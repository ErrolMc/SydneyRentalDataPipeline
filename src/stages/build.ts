// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import path from 'node:path'
import process from 'node:process'

import {
  CriteriaSchema,
  IndexSchema,
  LedgerSchema,
  PlacesSchema,
  SearchesSchema,
  SiteConfigSchema,
  SuburbsSchema,
  type DataIndex,
  type Ledger,
  type RejectedEntry,
  type ListingEntry,
  type LedgerEntry,
  type Run,
  type RunManifestEntry,
  type SuburbProfile,
  type Suburbs,
  placesByCanonical,
} from 'sydney-rental-schema'
import { computeConfigHash } from '../lib/config-hash.js'
import { buildListingEntry, sortListings } from '../lib/entry.js'
import { geocodeSuburbs, type Centroid } from '../lib/geocode-places.js'
import { syncListingImages } from '../lib/images.js'
import { dataPath, isoNow, readJsonFile, sortRecord, writeJsonFile } from '../lib/json-io.js'
import { markAbsent, mergeListing, mergeRejected } from '../lib/ledger.js'
import { fail } from '../lib/stage-error.js'
import { r2ConfigFromEnv } from '../lib/r2.js'
import { suburbKey, type RawListing } from '../lib/raw.js'
import {
  ReaCaptureSchema,
  excludedByKeyword,
  flattenCapture,
  reaToRawListing,
  type MappingProblem,
} from '../lib/rea.js'
import { unenrichedBlock } from '../lib/score.js'
import { evaluateSearches, planSearchQueries, type SearchCandidate } from '../lib/searches.js'
import {
  centroidCorrections,
  observedRents,
  placeSuburb,
  placesBySuburbKey,
  stubSuburb,
} from '../lib/suburbs.js'
import { allocateRunId, resolveTransitDeparture, transitArriveByMismatches } from '../lib/sydney.js'

/**
 * Protocol steps 2, 3, 5, 7, 8 and 9 (PLAN.md §4), driven from a capture file
 * the agent produced in step 4.
 *
 *   node dist/cli.js build <capture.json> [--dry-run] [--run-id=YYYY-MM-DDx] [--force]
 *
 * Everything here is deterministic apart from the image downloads and the
 * clock, so re-running the same capture after fixing a bug reproduces the same
 * run. Step 6 (enrichment) never became a pipeline here. Its commute half is
 * measured by the MCP server during the search itself and mapped from
 * `listing.travel` by `buildListingEntry`; its walkability half is fetched out
 * of band by `npm run enrich:walk` and cached in the ledger, which this reads.
 * So what this hands over is the all-`unavailable` starting point plus the run's
 * `config_hash`, and anything still unanswered sits out of the composite rather
 * than scoring zero.
 */

/**
 * Photos kept per listing. One by default, because `image_urls` arrives
 * hero-first — photo 01 is the lead shot the listing agent chose — and the
 * site renders only `images.hero` until PLAN.md §5’s gallery exists.
 *
 * A transit run returns on the order of a thousand listings, so eight each
 * would be ~10k images downloaded, resized twice and pushed to R2 for seven
 * eighths of them to be unreachable. Filenames are append-only, so raising
 * this later adds photos rather than renumbering what older runs point at.
 */
const DEFAULT_PHOTOS_PER_LISTING = 1

export async function main(argv: string[]): Promise<void> {
  const DRY_RUN = argv.includes('--dry-run')
  const RUN_ID_OVERRIDE = argv.find((arg) => arg.startsWith('--run-id='))?.slice(9)
  const LOCAL_IMAGES = argv.includes('--local-images')
  /** Build a capture whose transit arrive-by is not the one computed here anyway. */
  const FORCE = argv.includes('--force')
  const PHOTOS_PER_LISTING = Number(
    argv.find((a) => a.startsWith('--photos='))?.slice(9) ?? DEFAULT_PHOTOS_PER_LISTING,
  )
  const CAPTURE_PATH = argv[0]

  if (!CAPTURE_PATH) {
    fail(
      'usage: node dist/cli.js build <capture.json> [--dry-run] [--run-id=YYYY-MM-DDx] [--local-images] [--force]',
    )
  }

  // ── step 2: load ───────────────────────────────────────────────────────────
  const [site, criteria, searches, placesFile, index, ledger, suburbs, capture] = await Promise.all([
    readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema),
    readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema),
    readJsonFile(dataPath('config', 'searches.json'), SearchesSchema),
    readJsonFile(dataPath('config', 'places.json'), PlacesSchema),
    readJsonFile(dataPath('index.json'), IndexSchema).catch(() => null),
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema),
    readJsonFile(dataPath('knowledge', 'suburbs.json'), SuburbsSchema),
    readJsonFile(path.resolve(CAPTURE_PATH), ReaCaptureSchema),
  ])

  // Photos are served from R2, so a run that cannot upload would write image
  // paths the site resolves to nothing. Fail before any work rather than after.
  const { config: r2, missing } = r2ConfigFromEnv()
  if (!r2 && !LOCAL_IMAGES && !DRY_RUN) {
    fail(
      [
        `R2 is not configured — missing ${missing.join(', ')} in the pipeline's .env.`,
        '  Photos are served from R2 (see README, "Photo hosting"), so a run without it',
        '  would record image paths that resolve to nothing. Pass --local-images to',
        '  skip uploading for a local test.',
      ].join('\n'),
    )
  }

  // A search narrows the capture envelope and can never reach outside it, so a
  // search asking for something the envelope never fetched is a config error,
  // not a thin result set. Catch it before any work happens.
  // A rule-based `locations` resolves against places.json. Passing no places
  // does not fall back to the envelope: every rule search is refused, because
  // a missing measurement is never guessed at.
  /**
   * Only the searches this capture actually covered.
   *
   * A search has no `enabled` flag — which searches a run asks is decided at
   * capture time (`capture:run --searches=…`), and the capture records the
   * result as one group per `origin:mode`. Planning every saved search here
   * would hand a search a group the capture never filled, and `evaluateSearches`
   * would write `matched: 0, considered: 0` into `run.searches[]` for a search
   * nobody asked — the false zero this project has now paid for three times. A
   * search the capture skipped is simply absent from the run, which is what
   * `buildSearchHistory` reads as "not asked" rather than "found nothing".
   */
  const capturedKeys = new Set(capture.groups.map((group) => `${group.origin}:${group.mode}`))
  const covered = searches.searches
    .filter((search) => capturedKeys.has(`${search.commute.origin}:${search.commute.mode}`))
    .map((search) => search.id)

  const { groups, problems: planProblems } = planSearchQueries(
    searches,
    criteria,
    placesByCanonical(placesFile),
    covered,
  )
  if (planProblems.length > 0) {
    fail(
      [
        'searches.json asks for things criteria.search never captures:',
        ...planProblems.map((problem) => `    ${problem.searchId}: ${problem.reason}`),
        '',
        '  A search narrows the envelope; it cannot widen it. Either loosen',
        '  criteria.search or tighten the search.',
      ].join('\n'),
    )
  }

  const configHash = computeConfigHash(site)
  const transitDeparture = resolveTransitDeparture(
    site.commute_assumption.transit.day_of_week,
    site.commute_assumption.transit.arrive_by,
  )

  // The capture measured its transit minutes against the arrive-by it was given
  // at capture time; the line above computed that moment again, independently,
  // and `run.json` is about to publish this one as `transit_departure_resolved`.
  // If they are not the same moment the run states a precision it never had, and
  // nothing downstream can tell — the minutes look fine either way.
  const arriveByDrift = transitArriveByMismatches(capture.groups, transitDeparture)
  if (arriveByDrift.length > 0 && !FORCE) {
    fail(
      [
        'this capture was not measured against the arrive-by this build computed.',
        '',
        `  build computes  ${transitDeparture}`,
        `    from site.json commute_assumption.transit — ${site.commute_assumption.transit.day_of_week} ${site.commute_assumption.transit.arrive_by}`,
        '',
        '  the capture records:',
        ...arriveByDrift.map(
          (group) =>
            `    ${group.origin}:transit  ${group.arriveBy ?? '(none — captured without --arrive-by)'}`,
        ),
        '',
        '  resolveTransitDeparture returns the next matching weekday at least two days',
        '  out, so its answer rolls a week forward every Monday. A capture taken on one',
        '  side of that boundary and built on the other reports transit minutes measured',
        '  against a moment the run does not name.',
        '',
        `  Re-capture with --arrive-by=${transitDeparture}, or pass --force to build it`,
        '  anyway — and say so in the commit, because the run cannot say it for you.',
      ].join('\n'),
    )
  }

  // ── step 3: allocate the run id ────────────────────────────────────────────
  const existingRunIds = index?.runs.map((run) => run.id) ?? []
  const runId = RUN_ID_OVERRIDE ?? allocateRunId(existingRunIds)
  if (existingRunIds.includes(runId)) fail(`run ${runId} already exists — runs are immutable`)
  const previousRunId = existingRunIds.length > 0 ? existingRunIds[existingRunIds.length - 1] : null

  const createdAt = isoNow()

  console.log(`\nRun ${runId}${DRY_RUN ? '  (dry run — nothing will be written)' : ''}`)
  console.log(`  capture     ${path.relative(process.cwd(), path.resolve(CAPTURE_PATH))}`)
  console.log(`  source      ${capture.source} @ ${capture.captured_at}`)
  console.log(`  criteria    v${criteria.version}`)
  console.log(`  searches    v${searches.version} — ${groups.map((g) => `${g.key}\u2264${g.maxTravelMinutes}m`).join(', ') || '(none covered by this capture)'}`)
  console.log(`  config_hash ${configHash.slice(0, 12)}…`)
  console.log(`  transit     ${transitDeparture} (synthetic arrive-by)`)
  console.log(`  previous    ${previousRunId ?? '(first run)'}`)
  console.log(`  photos      ${r2 ? `R2 ${r2.bucket} → ${r2.publicBaseUrl}` : 'LOCAL ONLY (not published)'}`)

  // ── step 4 output → normalised listings ────────────────────────────────────
  // Duplicates are the norm, not the exception: a listing near the office comes
  // back from both the walk pass and the drive pass, and REA blends neighbouring
  // suburbs into every page besides. `flattenCapture` keeps the facts once and
  // merges the routed times, so one listing can carry both a walk and a drive
  // minute without either being guessed at.
  const flat = flattenCapture(capture)
  const returnedIds = flat.returnedIds

  if (capture.groups.length === 0) {
    fail(
      [
        'this capture has no `groups` — it predates named searches.',
        '  A run answers searches now (PLAN.md §3.7), and a flat `results` array carries no',
        '  routed times, so nothing could match. Re-capture per origin:mode group, or use',
        '  `npm run replay:run` if you meant to rebuild an older run.',
      ].join('\n'),
    )
  }

  const problems: MappingProblem[] = []
  const keywordSkips: string[] = []
  const results: RawListing[] = []

  for (const captured of flat.listings) {
    const keyword = excludedByKeyword(captured.listing, criteria.search.exclude_keywords)
    if (keyword) {
      keywordSkips.push(`${captured.listing.id} (${keyword})`)
      continue
    }
    const mapped = reaToRawListing(captured.listing, problems, captured.travel)
    if (mapped) results.push(mapped)
  }

  const capturedTotal = capture.groups.reduce((sum, group) => sum + group.results.length, 0)
  console.log(
    `  captured    ${capturedTotal} result(s) → ${flat.listings.length} unique → ${results.length} usable`,
  )
  if (keywordSkips.length > 0) {
    console.log(`  excluded    ${keywordSkips.length} by keyword: ${keywordSkips.slice(0, 5).join(', ')}`)
  }
  const roomLets = results.filter((raw) => raw.share_signals.length > 0)
  if (roomLets.length > 0) {
    console.log(
      `  share      ${roomLets.length} listing(s) look like a room, not a dwelling — ` +
        'flagged share_house, not dropped (npm run check:shares for the evidence)',
    )
  }
  for (const problem of problems) {
    console.log(`  ⚠ skipped   ${problem.id}: ${problem.reason}`)
  }

  // ── step 5: dedupe / merge against the ledger ──────────────────────────────
  const nextLedger: Record<string, LedgerEntry> = { ...ledger.listings }
  const merged = results.map((raw) => {
    const outcome = mergeListing({ raw, existing: nextLedger[raw.id], runId })
    nextLedger[raw.id] = outcome.entry
    return { raw, ...outcome }
  })

  const searched = capture.searched_locations
  const partialSearch = searched.length > 0 && searched.length < criteria.search.locations.length
  if (partialSearch) {
    console.log(
      `  ⚠ partial     ${searched.length}/${criteria.search.locations.length} locations searched — ` +
        'nothing will be marked stale',
    )
  }

  let goneCount = 0
  let unmatchedCount = 0
  let uncheckedCount = 0
  for (const [id, entry] of Object.entries(nextLedger)) {
    // `returnedIds`, not the usable subset: a listing skipped by a keyword or
    // a mapping problem is still listed on REA, and must not drift to stale.
    if (returnedIds.has(id)) continue
    const { entry: updated, status } = markAbsent({
      entry,
      runId,
      previousRunId,
      checked: capture.gone[id],
      allowStale: !partialSearch,
    })
    nextLedger[id] = updated
    if (status === 'unmatched') unmatchedCount += 1
    else if (status !== null) goneCount += 1
    else if (entry.status === 'active') uncheckedCount += 1
  }

  if (unmatchedCount > 0) {
    console.log(`  unmatched   ${unmatchedCount} still listed on REA but outside every search`)
  }
  if (uncheckedCount > 0) {
    console.log(
      `  ⚠ unchecked ${uncheckedCount} absent listing(s) with no verdict in the capture's \`gone\` map — ` +
        'they may have drifted out of a travel budget rather than left the market (AGENT.md §5–9)',
    )
  }

  // ── suburb stubs (the reduced form of step 6) ──────────────────────────────
  const nextSuburbs: Record<string, SuburbProfile> = { ...suburbs.suburbs }
  const bySuburb = new Map<string, RawListing[]>()
  for (const raw of results) {
    const key = suburbKey(raw.suburb, raw.postcode)
    bySuburb.set(key, [...(bySuburb.get(key) ?? []), raw])
  }

  // The envelope already knows where these are. Asking the gazetteer again was
  // a second derivation of the same fact, and the two drifted — see
  // `src/lib/suburbs.ts`. Realigning touches `suburbs.json` and nothing else:
  // a run refers to a suburb by `enrichment.suburb_ref`, so no run.json is
  // rewritten and the replay invariant is unaffected.
  const placesByKey = placesBySuburbKey(placesFile)
  const corrections = centroidCorrections(nextSuburbs, placesByKey)
  for (const correction of corrections) {
    nextSuburbs[correction.key] = { ...nextSuburbs[correction.key], centroid: correction.to }
  }
  if (corrections.length > 0) {
    console.log(`\n  ${corrections.length} suburb centroid(s) realigned to places.json:`)
    for (const c of corrections) {
      console.log(
        `    ~ ${c.key.padEnd(24)} ${c.from.lat}, ${c.from.lon} → ${c.to.lat}, ${c.to.lon}  (${Math.round(c.metres)} m)`,
      )
    }
  }

  // Ask once for everything that needs placing, before the loop — a run brings
  // a handful of new suburbs at most, and now only the ones the envelope does
  // not already hold. REA blends `surrounding` listings from neighbouring
  // suburbs into every page, so one can arrive from outside the enumerated
  // postcode range; that is what is left for the gazetteer to answer.
  //
  // Asked as "what cannot be placed *without* the gazetteer" rather than by
  // restating the precedence here, which would be a second copy of it free to
  // drift from `placeSuburb`'s.
  const unplaceableSuburbs: string[] = []
  const needPlacing = [...bySuburb]
    .filter(([key, listings]) => !nextSuburbs[key] && !placeSuburb(listings, placesByKey.get(key), undefined))
    .map(([key, listings]) => ({ id: key, suburb: listings[0].suburb, postcode: listings[0].postcode }))
  let geocoded = new Map<string, Centroid>()
  if (needPlacing.length > 0) geocoded = await geocodeSuburbs(needPlacing)

  for (const [key, listings] of bySuburb) {
    if (nextSuburbs[key]) continue

    const placed = placeSuburb(listings, placesByKey.get(key), geocoded.get(key))

    if (!placed) {
      unplaceableSuburbs.push(`${key} (${listings.length} listing(s))`)
      continue
    }

    console.log(`    + suburb ${key} @ ${placed.centroid.lat}, ${placed.centroid.lon} (${placed.source})`)
    nextSuburbs[key] = stubSuburb(listings[0].suburb, listings[0].postcode, placed.centroid)
  }

  /**
   * What this run saw asked, per suburb — the one part of a profile that costs
   * nothing to fill, because the prices are already in hand.
   *
   * Runs over every suburb in the capture, not just the new ones: an existing
   * profile wants this run's prices, not the prices of whenever it was created.
   * A suburb the capture did not reach keeps what it had, stamped with the run
   * that measured it, which is how a reader tells a current median from one
   * left over from three runs ago.
   */
  let observedFilled = 0
  for (const [key, listings] of bySuburb) {
    const profile = nextSuburbs[key]
    if (!profile) continue
    const observed = observedRents(listings, runId, createdAt)
    if (!observed) continue
    nextSuburbs[key] = { ...profile, observed_rents: observed }
    observedFilled += 1
  }
  if (observedFilled > 0) {
    console.log(`\n  observed rents for ${observedFilled} suburb(s) (own listings, not published figures)`)
  }

  if (unplaceableSuburbs.length > 0) {
    fail(
      `could not place these suburbs, and a profile needs a centroid:\n    ${unplaceableSuburbs.join('\n    ')}\n` +
        `  Add them to data/knowledge/suburbs.json by hand (name, postcode, centroid\n` +
        `  lat/lon, everything else null) and re-run.`,
    )
  }

  // ── step 8: images ─────────────────────────────────────────────────────────
  console.log(`\n  ${results.length} listing(s) — syncing photos`)
  let downloadedTotal = 0
  let skippedListings = 0

  for (const item of merged) {
    const entry = nextLedger[item.raw.id]

    if (DRY_RUN) {
      const pending = item.raw.image_urls.filter((url) => !entry.images.source_urls.includes(url))
      if (pending.length > 0) {
        const room = Math.max(0, PHOTOS_PER_LISTING - entry.images.files.length)
        console.log(`    ${item.raw.id}  would download ${Math.min(pending.length, room)} photo(s)`)
      }
      continue
    }

    const sync = await syncListingImages({
      listingId: item.raw.id,
      sourceUrls: item.raw.image_urls,
      known: entry.images,
      r2,
      maxPhotos: PHOTOS_PER_LISTING,
      onProgress: (message) => console.log(message),
    })

    nextLedger[item.raw.id] = {
      ...entry,
      images: { source_urls: sync.sourceUrls, files: sync.files, count: sync.files.length },
    }

    downloadedTotal += sync.downloaded
    if (sync.skipped) skippedListings += 1
    if (sync.downloaded > 0 || sync.failed > 0) {
      console.log(
        `    ${item.raw.id}  +${sync.downloaded} photo(s)${sync.failed > 0 ? `, ${sync.failed} failed` : ''}`,
      )
    }
  }

  console.log(
    `  downloaded ${downloadedTotal} new photo(s); ${skippedListings} listing(s) already complete`,
  )

  // ── step 7: evaluate the searches, then score what they matched ────────────
  //
  // Flags have to exist before a search can filter on them (`exclude_flagged`),
  // and the entry builder is what produces flags — so the entry is built first
  // and its `matched_searches` filled in after. Building an entry costs nothing
  // but arithmetic; it is the photos and the enrichment that are expensive, and
  // those are already done or deferred.
  const enrichedAt = createdAt
  const built = merged.map((item) => {
    const key = suburbKey(item.raw.suburb, item.raw.postcode)
    return buildListingEntry({
      raw: item.raw,
      criteria,
      suburbProfile: nextSuburbs[key] ?? null,
      // The starting point only. `buildListingEntry` fills `commute` from the
      // routed times in `raw.travel` and `walkability` from the ledger cache
      // below, which `npm run enrich:walk` populates out of band.
      enrichment: unenrichedBlock(key, configHash, enrichedAt),
      walkability: nextLedger[item.raw.id].walkability,
      cachedTravel: nextLedger[item.raw.id].travel,
      history: {
        listing_state: item.state,
        first_seen_run: nextLedger[item.raw.id].first_seen_run,
        price_change: item.priceChange,
        imageFiles: nextLedger[item.raw.id].images.files,
        agent_notes: item.raw.agent_notes,
        matched_searches: [],
      },
    })
  })

  const capturedTravel = new Map(merged.map((item) => [item.raw.id, item.raw.travel]))
  // Matched on the **capture's** routed times, not the merged ones. PLAN.md
  // §4 step 7 defines a match as walking "the results of its `origin:mode`
  // group": a search is a real query, and a listing REA withheld from that
  // group was not found by it. Since `buildListingEntry` now merges the
  // ledger's cache in for display, matching on `entry.travel` would let a
  // cached measurement satisfy a search REA never returned the listing for
  // — silently inflating what that search claims to have found.
  const candidates: SearchCandidate[] = built.map((entry) => ({
    id: entry.id,
    price_pw: entry.price_pw,
    beds: entry.beds,
    baths: entry.baths,
    car_spaces: entry.car_spaces,
    property_type: entry.property_type,
    flags: entry.flags,
    travel: capturedTravel.get(entry.id) ?? {},
  }))

  const travelReports = Object.fromEntries(
    capture.groups.map((group) => [`${group.origin}:${group.mode}`, group.travel_report ?? null]),
  )

  const evaluation = evaluateSearches({
    searches,
    groups,
    candidates,
    groupTotals: flat.groupTotals,
    travelReports,
    searchedLocations: capture.searched_locations,
  })

  // A listing REA returned for one group but that no search wants — a wider
  // group budget, or a price filter it fails — is not part of the answer.
  const listings: ListingEntry[] = sortListings(
    built
      .filter((entry) => evaluation.matchedByListing.has(entry.id))
      .map((entry) => ({
        ...entry,
        matched_searches: evaluation.matchedByListing.get(entry.id) ?? [],
      })),
  )

  console.log('')
  for (const result of evaluation.results) {
    const note = result.status === 'ok' ? '' : `  (${result.status.replace(/_/g, ' ')})`
    console.log(
      `  search      ${result.id.padEnd(18)} ${String(result.matched).padStart(4)} of ` +
        `${result.considered} considered${note}`,
    )
  }
  const dropped = built.length - listings.length
  if (dropped > 0) {
    console.log(`              ${dropped} usable listing(s) matched no search and are not in the run`)
  }

  const countOf = (state: ListingEntry['listing_state']) =>
    listings.filter((listing) => listing.listing_state === state).length

  const warnings = [
    'Enrichment has not run for this milestone, so commute times and walkability are ' +
      'unavailable for every listing. Six of the nine scoring factors sat out of the ' +
      'composite and confidence is correspondingly low — scores are hidden on the site ' +
      'and listings are ordered by rent instead.',
  ]

  // A run carries the full criteria snapshot, so a partial search has to say so
  // — otherwise the file claims coverage it does not have, and a later
  // run-vs-run diff reads the unsearched suburbs as listings that disappeared.
  if (partialSearch) {
    warnings.push(
      `Partial search: ${searched.length} of ${criteria.search.locations.length} configured ` +
        `locations were queried (${searched.join(', ')}). Listings from the remaining ` +
        `${criteria.search.locations.length - searched.length} are absent because they were ` +
        `never searched, not because none exist — so no listing was marked stale this run.`,
    )
  }

  const run: Run = {
    schema_version: 1,
    run_id: runId,
    created_at: createdAt,
    agent: 'claude-code',
    criteria_version: criteria.version,
    criteria_snapshot: criteria,
    searches_version: searches.version,
    searches_snapshot: searches.searches,
    searches: evaluation.results,
    transit_departure_resolved: transitDeparture,
    summary: {
      total: listings.length,
      new: countOf('new'),
      carried_over: countOf('carried_over'),
      price_drops: countOf('price_drop'),
      relisted: countOf('relisted'),
      leased_since_last_run: goneCount,
    },
    provider_report: { warnings },
    commentary: capture.commentary,
    listings,
  }

  const manifestEntry: RunManifestEntry = {
    id: runId,
    date: runId.slice(0, 10),
    created_at: createdAt,
    criteria_version: criteria.version,
    listing_count: listings.length,
    new_count: run.summary.new,
    label: null,
  }

  const nextIndex: DataIndex = {
    schema_version: 1,
    current_run: runId,
    runs: [...(index?.runs ?? []), manifestEntry],
  }

  // The MCP server drops these after geocoding and routing each one, so the
  // capture is the only record that the work was done. See `mergeRejected`.
  const { rejected: nextRejected, seen: rejectedSeen } = mergeRejected({
    previous: ledger?.rejected ?? {},
    groups: capture.groups,
    publishedIds: Object.keys(nextLedger),
    runId,
    computedAt: createdAt,
  })
  if (rejectedSeen > 0) {
    console.log(
      `  rejected    ${rejectedSeen} listing(s) outside the travel budget, remembered so ` +
        `they are not re-measured (${Object.keys(nextRejected).length} held in total)`,
    )
  }

  const nextLedgerFile: Ledger = {
    schema_version: 1,
    updated_at: createdAt,
    listings: sortRecord(nextLedger),
    rejected: sortRecord(nextRejected),
  }

  const nextSuburbsFile: Suburbs = {
    schema_version: 1,
    updated_at: createdAt,
    suburbs: sortRecord(nextSuburbs),
  }

  console.log(
    `\n  summary     ${run.summary.total} total · ${run.summary.new} new · ` +
      `${run.summary.price_drops} price change(s) · ${run.summary.relisted} relisted · ` +
      `${run.summary.leased_since_last_run} gone`,
  )

  if (DRY_RUN) {
    console.log('\n  Dry run — no files written.\n')
    return
  }

  // ── step 9: write outputs ──────────────────────────────────────────────────
  await writeJsonFile(dataPath('runs', runId, 'run.json'), run)
  await writeJsonFile(dataPath('knowledge', 'listings.json'), nextLedgerFile)
  await writeJsonFile(dataPath('knowledge', 'suburbs.json'), nextSuburbsFile)
  await writeJsonFile(dataPath('index.json'), nextIndex)

  console.log(`\n  wrote       data/runs/${runId}/run.json`)
  console.log('              data/knowledge/listings.json, suburbs.json, data/index.json')

  if (!run.commentary.trim()) {
    console.log('\n  ⚠ commentary is empty — write it into run.json before committing (§4 step 9).')
  }

  console.log('\n  Next: npm run validate:data, then commit per §4 step 11.\n')
}

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import path from 'node:path'
import process from 'node:process'

import {
  IndexSchema,
  LedgerSchema,
  RunSchema,
  SuburbsSchema,
  type ListingEntry,
  type Run,
} from 'sydney-rental-schema'
import { buildListingEntry, sortListings } from './lib/entry'
import { dataPath, readJsonFile, writeJsonFile } from './lib/json-io'
import { suburbKey, type RawListing } from './lib/raw'
import {
  ReaCaptureSchema,
  excludedByKeyword,
  flattenCapture,
  reaToRawListing,
  type MappingProblem,
} from './lib/rea'
import { matchesSearch, type SearchCandidate } from './lib/searches'

/**
 * Rebuild an existing run from the capture it came from, after a mapping fix.
 *
 *   npm run replay:run -- <capture.json> --run-id=2026-08-24a [--dry-run]
 *
 * `lib/rea.ts` is the only thing that interprets a capture, and the capture is
 * kept precisely so a wrong interpretation can be corrected without asking REA
 * the same question twice. Until this existed there was no way to act on that
 * for a run already written: `build-run.ts` refuses an existing run id, because
 * runs are immutable.
 *
 * They still are, in the sense that matters. A replay changes only what the
 * mapping produces — prices, types, snippets, flags, scores, and which searches
 * those flags let a listing match. Everything that is a fact about *history* is
 * copied across untouched:
 *
 *   run_id · created_at · agent · criteria_snapshot · searches_snapshot
 *   transit_departure_resolved · provider_report · commentary
 *   per listing: listing_state · first_seen_run · price_change · images
 *                · agent_notes
 *   per search: considered · locations_searched · travel report
 *
 * `enrichment` is derived, not carried: its commute half comes from the
 * capture's own routed times and its walkability half from the ledger, which is
 * that half's cache and home (see `lib/entry.ts`). So a replay is a rebuild from
 * this run's capture plus everything the ledger currently knows, and it carries
 * over only what neither of those can supply. One consequence worth stating: a
 * run replayed after `npm run enrich:walk` picks up walkability it did not have
 * when it was committed. That is the point — it is how a committed run gets
 * enriched without paying REA for a fresh one.
 *
 * Two consequences worth stating plainly. Scoring and matching use the run's own
 * snapshots, not today's config — a replay reproduces a run, it does not
 * re-judge it against newer rules. And the ledger is never written: photos,
 * price history and status history belong to the original run, and a replay has
 * no business editing them. If a fix changes a fact the ledger already recorded,
 * or needs history for a listing the run never contained, this refuses.
 */

const DRY_RUN = process.argv.includes('--dry-run')
const RUN_ID = process.argv.find((arg) => arg.startsWith('--run-id='))?.slice(9)
const CAPTURE_PATH = process.argv[2]

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

/** What a mapping fix is allowed to move. */
const DERIVED_FIELDS = [
  'url',
  'address',
  'suburb',
  'postcode',
  'state',
  'lat',
  'lon',
  'price_pw',
  'price_display',
  'beds',
  'baths',
  'car_spaces',
  'area_sqm',
  'area_source',
  'property_type',
  'available_date',
  'bond',
  'features',
  'description_snippet',
  'travel',
  'matched_searches',
  'enrichment',
  'scores',
  'flags',
  'share_signals',
] as const

/** What it may not. A difference here is a bug in this script, not a result. */
const HISTORY_FIELDS = [
  'listing_state',
  'first_seen_run',
  'price_change',
  'images',
  'agent_notes',
] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function main() {
  if (!CAPTURE_PATH || !RUN_ID) {
    fail('usage: npm run replay:run -- <capture.json> --run-id=YYYY-MM-DDx [--dry-run]')
  }

  const [index, ledger, suburbs, capture, previous] = await Promise.all([
    readJsonFile(dataPath('index.json'), IndexSchema),
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema),
    readJsonFile(dataPath('knowledge', 'suburbs.json'), SuburbsSchema),
    readJsonFile(path.resolve(CAPTURE_PATH), ReaCaptureSchema),
    readJsonFile(dataPath('runs', RUN_ID, 'run.json'), RunSchema).catch(() =>
      fail(`no run at data/runs/${RUN_ID}/run.json — a replay rebuilds an existing run`),
    ),
  ])

  if (!index.runs.some((entry) => entry.id === RUN_ID)) {
    fail(`run ${RUN_ID} is not in index.json`)
  }

  const criteria = previous.criteria_snapshot
  // An empty snapshot means the run predates named searches, not that no search
  // matched. Such a run kept every usable listing, and a replay must too.
  const hasSearches = previous.searches_snapshot.length > 0

  console.log(`\nReplay ${RUN_ID}${DRY_RUN ? '  (dry run — nothing will be written)' : ''}`)
  console.log(`  capture     ${path.relative(process.cwd(), path.resolve(CAPTURE_PATH))}`)
  console.log(`  source      ${capture.source} @ ${capture.captured_at}`)
  console.log(`  criteria    v${criteria.version} — the run's own snapshot, not today's`)
  console.log(
    `  searches    ${hasSearches ? `v${previous.searches_version} — ${previous.searches_snapshot.length} search(es)` : '(run predates named searches)'}`,
  )
  console.log(`  listings    ${previous.listings.length} as committed`)

  // ── remap, exactly as build-run.ts does ────────────────────────────────────
  const flat = flattenCapture(capture)
  const problems: MappingProblem[] = []
  const results: RawListing[] = []

  for (const captured of flat.listings) {
    if (excludedByKeyword(captured.listing, criteria.search.exclude_keywords)) continue
    const mapped = reaToRawListing(captured.listing, problems, captured.travel)
    if (mapped) results.push(mapped)
  }

  // ── rebuild, keeping every historical fact ─────────────────────────────────
  const priorById = new Map(previous.listings.map((listing) => [listing.id, listing]))
  const missingSuburbs = new Set<string>()

  const built = results
    .filter((raw) => priorById.has(raw.id))
    .map((raw) => {
      const prior = priorById.get(raw.id) as ListingEntry
      const key = suburbKey(raw.suburb, raw.postcode)
      if (!suburbs.suburbs[key]) missingSuburbs.add(key)
      return buildListingEntry({
        raw,
        criteria,
        suburbProfile: suburbs.suburbs[key] ?? null,
        enrichment: prior.enrichment,
        walkability: ledger.listings[raw.id]?.walkability ?? null,
        cachedTravel: ledger.listings[raw.id]?.travel,
        history: {
          listing_state: prior.listing_state,
          first_seen_run: prior.first_seen_run,
          price_change: prior.price_change,
          imageFiles: prior.images.photos.map((photo) => path.posix.basename(photo.src)),
          agent_notes: prior.agent_notes,
          matched_searches: [],
        },
      })
    })

  if (missingSuburbs.size > 0) {
    fail(`suburb profile(s) missing from knowledge/suburbs.json: ${[...missingSuburbs].join(', ')}`)
  }

  // ── re-decide what each search matched ─────────────────────────────────────
  //
  // Not carried over, because a mapping fix can legitimately change it: a
  // listing newly flagged `share_house` drops out of a search that excludes the
  // flag. That is the whole point of replaying after a classifier fix. What is
  // carried over is everything about the *query* — how many listings it
  // considered, which locations it covered, what the router measured — because
  // those describe a search REA answered once and will not answer again.
  const matchedByListing = new Map<string, string[]>()
  const matchCounts = new Map<string, number>()

  if (hasSearches) {
    const capturedTravel = new Map(results.map((raw) => [raw.id, raw.travel]))
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

    /**
     * Only the searches this run **asked**, not everything it knew about.
     *
     * `searches_snapshot` is the config as it stood at run time; `searches[]` is
     * what the run actually queried REA for. Matching against the snapshot lets a
     * run claim an answer it never went and got: `2026-08-25a` asked only
     * `train-25`, and the moment its listings gained a walk time from the ledger,
     * ten of them started matching `office-walk-15` — a search that run never put
     * to REA, over a listing set gathered under a different budget. That is the
     * false zero's mirror image, and it would have been written into the data
     * with nothing to catch it: `validate:data` checks that every id in
     * `matched_searches` exists in the *snapshot*, which it does.
     *
     * A run with no `searches[]` predates the field, so there is no record of what
     * it asked and the snapshot is the only thing to go on.
     */
    const asked = new Set(previous.searches.map((result) => result.id))
    const askedSearches = asked.size > 0
      ? previous.searches_snapshot.filter((search) => asked.has(search.id))
      : previous.searches_snapshot

    for (const search of askedSearches) {
      let matched = 0
      for (const candidate of candidates) {
        if (!matchesSearch(search, candidate)) continue
        matched += 1
        matchedByListing.set(candidate.id, [
          ...(matchedByListing.get(candidate.id) ?? []),
          search.id,
        ])
      }
      matchCounts.set(search.id, matched)
    }
  }

  const listings: ListingEntry[] = sortListings(
    built
      .filter((entry) => !hasSearches || matchedByListing.has(entry.id))
      .map((entry) => ({ ...entry, matched_searches: matchedByListing.get(entry.id) ?? [] })),
  )

  // ── it has to be about listings the run can account for ────────────────────
  const before = new Set(previous.listings.map((listing) => listing.id))
  const after = new Set(listings.map((listing) => listing.id))
  const appeared = results.filter((raw) => !before.has(raw.id) && after.has(raw.id))

  if (appeared.length > 0) {
    fail(
      [
        `${appeared.length} listing(s) would enter ${RUN_ID} that it never contained:`,
        `    ${appeared.slice(0, 8).map((raw) => raw.id).join(', ')}`,
        '',
        '  A replay carries the original run history — first_seen_run, price_change, photos —',
        '  onto the listings it rebuilds, and it has none for a listing the run never held.',
        '  Build a fresh run from this capture instead.',
      ].join('\n'),
    )
  }

  const left = [...before].filter((id) => !after.has(id))

  // ── what actually moved ────────────────────────────────────────────────────
  const changedBy = new Map<string, string[]>()
  for (const listing of listings) {
    const prior = priorById.get(listing.id) as ListingEntry
    for (const field of DERIVED_FIELDS) {
      if (!same(prior[field], listing[field])) {
        changedBy.set(field, [...(changedBy.get(field) ?? []), listing.id])
      }
    }
    for (const field of HISTORY_FIELDS) {
      if (!same(prior[field], listing[field])) {
        fail(
          `${listing.id}: the replay changed "${field}", which is history and has to be carried ` +
            'over verbatim. That is a bug in replay-run.ts, not something to commit.',
        )
      }
    }

  }

  console.log('\n  changed')
  if (changedBy.size === 0 && left.length === 0) {
    console.log('    nothing — the mapping already produces the committed run')
  }
  for (const [field, ids] of [...changedBy].sort((a, b) => b[1].length - a[1].length)) {
    const sample = `${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''}`
    console.log(`    ${field.padEnd(20)} ${String(ids.length).padStart(3)} listing(s)   ${sample}`)
  }
  if (left.length > 0) {
    console.log(
      `    ${'no longer matched'.padEnd(20)} ${String(left.length).padStart(3)} listing(s)   ${left.slice(0, 4).join(', ')}${left.length > 4 ? ' …' : ''}`,
    )
  }

  // ── does the ledger still agree with the run? ──────────────────────────────
  const drifted: string[] = []
  for (const listing of listings) {
    const entry = ledger.listings[listing.id]
    if (!entry) continue
    const lastPrice = entry.price_history[entry.price_history.length - 1]?.price_pw ?? null
    if (lastPrice !== listing.price_pw) {
      drifted.push(`${listing.id} price ${lastPrice} → ${listing.price_pw}`)
    }
    if (entry.facts_last.beds !== listing.beds) {
      drifted.push(`${listing.id} beds ${entry.facts_last.beds} → ${listing.beds}`)
    }
    if (entry.facts_last.baths !== listing.baths) {
      drifted.push(`${listing.id} baths ${entry.facts_last.baths} → ${listing.baths}`)
    }
  }

  if (drifted.length > 0) {
    fail(
      [
        `the fix moves ${drifted.length} fact(s) the ledger has already recorded:`,
        ...drifted.slice(0, 10).map((line) => `    ${line}`),
        '',
        '  A replay does not write the ledger, so this would leave run.json and',
        '  knowledge/listings.json disagreeing about the same listing. Build a fresh run.',
      ].join('\n'),
    )
  }

  const countOf = (state: ListingEntry['listing_state']) =>
    listings.filter((listing) => listing.listing_state === state).length

  const run: Run = {
    ...previous,
    searches: previous.searches.map((result) => ({
      ...result,
      matched: matchCounts.get(result.id) ?? result.matched,
    })),
    summary: {
      ...previous.summary,
      total: listings.length,
      new: countOf('new'),
      carried_over: countOf('carried_over'),
      price_drops: countOf('price_drop'),
      relisted: countOf('relisted'),
    },
    listings,
  }

  if (!same(run.summary, previous.summary)) {
    console.log(
      `\n  ⚠ summary    total ${previous.summary.total} → ${run.summary.total}. index.json still says ` +
        `${previous.summary.total}; update it in the same commit or validate:data will fail.`,
    )
  }

  if (DRY_RUN) {
    console.log('\n  Dry run — nothing written.\n')
    return
  }

  await writeJsonFile(dataPath('runs', RUN_ID, 'run.json'), run)
  console.log(`\n  wrote       data/runs/${RUN_ID}/run.json`)
  console.log('\n  Next: npm run validate:data, then commit. The ledger and index are untouched.\n')
}

main().catch((error) => fail((error as Error).message))

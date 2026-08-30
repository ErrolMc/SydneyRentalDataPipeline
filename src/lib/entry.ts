import type {
  Criteria,
  Enrichment,
  LedgerEntry,
  ListingEntry,
  ListingFlag,
  ListingState,
  SuburbProfile,
  Travel,
} from 'sydney-rental-schema'
import { OFFICE_ORIGIN_ID } from 'sydney-rental-schema'
import { listingImagePath } from './images.js'
import { normaliseFeature, suburbKey, type RawListing } from './raw.js'
import { commuteFromTravel, scoreListing } from './score.js'

/**
 * Turning one normalised listing into the entry a run publishes.
 *
 * This lives apart from `build-run.ts` because two callers need to agree on it
 * exactly. A run builds entries from a fresh capture; a replay
 * (`replay-run.ts`) rebuilds an existing run's entries from the same capture
 * after a mapping fix. If the two drifted, a replay would silently change
 * fields it was never meant to touch, which is the one thing a replay must not
 * do.
 *
 * Everything that is a *fact about history* rather than a fact about the
 * listing — which run first saw it, whether the price moved, which photos were
 * downloaded, what the agent wrote about it — is passed in rather than derived,
 * because a replay owes those to the run it is replaying.
 */

/** Below half the target rent, a 2-bed in the inner west is a scam or a typo, not a bargain. */
const SUSPICIOUSLY_CHEAP_RATIO = 0.5

export interface EntryHistory {
  listing_state: ListingState
  first_seen_run: string
  price_change: ListingEntry['price_change']
  /** Photo file names as recorded, e.g. `01.webp` — thumbs are implied. */
  imageFiles: readonly string[]
  agent_notes: string
  /** Which saved searches matched, in config order. Empty only on a run with no searches. */
  matched_searches: readonly string[]
}

/** The schema caps `description_snippet` at 500 chars; cut on a word boundary. */
export function snippet(description: string, limit = 500): string {
  const clean = description.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  const cut = clean.slice(0, limit - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

export function priceDisplay(raw: RawListing): string {
  if (raw.price_display.trim()) return raw.price_display.trim()
  return raw.price_pw === null ? 'Contact agent' : `$${raw.price_pw} per week`
}

/**
 * Which enrichment questions came back with nothing — `unavailable`, not
 * `none_found`, which is an answer.
 *
 * The commute counts as *one* question, not three. A run measures only the
 * modes the run's searches ask for, so a transit-only run leaves walk and
 * drive `unavailable` forever — and reporting those as gaps made
 * `enrichment_incomplete` fire on every listing ever built, which tells a reader
 * nothing. What matters is whether we know how long it takes to get to the
 * office at all.
 *
 * `drive` is left out entirely on the same reasoning: it carries a weight of 2
 * and answers a question no search has yet asked.
 */
export function unavailableProviders(enrichment: Enrichment): string[] {
  const { walk, transit } = enrichment.commute
  const commuteKnown = walk.status !== 'unavailable' || transit.status !== 'unavailable'

  const blocks: [string, { status: string }][] = [
    ['cafe', enrichment.walkability.cafe],
    ['supermarket', enrichment.walkability.supermarket],
    ['gym', enrichment.walkability.gym],
  ]

  return [
    ...(commuteKnown ? [] : ['commute']),
    ...blocks.filter(([, block]) => block.status === 'unavailable').map(([name]) => name),
  ]
}

/**
 * The ledger's travel cache as plain `Travel`. Its entries carry `computed_at`
 * and `address` — provenance and the invalidation key — which a run entry does
 * not, so they are dropped rather than widening the run schema to hold a cache's
 * bookkeeping.
 */
function ledgerTravel(cached: LedgerEntry['travel'] | undefined): Record<string, Travel> {
  if (!cached) return {}
  return Object.fromEntries(
    Object.entries(cached).map(
      ([key, { minutes, km, mode, precision, composition, mislabelled }]) => [
        key,
        {
          minutes,
          km,
          mode,
          precision,
          ...(composition ? { composition } : {}),
          ...(mislabelled ? { mislabelled } : {}),
        },
      ],
    ),
  )
}

/**
 * Merge one mode's cached time with the capture's, and say which wins.
 *
 * The capture wins by default, because a replay must reproduce a run rather than
 * re-measure it. **A measured journey is the exception.** A capture's transit
 * entry is a bare number whose composition is unknown — `travelMode` echoed back,
 * which is how a 350 m walk came to be displayed as public transport on ten
 * listings and a ferry crossing as a "walk" on six. A ledger entry carrying a
 * `composition` has been measured leg by leg and knows what the journey is.
 *
 * So the rule is *better-evidenced wins*, not *newer wins*: a measured
 * composition beats no composition, and evidence that a mode is **mislabelled**
 * beats an unexamined claim to be that mode. Everything else defers to the
 * capture exactly as before, so a run whose ledger has not been enriched is
 * untouched and re-running the enrichment cannot quietly re-time a mode it has
 * nothing new to say about.
 *
 * The second case matters for the walk. A capture's walk entry says `walk`
 * because that is what was asked; the ledger's says the same route was routed at
 * 6.5 km/h with a ferry serving the address. Both describe one measurement, and
 * only one of them looked.
 */
function mergeTravel(
  cached: Record<string, Travel>,
  captured: Record<string, Travel>,
): Record<string, Travel> {
  const merged: Record<string, Travel> = { ...cached, ...captured }
  for (const [key, cachedEntry] of Object.entries(cached)) {
    const capturedEntry = captured[key]
    const knowsMore =
      (cachedEntry.composition && !capturedEntry?.composition) ||
      (cachedEntry.mislabelled && !capturedEntry?.mislabelled)
    if (knowsMore) merged[key] = cachedEntry
  }
  return merged
}

export function buildListingEntry(options: {
  raw: RawListing
  criteria: Criteria
  suburbProfile: SuburbProfile | null
  /** The starting point: `config_hash`, `enriched_at`, and all-`unavailable` blocks. */
  enrichment: Enrichment
  /** The ledger's cached POIs for this listing, or null if nobody has asked yet. */
  walkability: LedgerEntry['walkability']
  /**
   * The ledger's routed-time cache (PLAN.md §3.5), which `npm run enrich:travel`
   * fills for modes no run asked about. Empty is normal.
   */
  cachedTravel?: LedgerEntry['travel']
  history: EntryHistory
}): ListingEntry {
  const { raw, criteria, suburbProfile, walkability, history } = options

  /**
   * Every mode measured for this listing, the capture's own winning where they
   * overlap.
   *
   * A run measures only the modes its searches ask for — `travelMode` is one per
   * request — so `raw.travel` is a slice by mode, and a run that asked only about
   * transit produced listings that appear to have no walk. That is what let the
   * site describe a 370 m walk as public transport: `travel.mode` is the mode
   * *requested*, echoed back, not a description of the route.
   *
   * The ledger is where the rest lives. A routed minute is a fact about a place
   * rather than about a moment — the same reasoning that puts walkability there
   * — so merging it in is a denormalisation, not a second source. The capture
   * wins on any mode it carries, because a replay must reproduce the run rather
   * than re-measure it — except where the ledger has *measured the journey* and
   * the capture only has a number. See `mergeTravel`.
   */
  const travel = mergeTravel(ledgerTravel(options.cachedTravel), raw.travel)
  const key = suburbKey(raw.suburb, raw.postcode)

  // The enrichment block is *derived*, not carried — which is what lets a
  // replay reproduce it at no cost, and why this module exists at all: a run
  // and a replay of that run cannot map the same inputs two different ways.
  //
  // Its two halves come from different places. Commute comes from the capture,
  // via `raw.travel`, exactly like price or beds do. Walkability comes from the
  // ledger, which is its cache and its home — a cafe 290 m away is 290 m away
  // whichever run asked, so the copy on a run entry is a denormalisation of the
  // ledger's, not a separate fact.
  const enrichment: Enrichment = {
    ...options.enrichment,
    ...(walkability
      ? { enriched_at: walkability.computed_at, config_hash: walkability.config_hash }
      : {}),
    commute: commuteFromTravel(travel, OFFICE_ORIGIN_ID),
    walkability: walkability
      ? { cafe: walkability.cafe, supermarket: walkability.supermarket, gym: walkability.gym }
      : options.enrichment.walkability,
  }

  const scores = scoreListing(
    {
      price_pw: raw.price_pw,
      beds: raw.beds,
      baths: raw.baths,
      car_spaces: raw.car_spaces,
      area_sqm: raw.area_sqm,
      suburb_key: key,
      enrichment,
      suburb_profile: suburbProfile,
    },
    criteria,
  )

  const photos = history.imageFiles.map((file) => ({
    src: listingImagePath(raw.id, file),
    thumb: listingImagePath(raw.id, file.replace(/\.webp$/, '.thumb.webp')),
  }))

  const flags: ListingFlag[] = []
  if (raw.area_sqm === null) flags.push('no_sqm')
  if (raw.price_pw === null) flags.push('no_price')
  if (raw.lat === null || raw.lon === null) flags.push('no_latlon')
  // Derived rather than assumed, so it stops being true on its own as providers
  // start answering — which both now do, so on a fully enriched run this fires
  // only for a listing nobody could place. `none_found` and `fallback` are real
  // answers; only `unavailable` is a gap.
  if (unavailableProviders(enrichment).length > 0) flags.push('enrichment_incomplete')
  if (photos.length === 0) flags.push('images_failed')
  if (
    raw.price_pw !== null &&
    raw.price_pw < criteria.search.target_price_pw * SUSPICIOUSLY_CHEAP_RATIO
  ) {
    flags.push('suspiciously_cheap')
  }
  // Flagged, never dropped: a room let is still a listing REA is publishing,
  // and price history and relist tracking depend on it staying in the ledger.
  // The site decides whether to show it.
  if (raw.share_signals.length > 0) flags.push('share_house')

  return {
    id: raw.id,
    url: raw.url,
    address: raw.address,
    suburb: raw.suburb,
    postcode: raw.postcode,
    state: raw.state,
    lat: raw.lat,
    lon: raw.lon,

    price_pw: raw.price_pw,
    price_display: priceDisplay(raw),
    beds: raw.beds,
    baths: raw.baths,
    car_spaces: raw.car_spaces,
    area_sqm: raw.area_sqm,
    area_source: raw.area_source,
    property_type: raw.property_type,
    available_date: raw.available_date,
    bond: raw.bond,
    features: [...new Set(raw.features.map(normaliseFeature).filter(Boolean))],
    description_snippet: snippet(raw.description),

    images: { count: photos.length, hero: photos[0]?.src ?? null, photos },

    travel,
    matched_searches: [...history.matched_searches],

    listing_state: history.listing_state,
    first_seen_run: history.first_seen_run,
    price_change: history.price_change,

    enrichment,
    scores,

    agent_notes: history.agent_notes,
    flags,
    share_signals: raw.share_signals,
  }
}

/**
 * Composite desc, then rent, then id (§4 step 7). The tie-breakers keep the
 * file byte-stable when scores collide, which they will while six of the nine
 * factors sit out of the composite.
 */
export function sortListings(listings: ListingEntry[]): ListingEntry[] {
  return listings.sort(
    (a, b) =>
      b.scores.composite - a.scores.composite ||
      (a.price_pw ?? Number.MAX_SAFE_INTEGER) - (b.price_pw ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  )
}

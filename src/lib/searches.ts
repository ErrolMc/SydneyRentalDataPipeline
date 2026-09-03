import type {
  Criteria,
  ListingFlag,
  Place,
  PropertyType,
  Search,
  Searches,
  SearchResult,
  Travel,
  TravelMode,
  TravelReport,
} from 'sydney-rental-schema'
import { travelKey } from 'sydney-rental-schema'

/**
 * Turning saved searches into MCP queries, and MCP results back into answers
 * (PLAN.md §3.7).
 *
 * Pure — no I/O, no clock. That is what lets `check-searches.ts` exercise every
 * rule against fixtures without touching REA, which matters because the rules
 * decide what a run is allowed to claim.
 */

// ── planning the queries ─────────────────────────────────────────────────────

/**
 * One pass over the locations, shared by every search that measures from the
 * same place in the same way.
 *
 * `search_listings` takes one `travelMode` per request, so walk and drive are
 * always separate passes. Two walk searches from the same origin are not: they
 * share a pass at the **widest** budget among them, and each applies its own
 * tighter budget afterwards. Two searches at 10 and 15 minutes cost one pass at
 * 15, not two.
 */
export interface SearchQueryGroup {
  /** `office:walk` — the same key the routed time is stored under. */
  key: string
  originId: string
  /** What to send as `travelFrom`. */
  originAddress: string
  mode: TravelMode
  /** What to send as `maxTravelMinutes` — the widest budget in the group. */
  maxTravelMinutes: number
  /**
   * True when this pass needs a `travelArriveBy`. Transit is measured against a
   * timetable, so the run's `transit_departure_resolved` goes with the query;
   * walk and drive have no clock and must not be sent one, since a time on a
   * road mode would move the request to Google's traffic-aware SKU.
   */
  needsArriveBy: boolean
  /** Locations to query, already resolved against the envelope. */
  locations: string[]
  /** The searches this pass serves, in config order. */
  searchIds: string[]
  /**
   * What each search in this pass asked for, by search id.
   *
   * A pass queries the union of its searches' locations, so the union alone
   * cannot say whether any one search got full coverage. Keeping the per-search
   * set is what lets `evaluateSearches` label a search `partial_coverage`
   * honestly when a rule resolved to more than the run managed to query.
   */
  searchLocations: Record<string, string[]>
}

/**
 * Turn a search's `locations` into an explicit list.
 *
 * Three forms collapse to one: absent means the whole envelope, an array is
 * already the answer, and a rule is filtered out of the envelope against
 * `places.json`.
 *
 * A place the rule cannot measure is **kept**. A missing number means nobody
 * looked, not that it is far, and dropping it would rebuild exactly the silent
 * miss the rule exists to prevent — better to query a suburb needlessly than to
 * never see it.
 */
export function resolveSearchLocations(
  search: Search,
  envelopeLocations: readonly string[],
  places: ReadonlyMap<string, Place>,
): { locations: string[]; problem?: string } {
  const requested = search.locations
  if (requested == null) return { locations: [...envelopeLocations] }
  if (Array.isArray(requested)) return { locations: requested }

  const mode = requested.mode ?? search.commute.mode
  const key = travelKey(search.commute.origin, mode)

  if (places.size === 0) {
    return {
      locations: [],
      problem: 'locations is a rule but places.json has no places to resolve it against',
    }
  }

  const locations = envelopeLocations.filter((canonical) => {
    const place = places.get(canonical)
    if (!place) return true // in the envelope but untagged — keep it, see above

    if (requested.within_indicative_minutes != null) {
      const minutes = place.indicative_minutes[key]
      if (minutes != null && minutes > requested.within_indicative_minutes) return false
    }
    if (requested.within_km != null) {
      const km = place.km_from[search.commute.origin]
      if (km != null && km > requested.within_km) return false
    }
    return true
  })

  return { locations }
}

export interface PlanProblem {
  searchId: string
  reason: string
}

/**
 * Group the searches into query passes, refusing anything that reaches outside
 * the capture envelope.
 *
 * A search narrows what REA is asked for; it can never widen it. A search
 * wanting $800 when the envelope caps at $750, or a location the envelope never
 * queries, would silently return less than it claims — so the run stops instead.
 *
 * ## `only`, which replaced `enabled`
 *
 * A search used to carry `enabled`, and a run asked the ones set true. That put
 * a per-run decision in the file that says what the saved questions *are*, and
 * it quietly did a second job — a disabled search stayed in the config, so it
 * stayed in the next run's snapshot, so its page kept being built. Removing it
 * from the config was what deleted its page and stranded its listings.
 *
 * The model is one search answered by many runs at different times, so which
 * searches a given run covers belongs to **the run**: `capture:run
 * --searches=train-25`. `run.searches[]` already records the answer after the
 * fact; this is the same decision made up front, and nothing about the site
 * depends on it. Omitted means every saved search, which is the honest default.
 */
export function planSearchQueries(
  searches: Searches,
  criteria: Criteria,
  places: ReadonlyMap<string, Place> = new Map(),
  only?: readonly string[],
): { groups: SearchQueryGroup[]; problems: PlanProblem[] } {
  const problems: PlanProblem[] = []
  const envelope = criteria.search
  const envelopeLocations = new Set(envelope.locations)
  const byKey = new Map<string, SearchQueryGroup>()

  const wanted = only ? new Set(only) : null
  if (wanted) {
    const known = new Set(searches.searches.map((search) => search.id))
    // A typo in --searches would otherwise run *nothing* and look like a search
    // that matched nothing, which is the false zero this project keeps paying
    // for. Name it instead.
    for (const id of wanted) {
      if (!known.has(id)) problems.push({ searchId: id, reason: 'no such search in searches.json' })
    }
  }

  for (const search of searches.searches) {
    if (wanted && !wanted.has(search.id)) continue

    const origin = searches.origins[search.commute.origin]
    if (!origin) {
      problems.push({ searchId: search.id, reason: `unknown origin "${search.commute.origin}"` })
      continue
    }

    const resolved = resolveSearchLocations(search, envelope.locations, places)
    if (resolved.problem) {
      problems.push({ searchId: search.id, reason: resolved.problem })
      continue
    }
    const locations = resolved.locations
    const outside = locations.filter((location) => !envelopeLocations.has(location))
    if (outside.length > 0) {
      problems.push({
        searchId: search.id,
        reason: `location(s) not in criteria.search.locations: ${outside.join(', ')}`,
      })
      continue
    }

    const cap = search.filters.max_price_pw
    if (cap != null && cap > envelope.max_price_pw) {
      problems.push({
        searchId: search.id,
        reason: `max_price_pw ${cap} is above the envelope's ${envelope.max_price_pw}`,
      })
      continue
    }

    const floor = search.filters.min_beds
    if (floor != null && floor < envelope.min_beds) {
      problems.push({
        searchId: search.id,
        reason: `min_beds ${floor} is below the envelope's ${envelope.min_beds}`,
      })
      continue
    }

    const key = travelKey(search.commute.origin, search.commute.mode)
    const existing = byKey.get(key)

    if (!existing) {
      byKey.set(key, {
        key,
        originId: search.commute.origin,
        originAddress: origin.address,
        mode: search.commute.mode,
        maxTravelMinutes: search.commute.max_minutes,
        needsArriveBy: search.commute.mode === 'transit',
        locations: [...locations],
        searchIds: [search.id],
        searchLocations: { [search.id]: [...locations] },
      })
      continue
    }

    // Widen the pass to cover this search too — both the budget and the locations.
    existing.maxTravelMinutes = Math.max(existing.maxTravelMinutes, search.commute.max_minutes)
    existing.searchIds.push(search.id)
    existing.searchLocations[search.id] = [...locations]
    for (const location of locations) {
      if (!existing.locations.includes(location)) existing.locations.push(location)
    }
  }

  return { groups: [...byKey.values()], problems }
}

// ── deciding what a search matched ───────────────────────────────────────────

/** What a search needs to know about a listing. Deliberately not the whole entry. */
export interface SearchCandidate {
  id: string
  price_pw: number | null
  beds: number
  baths: number
  car_spaces: number
  property_type: PropertyType
  flags: readonly ListingFlag[]
  /** Routed times by `<origin-id>:<mode>`. A missing key means unroutable. */
  travel: Readonly<Record<string, Travel>>
}

/**
 * Does this listing answer this search?
 *
 * The travel test is the one with a trap in it. A listing whose address could
 * not be routed has no entry under the search's key, and that is **not** a
 * match: an unknown time is not evidence of being close, and treating it as one
 * would quietly put unreachable places at the top of a commute search. REA's
 * own filter takes the same position from the other side — it keeps unroutable
 * listings rather than dropping them, and leaves the judgement here.
 */
export function matchesSearch(search: Search, candidate: SearchCandidate): boolean {
  const key = travelKey(search.commute.origin, search.commute.mode)
  const travel = candidate.travel[key]
  if (!travel) return false
  if (travel.minutes > search.commute.max_minutes) return false

  const f = search.filters

  // A listing REA would not price is not one a price filter can pass.
  if (f.max_price_pw != null && (candidate.price_pw === null || candidate.price_pw > f.max_price_pw)) {
    return false
  }
  if (f.min_price_pw != null && (candidate.price_pw === null || candidate.price_pw < f.min_price_pw)) {
    return false
  }

  if (f.min_beds != null && candidate.beds < f.min_beds) return false
  if (f.max_beds != null && candidate.beds > f.max_beds) return false
  if (f.min_baths != null && candidate.baths < f.min_baths) return false
  if (f.min_car_spaces != null && candidate.car_spaces < f.min_car_spaces) return false

  if (f.property_types != null && !f.property_types.includes(candidate.property_type)) return false

  if (f.exclude_flagged != null) {
    for (const flag of f.exclude_flagged) {
      if ((candidate.flags as readonly string[]).includes(flag)) return false
    }
  }

  return true
}

/**
 * True when every one of these searches refuses the listing on its flags alone.
 *
 * A flag exclusion is the one filter nothing else can rescue: price, beds and
 * routed time are all irrelevant once `exclude_flagged` matches. So a listing
 * every covered search excludes this way is already known to match nothing, and
 * `build` can skip fetching its photos rather than paying R2 for a listing the
 * next step discards.
 *
 * Empty is **false**, not vacuously true. A run that covered no searches keeps
 * every listing (`replay` filters on `!hasSearches || matched`), so "no searches
 * exclude it" must not read as "all of them do".
 */
export function excludedByEverySearch(
  searches: readonly Search[],
  flags: readonly string[],
): boolean {
  if (searches.length === 0) return false
  return searches.every((search) =>
    (search.filters.exclude_flagged ?? []).some((flag) => flags.includes(flag)),
  )
}

export interface EvaluationInput {
  searches: Searches
  groups: SearchQueryGroup[]
  candidates: SearchCandidate[]
  /** How many listings each group returned, by group key — the denominator for `considered`. */
  groupTotals: Readonly<Record<string, number>>
  /** Travel reports by group key, as the MCP server gave them. */
  travelReports: Readonly<Record<string, TravelReport | null>>
  /** Locations actually queried this run. Empty means "all of them". */
  searchedLocations: readonly string[]
}

export interface Evaluation {
  /** Search ids per listing id, in config order. Absent means no search matched. */
  matchedByListing: Map<string, string[]>
  results: SearchResult[]
}

/**
 * Run every covered search over the capture and record both halves of the
 * answer: which searches each listing matched, and how each search did.
 *
 * A search's `status` is the honest label for how much of its question was
 * actually asked this run — `partial_coverage` when only some of its locations
 * were queried, because absence from an unqueried suburb is not evidence of
 * anything and the ledger must not read it as one.
 */
export function evaluateSearches(input: EvaluationInput): Evaluation {
  const { searches, groups, candidates, groupTotals, travelReports, searchedLocations } = input
  const groupBySearch = new Map<string, SearchQueryGroup>()
  for (const group of groups) {
    for (const id of group.searchIds) groupBySearch.set(id, group)
  }

  const covered = searchedLocations.length === 0 ? null : new Set(searchedLocations)
  const matchedByListing = new Map<string, string[]>()
  const results: SearchResult[] = []

  for (const search of searches.searches) {
    const group = groupBySearch.get(search.id)
    if (!group) continue // not covered by this run, or refused by planSearchQueries

    let matched = 0
    for (const candidate of candidates) {
      if (!matchesSearch(search, candidate)) continue
      matched += 1
      matchedByListing.set(candidate.id, [...(matchedByListing.get(candidate.id) ?? []), search.id])
    }

    const wanted = group.searchLocations[search.id] ?? group.locations
    const queried = covered === null ? wanted : wanted.filter((location) => covered.has(location))

    results.push({
      id: search.id,
      label: search.label,
      status: queried.length < wanted.length ? 'partial_coverage' : 'ok',
      matched,
      considered: groupTotals[group.key] ?? 0,
      locations_searched: queried,
      travel: travelReports[group.key] ?? null,
    })
  }

  return { matchedByListing, results }
}

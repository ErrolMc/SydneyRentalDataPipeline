import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import {
  CriteriaSchema,
  PlacesSchema,
  SearchesSchema,
  placesByCanonical,
  travelKey,
  type Criteria,
  type ListingFlag,
  type Place,
  type Search,
  type Searches,
} from 'sydney-rental-schema'
import { dataPath, readJsonFile } from '../src/lib/json-io.js'
import {
  evaluateSearches,
  excludedByEverySearch,
  matchesSearch,
  planSearchQueries,
  resolveSearchLocations,
  type SearchCandidate,
} from '../src/lib/searches.js'

test('searches', async (t) => {
  /**
   * Every assertion, recorded as the body runs and replayed as named subtests
   * below. Recording rather than asserting inline keeps `check` synchronous and
   * keeps this file's output — which is the point of it — in the order it was
   * written in.
   *
   * Compared as JSON, exactly as this check always has: `deepStrictEqual` would
   * disagree about an explicit `undefined` where the old comparison did not,
   * and Step 6 is not the place to discover that.
   */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    console.log(
      `${ok ? '  ok  ' : '  FAIL'} ${label}  \u2192  ${JSON.stringify(actual)}` +
        `${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
    )
    recorded.push([label, () => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected))])
  }

  /**
   * Self-check for the pure half of the search model (PLAN.md §3.7).
   *
   *   npm run check:searches
   *
   * `lib/searches.ts` decides two things a run cannot get wrong: which queries go
   * to REA, and what each search is allowed to claim it matched. Both are pure, so
   * both can be pinned here against fixtures — no MCP, no network, no capture.
   *
   * It also parses the real `data/config/searches.json` and plans it against the
   * real envelope, so a search that quietly asks for more than the capture covers
   * is caught by running this rather than by a thin result set weeks later.
   */


  const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)
  const configured = await readJsonFile(dataPath('config', 'searches.json'), SearchesSchema)
  const places = placesByCanonical(
    await readJsonFile(dataPath('config', 'places.json'), PlacesSchema),
  )

  // ── fixtures ─────────────────────────────────────────────────────────────────

  const search = (over: Partial<Search> & Pick<Search, 'id'>): Search =>
    SearchSchemaParse({
      label: over.label ?? over.id,
      commute: { origin: 'office', mode: 'walk', max_minutes: 15 },
      filters: {},
      locations: null,
      ...over,
    })

  function SearchSchemaParse(value: unknown): Search {
    return SearchesSchema.shape.searches.element.parse(value)
  }

  const candidate = (over: Partial<SearchCandidate> = {}): SearchCandidate => ({
    id: 'x',
    price_pw: 600,
    beds: 2,
    baths: 1,
    car_spaces: 0,
    property_type: 'apartment',
    flags: [] as ListingFlag[],
    travel: { 'office:walk': { minutes: 9.4, km: 0.8, mode: 'walk', precision: 'building' } },
    ...over,
  })

  const envelope = (over: Partial<Criteria['search']> = {}): Criteria => ({
    ...criteria,
    search: { ...criteria.search, ...over },
  })

  const searchesFile = (searches: Search[]): Searches => ({
    schema_version: 1,
    version: 1,
    updated_at: '2026-08-24T00:00:00Z',
    origins: { office: { label: 'Office', address: '275 Kent Street, Sydney NSW 2000' } },
    searches,
  })

  // ── the travel test ──────────────────────────────────────────────────────────

  console.log('\nmatchesSearch — travel')
  check('inside the budget matches', matchesSearch(search({ id: 'a' }), candidate()), true)
  check(
    'over the budget does not',
    matchesSearch(search({ id: 'a' }), candidate({ travel: { 'office:walk': { minutes: 15.1, km: 1.4, mode: 'walk', precision: 'building' } } })),
    false,
  )
  check(
    'exactly at the budget does',
    matchesSearch(search({ id: 'a' }), candidate({ travel: { 'office:walk': { minutes: 15, km: 1.4, mode: 'walk', precision: 'building' } } })),
    true,
  )
  // The important one: an unroutable address is not evidence of being close, and
  // treating a missing time as a match would quietly float unreachable places to
  // the top of a commute search.
  check('no routed time does NOT match', matchesSearch(search({ id: 'a' }), candidate({ travel: {} })), false)
  check(
    'a time for a different mode does not count',
    matchesSearch(
      search({ id: 'a' }),
      candidate({ travel: { 'office:drive': { minutes: 4, km: 2, mode: 'drive', precision: 'building' } } }),
    ),
    false,
  )
  check(
    'a time from a different origin does not count',
    matchesSearch(
      search({ id: 'a', commute: { origin: 'home', mode: 'walk', max_minutes: 15 } }),
      candidate(),
    ),
    false,
  )

  // ── the filter tests ─────────────────────────────────────────────────────────

  console.log('\nmatchesSearch — filters')
  const under700 = search({ id: 'a', filters: { max_price_pw: 700 } })
  check('under the cap matches', matchesSearch(under700, candidate({ price_pw: 700 })), true)
  check('over the cap does not', matchesSearch(under700, candidate({ price_pw: 701 })), false)
  // "Contact agent" is not under $700 — it is unknown, and a price filter cannot
  // pass an unknown without inventing the number it is filtering on.
  check('an unpriced listing fails a price filter', matchesSearch(under700, candidate({ price_pw: null })), false)
  check(
    'an unpriced listing passes a search with no price filter',
    matchesSearch(search({ id: 'a' }), candidate({ price_pw: null })),
    true,
  )

  const twoBed = search({ id: 'a', filters: { min_beds: 2, max_beds: 2 } })
  check('beds in range', matchesSearch(twoBed, candidate({ beds: 2 })), true)
  check('beds under', matchesSearch(twoBed, candidate({ beds: 1 })), false)
  check('beds over', matchesSearch(twoBed, candidate({ beds: 3 })), false)

  const noShares = search({ id: 'a', filters: { exclude_flagged: ['share_house'] } })
  check('unflagged passes', matchesSearch(noShares, candidate()), true)
  check('flagged is excluded', matchesSearch(noShares, candidate({ flags: ['share_house'] })), false)
  check(
    'a different flag is not excluded',
    matchesSearch(noShares, candidate({ flags: ['no_sqm', 'enrichment_incomplete'] })),
    true,
  )

  // ── excluded before its photos are paid for ──────────────────────────────────
  //
  // `build` skips fetching photos for a listing no covered search can match, so
  // the predicate has to be exactly as strict as `matchesSearch` on flags — and
  // must refuse to answer "excluded" when there is nothing to be excluded by.
  const noStudios = search({ id: 'b', filters: { exclude_flagged: ['studio'] } })
  check('excluded by the only search', excludedByEverySearch([noShares], ['share_house']), true)
  check('excluded by both searches', excludedByEverySearch([noShares, noShares], ['share_house']), true)
  check(
    'one search still admits it, so not excluded',
    excludedByEverySearch([noShares, noStudios], ['share_house']),
    false,
  )
  check(
    'excluded by each search for a different flag',
    excludedByEverySearch([noShares, noStudios], ['share_house', 'studio']),
    true,
  )
  check('an unflagged listing is never excluded', excludedByEverySearch([noShares], []), false)
  check(
    'a search with no exclusions excludes nothing',
    excludedByEverySearch([search({ id: 'c' })], ['share_house']),
    false,
  )
  // Empty must be false, not vacuously true: a run covering no searches keeps
  // every listing, so "no search excludes it" cannot read as "all of them do".
  check('no searches at all is not exclusion', excludedByEverySearch([], ['share_house']), false)

  const flats = search({ id: 'a', filters: { property_types: ['apartment', 'unit'] } })
  check('listed type passes', matchesSearch(flats, candidate({ property_type: 'unit' })), true)
  check('unlisted type does not', matchesSearch(flats, candidate({ property_type: 'house' })), false)

  // ── planning ─────────────────────────────────────────────────────────────────

  console.log('\nplanSearchQueries — grouping')
  const walk10 = search({ id: 'walk-10', commute: { origin: 'office', mode: 'walk', max_minutes: 10 } })
  const walk15 = search({ id: 'walk-15', commute: { origin: 'office', mode: 'walk', max_minutes: 15 } })
  const drive20 = search({ id: 'drive-20', commute: { origin: 'office', mode: 'drive', max_minutes: 20 } })

  const grouped = planSearchQueries(searchesFile([walk10, walk15, drive20]), criteria)
  check('walk and drive are separate passes', grouped.groups.length, 2)
  check('two walk searches share one pass', grouped.groups[0].searchIds, ['walk-10', 'walk-15'])
  // The whole point of grouping: 10 and 15 cost one pass at 15, not two passes.
  check('the pass uses the widest budget', grouped.groups[0].maxTravelMinutes, 15)
  check('the group key is the travel key', grouped.groups[0].key, 'office:walk')
  check('no problems', grouped.problems, [])

  // `only` replaced `enabled`: which searches a run covers is the run's decision,
  // not a flag on the question. Omitted still means all of them.
  const narrowed = planSearchQueries(searchesFile([walk10, drive20]), criteria, new Map(), ['drive-20'])
  check('a search left out of --searches is not queried', narrowed.groups.map((g) => g.key), ['office:drive'])
  const typo = planSearchQueries(searchesFile([walk10, drive20]), criteria, new Map(), ['drive-2'])
  // Silently querying nothing would look exactly like a search that matched
  // nothing — the false zero, arriving through a typo this time.
  check('an unknown id in --searches is refused, not ignored', typo.problems.length, 1)
  check('  and nothing is queried', typo.groups.length, 0)

  console.log('\nplanSearchQueries — a search cannot widen the envelope')
  const tooDear = planSearchQueries(
    searchesFile([search({ id: 'rich', filters: { max_price_pw: 5000 } })]),
    envelope({ max_price_pw: 750 }),
  )
  check('asking above the envelope cap is refused', tooDear.problems.length, 1)
  check('  and it is not queried', tooDear.groups.length, 0)

  // Deliberately somewhere no envelope could ever reach. This fixture used to say
  // Bondi, which stopped being outside the envelope the moment the envelope was
  // derived from measured times rather than hand-written — Bondi is 40 minutes by
  // transit and always should have been in it.
  const elsewhere = planSearchQueries(
    searchesFile([search({ id: 'away', locations: ['Broken Hill NSW 2880'] })]),
    criteria,
  )
  check('a location outside the envelope is refused', elsewhere.problems.length, 1)

  // ── location rules ───────────────────────────────────────────────────────────

  console.log('\nresolveSearchLocations — rules')
  const nearPlace = (canonical: string, minutes: Record<string, number>): Place => ({
    canonical,
    name: canonical.split(' ')[0],
    state: 'NSW',
    postcode: canonical.slice(-4),
    kind: 'suburb',
    centroid: { lat: -33.87, lon: 151.2 },
    km_from: { office: 1 },
    indicative_minutes: minutes,
  })

  const ruleEnvelope = ['Close NSW 2000', 'Far NSW 2999', 'Untagged NSW 2001']
  const rulePlaces = new Map<string, Place>([
    ['Close NSW 2000', nearPlace('Close NSW 2000', { 'office:walk': 12 })],
    ['Far NSW 2999', nearPlace('Far NSW 2999', { 'office:walk': 200 })],
  ])

  const byMinutes = search({
    id: 'rule',
    locations: { within_indicative_minutes: 45, mode: 'walk' },
  })
  check(
    'a rule keeps what is inside it',
    resolveSearchLocations(byMinutes, ruleEnvelope, rulePlaces).locations.includes('Close NSW 2000'),
    true,
  )
  check(
    'a rule drops what is outside it',
    resolveSearchLocations(byMinutes, ruleEnvelope, rulePlaces).locations.includes('Far NSW 2999'),
    false,
  )
  // The rule that stops this becoming another silent miss: no measurement is not
  // a measurement of "far", so an untagged place is queried rather than dropped.
  check(
    'an untagged place is kept, not dropped',
    resolveSearchLocations(byMinutes, ruleEnvelope, rulePlaces).locations.includes('Untagged NSW 2001'),
    true,
  )
  check(
    'a rule reads the mode it names, not the commute mode',
    resolveSearchLocations(
      search({ id: 'r2', locations: { within_indicative_minutes: 45, mode: 'transit' } }),
      ruleEnvelope,
      rulePlaces,
    ).locations.length,
    3, // nothing has a transit time, so nothing can be excluded
  )
  check(
    'a rule with no places to read is refused rather than guessed',
    resolveSearchLocations(byMinutes, ruleEnvelope, new Map()).problem !== undefined,
    true,
  )
  // A rule narrows the envelope exactly like an explicit subset does.
  check(
    'a rule cannot reach outside the envelope',
    resolveSearchLocations(byMinutes, ['Close NSW 2000'], rulePlaces).locations,
    ['Close NSW 2000'],
  )

  const nowhere = planSearchQueries(
    searchesFile([search({ id: 'lost', commute: { origin: 'nowhere', mode: 'walk', max_minutes: 5 } })]),
    criteria,
  )
  check('an unknown origin is refused', nowhere.problems[0]?.reason.includes('unknown origin'), true)

  // ── evaluation ───────────────────────────────────────────────────────────────

  console.log('\nevaluateSearches')
  const file = searchesFile([walk10, walk15])
  const plan = planSearchQueries(file, criteria)
  const near = candidate({ id: 'near', travel: { 'office:walk': { minutes: 8, km: 0.7, mode: 'walk', precision: 'building' } } })
  const mid = candidate({ id: 'mid', travel: { 'office:walk': { minutes: 12, km: 1.1, mode: 'walk', precision: 'street' } } })
  const far = candidate({ id: 'far', travel: { 'office:walk': { minutes: 40, km: 3.4, mode: 'walk', precision: 'building' } } })

  const evaluated = evaluateSearches({
    searches: file,
    groups: plan.groups,
    candidates: [near, mid, far],
    groupTotals: { 'office:walk': 3 },
    travelReports: { 'office:walk': null },
    searchedLocations: [],
  })
  check('the tight search matched one', evaluated.results[0].matched, 1)
  check('the wide search matched two', evaluated.results[1].matched, 2)
  check('a listing records every search that matched it', evaluated.matchedByListing.get('near'), ['walk-10', 'walk-15'])
  check('a listing only the wide search wanted', evaluated.matchedByListing.get('mid'), ['walk-15'])
  check('an out-of-range listing matched nothing', evaluated.matchedByListing.has('far'), false)
  check('considered is the group total, not the match count', evaluated.results[0].considered, 3)
  check('full coverage reads ok', evaluated.results[0].status, 'ok')

  // Absence is only evidence where somebody looked — a run over two of the
  // configured locations must say so, or the ledger will read the rest as gone.
  const partial = evaluateSearches({
    searches: file,
    groups: plan.groups,
    candidates: [near],
    groupTotals: { 'office:walk': 1 },
    travelReports: { 'office:walk': null },
    searchedLocations: criteria.search.locations.slice(0, 2),
  })
  check('a partial run says so', partial.results[0].status, 'partial_coverage')
  check('  and reports only what it covered', partial.results[0].locations_searched.length, 2)

  // ── the real config ──────────────────────────────────────────────────────────

  console.log('\ndata/config/searches.json — as configured')
  const real = planSearchQueries(configured, criteria, places)
  for (const problem of real.problems) {
    console.log(`  ${problem.searchId}: ${problem.reason}`)
  }
  check('every saved search is plannable', real.problems.length, 0)
  check(
    'saved searches are all covered by a pass',
    real.groups.flatMap((g) => g.searchIds).sort(),
    configured.searches.map((s) => s.id).sort(),
  )
  for (const group of real.groups) {
    console.log(
      `        ${group.key.padEnd(14)} ≤${group.maxTravelMinutes} min · ${group.locations.length} location(s) · ` +
        `${group.searchIds.join(', ')}`,
    )
  }

  // A rule keeps a place it cannot measure, on purpose — a missing number is not
  // evidence of being far. But that safety net hides a half-measured places.json:
  // after the envelope was widened, eight outer-western suburbs had a transit time
  // and no walk time, so the 15-minute *walk* search silently picked up Penrith.
  // Counting them here turns that from an invisible over-query into a visible one.
  console.log('\nlocations kept for lack of a measurement')
  for (const search of configured.searches) {
    if (search.locations == null || Array.isArray(search.locations)) continue
    const mode = search.locations.mode ?? search.commute.mode
    const key = travelKey(search.commute.origin, mode)
    const group = real.groups.find((g) => g.searchIds.includes(search.id))
    const kept = (group?.searchLocations[search.id] ?? []).filter(
      (canonical) => places.get(canonical)?.indicative_minutes[key] == null,
    )
    console.log(
      `        ${search.id.padEnd(16)} ${String(kept.length).padStart(3)} of ` +
        `${group?.searchLocations[search.id]?.length ?? 0}` +
        `${kept.length ? `  — ${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ', …' : ''}` : ''}`,
    )
  }

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})

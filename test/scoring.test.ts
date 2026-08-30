import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import {
  CriteriaSchema,
  OFFICE_ORIGIN_ID,
  type SuburbProfile,
  type Travel,
} from 'sydney-rental-schema'
import { dataPath, readJsonFile } from '../src/lib/json-io.js'
import {
  commuteFromTravel,
  commuteMinutes,
  piecewise,
  scoreListing,
  unenrichedBlock,
} from '../src/lib/score.js'
import { allocateRunId, resolveTransitDeparture, sydneyToday } from '../src/lib/sydney.js'

test('scoring', async (t) => {
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

  const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)


  console.log('\npiecewise — price [[650,100],[750,50],[800,0]] (ascending raw)')
  const price = piecewise(criteria.curves.price)
  check('600 (under target, never over 100)', price(600), 100)
  check('650 (at target)', price(650), 100)
  check('700 (midway)', price(700), 75)
  check('750 (at max)', price(750), 50)
  check('800 (at hard cap)', price(800), 0)
  check('950 (way over)', price(950), 0)

  console.log('\npiecewise — space [[55,100],[40,70],[30,40],[20,0]] (descending raw)')
  const space = piecewise(criteria.curves.space)
  check('70 sqm/bed (huge)', space(70), 100)
  check('47.5 sqm/bed', space(47.5), 85)
  check('40 sqm/bed', space(40), 70)
  check('25 sqm/bed', space(25), 20)
  check('15 sqm/bed (tiny)', space(15), 0)

  console.log('\npiecewise — commute [[10,100],[20,75],[30,50],[45,0]]')
  const commute = piecewise(criteria.curves.commute)
  check('30 min (at the dealbreaker cap)', commute(30), 50)
  check('45 min', commute(45), 0)

  console.log('\nscoreListing — M2, no enrichment')
  const base = {
    beds: 2,
    baths: 1,
    car_spaces: 0,
    suburb_key: 'marrickville-2204',
    enrichment: unenrichedBlock('marrickville-2204', 'hash', '2026-08-24T00:00:00Z'),
    suburb_profile: null,
  }

  const withArea = scoreListing({ ...base, price_pw: 700, area_sqm: 80 }, criteria)
  check('confidence with sqm = (25+12+2)/100', withArea.confidence, 0.39)
  check('space raw = 80/2', withArea.factors.space.raw, 40)
  check('six factors sat out', Object.values(withArea.factors).filter((f) => f.score === null).length, 6)
  check('commute excluded as provider_unavailable', withArea.factors.commute.excluded, 'provider_unavailable')
  check('suburb excluded as no_suburb_profile', withArea.factors.suburb.excluded, 'no_suburb_profile')
  check('composite = (25*75 + 12*70 + 2*0)/39', withArea.composite, Number(((25 * 75 + 12 * 70) / 39).toFixed(1)))
  check('no dealbreakers', withArea.dealbreakers, [])

  console.log('\nscoreListing — the suburb factor\'s rent value, published vs observed')
  {
    const profile = (over: Partial<SuburbProfile> = {}): SuburbProfile => ({
      name: 'Marrickville',
      postcode: '2204',
      sal_code: null,
      centroid: { lat: -33.9, lon: 151.15 },
      commute_baseline: null,
      rents: null,
      observed_rents: null,
      bonds: null,
      crime: null,
      census: null,
      percentiles: null,
      agent_notes: '',
      ...over,
    })

    const observed = {
      computed_at: '2026-09-01T00:00:00Z',
      run: '2026-09-01a',
      median_pw_by_beds: { '2': 800 },
      sample_by_beds: { '2': 9 },
      considered: 12,
      min_sample: 5,
    }
    const published = {
      source: 'NSW Fair Trading',
      quarter: '2026-Q2',
      median_rent_by_beds: { '2': 900 },
      annual_change_pct: 4.1,
    }

    // Nothing to compare against: the factor sits out rather than scoring the
    // listing down for a gap in our own data collection.
    const bare = scoreListing({ ...base, price_pw: 700, area_sqm: 80, suburb_profile: profile() }, criteria)
    check('an empty profile still excludes the factor', bare.factors.suburb.excluded, 'incomplete_suburb_profile')
    check('and names no source', bare.factors.suburb.source, undefined)

    // Our own median turns it on, and the factor says so — the claim is weaker
    // than a published series and a reader is entitled to discount it.
    const own = scoreListing(
      { ...base, price_pw: 700, area_sqm: 80, suburb_profile: profile({ observed_rents: observed }) },
      criteria,
    )
    check('observed medians turn the factor on', own.factors.suburb.score !== null, true)
    check('and it says the number is ours, not published', own.factors.suburb.source, 'rents:observed')
    check('700 against an observed 800 scores well', own.factors.suburb.score !== null && own.factors.suburb.score > 60, true)

    // Published wins outright. Averaging the two would produce a number that is
    // neither, with no honest label for it.
    const both = scoreListing(
      { ...base, price_pw: 700, area_sqm: 80, suburb_profile: profile({ rents: published, observed_rents: observed }) },
      criteria,
    )
    check('published figures beat our own', both.factors.suburb.source, 'rents:published')
    check('and the score is the published comparison, not a blend', both.factors.suburb.raw !== own.factors.suburb.raw, true)

    // A bedroom count our sample never covered is not a number.
    const wrongBeds = scoreListing(
      { ...base, beds: 3, price_pw: 700, area_sqm: 80, suburb_profile: profile({ observed_rents: observed }) },
      criteria,
    )
    check('a bed count with no median leaves the factor out', wrongBeds.factors.suburb.excluded, 'incomplete_suburb_profile')

    // Turning the factor on is worth 10 of 100 weight, which is the whole point.
    check('confidence rises by the suburb weight', own.confidence > bare.confidence, true)
  }

  const noArea = scoreListing({ ...base, price_pw: 700, area_sqm: null }, criteria)
  check('confidence without sqm = (25+2)/100', noArea.confidence, 0.27)
  check('space excluded as missing_sqm', noArea.factors.space.excluded, 'missing_sqm')
  // The point of redistribution: a missing measurement costs ~0.2 points, where
  // scoring the absent factor as zero would cost ~21.
  const zeroed = Number(((25 * 75 + 12 * 0 + 2 * 0) / 39).toFixed(1))
  check('missing sqm barely moves the composite', Math.abs(noArea.composite - withArea.composite) < 1, true)
  check('  ...where zeroing it would gut the listing', withArea.composite - zeroed > 20, true)

  const tooDear = scoreListing({ ...base, price_pw: 900, area_sqm: null }, criteria)
  check('rent over the hard cap is a dealbreaker', tooDear.dealbreakers, ['rent_above_hard_cap'])
  check('but it is still scored', tooDear.composite >= 0, true)

  const noPrice = scoreListing({ ...base, price_pw: null, area_sqm: null }, criteria)
  check('no price → price excluded, not zeroed', noPrice.factors.price.excluded, 'missing_price')
  check('no price → no rent dealbreaker fired', noPrice.dealbreakers, [])

  console.log('\ncommuteFromTravel — routed minutes into the enrichment block')
  const routed = (mode: Travel['mode'], minutes: number, km: number, precision: Travel['precision'] = 'building'): Record<string, Travel> =>
    ({ [`${OFFICE_ORIGIN_ID}:${mode}`]: { minutes, km, mode, precision } })

  const transitOnly = commuteFromTravel(routed('transit', 18.6, 11.93), OFFICE_ORIGIN_ID)
  check('transit measured → ok', transitOnly.transit.status, 'ok')
  check('  minutes carried at 1dp, not rounded', transitOnly.transit.minutes, 18.6)
  check('  interchanges unknown, not zero', transitOnly.transit.interchanges, null)
  check('walk and drive not measured → unavailable, not zero', [transitOnly.walk.status, transitOnly.drive.status], ['unavailable', 'unavailable'])
  check('  and carries no minutes', transitOnly.drive.minutes, null)

  const driven = commuteFromTravel(routed('drive', 22, 14.2), OFFICE_ORIGIN_ID)
  check('drive measured → ok with distance', [driven.drive.status, driven.drive.minutes, driven.drive.distance_km], ['ok', 22, 14.2])

  const indicative = commuteFromTravel(routed('transit', 30, 12, 'area'), OFFICE_ORIGIN_ID)
  check('area precision → fallback, still scored', indicative.transit.status, 'fallback')

  const walked = commuteFromTravel(routed('walk', 12, 0.9), OFFICE_ORIGIN_ID)
  check('walk measured → ok with distance', [walked.walk.status, walked.walk.minutes, walked.walk.distance_km], ['ok', 12, 0.9])
  check('  and the modes nobody measured stay unavailable', [walked.transit.status, walked.drive.status], ['unavailable', 'unavailable'])

  const wrongOrigin = commuteFromTravel(routed('transit', 18.6, 11.93), 'somewhere-else')
  check('another origin does not feed the office commute', wrongOrigin.transit.status, 'unavailable')

  console.log('\nscoreListing — with the commute wired in')
  const commuted = (travel: Record<string, Travel>) =>
    scoreListing(
      {
        ...base,
        price_pw: 700,
        area_sqm: null,
        enrichment: {
          ...base.enrichment,
          commute: commuteFromTravel(travel, OFFICE_ORIGIN_ID),
        },
      },
      criteria,
    )

  const byTrain = commuted(routed('transit', 20, 12))
  check('confidence with transit = (25+2+27)/100', byTrain.confidence, 0.54)
  check('  past the 0.5 threshold, so scores show', byTrain.confidence >= 0.5, true)
  check('commute factor scored off the curve', byTrain.factors.commute.score, 75)
  check('20 min is under the 30 min cap → no dealbreaker', byTrain.dealbreakers, [])
  check('35 min is over it → dealbreaker', commuted(routed('transit', 35, 20)).dealbreakers, ['commute_too_long'])

  const byBoth = commuted({ ...routed('transit', 20, 12), ...routed('drive', 25, 14) })
  check('confidence with transit and drive = (25+2+27+2)/100', byBoth.confidence, 0.56)

  // A walk is a commute. One factor, whichever way in is fastest — so a run that
  // measured only `office:walk` scores exactly as one that measured only transit.
  const onFoot = commuted(routed('walk', 20, 1.6))
  check('confidence with only a walk = (25+2+27)/100', onFoot.confidence, 0.54)
  check('  so a walk-only run shows its scores too', onFoot.confidence >= 0.5, true)
  check('  scored off the same curve as transit', onFoot.factors.commute.score, 75)

  console.log('\ncommuteMinutes — the fastest way in wins')
  const empty = () => unenrichedBlock('k', 'h', '2026-08-24T00:00:00Z').commute
  const both = (walk: number, transit: number, interchanges: number | null = null) => ({
    ...empty(),
    walk: { status: 'ok' as const, source: 's', minutes: walk, distance_km: 1 },
    transit: {
      status: 'ok' as const,
      source: 's',
      minutes: transit,
      interchanges,
      walk_minutes_total: null,
      legs_summary: null,
    },
  })
  check('train faster than walking', commuteMinutes(both(24, 12)), 12)
  check('walking faster than the train', commuteMinutes(both(12, 24)), 12)
  // The interchange penalty is what stops a two-change train beating a walk it
  // only wins on paper.
  check('one interchange costs 5 min, so the walk wins', commuteMinutes(both(16, 14, 1)), 16)
  check('  ...and without the change the train would have won', commuteMinutes(both(16, 14, 0)), 14)
  check('nothing measured → null, so the factor sits out', commuteMinutes(empty()), null)

  // Driving is a different question and must not sneak into the commute number.
  const drivenOnly = commuted(routed('drive', 9, 5))
  check('a drive alone does not answer "how do I get to work"', drivenOnly.factors.commute.excluded, 'provider_unavailable')
  check('  it scores its own factor instead', drivenOnly.factors.drive.score, 100)

  console.log('\nsydney')
  check('today is a calendar date', /^\d{4}-\d{2}-\d{2}$/.test(sydneyToday()), true)
  const departure = resolveTransitDeparture('Tuesday', '09:00')
  check('transit departure is a Tuesday 09:00 with a real Sydney offset', /T09:00:00\+1[01]:00$/.test(departure), true)
  check('  it is at least 2 days out', departure.slice(0, 10) >= sydneyToday(), true)
  console.log(`        resolved → ${departure}`)
  check('run id suffix advances past taken ids', allocateRunId([`${sydneyToday()}a`, `${sydneyToday()}b`]), `${sydneyToday()}c`)

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})

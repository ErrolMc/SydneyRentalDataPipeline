import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import { PlacesSchema, SuburbsSchema, type Place, type Places, type SuburbProfile } from 'sydney-rental-schema'
import { dataPath, readJsonFile } from '../src/lib/json-io.js'
import type { RawListing } from '../src/lib/raw.js'
import {
  CENTROID_SAME_WITHIN_M,
  centroidCorrections,
  placeSuburb,
  placesBySuburbKey,
  stubSuburb,
} from '../src/lib/suburbs.js'

test('suburbs', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, label)])
  }

  /**
   * Prove that a suburb has exactly one centroid.
   *
   *   npm run check:suburbs
   *
   * `places.json` and `suburbs.json` both carry one, and until now `build`
   * derived the second without ever consulting the first. This suite exists to
   * keep them from parting again: the fixtures prove the precedence, and the
   * last section reads what is committed and reports the drift still on file.
   *
   * Nothing reads a profile centroid yet — a run refers to a suburb by
   * `enrichment.suburb_ref` and joins it at read time, and scoring never asks
   * where a suburb is. `commute_baseline` will be the first, and it is a routed
   * measurement: a centroid 1.4 km out stops being a visibly wrong coordinate
   * and becomes a confident wrong commute. Cheaper to settle before that stage
   * exists than after it has quoted numbers.
   */

  const place = (name: string, postcode: string, lat: number, lon: number): Place => ({
    canonical: `${name} NSW ${postcode}`,
    name,
    state: 'NSW',
    postcode,
    kind: 'suburb',
    centroid: { lat, lon },
    km_from: {},
    indicative_minutes: {},
  })

  const envelopeOf = (places: Place[]): Places => ({
    schema_version: 1,
    version: 1,
    updated_at: '2026-08-30T00:00:00Z',
    transit_arrive_by: null,
    postcode_range: null,
    places,
  })

  const listing = (over: Partial<RawListing> = {}): RawListing =>
    ({
      suburb: 'Marrickville',
      postcode: '2204',
      lat: null,
      lon: null,
      ...over,
    }) as RawListing

  /* --- the index ------------------------------------------------------------ */

  console.log('\nplacesBySuburbKey\n')
  {
    const byKey = placesBySuburbKey(
      envelopeOf([place('Marrickville', '2204', -33.9, 151.15), place('Walsh Bay', '2000', -33.856, 151.206)]),
    )
    check('keyed the way a listing arrives, not by `canonical`', byKey.has('marrickville-2204'))
    // A precinct is a place too. REA reports a Walsh Bay listing as Walsh Bay,
    // and the envelope's row for it beats anything the gazetteer would say.
    check('a multi-word place keys on its slug', byKey.has('walsh-bay-2000'))
    check('an unknown suburb is absent, not guessed', byKey.get('nowhere-9999') === undefined)
  }

  /* --- precedence ----------------------------------------------------------- */

  console.log('\nplaceSuburb — listings, then the envelope, then the gazetteer\n')
  {
    const envelope = place('Marrickville', '2204', -33.9, 151.15)
    const gazetteer = { lat: -33.8, lon: 151.0 }

    const measured = placeSuburb(
      [listing({ lat: -33.911, lon: 151.155 }), listing({ lat: -33.913, lon: 151.157 })],
      envelope,
      gazetteer,
    )
    // A mean of real positions beats any polygon centroid, and it stays first
    // for the day REA starts publishing coordinates.
    check('real listing positions win', measured?.source === 'listings', JSON.stringify(measured?.centroid))
    check('and are rounded to the 6 dp the files carry', measured?.centroid.lat === -33.912)

    const fromEnvelope = placeSuburb([listing()], envelope, gazetteer)
    check('the envelope beats the gazetteer', fromEnvelope?.source === 'envelope')
    check('and it is the envelope value, not a near one', fromEnvelope?.centroid.lon === 151.15)

    // Not dead code: REA blends `surrounding` listings from neighbouring
    // suburbs into every page, so one can arrive from outside the enumerated
    // postcode range, and the envelope will have no row for it.
    const fallback = placeSuburb([listing()], undefined, gazetteer)
    check('the gazetteer still answers for a suburb outside the envelope', fallback?.source === 'gazetteer')

    check('and nothing is invented when all three are silent', placeSuburb([listing()], undefined, undefined) === null)

    // `build` asks the question this way round to decide what to geocode:
    // nothing placeable without a gazetteer answer means the gazetteer is the
    // only thing left to ask. Pinned here because that idiom is load-bearing.
    check(
      'a suburb the envelope holds never reaches the gazetteer',
      placeSuburb([listing()], envelope, undefined)?.source === 'envelope',
    )
  }

  /* --- corrections ---------------------------------------------------------- */

  console.log('\ncentroidCorrections\n')
  {
    const byKey = placesBySuburbKey(envelopeOf([place('Marrickville', '2204', -33.9, 151.15)]))
    const profile = (lat: number, lon: number): SuburbProfile => stubSuburb('Marrickville', '2204', { lat, lon })

    const drifted = centroidCorrections({ 'marrickville-2204': profile(-33.911, 151.161) }, byKey)
    check('a disagreement is reported', drifted.length === 1, `${Math.round(drifted[0]?.metres ?? 0)} m`)
    check('and it moves toward the envelope', drifted[0]?.to.lat === -33.9)

    const agreeing = centroidCorrections({ 'marrickville-2204': profile(-33.9, 151.15) }, byKey)
    check('an agreement is left alone', agreeing.length === 0)

    // Both files round to 6 dp — about 0.1 m — so float noise must not churn
    // suburbs.json on every build.
    const noise = centroidCorrections({ 'marrickville-2204': profile(-33.900001, 151.150001) }, byKey)
    check(`rounding noise under ${CENTROID_SAME_WITHIN_M} m is not a correction`, noise.length === 0)

    // Its centroid came from the gazetteer and there is nothing better to
    // compare it against. Leaving it alone is the only honest answer.
    const outside = centroidCorrections({ 'nowhere-9999': profile(-33.0, 151.0) }, byKey)
    check('a suburb the envelope does not hold is untouched', outside.length === 0)

    // A profile that only just clears the tolerance is still a correction —
    // the point of the tolerance is rounding, not a quiet drift budget.
    const justOver = centroidCorrections({ 'marrickville-2204': profile(-33.90003, 151.15) }, byKey)
    check('a real disagreement above the tolerance is not swallowed', justOver.length === 1)
  }

  /* --- what is actually committed ------------------------------------------- */

  const [places, suburbs] = await Promise.all([
    readJsonFile(dataPath('config', 'places.json'), PlacesSchema),
    readJsonFile(dataPath('knowledge', 'suburbs.json'), SuburbsSchema),
  ])
  const byKey = placesBySuburbKey(places)
  const outstanding = centroidCorrections(suburbs.suburbs, byKey)
  const orphans = Object.keys(suburbs.suburbs).filter((key) => !byKey.has(key))

  console.log('\ncommitted data\n')
  console.log(
    `  ${places.places.length} envelope places — ${Object.keys(suburbs.suburbs).length} profiles — ` +
      `${orphans.length} outside the envelope`,
  )
  if (outstanding.length > 0) {
    const worst = outstanding[0]
    console.log(
      `\n  ${outstanding.length} profile(s) still disagree with places.json — ` +
        `worst ${worst.key} at ${Math.round(worst.metres)} m.`,
    )
    console.log('  These predate `placeSuburb`; the next build realigns them.')
    for (const c of outstanding.slice(0, 5)) {
      console.log(`    ~ ${c.key.padEnd(24)} ${Math.round(c.metres)} m`)
    }
  } else {
    console.log('\n  every profile agrees with its envelope row.')
  }

  // The drift itself is not asserted — it is data, and it is what the next
  // build fixes. What must hold is that realigning *settles*: `build` writes
  // the corrections once and the build after it finds none, or every run
  // churns suburbs.json and no replay is ever byte-identical again.
  const realigned = Object.fromEntries(
    Object.entries(suburbs.suburbs).map(([key, profile]) => {
      const fix = outstanding.find((c) => c.key === key)
      return [key, fix ? { ...profile, centroid: fix.to } : profile]
    }),
  )
  check('realigning is idempotent — a second pass finds nothing', centroidCorrections(realigned, byKey).length === 0)

  const unplaceable = Object.entries(suburbs.suburbs).filter(
    ([, p]) => !Number.isFinite(p.centroid.lat) || !Number.isFinite(p.centroid.lon),
  )
  check('every committed profile has a finite centroid', unplaceable.length === 0)

  // The envelope is the source of truth, so it had better not disagree with
  // itself: two rows on one key would make `placesBySuburbKey` order-dependent
  // and the correction it produces a coin toss.
  check('no two envelope places share a suburb key', byKey.size === places.places.length)

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})

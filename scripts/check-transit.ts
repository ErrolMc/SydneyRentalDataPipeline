import process from 'node:process'

import { IndexSchema, PRODUCT_CLASS, RunSchema, travelKey, OFFICE_ORIGIN_ID } from '../../SydneyRealEstateFindings/src/lib/schema'
import type { JourneyComposition, Travel } from '../../SydneyRealEstateFindings/src/lib/schema'
import { dataPath, readJsonFile } from './lib/json-io'

/**
 * The MCP server's `WALK_SUSPECT_KMH`, mirrored here **on purpose**.
 *
 * Reading it back out of `mislabelled.threshold_kmh` would be the more obvious
 * thing to do and would make this check unable to fail: a check that takes its
 * expectation from the data it is checking agrees with anything. So the number
 * is stated independently, and an invariant below fails if the server ever
 * raises a flag against a different one.
 *
 * Its derivation lives with the code that applies it, in the server's
 * `src/tfnsw.ts`. Do not re-derive it here.
 */
const WALK_SUSPECT_KMH = 4.85

/** `km ÷ hours` for a routed walk. */
const impliedSpeedKmh = (km: number, minutes: number): number => km / (minutes / 60)

/**
 * Read the journey classifier's working out against a committed run.
 *
 *   npm run check:transit            # the current run
 *   npm run check:transit -- 2026-08-24a
 *
 * The sibling of `check:shares` and `check:studios`, and it exists for the same
 * reason: a classifier that quietly over- or under-flags reads perfectly well in
 * a diff. This one has more to get wrong than either — two thresholds, a
 * two-signal rule, and a scoring landmine it has to keep *not* stepping on.
 *
 * Everything below is recomputed from `run.listings`, never read back from the
 * enrichment's own tally, so agreeing requires both to be right rather than
 * consistently wrong.
 *
 * Three parts:
 *
 *   INVARIANTS   things that must hold. A failure exits non-zero.
 *   FLAGGED      what it caught, and the evidence it caught them on.
 *   WORTH AN EYE what it did NOT catch that sits near a line.
 *
 * A line under WORTH AN EYE is not a bug on its own — the whole point of the
 * two-signal rule is that a fast walk with no ferry near it stays unflagged. It
 * is there so a threshold drifting towards a real case is visible before it
 * arrives.
 */

const runId = process.argv[2]

const index = await readJsonFile(dataPath('index.json'), IndexSchema)
const target = runId ?? index?.current_run
if (!target) {
  console.error('\n✖ no run to check — pass a run id, or build one first\n')
  process.exit(1)
}

const run = await readJsonFile(dataPath('runs', target, 'run.json'), RunSchema)
if (!run) {
  console.error(`\n✖ no such run: ${target} (or it failed schema validation)\n`)
  process.exit(1)
}

const TRANSIT = travelKey(OFFICE_ORIGIN_ID, 'transit')
const WALK = travelKey(OFFICE_ORIGIN_ID, 'walk')
const WALK_CLASSES = new Set<number>([PRODUCT_CLASS.walk, PRODUCT_CLASS.footpath])

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`)
}

interface Row {
  id: string
  address: string
  walk: Travel | undefined
  transit: Travel | undefined
  journey: JourneyComposition | undefined
  /** Implied speed of the walk measurement, or null when there is no walk. */
  kmh: number | null
  interchangesInEnrichment: number | null
}

const rows: Row[] = run.listings.map((listing) => {
  const walk = listing.travel[WALK]
  const transit = listing.travel[TRANSIT]
  return {
    id: listing.id,
    address: listing.address,
    walk,
    transit,
    journey: transit?.composition,
    kmh: walk && walk.minutes > 0 ? impliedSpeedKmh(walk.km, walk.minutes) : null,
    interchangesInEnrichment: listing.enrichment.commute.transit.interchanges,
  }
})

const measured = rows.filter((row) => row.journey !== undefined)
const flagged = rows.filter((row) => row.walk?.mislabelled !== undefined)

const describe = (row: Row) => `${row.id}  ${row.address}`

console.log(`\nJourney classifier — run ${target}`)
console.log(
  `  ${run.listings.length} listings · ${measured.length} with a measured journey · ` +
    `${flagged.length} walk(s) flagged as really a ferry`,
)
console.log(`  threshold: ${WALK_SUSPECT_KMH} km/h, and a ferry must actually serve the address\n`)

console.log('══ INVARIANTS ' + '═'.repeat(58))

/* --- the two-signal rule, both directions ------------------------------- */

const flaggedWithoutBothSignals = flagged.filter((row) => {
  const evidence = row.walk!.mislabelled!
  return !(row.kmh !== null && row.kmh >= WALK_SUSPECT_KMH && evidence.ferry_available)
})
check(
  'every flagged walk has BOTH signals — too fast, and a ferry serves it',
  flaggedWithoutBothSignals.length === 0,
  flaggedWithoutBothSignals.map(describe).join(', ') || `${flagged.length} flagged`,
)

// The contrapositive, and the one that catches a silent miss. Recomputed from
// the raw numbers rather than trusting the flag that is already there.
const shouldBeFlagged = rows.filter(
  (row) =>
    row.kmh !== null &&
    row.kmh >= WALK_SUSPECT_KMH &&
    row.journey?.ferry_available === true,
)
const missed = shouldBeFlagged.filter((row) => row.walk!.mislabelled === undefined)
check(
  'no silent misses — every walk meeting both signals carries the flag',
  missed.length === 0,
  missed.map(describe).join(', ') || `${shouldBeFlagged.length} qualify, ${flagged.length} flagged`,
)

/* --- the mirrored threshold still matches the one that was applied ------- */

const otherThresholds = [
  ...new Set(flagged.map((row) => row.walk!.mislabelled!.threshold_kmh)),
].filter((value) => value !== WALK_SUSPECT_KMH)
check(
  `every flag was raised against ${WALK_SUSPECT_KMH} km/h, the value this check expects`,
  otherThresholds.length === 0,
  otherThresholds.length === 0
    ? `${flagged.length} flag(s) agree`
    : `also found ${otherThresholds.join(', ')} — the server's threshold moved, or the ledger is half re-measured`,
)

/* --- the empty band the threshold sits in ------------------------------- */

const unflaggedSpeeds = rows
  .filter((row) => row.kmh !== null && row.walk!.mislabelled === undefined)
  .map((row) => row.kmh!)
const flaggedSpeeds = flagged.map((row) => row.kmh!)
const fastestUnflagged = unflaggedSpeeds.length ? Math.max(...unflaggedSpeeds) : 0
const slowestFlagged = flaggedSpeeds.length ? Math.min(...flaggedSpeeds) : Infinity

check(
  'the threshold still sits in empty space, not on top of a listing',
  fastestUnflagged < WALK_SUSPECT_KMH && slowestFlagged > WALK_SUSPECT_KMH,
  `fastest unflagged ${fastestUnflagged.toFixed(3)} < ${WALK_SUSPECT_KMH} < ` +
    `${slowestFlagged === Infinity ? '—' : slowestFlagged.toFixed(3)} slowest flagged`,
)

/* --- the interchange landmine ------------------------------------------- */

// `commuteMinutes` reads `enrichment.commute.transit.interchanges` and adds five
// minutes per change, which reaches the `max_commute_minutes` dealbreaker. At two
// changes that removed 130 of 265 listings from the shortlist. The count is
// measured and stored on the composition; writing it here is a scoring change,
// and this is the guard that makes doing it by accident impossible. See ITEM-6.
const leaked = rows.filter((row) => row.interchangesInEnrichment !== null)
check(
  'the interchange count has NOT leaked into scoring',
  leaked.length === 0,
  leaked.length === 0
    ? `${measured.filter((r) => (r.journey?.interchanges ?? 0) > 0).length} listing(s) have a change, none scored for it`
    : `${leaked.length} listing(s) would take a 5-min-per-change penalty: ${leaked.slice(0, 3).map(describe).join(', ')}`,
)

/* --- each composition agrees with itself -------------------------------- */

const serviceLegs = (journey: JourneyComposition) =>
  journey.legs.filter((leg) => !WALK_CLASSES.has(leg.product_class))

const badIsWalk = measured.filter(
  (row) => row.journey!.is_walk !== (serviceLegs(row.journey!).length === 0),
)
check('is_walk agrees with the legs', badIsWalk.length === 0, badIsWalk.map(describe).join(', '))

const badFerry = measured.filter(
  (row) =>
    row.journey!.has_ferry !==
    row.journey!.legs.some((leg) => leg.product_class === PRODUCT_CLASS.ferry),
)
check('has_ferry agrees with the legs', badFerry.length === 0, badFerry.map(describe).join(', '))

const badInterchanges = measured.filter(
  (row) => row.journey!.interchanges !== Math.max(0, serviceLegs(row.journey!).length - 1),
)
check(
  'interchanges is one fewer than the service legs',
  badInterchanges.length === 0,
  badInterchanges.map(describe).join(', '),
)

// A ferry in the chosen journey means one is obviously available; the reverse is
// not true, and that asymmetry is the whole reason `ferry_available` exists.
const ferryWithoutAvailable = measured.filter(
  (row) => row.journey!.has_ferry && !row.journey!.ferry_available,
)
check(
  'has_ferry implies ferry_available',
  ferryWithoutAvailable.length === 0,
  ferryWithoutAvailable.map(describe).join(', '),
)

/* --- the minutes reconcile ---------------------------------------------- */

// The displayed total must be what its parts add up to, or the tooltip and the
// row contradict each other — which they did, before walk legs were re-timed.
const RECONCILE_TOLERANCE_MIN = 0.15
const notReconciling = measured.filter((row) => {
  const journey = row.journey!
  const walkMinutes = (journey.walk_metres / 1000 / journey.walk_speed_kmh) * 60
  const expected = walkMinutes + journey.service_minutes + journey.wait_minutes
  return Math.abs(expected - row.transit!.minutes) > RECONCILE_TOLERANCE_MIN
})
check(
  'the total is its walk-at-our-speed plus services plus waiting',
  notReconciling.length === 0,
  notReconciling.length === 0
    ? `within ${RECONCILE_TOLERANCE_MIN} min on all ${measured.length}`
    : notReconciling.slice(0, 3).map(describe).join(', '),
)

const walkMetresMismatch = measured.filter((row) => {
  const journey = row.journey!
  const summed = journey.legs
    .filter((leg) => WALK_CLASSES.has(leg.product_class))
    .reduce((total, leg) => total + leg.metres, 0)
  return Math.abs(summed - journey.walk_metres) > 1
})
check(
  'walk_metres is the sum of the walk legs',
  walkMetresMismatch.length === 0,
  walkMetresMismatch.slice(0, 3).map(describe).join(', '),
)

/* --- fixtures: what this run cannot exercise ---------------------------- */

// The committed data has no fast walk without a ferry near it, so the rule's
// most important negative case is untested by real listings. It is the case that
// stops the classifier degrading into the implied-speed guard ITEM-3 §3.6
// rejected, so it is held against fixtures instead.
const FIXTURES: { label: string; kmh: number; ferryAvailable: boolean; expect: boolean }[] = [
  { label: 'fast walk, ferry nearby', kmh: 6.53, ferryAvailable: true, expect: true },
  { label: 'fast walk, NO ferry', kmh: 6.53, ferryAvailable: false, expect: false },
  { label: 'normal walk, ferry nearby', kmh: 4.32, ferryAvailable: true, expect: false },
  { label: 'normal walk, no ferry', kmh: 4.32, ferryAvailable: false, expect: false },
  { label: 'exactly at the threshold, ferry', kmh: WALK_SUSPECT_KMH, ferryAvailable: true, expect: true },
  { label: 'a hair under, ferry', kmh: WALK_SUSPECT_KMH - 0.01, ferryAvailable: true, expect: false },
]
const wouldFlag = (kmh: number, ferry: boolean) => kmh >= WALK_SUSPECT_KMH && ferry
const badFixtures = FIXTURES.filter((f) => wouldFlag(f.kmh, f.ferryAvailable) !== f.expect)
check(
  'the two-signal rule behaves on cases this run has none of',
  badFixtures.length === 0,
  badFixtures.map((f) => f.label).join(', ') || `${FIXTURES.length} fixtures`,
)

/* --- what the data actually exercises ----------------------------------- */

const classesSeen = new Set<number>()
for (const row of measured) for (const leg of row.journey!.legs) classesSeen.add(leg.product_class)
const changeCounts = new Map<number, number>()
for (const row of measured) {
  const n = row.journey!.interchanges
  changeCounts.set(n, (changeCounts.get(n) ?? 0) + 1)
}

console.log('\n══ WHAT THIS RUN EXERCISES ' + '═'.repeat(45))
console.log(
  `  product classes  ${[...classesSeen].sort((a, b) => a - b).join(', ')}` +
    `   (unseen here: ${[PRODUCT_CLASS.coach, PRODUCT_CLASS.cycle].filter((c) => !classesSeen.has(c)).join(', ') || 'none'})`,
)
console.log(
  `  changes          ${[...changeCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, count]) => `${n}:${count}`)
    .join('  ')}`,
)
console.log(
  `  really a walk    ${measured.filter((r) => r.journey!.is_walk).length}` +
    `   ·  uses a ferry ${measured.filter((r) => r.journey!.has_ferry).length}` +
    `   ·  ferry nearby ${measured.filter((r) => r.journey!.ferry_available).length}`,
)

/* --- the working out ---------------------------------------------------- */

console.log('\n\n══ FLAGGED — a "walk" the router put on a ferry ' + '═'.repeat(25))
for (const row of flagged.sort((a, b) => b.kmh! - a.kmh!)) {
  const evidence = row.walk!.mislabelled!
  console.log(`\n${describe(row)}`)
  console.log(
    `   walk ${row.walk!.minutes.toFixed(1)} min over ${row.walk!.km.toFixed(2)} km  ` +
      `→ ${evidence.implied_kmh} km/h, above ${evidence.threshold_kmh}`,
  )
  console.log(
    `   a ferry serves this address${row.journey ? `; fastest way in is ${row.journey.legs.map((l) => l.service ?? 'walk').join(' + ')}` : ''}`,
  )
}
if (flagged.length === 0) console.log('\n  (none)')

console.log('\n\n══ WORTH AN EYE — near a line, and not flagged ' + '═'.repeat(26))
const NEAR_BAND_KMH = 0.35
let watched = 0

for (const row of rows) {
  if (row.kmh === null || row.walk!.mislabelled) continue
  const fast = row.kmh >= WALK_SUSPECT_KMH
  const nearThreshold = !fast && row.kmh >= WALK_SUSPECT_KMH - NEAR_BAND_KMH
  const ferry = row.journey?.ferry_available === true
  if (!fast && !nearThreshold) continue
  watched += 1
  const why = fast
    ? `${row.kmh.toFixed(2)} km/h — above the threshold, but no ferry serves this address`
    : `${row.kmh.toFixed(2)} km/h — within ${NEAR_BAND_KMH} of the threshold${ferry ? ', and a ferry is nearby' : ''}`
  console.log(`\n${describe(row)}\n   ${why}`)
}
if (watched === 0) {
  console.log(
    `\n  (none — nothing sits within ${NEAR_BAND_KMH} km/h below ${WALK_SUSPECT_KMH}, ` +
      'and every walk above it is flagged)',
  )
}

/* --- the blind spot, stated rather than hidden -------------------------- */

console.log('\n\n══ WHAT THIS CANNOT SEE ' + '═'.repeat(48))
console.log(
  '  A ferry trip with a long walk at either end averages out below the\n' +
    '  threshold and is missed. Inherent to inferring from a door-to-door speed,\n' +
    '  accepted deliberately, and the reason the band above is printed.',
)

console.log(
  `\n\n${flagged.length} flagged · ${watched} worth an eye · ` +
    `${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`,
)
process.exit(failures === 0 ? 0 : 1)

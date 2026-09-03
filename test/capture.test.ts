import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import { TravelSchema } from 'sydney-rental-schema'

import type { MislabelledWalk } from '../src/distance.js'
import { blankAddressListings } from '../src/lib/rea.js'
import { normaliseMislabelled } from '../src/lib/search-listings.js'
import type { Listing } from '../src/types.js'

/**
 * What a capture is allowed to contain, checked against the schema that reads it
 * back.
 *
 * ## Why this suite exists
 *
 * `enrichWithTravel` is generic over `Locatable`, so it type-checks its writes
 * against `distance.ts`'s own `Travel` and never against the `Listing` they land
 * on — and `Listing.travel` does not declare `mislabelled` at all. So the field
 * is written at run time onto a type that cannot see it, serialised into the
 * capture, and only noticed when `build` parses the capture back through
 * `ReaCaptureSchema`.
 *
 * That is exactly what happened on 2026-09-03: the walk capture completed a full
 * live pass over all 25 locations and then failed at `build` with 177 issues —
 * 59 `filtered_by_travel` entries carrying `impliedKmh` where the schema wants
 * `implied_kmh`. `npm run typecheck` was green throughout and could not have been
 * otherwise.
 *
 * A type cannot catch this, so a test has to. These assertions are deliberately
 * about the *shape crossing the boundary*, not about the ferry rule — the
 * two-signal rule itself is held in `transit`, against real listings and fixtures.
 */
test('capture', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, label)])
  }

  /** Exactly what `flagMislabelledWalks` hands to `distance.ts:1311`. */
  const evidence: MislabelledWalk = {
    actually: 'ferry',
    impliedKmh: 6.53,
    thresholdKmh: 5.0,
    ferryAvailable: true,
  }

  const listingWith = (mislabelled: unknown): Listing =>
    ({
      id: '1',
      address: '1 Test St',
      travel: { minutes: 12.4, km: 1.35, mode: 'walk', precision: 'building', mislabelled },
    }) as unknown as Listing

  /* --- the bug, stated as a failing shape -------------------------------- */

  // If this ever passes, the schema has loosened and the rest of the suite is
  // no longer testing anything.
  const raw = listingWith(evidence)
  check(
    "the router's own camelCase shape is NOT a valid capture travel",
    TravelSchema.safeParse(raw.travel).success === false,
    'implied_kmh / threshold_kmh / ferry_available',
  )

  /* --- what the boundary must do ----------------------------------------- */

  const normalised = listingWith(evidence)
  normaliseMislabelled([normalised])
  const parsed = TravelSchema.safeParse(normalised.travel)
  check(
    'normaliseMislabelled makes it one',
    parsed.success,
    parsed.success ? '' : parsed.error.issues.map((i) => i.path.join('.')).join(', '),
  )

  const out = parsed.success ? parsed.data.mislabelled : undefined
  check(
    'every field carries across, none invented',
    out?.actually === 'ferry' &&
      out?.implied_kmh === evidence.impliedKmh &&
      out?.threshold_kmh === evidence.thresholdKmh &&
      out?.ferry_available === evidence.ferryAvailable,
    JSON.stringify(out),
  )

  /* --- the cases the capture actually contained --------------------------- */

  // All 59 on 2026-09-03 were rejects, not matches. `normaliseMislabelled` runs
  // before `maxTravelMinutes` splits the array precisely so that both sides are
  // written down the same way; a fix applied after the split would have left the
  // capture just as invalid.
  const batch = [listingWith(evidence), listingWith(undefined), listingWith(evidence)]
  normaliseMislabelled(batch)
  check(
    'a whole page normalises, and a listing with no evidence is untouched',
    batch.every((l) => TravelSchema.safeParse(l.travel).success) &&
      (batch[1].travel as { mislabelled?: unknown }).mislabelled === undefined,
  )

  // Idempotent: `searchListings` runs this once, but a caller that ran it twice
  // must not turn a good shape back into a bad one.
  const twice = listingWith(evidence)
  normaliseMislabelled([twice])
  normaliseMislabelled([twice])
  check('running it twice is the same as running it once', TravelSchema.safeParse(twice.travel).success)

  // ── listings REA returned with no address ────────────────────────────────────
  //
  // These are dropped at build with `no address` and never scored — seven in run
  // 2026-09-03a, nineteen in 2026-09-03b. `capture` now resolves them from their
  // detail pages, and this is the part that decides which, and how many fetches
  // that costs. Grouping matters as much as selecting: the same listing comes
  // back from every overlapping suburb, and each one must be one page fetch.
  const row = (id: string, address: string): Listing =>
    ({ id, address, price: '$700 per week' }) as Listing

  const groups = [
    {
      results: [
        row('1', ''),
        row('2', '10 Kent Street, Sydney'),
        row('1', ''),
        row('3', '   '),
      ],
    },
    { results: [row('1', ''), row('4', '5 Bridge Street, Sydney')] },
  ]
  const blanks = blankAddressListings(groups)

  check('only the address-less listings are selected', [...blanks.keys()].sort().join(',') === '1,3')
  check('whitespace counts as no address', blanks.has('3'))
  check(
    'every row of one listing is grouped, so it costs one fetch',
    blanks.get('1')?.length === 3,
    String(blanks.get('1')?.length),
  )
  check('a listing with an address is never selected', !blanks.has('2') && !blanks.has('4'))

  // Patching the returned rows must reach the capture, since they are the very
  // objects about to be serialised.
  for (const occurrence of blanks.get('1') ?? []) occurrence.address = '1 Recovered Way, Sydney'
  check(
    'the selected rows are the capture\'s own objects',
    groups[0].results[0].address === '1 Recovered Way, Sydney' &&
      groups[1].results[0].address === '1 Recovered Way, Sydney',
  )

  check('a group with no results array is skipped, not thrown on', (() => {
    try {
      return blankAddressListings([{}, { results: null }, undefined]).size === 0
    } catch {
      return false
    }
  })())

  for (const [label, fn] of recorded) await t.test(label, fn)
})

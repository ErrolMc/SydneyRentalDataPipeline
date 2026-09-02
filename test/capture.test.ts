import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import { TravelSchema } from 'sydney-rental-schema'

import type { MislabelledWalk } from '../src/distance.js'
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

  for (const [label, fn] of recorded) await t.test(label, fn)
})

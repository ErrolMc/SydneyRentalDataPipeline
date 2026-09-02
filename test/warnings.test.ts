import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import type { EnrichmentStatus, ListingEntry } from 'sydney-rental-schema'

import {
  ENRICHMENT_WARNING_PREFIX,
  LEGACY_ENRICHMENT_WARNING_PREFIX,
  enrichmentWarning,
  missingEnrichment,
  providerWarnings,
} from '../src/lib/warnings.js'

/**
 * What a run says about its own completeness.
 *
 * The note this covers was, until 2026-09-03, a single hardcoded string appended
 * to every run unconditionally and then carried across every replay as though it
 * were a fact about history. The walk run committed that day went out saying
 * "commute times and walkability are unavailable for every listing … scores are
 * hidden on the site and listings are ordered by rent instead" while carrying
 * routed walk times, TfNSW leg breakdowns, walkability from 1,019 POIs and
 * confidence from 0.76 to 0.98.
 *
 * So the assertions that matter here are the negative ones: an enriched run must
 * say **nothing**, and a replay must be able to remove a note an earlier build
 * left behind. A test that only checked the note's wording would have passed
 * against the bug.
 */
test('warnings', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, label)])
  }

  const listing = (commute: EnrichmentStatus, walkability: EnrichmentStatus): ListingEntry =>
    ({
      id: 'x',
      enrichment: {
        commute: {
          walk: { status: commute },
          transit: { status: commute },
          drive: { status: 'unavailable' },
        },
        walkability: {
          cafe: { status: walkability },
          supermarket: { status: walkability },
          gym: { status: walkability },
        },
      },
    }) as unknown as ListingEntry

  /* --- the case the bug produced ----------------------------------------- */

  const enriched = [listing('ok', 'ok'), listing('ok', 'ok')]
  check(
    'a fully enriched run says nothing at all',
    enrichmentWarning(enriched) === null,
    JSON.stringify(enrichmentWarning(enriched)),
  )

  /* --- naming only what is actually missing ------------------------------- */

  const noWalkability = [listing('ok', 'unavailable')]
  check(
    'commute measured, walkability not — names walkability alone',
    missingEnrichment(noWalkability).join('|') === 'walkability',
    missingEnrichment(noWalkability).join(', '),
  )

  const nothing = [listing('unavailable', 'unavailable')]
  check(
    'neither measured — names both',
    missingEnrichment(nothing).join('|') === 'a routed commute time|walkability',
    missingEnrichment(nothing).join(', '),
  )

  // `none_found` means the provider worked and there is genuinely nothing within
  // the radius — a real signal that is scored, not excluded. Counting it as
  // missing would put the note back on runs that measured perfectly well.
  const emptyNeighbourhood = [listing('ok', 'none_found')]
  check(
    'none_found is an answer, not a gap',
    enrichmentWarning(emptyNeighbourhood) === null,
    JSON.stringify(enrichmentWarning(emptyNeighbourhood)),
  )

  const degraded = [listing('fallback', 'fallback')]
  check('fallback is an answer too', enrichmentWarning(degraded) === null)

  // One listing answering is enough for the factor to be in play, so the note is
  // about the run, not about each listing.
  check(
    'one listing measured is enough to drop the note',
    enrichmentWarning([listing('ok', 'ok'), listing('unavailable', 'unavailable')]) === null,
  )

  check('an empty run has nothing to report', enrichmentWarning([]) === null)

  /* --- what replay has to be able to do ----------------------------------- */

  const PARTIAL = 'Partial search: 25 of 398 configured locations were queried (…).'
  const STALE =
    `${LEGACY_ENRICHMENT_WARNING_PREFIX} for this milestone, so commute times and ` +
    'walkability are unavailable for every listing.'

  const replayed = providerWarnings(enriched, [STALE, PARTIAL])
  check(
    'a replay drops the stale note an older build left behind',
    replayed.length === 1 && replayed[0] === PARTIAL,
    JSON.stringify(replayed),
  )

  const stillMissing = providerWarnings(noWalkability, [STALE, PARTIAL])
  check(
    'and replaces it rather than duplicating it when the gap is real',
    stillMissing.length === 2 &&
      stillMissing[0].startsWith(ENRICHMENT_WARNING_PREFIX) &&
      stillMissing[1] === PARTIAL,
    JSON.stringify(stillMissing.map((w) => w.slice(0, 40))),
  )

  // Which locations a partial search queried cannot be recomputed from the
  // listings that came back, so it has to survive every replay.
  check(
    'history survives — the partial-search note is never regenerated, only kept',
    providerWarnings(enriched, [PARTIAL])[0] === PARTIAL,
  )

  check(
    'running it twice does not stack notes',
    providerWarnings(noWalkability, providerWarnings(noWalkability, [PARTIAL])).length === 2,
  )

  /* --- the note itself ----------------------------------------------------- */

  const note = enrichmentWarning(noWalkability) ?? ''
  check(
    'the note says what to do about it',
    note.includes('walkability') && note.includes('replay') && !note.includes('hidden on the site'),
    note,
  )

  for (const [label, fn] of recorded) await t.test(label, fn)
})

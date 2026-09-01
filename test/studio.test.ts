import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import type { ReaListing } from '../src/lib/rea.js'
import { studioListingSignals, studioSignalEvidence } from '../src/lib/studio.js'

test('studio', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    console.log(
      `  ${ok ? ' ok ' : 'FAIL'}   ${label}  →  ${JSON.stringify(actual)}` +
        `${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
    )
    recorded.push([label, () => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected))])
  }

  /**
   * The studio classifier's mechanical halves.
   *
   *   npm run check:studios -- <capture.json>
   *
   * The prose patterns themselves are verified the way the share classifier's
   * are — by reading `check studios` against a real capture, because a regex
   * over marketing copy is a judgement call and a unit test over invented
   * strings would only assert that the author agreed with themselves.
   *
   * What *is* mechanical, and what breaks silently, is asserted here: that REA's
   * property type is read at all, that it is independent of the prose, and that
   * the negation guard still masks the phrases it was written for. Those three
   * are the ones a later edit could quietly undo.
   */

  const listing = (over: Partial<ReaListing> = {}): ReaListing =>
    ({
      id: '1',
      url: '',
      address: { display: '1 Test St, Sydney NSW 2000' },
      propertyType: 'Apartment',
      description: '',
      ...over,
    }) as unknown as ReaListing

  console.log('\nREA says so')
  check(
    'propertyType "Studio" is a signal on its own, with no prose at all',
    studioListingSignals(listing({ propertyType: 'Studio' })),
    ['rea_property_type'],
  )
  check(
    '  it quotes the field, so a reader can see where it came from',
    studioSignalEvidence(listing({ propertyType: 'Studio' }))[0].quote,
    'REA property type: Studio',
  )
  check(
    '  an ordinary type says nothing by itself',
    studioListingSignals(listing({ propertyType: 'Apartment' })),
    [],
  )
  check('  nor does a missing one', studioListingSignals(listing({ propertyType: undefined })), [])

  // Ten of the 30 REA-typed studios in the 2026-08-24 transit capture never use
  // the word. Prose alone would let every one of them through unlabelled, which
  // is the whole reason the type is consulted.
  check(
    'a typed studio whose ad never says the word is still flagged',
    studioListingSignals(
      listing({ propertyType: 'Studio', description: 'Light-filled inner-city living, moments from the park.' }),
    ),
    ['rea_property_type'],
  )

  console.log('\nthe prose, and what it refuses to count')
  check(
    'an untyped listing whose ad offers a studio is flagged',
    studioListingSignals(listing({ description: 'This spacious studio is fully renovated.' })),
    ['studio_offered'],
  )
  check(
    '  "not a studio" is not an offer',
    studioListingSignals(listing({ description: 'A true one bedroom (not a studio) in the heart of it.' })),
    [],
  )
  check(
    '  nor is "studio-style", which is a two-bedder describing its living area',
    studioListingSignals(listing({ description: 'The studio-style living area opens to a balcony.' })),
    [],
  )
  check(
    '  nor is a yoga studio down the road',
    studioListingSignals(listing({ description: 'Moments from cafes and a yoga studio.' })),
    [],
  )

  /**
   * The disagreement case, and the reason the type is evaluated separately: REA
   * types it `Studio` while the copy calls it a one-bedder. Masking the prose
   * must not take the structured field down with it — that would be silently
   * trusting marketing over REA's own classification.
   */
  check(
    'REA says Studio and the ad denies it → still flagged, on the type alone',
    studioListingSignals(
      listing({ propertyType: 'Studio', description: 'A true one bedroom (not a studio), beautifully presented.' }),
    ),
    ['rea_property_type'],
  )

  console.log('\nboth at once')
  check(
    'type and prose together report both, type first',
    studioListingSignals(
      listing({ propertyType: 'Studio', description: 'Furnished studio apartments available now.' }),
    ),
    ['rea_property_type', 'studio_dwelling', 'studio_offered'],
  )
  // `studios_offered` wants the plural specifically — "studio apartments" is one
  // studio, "furnished studios" is an offer of several — and `studio_offered`
  // ends at `studio`, so it does *not* also fire on the plural. Worth pinning:
  // the two are one character apart and the wrong one firing would be invisible.
  check(
    '  the plural pattern needs an actual plural',
    studioListingSignals(listing({ description: 'Fully furnished studios in the heart of Surry Hills.' })),
    ['studios_offered'],
  )

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})

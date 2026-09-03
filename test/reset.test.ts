import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import { listingIdFromKey, objectKeyFor } from '../src/lib/r2.js'

/**
 * What `reset --run` is allowed to delete.
 *
 * `reset` without a scope destroys everything on purpose, and that is fine
 * because it is unambiguous. `--run` is the dangerous one: it deletes some
 * photos and keeps others, and every decision runs through
 * `listingIdFromKey`. A wrong answer there deletes photos belonging to a run
 * nobody asked to remove — irreversibly, since R2 deletion is the one step that
 * cannot be undone.
 *
 * The rule the scoped reset enforces, and the reason this file exists: a
 * listing's photos may only go when **no remaining run references that
 * listing**. Verified live on 2026-09-03 — removing run 2026-09-03a proposed
 * deleting 0 of 3522 objects, because all eleven of its listings are carried
 * over into 2026-09-03b, while removing 2026-09-03b proposed 3276, holding back
 * exactly the shared eleven.
 */
test('reset', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, `${label}${detail ? ` — ${detail}` : ''}`)])
  }

  console.log('\nwhich listing an object key belongs to\n')

  check(
    'a stored key, which carries no leading slash',
    listingIdFromKey('images/listings/444938292/01.webp') === '444938292',
    String(listingIdFromKey('images/listings/444938292/01.webp')),
  )
  check(
    'the same path as a run records it, with a leading slash',
    listingIdFromKey('/images/listings/444938292/01.webp') === '444938292',
  )
  check(
    'and both spellings agree, which is the point',
    listingIdFromKey('/images/listings/444938292/01.webp') ===
      listingIdFromKey(objectKeyFor('/images/listings/444938292/01.webp')),
  )
  check(
    'thumbnails belong to the same listing',
    listingIdFromKey('images/listings/444938292/01.thumb.webp') === '444938292',
  )

  console.log('\nand what it must refuse to claim\n')

  // Each of these, misread, deletes something nobody asked to delete.
  check('a key with no listing segment', listingIdFromKey('images/other/1/01.webp') === null)
  check('the listings folder itself', listingIdFromKey('images/listings/') === null)
  check('a listing folder with no file', listingIdFromKey('images/listings/444938292/') === null)
  check('an empty key', listingIdFromKey('') === null)
  check(
    'a folder merely named like it',
    listingIdFromKey('images/sublistings/444938292/01.webp') === null,
    String(listingIdFromKey('images/sublistings/444938292/01.webp')),
  )
  check(
    'a nested path does not hand back the wrong segment',
    listingIdFromKey('images/listings/444938292/nested/01.webp') === null,
    String(listingIdFromKey('images/listings/444938292/nested/01.webp')),
  )

  console.log('\nthe rule the scoped reset enforces\n')

  // The set arithmetic `resetRuns` performs, stated plainly: shared listings
  // survive, exclusive ones do not.
  const removed = ['a', 'b', 'shared']
  const keptByOtherRuns = new Set(['shared', 'c'])
  const doomed = new Set(removed.filter((id) => !keptByOtherRuns.has(id)))

  check('a listing only the removed run had is deleted', doomed.has('a') && doomed.has('b'))
  check('a listing another run still references survives', !doomed.has('shared'))
  check('and nothing else is touched', doomed.size === 2, [...doomed].join(','))

  const keys = [
    'images/listings/a/01.webp',
    'images/listings/shared/01.webp',
    'images/listings/c/01.webp',
  ]
  const toDelete = keys.filter((key) => {
    const id = listingIdFromKey(key)
    return id !== null && doomed.has(id)
  })
  check(
    'so only the exclusive listing\'s objects are selected',
    toDelete.length === 1 && toDelete[0] === 'images/listings/a/01.webp',
    toDelete.join(', '),
  )

  console.log('\n(assertions below)\n')

  for (const [label, fn] of recorded) await t.test(label, fn)
})

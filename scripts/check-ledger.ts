// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import { LedgerSchema } from 'sydney-rental-schema'
import { dataPath, readJsonFile } from './lib/json-io'
import { mergeRejected, type CapturedRejection } from './lib/ledger'

/**
 * Prove `mergeRejected` against fixtures, and read the committed ledger back.
 *
 *   npm run check:ledger
 *
 * Fixtures rather than committed data, because **no run has ever produced a
 * rejection**. The MCP server only began returning `filteredByTravel` today, so
 * the committed ledger has an empty `rejected` map and will until the next
 * capture. AGENTS.md is explicit about this case: a control the data cannot
 * exercise yet is covered by fixtures rather than shipped unproven.
 *
 * What is being protected is not obvious. These entries exist only so a
 * rejection is not paid for twice — the server geocodes and routes a listing,
 * decides it is outside the budget, and drops it. Get the merge wrong and the
 * failure is silent in both directions: forget a rejection and every run
 * re-buys it; keep a stale one and a listing that moved gets a travel time
 * describing somewhere else.
 */

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
}

const AT = '2026-08-28T00:00:00Z'
const rejection = (over: Partial<CapturedRejection> = {}): CapturedRejection => ({
  id: 'r1',
  url: 'https://www.realestate.com.au/property-1',
  address: '1 Far Away St, Woop Woop',
  coords: { lat: -33.9, lng: 151.1 },
  travel: { minutes: 41.2, km: 12.3, mode: 'walk', precision: 'building' },
  ...over,
})
const group = (items: CapturedRejection[], origin = 'office', mode = 'walk') => ({
  origin,
  mode,
  filtered_by_travel: items,
})

console.log('\nmergeRejected — remembering what the travel budget threw away\n')

/* --- the basics ---------------------------------------------------------- */

{
  const { rejected, seen } = mergeRejected({
    previous: {},
    groups: [group([rejection()])],
    publishedIds: [],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  check('a rejection is remembered', Object.keys(rejected).length === 1, `seen ${seen}`)
  check('  with its routed time, keyed by origin:mode', rejected.r1?.travel['office:walk']?.minutes === 41.2)
  check('  and the address that invalidates it', rejected.r1?.travel['office:walk']?.address === '1 Far Away St, Woop Woop')
  check('  position carried across, lng → lon', rejected.r1?.lat === -33.9 && rejected.r1?.lon === 151.1)
}

/* --- no URL, no entry ---------------------------------------------------- */

{
  const { rejected } = mergeRejected({
    previous: {},
    groups: [group([rejection({ url: null })])],
    publishedIds: [],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  // Nothing to open later to resolve it, and a fabricated URL is worse than
  // forgetting the listing — `RejectedEntrySchema.url` would reject it anyway.
  check('a rejection with no URL is dropped, not invented', Object.keys(rejected).length === 0)
}

/* --- publication wins over rejection ------------------------------------- */

{
  // The same listing can be rejected by the walk pass and kept by the transit
  // pass in one capture. Being kept is what counts.
  const { rejected } = mergeRejected({
    previous: {},
    groups: [group([rejection()])],
    publishedIds: ['r1'],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  check('a listing the run published is not also a rejection', rejected.r1 === undefined)
}

{
  const previous = mergeRejected({
    previous: {},
    groups: [group([rejection()])],
    publishedIds: [],
    runId: '2026-08-27a',
    computedAt: AT,
  }).rejected
  const { rejected } = mergeRejected({
    previous,
    groups: [],
    publishedIds: ['r1'],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  check('...and graduating out of rejection clears an older entry', rejected.r1 === undefined)
}

/* --- accumulating across passes and runs --------------------------------- */

{
  const first = mergeRejected({
    previous: {},
    groups: [group([rejection()])],
    publishedIds: [],
    runId: '2026-08-27a',
    computedAt: AT,
  }).rejected
  const { rejected } = mergeRejected({
    previous: first,
    groups: [
      group([rejection({ travel: { minutes: 55, km: 12.3, mode: 'transit', precision: 'building' } })], 'office', 'transit'),
    ],
    publishedIds: [],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  check('a second mode adds to the same entry', Object.keys(rejected.r1?.travel ?? {}).length === 2)
  check('  the earlier mode survives', rejected.r1?.travel['office:walk']?.minutes === 41.2)
  check('  last_seen_run advances', rejected.r1?.last_seen_run === '2026-08-28a')
}

/* --- the address is the invalidation key --------------------------------- */

{
  const first = mergeRejected({
    previous: {},
    groups: [group([rejection()])],
    publishedIds: [],
    runId: '2026-08-27a',
    computedAt: AT,
  }).rejected
  const { rejected } = mergeRejected({
    previous: first,
    groups: [group([rejection({ address: '2 Somewhere Else Rd, Elsewhere', travel: null })])],
    publishedIds: [],
    runId: '2026-08-28a',
    computedAt: AT,
  })
  // Keeping it would describe a journey to the old address, which is the one
  // failure here that produces a confident wrong number rather than a missing one.
  check('an edited address discards the old routed times', Object.keys(rejected.r1?.travel ?? {}).length === 0)
}

/* --- what is actually committed ------------------------------------------ */

const ledger = await readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema)
if (!ledger) {
  console.error('\n✖ data/knowledge/listings.json is missing or invalid\n')
  process.exit(1)
}
const rejectedCount = Object.keys(ledger.rejected).length
const overlap = Object.keys(ledger.rejected).filter((id) => ledger.listings[id])

console.log('\ncommitted ledger\n')
check('every rejection is absent from `listings`', overlap.length === 0, overlap.slice(0, 3).join(', ') || `${rejectedCount} rejected`)
console.log(`\n  ${Object.keys(ledger.listings).length} tracked · ${rejectedCount} rejected on travel time`)
if (rejectedCount === 0) {
  console.log('  (none yet — no capture has run since the server started returning them)')
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

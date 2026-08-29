// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import { LedgerSchema, SiteConfigSchema, type Ledger } from '../../SydneyRealEstateFindings/src/lib/schema'
import { computeConfigHash } from './lib/config-hash'
import { dataPath, readJsonFile, writeJsonFile } from './lib/json-io'
import { fetchWalkabilityPois, type Point } from './lib/overpass'
import { cacheIsFresh, walkabilityFor } from './lib/walkability'

/**
 * Protocol step 6, the half a capture cannot supply: the nearest cafe,
 * supermarket and gym for every listing the ledger knows about.
 *
 *   npm run enrich:walk -- [--dry-run] [--force]
 *
 * This writes the **ledger**, not a run. Walkability is a fact about a place
 * rather than about a moment — a cafe 290 m away is 290 m away whichever run
 * asked — so it is cached against the listing and copied into a run when one is
 * built or replayed. That is what makes it free to backfill a run that has
 * already been committed: `npm run replay:run` reads this cache.
 *
 * Nothing here costs money. Overpass is volunteer-run and free, which is why it
 * is asked about ~15 grid cells rather than 265 listings, at one request per two
 * seconds. See `lib/overpass.ts`.
 *
 * `--force` re-asks for listings whose cache is still fresh. `--dry-run` prints
 * the plan and the cells without sending anything.
 */

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

async function main() {
  const [site, ledger] = await Promise.all([
    readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema),
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema),
  ])

  const configHash = computeConfigHash(site)
  const entries = Object.entries(ledger.listings)

  console.log(`\nWalkability${DRY_RUN ? '  (dry run — nothing will be sent or written)' : ''}`)
  console.log(`  ledger      ${entries.length} listing(s)`)
  console.log(`  config      radius ${site.walk.poi_radius_m} m · ${site.walk.speed_m_per_min} m/min · detour ×${site.walk.detour_factor}`)
  console.log(`  config_hash ${configHash.slice(0, 12)}…`)

  const located = entries.filter(([, entry]) => entry.lat !== null && entry.lon !== null)
  const unlocatable = entries.length - located.length

  const todo = located.filter(
    ([, entry]) =>
      FORCE || !cacheIsFresh(entry.walkability, configHash, { lat: entry.lat!, lon: entry.lon! }),
  )

  console.log(`  cached      ${located.length - todo.length} still fresh`)
  console.log(`  to ask      ${todo.length}${FORCE ? ' (--force: re-asking everything)' : ''}`)
  if (unlocatable > 0) {
    console.log(`  no lat/lon  ${unlocatable} — these stay unavailable, never none_found`)
  }

  if (todo.length === 0) {
    console.log('\n  Nothing to do. Every located listing has a fresh answer.\n')
    return
  }

  const points: Point[] = todo.map(([, entry]) => ({ lat: entry.lat!, lon: entry.lon! }))

  if (DRY_RUN) {
    const { cellsFor } = await import('./lib/overpass')
    const cells = cellsFor(points, site.walk.poi_radius_m)
    console.log(`\n  would ask Overpass about ${cells.length} cell(s):`)
    for (const cell of cells) {
      console.log(
        `    ${cell.south.toFixed(3)},${cell.west.toFixed(3)} → ${cell.north.toFixed(3)},${cell.east.toFixed(3)}   ${cell.listings} listing(s)`,
      )
    }
    console.log('\n  Dry run — nothing sent, nothing written.\n')
    return
  }

  console.log('')
  const pois = await fetchWalkabilityPois(points, site.walk.poi_radius_m, (message) =>
    console.log(message),
  )

  const tally = { cafe: 0, supermarket: 0, gym: 0 }
  for (const poi of pois) tally[poi.kind] += 1
  console.log(
    `\n  found       ${pois.length} POI(s): ${tally.cafe} cafe, ${tally.supermarket} supermarket, ${tally.gym} gym`,
  )

  const computedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const nextListings: Ledger['listings'] = { ...ledger.listings }
  const missing = { cafe: 0, supermarket: 0, gym: 0 }

  for (const [id, entry] of todo) {
    const point = { lat: entry.lat!, lon: entry.lon! }
    const blocks = walkabilityFor(point, pois, site.walk)
    for (const kind of ['cafe', 'supermarket', 'gym'] as const) {
      if (blocks[kind].status === 'none_found') missing[kind] += 1
    }
    nextListings[id] = {
      ...entry,
      walkability: { computed_at: computedAt, config_hash: configHash, ...point, ...blocks },
    }
  }

  console.log(
    `  none found  ${missing.cafe} cafe, ${missing.supermarket} supermarket, ${missing.gym} gym — a real signal, scored, not excluded`,
  )

  await writeJsonFile(dataPath('knowledge', 'listings.json'), {
    ...ledger,
    updated_at: computedAt,
    listings: nextListings,
  })

  console.log(`\n  wrote       data/knowledge/listings.json — ${todo.length} listing(s) enriched`)
  console.log('\n  Next: replay the runs that should carry these, then npm run validate:data.\n')
}

main().catch((error) => fail((error as Error).message))

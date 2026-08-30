// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import {
  IndexSchema,
  LedgerSchema,
  RunSchema,
  SearchesSchema,
  TravelMode,
  travelKey,
  type TravelPrecision,
} from 'sydney-rental-schema'
import { dataPath, readJsonFile, writeJsonFile } from './lib/json-io'
import { callRoutePlaces } from './lib/tools'
import { RoutePlacesReportSchema, toMislabelled } from './lib/route-places'

/**
 * Measure a travel mode the runs never asked for, for listings we already know.
 *
 *   npm run enrich:travel -- [--mode=walk] [--dry-run] [--force]
 *
 * ## The problem this exists for
 *
 * A run measures only the modes its searches ask for, because `travelMode` is
 * one per request. `2026-08-25a` asked `train-25`, so all 265 of its listings
 * carry a transit time and nothing else — and `travel.mode` is the mode that was
 * **requested**, echoed back, not a description of what the router did. Google
 * returns a walking route as the transit answer when walking is fastest, so the
 * site told a reader to catch public transport 370 metres. Thirteen of the 265
 * transit times are at walking pace.
 *
 * That cannot be fixed by looking at the number. `computeRouteMatrix` returns
 * `duration` and `distanceMeters` and no legs at all — leg detail lives on
 * `computeRoutes`, one route per request rather than a hundred per request — so
 * "did this route use a train" is not in the data at any field mask. Inferring
 * it from an implied speed would be a guess dressed as a fact.
 *
 * Measuring the walk answers it properly: two measured numbers, and whichever is
 * lower is how you would actually get there. `commuteMinutes` in `score.ts` has
 * always computed exactly that `min(...)` — it has simply never had both.
 *
 * ## Why this costs almost nothing
 *
 * `route_places` takes **coordinates**, not a search: it geocodes nothing, drives
 * no browser, and never touches realestate.com.au. Every listing's lat/lon is
 * already in the ledger, put there by the search that first routed it. So one
 * walk pass is ~285 route elements against 10,000 free a month, where going back
 * to REA for the same answer would be ~9,100 — that pass routes everything REA
 * returns, including the surrounding-suburb blending, before anything is
 * filtered.
 *
 * ## Why it writes the ledger
 *
 * Same reason walkability does (ITEM-3 §3.4): a routed minute is a fact about a
 * place, not about a moment, and PLAN.md §3.5 already specifies the ledger's
 * `travel` map as its cache — "a routed minute costs a geocode and a matrix leg
 * to produce, so it is kept whether or not a search wanted it". That field has
 * been empty on all 288 entries since the ledger existed: `ledger.ts` initialises
 * it to `{}` and nothing has ever written it. This is what writes it.
 *
 * Writing the ledger rather than a run is also what makes a **committed** run
 * fixable for free: `buildListingEntry` merges this cache in, so
 * `npm run replay:run` backfills both runs with no REA spend and no new run.
 */

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
const MODE = TravelMode.parse(
  process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'walk',
)

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

async function main() {
  if (MODE === 'transit') {
    // Transit needs an arrive-by, and the run's own resolved moment is the only
    // one that keeps its numbers comparable with each other. Backfilling it here
    // would quietly measure against a different timetable.
    fail('transit is measured by a run, against its own arrive-by. This backfills walk and drive.')
  }

  const [ledger, searches, index] = await Promise.all([
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema),
    readJsonFile(dataPath('config', 'searches.json'), SearchesSchema),
    readJsonFile(dataPath('index.json'), IndexSchema),
  ])

  const originId = 'office'
  const origin = searches.origins[originId]
  if (!origin) fail(`searches.json has no "${originId}" origin to measure towards`)

  const key = travelKey(originId, MODE)
  const entries = Object.entries(ledger.listings)
  const located = entries.filter(([, entry]) => entry.lat !== null && entry.lon !== null)

  /**
   * `route_places` geocodes nothing, so it cannot report how well an address
   * resolved — but the coordinate it is handed came from a search that did, and
   * a walk from that point is exactly as precise as the point. Carry it forward
   * from whichever run measured the listing, and fall back to `street` rather
   * than claiming `building` about a coordinate whose provenance we cannot see.
   */
  const precisionById = new Map<string, TravelPrecision>()
  for (const manifest of index.runs) {
    const run = await readJsonFile(dataPath('runs', manifest.id, 'run.json'), RunSchema)
    for (const listing of run.listings) {
      for (const travel of Object.values(listing.travel)) {
        if (!precisionById.has(listing.id)) precisionById.set(listing.id, travel.precision)
      }
    }
  }

  const todo = located.filter(([, entry]) => {
    const cached = entry.travel[key]
    if (FORCE || !cached) return true
    // `address` is the invalidation key the schema documents: an agent editing a
    // listing's address invalidates its route, and nothing else does.
    return cached.address !== entry.address
  })

  console.log(`\nRouted ${MODE} times${DRY_RUN ? '  (dry run — nothing sent or written)' : ''}`)
  console.log(`  ledger      ${entries.length} listing(s), ${located.length} with coordinates`)
  console.log(`  towards     ${origin.label} — ${origin.address}`)
  console.log(`  cached      ${located.length - todo.length} already measured`)
  console.log(`  to measure  ${todo.length}${FORCE ? ' (--force)' : ''}`)
  console.log(`  precision   ${todo.filter(([id]) => precisionById.get(id) === 'building').length} building · rest street`)

  if (entries.length - located.length > 0) {
    console.log(
      `  no coords   ${entries.length - located.length} cannot be measured — an unplaced listing` +
        ` matches nothing rather than counting as close`,
    )
  }

  if (todo.length === 0) {
    console.log('\nNothing to do.\n')
    return
  }
  if (DRY_RUN) {
    console.log(`\nWould send ${todo.length} coordinate(s) in one route_places call.\n`)
    return
  }

  let report
  // Parsed, not cast. An inline `as` here is what let the server's measured
  // journey arrive and be dropped for as long as nobody looked — see
  // `lib/route-places.ts`.
  report = RoutePlacesReportSchema.parse(
    await callRoutePlaces({
      places: todo.map(([id, entry]) => ({ id, lat: entry.lat!, lng: entry.lon! })),
      destination: origin.address,
      travelMode: MODE,
    }),
  )

  // Same stamp shape the walkability enricher writes, so the two caches read alike.
  const computedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let written = 0
  let mislabelled = 0
  for (const leg of report.legs) {
    const entry = ledger.listings[leg.id]
    if (!entry) continue
    entry.travel[key] = {
      minutes: leg.minutes,
      km: leg.km,
      mode: MODE,
      precision: precisionById.get(leg.id) ?? 'street',
      // The server decides this: too fast to be walking, and a ferry actually
      // serves the address. Carried across rather than re-derived here.
      ...(leg.mislabelled ? { mislabelled: toMislabelled(leg.mislabelled) } : {}),
      computed_at: computedAt,
      address: entry.address,
    }
    written += 1
    if (leg.mislabelled) mislabelled += 1
  }

  console.log(`\n  measured    ${report.legs.length} (${report.cachedLegs} from the server's own cache)`)
  console.log(`  router      ${report.router} · ${report.matrixCalls} matrix request(s)`)
  if (mislabelled > 0) {
    console.log(`  ferries     ${mislabelled} "${MODE}" that the timetable says crosses water`)
  }
  if (report.unroutable.length > 0) {
    // Never a straight line standing in for a measurement.
    console.log(`  unroutable  ${report.unroutable.length} — left with no ${MODE} time at all`)
  }

  ledger.updated_at = computedAt
  await writeJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema.parse(ledger))
  console.log(`\n✔ wrote ${written} ${key} time(s) into the ledger.`)
  console.log('  Replay the committed runs to put them on the site:')
  for (const manifest of index.runs) {
    console.log(`    npm run replay:run -- <capture> --run-id=${manifest.id}`)
  }
  console.log()
}

main().catch((error: unknown) => fail((error as Error).message))

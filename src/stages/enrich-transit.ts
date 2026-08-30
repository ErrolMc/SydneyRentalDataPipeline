// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import process from 'node:process'

import { LedgerSchema, SiteConfigSchema, travelKey, OFFICE_ORIGIN_ID } from 'sydney-rental-schema'
import { dataPath, readJsonFile, writeJsonFile, isoNow } from '../lib/json-io.js'
import { callRoutePlaces } from '../lib/tools.js'
import {
  RoutePlacesReportSchema,
  describeComposition,
  toComposition,
  type RoutePlacesReport,
} from '../lib/route-places.js'
import { fail } from '../lib/stage-error.js'
import { resolveTransitDeparture } from '../lib/sydney.js'

/**
 * Record what each listing's commute actually *is*, measured by the MCP server.
 *
 *   npm run enrich:transit -- [--dry-run] [--limit=N] [--force]
 *
 * ## What this does and does not do
 *
 * It measures nothing. It asks `route_places` for `transit`, and writes the
 * journey the server returns into the ledger's `travel` cache. Every judgement
 * in that answer — which planner to ask, which of the offered journeys is
 * fastest, what walking speed to re-time the walk legs at, whether a ferry
 * serves the address — belongs to the server and is made there
 * (docs/adr/0004).
 *
 * It used to hold its own Trip Planner client and its own `TFNSW_API_KEY`. That
 * client and the server's were written six minutes apart on 2026-08-27, each
 * because the other did not exist yet, and the server's has answered everything
 * this one asked since. What is left here is the part that is genuinely this
 * project's: **which moment to measure against**, and where to put the answer.
 *
 * ## Why the arrive-by is resolved here
 *
 * A transit time is a timetable lookup, so it is only comparable with another
 * transit time measured against the same moment. `resolveTransitDeparture` fixes
 * a synthetic one from `site.commute_assumption` — the next matching weekday at
 * least two days out — so a re-measure a week later is still comparable with
 * what is already committed. A real "next Tuesday" would drift, and the server
 * has no business choosing it: it is a property of how this project compares its
 * own runs, not of how far apart two points are.
 *
 * ## Why it writes the ledger
 *
 * Same reason walkability and `enrich:travel` do: what a journey is made of is a
 * fact about a place rather than about a run, so it belongs in the cache a
 * replay reads. `npm run replay:run` then puts it on both committed runs with no
 * re-searching.
 *
 * **It deliberately does not populate `enrichment.commute.transit.interchanges`.**
 * `commuteMinutes` reads that field and adds five minutes per change, which
 * reaches the `max_commute_minutes` dealbreaker — at two changes it removes 130
 * of 265 listings from the shortlist. The count is stored on the composition
 * where nothing scores it. See ITEM-6, *The interchange landmine*.
 */

export async function main(argv: string[]): Promise<void> {
  const DRY_RUN = argv.includes('--dry-run')
  const FORCE = argv.includes('--force')
  const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? '') || Infinity

  /**
   * Listings per `route_places` call.
   *
   * The Trip Planner answers one trip per request, so the server works through a
   * batch serially at ~250ms apiece and a whole ledger in one call would sit well
   * past `McpClient`'s three-minute timeout. Forty keeps a call around half a
   * minute and gives the progress below something to report.
   */
  const BATCH = 40

  const site = await readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema)
  if (!site) fail('data/config/site.json is missing or invalid')

  const ledger = await readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema)
  if (!ledger) fail('data/knowledge/listings.json is missing or invalid')

  const arriveBy = resolveTransitDeparture(
    site.commute_assumption.transit.day_of_week,
    site.commute_assumption.transit.arrive_by,
  )
  const cacheKey = travelKey(OFFICE_ORIGIN_ID, 'transit')

  const entries = Object.entries(ledger.listings)
  const located = entries.filter(([, entry]) => entry.lat !== null && entry.lon !== null)
  const skippedNoCoords = entries.length - located.length

  const todo = located
    .filter(([, entry]) => FORCE || entry.travel[cacheKey]?.composition === undefined)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT)

  console.log(`\nMeasured commutes → ledger  (arrive by ${arriveBy})`)
  console.log(
    `  ${entries.length} ledger entries · ${located.length} located · ` +
      `${todo.length} to measure${FORCE ? ' (--force)' : ''}${DRY_RUN ? ' · DRY RUN' : ''}`,
  )
  if (skippedNoCoords > 0) {
    console.log(`  ${skippedNoCoords} have no coordinates and cannot be measured — left untouched.`)
  }
  if (todo.length === 0) {
    console.log('\nNothing to do.\n')
    return
  }
  if (DRY_RUN) {
    const calls = Math.ceil(todo.length / BATCH)
    console.log(`\nWould send ${todo.length} coordinate(s) in ${calls} route_places call(s).\n`)
    return
  }

  const tally = {
    measured: 0,
    walkOnly: 0,
    ferry: 0,
    withInterchange: 0,
    staleCache: [] as string[],
    noJourney: [] as string[],
    unroutable: [] as string[],
  }
  const routers = new Set<string>()

  console.log()
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH)
    let report: RoutePlacesReport
    try {
      report = RoutePlacesReportSchema.parse(
        await callRoutePlaces({
          places: batch.map(([id, entry]) => ({ id, lat: entry.lat!, lng: entry.lon! })),
          destination: site.office.address,
          travelMode: 'transit',
          travelArriveBy: arriveBy,
        }),
      )
    } catch (error) {
      fail(
        `route_places failed on listings ${start + 1}–${start + batch.length}: ` +
          `${(error as Error).message}\n  Nothing was written; re-run to resume from the same place.`,
      )
    }

    routers.add(report.router)
    tally.unroutable.push(...report.unroutable)

    for (const leg of report.legs) {
      const entry = ledger.listings[leg.id]
      if (!entry) continue

      if (!leg.journey) {
        // A duration with no legs — the server answered from Google, which does
        // not report them. Recorded as a gap rather than written as a journey.
        tally.noJourney.push(entry.address)
        continue
      }
      const composition = toComposition(leg.journey)
      if (!composition) {
        tally.staleCache.push(entry.address)
        continue
      }

      const previous = entry.travel[cacheKey]
      entry.travel[cacheKey] = {
        minutes: Math.round(leg.minutes * 10) / 10,
        km: Math.round(leg.km * 100) / 100,
        mode: 'transit',
        // The coordinates are unchanged, so how well the address resolved is too.
        precision: previous?.precision ?? 'building',
        composition,
        computed_at: isoNow(),
        address: entry.address,
      }

      tally.measured += 1
      if (composition.is_walk) tally.walkOnly += 1
      if (composition.has_ferry) tally.ferry += 1
      if (composition.interchanges > 0) tally.withInterchange += 1

      const minutes = Math.round(leg.minutes * 10) / 10
      const was = previous ? `${previous.minutes.toFixed(1)} →` : '   —  '
      const moved = previous ? minutes - previous.minutes : null
      console.log(
        `  ${String(tally.measured).padStart(3)}. ${was}${minutes.toFixed(1).padStart(6)} min` +
          `${moved === null ? '      ' : (moved > 0 ? ' +' : ' ') + moved.toFixed(1).padStart(5)}` +
          `  ${describeComposition(composition).slice(0, 34).padEnd(34)} ${entry.address.slice(0, 40)}`,
      )
    }
  }

  console.log(`\n  router   ${[...routers].join(', ') || 'none'}`)
  console.log(`  measured ${tally.measured}`)
  console.log(`    a walk, not public transport : ${tally.walkOnly}`)
  console.log(`    uses a ferry                 : ${tally.ferry}`)
  console.log(`    has at least one change      : ${tally.withInterchange}`)
  if (tally.unroutable.length) {
    console.log(`    no route offered             : ${tally.unroutable.length}`)
  }
  if (tally.noJourney.length) {
    console.log(`    answered without legs        : ${tally.noJourney.length}`)
  }
  if (tally.staleCache.length) {
    console.log(`    server cache predates ferry availability : ${tally.staleCache.length}`)
  }

  if (routers.size > 0 && !routers.has('tfnsw')) {
    // The measurements are real; they simply cannot say what they are made of.
    fail(
      `the server answered transit with "${[...routers].join(', ')}", not tfnsw, so no journey has ` +
        `legs and nothing was written.\n  Set TFNSW_API_KEY in the MCP server's own .env ` +
        `(copy its .env.example) and restart it — this repo does not hold that key.`,
    )
  }
  if (tally.staleCache.length > 0) {
    console.log(
      `\n  ${tally.staleCache.length} answer(s) came from the server's route cache, written before it ` +
        `recorded\n  ferry availability. They have legs but no composition can be built from them —\n` +
        `  delete its distance-cache.json entries, or accept that those stay unmeasured.`,
    )
  }

  ledger.updated_at = isoNow()
  await writeJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema.parse(ledger))
  console.log('\nWrote data/knowledge/listings.json.')
  console.log('Replay the runs to put it on them:  npm run replay:run -- <capture.json> --run-id=<id>\n')
}

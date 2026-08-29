import { writeFile } from 'node:fs/promises'
import process from 'node:process'

import {
  CriteriaSchema,
  PlacesSchema,
  SearchesSchema,
  placesByCanonical,
} from '../../SydneyRealEstateFindings/src/lib/schema'
import { dataPath, readJsonFile } from './lib/json-io'
import { McpClient } from './lib/mcp-client'
import { planSearchQueries, type SearchQueryGroup } from './lib/searches'

/**
 * Run the planned query passes against the realestate MCP server and write a
 * capture (AGENT.md §4).
 *
 *   npm run capture:run -- --out=<path> [--core=<loc>,<loc>] [--probe-pages=1]
 *
 * Why this exists rather than the agent calling `search_listings` by hand: a
 * full pass is dozens of calls whose results come back **inline** and are
 * persisted nowhere, which is exactly the silent-loss failure AGENT.md warns
 * about ("Reconcile page count on disk against `totalPages` … or listings
 * disappear silently"). A script keeps every page, writes the capture
 * incrementally so a bot-block mid-run costs one location rather than all of
 * them, and reconciles the count itself.
 *
 * It speaks MCP over stdio directly — the server exposes no batch CLI, and the
 * protocol is a few lines of JSON-RPC. It spawns its **own** server instance, so
 * do not run it while another one holds the Chrome profile; the profile lock is
 * exclusive. Chrome closes after ~30s idle, so in practice waiting a moment
 * after the last tool call is enough.
 *
 * `--core` names the locations to page to exhaustion. Everything else in the
 * envelope gets `--probe-pages` pages (default 1) — enough to record that it was
 * queried and returned nothing inside the travel budget, without paging through
 * hundreds of results that the budget will discard anyway. Both sets land in
 * `locations_searched`, because both were genuinely asked.
 */

/** REA pages are 25 results; nothing sane needs more than this many. */
const PAGE_CAP = 50
/** Politeness gap between page fetches, and the backoff after a bot block. */
const PAGE_DELAY_MS = 400
const BLOCK_BACKOFF_MS = 20_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

// ── the travel report ────────────────────────────────────────────────────────

interface ServerTravelReport {
  origin?: { query?: string }
  mode?: string
  router?: string | null
  geocoder?: string | null
  listings?: number
  routed?: number
  precision?: { building?: number; street?: number; area?: number }
  unresolved?: number
  geocodeCalls?: number
  matrixCalls?: number
  uniqueBuildings?: number
  cachedBuildings?: number
}

/**
 * Fold every page's report into one per group, in the *repo's* shape.
 *
 * AGENT.md says to copy the server's `travelReport` verbatim, but it cannot be:
 * `TravelReportSchema.origin` is a string while the server returns an object,
 * and a group makes many calls where the schema holds one report. So the counts
 * are summed and `origin` is flattened to the query string. `router` and
 * `geocoder` are carried through unchanged — they are the record of which
 * provider actually answered, which is the whole point of keeping this.
 */
class ReportAccumulator {
  private origin: string | null = null
  private mode: string | null = null
  private router: string | null = null
  private geocoder: string | null = null
  private listings = 0
  private routed = 0
  private building = 0
  private street = 0
  private area = 0
  private unresolved = 0
  private geocodeCalls = 0
  private matrixCalls = 0
  private uniqueBuildings = 0
  private cachedBuildings = 0
  private seen = false

  add(report: ServerTravelReport | undefined) {
    if (!report) return
    this.seen = true
    this.origin ??= report.origin?.query ?? null
    this.mode ??= report.mode ?? null
    this.router ??= report.router ?? null
    this.geocoder ??= report.geocoder ?? null
    this.listings += report.listings ?? 0
    this.routed += report.routed ?? 0
    this.building += report.precision?.building ?? 0
    this.street += report.precision?.street ?? 0
    this.area += report.precision?.area ?? 0
    this.unresolved += report.unresolved ?? 0
    // Calls are per request and genuinely additive across pages. Building
    // counts are per call, so summing them double-counts a building that
    // appears on two pages — they bound the distinct total, not state it.
    this.geocodeCalls += report.geocodeCalls ?? 0
    this.matrixCalls += report.matrixCalls ?? 0
    this.uniqueBuildings += report.uniqueBuildings ?? 0
    this.cachedBuildings += report.cachedBuildings ?? 0
  }

  build(fallbackOrigin: string, fallbackMode: string) {
    if (!this.seen) return null
    return {
      origin: this.origin ?? fallbackOrigin,
      mode: (this.mode ?? fallbackMode) as 'walk' | 'drive' | 'transit',
      router: this.router,
      geocoder: this.geocoder,
      listings: this.listings,
      routed: this.routed,
      precision: { building: this.building, street: this.street, area: this.area },
      unresolved: this.unresolved,
      geocode_calls: this.geocodeCalls,
      matrix_calls: this.matrixCalls,
      unique_buildings: this.uniqueBuildings,
      cached_buildings: this.cachedBuildings,
    }
  }
}

// ── one location ─────────────────────────────────────────────────────────────

interface PageOutcome {
  listings: Array<Record<string, unknown>>
  /** What the server rejected on travel time — kept so the ledger can remember it. */
  filtered: Array<Record<string, unknown>>
  totalResults: number
  totalPages: number
  pagesFetched: number
  kept: number
}

const isBlocked = (error: unknown) =>
  /bot protection|kasada|blocked by realestate/i.test(String((error as Error)?.message ?? ''))

async function fetchLocation(
  client: McpClient,
  group: SearchQueryGroup,
  location: string,
  maxPages: number,
  criteriaSearch: { max_price_pw: number; min_beds: number; min_baths: number },
  accumulator: ReportAccumulator,
): Promise<PageOutcome> {
  const listings: Array<Record<string, unknown>> = []
  const filtered: Array<Record<string, unknown>> = []
  let totalResults = 0
  let totalPages = 0
  let pagesFetched = 0

  for (let page = 1; page <= Math.min(maxPages, PAGE_CAP); page += 1) {
    const args: Record<string, unknown> = {
      location,
      channel: 'rent',
      maxPrice: criteriaSearch.max_price_pw,
      minBedrooms: criteriaSearch.min_beds,
      minBathrooms: criteriaSearch.min_baths,
      travelFrom: group.originAddress,
      travelMode: group.mode,
      maxTravelMinutes: group.maxTravelMinutes,
      page,
    }
    // Never send a clock on a road mode: on Google that switches to the
    // traffic-aware SKU at double the price (AGENT.md §4).
    if (group.needsArriveBy) args.travelArriveBy = arriveBy

    let payload: Record<string, unknown>
    try {
      payload = await client.callTool('search_listings', args)
    } catch (error) {
      if (!isBlocked(error)) throw error
      console.log(`      bot block on page ${page}; backing off ${BLOCK_BACKOFF_MS / 1000}s`)
      await sleep(BLOCK_BACKOFF_MS)
      payload = await client.callTool('search_listings', args)
    }

    pagesFetched += 1
    totalResults = Number(payload.totalResults ?? 0)
    totalPages = Number(payload.totalPages ?? 0)
    accumulator.add(payload.travelReport as ServerTravelReport | undefined)

    const page_listings = (payload.listings ?? []) as Array<Record<string, unknown>>
    listings.push(...page_listings)
    // Rejected on travel time, after the server paid to geocode and route them.
    filtered.push(...((payload.filteredByTravel ?? []) as Array<Record<string, unknown>>))

    if (page >= totalPages) break
    await sleep(PAGE_DELAY_MS)
  }

  return { listings, filtered, totalResults, totalPages, pagesFetched, kept: listings.length }
}

// ── main ─────────────────────────────────────────────────────────────────────

const out = arg('out')
if (!out) {
  console.error('usage: npm run capture:run -- --out=<path> [--core=<loc>,<loc>] [--probe-pages=1]')
  process.exit(1)
}
const core = new Set((arg('core') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const probePages = Number(arg('probe-pages') ?? 1)
/** Transit only: the run's `transit_departure_resolved`. Refused rather than invented. */
const arriveBy = arg('arrive-by') ?? null
/** Restrict the pass to these locations — for a smoke test, or to retry a suburb that failed. */
const only = new Set((arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean))

const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)
const searches = await readJsonFile(dataPath('config', 'searches.json'), SearchesSchema)
// A rule-based `locations` resolves against places.json. Passing no places does
// not fall back to the envelope: every rule search is refused, because a missing
// measurement is never guessed at.
const places = placesByCanonical(
  await readJsonFile(dataPath('config', 'places.json'), PlacesSchema),
)

/**
 * Which searches this run covers. Omitted means all of them — a search has no
 * on/off flag, because "am I asking this today" is a property of the run, not of
 * the question. See `planSearchQueries`.
 *
 *   npm run capture:run -- --searches=train-25
 */
const onlySearches = arg('searches')
  ?.split(',')
  .map((id) => id.trim())
  .filter(Boolean)

const plan = planSearchQueries(searches, criteria, places, onlySearches)
if (plan.problems.length > 0) {
  for (const problem of plan.problems) console.error(`refused ${problem.searchId}: ${problem.reason}`)
  process.exit(1)
}
if (plan.groups.length === 0) {
  console.error('no searches to run')
  process.exit(1)
}

// A transit minute means nothing without the moment it was measured at, and the
// server refuses rather than measuring against whatever timetable is running now.
const needsClock = plan.groups.filter((g) => g.needsArriveBy)
if (needsClock.length > 0 && !arriveBy) {
  console.error(
    `--arrive-by is required for ${needsClock.map((g) => g.key).join(', ')} ` +
      `(pass the run's transit_departure_resolved, e.g. 2026-08-25T09:00:00+10:00)`,
  )
  process.exit(1)
}

const unknownCore = [...core].filter((c) => !criteria.search.locations.includes(c))
if (unknownCore.length > 0) {
  console.error(`--core names locations outside the envelope: ${unknownCore.join(', ')}`)
  process.exit(1)
}

console.log(`\ncapture → ${out}`)
console.log(`groups: ${plan.groups.map((g) => `${g.key} ≤${g.maxTravelMinutes}min`).join(', ')}`)
console.log(`core (paged to exhaustion): ${core.size} · probe pages elsewhere: ${probePages}\n`)

const client = new McpClient()
await client.handshake()

const capturedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const groups: unknown[] = []
const searchedLocations = new Set<string>()
let grandTotal = 0

try {
  for (const group of plan.groups) {
    const accumulator = new ReportAccumulator()
    const results: Array<Record<string, unknown>> = []
    const filtered: Array<Record<string, unknown>> = []
    console.log(`── ${group.key} (≤${group.maxTravelMinutes} min) ─────────────────`)

    const locations = only.size > 0 ? group.locations.filter((l) => only.has(l)) : group.locations
    for (const location of locations) {
      const exhaustive = core.has(location)
      const maxPages = exhaustive ? PAGE_CAP : probePages
      let outcome: PageOutcome
      try {
        outcome = await fetchLocation(client, group, location, maxPages, criteria.search, accumulator)
      } catch (error) {
        // One bad location must not cost the whole pass; it is simply not
        // recorded as searched, which is what `partial_coverage` is for.
        console.log(`  ${location.padEnd(26)} FAILED — ${(error as Error).message.slice(0, 120)}`)
        continue
      }

      searchedLocations.add(location)
      results.push(...outcome.listings)
      filtered.push(...outcome.filtered)
      grandTotal += outcome.kept

      const shortfall =
        exhaustive && outcome.totalPages > outcome.pagesFetched
          ? ` !! only ${outcome.pagesFetched}/${outcome.totalPages} pages`
          : ''
      console.log(
        `  ${location.padEnd(26)} ${exhaustive ? 'full' : 'probe'} · ` +
          `${String(outcome.pagesFetched).padStart(2)}p of ${String(outcome.totalPages).padStart(2)} · ` +
          `REA ${String(outcome.totalResults).padStart(4)} → kept ${String(outcome.kept).padStart(3)}${shortfall}`,
      )

      // Write after every location so a crash costs one suburb, not the run.
      const snapshot = {
        source: 'rea-mcp',
        captured_at: capturedAt,
        commentary: '',
        searched_locations: [...searchedLocations],
        gone: {},
        groups: [
          ...groups,
          {
            origin: group.originId,
            mode: group.mode,
            max_travel_minutes: group.maxTravelMinutes,
            arrive_by: group.needsArriveBy ? arriveBy : null,
            locations_searched: [...searchedLocations],
            travel_report: accumulator.build(group.originAddress, group.mode),
            results,
            filtered_by_travel: filtered,
          },
        ],
        results: [],
      }
      await writeFile(out, JSON.stringify(snapshot, null, 2), 'utf8')
    }

    groups.push({
      origin: group.originId,
      mode: group.mode,
      max_travel_minutes: group.maxTravelMinutes,
      arrive_by: group.needsArriveBy ? arriveBy : null,
      locations_searched: [...searchedLocations],
      travel_report: accumulator.build(group.originAddress, group.mode),
      results,
      filtered_by_travel: filtered,
    })
  }
} finally {
  client.close()
}

const capture = {
  source: 'rea-mcp',
  captured_at: capturedAt,
  commentary: '',
  // Every envelope location was queried → [] means "all of them". If any
  // failed, say exactly which were covered so the run cannot claim more.
  searched_locations:
    only.size === 0 && searchedLocations.size === criteria.search.locations.length
      ? []
      : [...searchedLocations],
  gone: {},
  groups,
  results: [],
}

await writeFile(out, JSON.stringify(capture, null, 2), 'utf8')

const missing = criteria.search.locations.filter((l) => !searchedLocations.has(l))
console.log(`\nwrote ${out}`)
console.log(`  ${grandTotal} listing row(s) across ${groups.length} group(s)`)
console.log(`  ${searchedLocations.size}/${criteria.search.locations.length} locations searched`)
if (missing.length > 0) console.log(`  NOT searched: ${missing.join(', ')}`)
console.log(`\nnext: npm run audit:capture -- ${out}\n`)

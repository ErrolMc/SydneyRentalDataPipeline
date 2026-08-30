// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { SearchesSchema, SiteConfigSchema } from 'sydney-rental-schema'
import { geocodeSuburbs } from '../lib/geocode-places.js'
import { dataPath, readJsonFile } from '../lib/json-io.js'
import { failAfterReport } from '../lib/stage-error.js'
import { callResolveLocation, callRoutePlaces } from '../lib/tools.js'
import { resolveTransitDeparture } from '../lib/sydney.js'

/**
 * Derive `criteria.search.locations` from REA's own suburb list instead of
 * curating it by hand (AGENT.md §4, and the gap `audit:postcodes` measures).
 *
 *   npm run build:envelope -- --stage=enumerate --cache=<path> [--from=2000] [--to=2234]
 *   npm run build:envelope -- --stage=place     --cache=<path>
 *   npm run build:envelope -- --stage=emit      --cache=<path> [--km=25]
 *
 * The hand-written list was curated when the suburb list *was* the geographic
 * filter — before `travelFrom`/`maxTravelMinutes` existed. It missed 17 suburbs
 * inside its own postcodes, including four of the seven in postcode 2000, and
 * the miss is **silent**: an unasked suburb is indistinguishable from one with
 * no listings.
 *
 * The envelope only has to be a correct *superset*. Precision comes from the
 * travel budget at query time, so this cuts generously by straight-line distance
 * rather than pretending to model the rail network. A search that wants less
 * says so with its own `locations` subset.
 *
 * Three stages because they fail differently and none should redo the others:
 * `enumerate` is ~235 free MCP calls, `place` is Nominatim at 1 request/second
 * and resumes where it stopped, `emit` is pure and instant to re-run at a
 * different radius.
 */

const OFFICE = { lat: -33.8659215, lon: 151.20406 }

interface CachedSuburb {
  canonical: string
  name: string
  state: string
  postcode: string
  type: string
  lat?: number
  lon?: number
  /** Set when Nominatim could not place it, so `place` does not retry forever. */
  unplaced?: boolean
  /**
   * Routed minutes from this place's CENTROID to an origin, by `origin:mode`.
   *
   * Indicative by construction — a centroid is `precision: "area"`, and a big
   * suburb spans several stations. Good enough to decide which suburbs are worth
   * querying; never good enough to show as a listing's commute, which is why
   * this lives here and never in `run.json`.
   */
  indicative_minutes?: Record<string, number>
}

interface Cache {
  enumerated_at?: string
  placed_at?: string
  measured_at?: string
  truncated_postcodes: string[]
  suburbs: CachedSuburb[]
}

/** This stage's own argv, set by `main`. `arg` is used from every stage branch. */
let ARGV: string[] = []

function arg(name: string): string | undefined {
  return ARGV.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

async function readCache(path: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Cache
  } catch {
    return { truncated_postcodes: [], suburbs: [] }
  }
}

const writeCache = (path: string, cache: Cache) =>
  writeFile(path, JSON.stringify(cache, null, 2), 'utf8')

/** Great-circle distance in km. Straight line, deliberately — see the header. */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export async function main(argv: string[]): Promise<void> {
  ARGV = argv

  const cachePath = arg('cache')
  const stage = arg('stage')
  if (!cachePath || !stage) {
    console.error(
      'usage: --stage=enumerate|place|measure|emit --cache=<path> [--from] [--to] [--km] [--minutes] [--mode]',
    )
    failAfterReport()
  }

  const cache = await readCache(cachePath)

  // ── stage 1: what suburbs does REA have? ─────────────────────────────────────

  if (stage === 'enumerate') {
    const from = Number(arg('from') ?? 2000)
    const to = Number(arg('to') ?? 2234)
    // resolve_location caps at 20; a postcode returning exactly 20 may be cut off.
    const MAX = 20

    const bySuburb = new Map<string, CachedSuburb>()
    for (const existing of cache.suburbs) bySuburb.set(existing.canonical, existing)
    const truncated: string[] = []

    for (let code = from; code <= to; code += 1) {
      const postcode = String(code)
      let found: Array<{ type: string; name?: string; state?: string; postcode?: string }>
      try {
        found = (await callResolveLocation({
          query: postcode,
          max: MAX,
        })) as typeof found
      } catch (error) {
        console.log(`${postcode}  FAILED — ${(error as Error).message.slice(0, 90)}`)
        continue
      }

      // Keep only real places in the postcode asked for: a bare numeric query
      // also matches suburbs whose *name* contains the digits.
      const places = found.filter(
        (f) => (f.type === 'suburb' || f.type === 'precinct') && f.postcode === postcode && f.name,
      )
      if (places.length >= MAX) truncated.push(postcode)

      for (const place of places) {
        const canonical = `${place.name} ${place.state} ${place.postcode}`
        if (bySuburb.has(canonical)) continue
        bySuburb.set(canonical, {
          canonical,
          name: place.name as string,
          state: place.state as string,
          postcode: place.postcode as string,
          type: place.type,
        })
      }
      if (places.length > 0) console.log(`${postcode}  ${places.length} place(s)`)
    }

    cache.suburbs = [...bySuburb.values()].sort((a, b) => a.canonical.localeCompare(b.canonical))
    cache.enumerated_at = new Date().toISOString()
    cache.truncated_postcodes = truncated
    await writeCache(cachePath, cache)

    console.log(`\n${cache.suburbs.length} distinct place(s) across ${to - from + 1} postcode(s)`)
    if (truncated.length) console.log(`  possibly truncated at ${MAX}: ${truncated.join(', ')}`)
    console.log(`\nnext: --stage=place --cache=${cachePath}`)
  }

  // ── stage 2: where are they? ─────────────────────────────────────────────────

  if (stage === 'place') {
    const todo = cache.suburbs.filter((s) => s.lat === undefined && !s.unplaced)
    console.log(`placing ${todo.length} suburb(s) via the MCP server at ~1/second…\n`)

    // One call per checkpoint, rather than one call per suburb or one for all of
    // them. This stage is long and must resume rather than restart, and a single
    // call covering everything would sit well past McpClient's three-minute
    // timeout — the server asks the gazetteer serially at Nominatim's 1/second.
    const CHUNK = 25
    let done = 0
    for (let start = 0; start < todo.length; start += CHUNK) {
      const batch = todo.slice(start, start + CHUNK)
      const placedBatch = await geocodeSuburbs(
        batch.map((s, i) => ({ id: String(start + i), suburb: s.name, postcode: s.postcode, state: s.state })),
      )
      batch.forEach((suburb, i) => {
        const centroid = placedBatch.get(String(start + i))
        if (centroid) {
          suburb.lat = centroid.lat
          suburb.lon = centroid.lon
        } else {
          suburb.unplaced = true
          console.log(`  could not place ${suburb.canonical}`)
        }
      })
      done += batch.length
      await writeCache(cachePath, cache)
      console.log(`  ${done}/${todo.length}`)
    }

    cache.placed_at = new Date().toISOString()
    await writeCache(cachePath, cache)

    const placed = cache.suburbs.filter((s) => s.lat !== undefined).length
    console.log(`\nplaced ${placed}/${cache.suburbs.length}`)
    console.log(`\nnext: --stage=emit --cache=${cachePath}`)
  }


  // ── stage 3: how far are they, really? ───────────────────────────────────────

  if (stage === 'measure') {
    const site = await readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema)
    const searches = await readJsonFile(dataPath('config', 'searches.json'), SearchesSchema)
    const modes = (arg('modes') ?? 'walk,drive,transit').split(',').map((m) => m.trim())

    // The same synthetic arrive-by a run uses, so these numbers sit on the same
    // timetable the real transit measurements will.
    const arriveBy = resolveTransitDeparture(
      site.commute_assumption.transit.day_of_week,
      site.commute_assumption.transit.arrive_by,
    )
    console.log(`transit arrive-by: ${arriveBy}
`)

    const limit = arg('limit') ? Number(arg('limit')) : null
    const placed = cache.suburbs
      .filter(
        (s): s is CachedSuburb & { lat: number; lon: number } =>
          s.lat !== undefined && s.lon !== undefined,
      )
      .slice(0, limit ?? undefined)
    const byCanonical = new Map(cache.suburbs.map((s) => [s.canonical, s]))

    for (const [originId, origin] of Object.entries(searches.origins)) {
      for (const mode of modes) {
        const key = `${originId}:${mode}`
        const todo = placed.filter((s) => s.indicative_minutes?.[key] === undefined)
        if (todo.length === 0) {
          console.log(`${key.padEnd(16)} already measured`)
          continue
        }

        const report = (await callRoutePlaces({
          places: todo.map((s) => ({ id: s.canonical, lat: s.lat, lng: s.lon })),
          destination: origin.address,
          travelMode: mode,
          ...(mode === 'transit' ? { travelArriveBy: arriveBy } : {}),
        })) as {
          legs: Array<{ id: string; minutes: number }>
          unroutable: string[]
          matrixCalls: number
          cachedLegs: number
          router: string
        }

        for (const leg of report.legs) {
          const suburb = byCanonical.get(leg.id)
          if (!suburb) continue
          suburb.indicative_minutes = { ...suburb.indicative_minutes, [key]: leg.minutes }
        }
        await writeCache(cachePath, cache)

        console.log(
          `${key.padEnd(16)} ${String(report.legs.length).padStart(3)} routed · ` +
            `${report.unroutable.length} unroutable · ${report.matrixCalls} call(s) · ` +
            `${report.cachedLegs} cached · router=${report.router}`,
        )
      }
    }

    cache.measured_at = new Date().toISOString()
    await writeCache(cachePath, cache)
    console.log(`
next: --stage=emit --cache=${cachePath} --minutes=45 --mode=office:transit`)
  }

  // ── stage 4: the list ────────────────────────────────────────────────────────

  if (stage === 'emit') {
    // Either cut: `--minutes` + `--mode` uses the measured indicative time and is
    // what you want for a commute question; `--km` is the crude fallback for
    // before `measure` has run.
    const minutes = arg('minutes') ? Number(arg('minutes')) : null
    const mode = arg('mode') ?? 'office:transit'
    const km = Number(arg('km') ?? 25)

    const placed = cache.suburbs.filter(
      (s): s is CachedSuburb & { lat: number; lon: number } => s.lat !== undefined && s.lon !== undefined,
    )

    const scored = placed.map((s) => ({
      ...s,
      km: haversineKm(OFFICE, { lat: s.lat, lon: s.lon }),
      mins: s.indicative_minutes?.[mode],
    }))

    // An unmeasured place is kept rather than dropped — a missing number is not
    // evidence of being far, and dropping it silently is the exact failure this
    // exercise exists to remove. But "kept" needs a bound, or widening the
    // enumeration sweeps in every national park and boat-access inlet in the
    // state: 235 places came back unroutable, and the nearest was 27 km out while
    // the 45-minute boundary reaches 23.5 km. So keep the unmeasured only where
    // being unmeasured is genuinely surprising.
    const keepUnmeasuredKm = Number(arg('keep-unmeasured-km') ?? 30)

    const within = (
      minutes === null
        ? scored.filter((s) => s.km <= km)
        : scored.filter((s) => (s.mins === undefined ? s.km <= keepUnmeasuredKm : s.mins <= minutes))
    ).sort((a, b) => (a.mins ?? Infinity) - (b.mins ?? Infinity) || a.km - b.km)

    const unmeasured = within.filter((s) => s.mins === undefined).length
    console.log(
      minutes === null
        ? `cut: straight-line ≤ ${km} km`
        : `cut: ${mode} ≤ ${minutes} min (${unmeasured} unmeasured kept)`,
    )

    const unplaced = cache.suburbs.filter((s) => s.unplaced)
    console.log(`${within.length} place(s) selected of ${cache.suburbs.length} enumerated`)
    console.log(`  ${unplaced.length} could not be placed`)
    if (unplaced.length) console.log(`  unplaced: ${unplaced.map((s) => s.canonical).join(', ')}`)

    const out = arg('out')
    if (out) {
      await writeFile(out, JSON.stringify(within.map((s) => s.canonical), null, 2), 'utf8')
      console.log(`\nwrote ${within.length} location(s) to ${out}`)
    }

    // The tagged form. Written for the *selected* places only: a rule resolves
    // inside the envelope, so tagging places the envelope excludes would be dead
    // weight in a committed file.
    const placesOut = arg('places-out')
    if (placesOut) {
      const payload = {
        schema_version: 1,
        version: Number(arg('places-version') ?? 1),
        updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        transit_arrive_by: arg('arrive-by') ?? null,
        postcode_range: { from: arg('from') ?? '2000', to: arg('to') ?? '2234' },
        places: within.map((s) => ({
          canonical: s.canonical,
          name: s.name,
          state: s.state,
          postcode: s.postcode,
          kind: s.type === 'precinct' ? 'precinct' : 'suburb',
          centroid: { lat: s.lat, lon: s.lon },
          km_from: { office: Math.round(s.km * 100) / 100 },
          indicative_minutes: s.indicative_minutes ?? {},
        })),
      }
      await writeFile(placesOut, JSON.stringify(payload, null, 2), 'utf8')
      console.log(`wrote ${payload.places.length} tagged place(s) to ${placesOut}`)
    }

    if (!out && !placesOut) {
      console.log('\nnearest 15:')
      for (const s of within.slice(0, 15)) {
        const mins = s.mins === undefined ? '   ?' : s.mins.toFixed(0).padStart(4)
        console.log(`  ${mins} min  ${s.km.toFixed(1).padStart(5)} km  ${s.canonical}`)
      }
      console.log('\npass --out=<path> or --places-out=<path> to write the list')
    }
  }
}

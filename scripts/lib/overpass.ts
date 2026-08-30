import type { SiteConfig } from 'sydney-rental-schema'

/**
 * Walkability from OpenStreetMap, via Overpass (PLAN.md §8.1).
 *
 * The only enrichment that needs no key and costs nothing, and the only one
 * whose provider is run by volunteers — which shapes the whole design here.
 *
 * **One query per grid cell, not one per listing.** 265 listings would be 265
 * requests to a service that rate-limits hard and asks callers to be
 * considerate. But they sit inside about twelve kilometres of inner Sydney, so
 * bucketing them into ~3 km cells and asking each cell once brings it down to
 * roughly fifteen requests, and every listing is then matched against the
 * answers in memory. Cells are expanded by the search radius so a listing at a
 * cell's edge still sees the POIs just outside it.
 *
 * Distances are straight-line. `site.json.walk.detour_factor` turns them into
 * walking distance and `speed_m_per_min` into minutes — a deliberate estimate,
 * not a routed time, which is why nothing here calls a router.
 */

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'

/**
 * Cell size in degrees. 0.05° is roughly 5.5 km, which with the radius margin
 * asks for about a 8 km square.
 *
 * Bigger than it needs to be for the payload's sake, and deliberately so: the
 * binding constraint is not how much a query returns but how many queries the
 * public instance will accept. It allows two concurrent slots per IP and
 * answers 429 or 504 to everything else, so *fewer, heavier* requests get
 * through where more, lighter ones do not. This turns 285 listings into eight
 * questions.
 */
const CELL_DEGREES = 0.05

/**
 * A floor under the request rate, on top of waiting for a slot. Overpass's own
 * guidance is to be considerate rather than to hit a documented ceiling.
 */
const MIN_REQUEST_GAP_MS = 3_000

/** Still transient failures after all that, so still worth a few retries. */
const MAX_ATTEMPTS = 5
const BACKOFF_MS = [10_000, 30_000, 60_000, 60_000]

/** How long to keep waiting for a free slot before giving up on a cell. */
const SLOT_WAIT_LIMIT_MS = 5 * 60_000

/** Overpass asks callers to identify themselves, so it can tell a considerate script from a runaway one. */
const USER_AGENT = 'SydneyRentalFindings/1.0 (personal rental research; one-off enrichment)'

export const POI_KINDS = ['cafe', 'supermarket', 'gym'] as const
export type PoiKind = (typeof POI_KINDS)[number]

export interface Poi {
  kind: PoiKind
  /** `node/1234` — the dedupe key across overlapping cells. */
  osmId: string
  name: string | null
  lat: number
  lon: number
  isMajorChain: boolean
}

export interface Point {
  lat: number
  lon: number
}

/** The chains worth walking to for a full shop, rather than a corner store tagged `supermarket`. */
const MAJOR_CHAIN = /Woolworths|Coles|ALDI|IGA|Harris Farm|FoodWorks/i

/**
 * Gyms are the worst-tagged of the three. `leisure=fitness_centre` is the
 * documented tag and `amenity=gym` is the one people actually use, so both are
 * asked for; the name regex catches franchises mapped as neither.
 */
const GYM_CHAINS = 'Anytime Fitness|F45|Fitness First|Plus Fitness|Snap Fitness|BFT|Jetts'

export function haversineMetres(a: Point, b: Point): number {
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Straight line → walking minutes, per `site.json.walk`. Never a routed time. */
export function walkMinutes(distanceM: number, walk: SiteConfig['walk']): number {
  return Math.round(((distanceM * walk.detour_factor) / walk.speed_m_per_min) * 10) / 10
}

export interface Cell {
  south: number
  west: number
  north: number
  east: number
  /** How many listings fall in this cell — logged so a run says what it asked for. */
  listings: number
}

/**
 * The cells covering these points, each already expanded by `radiusM` so a
 * listing on a boundary still sees everything within its radius. Only cells
 * containing a listing are returned: the points cluster, and asking about empty
 * water is both slower and ruder.
 */
export function cellsFor(points: readonly Point[], radiusM: number): Cell[] {
  const marginLat = radiusM / 111_000
  const buckets = new Map<string, number>()

  for (const point of points) {
    const key = `${Math.floor(point.lat / CELL_DEGREES)},${Math.floor(point.lon / CELL_DEGREES)}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }

  return [...buckets]
    .map(([key, listings]) => {
      const [latIndex, lonIndex] = key.split(',').map(Number)
      const south = latIndex * CELL_DEGREES
      const west = lonIndex * CELL_DEGREES
      // Longitude degrees shrink with latitude, so the east-west margin has to
      // grow to cover the same metres. Sydney is at ~34°S, where a degree of
      // longitude is about 92 km.
      const marginLon = marginLat / Math.cos((south * Math.PI) / 180)
      return {
        south: south - marginLat,
        west: west - marginLon,
        north: south + CELL_DEGREES + marginLat,
        east: west + CELL_DEGREES + marginLon,
        listings,
      }
    })
    .sort((a, b) => b.listings - a.listings)
}

function queryFor(cell: Cell): string {
  const bbox = [cell.south, cell.west, cell.north, cell.east].map((n) => n.toFixed(5)).join(',')
  return [
    '[out:json][timeout:180];',
    '(',
    `nwr["amenity"="cafe"](${bbox});`,
    `nwr["shop"="supermarket"](${bbox});`,
    `nwr["leisure"="fitness_centre"](${bbox});`,
    `nwr["amenity"="gym"](${bbox});`,
    `nwr["name"~"${GYM_CHAINS}",i](${bbox});`,
    ');',
    'out center tags;',
  ].join('')
}

export interface OverpassElement {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

function classify(tags: Record<string, string>): PoiKind | null {
  if (tags.amenity === 'cafe') return 'cafe'
  if (tags.shop === 'supermarket') return 'supermarket'
  if (tags.leisure === 'fitness_centre' || tags.amenity === 'gym') return 'gym'
  // Swept in by the franchise-name regex without a usable tag on it.
  if (tags.name && new RegExp(GYM_CHAINS, 'i').test(tags.name)) return 'gym'
  return null
}

export function poiFromElement(element: OverpassElement): Poi | null {
  const tags = element.tags ?? {}
  const kind = classify(tags)
  if (!kind) return null

  const lat = element.lat ?? element.center?.lat
  const lon = element.lon ?? element.center?.lon
  // A way or relation without `out center` geometry cannot be measured to.
  if (lat === undefined || lon === undefined) return null

  const name = tags.name?.trim() || null
  // An unnamed cafe is usually a mapping stub — a bench outside a bakery, a
  // seating area. PLAN.md §8.1 keeps named cafes only, and the same reasoning
  // applies to a supermarket nobody could name.
  if (!name && kind !== 'gym') return null

  return {
    kind,
    osmId: `${element.type}/${element.id}`,
    name,
    lat,
    lon,
    isMajorChain: kind === 'supermarket' && name !== null && MAJOR_CHAIN.test(name),
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until the instance says it has a slot for us.
 *
 * `/api/status` reports how many of this IP's slots are free and, when none
 * are, exactly when the next one frees up. Asking it first is the difference
 * between queueing politely and being told 429 four times in a row — which is
 * what a fixed delay produced. Failure to read the status is not fatal: fall
 * through and let the query itself find out.
 */
async function waitForSlot(endpoint: string, onProgress: (message: string) => void): Promise<void> {
  const statusUrl = endpoint.replace(/\/interpreter$/, '/status')
  const deadline = Date.now() + SLOT_WAIT_LIMIT_MS

  while (Date.now() < deadline) {
    let text: string
    try {
      const response = await fetch(statusUrl, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) return
      text = await response.text()
    } catch {
      return
    }

    const free = text.match(/(\d+) slots? available now/)
    if (free && Number(free[1]) > 0) return

    // "Slot available after: 2026-08-24T15:31:02Z, in 33 seconds." — possibly
    // several, one per slot. The soonest is the one we are waiting for, and a
    // past deadline reports as a negative number.
    const waits = [...text.matchAll(/in (-?\d+) seconds/g)].map((match) => Number(match[1]))
    const seconds = waits.length > 0 ? Math.max(1, Math.min(...waits)) : 15
    onProgress(`      no slot free — waiting ${seconds}s`)
    await sleep((seconds + 1) * 1_000)
  }

  onProgress('      still no slot after 5 minutes — asking anyway')
}

/**
 * One cell's POIs. Retries a 429 or 504 — the public instance answers both when
 * its slots are busy, and both clear on their own — and gives up rather than
 * hammering.
 */
async function fetchCell(
  cell: Cell,
  endpoint: string,
  onProgress: (message: string) => void,
): Promise<Poi[]> {
  const body = queryFor(cell)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await waitForSlot(endpoint, onProgress)
    const started = Date.now()
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body,
      })

      if (response.status === 429 || response.status === 504) {
        const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
        onProgress(`      ${response.status} (busy) — waiting ${wait / 1000}s`)
        await sleep(wait)
        continue
      }

      if (!response.ok) {
        throw new Error(`Overpass returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }

      const payload = (await response.json()) as { elements?: OverpassElement[] }
      const pois = (payload.elements ?? [])
        .map(poiFromElement)
        .filter((poi): poi is Poi => poi !== null)
      onProgress(`      ${pois.length} POI(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return pois
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error
      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
      onProgress(`      ${(error as Error).message.slice(0, 80)} — retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }

  throw new Error(`Overpass did not answer for cell ${cell.south.toFixed(3)},${cell.west.toFixed(3)} after ${MAX_ATTEMPTS} attempts`)
}

/**
 * Every POI around these points, deduped by OSM id across overlapping cells.
 *
 * Throws if any cell fails. A partial answer is worse than none here: a listing
 * whose cell went missing would come back `none_found` — "no cafe within
 * 1200 m", a real signal — when the truth is that nobody asked.
 */
export async function fetchWalkabilityPois(
  points: readonly Point[],
  radiusM: number,
  onProgress: (message: string) => void,
  endpoint = DEFAULT_ENDPOINT,
): Promise<Poi[]> {
  const cells = cellsFor(points, radiusM)
  const byOsmId = new Map<string, Poi>()

  onProgress(`  ${points.length} location(s) → ${cells.length} cell(s) to ask about`)

  for (const [index, cell] of cells.entries()) {
    if (index > 0) await sleep(MIN_REQUEST_GAP_MS)
    onProgress(
      `    cell ${index + 1}/${cells.length}  ${cell.south.toFixed(3)},${cell.west.toFixed(3)}  (${cell.listings} listing(s))`,
    )
    for (const poi of await fetchCell(cell, endpoint, onProgress)) {
      byOsmId.set(poi.osmId, poi)
    }
  }

  return [...byOsmId.values()]
}

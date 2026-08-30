import type { LedgerEntry, SiteConfig } from 'sydney-rental-schema'
import { haversineMetres, walkMinutes, type Poi, type Point } from './overpass'

/**
 * Turning a pile of POIs into one listing's walkability block (PLAN.md §8.1).
 *
 * Pure, and separate from `overpass.ts`, so the matching can be checked without
 * a network call — which is the half that is easy to get quietly wrong.
 *
 * Status semantics matter more here than anywhere else in scoring:
 *
 *   ok          Overpass answered and something is within the radius
 *   none_found  Overpass answered and nothing is — a real signal, scores 0
 *               (30 for a gym, which OSM tags too patchily to trust an absence)
 *   unavailable nobody asked, or the listing has no coordinates — the factor
 *               sits out and its weight redistributes
 *
 * The difference between the last two is the whole reason `fetchWalkabilityPois`
 * refuses to return a partial answer.
 */

/**
 * `ok` rather than `fallback`, though the minutes are a straight-line estimate.
 *
 * PLAN.md §8.1 reserved `fallback` for a haversine standing in after OSRM had
 * been tried and failed. No router is called at all now — `site.json.walk`'s
 * detour factor *is* the method, deliberately, the same way transit left TfNSW
 * — so there is nothing degraded to flag. Overpass is the provider and it
 * answered. The estimate is named in `source` instead, so nobody reads these
 * minutes as routed.
 */
const SOURCE = 'overpass+detour'

type Poi3 = NonNullable<LedgerEntry['walkability']>

const UNAVAILABLE = {
  status: 'unavailable' as const,
  source: null,
  name: null,
  walk_minutes: null,
  distance_m: null,
}

const NONE_FOUND = {
  status: 'none_found' as const,
  source: SOURCE,
  name: null,
  walk_minutes: null,
  distance_m: null,
}

interface Nearest {
  poi: Poi
  distanceM: number
}

function nearest(from: Point, pois: readonly Poi[], radiusM: number): Nearest | null {
  let best: Nearest | null = null
  for (const poi of pois) {
    const distanceM = haversineMetres(from, poi)
    if (distanceM > radiusM) continue
    if (best === null || distanceM < best.distanceM) best = { poi, distanceM }
  }
  return best
}

function block(found: Nearest | null, walk: SiteConfig['walk']) {
  if (!found) return NONE_FOUND
  return {
    status: 'ok' as const,
    source: SOURCE,
    name: found.poi.name,
    walk_minutes: walkMinutes(found.distanceM, walk),
    distance_m: Math.round(found.distanceM),
  }
}

/**
 * The nearest of each kind to one listing.
 *
 * Supermarkets prefer the nearest major chain over a nearer corner store: a
 * weekly shop is the thing the factor is really asking about, and an IGA four
 * hundred metres away beats a convenience store at fifty. If no chain is in
 * range, the nearest supermarket of any kind answers, with `is_major_chain`
 * false saying so.
 */
export function walkabilityFor(
  from: Point,
  pois: readonly Poi[],
  walk: SiteConfig['walk'],
): Pick<Poi3, 'cafe' | 'supermarket' | 'gym'> {
  const radiusM = walk.poi_radius_m
  const of = (kind: Poi['kind']) => pois.filter((poi) => poi.kind === kind)

  const supermarkets = of('supermarket')
  const chain = nearest(from, supermarkets.filter((poi) => poi.isMajorChain), radiusM)
  const anyShop = nearest(from, supermarkets, radiusM)
  const shop = chain ?? anyShop

  return {
    cafe: block(nearest(from, of('cafe'), radiusM), walk),
    supermarket: {
      ...block(shop, walk),
      is_major_chain: shop === null ? null : shop.poi.isMajorChain,
    },
    gym: block(nearest(from, of('gym'), radiusM), walk),
  }
}

/** The all-`unavailable` block, for a listing nobody could ask about. */
export function unavailableWalkability(): Pick<Poi3, 'cafe' | 'supermarket' | 'gym'> {
  return {
    cafe: UNAVAILABLE,
    supermarket: { ...UNAVAILABLE, is_major_chain: null },
    gym: UNAVAILABLE,
  }
}

/**
 * Whether a cached block still answers for this listing. Both keys have to
 * match: `config_hash` covers a change to `site.json.walk` (a wider radius means
 * a different nearest), and the coordinates cover a re-geocode that moved the
 * listing. The tolerance is the same ±0.0005° PLAN.md §4 uses for the commute
 * cache — about 55 metres, below which the nearest cafe does not change.
 */
export function cacheIsFresh(
  cached: LedgerEntry['walkability'],
  configHash: string,
  point: Point,
): boolean {
  if (!cached) return false
  if (cached.config_hash !== configHash) return false
  return Math.abs(cached.lat - point.lat) <= 0.0005 && Math.abs(cached.lon - point.lon) <= 0.0005
}

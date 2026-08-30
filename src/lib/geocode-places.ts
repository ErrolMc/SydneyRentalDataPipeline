import { z } from 'zod'

import { callGeocodePlaces } from './tools.js'

/**
 * The `geocode_places` boundary: asking the MCP server where a suburb is.
 *
 * This repo had its own Nominatim client until ADR 0004 — 76 lines in
 * the site repo's `scripts/lib/geocode.ts`, one request, first result. It has been moved into
 * the server *verbatim* rather than folded into the geocoder already there,
 * which is an address geocoder and answers a different question: pointed at
 * "Westleigh, NSW 2120" it returns a street inside Westleigh, 1.5 km from the
 * centre, and on a 40-suburb sample it placed only 15.
 *
 * Being the same request is the whole point. Measured across 80 of the 398
 * committed envelope places, the server now reproduces every centroid exactly —
 * so this was a refactor. Any other gazetteer moves suburbs by a median of
 * 241 m, which would have been a data change wearing a refactor's clothes.
 */

/** The query the committed envelope was built with. Changing it moves suburbs. */
export const localityQuery = (suburb: string, postcode: string, state = 'NSW'): string =>
  `${suburb}, ${state} ${postcode}, Australia`

export interface Centroid {
  lat: number
  lon: number
}

const GeocodeReportSchema = z.object({
  geocoder: z.string(),
  places: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      query: z.string(),
      lat: z.number(),
      lng: z.number(),
      precision: z.enum(['building', 'street', 'area']),
      source: z.enum(['osm', 'google']),
      cached: z.boolean(),
    }),
  ),
  /** Queries nothing could place. Never a guess standing in for a position. */
  unresolved: z.array(z.string()),
  geocodeCalls: z.number().int().nonnegative(),
})

export interface SuburbQuery {
  /** The caller's own key, so answers match questions without relying on order. */
  id: string
  suburb: string
  postcode: string
  state?: string
}

/**
 * Centroids for many suburbs, by the caller's id. A missing id could not be
 * placed — which the caller must treat as "unknown", never as a position.
 *
 * Callers decide their own batching: `build-envelope` chunks so it can
 * checkpoint and resume.
 */
export async function geocodeSuburbs(places: readonly SuburbQuery[]): Promise<Map<string, Centroid>> {
  const placed = new Map<string, Centroid>()
  if (places.length === 0) return placed

  const report = GeocodeReportSchema.parse(
    await callGeocodePlaces({
      queries: places.map((p) => localityQuery(p.suburb, p.postcode, p.state)),
      prefer: 'locality',
    }),
  )

  const byQuery = new Map(report.results.map((r) => [r.query, r]))
  for (const place of places) {
    const hit = byQuery.get(localityQuery(place.suburb, place.postcode, place.state))
    // 6 dp is what the server rounds to and what the committed data carries.
    if (hit) placed.set(place.id, { lat: hit.lat, lon: hit.lng })
  }
  return placed
}

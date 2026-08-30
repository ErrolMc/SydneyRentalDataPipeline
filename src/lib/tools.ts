// Must stay first: browser.ts and distance.ts read process.env at import time.
import '../env.js'

import { z } from 'zod'

import { closeContext } from '../browser.js'
import { geocodePlaces, routePlaces } from '../distance.js'
import { searchListings } from './search-listings.js'
import { suggestLocations } from '../search.js'

/**
 * The four calls the scripts used to make to the MCP server, in-process.
 *
 * `mcp-client.ts` spawned `dist/index.js` and spoke JSON-RPC to it over stdio —
 * a handshake, a 180 s call timeout, stderr filtering, and "rebuild `dist/` or
 * nothing changes" — to reach functions that now live one import away. Each
 * function here does what the corresponding tool handler did: validate and
 * default the arguments with the same zod schema, translate them into the
 * library's shape, call it, and hand back what the wire would have carried.
 *
 * That last part is the Phase 1 rule. The old answer was `JSON.stringify` on
 * one side and `JSON.parse` on the other, which drops `undefined` keys, turns
 * a `Date` into a string and `NaN` into `null`. `wire` reproduces it, so the
 * scripts see exactly the values they saw before — and the zod parsers in
 * `route-places.ts` / `geocode-places.ts` keep checking them. Phase 2 shares
 * the types and deletes all three (MIGRATION.md).
 */
const wire = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T

const TravelModeInput = z.enum(['walk', 'drive', 'transit'])

const GeocodePlacesInput = z.object({
  queries: z.array(z.string().min(1)).min(1).max(500),
  prefer: z.enum(['precise', 'locality']).default('precise'),
})

const RoutePlacesInput = z.object({
  places: z
    .array(
      z.object({
        id: z.string(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .min(1)
    .max(1000),
  destination: z.string(),
  travelMode: TravelModeInput.default('walk'),
  travelArriveBy: z.string().optional(),
})

const ResolveLocationInput = z.object({
  query: z.string(),
  max: z.number().int().min(1).max(20).default(7),
})

/** `search_listings`. Throws on a failed fetch or a bot block, as the tool call did. */
export async function callSearchListings(args: unknown): Promise<Record<string, unknown>> {
  // The input schema lives with the function; it parses for itself.
  return wire(await searchListings(args as Parameters<typeof searchListings>[0]))
}

/** `geocode_places`. `prefer: 'locality'` asks for the suburb centroid, not a street. */
export async function callGeocodePlaces(args: unknown): Promise<Record<string, unknown>> {
  const { queries, prefer } = GeocodePlacesInput.parse(args)
  return wire(await geocodePlaces(queries, prefer === 'locality'))
}

/** `route_places`. Flat `{ id, lat, lng }` in; the library wants `{ id, coord }`. */
export async function callRoutePlaces(args: unknown): Promise<Record<string, unknown>> {
  const { places, destination, travelMode, travelArriveBy } = RoutePlacesInput.parse(args)
  return wire(
    await routePlaces(
      places.map((p) => ({ id: p.id, coord: { lat: p.lat, lng: p.lng } })),
      destination,
      travelMode,
      travelArriveBy,
    ),
  )
}

/** `resolve_location`. No browser involved; safe alongside anything. */
export async function callResolveLocation(args: unknown): Promise<unknown[]> {
  const { query, max } = ResolveLocationInput.parse(args)
  return wire(await suggestLocations(query, max))
}

/**
 * Release the Chrome profile. `capture-run` used to rely on the child server
 * exiting for this; in-process it has to ask. Chrome allows one process per
 * profile, so a capture cannot run while an interactive MCP server holds it.
 */
export const closeBrowser = closeContext

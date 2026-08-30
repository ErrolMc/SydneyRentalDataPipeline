import type { Place, Places, SuburbProfile } from 'sydney-rental-schema'

import type { Centroid } from './geocode-places.js'
import { haversineMetres } from './overpass.js'
import { suburbKey, type RawListing } from './raw.js'

/**
 * Where a suburb *is*, and the stub profile that hangs off it.
 *
 * This module exists because the same fact — a suburb's centroid — was being
 * derived twice from two different places, and the two drifted. `places.json`
 * carries a centroid for all 398 envelope locations, generated once by
 * `build:envelope`; `build` was placing every new suburb by asking the
 * gazetteer again and never looking at the envelope at all. Across the 46
 * committed profiles that left 43 disagreeing with their own envelope row by a
 * median of 217 m and as much as 1.47 km — which is exactly the drift
 * `geocode-places.ts` warns a different gazetteer produces.
 *
 * The envelope wins. It is the copy a human curated, the copy `km_from` and
 * `indicative_minutes` were measured against, and the copy `reset` keeps. A
 * profile centroid that disagrees with it is a second opinion nobody asked for.
 *
 * The files stay separate — config is what you want, knowledge is what you
 * found, and `reset` treats them oppositely — but the *fact* is now single.
 */

/**
 * Below this, two centroids are the same point. Both files round to 6 dp,
 * which is ~0.1 m, so a metre of slack absorbs float noise without letting a
 * real disagreement through.
 */
export const CENTROID_SAME_WITHIN_M = 1

/**
 * The envelope indexed the way a listing arrives — by suburb and postcode,
 * not by the `canonical` string a search takes.
 *
 * Keyed on `suburbKey`, so a `precinct` row (Walsh Bay, The Rocks) answers for
 * a listing REA reports in that precinct. No two of the 398 share a key.
 */
export function placesBySuburbKey(places: Places): Map<string, Place> {
  return new Map(places.places.map((place) => [suburbKey(place.name, place.postcode), place]))
}

/**
 * The mean position of listings that carry one — preferred over any gazetteer,
 * because a mean of real positions beats a centroid of a polygon.
 *
 * REA publishes no coordinates today, so this almost always returns null. It is
 * kept because it costs nothing on the day that changes.
 */
export function centroidOf(listings: readonly RawListing[]): Centroid | null {
  const located = listings.filter((listing) => listing.lat !== null && listing.lon !== null)
  if (located.length === 0) return null
  const lat = located.reduce((sum, listing) => sum + (listing.lat as number), 0) / located.length
  const lon = located.reduce((sum, listing) => sum + (listing.lon as number), 0) / located.length
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) }
}

/** Which of the three sources placed a suburb — logged, so a run says so out loud. */
export type CentroidSource = 'listings' | 'envelope' | 'gazetteer'

export interface PlacedCentroid {
  centroid: Centroid
  source: CentroidSource
}

/**
 * Listings, then the envelope, then the gazetteer.
 *
 * The gazetteer is last and is now only reached for a suburb the envelope does
 * not hold — which is possible, because REA blends `surrounding` listings from
 * neighbouring suburbs into every page and one of those can sit outside the
 * postcode range the envelope enumerated.
 */
export function placeSuburb(
  listings: readonly RawListing[],
  fromEnvelope: Place | undefined,
  fromGazetteer: Centroid | undefined,
): PlacedCentroid | null {
  const measured = centroidOf(listings)
  if (measured) return { centroid: measured, source: 'listings' }
  if (fromEnvelope) return { centroid: fromEnvelope.centroid, source: 'envelope' }
  if (fromGazetteer) return { centroid: fromGazetteer, source: 'gazetteer' }
  return null
}

export function stubSuburb(name: string, postcode: string, centroid: Centroid): SuburbProfile {
  return {
    name,
    postcode,
    sal_code: null,
    centroid,
    // Everything below is filled in by a build-suburbs stage (M6). Until
    // then the suburb scoring factor excludes itself rather than guessing.
    commute_baseline: null,
    rents: null,
    bonds: null,
    crime: null,
    census: null,
    percentiles: null,
    agent_notes: '',
  }
}

export interface CentroidCorrection {
  key: string
  from: Centroid
  to: Centroid
  metres: number
}

/**
 * Existing profiles whose centroid disagrees with the envelope's.
 *
 * A suburb the envelope does not hold is left alone rather than dropped — its
 * centroid came from the gazetteer and there is nothing better to compare it
 * against. Silence would be the wrong answer here, so `build` prints every
 * correction with its distance; this returns them rather than applying them so
 * it can.
 */
export function centroidCorrections(
  suburbs: Readonly<Record<string, SuburbProfile>>,
  placesByKey: ReadonlyMap<string, Place>,
): CentroidCorrection[] {
  const corrections: CentroidCorrection[] = []
  for (const [key, profile] of Object.entries(suburbs)) {
    const place = placesByKey.get(key)
    if (!place) continue
    const metres = haversineMetres(profile.centroid, place.centroid)
    if (metres <= CENTROID_SAME_WITHIN_M) continue
    corrections.push({ key, from: profile.centroid, to: place.centroid, metres })
  }
  return corrections.sort((a, b) => b.metres - a.metres)
}

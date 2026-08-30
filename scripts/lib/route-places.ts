import { z } from 'zod'

import type { JourneyComposition, MislabelledTravel } from 'sydney-rental-schema'

/**
 * The `route_places` boundary: what the MCP server returns, and how it becomes
 * this repo's shapes.
 *
 * ## Why this is parsed rather than cast
 *
 * It used to be cast. `enrich-travel.ts` declared the response inline as
 * `legs: { id, minutes, km }[]` and asserted it with `as typeof report`, which
 * TypeScript is happy to believe — so when the server started returning a
 * measured `journey` on every transit leg, the field arrived on the wire and was
 * dropped on the floor, silently, for as long as nobody looked. This repo kept
 * its own Trip Planner client to re-fetch what it was already being sent.
 *
 * A cast cannot fail. A parse can, which is the entire point at a boundary
 * between two repositories that are versioned separately.
 *
 * ## Why the server's shapes are not this repo's shapes
 *
 * The server speaks camelCase and minutes; the ledger is snake_case, and rounds
 * for diff readability (PLAN.md §4 step 9). Neither is wrong, so the translation
 * lives here rather than either side changing to suit the other — one file to
 * read when they disagree.
 */

const round1 = (n: number): number => Math.round(n * 10) / 10

const ServerJourneyLegSchema = z.object({
  productClass: z.number().int().nonnegative(),
  service: z.string().min(1).nullable(),
  serviceDescription: z.string().min(1).nullable(),
  from: z.string().min(1),
  to: z.string().min(1),
  minutes: z.number().nonnegative(),
  metres: z.number().nonnegative(),
})

const ServerJourneySchema = z.object({
  legs: z.array(ServerJourneyLegSchema).min(1),
  walkMetres: z.number().nonnegative(),
  serviceMinutes: z.number().nonnegative(),
  waitMinutes: z.number().nonnegative(),
  providerMinutes: z.number().nonnegative(),
  isWalk: z.boolean(),
  hasFerry: z.boolean(),
  interchanges: z.number().int().nonnegative(),
  metres: z.number().nonnegative(),
  /**
   * Both optional because the server's own route cache predates them. An entry
   * written between its `02150de` and the ferry work has legs but neither of
   * these, and a composition cannot be built from it — `toComposition` returns
   * null rather than inventing a `ferry_available: false`, which would read as
   * "no ferry here" when it means "nobody asked".
   */
  ferryAvailable: z.boolean().optional(),
  walkSpeedKmh: z.number().positive().optional(),
})

const ServerMislabelledSchema = z.object({
  actually: z.literal('ferry'),
  impliedKmh: z.number().positive(),
  thresholdKmh: z.number().positive(),
  ferryAvailable: z.literal(true),
})

export const RoutePlacesReportSchema = z.object({
  destination: z.object({
    query: z.string(),
    lat: z.number(),
    lng: z.number(),
    precision: z.enum(['building', 'street', 'area']),
  }),
  mode: z.enum(['walk', 'drive', 'transit']),
  /** Which provider actually answered — `tfnsw` or `google`, not what was configured. */
  router: z.string(),
  arriveBy: z.string().nullable(),
  places: z.number().int().nonnegative(),
  legs: z.array(
    z.object({
      id: z.string().min(1),
      minutes: z.number().nonnegative(),
      km: z.number().nonnegative(),
      journey: ServerJourneySchema.optional(),
      mislabelled: ServerMislabelledSchema.optional(),
    }),
  ),
  /** Ids with no answer at all. Never a straight line standing in for one. */
  unroutable: z.array(z.string()),
  matrixCalls: z.number().int().nonnegative(),
  cachedLegs: z.number().int().nonnegative(),
})

export type RoutePlacesReport = z.infer<typeof RoutePlacesReportSchema>
export type RoutePlacesLeg = RoutePlacesReport['legs'][number]

/**
 * A measured journey as the ledger stores it, or null when the server's answer
 * came from a cache entry written before it recorded ferry availability and
 * walking speed. Null is not a failure — it means re-measure, and the caller
 * says so rather than writing a composition that would be wrong in one field.
 */
export function toComposition(journey: NonNullable<RoutePlacesLeg['journey']>): JourneyComposition | null {
  if (journey.ferryAvailable === undefined || journey.walkSpeedKmh === undefined) return null
  return {
    source: 'tfnsw',
    ferry_available: journey.ferryAvailable,
    legs: journey.legs.map((leg) => ({
      product_class: leg.productClass,
      service: leg.service,
      service_description: leg.serviceDescription,
      from: leg.from,
      to: leg.to,
      minutes: round1(leg.minutes),
      metres: leg.metres,
    })),
    walk_metres: Math.round(journey.walkMetres),
    service_minutes: round1(journey.serviceMinutes),
    wait_minutes: round1(journey.waitMinutes),
    walk_speed_kmh: journey.walkSpeedKmh,
    is_walk: journey.isWalk,
    has_ferry: journey.hasFerry,
    interchanges: journey.interchanges,
    provider_minutes: round1(journey.providerMinutes),
  }
}

/** The server's ferry finding, in the ledger's spelling. */
export function toMislabelled(
  evidence: NonNullable<RoutePlacesLeg['mislabelled']>,
): MislabelledTravel {
  return {
    actually: evidence.actually,
    implied_kmh: evidence.impliedKmh,
    threshold_kmh: evidence.thresholdKmh,
    ferry_available: evidence.ferryAvailable,
  }
}

/** "walk · F4 ferry · walk", from a stored composition. */
export function describeComposition(composition: JourneyComposition): string {
  return composition.legs
    .map((leg) => (leg.service ? `${leg.service} ${legLabel(leg.product_class)}` : legLabel(leg.product_class)))
    .join(' · ')
}

const LABELS: Readonly<Record<number, string>> = {
  1: 'train',
  2: 'metro',
  4: 'light rail',
  5: 'bus',
  7: 'coach',
  9: 'ferry',
  11: 'school bus',
  99: 'walk',
  100: 'walk',
  107: 'cycle',
}

const legLabel = (productClass: number): string => LABELS[productClass] ?? `class ${productClass}`

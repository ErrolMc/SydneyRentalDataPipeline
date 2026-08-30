import type { MislabelledWalk } from '../distance.js'
import type { Journey } from '../tfnsw.js'

import type { JourneyComposition, MislabelledTravel } from 'sydney-rental-schema'

/**
 * How a routed answer becomes the ledger's shape.
 *
 * ## Why the router's shapes are not the ledger's shapes
 *
 * `distance.ts` speaks camelCase and unrounded minutes; the ledger is
 * snake_case, and rounds for diff readability (PLAN.md §4 step 9). Neither is
 * wrong, so the translation lives here rather than either side changing to suit
 * the other — one file to read when they disagree.
 *
 * ## What used to be here, and why it went
 *
 * A zod mirror of the wire format, because this was a boundary between two
 * processes: `enrich-travel.ts` had declared the response inline as
 * `legs: { id, minutes, km }[]` and asserted it with `as typeof report`, which
 * TypeScript is happy to believe — so when the server began returning a
 * measured `journey` on every transit leg, the field arrived over stdio and was
 * dropped on the floor, silently, for as long as nobody looked. A cast cannot
 * fail; a parse can. That argument was right for a boundary between two
 * separately versioned repositories.
 *
 * It stopped being one. `Journey` and `MislabelledWalk` are imported from the
 * modules that produce them now, and the compiler checks the same field names
 * the parser used to — at build time, over the whole call, rather than at run
 * time over one answer. PHASE2.md Step 4 proved the deletion value-neutral
 * against a live answer before making it.
 */

const round1 = (n: number): number => Math.round(n * 10) / 10


/**
 * A measured journey as the ledger stores it, or null when the server's answer
 * came from a cache entry written before it recorded ferry availability and
 * walking speed. Null is not a failure — it means re-measure, and the caller
 * says so rather than writing a composition that would be wrong in one field.
 */
export function toComposition(journey: Journey): JourneyComposition | null {
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
export function toMislabelled(evidence: MislabelledWalk): MislabelledTravel {
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

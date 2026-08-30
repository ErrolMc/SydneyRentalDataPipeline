import type { z } from 'zod'

import { FACTOR_KEYS, travelKey } from 'sydney-rental-schema'
import type {
  Criteria,
  Enrichment,
  EnrichmentStatus,
  FactorKey,
  ScoresSchema,
  SuburbProfile,
  Travel,
} from 'sydney-rental-schema'

type Scores = z.infer<typeof ScoresSchema>
type Factor = Scores['factors'][FactorKey]

/**
 * Scoring (PLAN.md §8.2–8.4). Pure: same inputs, same output, no clock, no
 * network, no filesystem. Every run recomputes every score from that run's
 * `criteria_snapshot` — scores are never cached, which is what stops a
 * criteria change from leaving stale numbers behind in an old run.
 *
 * Composites are only comparable within one `criteria_version`.
 */

// ── §8.2 normalisation ───────────────────────────────────────────────────────

/**
 * Linear interpolation between `[raw, score]` anchors, clamped to 0–100.
 *
 * Anchors are sorted here rather than assumed ascending, because the curves in
 * criteria.json run both ways: `price` ascends by raw (cheaper is better, so
 * its scores descend) while `space` descends by raw (bigger is better).
 * Sorting lets one implementation serve both, and makes out-of-range values
 * clamp to the nearest anchor's score in the correct direction — which is what
 * gives "below target never exceeds 100" for free.
 */
export function piecewise(anchors: readonly (readonly [number, number])[]) {
  const points = [...anchors].sort((a, b) => a[0] - b[0])
  const last = points[points.length - 1]

  return (raw: number): number => {
    if (raw <= points[0][0]) return clamp(points[0][1])
    if (raw >= last[0]) return clamp(last[1])

    for (let index = 0; index < points.length - 1; index += 1) {
      const [lowRaw, lowScore] = points[index]
      const [highRaw, highScore] = points[index + 1]
      if (raw <= highRaw) {
        const span = highRaw - lowRaw
        const ratio = span === 0 ? 0 : (raw - lowRaw) / span
        return clamp(lowScore + ratio * (highScore - lowScore))
      }
    }

    return clamp(last[1])
  }
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, score))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ── factor helpers ───────────────────────────────────────────────────────────

const scored = (raw: number | null, score: number): Factor => ({ raw, score: round(score, 0) })
const sitOut = (raw: number | null, why: string): Factor => ({ raw, score: null, excluded: why })

/**
 * §8.1 status semantics, applied to scoring:
 *   ok / fallback  → score the value we have
 *   none_found     → a real signal, not a gap: nothing within the radius scores 0
 *   unavailable    → the provider was down, so we know nothing. The factor sits
 *                    out and its weight is redistributed. Never zeroed.
 */
function fromPoi(
  status: EnrichmentStatus,
  walkMinutes: number | null,
  curve: readonly (readonly [number, number])[],
  noneFoundScore = 0,
): Factor {
  if (status === 'unavailable') return sitOut(null, 'provider_unavailable')
  if (status === 'none_found') return scored(null, noneFoundScore)
  if (walkMinutes === null) return sitOut(null, 'provider_unavailable')
  return scored(walkMinutes, piecewise(curve)(walkMinutes))
}

// ── §8.3 suburb factor ───────────────────────────────────────────────────────

const RENT_VALUE_CURVE = [
  [-0.15, 100],
  [0, 60],
  [0.15, 20],
] as const

/**
 * `0.4 × crime percentile + 0.3 × SEIFA decile + 0.3 × rent value`, plus an +8
 * bonus (capped at 100) for a suburb on the preferred list.
 *
 * Each component brings its own missing-data handling: whichever ones have
 * data are renormalised over their own sub-weights, mirroring how the
 * composite redistributes weight in §8.4. A profile with nothing usable
 * excludes the factor outright rather than marking a listing down for a gap in
 * *our* data collection. Nothing here is populated until M6 runs
 * `build-suburbs.ts`, so today this always excludes.
 */
function suburbFactor(
  profile: SuburbProfile | null,
  suburbKey: string,
  pricePerWeek: number | null,
  beds: number,
  criteria: Criteria,
): Factor {
  if (!profile) return sitOut(null, 'no_suburb_profile')

  const parts: { weight: number; score: number }[] = []

  if (profile.percentiles) {
    parts.push({ weight: 0.4, score: clamp(profile.percentiles.crime_lower_than_pct * 100) })
  }

  if (profile.census?.seifa_irsad_decile != null) {
    parts.push({ weight: 0.3, score: clamp(profile.census.seifa_irsad_decile * 10) })
  }

  const median = profile.rents?.median_rent_by_beds[String(beds)] ?? null
  if (median != null && median > 0 && pricePerWeek != null) {
    const gap = (pricePerWeek - median) / median
    parts.push({ weight: 0.3, score: piecewise(RENT_VALUE_CURVE)(gap) })
  }

  if (parts.length === 0) return sitOut(null, 'incomplete_suburb_profile')

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0)
  const base = parts.reduce((sum, part) => sum + part.weight * part.score, 0) / totalWeight
  const bonus = criteria.search.preferred_suburbs.includes(suburbKey) ? 8 : 0

  // `raw` carries the pre-bonus composition, so the UI can show where the +8 came from.
  return { raw: round(base, 1), score: round(clamp(base + bonus), 0) }
}

// ── §8.4 composite, nulls, dealbreakers ──────────────────────────────────────

export interface ScoreInput {
  price_pw: number | null
  beds: number
  baths: number
  car_spaces: number
  area_sqm: number | null
  suburb_key: string
  enrichment: Enrichment
  suburb_profile: SuburbProfile | null
}

export function scoreListing(input: ScoreInput, criteria: Criteria): Scores {
  const { curves, weights, dealbreakers } = criteria
  const commute = input.enrichment.commute
  const { drive } = commute
  const { cafe, supermarket, gym } = input.enrichment.walkability

  const factors: Record<FactorKey, Factor> = {
    price:
      input.price_pw === null
        ? sitOut(null, 'missing_price')
        : scored(input.price_pw, piecewise(curves.price)(input.price_pw)),

    space: spaceFactor(input.area_sqm, input.beds, curves.space),

    // Boolean, no curve — the listing either has parking or it does not.
    car_space: scored(input.car_spaces, input.car_spaces > 0 ? 100 : 0),

    commute: commuteFactor(commute, curves.commute),

    drive:
      drive.status === 'unavailable' || drive.minutes === null
        ? sitOut(null, 'provider_unavailable')
        : scored(drive.minutes, piecewise(curves.drive)(drive.minutes)),

    walk_cafe: fromPoi(cafe.status, cafe.walk_minutes, curves.walk_cafe),
    walk_supermarket: fromPoi(supermarket.status, supermarket.walk_minutes, curves.walk_supermarket),
    // Gyms are patchily tagged in OSM, so "none found" is weak evidence of
    // absence — it scores 30 rather than 0 (§8.1).
    walk_gym: fromPoi(gym.status, gym.walk_minutes, curves.walk_gym, 30),

    suburb: suburbFactor(
      input.suburb_profile,
      input.suburb_key,
      input.price_pw,
      input.beds,
      criteria,
    ),
  }

  let weightedTotal = 0
  let includedWeight = 0
  let allWeight = 0

  for (const key of FACTOR_KEYS) {
    allWeight += weights[key]
    const factor = factors[key]
    if (factor.score === null) continue
    weightedTotal += weights[key] * factor.score
    includedWeight += weights[key]
  }

  return {
    composite: includedWeight === 0 ? 0 : round(weightedTotal / includedWeight, 1),
    confidence: allWeight === 0 ? 0 : round(includedWeight / allWeight, 2),
    dealbreakers: findDealbreakers(input, dealbreakers),
    factors,
  }
}

/**
 * Sydney rentals routinely omit internal area. Excluding the factor means a
 * missing measurement never helps *or* hurts a listing — it only lowers
 * `confidence`, which is what makes the gap visible in the UI.
 */
function spaceFactor(
  areaSqm: number | null,
  beds: number,
  curve: Criteria['curves']['space'],
): Factor {
  if (areaSqm === null) return sitOut(null, 'missing_sqm')
  if (beds < 1) return sitOut(areaSqm, 'unknown_beds')
  const perBed = round(areaSqm / beds, 1)
  return scored(perBed, piecewise(curve)(perBed))
}

/**
 * How long it takes to get to the office by the means you would actually use:
 * the fastest of the measured ways in.
 *
 * One factor rather than one per mode, for two reasons. A walk and a transit
 * trip are frequently the *same* measurement — Google returns the walking route
 * as the transit answer for anything close enough — so scoring them separately
 * would count one commute twice, systematically favouring the inner city. And a
 * search has already imposed its own travel budget by the time scoring runs, so
 * the factor's real job is making listings from *different* searches comparable
 * on one page; mode-specific weights would score them over different
 * denominators and make their composites unreadable side by side.
 *
 * Interchanges cost 5 minutes each — a change of train is worse than the clock
 * says — so the comparison is on the adjusted number, and a walk fairly beats a
 * two-change train of the same duration. A null interchange count means "not
 * reported", not "none", and adds nothing.
 *
 * `drive` is deliberately not in here. It answers whether you *could* drive,
 * which is a different question, and it carries its own small weight.
 */
export function commuteMinutes(commute: Enrichment['commute']): number | null {
  const ways: number[] = []
  const { walk, transit } = commute

  if (walk.status !== 'unavailable' && walk.minutes !== null) ways.push(walk.minutes)
  if (transit.status !== 'unavailable' && transit.minutes !== null) {
    ways.push(transit.minutes + 5 * (transit.interchanges ?? 0))
  }

  return ways.length === 0 ? null : Math.min(...ways)
}

function commuteFactor(
  commute: Enrichment['commute'],
  curve: Criteria['curves']['commute'],
): Factor {
  const raw = commuteMinutes(commute)
  return raw === null ? sitOut(null, 'provider_unavailable') : scored(raw, piecewise(curve)(raw))
}

/**
 * Dealbreakers run before ranking, but the listing is still enriched, scored
 * and stored — price history and relist tracking have to keep working for a
 * place that is merely too expensive today. The site collapses these into a
 * "filtered out" section rather than hiding them.
 */
function findDealbreakers(input: ScoreInput, rules: Criteria['dealbreakers']): string[] {
  const hits: string[] = []

  if (input.price_pw !== null && input.price_pw > rules.hard_cap_pw) hits.push('rent_above_hard_cap')
  if (input.beds < rules.min_beds) hits.push('too_few_beds')
  if (input.baths < rules.min_baths) hits.push('too_few_baths')
  if (rules.require_car_space && input.car_spaces < 1) hits.push('no_car_space')

  // The same fastest-mode number the factor scores, so a 40 minute walk cannot
  // escape a cap a 40 minute train would hit. Never dealbreak on missing data:
  // `commuteMinutes` returns null when nothing was measured, and an unavailable
  // provider must not filter a listing out, or one API outage would quietly
  // empty the whole shortlist.
  const minutes = commuteMinutes(input.enrichment.commute)
  if (minutes !== null && minutes > rules.max_commute_minutes) hits.push('commute_too_long')

  return hits
}

const UNAVAILABLE_TRANSIT: Enrichment['commute']['transit'] = {
  status: 'unavailable',
  source: null,
  minutes: null,
  interchanges: null,
  walk_minutes_total: null,
  legs_summary: null,
}

const UNAVAILABLE_ROUTED: Enrichment['commute']['drive'] = {
  status: 'unavailable',
  source: null,
  minutes: null,
  distance_km: null,
}

/**
 * The all-`unavailable` enrichment block a run starts from. Every
 * provider-backed factor sees `unavailable` and sits out of the composite, so
 * weight redistribution and `confidence` behave exactly as they will once every
 * provider answers. `commuteFromTravel` fills the commute half; walkability is
 * still unbuilt.
 */
export function unenrichedBlock(
  suburbKey: string,
  configHash: string,
  enrichedAt: string,
): Enrichment {
  const poi = {
    status: 'unavailable' as const,
    source: null,
    name: null,
    walk_minutes: null,
    distance_m: null,
  }

  return {
    enriched_at: enrichedAt,
    config_hash: configHash,
    commute: {
      walk: UNAVAILABLE_ROUTED,
      transit: UNAVAILABLE_TRANSIT,
      drive: UNAVAILABLE_ROUTED,
    },
    walkability: { cafe: poi, supermarket: { ...poi, is_major_chain: null }, gym: poi },
    suburb_ref: suburbKey,
  }
}

/**
 * What actually measured the minutes. The MCP server picks the router — Google
 * today, something else before — and reports which per pass in
 * `run.searches[].travel.router`. Naming that router here as well would
 * duplicate a fact that can change without this file noticing, so this names
 * the thing that answered and leaves the router to the report.
 */
const TRAVEL_SOURCE = 'realestate-mcp'

/**
 * A locality centroid is a degraded measurement, not a wrong one: it scores
 * identically and dealbreaks identically, but §8.1 keeps `fallback` distinct
 * from `ok` so the UI can say which it is rather than rounding the distinction
 * away.
 */
function statusFor(travel: Travel): EnrichmentStatus {
  return travel.precision === 'area' ? 'fallback' : 'ok'
}

/**
 * The commute half of the enrichment block, from the routed times the run
 * measured into `listing.travel`.
 *
 * `scoreListing` reads commute from `enrichment.commute`; the MCP server
 * measures into `listing.travel`. This is the join between them, and it fills
 * the block rather than teaching the scorer a second source — so walkability
 * can fill the other half of the same block by the same mechanism.
 *
 * A mode with no routed entry stays `unavailable`, which excludes it from
 * `commuteMinutes` and, if nothing was measured at all, redistributes the
 * factor's weight. A missing measurement is not a zero.
 *
 * `interchanges` and `walk_minutes_total` stay null because the server reports
 * a door-to-door total, not legs. `commuteMinutes` reads a null interchange
 * count as "no penalty known" rather than "no changes", so a transit time is
 * scored on the clock alone until legs are available.
 */
export function commuteFromTravel(
  travel: Record<string, Travel>,
  originId: string,
): Enrichment['commute'] {
  const routed = (mode: 'walk' | 'drive'): Enrichment['commute']['drive'] => {
    const leg = travel[travelKey(originId, mode)]
    if (!leg) return UNAVAILABLE_ROUTED
    return {
      status: statusFor(leg),
      source: TRAVEL_SOURCE,
      minutes: leg.minutes,
      distance_km: leg.km,
    }
  }

  const transit = travel[travelKey(originId, 'transit')]

  return {
    walk: routed('walk'),
    transit: transit
      ? {
          status: statusFor(transit),
          source: TRAVEL_SOURCE,
          minutes: transit.minutes,
          interchanges: null,
          walk_minutes_total: null,
          legs_summary: null,
        }
      : UNAVAILABLE_TRANSIT,
    drive: routed('drive'),
  }
}

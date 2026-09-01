import { z } from 'zod'

import {
  TravelMode,
  TravelReportSchema,
  TravelSchema,
  type PropertyType,
  type Travel,
} from 'sydney-rental-schema'
import type { RawListing } from './raw.js'
import { studioListingSignals } from './studio.js'

/**
 * Mapping the search library's `Listing` (src/types.ts) onto the shape a run needs.
 *
 * The capture file stores what the search actually returned, verbatim, and
 * this module is the only thing that interprets it. That split is deliberate:
 * REA's payload is a moving target, and when a mapping turns out to be wrong
 * the fix is to change this file and replay the capture — not to search REA
 * again and hope the same listings come back.
 *
 * Source: this repo's src/, formerly the RealEstateMCP server (its tools `search_listings`,
 * `get_listing`, `resolve_location`).
 */

/**
 * The MCP `Listing` interface, kept lenient. Only `id` is truly required —
 * anything else may be absent on a given listing, and a run that aborts because
 * one result lacked a bathroom count would be useless.
 */
export const ReaListingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  url: z.string().optional(),
  address: z.string().default(''),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  /** Display text only — REA publishes no numeric rent. See `parseRentPerWeek`. */
  price: z.string().default(''),
  propertyType: z.string().optional(),
  bedrooms: z.number().optional(),
  bathrooms: z.number().optional(),
  carSpaces: z.number().optional(),
  studies: z.number().optional(),
  landSize: z.string().optional(),
  buildingSize: z.string().optional(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  floorplans: z.array(z.string()).optional(),
  /**
   * Filled in by the server's own geocoder whenever `travelFrom` is passed —
   * which is where every listing's position comes from, because REA publishes
   * none of its own. Absent on a search that asked for no travel times.
   */
  coords: z.object({ lat: z.number(), lng: z.number() }).nullish(),

  /**
   * Real routed time from the query's `travelFrom` origin. Null when the address
   * could not be routed — never a straight-line guess standing in for a
   * measurement, which is why a search treats it as "no match" rather than
   * "close" (see `matchesSearch`).
   */
  travel: TravelSchema.nullish(),
  /** True when REA blended this in from a neighbouring suburb. */
  isSurrounding: z.boolean().optional(),
})

export type ReaListing = z.infer<typeof ReaListingSchema>

/**
 * One query pass: every page of every location for a single `origin:mode`
 * group, exactly as `search_listings` returned them.
 *
 * A group is the unit because `travelMode` is per request, so walk and drive
 * are always separate passes and the routed times they carry mean different
 * things. Keeping them apart in the capture is what lets one listing end up
 * with both a walk time and a drive time without either being guessed at.
 */
export const ReaCaptureGroupSchema = z.object({
  /** Origin id from `searches.json`, not the address — the key half of `office:walk`. */
  origin: z.string().min(1),
  mode: TravelMode,
  /** The `maxTravelMinutes` actually sent: the widest budget among the group's searches. */
  max_travel_minutes: z.number().positive(),
  /**
   * The `travelArriveBy` sent, for a transit group. This is the run's
   * `transit_departure_resolved` — recorded here because a transit number means
   * nothing without the moment it was measured at, and a replay has to know it.
   */
  arrive_by: z.string().nullish(),
  locations_searched: z.array(z.string().min(1)).default([]),
  /** The server's own account of what it managed to measure. Null if it errored. */
  travel_report: TravelReportSchema.nullish(),
  results: z.array(ReaListingSchema),
  /**
   * What `maxTravelMinutes` rejected — identity, position and routed time only.
   *
   * The server drops these after geocoding and routing each one, so without
   * them the capture has no record that the work was ever done and the next run
   * pays for the same rejection again. They are never published in a run; they
   * go to the ledger's `rejected` map. Absent on captures taken before the
   * server returned them.
   */
  filtered_by_travel: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string().min(1).nullish(),
        address: z.string().min(1),
        suburb: z.string().nullish(),
        state: z.string().nullish(),
        postcode: z.string().nullish(),
        coords: z.object({ lat: z.number(), lng: z.number() }).nullish(),
        travel: TravelSchema.nullish(),
      }),
    )
    .default([]),
})

export type ReaCaptureGroup = z.infer<typeof ReaCaptureGroupSchema>

/**
 * The capture file: the agent's step-4 output, written to the scratchpad and
 * never committed. Raw — no filtering, no reshaping.
 */
export const ReaCaptureSchema = z.object({
  /** Where these came from, e.g. `rea-mcp`. Recorded in the run's provider report. */
  source: z.string().min(1),
  captured_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),

  /** The run's markdown editorial (§4 step 9). Empty is allowed but validated against. */
  commentary: z.string().default(''),

  /**
   * The entries from `criteria.search.locations` that were actually queried.
   *
   * A run embeds the full criteria snapshot, so a partial search — a trial run
   * over a handful of suburbs, or a session cut short by a flaky MCP server —
   * would otherwise produce a run.json claiming coverage it does not have.
   * Listing them here lets the run say so out loud, and disables the staleness
   * rule, since absence from an unsearched suburb is not evidence of anything.
   * Leave empty to mean "all of them".
   */
  searched_locations: z.array(z.string().min(1)).default([]),

  /**
   * What the agent found when it checked a disappeared listing's URL, keyed by
   * id (AGENT.md §5–9).
   *
   * Three outcomes, not two. Since a search asks REA to withhold listings
   * outside its travel budget, an absence no longer means anything on its own —
   * a listing drifting from 14 to 16 minutes' walk stops coming back and looks
   * exactly like one that left the market. `unmatched` is the answer for "page
   * is still live": still for rent, just outside every search now. Anything
   * active-but-absent and *not* named here could not be checked, and goes stale
   * after a second consecutive absence rather than being guessed at.
   */
  gone: z.record(z.string(), z.enum(['leased', 'withdrawn', 'unmatched'])).default({}),

  /** One entry per `origin:mode` query pass. Empty on a capture taken before searches existed. */
  groups: z.array(ReaCaptureGroupSchema).default([]),

  /**
   * The pre-searches capture shape: a flat concatenation of every page, with no
   * travel times. Kept so `replay-run.ts` can still rebuild run 2026-08-24a.
   */
  results: z.array(ReaListingSchema).default([]),
})

export type ReaCapture = z.infer<typeof ReaCaptureSchema>

/**
 * One listing as the whole capture saw it: the facts once, and every routed time
 * any group measured for it.
 */
export interface CapturedListing {
  listing: ReaListing
  /** Routed times by `<origin-id>:<mode>` — one per group that returned it. */
  travel: Record<string, Travel>
}

export interface FlattenedCapture {
  listings: CapturedListing[]
  /** How many listings each group returned, by `origin:mode` key. */
  groupTotals: Record<string, number>
  /** Every id the capture returned, in any group — what step 5 tests absence against. */
  returnedIds: Set<string>
}

/**
 * Collapse a capture into one row per listing.
 *
 * A listing near the office comes back from both the walk pass and the drive
 * pass, and REA blends neighbouring suburbs into every page besides, so
 * duplicates are the norm rather than the exception. First occurrence wins for
 * the facts — they are the same listing — but the routed times are *merged*,
 * because each pass measured a different thing and both are worth keeping.
 */
export function flattenCapture(capture: ReaCapture): FlattenedCapture {
  const byId = new Map<string, CapturedListing>()
  const groupTotals: Record<string, number> = {}

  const groups: { key: string | null; results: ReaListing[] }[] =
    capture.groups.length > 0
      ? capture.groups.map((group) => ({
          key: `${group.origin}:${group.mode}`,
          results: group.results,
        }))
      : [{ key: null, results: capture.results }]

  for (const group of groups) {
    const seenInGroup = new Set<string>()

    for (const listing of group.results) {
      if (!seenInGroup.has(listing.id)) {
        seenInGroup.add(listing.id)
        if (group.key) groupTotals[group.key] = (groupTotals[group.key] ?? 0) + 1
      }

      const existing = byId.get(listing.id)
      const row = existing ?? { listing, travel: {} }
      if (!existing) byId.set(listing.id, row)

      if (group.key && listing.travel) row.travel[group.key] = listing.travel
    }
  }

  return {
    listings: [...byId.values()],
    groupTotals,
    returnedIds: new Set(byId.keys()),
  }
}

// ── price ────────────────────────────────────────────────────────────────────

/** Sydney weekly rents outside this band are noise — a bond, a parking add-on, a typo. */
const MIN_PLAUSIBLE_PW = 100
const MAX_PLAUSIBLE_PW = 5000

/**
 * `"$650 per week"` → `650`.
 *
 * REA's `price` is free text an agent typed, so this has to cope with ranges
 * (`"$650 - $700 per week"`), add-ons (`"$650 pw + $30 parking"`) and refusals
 * (`"Contact agent"`). Taking the smallest plausible figure handles the first
 * two: the low end of a range is the advertised entry price, and an add-on is
 * always smaller than the rent. Anything implausible yields null and the
 * listing is flagged `no_price` rather than given an invented number.
 */
export function parseRentPerWeek(display: string): number | null {
  if (!display) return null

  // Monthly and annual figures appear on the odd commercial crossover listing.
  // Converting one would be inventing precision, so decline instead.
  if (/\b(per month|pcm|per annum|p\.?a\.?)\b/i.test(display) && !/week|pw|p\/w/i.test(display)) {
    return null
  }

  const amounts = [...display.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((value) => Number.isFinite(value) && value >= MIN_PLAUSIBLE_PW && value <= MAX_PLAUSIBLE_PW)

  return amounts.length === 0 ? null : Math.round(Math.min(...amounts))
}

// ── property type ────────────────────────────────────────────────────────────

/**
 * REA's `propertyType.display` is title-case free text with a wider vocabulary
 * than our enum. Villas map to townhouse (attached, single-storey — closer to a
 * townhouse than a house), and a studio maps to `other` rather than pretending
 * to be an apartment, so it stays visible as the different thing it is.
 */
const PROPERTY_TYPES: [RegExp, PropertyType][] = [
  [/\bterrace\b/i, 'terrace'],
  [/\bduplex\b/i, 'duplex'],
  [/\btown\s?house\b/i, 'townhouse'],
  [/\bvilla\b/i, 'townhouse'],
  [/\bstudio\b/i, 'other'],
  [/\b(apartment|penthouse)\b/i, 'apartment'],
  [/\b(unit|flat)\b/i, 'unit'],
  [/\b(house|semi[-\s]?detached|cottage)\b/i, 'house'],
]

export function mapPropertyType(display: string | undefined): PropertyType {
  if (!display) return 'other'
  for (const [pattern, type] of PROPERTY_TYPES) {
    if (pattern.test(display)) return type
  }
  return 'other'
}

// ── size ─────────────────────────────────────────────────────────────────────

/** Sydney apartments outside this band are a land size or a parse error. */
const MIN_PLAUSIBLE_SQM = 15
const MAX_PLAUSIBLE_SQM = 600

/** `"80m²"` → `80`. Present on roughly one listing in ten, hence `area_sqm` being nullable. */
export function parseSqm(size: string | undefined): number | null {
  if (!size) return null
  const match = /([\d,]+(?:\.\d+)?)/.exec(size)
  if (!match) return null
  const value = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(value) || value < MIN_PLAUSIBLE_SQM || value > MAX_PLAUSIBLE_SQM) return null
  return Math.round(value)
}

// ── images ───────────────────────────────────────────────────────────────────

/**
 * REA's media CDN takes the resolution as a path segment, and the MCP parser
 * bakes in `1024x768` for its own vision use. Our committed WebP is 1200px
 * wide, so asking for 1024 would quietly cap every photo below target —
 * `withoutEnlargement` would leave them at 1024 and nothing would complain.
 *
 * 1600x1200 gives headroom to downsample from, which is visibly cleaner than
 * re-encoding a same-size source. Verified against the CDN: it really does
 * render the larger size (198 KB at 1024x768 vs 479 KB at 1600x1200) rather
 * than ignoring the segment.
 */
const SOURCE_IMAGE_SIZE = '1600x1200'

export function upscaleImageUrl(url: string, size = SOURCE_IMAGE_SIZE): string {
  if (url.includes('{size}')) return url.replace('{size}', size)
  return url.replace(/\/\d{2,4}x\d{2,4}\//, `/${size}/`)
}

// ── the mapping ──────────────────────────────────────────────────────────────

const POSTCODE = /^\d{4}$/

/** Pull `Suburb, STATE 2042` out of a full address when the structured fields are missing. */
function fromAddress(address: string): { suburb?: string; state?: string; postcode?: string } {
  const match = /,\s*([^,]+?),?\s+([A-Z]{2,3})\s+(\d{4})\s*$/.exec(address.trim())
  if (!match) return {}
  return { suburb: match[1].trim(), state: match[2], postcode: match[3] }
}

export interface MappingProblem {
  id: string
  reason: string
}

/**
 * Convert one MCP listing. Returns null when the result cannot become a valid
 * listing entry — no id, no usable suburb/postcode — because those are the
 * ledger key and the suburb key, and a wrong one corrupts memory that is meant
 * to be append-only.
 */
export function reaToRawListing(
  listing: ReaListing,
  problems: MappingProblem[],
  /**
   * Routed times merged across every query pass that returned this listing —
   * from `flattenCapture`, not from `listing.travel`, because one pass only ever
   * measures one mode.
   */
  travel: Record<string, Travel> = {},
): RawListing | null {
  const parsed = fromAddress(listing.address)
  const suburb = (listing.suburb ?? parsed.suburb ?? '').trim()
  const postcode = (listing.postcode ?? parsed.postcode ?? '').trim()

  if (!listing.id) {
    problems.push({ id: '(missing)', reason: 'no listing id' })
    return null
  }
  if (!suburb || !POSTCODE.test(postcode)) {
    problems.push({ id: listing.id, reason: `unusable suburb/postcode ("${suburb}" ${postcode})` })
    return null
  }
  if (!listing.address.trim()) {
    problems.push({ id: listing.id, reason: 'no address' })
    return null
  }

  const buildingSqm = parseSqm(listing.buildingSize)

  return {
    id: listing.id,
    url: listing.url ?? `https://www.realestate.com.au/${listing.id}`,
    address: listing.address.trim(),
    suburb,
    postcode,
    state: (listing.state ?? parsed.state ?? 'NSW').trim(),

    // REA publishes no coordinates. `coords` is read anyway so the day that
    // changes, this starts working with no edit here.
    lat: listing.coords?.lat ?? null,
    lon: listing.coords?.lng ?? null,

    price_pw: parseRentPerWeek(listing.price),
    price_display: listing.price.trim(),

    beds: listing.bedrooms ?? 0,
    baths: listing.bathrooms ?? 0,
    car_spaces: listing.carSpaces ?? 0,

    area_sqm: buildingSqm,
    // REA's `propertySizes.building` is a published listing field rather than
    // something read off a floorplan or estimated by us.
    area_source: buildingSqm === null ? null : 'listing_text',

    property_type: mapPropertyType(listing.propertyType),
    // The MCP payload carries neither an availability date nor a bond, on
    // search results or detail pages. Null is the honest answer.
    available_date: null,
    bond: null,

    // Nor a structured feature list. Deriving one from the description would be
    // guesswork, and nothing renders features until the M3 detail page.
    features: [],
    description: listing.description ?? '',

    // Read off the *full* description, which only exists here — a run keeps
    // 500 characters of it and the evidence is often past that cut.
    share_signals: roomListingSignals(listing),

    // Same reasoning, plus REA's own `Studio` property type, which the site
    // could never see either: it maps to `other` and the distinction was lost.
    studio_signals: studioListingSignals(listing),

    travel,

    image_urls: (listing.images ?? []).map((url) => upscaleImageUrl(url)),
    agent_notes: '',
  }
}

/**
 * `criteria.search.exclude_keywords` cannot be pushed into the REA query — the
 * URL grammar has no keyword exclusion. Matching prose would be worse than
 * useless (a two-bedder described as having a "studio-like living area" is not
 * a studio), so this checks only the two high-precision fields: REA's own
 * property type and the address.
 *
 * Anything a keyword cannot catch precisely stays in the capture, which suits
 * a data set the site is meant to filter anyway.
 */
export function excludedByKeyword(listing: ReaListing, keywords: readonly string[]): string | null {
  const haystack = `${listing.propertyType ?? ''} ${listing.address}`
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    if (pattern.test(haystack)) return keyword
  }
  return null
}

// ── rooms and share houses ───────────────────────────────────────────────────

/**
 * REA has no "room in a share house" category, so a room is advertised as
 * whatever building it sits in — `House` at a normal street address, $400 a
 * week — and every structured field looks like an ordinary rental. The only
 * place it says otherwise is the prose.
 *
 * That is why this is a *separate* signal set rather than more entries in
 * `criteria.search.exclude_keywords`. Those keywords are matched against REA's
 * property type and the address only, and for good reason: a bare `"share"`
 * against a description is worthless. In the 2026-08-24 capture, 70 of 358
 * descriptions contain the string "share" and only a handful are share houses —
 * the rest are `shared laundry` (30 on its own), `shared garden`, `shared rear
 * yard`, `shared rooftop terrace`, all perfectly normal in a self-contained
 * flat. Likewise "room": 78 hits, nearly all `lounge room`, `dining room`,
 * `laundry room`, `plenty of room`.
 *
 * The question these phrases actually answer is narrower and sharper:
 *
 *   **is this a whole self-contained dwelling, or one room inside one?**
 *
 * A listing fails it if the ad offers a *room* rather than a home, or if the
 * home has no kitchen or bathroom of its own. That second clause is what puts
 * co-living studios sharing a communal kitchen on the same side of the line as
 * a boarding-house room, which is right: neither is a flat you can cook and
 * wash in alone.
 *
 * Two structural signals were tested against the capture and deliberately left
 * out, because they are not decisive on their own:
 *
 * - `baths > beds` matched 5 listings, 4 of which the prose already caught. The
 *   fifth (`444635860`) is a genuine one-bedder with an ensuite and a main
 *   bathroom.
 * - rent below half the target matched 10, all 10 already caught by prose — and
 *   `suspiciously_cheap` already flags exactly that band, so repeating it here
 *   would say nothing new.
 *
 * Nothing here drops a listing. The flag is the output, and the site decides
 * what to do with it — same principle as every other failing listing in the
 * pipeline, and the reason price history and relist tracking keep working.
 */

/**
 * Rooms that are part of a dwelling and never an offer of a room to rent.
 * `lounge room`, `laundry room`, `study room` and friends are what make a bare
 * "room" match useless, so every room pattern below excludes them explicitly.
 */
const HOUSE_PART_ROOM = String.raw`(?:lounge|living|dining|laundry|storage|study|media|rumpus|utility|bike|sun|games|mud|powder|bath|bed|family|meals|store|drying|plant|theatre|guest|linen|box|court|club|common|parcel|mail)`

/**
 * Up to two adjectives between "shared" and the noun — real listings write
 * "shared modern kitchen" and "shared fully tiled bathroom".
 *
 * Two things keep it from over-reaching. The separator class excludes `.`, so a
 * sentence boundary stops the match ("shared garden area. Kitchen features…" is
 * not a shared kitchen). And no amenity noun may appear in the gap, so "five
 * shared bathrooms full kitchen" is one signal about bathrooms rather than two,
 * and each signal quotes the phrase it is actually about.
 */
const AMENITY_NOUN = String.raw`(?:kitchens?|bathrooms?|laundr(?:y|ies)|bedrooms?|toilets?|yards?|gardens?|pools?|terraces?|lounges?|balcon(?:y|ies))`
const UP_TO_TWO_ADJECTIVES = String.raw`(?:(?!${AMENITY_NOUN}\b)\w+[\s,-]+){0,2}`

/**
 * Each entry is sufficient on its own. They are named rather than anonymous so
 * a flagged listing can say why, and so `npm run check:shares` can be read
 * against a capture before the classifier is trusted.
 */
const ROOM_SIGNALS: [string, RegExp][] = [
  // No kitchen or bathroom of your own — the dwelling is not self-contained.
  [
    'shared_kitchen',
    new RegExp(String.raw`\b(?:shar(?:e|ed|ing)|communal|common)\s+${UP_TO_TWO_ADJECTIVES}kitchen`, 'i'),
  ],
  [
    'shared_bathroom',
    new RegExp(String.raw`\b(?:shar(?:e|ed|ing)|communal|common)\s+${UP_TO_TWO_ADJECTIVES}bathroom`, 'i'),
  ],
  ['shared_facilities', /\bshar(?:e|ed|ing)\s+(?:the\s+)?(?:facilit|amenit)/i],
  ['share_house', /\bshar(?:e|ed)[-\s]?(?:house|home|apartment|accommodation)\b/i],
  ['co_living', /\bco[-\s]?living\b/i],
  ['boarding_house', /\b(?:boarding\s*house|hostel|dormitor)/i],

  // The ad prices or offers a room rather than the property.
  ['per_room', /\bper\s+room\b/i],
  ['per_person', /\bper\s+person\b/i],
  ['room_rent', /\broom\s+rent\b|\beach\s+room\s+(?:rent|from|is|costs?|\$)/i],
  ['room_only', /\broom\s+only\b/i],
  ['room_for_rent', /\brooms?\s+(?:for|to)\s+(?:rent|lease)\b/i],
  ['rooms_available', /\b(?:\d{1,2}\s+)?rooms?\s+(?:are\s+)?(?:still\s+)?available\b/i],
  ['private_room', /\bprivate\s+room\b|\broom\s+type\s*:/i],
  ['lockable_room', /\block(?:able|ed)\s+(?:private\s+)?rooms?\b|\bprivate\s+lockable\b/i],
  ['master_room', /\bmaster\s+room\b/i],
  ['flatmate', /\b(?:flat\s?mates?|house\s?mates?|room\s?mates?)\b/i],
  ['n_rooms', /\bconsists?\s+of\s+\d{1,2}\s+rooms\b|\b\d{1,2}\s+rooms\s+in\s+total\b/i],
  [
    'offered_room',
    new RegExp(
      String.raw`\b(?:furnished|affordable|single|spacious|quiet|renovated|air[\s-]?conditioned|well[\s-]?presented|extra[\s-]?large|master|double)\s+(?!${HOUSE_PART_ROOM}\b)rooms?\b`,
      'i',
    ),
  ],
]

/** REA carries the unit number in the address, and a room let writes it `Room2/50 Frederick St`. */
const ROOM_ADDRESS = /^\s*(?:room|rm)\s*\.?\s*\d/i

/** A five-bedroom house does not rent for under $500 a week. One of its bedrooms does. */
const SHARED_HOUSE_MIN_BEDS = 5
const SHARED_HOUSE_MAX_PW = 500

/**
 * Strip REA's markup before matching. Descriptions arrive as `<br/>` soup with
 * the occasional entity, and a signal split across `shared<br/>kitchen` would
 * otherwise be invisible.
 */
function descriptionText(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export interface RoomSignal {
  signal: string
  /** The words that matched, so a human can disagree with the classifier. */
  quote: string
}

/** A little context either side, so `shared laundry` and `shared kitchen` read differently. */
const QUOTE_CONTEXT = 30

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - QUOTE_CONTEXT)
  const end = Math.min(text.length, index + length + QUOTE_CONTEXT)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/**
 * Every reason to think this listing is a room rather than a whole dwelling,
 * each with the text that triggered it.
 *
 * Takes the raw `ReaListing` because the evidence is usually in the full
 * `description`, and a run only keeps the first 500 characters of it — in the
 * 2026-08-24 capture 24 listings carry their only signal past that cut. A
 * downstream check against `description_snippet` would miss them.
 */
export function roomSignalEvidence(listing: ReaListing): RoomSignal[] {
  const text = descriptionText(listing.description ?? '')
  const found: RoomSignal[] = []

  for (const [signal, pattern] of ROOM_SIGNALS) {
    const match = pattern.exec(text)
    if (match) found.push({ signal, quote: quoteAround(text, match.index, match[0].length) })
  }

  if (ROOM_ADDRESS.test(listing.address)) {
    found.push({ signal: 'room_address', quote: listing.address })
  }

  const price = parseRentPerWeek(listing.price)
  if (
    (listing.bedrooms ?? 0) >= SHARED_HOUSE_MIN_BEDS &&
    price !== null &&
    price < SHARED_HOUSE_MAX_PW
  ) {
    found.push({ signal: 'beds_vs_price', quote: `${listing.bedrooms} bedrooms at ${listing.price}` })
  }

  return found
}

/** Just the signal names, in a stable order — what a run stores. Empty means a whole dwelling. */
export function roomListingSignals(listing: ReaListing): string[] {
  return roomSignalEvidence(listing).map((found) => found.signal)
}

import type { AreaSource, PropertyType, Travel } from 'sydney-rental-schema'

/**
 * The normalised listing shape the run pipeline works in.
 *
 * This is deliberately *not* the capture format. A capture holds whatever the
 * MCP server returned, verbatim (see `lib/rea.ts`); this is what that becomes
 * once interpreted. Keeping the two apart is what lets a mapping bug be fixed
 * and replayed against the same capture instead of re-searching REA.
 */
export interface RawListing {
  /** REA listing id, as a string. The ledger key and the image folder name. */
  id: string
  url: string
  address: string
  suburb: string
  postcode: string
  state: string

  /** Null in practice — REA publishes no coordinates. Flags `no_latlon`. */
  lat: number | null
  lon: number | null

  /** Null for "contact agent" and anything else without a plausible weekly figure. */
  price_pw: number | null
  /** Verbatim REA price text, kept so a human can see what we could not parse. */
  price_display: string

  beds: number
  baths: number
  car_spaces: number

  area_sqm: number | null
  area_source: AreaSource | null

  property_type: PropertyType
  available_date: string | null
  bond: number | null

  features: string[]
  /** Full listing description; truncated to the 500-char snippet by the build script. */
  description: string

  /**
   * Why this looks like a room in a share house rather than a whole dwelling —
   * empty when it does not. See `roomListingSignals` in `lib/rea.ts`; the build
   * script turns a non-empty list into the `share_house` flag.
   */
  share_signals: string[]

  /**
   * Routed times by `<origin-id>:<mode>`, merged across every query pass that
   * returned this listing. A missing key means unroutable, which a search reads
   * as "does not match" rather than "close".
   */
  travel: Record<string, Travel>

  /** Photo URLs in listing order — hero first, already resolution-corrected. */
  image_urls: string[]
  /** Optional per-listing editorial from the agent, in the Markdown subset (see AGENT.md). */
  agent_notes: string
}

/** `Air Conditioning` / `air-conditioning` → `air_conditioning` (§3.4). */
export function normaliseFeature(feature: string): string {
  return feature
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** `Marrickville` + `2204` → `marrickville-2204`, the suburb key and route param. */
export function suburbKey(suburb: string, postcode: string): string {
  const slug = suburb
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug}-${postcode}`
}

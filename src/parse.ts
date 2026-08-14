import type { Channel, Listing, ListingDetail, SearchResult } from "./types.js";

/**
 * REA server-renders the page, then hands the client a hydration blob:
 *
 *   <script>window.ArgonautExchange={"resi-property_listing-experience-web":{
 *     "urqlClientCache":"{\"<hash>\":{\"data\":\"{...}\"}}"}}</script>
 *
 * That inner `data` string is the raw Lexa GraphQL response — the same payload
 * the walled-off lexa.realestate.com.au/graphql endpoint would return.
 *
 * IMPORTANT: the app deletes `window.ArgonautExchange` once it has hydrated, so
 * reading the live global gives `undefined` on a page that loaded perfectly.
 * Always parse the <script> tag's source text, which is what we do here.
 */

const ARGONAUT_RE = /window\.ArgonautExchange\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:window\.|<\/script>|$)/;
const IMAGE_SIZE = "1024x768";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

function extractArgonaut(html: string): unknown {
  const m = html.match(ARGONAUT_RE);
  if (!m) throw new ParseError("no ArgonautExchange blob in page (layout may have changed)");
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new ParseError(`ArgonautExchange present but unparseable: ${(e as Error).message}`);
  }
}

/** Yield every decoded GraphQL `data` payload nested in the exchange blob. */
function* graphqlPayloads(exchange: unknown): Generator<Record<string, unknown>> {
  if (!exchange || typeof exchange !== "object") return;
  for (const node of Object.values(exchange as Record<string, unknown>)) {
    if (!node || typeof node !== "object") continue;
    for (const raw of Object.values(node as Record<string, unknown>)) {
      if (typeof raw !== "string") continue;
      let cache: Record<string, { data?: unknown }>;
      try {
        cache = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const entry of Object.values(cache)) {
        if (typeof entry?.data !== "string") continue;
        try {
          yield JSON.parse(entry.data);
        } catch {
          /* skip malformed entry */
        }
      }
    }
  }
}

interface SearchNode {
  results?: {
    /** Listings in the searched locality. */
    exact?: { items?: unknown[] };
    /** Listings REA blended in from neighbouring suburbs. Always present. */
    surrounding?: { items?: unknown[] };
    pagination?: { maxPageNumberAvailable?: number };
    totalResultsCount?: number;
  };
}

/** Find the `{buy,rent,sold}Search` node regardless of which key it landed under. */
function findSearchNode(payload: Record<string, unknown>): SearchNode | null {
  for (const [key, value] of Object.entries(payload)) {
    if (!value || typeof value !== "object") continue;
    if (/Search$/.test(key) && (value as SearchNode).results) return value as SearchNode;
  }
  // Fall back to a shallow walk — key naming has changed before.
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object" && (value as SearchNode).results?.exact?.items) {
      return value as SearchNode;
    }
  }
  return null;
}

const num = (v: unknown): number | undefined =>
  typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "number"
    ? ((v as { value: number }).value)
    : undefined;

/**
 * `sizeUnit` is sometimes a plain string ("m²") and sometimes an object with a
 * display field, so naive concatenation yields "108[object Object]".
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const formatSize = (size: any): string | undefined => {
  const value = size?.displayValue;
  if (value == null || value === "") return undefined;
  const unit = size.sizeUnit;
  const unitText =
    typeof unit === "string" ? unit : (unit?.displayValue ?? unit?.display ?? unit?.value ?? "m²");
  return `${value}${unitText}`;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const templated = (v: unknown): string | undefined => {
  const url = (v as { templatedUrl?: string } | undefined)?.templatedUrl;
  return url ? url.replace("{size}", IMAGE_SIZE) : undefined;
};

/**
 * Building coordinates. REA has moved these around between schema versions, so
 * probe the known shapes rather than trusting one path. Without these the whole
 * travel-time feature silently degrades to nothing, so it is worth being liberal.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const coords = (addr: any, listing: any): { lat: number; lng: number } | undefined => {
  const candidates = [
    addr?.location,
    addr?.geolocation,
    addr?.coordinates,
    listing?.location,
    listing?.geolocation,
  ];
  for (const c of candidates) {
    const lat = Number(c?.latitude ?? c?.lat);
    const lng = Number(c?.longitude ?? c?.lon ?? c?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      return { lat, lng };
    }
  }
  return undefined;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normaliseListing(raw: any): Listing {
  const g = raw?.listing ?? raw;
  const addr = g?.address ?? {};
  const feat = g?.generalFeatures ?? {};
  const sizes = g?.propertySizes ?? {};

  return {
    id: String(g?.id ?? ""),
    url: g?._links?.canonical?.href,
    address: addr?.display?.fullAddress ?? addr?.display?.shortAddress ?? "",
    suburb: addr?.suburb,
    state: addr?.state,
    postcode: addr?.postcode,
    price: g?.price?.display ?? g?.price?.information ?? "",
    propertyType: g?.propertyType?.display,
    bedrooms: num(feat?.bedrooms),
    bathrooms: num(feat?.bathrooms),
    carSpaces: num(feat?.parkingSpaces),
    studies: num(feat?.studies),
    landSize: formatSize(sizes?.land),
    buildingSize: formatSize(sizes?.building),
    agency: g?.listingCompany
      ? {
          name: g.listingCompany.name,
          id: g.listingCompany.id,
          avgRating: g.listingCompany.ratingsReviews?.avgRating,
          totalReviews: g.listingCompany.ratingsReviews?.totalReviews,
        }
      : undefined,
    agents: Array.isArray(g?.listers)
      ? g.listers.map((l: any) => ({
          name: l?.name,
          jobTitle: l?.jobTitle,
          profileUrl: l?._links?.canonical?.href?.replace("?cid={cid}", ""),
        }))
      : undefined,
    inspections: Array.isArray(g?.inspections)
      ? g.inspections.map((i: any) => ({
          start: i?.startTime,
          end: i?.endTime,
          label: i?.display?.longLabel,
        }))
      : undefined,
    auction: g?.auction?.dateTime
      ? { dateTime: g.auction.dateTime.value, label: g.auction.dateTime.display?.longLabel }
      : undefined,
    description: g?.description,
    images: Array.isArray(g?.media?.images)
      ? g.media.images.map(templated).filter(Boolean)
      : undefined,
    floorplans: Array.isArray(g?.media?.floorplans)
      ? g.media.floorplans.map(templated).filter(Boolean)
      : undefined,
    soldPrice: g?.price?.display && g?.__typename?.includes("Sold") ? g.price.display : undefined,
    soldDate: g?.dateSold?.value ?? g?.dateSold?.display,
    coords: coords(addr, g),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function parseSearchPage(
  html: string,
  meta: { channel: Channel; location: string; page: number; sourceUrl: string },
): SearchResult {
  const exchange = extractArgonaut(html);

  for (const payload of graphqlPayloads(exchange)) {
    const node = findSearchNode(payload);
    const exact = node?.results?.exact?.items;
    if (!exact) continue;

    // REA splits every page into the searched suburb plus neighbouring ones.
    // Reading only `exact` silently drops up to two-thirds of a page.
    const surrounding = node?.results?.surrounding?.items ?? [];
    const listings = [
      ...exact.map((i) => normaliseListing(i)),
      ...surrounding.map((i) => ({ ...normaliseListing(i), isSurrounding: true })),
    ];

    return {
      ...meta,
      totalResults: node?.results?.totalResultsCount,
      totalPages: node?.results?.pagination?.maxPageNumberAvailable,
      listings,
    };
  }
  throw new ParseError("ArgonautExchange found but no search results node inside it");
}

/**
 * Detail pages use a different payload shape to search pages: the listing sits
 * at `details.listing`, alongside REA's own comparables and suburb stats.
 */
export function parseListingPage(html: string): ListingDetail {
  const exchange = extractArgonaut(html);

  for (const payload of graphqlPayloads(exchange)) {
    const details = (payload as { details?: Record<string, unknown> }).details;
    if (!details?.listing) continue;

    const related = details.relatedListings;
    return {
      ...normaliseListing(details.listing),
      recentSales: details.recentSales ?? undefined,
      marketInsights: details.marketInsights ?? undefined,
      relatedListingIds: Array.isArray(related)
        ? related.map((r: unknown) => String((r as { id?: unknown })?.id ?? "")).filter(Boolean)
        : undefined,
    };
  }

  // Fallback: some page variants nest the listing without a `details` wrapper.
  for (const payload of graphqlPayloads(exchange)) {
    for (const value of Object.values(payload)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const candidate = (v.listing ?? v) as Record<string, unknown>;
      if (candidate.id && candidate.address) {
        const listing = normaliseListing(candidate);
        if (listing.id) return listing;
      }
    }
  }
  throw new ParseError("no listing found in page");
}

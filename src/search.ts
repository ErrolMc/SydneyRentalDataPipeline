import type { Channel, LocationSuggestion, SearchParams } from "./types.js";

const BASE = "https://www.realestate.com.au";

/**
 * REA encodes filters as path segments, not query params:
 *
 *   /buy/property-house-with-3-bedrooms-between-500000-1000000-in-bondi,+nsw+2026/list-2
 *    ^ch  ^types          ^beds            ^price range        ^location        ^page
 *
 * Segment order matters — the site 404s or silently drops filters if reordered.
 */

/** "Bondi, NSW 2026" -> "bondi,+nsw+2026" */
export function slugLocation(location: string): string {
  return location.trim().toLowerCase().replace(/\s+/g, "+");
}

export function buildSearchUrl(p: SearchParams): string {
  const parts: string[] = [];

  if (p.propertyTypes?.length) {
    parts.push(`property-${p.propertyTypes.map((t) => t.toLowerCase()).join("-")}`);
  }
  if (p.minBedrooms != null) {
    parts.push(`with-${p.minBedrooms}-bedrooms`);
  }
  if (p.minBathrooms != null) {
    parts.push(`${p.minBathrooms}-bathrooms`);
  }
  if (p.minCarSpaces != null) {
    parts.push(`${p.minCarSpaces}-car-spaces`);
  }
  if (p.minPrice != null || p.maxPrice != null) {
    // REA requires both ends; "any" is the open end.
    const lo = p.minPrice ?? 0;
    const hi = p.maxPrice ?? "any";
    parts.push(`between-${lo}-${hi}`);
  }
  if (p.minLandSize != null) {
    parts.push(`size-${p.minLandSize}-any`);
  }

  parts.push(`in-${slugLocation(p.location)}`);

  const page = Math.max(1, p.page ?? 1);
  const path = `/${p.channel}/${parts.join("-")}/list-${page}`;

  const q = new URLSearchParams();
  const misc: string[] = [];
  if (p.excludeUnderContract) misc.push("ex-under-contract");
  if (p.furnished) misc.push("furnished");
  if (p.petsAllowed) misc.push("pets-allowed");
  if (misc.length) q.set("misc", misc.join(","));
  if (p.surroundingSuburbs === false) q.set("includeSurrounding", "false");
  if (p.channel === "sold" && p.soldWithinMonths) {
    q.set("activeSort", "solddate");
  }

  const qs = q.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

export function buildListingUrl(idOrUrl: string): string {
  if (/^https?:\/\//.test(idOrUrl)) return idOrUrl.split("?")[0];
  // A bare id at the root 301s to the canonical /property-{type}-{state}-{suburb}-{id}
  // slug. Note /property/{id} is NOT the same thing — that path 404s.
  return `${BASE}/${idOrUrl.replace(/\D/g, "")}`;
}

/**
 * The one REA endpoint that is NOT behind Kasada. Plain HTTPS, no browser
 * needed, ~50ms. Use it to turn vague user input into a canonical location
 * string before building a search URL.
 */
export async function suggestLocations(
  query: string,
  max = 7,
): Promise<LocationSuggestion[]> {
  const url =
    `https://suggest.realestate.com.au/consumer-suggest/suggestions` +
    `?max=${max}&type=suburb,region,precinct,state,postcode&src=homepage-web` +
    `&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`suggest API returned ${res.status}`);

  const json = (await res.json()) as {
    _embedded?: { suggestions?: Array<Record<string, any>> };
  };
  return (json._embedded?.suggestions ?? []).map((s) => ({
    id: String(s.id ?? ""),
    text: s.display?.text ?? "",
    type: String(s.type ?? ""),
    name: s.source?.name,
    state: s.source?.state,
    postcode: s.source?.postcode,
  }));
}

export const CHANNELS: Channel[] = ["buy", "rent", "sold"];

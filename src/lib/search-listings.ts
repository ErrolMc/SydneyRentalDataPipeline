import { z } from "zod";

import type { MislabelledTravel } from "sydney-rental-schema";

import { fetchPage } from "../browser.js";
import { enrichWithTravel, type MislabelledWalk, type TravelMode } from "../distance.js";
import { parseSearchPage } from "../parse.js";
import { buildSearchUrl } from "../search.js";
import type { Channel, Listing, SearchParams, SearchResult } from "../types.js";
import { toMislabelled } from "./route-places.js";

/**
 * `search_listings` as a plain function.
 *
 * This was the body of the MCP tool handler. It is a module of its own so the
 * pipeline's capture step can call it in-process instead of spawning this
 * server and speaking JSON-RPC to it over stdio (MIGRATION.md, Step 3). The
 * MCP adapter still registers the tool — with `SearchListingsInput.shape` as
 * its input schema — and calls this.
 *
 * The input is parsed here, not only at the MCP boundary, because the body
 * leans on the schema's defaults: `channel` in particular is used undefaulted
 * further down, and the SDK used to fill it in before the handler ran. Parsing
 * in one place means both callers see the same `buy` / page 1 / walk.
 */
export const SearchListingsInput = z.object({
  location: z
    .string()
    .describe('Suburb/postcode/region, e.g. "Bondi, NSW 2026" or "Richmond, VIC 3121"'),
  channel: z
    .enum(["buy", "rent", "sold"])
    .default("buy")
    .describe("buy = for sale, rent = rentals, sold = recently sold"),
  page: z.number().int().min(1).max(50).default(1),
  minPrice: z.number().optional().describe("AUD. For rent this is weekly rent."),
  maxPrice: z.number().optional().describe("AUD. For rent this is weekly rent."),
  minBedrooms: z.number().int().min(0).max(10).optional(),
  minBathrooms: z.number().int().min(0).max(10).optional(),
  minCarSpaces: z.number().int().min(0).max(10).optional(),
  minLandSize: z.number().optional().describe("Square metres"),
  propertyTypes: z
    .array(z.enum(["house", "apartment", "townhouse", "villa", "land", "acreage", "unitblock"]))
    .optional(),
  excludeUnderContract: z.boolean().optional(),
  travelFrom: z
    .string()
    .optional()
    .describe(
      'Origin for real routed travel times, e.g. "275 Kent St, Sydney NSW 2000" or a ' +
        'bare "-33.8665,151.2045". Every listing gains a `travel` field with actual ' +
        "routed minutes and km — not straight-line distance, and `coords`, which " +
        "search results otherwise never carry. Requests are batched and cached on " +
        "disk, so repeat searches are free.",
    ),
  travelMode: z
    .enum(["walk", "drive", "transit"])
    .default("walk")
    .describe(
      "transit is real public-transport time from the timetable, not road distance. " +
        "It needs GOOGLE_MAPS_API_KEY and a `travelArriveBy`.",
    ),
  travelArriveBy: z
    .string()
    .optional()
    .describe(
      'RFC 3339 moment to arrive by, e.g. "2026-08-25T09:00:00+10:00". Required for ' +
        "travelMode:transit and ignored otherwise — the same trip takes a different " +
        "time on a Tuesday morning and a Sunday night, so there is no sensible default.",
    ),
  maxTravelMinutes: z
    .number()
    .optional()
    .describe(
      "Drop listings further than this from `travelFrom`. Listings that could not " +
        "be routed are kept and reported, never silently discarded. What this DOES " +
        "drop comes back under `filteredByTravel` — id, address and routed time only " +
        "— so a caller keeping its own records can remember the rejection instead of " +
        "paying to geocode and route the same listing again next time.",
    ),
  sortByTravel: z
    .boolean()
    .default(false)
    .describe("Sort nearest-first. Unroutable listings sort last."),
});

export type SearchListingsArgs = z.input<typeof SearchListingsInput>;

/**
 * Translate the one camelCase shape `enrichWithTravel` leaves behind.
 *
 * `enrichWithTravel` is generic over `Locatable`, so its writes are checked
 * against `distance.ts`'s own `Travel` and never against the listing type they
 * land on — a `Listing.travel` that does not declare `mislabelled` at all still
 * receives one. Nothing downstream reads it in TypeScript, so the mismatch is
 * invisible until `ReaCaptureSchema` parses the capture back and rejects
 * `impliedKmh` where it wants `implied_kmh`.
 *
 * This is the boundary where a routed answer becomes a listing, so the
 * translation belongs here for the reason route-places.ts's header gives:
 * distance.ts speaks camelCase, everything downstream is snake_case, and
 * neither side should change to suit the other.
 *
 * Run in place and before `maxTravelMinutes` splits the array, so the rejects
 * recorded in `filteredByTravel` — which is where all 59 of them were in the
 * 2026-09-03 walk capture — carry the same shape as the ones kept.
 */
export function normaliseMislabelled(listings: readonly Listing[]): void {
  for (const listing of listings) {
    const travel = listing.travel as ({ mislabelled?: MislabelledWalk } & object) | null | undefined;
    const evidence = travel?.mislabelled;
    // Keyed off the camelCase field rather than a boolean, so running twice
    // cannot turn a translated shape back into an untranslated one — reading
    // `impliedKmh` off an already-translated object yields `undefined`, which
    // would produce a `mislabelled` the schema rejects for a different reason.
    if (!evidence || !("impliedKmh" in evidence)) continue;
    (travel as { mislabelled?: MislabelledTravel }).mislabelled = toMislabelled(evidence);
  }
}

/**
 * Search realestate.com.au, optionally with routed travel times from `travelFrom`.
 * Throws on a failed fetch or a bot block; a routing outage is reported inside
 * the result instead, so it never costs the caller the listings.
 */
export async function searchListings(input: SearchListingsArgs): Promise<SearchResult> {
  const params = SearchListingsInput.parse(input) as unknown as SearchParams;
  const url = buildSearchUrl(params);
  const { html } = await fetchPage(url);
  const result = parseSearchPage(html, {
    channel: params.channel as Channel,
    location: params.location,
    page: params.page ?? 1,
    sourceUrl: url,
  });

  if (params.travelFrom) {
    const mode: TravelMode = params.travelMode ?? "walk";
    try {
      const report = await enrichWithTravel(
        result.listings,
        params.travelFrom,
        mode,
        params.travelArriveBy,
      );

      normaliseMislabelled(result.listings);

      if (params.maxTravelMinutes != null) {
        const limit = params.maxTravelMinutes;
        const before = result.listings.length;
        // Only listings with a KNOWN time over the limit are dropped —
        // an unknown is not evidence of being far away.
        const kept: typeof result.listings = [];
        const dropped: typeof result.listings = [];
        for (const l of result.listings) {
          (l.travel == null || l.travel.minutes <= limit ? kept : dropped).push(l);
        }
        result.listings = kept;
        // What was dropped, small enough to be worth remembering.
        //
        // These were geocoded and routed at real cost, and dropping them
        // silently meant that cost could only be remembered in the server's
        // own cache — a store the caller cannot see, version or review. Sent
        // back as identity and position only: enough to write down, far
        // short of the full listing, which would make every search result
        // several times larger for a caller that only wanted the matches.
        result.filteredByTravel = dropped.map((l) => ({
          id: l.id,
          url: l.url,
          address: l.address,
          suburb: l.suburb,
          state: l.state,
          postcode: l.postcode,
          coords: l.coords,
          travel: l.travel,
        }));
        report.notes = [
          ...(report.notes ?? []),
          `filtered to <=${limit} min ${mode}: ${before} -> ${result.listings.length}`,
        ];
      }

      if (params.sortByTravel) {
        result.listings.sort(
          (a, b) => (a.travel?.minutes ?? Infinity) - (b.travel?.minutes ?? Infinity),
        );
      }

      result.travelReport = report;
    } catch (e) {
      // A routing outage must not cost the user their search results.
      result.travelReport = {
        error: `travel times unavailable: ${(e as Error).message}`,
        listingsReturnedWithoutTravel: result.listings.length,
      };
    }
  }

  return result;
}

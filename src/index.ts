#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { closeContext, fetchPage, NotWarmError } from "./browser.js";
import { parseListingPage, parseSearchPage } from "./parse.js";
import { buildListingUrl, buildSearchUrl, suggestLocations } from "./search.js";
import { fetchImages, IMAGE_SIZES } from "./images.js";
import { enrichWithTravel, type TravelMode } from "./distance.js";
import type { Channel, SearchParams } from "./types.js";
import { runSetup } from "./cli.js";

// `realestate-mcp setup` shares this binary so users only learn one command.
if (process.argv[2] === "setup") {
  await runSetup();
  process.exit(0);
}

const server = new McpServer({ name: "realestate-mcp", version: "0.1.0" });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/** Map thrown errors onto messages the model can act on rather than stack traces. */
function explain(e: unknown): string {
  if (e instanceof NotWarmError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/Executable doesn't exist|channel/.test(msg)) {
    return (
      `Could not launch Google Chrome. This server drives your real Chrome install ` +
      `(bundled Chromium gets blocked).\nInstall Chrome, or set REALESTATE_MCP_CHANNEL ` +
      `to "msedge".\n\nUnderlying error: ${msg}`
    );
  }
  return msg;
}

server.registerTool(
  "search_listings",
  {
    title: "Search realestate.com.au listings",
    description:
      "Search realestate.com.au for properties to buy, rent, or recently sold. " +
      "Returns up to 25 listings per page with address, price, bed/bath/car counts, " +
      "land size, agency, agents, inspection times and auction dates. " +
      "Call resolve_location first if the user's location is vague or misspelled.",
    inputSchema: {
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
            "routed minutes and km — not straight-line distance. Requests are batched " +
            "(one per 45 listings) and cached on disk, so repeat searches are free.",
        ),
      travelMode: z.enum(["walk", "drive"]).default("walk"),
      maxTravelMinutes: z
        .number()
        .optional()
        .describe(
          "Drop listings further than this from `travelFrom`. Listings that could not " +
            "be routed are kept and reported, never silently discarded.",
        ),
      sortByTravel: z
        .boolean()
        .default(false)
        .describe("Sort nearest-first. Unroutable listings sort last."),
    },
  },
  async (args) => {
    const params = args as unknown as SearchParams;
    const url = buildSearchUrl(params);
    try {
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
          const report = await enrichWithTravel(result.listings, params.travelFrom, mode);

          if (params.maxTravelMinutes != null) {
            const limit = params.maxTravelMinutes;
            const before = result.listings.length;
            // Only listings with a KNOWN time over the limit are dropped —
            // an unknown is not evidence of being far away.
            result.listings = result.listings.filter(
              (l) => l.travel == null || l.travel.minutes <= limit,
            );
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

      return ok(result);
    } catch (e) {
      return fail(explain(e));
    }
  },
);

server.registerTool(
  "get_listing",
  {
    title: "Get a single listing",
    description:
      "Fetch full detail for one realestate.com.au listing, including the complete " +
      "description, all photos, floorplans, agency and agent contacts. " +
      "Accepts a listing URL or a bare numeric listing ID.",
    inputSchema: {
      listing: z
        .string()
        .describe('Full URL or numeric ID, e.g. "151132896" or a realestate.com.au property URL'),
    },
  },
  async ({ listing }) => {
    const url = buildListingUrl(listing);
    try {
      const { html } = await fetchPage(url);
      return ok(parseListingPage(html));
    } catch (e) {
      return fail(explain(e));
    }
  },
);

server.registerTool(
  "get_listing_photos",
  {
    title: "Get listing photos",
    description:
      "Fetch the actual photographs for a listing as images, so they can be looked at " +
      "and judged directly — condition, style, natural light, renovation quality, " +
      "how a room is laid out, whether furniture would fit. " +
      "Use this when the question is about how a place LOOKS rather than its numbers. " +
      "Costs roughly 400 tokens per image at the default size, so keep `limit` small " +
      "and raise `size` only when fine detail matters. Set `includeFloorplan` to judge layout.",
    inputSchema: {
      listing: z.string().describe("Listing URL or numeric ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(6)
        .describe("How many photos to return. Keep low — each one costs context."),
      size: z
        .enum(IMAGE_SIZES)
        .default("640x480")
        .describe("Larger sizes cost proportionally more tokens"),
      includeFloorplan: z
        .boolean()
        .default(false)
        .describe("Prepend the floorplan, when the listing has one"),
    },
  },
  async ({ listing, limit, size, includeFloorplan }) => {
    try {
      const { html } = await fetchPage(buildListingUrl(listing));
      const detail = parseListingPage(html);

      const urls = [
        ...(includeFloorplan ? (detail.floorplans ?? []) : []),
        ...(detail.images ?? []),
      ];
      if (!urls.length) return fail(`No photos published for ${detail.address || listing}.`);

      const images = await fetchImages(urls, size, limit);
      if (!images.length) return fail("Found photo URLs but none could be downloaded.");

      const kb = Math.round(images.reduce((a, b) => a + b.bytes, 0) / 1024);
      const header =
        `${detail.address}\n${detail.price} — ${detail.bedrooms}bd ${detail.bathrooms}ba ` +
        `${detail.carSpaces ?? 0}car${detail.buildingSize ? ` — ${detail.buildingSize}` : ""}\n` +
        `${images.length} of ${urls.length} images at ${size} (${kb}KB)` +
        (includeFloorplan && detail.floorplans?.length ? " — first image is the floorplan" : "");

      return {
        content: [
          { type: "text" as const, text: header },
          ...images.map((i) => ({
            type: "image" as const,
            data: i.data,
            mimeType: i.mimeType,
          })),
        ],
      };
    } catch (e) {
      return fail(explain(e));
    }
  },
);

server.registerTool(
  "resolve_location",
  {
    title: "Resolve a location",
    description:
      "Turn partial or ambiguous location text into canonical REA suburb/region names " +
      "with state and postcode. Fast (no browser needed). Use this to disambiguate " +
      'before search_listings — e.g. "bondi" returns Bondi, Bondi Beach, Bondi Junction.',
    inputSchema: {
      query: z.string().describe('Partial location, e.g. "bondi" or "3121"'),
      max: z.number().int().min(1).max(20).default(7),
    },
  },
  async ({ query, max }) => {
    try {
      return ok(await suggestLocations(query, max));
    } catch (e) {
      return fail(explain(e));
    }
  },
);

const shutdown = async () => {
  await closeContext();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());

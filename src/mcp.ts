// Must stay first: fills process.env from `.env` before the modules below read
// it at import time. See src/env.ts. (`dist/cli.js mcp` imports this module;
// it also loads env first, so the order here is belt and braces.)
import "./env.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { closeContext, fetchPage, NotWarmError } from "./browser.js";
import { parseListingPage } from "./parse.js";
import { buildListingUrl, suggestLocations } from "./search.js";
import { fetchImages, IMAGE_SIZES } from "./images.js";
import { searchListings, SearchListingsInput } from "./lib/search-listings.js";

/**
 * The MCP adapter: what Claude Code talks to. Interactive use only —
 * `search_listings` for ad-hoc questions and `get_listing` for the run
 * protocol's absence-resolution step. The pipeline itself calls the same
 * functions in-process (src/lib/tools.ts); `geocode_places` and
 * `route_places` were only ever called by it, so they are no longer tools.
 */
const server = new McpServer({ name: "sydney-rental-data-pipeline", version: "0.1.0" });

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
    inputSchema: SearchListingsInput.shape,
  },
  async (args) => {
    try {
      return ok(await searchListings(args));
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

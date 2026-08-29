#!/usr/bin/env node
// Must stay first: fills process.env from `.env` before the modules below read
// it at import time. See src/env.ts.
import "./env.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { closeContext, fetchPage, NotWarmError } from "./browser.js";
import { parseListingPage } from "./parse.js";
import { buildListingUrl, suggestLocations } from "./search.js";
import { fetchImages, IMAGE_SIZES } from "./images.js";
import { geocodePlaces, routePlaces, type TravelMode } from "./distance.js";
import { searchListings, SearchListingsInput } from "./lib/search-listings.js";
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

server.registerTool(
  "geocode_places",
  {
    title: "Coordinates for many place names",
    description:
      "Turn place names or addresses into coordinates — suburbs, streets, buildings. " +
      "Different from resolve_location, which returns canonical REA suburb NAMES and no " +
      "position at all; use that one to disambiguate before searching, and this one when " +
      "you need somewhere on a map. Goes through the same provider chain and the same " +
      "disk cache as travel measurement, so a position asked for twice costs one call, " +
      "and each result says which provider actually answered rather than which was " +
      "configured. `precision` is load-bearing: `area` means a locality centroid, which " +
      "is the right answer for a suburb and the wrong thing to quote as a property's " +
      "position. Anything nothing can place comes back under `unresolved` — never a " +
      "guessed coordinate.",
    inputSchema: {
      queries: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .describe(
          'Place names or addresses, e.g. "Balmain, NSW 2041, Australia" or ' +
            '"275 Kent Street, Sydney NSW 2000"',
        ),
      prefer: z
        .enum(["precise", "locality"])
        .default("precise")
        .describe(
          'What kind of point you want. "precise" takes the sharpest hit — right for an ' +
            'address. "locality" takes the suburb centroid and treats a sharper hit as the ' +
            'consolation prize — right for a place NAME, and not interchangeable: asking ' +
            'precisely for "Westleigh, NSW 2120" can return a street inside Westleigh, ' +
            "1.5km from its centre.",
        ),
    },
  },
  async ({ queries, prefer }) => {
    try {
      return ok(await geocodePlaces(queries, prefer === "locality"));
    } catch (e) {
      return fail(explain(e));
    }
  },
);

server.registerTool(
  "route_places",
  {
    title: "Routed time from many places to one destination",
    description:
      "Routed travel time from each of many coordinates to a single destination. " +
      "Built for deciding WHICH suburbs are worth searching, not for describing a " +
      "property: you supply the coordinates, so nothing is geocoded here. Measures " +
      "INTO the destination (the commute direction), which matters for transit — " +
      "arriving somewhere by 9am is not the same trip as leaving there at 9am. " +
      "Results are cached on disk and deduped, so re-asking is free. A suburb " +
      "centroid is an area-level position by nature: fine for picking a search " +
      "envelope, never quote it as a listing's commute. " +
      "With travelMode:transit each leg also carries a `journey` — the actual " +
      "sequence of walks and services with their product classes, service names " +
      "and stops, plus isWalk, hasFerry and interchanges. So you can tell a " +
      "ferry from a train from a 'transit' answer that is really just a walk, " +
      "instead of trusting the mode you asked for.",
    inputSchema: {
      places: z
        .array(
          z.object({
            id: z.string().describe("Your identifier, echoed back on the leg"),
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
          }),
        )
        .min(1)
        .max(1000)
        .describe("Origins to measure from"),
      destination: z
        .string()
        .describe('Address or bare "lat,lng", e.g. "275 Kent St, Sydney NSW 2000"'),
      travelMode: z.enum(["walk", "drive", "transit"]).default("walk"),
      travelArriveBy: z
        .string()
        .optional()
        .describe(
          'RFC 3339 moment to arrive by, e.g. "2026-08-25T09:00:00+10:00". Required for ' +
            "travelMode:transit and ignored otherwise.",
        ),
    },
  },
  async ({ places, destination, travelMode, travelArriveBy }) => {
    try {
      return ok(
        await routePlaces(
          places.map((p) => ({ id: p.id, coord: { lat: p.lat, lng: p.lng } })),
          destination,
          travelMode as TravelMode,
          travelArriveBy,
        ),
      );
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

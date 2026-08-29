/**
 * Real routed travel times from one origin to many listings.
 *
 * Why this exists: judging "is it walkable from work?" by eyeballing street
 * names is wrong in exactly the places it matters. Straight-line distance is
 * wrong too — Darling Harbour splits the Sydney CBD from Pyrmont, so a 700m
 * crow-flies gap is a 1.5km walk over Pyrmont Bridge. Only a real pedestrian
 * router gets that right.
 *
 * IMPORTANT — search results carry no coordinates. Verified empirically against
 * a live search page: `listing.address` holds only display/suburb/state/postcode,
 * and a deep scan for any lat/lng-shaped key across every GraphQL payload in the
 * hydration blob returns nothing — a 1 MB cached result page has zero occurrences
 * of "geocode" or "latitude". Since this module enriches *search* results, that
 * means positions have to be geocoded from the address string, which drives the
 * whole design here:
 *
 *  - **Deduped by building.** Unit numbers are stripped before geocoding, so the
 *    twenty listings inside 185-211 Broadway cost exactly one lookup.
 *  - **Cached on disk forever.** Buildings do not move. After the first search of
 *    an area the geocoder and router are barely touched again.
 *  - **Batched.** One matrix request per chunk of destinations, never one per
 *    listing.
 *  - **Precision is reported, never assumed.** A geocoder that falls back to a
 *    suburb centroid would silently reintroduce exactly the fake precision this
 *    module exists to remove, so every result carries how it was resolved.
 *  - **Never silently guessed.** Failures produce `travel: null` and a count in
 *    the report — never a straight line dressed up as a routed number.
 *
 * Detail pages are the exception: `address.display.geocode` carries an exact
 * building position, so `get_listing` returns real coordinates and needs none of
 * this. That costs one page fetch per listing, so it is an upgrade for a
 * shortlist, not a way to position a whole search.
 *
 * Routers (REALESTATE_MCP_ROUTER):
 *   valhalla (default) — FOSSGIS public instance, no API key
 *   ors                — OpenRouteService, needs ORS_API_KEY, 2000 calls/day
 *   google             — Routes API, needs GOOGLE_MAPS_API_KEY. The only one
 *                        that can do `transit`.
 * Valhalla and ORS model no traffic-light delay, so CBD walk times read a few
 * minutes optimistic. Treat them as good to about ±3 min, not to the minute.
 *
 * Geocoders (REALESTATE_MCP_GEOCODER): photon (default), nominatim, google.
 *
 * On choosing Google. It buys two things the free stack cannot: transit times
 * at all, and noticeably better precision on Australian unit addresses —
 * precision being what decides whether a number is measured or a suburb
 * centroid dressed up as one. It costs two things. Money past the free tier
 * (Compute Route Matrix Essentials: 10k elements/month free, then $5/1k;
 * Geocoding the same), and a caching limit: **Google's terms allow latitude and
 * longitude to be cached for at most 30 consecutive days**, where OSM data may
 * be kept forever. So Google-sourced geo entries carry a timestamp and expire;
 * OSM ones do not. That is a legal constraint, not a tuning knob — do not
 * "optimise" it away.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Coord {
  lat: number;
  lng: number;
}

/**
 * `transit` is answered by **TfNSW's Trip Planner** when `TFNSW_API_KEY` is set,
 * and by Google otherwise.
 *
 * This used to read "transit is Google-only — no free router does public
 * transport". That was wrong about the free part and, more importantly, about
 * what was being bought. Google's batched endpoint returns a duration and a
 * distance and no legs at any field mask, so `mode` was only ever the mode
 * *requested*, echoed back: a train, a ferry and a walk that Google answered a
 * transit question with were indistinguishable. TfNSW answers in legs with a
 * product class each, free, at 60,000 calls a day. See `tfnsw.ts`.
 *
 * Road modes never come here — no free router does public transport, but plenty
 * do roads, and they batch.
 */
export type TravelMode = "walk" | "drive" | "transit";

/**
 * How well the address resolved. `area` means the geocoder gave back a suburb or
 * locality centroid rather than the building — the time is indicative only.
 */
export type Precision = "building" | "street" | "area";

/**
 * The evidence that a measurement is not the mode it claims to be.
 *
 * Recorded rather than acted on: the answer still reports the minutes the
 * router gave, and this sits beside them saying what they really describe. A
 * caller that disagrees with the threshold can see exactly what it was.
 */
export interface MislabelledWalk {
  /** What the route actually does. Only ferries are detectable this way. */
  actually: "ferry";
  /** The routed speed that gave it away — `km ÷ hours`, as measured. */
  impliedKmh: number;
  /** What it had to beat, so a later change of threshold stays visible. */
  thresholdKmh: number;
  /** Confirmed against the timetable: a ferry serves this pair. */
  ferryAvailable: true;
}

export interface Travel {
  minutes: number;
  km: number;
  mode: TravelMode;
  precision: Precision;
  /**
   * What the journey is made of, when it was measured by a provider that says.
   * Present on `transit` answered by TfNSW; absent on road modes, which have no
   * legs, and on transit answered by Google, which does not report them.
   */
  journey?: Journey;
  /**
   * Present on a `walk` that crosses open water. Every router will put a
   * pedestrian on a ferry and report the whole thing as walking — Google returns
   * eight WALK steps for Balmain East to the CBD — and no field mask on any
   * endpoint says otherwise, so it is caught by two signals instead. See
   * `flagMislabelledWalks`.
   */
  mislabelled?: MislabelledWalk;
}

export interface TravelReport {
  origin: { query: string; lat: number; lng: number; precision: Precision };
  mode: TravelMode;
  router: string;
  geocoder: string;
  /** Unique buildings resolved, vs listings — shows the dedupe working. */
  listings: number;
  uniqueBuildings: number;
  routed: number;
  /**
   * How the routed listings were positioned. `building` is an exact match on
   * house number; `street` means the right street but not the exact building
   * (good to roughly a block); `area` is a locality centroid.
   */
  precision: { building: number; street: number; area: number };
  /** Could not be geocoded or routed. These carry `travel: null`. */
  unresolved: number;
  geocodeCalls: number;
  matrixCalls: number;
  cachedBuildings: number;
  notes?: string[];
}

import {
  DEFAULT_WALK_SPEED_KMH,
  type Journey,
  TfnswError,
  WALK_SUSPECT_KMH,
  fastestJourney,
  ferryAvailable,
  impliedSpeedKmh,
  journeyMinutes,
  tfnswKey,
  tripJourneys,
  MIN_REQUEST_INTERVAL_MS as TFNSW_MIN_INTERVAL_MS,
} from "./tfnsw.js";

const CACHE_PATH =
  process.env.REALESTATE_MCP_DISTANCE_CACHE ??
  join(homedir(), ".realestate-mcp", "distance-cache.json");

// Trimmed as well as lowercased: a trailing space off a `.env` line is a
// different string, and nobody has ever meant to configure "google ".
const ROUTER = (process.env.REALESTATE_MCP_ROUTER ?? "valhalla").trim().toLowerCase();
const GEOCODER = (process.env.REALESTATE_MCP_GEOCODER ?? "photon").trim().toLowerCase();

/**
 * Say something when one of those is a value we do not know.
 *
 * Both dispatches end in a bare else — `matrix` falls through to Valhalla and
 * `geocoderChain` to Photon. Neither needs a key, so a typo does not fail. It
 * quietly measures with a different provider than the caller asked for, and
 * every number after it is subtly not what the committed ones were:
 * `REALESTATE_MCP_ROUTER=tfnsw` looks like it should route transit and instead
 * moves *walking* onto Valhalla, and a misspelled geocoder gives up Google's
 * markedly better Australian unit addresses, which is what decides whether a
 * travel time is measured or a suburb centroid.
 *
 * Warned rather than thrown. The fallbacks do work, and a server refusing to
 * start over one misspelled variable would be worse than what it is guarding
 * against. "configuration error" is deliberate wording: the findings repo's
 * `McpClient` filters this server's stderr and only surfaces lines matching
 * /error|refus|blocked|bot protection/, so anything softer would be swallowed
 * by exactly the caller who needs to see it.
 */
function warnUnknownProvider(
  name: string,
  value: string,
  known: readonly string[],
  fallsBackTo: string,
): void {
  if (known.includes(value)) return;
  console.error(
    `[sydney-rental-data-pipeline] configuration error: ${name}="${value}" is not one of ` +
      `${known.join(", ")}. Falling back to ${fallsBackTo}, which needs no key and will not ` +
      `fail — so measurements will silently disagree with ones taken as intended.`,
  );
}

warnUnknownProvider("REALESTATE_MCP_ROUTER", ROUTER, ["valhalla", "ors", "google"], "Valhalla");
warnUnknownProvider("REALESTATE_MCP_GEOCODER", GEOCODER, ["photon", "nominatim", "google"], "Photon");
const ORS_KEY = process.env.ORS_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * Google's terms permit caching latitude/longitude for at most 30 consecutive
 * days. OSM-derived positions have no such limit, so only Google entries carry
 * an expiry — see the header note.
 */
const GOOGLE_GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VALHALLA_URL =
  process.env.REALESTATE_MCP_VALHALLA_URL ?? "https://valhalla1.openstreetmap.de/sources_to_targets";

/**
 * Valhalla and ORS are happy with 45 targets a call. Google counts *elements*
 * (origins × destinations) and caps transit at 100 — the same figure is used for
 * its road modes, well inside their 625, because a smaller body fails faster and
 * costs less to retry.
 */
const MAX_TARGETS = 45;
const GOOGLE_MAX_TARGETS = 100;

function targetsPerCall(mode: TravelMode): number {
  if (ROUTER === "google" || mode === "transit") return GOOGLE_MAX_TARGETS;
  return MAX_TARGETS;
}
const CHUNK_DELAY_MS = 300;
const HTTP_TIMEOUT_MS = 20_000;
/** Photon tolerates a brisk pace; Nominatim's published policy is 1 req/sec. */
const PHOTON_DELAY_MS = 200;
const NOMINATIM_DELAY_MS = 1_100;

const UA = "realestate-mcp/0.1 (personal use; travel-time enrichment)";

/* ------------------------------------------------------------------ cache -- */

interface CachedGeo {
  lat: number;
  lng: number;
  precision: Precision;
  /** Absent on entries written before provenance was tracked — those are OSM. */
  src?: "osm" | "google";
  /** Epoch ms. Only meaningful for `src: "google"`, which expires (see header). */
  at?: number;
}

interface CacheShape {
  routes: Record<
    string,
    {
      minutes: number;
      km: number;
      journey?: Journey;
      /**
       * Whether a ferry serves this pair, once asked. Written only for walks
       * fast enough to be suspect, so `undefined` means "never asked" rather
       * than "no" — which is what lets entries written before this existed be
       * re-examined instead of silently passing. Transit entries carry the same
       * fact inside `journey`, where it came free with the trip.
       */
      ferryAvailable?: boolean;
    }
  >;
  geo: Record<string, CachedGeo>;
}

let cache: CacheShape | null = null;
let cacheDirty = false;

function loadCache(): CacheShape {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<CacheShape>;
    cache = { routes: parsed.routes ?? {}, geo: parsed.geo ?? {} };
  } catch {
    cache = { routes: {}, geo: {} };
  }
  return cache;
}

function flushCache(): void {
  if (!cacheDirty || !cache) return;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
    cacheDirty = false;
  } catch {
    /* an unpersistable cache is still a valid in-memory cache */
  }
}

const r5 = (n: number): number => Math.round(n * 1e5) / 1e5;

/**
 * `when` is part of the key for a reason: a transit time is a function of the
 * timetable at that moment. Caching "34 minutes" for a Tuesday 9am arrival and
 * replaying it for a Sunday midnight one would be worse than not caching at all.
 * Road modes ignore it — free-flow routing has no clock.
 */
const routeKey = (mode: TravelMode, o: Coord, d: Coord, when?: string, provider?: string): string =>
  `${provider ? `${mode}:${provider}` : mode}|${when ?? ""}|${r5(o.lat)},${r5(o.lng)}|${r5(d.lat)},${r5(d.lng)}`;

/**
 * TfNSW answers are namespaced `transit:tfnsw` rather than sharing `transit`.
 *
 * The cache on disk predates legs — thousands of `{ minutes, km }` entries
 * written when transit meant Google. Reusing the key would let one of them
 * satisfy a request that needs a journey, and the caller would get a hit, no
 * legs, and no error: the whole measurement silently doing nothing while
 * appearing to work. A separate namespace makes that impossible, at the cost of
 * some dead entries that a caller can delete whenever they like.
 */
const TFNSW_PROVIDER = "tfnsw";

/** True once a Google-sourced position has passed the 30 days its licence allows. */
function geoExpired(hit: CachedGeo): boolean {
  if (hit.src !== "google") return false;
  return hit.at === undefined || Date.now() - hit.at > GOOGLE_GEO_TTL_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- geocoding -- */

/**
 * Reduce a listing address to the building a geocoder can actually find.
 * "182/27 Park Street, Sydney, NSW 2000"      -> "27 Park Street, Sydney, NSW 2000"
 * "Level3 BlockC/24-26 Point Street, Pyrmont" -> "24-26 Point Street, Pyrmont"
 * "Fully Furnished 3/170 Pyrmont Street, ..." -> "170 Pyrmont Street, ..."
 *
 * Dropping the unit is deliberate, not lossy: we want the building's position,
 * and unit prefixes are the single biggest cause of geocoder misses.
 */
export function buildingAddress(address: string): string {
  let s = address.trim();
  // Strip any leading marketing prose before the unit ("Fully Furnished 3/170 ...").
  s = s.replace(/^[^,\d]*?(?=\d+\s*\/)/, "");
  // Strip the unit/level prefix up to the last slash before the street number.
  s = s.replace(/^\s*[^,/]*\/\s*/, "");
  // Strip a bare leading descriptor with no slash ("Small Studio/..." handled above,
  // "Studio 631-635 George Street" -> "631-635 George Street").
  s = s.replace(/^(studio|penthouse|apartment|unit|suite|level\s*\d*)\s+(?=\d)/i, "");
  return s.trim();
}

interface GeoResult extends Coord {
  precision: Precision;
}

/**
 * Abbreviated street types wreck geocoder ranking. Verified: "4 Bridge St,
 * Sydney" returns a STREET LAMP on King Street Cycleway as its top hit, while
 * "4 Bridge Street, Sydney" returns the right building first. Expanding the
 * suffix is the single highest-value normalisation here.
 */
const STREET_TYPES: Record<string, string> = {
  st: "Street", str: "Street", rd: "Road", ave: "Avenue", av: "Avenue",
  pde: "Parade", cres: "Crescent", cr: "Crescent", dr: "Drive", drv: "Drive",
  ct: "Court", pl: "Place", ln: "Lane", hwy: "Highway", tce: "Terrace",
  cct: "Circuit", esp: "Esplanade", gr: "Grove", sq: "Square", wy: "Way",
  bvd: "Boulevard", blvd: "Boulevard",
};

export function expandStreetTypes(address: string): string {
  const parts = address.split(",");
  parts[0] = parts[0].replace(/\s+([A-Za-z]+)\.?\s*$/, (m, word: string) => {
    const full = STREET_TYPES[word.toLowerCase()];
    return full ? ` ${full}` : m;
  });
  return parts.join(",");
}

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** The street portion of an address, house number stripped. */
function wantedStreet(address: string): string {
  return norm(expandStreetTypes(address).split(",")[0].replace(/^\s*[\d-]+[a-z]?\s+/i, ""));
}

function wantedPostcode(address: string): string | null {
  const m = address.match(/\b(\d{4})\b\s*$/) ?? address.match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

/** The house number or range: "24-26 Point Street" -> "2426". */
function wantedNumber(address: string): string | null {
  const m = address.split(",")[0].trim().match(/^([\d]+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\s+/i);
  return m ? m[1].replace(/[^a-z0-9]/gi, "").toLowerCase() : null;
}

const sameNumber = (a: string | undefined, b: string | null): boolean =>
  !!a && !!b && a.replace(/[^a-z0-9]/gi, "").toLowerCase() === b;

/**
 * Does a geocoder candidate actually sit on the street we asked for? Without
 * this a plausible-looking result on a completely different street is accepted
 * silently — which is precisely how a pub on John Street became "24-26 Point
 * Street, Pyrmont".
 */
function streetMatches(candidate: string | undefined, wanted: string): boolean {
  if (!candidate || !wanted) return false;
  const c = norm(candidate);
  if (c.includes(wanted) || wanted.includes(c)) return true;
  const head = wanted.split(" ")[0];
  return head.length > 2 && c.split(" ").includes(head);
}

async function photonGeocode(query: string): Promise<GeoResult | null> {
  const q = expandStreetTypes(query);
  const url =
    "https://photon.komoot.io/api/?limit=6&lang=en&lat=-33.87&lon=151.21&q=" + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        type?: string;
        osm_key?: string;
        street?: string;
        name?: string;
        housenumber?: string;
        postcode?: string;
      };
    }>;
  };

  const wantStreet = wantedStreet(q);
  const wantPost = wantedPostcode(q);
  const wantNum = wantedNumber(q);

  const onRightStreet = (body.features ?? [])
    .filter((f) => (f.geometry?.coordinates?.length ?? 0) >= 2)
    // Wrong postcode means wrong suburb — "4 Bridge Street" also exists in Epping.
    .filter((f) => !(wantPost && f.properties?.postcode && f.properties.postcode !== wantPost))
    .filter((f) => {
      const p = f.properties ?? {};
      // `street` is authoritative when present. Only fall back to `name` for
      // features that ARE streets — a POI name must never be matched against a
      // street name, or "Pyrmont Point Hotel" satisfies a search for "Point Street".
      if (p.street) return streetMatches(p.street, wantStreet);
      if (p.type === "street" || p.osm_key === "highway") return streetMatches(p.name, wantStreet);
      return false;
    });

  const exact = onRightStreet.find((f) => sameNumber(f.properties?.housenumber, wantNum));
  const pick = exact ?? onRightStreet[0];
  if (!pick) return null;

  const c = pick.geometry!.coordinates!;
  // Right street but wrong number is street-level knowledge, not building-level.
  return { lat: c[1], lng: c[0], precision: exact ? "building" : "street" };
}

async function nominatimGeocode(query: string): Promise<GeoResult | null> {
  const q = expandStreetTypes(query);
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=au" +
    "&addressdetails=1&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as Array<{
    lat?: string;
    lon?: string;
    addresstype?: string;
    address?: { road?: string; house_number?: string; postcode?: string };
  }>;

  const wantStreet = wantedStreet(q);
  const wantPost = wantedPostcode(q);
  const wantNum = wantedNumber(q);

  const onRightStreet = body.filter((hit) => {
    if (!hit.lat || !hit.lon) return false;
    const a = hit.address ?? {};
    if (wantPost && a.postcode && a.postcode !== wantPost) return false;
    return streetMatches(a.road, wantStreet);
  });

  const exact = onRightStreet.find((h) => sameNumber(h.address?.house_number, wantNum));
  const pick = exact ?? onRightStreet[0];
  if (!pick) return null;

  return {
    lat: Number(pick.lat),
    lng: Number(pick.lon),
    precision: exact ? "building" : "street",
  };
}

/**
 * Google Geocoding. Worth the money for one reason: `location_type` says how the
 * answer was arrived at, so precision is read off the response rather than
 * inferred from whether a house number happened to match.
 *
 *   ROOFTOP            the building itself          -> building
 *   RANGE_INTERPOLATED estimated along the block    -> street
 *   GEOMETRIC_CENTER   centre of a street or region -> street
 *   APPROXIMATE        a locality                   -> area
 *
 * `RANGE_INTERPOLATED` is usually close, but it is an interpolation and this
 * module's whole point is not to sell an estimate as a measurement — so it lands
 * on `street`, alongside "right road, wrong number".
 */
const GOOGLE_PRECISION: Record<string, Precision> = {
  ROOFTOP: "building",
  RANGE_INTERPOLATED: "street",
  GEOMETRIC_CENTER: "street",
  APPROXIMATE: "area",
};

async function googleGeocode(query: string): Promise<GeoResult | null> {
  if (!GOOGLE_KEY) {
    throw new Error(
      "REALESTATE_MCP_GEOCODER=google but GOOGLE_MAPS_API_KEY is not set. Create a " +
        "server key in the Google Cloud console with the Geocoding API enabled, or unset " +
        "REALESTATE_MCP_GEOCODER to use Photon (no key needed).",
    );
  }

  const q = expandStreetTypes(query);
  const url =
    `${GOOGLE_GEOCODE_URL}?region=au&components=country:AU` +
    `&address=${encodeURIComponent(q)}&key=${encodeURIComponent(GOOGLE_KEY)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google Geocoding HTTP ${res.status}`);

  const body = (await res.json()) as {
    status?: string;
    error_message?: string;
    results?: Array<{
      geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
      address_components?: Array<{ types?: string[]; long_name?: string; short_name?: string }>;
    }>;
  };

  // ZERO_RESULTS is a legitimate answer; a key or quota problem is not, and
  // must not be swallowed into "this address does not exist".
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status && body.status !== "OK") {
    throw new Error(`Google Geocoding ${body.status}${body.error_message ? `: ${body.error_message}` : ""}`);
  }

  const wantPost = wantedPostcode(q);

  for (const hit of body.results ?? []) {
    const loc = hit.geometry?.location;
    if (loc?.lat == null || loc.lng == null) continue;

    // Same guard as the OSM geocoders: a wrong postcode means a right-looking
    // street in the wrong suburb, and Sydney has plenty of those.
    if (wantPost) {
      const postcode = hit.address_components?.find((c) => c.types?.includes("postal_code"));
      if (postcode?.long_name && postcode.long_name !== wantPost) continue;
    }

    return {
      lat: loc.lat,
      lng: loc.lng,
      precision: GOOGLE_PRECISION[hit.geometry?.location_type ?? ""] ?? "area",
    };
  }

  return null;
}

let geocodeCalls = 0;

type Geocoder = { name: "osm" | "google"; run: (q: string) => Promise<GeoResult | null>; delay: number };

const PHOTON: Geocoder = { name: "osm", run: photonGeocode, delay: PHOTON_DELAY_MS };
const NOMINATIM: Geocoder = { name: "osm", run: nominatimGeocode, delay: NOMINATIM_DELAY_MS };
/** Google is rate-limited generously; the delay is courtesy, not policy. */
const GOOGLE: Geocoder = { name: "google", run: googleGeocode, delay: 50 };

/**
 * Primary geocoder first, then the other free one as a fallback.
 *
 * Google is never used as a *fallback* for an OSM primary, only as an explicit
 * primary. Falling back to it silently would spend money the caller did not ask
 * to spend, and would quietly put a 30-day expiry on cache entries the caller
 * believes are permanent.
 */
function geocoderChain(): Geocoder[] {
  if (GEOCODER === "google") return [GOOGLE, PHOTON];
  if (GEOCODER === "nominatim") return [NOMINATIM, PHOTON];
  return [PHOTON, NOMINATIM];
}

/** Geocode one address string, trying the primary geocoder then the fallback. */
async function geocodeUncached(query: string): Promise<(GeoResult & { src: "osm" | "google" }) | null> {
  const [primary, secondary] = geocoderChain();
  let best: (GeoResult & { src: "osm" | "google" }) | null = null;

  for (const geocoder of [primary, secondary]) {
    try {
      geocodeCalls++;
      const hit = await geocoder.run(query);
      await sleep(geocoder.delay);
      if (hit) {
        const tagged = { ...hit, src: geocoder.name };
        // A suburb centroid is barely better than nothing — keep it, but try the
        // other geocoder before settling for it.
        if (hit.precision !== "area") return tagged;
        best ??= tagged;
      }
    } catch {
      // A dead geocoder must not sink the run; the next one gets a turn, and
      // an unresolvable address ends up counted rather than invented.
    }
  }

  return best;
}

/**
 * The centroid of a named place, as distinct from the position of an address.
 *
 * Deliberately **not** `geocodeUncached`. That one resolves addresses, and every
 * heuristic in it — expanding street types, preferring a hit that names a road
 * or a house number, treating `area` as the consolation prize — is tuned to
 * reject exactly the answer wanted here. Pointed at "Westleigh, NSW 2120" it
 * returns a street inside Westleigh, 1.5 km from the centre, and on 25 of 40
 * sampled suburbs it matched nothing at all.
 *
 * So this asks the simple question instead: one result, take it. That is
 * verbatim what the downstream pipeline's own `geocodeSuburb` did before this
 * existed, down to the `limit=1` and the 6-decimal rounding, and it reproduces
 * every centroid in that project's committed 398-place envelope to the metre.
 * Being the same request is the point — a different gazetteer moves suburbs by a
 * median of 241 m, which is a data change wearing a refactor's clothes.
 *
 * OSM only, for the same reason. Mixing gazetteers across one dataset would move
 * some suburbs and not others, and OSM positions carry no licence expiry, so a
 * centroid cached here is good until the suburb moves.
 */
async function localityGeocode(query: string): Promise<(GeoResult & { src: "osm" }) | null> {
  geocodeCalls++;
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await sleep(NOMINATIM_DELAY_MS);
    if (!res.ok) return null;

    const body = (await res.json()) as { lat?: string; lon?: string }[];
    const first = body[0];
    if (!first?.lat || !first?.lon) return null;

    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // 6 dp — about 10 cm, far finer than a centroid means, and what the callers
    // downstream already store.
    return {
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      precision: "area",
      src: "osm",
    };
  } catch {
    return null;
  }
}

const LATLNG_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Resolve an origin string. Accepts "lat,lng" directly to bypass geocoding. */
export async function resolveOrigin(query: string): Promise<GeoResult> {
  const direct = LATLNG_RE.exec(query);
  if (direct) {
    const lat = Number(direct[1]);
    const lng = Number(direct[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng, precision: "building" };
    }
  }
  const hit = await geocodeCached(query);
  if (!hit) {
    throw new Error(
      `could not geocode origin "${query}". Pass coordinates directly as "lat,lng" instead.`,
    );
  }
  return hit;
}

/** A geocode plus where it came from, so a caller never has to assume. */
type GeocodeHit = GeoResult & { src: "osm" | "google"; cached: boolean };

async function geocodeCached(query: string, wantLocality = false): Promise<GeocodeHit | null> {
  const c = loadCache();
  // Namespaced, for the same reason `transit:tfnsw` is: the two preferences ask
  // different questions of the same string, and letting one answer satisfy the
  // other would be a cache hit that is silently the wrong kind of point.
  const k = (wantLocality ? "locality|" : "") + query.trim().toLowerCase();
  const hit = c.geo[k];
  // Entries written before provenance was tracked carry no `src`; those are OSM,
  // which is what they were.
  const remembered: GeocodeHit | null = hit
    ? { lat: hit.lat, lng: hit.lng, precision: hit.precision, src: hit.src ?? "osm", cached: true }
    : null;
  // Buildings do not move, so an OSM hit is good forever. A Google one is good
  // for 30 days, because that is what its licence allows.
  if (hit && remembered && !geoExpired(hit)) return remembered;

  const fresh = wantLocality ? await localityGeocode(query) : await geocodeUncached(query);
  if (!fresh) return remembered && remembered.src !== "google" ? remembered : null;

  c.geo[k] = { ...fresh, at: Date.now() };
  cacheDirty = true;
  return { ...fresh, cached: false };
}

/* ---------------------------------------------------------------- routers -- */

type MatrixLeg = { minutes: number; km: number; journey?: Journey } | null;

async function valhallaMatrix(
  origin: Coord,
  targets: Coord[],
  mode: TravelMode,
): Promise<MatrixLeg[]> {
  if (mode === "transit") throw new Error("Valhalla cannot answer transit — see googleMatrix");
  const res = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      sources: [{ lat: origin.lat, lon: origin.lng }],
      targets: targets.map((t) => ({ lat: t.lat, lon: t.lng })),
      costing: mode === "walk" ? "pedestrian" : "auto",
      units: "kilometers",
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Valhalla HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const json = (await res.json()) as {
    sources_to_targets?: Array<Array<{ time?: number | null; distance?: number | null }>>;
  };
  const row = json.sources_to_targets?.[0];
  if (!row) throw new Error("Valhalla returned no matrix row");

  return targets.map((_, i) => {
    const leg = row[i];
    if (!leg || leg.time == null || leg.distance == null) return null;
    return { minutes: leg.time / 60, km: leg.distance };
  });
}

async function orsMatrix(origin: Coord, targets: Coord[], mode: TravelMode): Promise<MatrixLeg[]> {
  if (mode === "transit") throw new Error("OpenRouteService cannot answer transit — see googleMatrix");
  if (!ORS_KEY) {
    throw new Error(
      "REALESTATE_MCP_ROUTER=ors but ORS_API_KEY is not set. Get a free key at " +
        "openrouteservice.org, or unset REALESTATE_MCP_ROUTER to use Valhalla (no key needed).",
    );
  }
  const profile = mode === "walk" ? "foot-walking" : "driving-car";
  // ORS takes [lng, lat] — the reverse of every other API here.
  const locations = [[origin.lng, origin.lat], ...targets.map((t) => [t.lng, t.lat])];
  const res = await fetch(`https://api.openrouteservice.org/v2/matrix/${profile}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ORS_KEY },
    body: JSON.stringify({
      locations,
      sources: [0],
      destinations: locations.map((_, i) => i).slice(1),
      metrics: ["duration", "distance"],
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ORS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const json = (await res.json()) as {
    durations?: Array<Array<number | null>>;
    distances?: Array<Array<number | null>>;
  };
  const dur = json.durations?.[0];
  const dist = json.distances?.[0];
  if (!dur) throw new Error("ORS returned no duration row");

  return targets.map((_, i) => {
    const seconds = dur[i];
    if (seconds == null) return null;
    return { minutes: seconds / 60, km: (dist?.[i] ?? 0) / 1000 };
  });
}

const GOOGLE_TRAVEL_MODE: Record<TravelMode, string> = {
  walk: "WALK",
  drive: "DRIVE",
  transit: "TRANSIT",
};

/**
 * Google Routes, Compute Route Matrix.
 *
 * The only router here that can answer `transit`, and the reason is worth
 * stating: Sydney public transport time is a timetable lookup, not a distance
 * calculation, so no road router can approximate it and none should try.
 *
 * `arriveBy` matters more than it looks. A train time is meaningless without a
 * moment to measure it at — "34 minutes" on a Tuesday at 9am and at 3am on a
 * Sunday are different facts about the same pair of points. It is required for
 * transit rather than defaulted, so nobody accidentally compares a commute
 * against the overnight timetable.
 *
 * A field mask is mandatory on this API; omitting it is an error, not a default.
 * `condition` is what separates "no route exists" from "the element failed",
 * and both come back inside a 200 alongside the elements that worked.
 */
/**
 * Everything that makes a request impossible rather than merely unlucky.
 * Exported so `enrichWithTravel` can run it up front — see the note there.
 */
export function assertRoutable(mode: TravelMode, arriveBy?: string): void {
  const needsGoogle = (mode === "transit" && !transitUsesTfnsw()) || ROUTER === "google";
  if (needsGoogle && !GOOGLE_KEY) {
    throw new Error(
      mode === "transit"
        ? "transit needs either TFNSW_API_KEY or GOOGLE_MAPS_API_KEY. Prefer TfNSW: it is free " +
          "(60,000 calls a day), it is the operator's own planner, and it reports the journey's " +
          "legs, so a ferry is a measured fact rather than a guess. Get one at " +
          "opendata.transport.nsw.gov.au and add the Trip Planner APIs to an application. " +
          "Estimating transit from road distance is never an option here."
        : "REALESTATE_MCP_ROUTER=google but GOOGLE_MAPS_API_KEY is not set. Unset it to use " +
          "Valhalla (no key needed).",
    );
  }
  if (mode === "transit" && !arriveBy) {
    throw new Error(
      "transit needs an arrival time — pass `travelArriveBy` as an RFC 3339 timestamp, " +
        'e.g. "2026-08-25T09:00:00+10:00". Without one the answer would be measured against ' +
        "whatever timetable happens to be running now.",
    );
  }
  if (arriveBy && Number.isNaN(Date.parse(arriveBy))) {
    throw new Error(`travelArriveBy "${arriveBy}" is not a parseable RFC 3339 timestamp`);
  }
}

async function googleMatrix(
  origin: Coord,
  targets: Coord[],
  mode: TravelMode,
  arriveBy?: string,
): Promise<MatrixLeg[]> {
  assertRoutable(mode, arriveBy);

  const body: Record<string, unknown> = {
    origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
    destinations: targets.map((t) => ({
      waypoint: { location: { latLng: { latitude: t.lat, longitude: t.lng } } },
    })),
    travelMode: GOOGLE_TRAVEL_MODE[mode],
  };
  // Only transit takes a clock. Sending one for DRIVE would silently switch the
  // request to a traffic-aware SKU at twice the price.
  if (mode === "transit") body.arrivalTime = arriveBy;

  const res = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY as string,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,status,condition",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google Routes HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const elements = (await res.json()) as Array<{
    originIndex?: number;
    destinationIndex?: number;
    duration?: string;
    distanceMeters?: number;
    condition?: string;
    status?: { code?: number; message?: string };
  }>;

  const legs: MatrixLeg[] = targets.map(() => null);
  for (const element of elements) {
    const i = element.destinationIndex;
    if (i == null || i < 0 || i >= targets.length) continue;
    // A failed element and a genuine "no route" both mean we do not know, and
    // both must stay null rather than becoming a zero.
    if (element.status?.code) continue;
    if (element.condition && element.condition !== "ROUTE_EXISTS") continue;
    const seconds = Number.parseFloat(element.duration ?? "");
    if (!Number.isFinite(seconds)) continue;
    legs[i] = { minutes: seconds / 60, km: (element.distanceMeters ?? 0) / 1000 };
  }

  return legs;
}

/**
 * Transit never goes to the road routers regardless of `REALESTATE_MCP_ROUTER` —
 * asking Valhalla for a train time would silently return a walking time. It goes
 * to TfNSW when `TFNSW_API_KEY` is set and Google otherwise.
 *
 * **The TfNSW path measures `targets → origin`, not `origin → targets`.** That
 * is deliberate and it is not what the Google path does. `googleMatrix` indexes
 * by `destinationIndex` and asks "leave the origin, reach each target by
 * `arriveBy`" — which for a commute origin like an office is the evening trip
 * home, not the morning trip in. Walk and drive are symmetric enough for that
 * not to matter; a peak timetable is not. `manyToOne` already gets this right
 * for `route_places`, and this brings the enrichment path into line with it.
 */
function matrix(
  origin: Coord,
  targets: Coord[],
  mode: TravelMode,
  arriveBy?: string,
): Promise<MatrixLeg[]> {
  if (mode === "transit") {
    const key = tfnswKey();
    if (key) return tfnswManyToOne(targets, origin, arriveBy as string, key);
    return googleMatrix(origin, targets, mode, arriveBy);
  }
  if (ROUTER === "google") return googleMatrix(origin, targets, mode, arriveBy);
  return ROUTER === "ors" ? orsMatrix(origin, targets, mode) : valhallaMatrix(origin, targets, mode);
}

/** Whether transit goes to TfNSW. Falls back to Google when no key is set. */
function transitUsesTfnsw(): boolean {
  return tfnswKey() !== undefined;
}

/** What actually answered, for the report — `REALESTATE_MCP_ROUTER` may not be it. */
function routerFor(mode: TravelMode): string {
  if (mode !== "transit") return ROUTER;
  return transitUsesTfnsw() ? "tfnsw" : "google";
}

/** The cache namespace for a mode. Only TfNSW transit takes one — see `TFNSW_PROVIDER`. */
function providerFor(mode: TravelMode): string | undefined {
  return mode === "transit" && transitUsesTfnsw() ? TFNSW_PROVIDER : undefined;
}

/* ------------------------------------------------------ mislabelled walk -- */

/**
 * When to ask the timetable whether a ferry serves a pair.
 *
 * The question is "does a ferry run here at all", not "how long does it take",
 * so the exact moment hardly matters — but it cannot be *any* moment. Probe at
 * 3am and the planner answers, truthfully, that nothing is running. A caller's
 * own `arriveBy` is used when there is one; otherwise the next weekday 9am in
 * Sydney, which is what a commute question means.
 *
 * Found by inspection rather than by arithmetic because "+10 hours" is not a
 * fixed thing across a daylight-saving boundary.
 */
function ferryProbeTime(arriveBy?: string, now: Date = new Date()): Date {
  if (arriveBy) {
    const given = new Date(arriveBy);
    if (!Number.isNaN(given.getTime())) return given;
  }
  const sydney = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const at = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  at.setUTCMinutes(0, 0, 0);
  for (let step = 0; step < 24 * 9; step += 1) {
    const parts = sydney.formatToParts(at);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    const hour = parts.find((p) => p.type === "hour")?.value;
    if (hour === "09" && weekday !== "Sat" && weekday !== "Sun") return at;
    at.setUTCHours(at.getUTCHours() + 1);
  }
  return at;
}

/** One walk to examine, and where to write the finding if there is one. */
interface WalkAudit {
  /** The walk's far end — a listing. The trip is probed from here. */
  from: Coord;
  /** The end a search measures against — the office. */
  to: Coord;
  /** This leg's route-cache key, so one pair is probed once and not again. */
  cacheKey: string;
  minutes: number;
  km: number;
  /** Called only when both signals agree. */
  flag: (evidence: MislabelledWalk) => void;
}

/**
 * Mark the walks that are really ferry crossings.
 *
 * Asking any router to walk from Balmain East to the CBD returns a route made
 * entirely of walking steps, across open water, and no field mask on any
 * endpoint reports the vehicle — so the answer cannot be taken at face value
 * and cannot be corrected from the numbers alone. A walk, a short ferry hop and
 * a genuine stroll produce indistinguishable `(minutes, km)` pairs.
 *
 * So it takes two signals. The routed speed narrows the field for nothing, off
 * numbers already in hand; only what survives that costs a request, which is
 * why this is affordable to run on every walk — six of 285 in the measured set,
 * and the other 279 are settled by arithmetic. The timetable then confirms it.
 *
 * Neither signal is sufficient alone: a router cutting a corner can look fast
 * without crossing water, and a ferry existing nearby says nothing about the
 * route that was returned. Both together were right on all six known cases and
 * on neither control.
 *
 * Returns how many requests it actually spent.
 */
async function flagMislabelledWalks(audits: WalkAudit[], arriveBy?: string): Promise<number> {
  const key = tfnswKey();
  if (!key) return 0;

  const suspects: { audit: WalkAudit; kmh: number }[] = [];
  for (const audit of audits) {
    const kmh = impliedSpeedKmh(audit.km, audit.minutes);
    if (kmh !== null && kmh >= WALK_SUSPECT_KMH) suspects.push({ audit, kmh });
  }
  if (suspects.length === 0) return 0;

  const c = loadCache();
  const when = ferryProbeTime(arriveBy);
  let probes = 0;

  for (const { audit, kmh } of suspects) {
    const cached = c.routes[audit.cacheKey];
    let served = cached?.ferryAvailable;

    if (served === undefined) {
      if (probes > 0) await sleep(TFNSW_MIN_INTERVAL_MS);
      try {
        served = ferryAvailable(await tripJourneys(audit.from, audit.to, when, key));
        probes += 1;
      } catch (e) {
        // A rejected key will not fix itself. Anything else is this one pair
        // being unlucky, and a suspicion nobody confirmed is not a finding.
        if (e instanceof TfnswError && e.fatal) throw e;
        continue;
      }
      if (cached) {
        cached.ferryAvailable = served;
        cacheDirty = true;
      }
    }

    if (served) {
      audit.flag({
        actually: "ferry",
        impliedKmh: Math.round(kmh * 100) / 100,
        thresholdKmh: WALK_SUSPECT_KMH,
        ferryAvailable: true,
      });
    }
  }
  return probes;
}

/* ---------------------------------------------------------------- enrich -- */

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export interface Locatable {
  address: string;
  coords?: Coord;
  travel?: Travel | null;
}

/**
 * Attach real routed travel times to `items` in place, geocoding building
 * positions as needed. Returns a report the caller should surface — it is the
 * only way to tell an exact answer from an approximate one.
 */
export async function enrichWithTravel<T extends Locatable>(
  items: T[],
  originQuery: string,
  mode: TravelMode,
  /**
   * RFC 3339 moment to arrive by. Required for `transit` and ignored otherwise —
   * see `googleMatrix` for why a train time without a clock is not a fact.
   */
  arriveBy?: string,
): Promise<TravelReport> {
  // Checked here, before any work, and thrown rather than noted. The per-chunk
  // handler below deliberately absorbs a routing failure so an outage cannot
  // cost the caller their search results — but a missing key is not an outage.
  // Absorbed, it would hand back every listing with `travel: null`, which
  // `maxTravelMinutes` keeps rather than drops, and a transit search would
  // silently return the whole unfiltered set as though everything matched.
  assertRoutable(mode, arriveBy);

  geocodeCalls = 0;
  const origin = await resolveOrigin(originQuery);
  const c = loadCache();
  const notes: string[] = [];

  // Pass 1 — one geocode per unique BUILDING, not per listing.
  const buildings = new Map<string, GeoResult | null>();
  for (const item of items) {
    const key = buildingAddress(item.address).toLowerCase();
    if (!buildings.has(key)) buildings.set(key, null);
  }
  const cachedBefore = [...buildings.keys()].filter((k) => c.geo[k]).length;

  for (const key of buildings.keys()) {
    const hit = await geocodeCached(key);
    buildings.set(key, hit);
  }
  flushCache();

  // Pass 2 — resolve each listing to its building, collect uncached routes.
  const misses: { item: T; coord: Coord }[] = [];
  const report: TravelReport = {
    origin: { query: originQuery, lat: origin.lat, lng: origin.lng, precision: origin.precision },
    mode,
    router: routerFor(mode),
    geocoder: GEOCODER,
    listings: items.length,
    uniqueBuildings: buildings.size,
    routed: 0,
    precision: { building: 0, street: 0, area: 0 },
    unresolved: 0,
    geocodeCalls,
    matrixCalls: 0,
    cachedBuildings: cachedBefore,
  };

  const precisionOf = new Map<T, Precision>();
  for (const item of items) {
    const geo = buildings.get(buildingAddress(item.address).toLowerCase());
    if (!geo) {
      item.travel = null;
      item.coords = undefined;
      report.unresolved++;
      continue;
    }
    item.coords = { lat: geo.lat, lng: geo.lng };
    precisionOf.set(item, geo.precision);

    const hit = c.routes[routeKey(mode, origin, item.coords, arriveBy, providerFor(mode))];
    if (hit) {
      item.travel = {
        minutes: Math.round(hit.minutes * 10) / 10,
        km: Math.round(hit.km * 100) / 100,
        mode,
        precision: geo.precision,
        ...(hit.journey ? { journey: hit.journey } : {}),
      };
    } else {
      misses.push({ item, coord: item.coords });
    }
  }

  // Pass 3 — one matrix request per chunk of uncached destinations.
  for (const group of chunk(misses, targetsPerCall(mode))) {
    if (report.matrixCalls > 0) await sleep(CHUNK_DELAY_MS);
    try {
      const legs = await matrix(
        origin,
        group.map((g) => g.coord),
        mode,
        arriveBy,
      );
      report.matrixCalls++;
      group.forEach((g, i) => {
        const leg = legs[i];
        if (!leg) {
          g.item.travel = null;
          return;
        }
        g.item.travel = {
          minutes: Math.round(leg.minutes * 10) / 10,
          km: Math.round(leg.km * 100) / 100,
          mode,
          precision: precisionOf.get(g.item) ?? "area",
          ...(leg.journey ? { journey: leg.journey } : {}),
        };
        c.routes[routeKey(mode, origin, g.coord, arriveBy, providerFor(mode))] = {
          minutes: leg.minutes,
          km: leg.km,
          ...(leg.journey ? { journey: leg.journey } : {}),
        };
        cacheDirty = true;
      });
    } catch (e) {
      for (const g of group) g.item.travel = null;
      notes.push(`routing request failed: ${(e as Error).message}`);
    }
  }

  // Only walks can be mislabelled this way, and only the fast ones cost a
  // request. Runs before the flush so a probe is written down with its leg.
  if (mode === "walk") {
    const audits: WalkAudit[] = [];
    for (const item of items) {
      const travel = item.travel;
      if (!travel || !item.coords) continue;
      audits.push({
        from: item.coords,
        to: origin,
        cacheKey: routeKey(mode, origin, item.coords, arriveBy, providerFor(mode)),
        minutes: travel.minutes,
        km: travel.km,
        flag: (evidence) => {
          travel.mislabelled = evidence;
        },
      });
    }
    try {
      const probes = await flagMislabelledWalks(audits, arriveBy);
      if (probes > 0) notes.push(`checked ${probes} suspiciously fast walk(s) against the timetable`);
    } catch (e) {
      // Never at the cost of the measurements themselves.
      notes.push(`ferry check skipped: ${(e as Error).message}`);
    }
  }
  flushCache();

  for (const item of items) {
    if (item.travel == null) {
      if (item.coords) report.unresolved++;
    } else {
      report.routed++;
      report.precision[item.travel.precision]++;
    }
  }
  report.geocodeCalls = geocodeCalls;

  if (origin.precision !== "building") {
    notes.push(
      `origin "${originQuery}" resolved only to precision:"${origin.precision}" — every time ` +
        `shares that error. Pass exact "lat,lng" for a precise origin.`,
    );
  }
  if (report.precision.street || report.precision.area) {
    notes.push(
      `${report.precision.street} listing(s) matched the right street but not the exact ` +
        `building (+/- a block), and ${report.precision.area} only a locality centroid. ` +
        `Check each listing's travel.precision before quoting its time as exact.`,
    );
  }
  if (report.unresolved) {
    notes.push(
      `${report.unresolved} listing(s) could not be geocoded or routed. They carry ` +
        `travel:null and were NOT estimated.`,
    );
  }
  if (notes.length) report.notes = notes;
  return report;
}

/* -------------------------------------------------------------- geocoding -- */

export interface GeocodedPlace {
  /** Echoed back, so a caller can match answers to questions without ordering. */
  query: string;
  lat: number;
  lng: number;
  /**
   * `area` is the *correct* answer for a suburb — it is a centroid, and saying so
   * is the difference between a measured position and an indicative one.
   */
  precision: Precision;
  /** Which family answered: `google`, or `osm` for Photon and Nominatim. */
  source: "osm" | "google";
  /** Whether it came off the disk cache rather than a fresh call. */
  cached: boolean;
}

export interface GeocodeReport {
  /** What was configured — `source` on each result is what actually answered. */
  geocoder: string;
  places: number;
  results: GeocodedPlace[];
  /** Queries nothing could place. Never a guess standing in for a position. */
  unresolved: string[];
  geocodeCalls: number;
}

/**
 * Geocode many queries, through the same cache and the same provider chain that
 * routing already uses.
 *
 * Exists because the downstream pipeline had its own Nominatim client for suburb
 * centroids while calling this server for everything else — the same split that
 * put two Trip Planner clients in two repositories (ADR 0004 downstream). This
 * one is strictly better than the copy it replaces: a provider chain rather than
 * one provider, a disk cache, and `geoExpired` honouring Google's 30-day licence
 * term on cached coordinates.
 *
 * Rate limiting is per-provider inside `geocodeUncached`, so a batch is no
 * ruder than the same queries one at a time.
 */
export async function geocodePlaces(
  queries: string[],
  wantLocality = false,
): Promise<GeocodeReport> {
  geocodeCalls = 0;
  const results: GeocodedPlace[] = [];
  const unresolved: string[] = [];

  for (const query of queries) {
    let hit: GeocodeHit | null = null;
    try {
      hit = await geocodeCached(query, wantLocality);
    } catch {
      // A dead geocoder is not a fact about this place. It joins `unresolved`,
      // which a caller must treat as "unknown", never as "nowhere".
    }
    if (!hit) {
      unresolved.push(query);
      continue;
    }
    results.push({
      query,
      lat: hit.lat,
      lng: hit.lng,
      precision: hit.precision,
      source: hit.src,
      cached: hit.cached,
    });
  }

  flushCache();
  return { geocoder: GEOCODER, places: queries.length, results, unresolved, geocodeCalls };
}

/* ----------------------------------------------------------------- places -- */

/** One place to measure from, with the caller's own identifier echoed back. */
export interface PlaceOrigin {
  id: string;
  coord: Coord;
}

export interface PlaceLeg {
  id: string;
  minutes: number;
  km: number;
  /**
   * What the journey is made of, when the provider says. Present on `transit`
   * answered by TfNSW; absent on road modes and on Google-answered transit,
   * neither of which reports legs.
   */
  journey?: Journey;
  /** Present on a `walk` that is really a ferry crossing — see `MislabelledWalk`. */
  mislabelled?: MislabelledWalk;
}

export interface RoutePlacesReport {
  destination: { query: string; lat: number; lng: number; precision: Precision };
  mode: TravelMode;
  router: string;
  arriveBy: string | null;
  places: number;
  legs: PlaceLeg[];
  /** Ids with no answer. Never a straight line standing in for a measurement. */
  unroutable: string[];
  matrixCalls: number;
  cachedLegs: number;
}

/**
 * N origins → one destination.
 *
 * The opposite direction from `matrix`, and deliberately so. A commute is
 * measured *into* the office, and with a transit `arrivalTime` the direction is
 * a real difference rather than a formality — Sydney's peak timetable is not
 * symmetric, so "leave the office and reach Epping by 9am" is a different number
 * from "reach the office from Epping by 9am".
 *
 * Walk and drive are symmetric enough to ask the configured router the other way
 * round, which is why only the Google path is written out here.
 */
/**
 * Transit, one origin at a time, from TfNSW.
 *
 * `computeRouteMatrix` takes a thousand origins in a request; the Trip Planner
 * takes one. That is the price of legs, and at 5 requests a second against a
 * 60,000-a-day allowance it is affordable for the few hundred origins a commute
 * question asks about. One origin failing leaves the rest measured — where a
 * failed matrix call loses the whole batch.
 */
async function tfnswManyToOne(
  origins: Coord[],
  destination: Coord,
  arriveBy: string,
  key: string,
): Promise<MatrixLeg[]> {
  const when = new Date(arriveBy);
  const out: MatrixLeg[] = [];
  for (const [index, origin] of origins.entries()) {
    if (index > 0) await sleep(TFNSW_MIN_INTERVAL_MS);
    try {
      // `ferryAvailable` is read off the whole list, which is the only place it
      // exists — one journey cannot say whether a ferry serves the pair.
      const journeys = await tripJourneys(origin, destination, when, key);
      const served = ferryAvailable(journeys);
      const fastest = fastestJourney(journeys);
      out.push(
        fastest
          ? {
              minutes: journeyMinutes(fastest, DEFAULT_WALK_SPEED_KMH),
              km: fastest.metres / 1000,
              journey: {
                ...fastest,
                ferryAvailable: served,
                walkSpeedKmh: DEFAULT_WALK_SPEED_KMH,
              },
            }
          : null,
      );
    } catch (e) {
      // A bad key is not a fact about this origin, and will not fix itself.
      if (e instanceof TfnswError && e.fatal) throw e;
      out.push(null);
    }
  }
  return out;
}

async function manyToOne(
  origins: Coord[],
  destination: Coord,
  mode: TravelMode,
  arriveBy?: string,
): Promise<MatrixLeg[]> {
  if (mode !== "transit" && ROUTER !== "google") {
    return matrix(destination, origins, mode);
  }
  assertRoutable(mode, arriveBy);

  if (mode === "transit") {
    const key = tfnswKey();
    if (key) return tfnswManyToOne(origins, destination, arriveBy as string, key);
  }

  const body: Record<string, unknown> = {
    origins: origins.map((o) => ({
      waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
    })),
    destinations: [
      {
        waypoint: {
          location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
        },
      },
    ],
    travelMode: GOOGLE_TRAVEL_MODE[mode],
  };
  if (mode === "transit") body.arrivalTime = arriveBy;

  const res = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY as string,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,status,condition",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google Routes HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const elements = (await res.json()) as Array<{
    originIndex?: number;
    duration?: string;
    distanceMeters?: number;
    condition?: string;
    status?: { code?: number };
  }>;

  const legs: MatrixLeg[] = origins.map(() => null);
  for (const element of elements) {
    // Indexed by ORIGIN here, not destination — the matrix is the other way up.
    const i = element.originIndex;
    if (i == null || i < 0 || i >= origins.length) continue;
    if (element.status?.code) continue;
    if (element.condition && element.condition !== "ROUTE_EXISTS") continue;
    const seconds = Number.parseFloat(element.duration ?? "");
    if (!Number.isFinite(seconds)) continue;
    legs[i] = { minutes: seconds / 60, km: (element.distanceMeters ?? 0) / 1000 };
  }
  return legs;
}

/**
 * Routed time from each of `origins` to one destination.
 *
 * Built for choosing *which suburbs are worth searching*, not for describing a
 * property. The caller supplies the coordinates, so nothing here is geocoded and
 * no Google position is cached — feed it OSM centroids and the 30-day licence
 * limit never applies. A suburb centroid is `precision: "area"` by nature; that
 * is fine for picking a search envelope and must not be shown as a listing's
 * commute.
 */
export async function routePlaces(
  origins: PlaceOrigin[],
  destinationQuery: string,
  mode: TravelMode,
  arriveBy?: string,
): Promise<RoutePlacesReport> {
  assertRoutable(mode, arriveBy);

  const resolved = await resolveOrigin(destinationQuery);
  const destination: Coord = { lat: resolved.lat, lng: resolved.lng };
  const c = loadCache();

  const legs: PlaceLeg[] = [];
  const unroutable: string[] = [];
  const misses: PlaceOrigin[] = [];
  let cachedLegs = 0;

  for (const place of origins) {
    const hit = c.routes[routeKey(mode, place.coord, destination, arriveBy, providerFor(mode))];
    if (!hit) {
      misses.push(place);
      continue;
    }
    cachedLegs++;
    legs.push({
      id: place.id,
      minutes: Math.round(hit.minutes * 10) / 10,
      km: Math.round(hit.km * 100) / 100,
      ...(hit.journey ? { journey: hit.journey } : {}),
    });
  }

  let matrixCalls = 0;
  for (const group of chunk(misses, targetsPerCall(mode))) {
    let answered: MatrixLeg[];
    try {
      answered = await manyToOne(
        group.map((g) => g.coord),
        destination,
        mode,
        arriveBy,
      );
      matrixCalls++;
    } catch {
      // An outage is not evidence of distance: leave the batch unanswered.
      for (const place of group) unroutable.push(place.id);
      continue;
    }

    group.forEach((place, index) => {
      const leg = answered[index];
      if (!leg) {
        unroutable.push(place.id);
        return;
      }
      c.routes[routeKey(mode, place.coord, destination, arriveBy, providerFor(mode))] = leg;
      cacheDirty = true;
      legs.push({
        id: place.id,
        minutes: Math.round(leg.minutes * 10) / 10,
        km: Math.round(leg.km * 100) / 100,
        ...(leg.journey ? { journey: leg.journey } : {}),
      });
    });
    await sleep(CHUNK_DELAY_MS);
  }

  if (mode === "walk") {
    const coordById = new Map(origins.map((place) => [place.id, place.coord]));
    const audits: WalkAudit[] = [];
    for (const leg of legs) {
      const from = coordById.get(leg.id);
      if (!from) continue;
      audits.push({
        from,
        to: destination,
        cacheKey: routeKey(mode, from, destination, arriveBy, providerFor(mode)),
        minutes: leg.minutes,
        km: leg.km,
        flag: (evidence) => {
          leg.mislabelled = evidence;
        },
      });
    }
    // A failed check leaves every measurement standing; it only leaves them
    // unannotated, which is what they were before this existed.
    await flagMislabelledWalks(audits, arriveBy).catch(() => 0);
  }
  flushCache();

  return {
    destination: {
      query: destinationQuery,
      lat: resolved.lat,
      lng: resolved.lng,
      precision: resolved.precision,
    },
    mode,
    router: routerFor(mode),
    arriveBy: arriveBy ?? null,
    places: origins.length,
    legs,
    unroutable,
    matrixCalls,
    cachedLegs,
  };
}

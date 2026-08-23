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
 * Neither models traffic-light delay, so CBD walk times read a few minutes
 * optimistic. Treat them as good to about ±3 min, not to the minute.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Coord {
  lat: number;
  lng: number;
}

export type TravelMode = "walk" | "drive";

/**
 * How well the address resolved. `area` means the geocoder gave back a suburb or
 * locality centroid rather than the building — the time is indicative only.
 */
export type Precision = "building" | "street" | "area";

export interface Travel {
  minutes: number;
  km: number;
  mode: TravelMode;
  precision: Precision;
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

const CACHE_PATH =
  process.env.REALESTATE_MCP_DISTANCE_CACHE ??
  join(homedir(), ".realestate-mcp", "distance-cache.json");

const ROUTER = (process.env.REALESTATE_MCP_ROUTER ?? "valhalla").toLowerCase();
const GEOCODER = (process.env.REALESTATE_MCP_GEOCODER ?? "photon").toLowerCase();
const ORS_KEY = process.env.ORS_API_KEY;

const VALHALLA_URL =
  process.env.REALESTATE_MCP_VALHALLA_URL ?? "https://valhalla1.openstreetmap.de/sources_to_targets";

const MAX_TARGETS = 45;
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
}

interface CacheShape {
  routes: Record<string, { minutes: number; km: number }>;
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
const routeKey = (mode: TravelMode, o: Coord, d: Coord): string =>
  `${mode}|${r5(o.lat)},${r5(o.lng)}|${r5(d.lat)},${r5(d.lng)}`;

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

let geocodeCalls = 0;

/** Geocode one address string, trying the primary geocoder then the fallback. */
async function geocodeUncached(query: string): Promise<GeoResult | null> {
  const primary = GEOCODER === "nominatim" ? nominatimGeocode : photonGeocode;
  const secondary = GEOCODER === "nominatim" ? photonGeocode : nominatimGeocode;
  const primaryDelay = GEOCODER === "nominatim" ? NOMINATIM_DELAY_MS : PHOTON_DELAY_MS;

  try {
    geocodeCalls++;
    const hit = await primary(query);
    await sleep(primaryDelay);
    // A suburb centroid is barely better than nothing — try the other one first.
    if (hit && hit.precision !== "area") return hit;
    try {
      geocodeCalls++;
      const alt = await secondary(query);
      await sleep(GEOCODER === "nominatim" ? PHOTON_DELAY_MS : NOMINATIM_DELAY_MS);
      if (alt && alt.precision !== "area") return alt;
      return hit ?? alt;
    } catch {
      return hit;
    }
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

async function geocodeCached(query: string): Promise<GeoResult | null> {
  const c = loadCache();
  const k = query.trim().toLowerCase();
  const hit = c.geo[k];
  if (hit) return hit;

  const fresh = await geocodeUncached(query);
  if (!fresh) return null;
  c.geo[k] = fresh;
  cacheDirty = true;
  return fresh;
}

/* ---------------------------------------------------------------- routers -- */

type MatrixLeg = { minutes: number; km: number } | null;

async function valhallaMatrix(
  origin: Coord,
  targets: Coord[],
  mode: TravelMode,
): Promise<MatrixLeg[]> {
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

const matrix = ROUTER === "ors" ? orsMatrix : valhallaMatrix;

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
): Promise<TravelReport> {
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
    router: ROUTER,
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

    const hit = c.routes[routeKey(mode, origin, item.coords)];
    if (hit) {
      item.travel = {
        minutes: Math.round(hit.minutes * 10) / 10,
        km: Math.round(hit.km * 100) / 100,
        mode,
        precision: geo.precision,
      };
    } else {
      misses.push({ item, coord: item.coords });
    }
  }

  // Pass 3 — one matrix request per chunk of uncached destinations.
  for (const group of chunk(misses, MAX_TARGETS)) {
    if (report.matrixCalls > 0) await sleep(CHUNK_DELAY_MS);
    try {
      const legs = await matrix(
        origin,
        group.map((g) => g.coord),
        mode,
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
        };
        c.routes[routeKey(mode, origin, g.coord)] = { minutes: leg.minutes, km: leg.km };
        cacheDirty = true;
      });
    } catch (e) {
      for (const g of group) g.item.travel = null;
      notes.push(`routing request failed: ${(e as Error).message}`);
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

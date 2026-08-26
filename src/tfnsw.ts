/**
 * Public transport journeys from Transport for NSW's Trip Planner.
 *
 * ## Why this exists when Google already answered transit
 *
 * Google answers *how long*. It cannot answer *what the journey is*, because
 * `computeRouteMatrix` — the only endpoint that batches — returns a duration and
 * a distance and no legs at any field mask. So `Travel.mode` was only ever the
 * mode that was **requested**, echoed back, and a consumer could not tell a
 * train from a ferry from a walk that Google happened to answer a transit
 * question with.
 *
 * That is not academic. In the downstream project, 10 of 265 listings displayed
 * a walk as "public transport" — the worst a 350 m stroll — and six displayed a
 * ferry crossing as a "walk", because asking Google to walk from Balmain East
 * returns walking steps for a journey across open water.
 *
 * TfNSW answers in **legs**, each with a product class, so "walk to Balmain East
 * Wharf · F4 ferry to Barangaroo Wharf · walk to 289 Kent St" is measured rather
 * than inferred. It is also the operator's own planner, free at 60,000 calls a
 * day, and where Google sources its Sydney timetables anyway.
 *
 * ## The trade, stated plainly
 *
 * One request per origin, where `computeRouteMatrix` takes up to a thousand. For
 * a few hundred origins that is fine at 5 requests a second and costs nothing;
 * for a whole envelope sweep it would not be, which is why `matrix()` still
 * sends road modes to the batched routers and only transit comes here.
 *
 * The two providers agree on services once walking speed is normalised — a ferry
 * leg times identically in both — and diverge on buses, where they sometimes
 * pick different journeys. TfNSW's answer wins because it is the operator's.
 *
 * ## Walk legs are re-timed, not trusted
 *
 * TfNSW walks people at about 3.6 km/h. Its walk-leg *durations* are also padded
 * on journeys with a change, carrying transfer buffer and slack absorbed from
 * the arrive-by constraint — one measured leg is 231 m in 8 minutes, or
 * 1.7 km/h. So `journeyMinutes` uses each walk leg's **distance** at a caller-
 * supplied speed, each service leg's **timetabled duration**, and the genuine
 * waiting between services. Timetables are fact; walking speed is an assumption,
 * and this makes it the caller's to state.
 */

const ENDPOINT = "https://api.transport.nsw.gov.au/v1/tp/trip";
const HTTP_TIMEOUT_MS = 20_000;

/** `transportation.product.class`. 99 and 100 are both footpaths. */
export const PRODUCT_CLASS = {
  train: 1,
  metro: 2,
  lightRail: 4,
  bus: 5,
  coach: 7,
  ferry: 9,
  schoolBus: 11,
  walk: 99,
  footpath: 100,
  cycle: 107,
} as const;

const WALK_CLASSES = new Set<number>([PRODUCT_CLASS.walk, PRODUCT_CLASS.footpath]);

export const CLASS_LABEL: Readonly<Record<number, string>> = {
  [PRODUCT_CLASS.train]: "train",
  [PRODUCT_CLASS.metro]: "metro",
  [PRODUCT_CLASS.lightRail]: "light rail",
  [PRODUCT_CLASS.bus]: "bus",
  [PRODUCT_CLASS.coach]: "coach",
  [PRODUCT_CLASS.ferry]: "ferry",
  [PRODUCT_CLASS.schoolBus]: "school bus",
  [PRODUCT_CLASS.walk]: "walk",
  [PRODUCT_CLASS.footpath]: "walk",
  [PRODUCT_CLASS.cycle]: "cycle",
};

/**
 * Default walking speed for re-timing, km/h. Measured rather than picked: the
 * median of 279 Google-routed land walks in the downstream ledger (4.053 min,
 * 4.324 median, 4.326 mean, 4.625 max). Callers can override.
 */
export const DEFAULT_WALK_SPEED_KMH = 4.324;

/** Bronze plan allows 5 requests a second. Stay under it rather than at it. */
export const MIN_REQUEST_INTERVAL_MS = 250;

export interface JourneyLeg {
  /** See `PRODUCT_CLASS`. */
  productClass: number;
  /** `F4`, `T2`, `389`. Null on a walk leg. */
  service: string | null;
  /** "Circular Quay to Pyrmont Bay". Null on a walk leg. */
  serviceDescription: string | null;
  /** "15 Johnston St", "Balmain East Wharf", "Town Hall Station". */
  from: string;
  to: string;
  /** As TfNSW timed it. Only meaningful on a service leg — see the header. */
  minutes: number;
  metres: number;
}

export interface Journey {
  legs: JourneyLeg[];
  walkMetres: number;
  /** Timetabled service time, minutes. Trusted. */
  serviceMinutes: number;
  /** Waiting between one service arriving and the next departing. */
  waitMinutes: number;
  /** Door to door as TfNSW timed it, on its own walking speed. */
  providerMinutes: number;
  /** Every leg on foot — a "transit" answer that is really a walk. */
  isWalk: boolean;
  hasFerry: boolean;
  /** Changes of vehicle. */
  interchanges: number;
  /** Whole-journey metres, summed along each leg's returned path. */
  metres: number;
}

interface RawPlace {
  name?: string;
  disassembledName?: string;
  departureTimePlanned?: string;
  arrivalTimePlanned?: string;
}

interface RawLeg {
  duration?: number;
  distance?: number;
  coords?: [number, number][];
  origin?: RawPlace;
  destination?: RawPlace;
  transportation?: {
    disassembledName?: string;
    number?: string;
    description?: string;
    product?: { class?: number };
  };
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle metres along a `[lat, lon]` path. */
function pathMetres(coords: readonly [number, number][] | undefined): number {
  if (!coords || coords.length < 2) return 0;
  const rad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const [lat1, lon1] = coords[i - 1];
    const [lat2, lon2] = coords[i];
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

/**
 * A leg endpoint's short name. `disassembledName` drops the suburb TfNSW repeats
 * on every stop ("Balmain East Wharf, Balmain East"), which reads badly once
 * every leg carries one.
 */
function placeName(place: RawPlace | undefined, fallback: string): string {
  return place?.disassembledName?.trim() || place?.name?.trim() || fallback;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function toJourney(rawLegs: RawLeg[]): Journey | null {
  if (rawLegs.length === 0) return null;

  const legs: JourneyLeg[] = [];
  let walkMetres = 0;
  let serviceSeconds = 0;
  let waitSeconds = 0;
  let metres = 0;
  let previousArrival: number | null = null;

  for (const raw of rawLegs) {
    const productClass = raw.transportation?.product?.class;
    if (productClass === undefined || raw.duration === undefined) return null;

    const departure = Date.parse(raw.origin?.departureTimePlanned ?? "");
    const arrival = Date.parse(raw.destination?.arrivalTimePlanned ?? "");
    const walk = WALK_CLASSES.has(productClass);

    // A walk leg's own `distance` is the routed footpath and beats the polyline;
    // a service leg has none, so its path is the only measure available.
    const legMetres = walk ? (raw.distance ?? pathMetres(raw.coords)) : pathMetres(raw.coords);
    metres += legMetres;

    if (walk) {
      walkMetres += legMetres;
    } else {
      serviceSeconds += raw.duration;
      if (previousArrival !== null && Number.isFinite(departure)) {
        waitSeconds += Math.max(0, (departure - previousArrival) / 1000);
      }
    }
    if (Number.isFinite(arrival)) previousArrival = arrival;

    legs.push({
      productClass,
      service: walk
        ? null
        : (raw.transportation?.disassembledName ?? raw.transportation?.number ?? null),
      serviceDescription: walk ? null : (raw.transportation?.description?.trim() || null),
      from: placeName(raw.origin, "start"),
      to: placeName(raw.destination, "destination"),
      minutes: round1(raw.duration / 60),
      metres: Math.round(legMetres),
    });
  }

  const first = Date.parse(rawLegs[0].origin?.departureTimePlanned ?? "");
  const last = Date.parse(rawLegs.at(-1)?.destination?.arrivalTimePlanned ?? "");
  const serviceLegs = legs.filter((leg) => !WALK_CLASSES.has(leg.productClass));

  return {
    legs,
    walkMetres: Math.round(walkMetres),
    serviceMinutes: round1(serviceSeconds / 60),
    waitMinutes: round1(waitSeconds / 60),
    providerMinutes:
      Number.isFinite(first) && Number.isFinite(last) ? round1((last - first) / 60000) : 0,
    isWalk: serviceLegs.length === 0,
    hasFerry: serviceLegs.some((leg) => leg.productClass === PRODUCT_CLASS.ferry),
    interchanges: Math.max(0, serviceLegs.length - 1),
    metres: Math.round(metres),
  };
}

/**
 * Door-to-door minutes with the walking re-timed at `speedKmh`.
 *
 * Walking faster does not let anyone catch an earlier service — it lets them
 * leave home later, which is the same saving, so this holds for an arrive-by
 * journey.
 */
export function journeyMinutes(journey: Journey, speedKmh = DEFAULT_WALK_SPEED_KMH): number {
  return (journey.walkMetres / 1000 / speedKmh) * 60 + journey.serviceMinutes + journey.waitMinutes;
}

/** "walk · F4 ferry · walk". */
export function describeJourney(journey: Journey): string {
  return journey.legs
    .map((leg) => {
      const label = CLASS_LABEL[leg.productClass] ?? `class ${leg.productClass}`;
      return leg.service ? `${leg.service} ${label}` : label;
    })
    .join(" · ");
}

export class TfnswError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** 401/403 mean the key is wrong; retrying the rest is pointless. */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "TfnswError";
  }
}

export function tfnswKey(): string | undefined {
  return process.env.TFNSW_API_KEY?.trim() || undefined;
}

/**
 * Every journey offered from one coordinate to another, arriving by a moment.
 *
 * **Coordinates go in longitude-first** — the one detail here that silently
 * returns the wrong side of the harbour if reversed.
 *
 * Returns `[]` when the planner has no route, which is a real answer about a
 * place. It throws only when the call itself failed, so a caller can tell
 * "nowhere to go" from "we did not ask properly".
 */
export async function tripJourneys(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  arriveBy: Date,
  key: string,
  numberOfTrips = 5,
): Promise<Journey[]> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(arriveBy);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const query = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: "EPSG:4326",
    depArrMacro: "arr",
    itdDate: `${part("year")}${part("month")}${part("day")}`,
    itdTime: `${part("hour")}${part("minute")}`,
    type_origin: "coord",
    name_origin: `${origin.lng}:${origin.lat}:EPSG:4326`,
    type_destination: "coord",
    name_destination: `${destination.lng}:${destination.lat}:EPSG:4326`,
    calcNumberOfTrips: String(numberOfTrips),
    TfNSWTR: "true",
  });

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?${query}`, {
      headers: { Authorization: `apikey ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TfnswError(`TfNSW request failed: ${(cause as Error).message}`, null, false);
  }

  if (!res.ok) {
    const fatal = res.status === 401 || res.status === 403;
    throw new TfnswError(
      fatal
        ? `TfNSW rejected TFNSW_API_KEY (HTTP ${res.status})`
        : `TfNSW HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      res.status,
      fatal,
    );
  }

  const payload = (await res.json()) as { journeys?: { legs?: RawLeg[] }[] };
  return (payload.journeys ?? [])
    .map((journey) => toJourney(journey.legs ?? []))
    .filter((journey): journey is Journey => journey !== null);
}

/**
 * The fastest way in by *our* clock rather than TfNSW's, which is not always the
 * same ordering — re-timing the walk favours journeys with more walking in them.
 */
export function fastestJourney(
  journeys: readonly Journey[],
  speedKmh = DEFAULT_WALK_SPEED_KMH,
): Journey | null {
  let best: Journey | null = null;
  let bestMinutes = Infinity;
  for (const journey of journeys) {
    const minutes = journeyMinutes(journey, speedKmh);
    if (minutes < bestMinutes) {
      best = journey;
      bestMinutes = minutes;
    }
  }
  return best;
}

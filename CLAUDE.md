# sydney-rental-data-pipeline — working notes

The data pipeline behind ../SydneyRealEstateFindings: it reads realestate.com.au
through a real Chrome (patchright), measures travel, scores, publishes photos
and writes that repo's `data/`. The MCP server it used to be is one subcommand
now (`node dist/cli.js mcp`), kept for interactive `search_listings` /
`get_listing` from Claude Code. README.md has the command table; docs/history/MIGRATION.md
is the record of how the scripts got here and what Phase 2 still owes.

`src/browser.ts` session + Kasada handling · `src/parse.ts` hydration-blob
extraction · `src/search.ts` URL grammar + suggest API · `src/images.ts` photo
fetching · `src/distance.ts` geocoding, routing, the disk cache ·
`src/tfnsw.ts` Trip Planner legs · `src/lib/search-listings.ts` the search as a
function · `src/mcp.ts` the four-tool adapter · `src/cli.ts` the entry point ·
`src/setup.ts` interactive warm-up · `src/env.ts` loads `.env` first.

`src/stages/` is the run — capture, build, replay, envelope, enrich, validate,
reset, audit, and `run`, which composes them — each a module exporting
`main(argv)` that `cli.ts` imports compiled. `src/lib/` is their logic
(scoring, ledger, search planning, walkability, photos/R2). Both were the
findings repo's `scripts/` until docs/history/PHASE2.md moved them here, pointed them at the
`sydney-rental-schema` package and gave them entry points. A stage signals
failure by **throwing** (`src/lib/stage-error.ts`), never by exiting — that is
what lets `run` compose them and say which one stopped. `test/` is the former
`check:*` scripts as `node --test` suites; nothing compiles TypeScript at run
time, and there is no tsx here.

**Byte-identical replay of both committed runs is the invariant** —
`node dist/cli.js replay …` for each, then
`git -C ../SydneyRealEstateFindings diff --stat data/` must print nothing.
`npm run build` builds both configs (`dist/` and `dist-test/`); `npm test` runs
the suites; `npm run typecheck` type-checks everything without emitting.

## After changing server code, run the reload script

```bash
./scripts/reload-mcp.ps1
```

Rebuilds, kills Chrome holding the browser profile, kills the server process(es),
and probes whether the profile is still warm. Run it **once after a batch of
edits**, not after each file. `-CheckOnly` inspects without changing anything;
`-NoBuild` skips compilation.

It aborts before killing anything if the build fails, so a syntax error can't
leave a dead server behind.

## Reload vs restart vs setup — three different things

| Changed | Action |
|---|---|
| Behaviour of an existing tool | reload script; server respawns on next tool call |
| **Added / renamed a tool, or changed its input schema** | **restart Claude Code** |
| Tools return "Blocked by bot protection" | `node dist/cli.js setup` |

The MCP tool list is negotiated **once** during the connection handshake and
cached for the session. Killing the server picks up new *code* immediately, but a
newly added tool stays invisible until Claude Code restarts. Verified empirically
— don't assume a reload exposed a new tool.

`setup` is unrelated to either. It warms a Kasada token into
`~/.realestate-mcp/profile`, which persists across restarts and reboots. Only
re-run it when calls actually start failing with the bot-protection error.

## Scripts must use a separate browser profile

Chrome takes an **exclusive lock on its user-data-dir**. Any script that calls
`fetchPage` while the MCP server is live will fight it for that lock. The one
deliberate exception is `capture` (`src/stages/capture.ts`): it wants the warm
profile, so it cannot run while Claude Code has the adapter up — disconnect the
server or run the reload script first.

Point ad-hoc scripts at a different profile:

```powershell
$env:REALESTATE_MCP_PROFILE = "<some scratch dir>"
```

This is why the lock bug stayed hidden for so long — every test script used its
own profile, so nothing ever contended until a real `setup` run wanted the same
directory the server already held.

## Kasada: what does and does not work

Do not "fix" a 429 by trying raw HTTP, bundled Chromium, or a cold headless
launch. All three are already known to fail:

- Raw HTTP to any endpoint (`lexa.realestate.com.au/graphql`,
  `services.realestate.com.au`, page URLs) → 429 + `x-kpsdk-ct`
- Playwright headless, with or without anti-automation flags → 429
- patchright + real Chrome headless from a **cold** profile → 429

What works: patchright + `channel: "chrome"` + persistent profile, warmed
**headed once**. Headless works from then on. A 429 almost always means the
profile went cold, not that the approach is wrong.

`suggest.realestate.com.au/consumer-suggest/suggestions` is the one unprotected
endpoint — plain `fetch`, no browser. `i2.au.reastatic.net` (images) is also
unprotected.

## Parser traps

- The app **deletes `window.ArgonautExchange` after hydration.** Reading the live
  global returns `undefined` on a page that loaded fine. Parse the `<script>`
  tag's source text.
- Results split into `results.exact` **and** `results.surrounding`. Reading only
  `exact` silently drops up to two-thirds of a page. Surrounding entries are
  flagged `isSurrounding: true` — they can be in suburbs across water, so filter
  on the listing's own suburb for anything geographic.
- Search pages and detail pages have **different shapes**: search is
  `buySearch.results.exact.items[].listing`; detail is `details.listing`.
- `sizeUnit` is sometimes a string and sometimes an object — use `formatSize`,
  never string-concatenate it.

## REA URL filter grammar

Bed/bath/car chain under a **single leading `with-`**:

```
/rent/property-apartment-with-2-bedrooms-1-car-space-in-sydney,+nsw+2000/list-1
```

**A bare segment is silently ignored.** `property-apartment-1-car-space-…`
returns HTTP 200 and a normal-looking page with the filter simply not applied.
When adding a filter, verify it by checking `totalResults` actually moves —
never by checking the response was 200.

Client-side filtering on returned fields is authoritative; treat URL filters as
an optimisation that reduces pages fetched.

## Travel times (`src/distance.ts`)

`search_listings` takes `travelFrom` (address or `"lat,lng"`), `travelMode`
(`walk`/`drive`/`transit`), `travelArriveBy`, `maxTravelMinutes` and
`sortByTravel`. Each listing gains `travel: { minutes, km, mode, precision }`.

**Search results carry no coordinates.** Verified against a live page:
`listing.address` has only display/suburb/state/postcode, and a deep scan for any
lat/lng-shaped key across every GraphQL payload finds nothing — a 1 MB cached
result page has zero occurrences of `"geocode"` or `"latitude"`. So positions for
a *search* must be geocoded from the address string, which is why everything
below matters.

**Detail pages are the exception.** `address.display.geocode` carries
`{ latitude, longitude }` for the exact building, so `get_listing` returns real
coordinates with no geocoding at all. It costs one page fetch per listing, which
makes it an upgrade for a shortlist rather than a way to position a whole search.
`coords()` in `parse.ts` probes that path first — it was missing it until
2026-08-24, so `get_listing` silently returned no coordinates despite having them.

Geocoding traps, all found the hard way:

- **Abbreviated street types wreck ranking.** `"4 Bridge St, Sydney"` returns a
  *street lamp* on King Street Cycleway as its top hit; `"4 Bridge Street"`
  returns the right building. Always run `expandStreetTypes` first.
- **Never match a POI `name` against a street name.** `"24-26 Point Street,
  Pyrmont"` matched **"Pyrmont Point Hotel"** — a pub on John Street — because
  the name contains "Point". Only a feature that *is* a street (`type:"street"`
  or `osm_key:"highway"`) may be matched on `name`; otherwise the `street` field
  is authoritative and a mismatch rejects the candidate outright.
- **Check the postcode.** "4 Bridge Street" also exists in Epping and Rydalmere.
- Right street + wrong house number is `precision:"street"`, never `"building"`.
  Expect most listings to land at street level — that is ±a block, fine for a
  walkability call, but do not quote it as exact.

A wrong geocode produces a *plausible* time, not an obvious error, so validate
by detour ratio (`routed_km / crow_flies_km`): under 1.0 is impossible, and CBD
grid should sit near 1.2–1.4. Pyrmont reads ~1.9 because of the Pyrmont Bridge
water crossing — which is exactly why straight-line distance is not good enough
here.

Batching and caching are the whole design: one geocode per unique *building*
(unit prefixes stripped, so 20 listings in one tower cost one lookup), one
matrix request per 45 destinations, and everything cached forever in
`~/.realestate-mcp/distance-cache.json`. A repeat query makes zero network
calls. **Delete that cache after changing geocoding logic** — it happily holds
the old wrong coordinates.

Routers: `valhalla` (default, FOSSGIS public, no key), `ors`
(`REALESTATE_MCP_ROUTER=ors` + `ORS_API_KEY`), or `google` (Routes API +
`GOOGLE_MAPS_API_KEY`). Geocoders: `photon` (default), `nominatim`, or `google`,
via `REALESTATE_MCP_GEOCODER`. Valhalla and ORS model no traffic-light delay, so
CBD walk times read a few minutes optimistic — treat as ±3 min.

### Transit

**`travelMode: "transit"` never consults `REALESTATE_MCP_ROUTER`.** It has its
own setting, `REALESTATE_MCP_TRANSIT_ROUTER` (`tfnsw` | `google`, obeyed without
fallback); unset, it goes to TfNSW's Trip Planner when `TFNSW_API_KEY` is set
and to Google otherwise — no
free router does public transport, and approximating a train time from road
distance would be the exact fake precision this module exists to remove. Asking
Valhalla for it throws rather than quietly returning a walking time.

Prefer TfNSW. It answers in **legs**, each carrying a product class, so what a
journey is made of is measured rather than echoed back from what was asked for;
Google returns a duration and nothing else at any field mask. `routerFor` reports
which one answered, so a transit group reading `google` means the key is absent.

**It requires `travelArriveBy`**, an RFC 3339 timestamp. A transit time is a
timetable lookup, so the same pair of points is a different number on a Tuesday
at 9am and a Sunday at 3am. There is no defensible default, so there is no
default. The route cache keys on it for the same reason.

Google batches transit at **100 elements per request** — 1,800 listings is 18
calls, not 1,800, which is what makes transit affordable as a search filter at
all. TfNSW's own Trip Planner is one trip per request and cannot.

**Configuration errors fail the whole call; routing outages do not.** The
per-chunk handler in `enrichWithTravel` deliberately absorbs a failed matrix
request so an outage cannot cost the caller their results. A missing key is not
an outage: absorbed, it would hand back every listing with `travel: null`, which
`maxTravelMinutes` *keeps* rather than drops, so a transit search would silently
return the entire unfiltered set as though everything matched. `assertRoutable`
runs up front and throws for exactly this reason — do not move those checks back
inside the try.

### A walk the router put on a ferry

Every router will walk a pedestrian onto a ferry and report the whole thing as
walking. Google returns eight `WALK` steps for Balmain East to the CBD, a journey
across open water, and no field mask on any endpoint names the vehicle. The
numbers cannot correct it either — a stroll, a short ferry hop and a genuine walk
produce indistinguishable `(minutes, km)` pairs, which is why a single threshold
was tried and rejected.

`flagMislabelledWalks` uses two signals, and neither is sufficient alone:

1. **Implied speed** — `km ÷ hours`, off an answer already in hand. Across 285
   walks measured into one Sydney office, the 279 genuine ones sit between 4.053
   and 4.625 km/h and six sit between 5.08 and 6.53, with **nothing** in the 0.44
   km/h between. `WALK_SUSPECT_KMH` is 4.85, the middle of that empty band.
2. **A ferry actually serves the pair** — across *every* journey the Trip Planner
   offers, not just the fastest. Three of the six have a bus as their quickest
   way in, so the chosen journey's own `hasFerry` misses them.

Only what fails the first test costs a request, which is what makes this
affordable on every walk: six of 285 asked, the other 279 settled by arithmetic.
A confirmed case gets `mislabelled` beside its minutes. **The measurement is
never rewritten** — the minutes are what the router really returned, and the
correction is an interpretation of them that a caller is entitled to reject.

Needs `TFNSW_API_KEY`. Without it the check is skipped rather than half-run:
speed alone is a suspicion, not a finding. The probe is cached on the route entry
as `ferryAvailable`, so one pair is asked once; `undefined` there means *never
asked* rather than *no*, which is what lets entries written before this existed
be re-examined instead of quietly passing. A transit journey carries the same
fact inside `journey.ferryAvailable`, where the trip request supplied it free.

### Google's caching limit is a licence term, not a tuning knob

Google's terms allow latitude and longitude to be cached for **at most 30
consecutive days**; only `place_id` may be kept indefinitely. OSM data has no
such limit. So cache entries carry `src` and `at`, and `geoExpired` re-geocodes
Google-sourced positions after 30 days while leaving Photon and Nominatim ones
forever. Entries written before provenance existed have no `src` and are treated
as OSM, which is what they were.

Google is also never used as a *fallback* for an OSM primary — only as an
explicit primary. Falling back silently would spend money nobody asked to spend
and put a hidden expiry on entries the caller believes are permanent.

Costs, if it matters: Compute Route Matrix Essentials is 10k elements/month free
then $5/1k; Geocoding the same. `TRAFFIC_AWARE` would move routing to the Pro
SKU at double that, which is why no clock is ever sent for `drive`.

## Conventions

- Errors surfaced to the model should say what to *do* (see `NotWarmError`), not
  just what broke.
- `get_listing_photos` costs roughly `(w × h) / 750` tokens per image. Keep
  `limit` low and default to a small `size`.
- **Always analyse photos in a subagent**, never inline in the main
  conversation. Spawn one per listing (or small batch), have it call the tool
  itself, and report back a short text verdict. Images are billed wherever they
  land; isolating them keeps the main thread clear.
- Throwaway analysis scripts live in `scratch/` (gitignored).

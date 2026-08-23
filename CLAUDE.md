# realestate-mcp — working notes

MCP server that reads realestate.com.au listings. TypeScript, stdio transport,
driven by a real Chrome via patchright.

`src/browser.ts` session + Kasada handling · `src/parse.ts` hydration-blob
extraction · `src/search.ts` URL grammar + suggest API · `src/images.ts` photo
fetching · `src/index.ts` tool definitions · `src/cli.ts` interactive setup.

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
| Tools return "Blocked by bot protection" | `node dist/index.js setup` |

The MCP tool list is negotiated **once** during the connection handshake and
cached for the session. Killing the server picks up new *code* immediately, but a
newly added tool stays invisible until Claude Code restarts. Verified empirically
— don't assume a reload exposed a new tool.

`setup` is unrelated to either. It warms a Kasada token into
`~/.realestate-mcp/profile`, which persists across restarts and reboots. Only
re-run it when calls actually start failing with the bot-protection error.

## Scripts must use a separate browser profile

Chrome takes an **exclusive lock on its user-data-dir**. Any script that calls
`fetchPage` while the MCP server is live will fight it for that lock.

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
(`walk`/`drive`), `maxTravelMinutes` and `sortByTravel`. Each listing gains
`travel: { minutes, km, mode, precision }`.

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

Routers: `valhalla` (default, FOSSGIS public, no key) or `ors`
(`REALESTATE_MCP_ROUTER=ors` + `ORS_API_KEY`). Geocoders: `photon` (default) or
`nominatim`, via `REALESTATE_MCP_GEOCODER`. Neither router models traffic-light
delay, so CBD walk times read a few minutes optimistic — treat as ±3 min.

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

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

## Conventions

- Errors surfaced to the model should say what to *do* (see `NotWarmError`), not
  just what broke.
- `get_listing_photos` costs roughly `(w × h) / 750` tokens per image. Keep
  `limit` low and default to a small `size`.
- Throwaway analysis scripts live in `scratch/` (gitignored).

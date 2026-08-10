# realestate-mcp

An MCP server that lets Claude Code search realestate.com.au — for-sale, rental, and sold listings, with full property detail.

```
> find me 3-bed houses in Bondi under $5m

  25 listings, 64 total across 3 pages
  1 Miller Street, Bondi NSW 2026     Onsite auction 29 August   5bd 4ba 3car   House
  25 Wellington Street, Bondi         Auction                    5bd 4ba 2car   House
  8B Castlefield Street, Bondi        Buyers Guide $3,000,000    3bd 2ba 1car   House
```

## Requirements

- **Node.js 20+**
- **Google Chrome** installed (the real browser — see [How it works](#how-it-works))

## Setup

```bash
npm install && npm run build
```

Then run the one-time warm-up. A Chrome window opens for a few seconds and closes itself:

```bash
node dist/index.js setup
```

Register with Claude Code:

```bash
claude mcp add realestate -- node "E:/Personal Projects/RealEstateMCP/dist/index.js"
```

## Tools

| Tool | What it does |
|---|---|
| `search_listings` | Search buy / rent / sold by location, with price, bed, bath, car, land-size and property-type filters. 25 results per page. |
| `get_listing` | Full detail for one listing — description, all photos, floorplans, agents, agency ratings, suburb market insights. Takes a URL or bare listing ID. |
| `get_listing_photos` | Returns the actual photographs **as images**, so the model can judge condition, finish quality, natural light and layout rather than just numbers. Optionally includes the floorplan. |
| `resolve_location` | Turn `"bondi"` into canonical suburbs with state and postcode. No browser needed, ~50ms. Use it to disambiguate before searching. |

### Returned fields

Address (with suburb/state/postcode), price display, bedrooms, bathrooms, car spaces, studies, land and building size, property type, agency (with average rating and review count), agents (name, job title, profile URL), inspection times and auction dates as ISO 8601 with offset, description, photo and floorplan URLs.

Results include listings REA blends in from neighbouring suburbs; those are flagged `isSurrounding: true`. They can be across water from the suburb you searched, so filter on each listing's own suburb for anything geographic.

### Photos and token cost

`get_listing_photos` sends real image data into the conversation, which is not free. REA's image URLs carry a `{size}` placeholder, so resolution is chosen at the CDN rather than downscaled locally. Cost is roughly `(width × height) / 750` tokens per image:

| `size` | ~tokens each | 6 images |
|---|---|---|
| `320x240` | 100 | 600 |
| `480x360` | 230 | 1.4k |
| **`640x480`** (default) | **410** | **2.5k** |
| `800x600` | 640 | 3.8k |
| `1024x768` | 1050 | 6.3k |

Keep `limit` small. It's a separate tool from `get_listing` precisely so routine lookups don't drag a dozen images into context.

Note that many REA listings are **virtually staged** — the furniture is digitally inserted and the listing usually says so in the description. Rooms are real, furnishings are not; use the floorplan for dimensions.

## How it works

realestate.com.au is behind [Kasada](https://www.kasada.io/) bot protection. Everything in this server is shaped by that:

- **Raw HTTP does not work.** Every endpoint — including `lexa.realestate.com.au/graphql` and `services.realestate.com.au` — returns `429` with a `x-kpsdk-ct` header. Those APIs are scoped to signed mobile-app tokens.
- **Headless does not work from a cold start.** Plain Playwright, Playwright with anti-automation flags, and even patched Chrome all get `429` on a fresh profile.
- **What works:** [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) driving your *real installed Chrome* with a persistent profile, warmed up **headed once**. Kasada issues its challenge, the browser solves it, and the token persists in the profile directory. **Headless works from then on.**

That's why setup opens a visible window once, and why bundled Chromium isn't used — it's fingerprinted and blocked.

Data is read from the page's server-side hydration blob rather than the DOM:

```
<script>window.ArgonautExchange={ "resi-property_listing-experience-web": {
  "urqlClientCache": "{\"<hash>\":{\"data\":\"{…}\"}}" }}</script>
     └─> buySearch.results.exact.items[].listing   ← the real Lexa GraphQL objects
```

Two things that will bite you if you modify the parser:

- The app **deletes `window.ArgonautExchange` after hydration**. Reading the live global returns `undefined` on a page that loaded perfectly fine. Parse the `<script>` tag's source text.
- Results are split into `results.exact` **and** `results.surrounding`. Reading only `exact` silently drops up to two-thirds of a page.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `REALESTATE_MCP_PROFILE` | `~/.realestate-mcp/profile` | Where the warm browser profile lives |
| `REALESTATE_MCP_CHANNEL` | `chrome` | Browser channel; `msedge` also works |
| `REALESTATE_MCP_TIMEOUT` | `60000` | Navigation timeout in ms |
| `REALESTATE_MCP_IDLE` | `30000` | Idle ms before the browser closes and releases the profile lock |

## Development

The server runs compiled JS, and Claude Code spawns it as a child process — so edits to `src/` do nothing until that process is replaced.

```bash
./scripts/reload-mcp.ps1
```

Rebuilds, kills any Chrome holding the browser profile, kills the server process(es), and reports whether the profile is still warm. `-CheckOnly` inspects without changing anything; `-NoBuild` skips compilation. It aborts before killing anything if the build fails.

It only targets node processes referencing this repo's `dist/index.js` and Chrome processes referencing the `realestate-mcp` profile — your normal browser is untouched.

**Three different actions for three different changes:**

| Changed | Action |
|---|---|
| Behaviour of an existing tool | reload script — the server respawns on the next tool call |
| **Added / renamed a tool, or changed its input schema** | **restart Claude Code** |
| Calls fail with the bot-protection error | `node dist/index.js setup` |

The MCP tool list is negotiated once during the connection handshake and cached for the session. Killing the server picks up new code immediately, but a newly added tool stays invisible until Claude Code restarts.

`setup` is independent of both — it warms a Kasada token into the profile directory, which survives restarts and reboots.

**Ad-hoc scripts need their own profile.** Chrome takes an exclusive lock on its user-data-dir, so anything calling `fetchPage` while the server is live will fight it for that lock:

```powershell
$env:REALESTATE_MCP_PROFILE = "<scratch dir>"
```

**Verify new URL filters by result count, not status code.** REA silently ignores malformed filter segments and still returns HTTP 200 with a normal-looking page. See `CLAUDE.md` for the segment grammar.

## Troubleshooting

**"Blocked by realestate.com.au bot protection"** — the profile has gone cold. Re-run `node dist/index.js setup`. Token lifetime is not documented; expect to re-warm occasionally. Check current state without changing anything with `./scripts/reload-mcp.ps1 -CheckOnly`.

**"Could not open the browser profile — another process is using it"** — Chrome allows one process per profile directory. Something else holds it: a `setup` run still open, a stray Chrome, or a script pointed at the same profile as the running server. `./scripts/reload-mcp.ps1` clears it.

**`setup` appears to do nothing, and tools stay blocked** — this was a real bug, now fixed. The server used to hold the profile lock for its whole lifetime, so `setup` in another terminal could never acquire it, and the running Chrome kept serving the cookies it loaded at startup. The browser now closes after `REALESTATE_MCP_IDLE`, and `fetchPage` retries once with a fresh context when it hits a block.

**"Could not launch Google Chrome"** — install Chrome, or set `REALESTATE_MCP_CHANNEL=msedge`.

**Warm-up fails repeatedly** — rapid requests raise your Kasada score and it takes a while to decay. Wait a few minutes, or try from a different network.

**A filter seems to be ignored** — it probably is. REA drops malformed filter segments silently and still returns 200. Compare `totalResults` against an unfiltered search.

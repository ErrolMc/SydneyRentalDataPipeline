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
| `resolve_location` | Turn `"bondi"` into canonical suburbs with state and postcode. No browser needed, ~50ms. Use it to disambiguate before searching. |

### Returned fields

Address (with suburb/state/postcode), price display, bedrooms, bathrooms, car spaces, studies, land and building size, property type, agency (with average rating and review count), agents (name, job title, profile URL), inspection times and auction dates as ISO 8601 with offset, description, photo and floorplan URLs.

Results include listings REA blends in from neighbouring suburbs; those are flagged `isSurrounding: true`.

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

## Troubleshooting

**"Blocked by realestate.com.au bot protection"** — the profile has gone cold. Re-run `node dist/index.js setup`. Token lifetime is not documented; expect to re-warm occasionally.

**"Could not launch Google Chrome"** — install Chrome, or set `REALESTATE_MCP_CHANNEL=msedge`.

**Warm-up fails repeatedly** — rapid requests raise your Kasada score and it takes a while to decay. Wait a few minutes, or try from a different network.

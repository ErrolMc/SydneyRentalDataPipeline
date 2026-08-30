# sydney-rental-data-pipeline

The data pipeline behind [SydneyRealEstateFindings](../SydneyRealEstateFindings): it searches
realestate.com.au through a real Chrome, measures how far every listing is from where Errol
needs to be, scores it, publishes its photos, and writes the result into the findings repo's
`data/`. The site next door renders that and nothing else (its `docs/adr/0005`).

It is also an MCP server, thinly: `search_listings` and `get_listing` for asking questions from
Claude Code. That used to be the whole program; now it is one subcommand.

```
SydneyRentalDataPipeline/        this repo
  src/            REA scrape + parse, geocode, route (Valhalla/ORS/Google), TfNSW,
                  images — and cli.ts, mcp.ts, setup.ts
  scripts/        the run: capture → build → enrich → check → validate (see below)
  scripts/lib/    scoring, ledger, search planning, walkability, photos/R2
  .env            every key: TFNSW_API_KEY, GOOGLE_MAPS_API_KEY, R2_*, …
  writes to  →    ../SydneyRealEstateFindings/data/   (and its public/images mirror)

SydneyRealEstateFindings/        the site: src/ + data/ + .env.local, five self-checks
```

The two checkouts must sit side by side: the scripts import the site's zod schema
(`src/lib/schema`) across the boundary by relative path, so the schema stays with the data it
describes. `FINDINGS_DIR` relocates the data, not the code. The move is recorded in
[MIGRATION.md](MIGRATION.md).

## Requirements

- **Node.js 20.12+** (`process.loadEnvFile`)
- **Google Chrome** installed (the real browser — see [How it works](#how-it-works))
- The findings repo checked out as `../SydneyRealEstateFindings`, with its own `npm install`
  (the scripts resolve `zod` for the schema files from there; both repos pin 4.4.3)

## Setup

```bash
npm install && npm run build
cp .env.example .env        # then fill in the keys — see Configuration
node dist/cli.js setup      # one-time warm-up: a Chrome window opens for a few seconds
```

Register the MCP adapter with Claude Code (user scope, so it works from either repo):

```bash
claude mcp add realestate -s user -- node "E:/Personal Projects/SydneyRealEstate/SydneyRentalDataPipeline/dist/cli.js" mcp
```

## Running the pipeline

One entry point, `node dist/cli.js <command>`; every `npm run` script in `package.json` is an
alias for one of them, kept so the run protocol's commands still read the same.

| Command | npm alias | What it does |
|---|---|---|
| `setup` | `npm run setup` | Warm the Chrome profile once |
| `capture [--out=…]` | `npm run capture:run` | Search REA per `data/config` and write a capture file. **Ask Errol first** — it drives a real Chrome and spends routing calls. Holds the browser profile: no MCP server may be running |
| `build <capture> [--run-id=…]` | `npm run build:run` | Map a capture into a run: ledger merge, scores, photos to R2, `runs/<id>/run.json`, `knowledge/*`, `index.json` |
| `replay <capture> --run-id=…` | `npm run replay:run` | Rebuild a committed run from its capture. Byte-identical when nothing changed — the migration's own proof |
| `envelope --stage=…` | `npm run build:envelope` | Derive the search envelope (findings `ENVELOPE.md`) |
| `enrich walk\|travel\|transit` | `npm run enrich:walk` etc. | Add walkability / routed travel / transit legs to the ledger |
| `check [name …]` | `npm run check:scoring` etc. | Self-checks. Default `scoring walk searches transit ledger`; also `shares <capture>`, `r2` |
| `validate [--check-remote]` | `npm run validate:data` | Validate the findings repo's `data/` — the gate before a data commit |
| `audit capture <file>` / `audit postcodes` | `npm run audit:*` | Reports; nothing written |
| `reset [--confirm]` | `npm run reset:data` | Destroy runs, photos and knowledge. Dry run without `--confirm` |
| `mcp` | `npm start` | Serve the MCP adapter over stdio |

Paths handed to a command — a capture, `--out`, `--cache`, `--places-out` — resolve against the
current directory, so prefer absolute ones. The committed runs' captures live at
`E:/Personal Projects/SydneyRealEstate/captures/`.

The run protocol itself — what to do in what order, the two human gates, what to commit — is the
findings repo's `AGENT.md`; it runs from here and commits there, because `data/` is versioned
there. Before a data commit, this repo's gate is:

```bash
npm run typecheck && npm run build && npm run check:scoring && npm run check:walk && npm run check:searches && npm run check:transit && npm run check:ledger && npm run validate:data
```

`validate:data -- --check-remote` also verifies every photo path against R2 when the keys are
in. The findings repo has its own, smaller gate for the site.

## The MCP adapter

What Claude Code talks to. Interactive use only: the pipeline calls the same functions
in-process (`scripts/lib/tools.ts`).

| Tool | What it does |
|---|---|
| `search_listings` | Search buy / rent / sold by location, with price, bed, bath, car, land-size and property-type filters. 25 results per page. Optionally narrows by **real routed travel time** from an origin — walk, drive, or public transport — and attaches the measured minutes to every listing. |
| `get_listing` | Full detail for one listing — description, all photos, floorplans, agents, agency ratings, suburb market insights. Takes a URL or bare listing ID. |
| `get_listing_photos` | Returns the actual photographs **as images**, so the model can judge condition, finish quality, natural light and layout rather than just numbers. Optionally includes the floorplan. |
| `resolve_location` | Turn `"bondi"` into canonical suburbs with state and postcode. No browser needed, ~50ms. Use it to disambiguate before searching. |

`geocode_places` and `route_places` used to be tools too. Their only caller was the pipeline,
which no longer needs a wire to reach them.

### Returned fields

Address (with suburb/state/postcode), price display, bedrooms, bathrooms, car spaces, studies, land and building size, property type, agency (with average rating and review count), agents (name, job title, profile URL), inspection times and auction dates as ISO 8601 with offset, description, photo and floorplan URLs.

On a `walk`, a route that is really a ferry crossing carries `mislabelled` — the implied speed that gave it away, the threshold it beat, and confirmation from the timetable that a ferry serves that address. The minutes are left exactly as the router returned them; the flag is the interpretation, kept separate so you can disagree with it. Needs `TFNSW_API_KEY`, and is skipped without one. On `transit` answered by TfNSW, each leg's `journey` reports what the trip is actually made of. See `CLAUDE.md` for both.

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

realestate.com.au is behind [Kasada](https://www.kasada.io/) bot protection. Everything in `src/` is shaped by that:

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

Everything lives in `.env` at this package's root — copy `.env.example`. It is read from the
package root whichever directory a command is run from, and whoever starts the process: a script,
the CLI, or Claude Code spawning the MCP adapter. What is already in the environment wins over
the file, so keep the MCP entry's `env` block empty. Keys belong in `.env`; it is gitignored.

| Env var | Default | Purpose |
|---|---|---|
| `FINDINGS_DIR` | `../SydneyRealEstateFindings` | The site whose `data/` and `public/` this pipeline writes. Only needed when the repos are not side by side |
| `REALESTATE_MCP_PROFILE` | `~/.realestate-mcp/profile` | Where the warm browser profile lives |
| `REALESTATE_MCP_CHANNEL` | `chrome` | Browser channel; `msedge` also works |
| `REALESTATE_MCP_TIMEOUT` | `60000` | Navigation timeout in ms |
| `REALESTATE_MCP_ROUTER` | `valhalla` | **Road modes only — `walk` and `drive`.** `valhalla` (no key), `ors` (needs `ORS_API_KEY`), or `google` (needs `GOOGLE_MAPS_API_KEY`; what the committed runs were measured with). Transit never consults it. Anything unrecognised falls through to Valhalla, which needs no key and would otherwise fail silently — a `configuration error` line goes to stderr instead |
| `REALESTATE_MCP_TRANSIT_ROUTER` | *(unset)* | **`transit` only.** `tfnsw` (needs `TFNSW_API_KEY`; the journey in legs) or `google` (a bare duration). Unset: `tfnsw` when the key is set, `google` otherwise. Set explicitly there is no fallback — `tfnsw` without a key refuses, so a transit number never quietly comes from the other provider |
| `REALESTATE_MCP_GEOCODER` | `photon` | `photon`, `nominatim`, or `google`. Unrecognised falls through to Photon, and is reported the same way. Google is markedly better on Australian unit addresses, which is what decides whether a travel time is measured or a suburb centroid |
| `REALESTATE_MCP_DISTANCE_CACHE` | `~/.realestate-mcp/distance-cache.json` | The geocode + route cache. Point it at the findings repo's `data/knowledge/mcp-cache.json` to have one cache that is committed and shared between machines |
| `TFNSW_API_KEY` | — | Transport for NSW Trip Planner key, and what answers `travelMode: "transit"` whenever it is set. It returns the journey in **legs**, each with a product class, so a walk is distinguishable from a ferry crossing; Google returns a duration and nothing else. Free at 60,000 calls/day — opendata.transport.nsw.gov.au, create an application, add **Trip Planner APIs** |
| `GOOGLE_MAPS_API_KEY` | — | Server key with the **Routes API** and **Geocoding API** enabled. Required for `travelMode: "transit"` unless `TFNSW_API_KEY` is set, and used as the fallback when it is not. Never use a browser key here — a referrer-restricted key cannot sign server-side calls, and a key that works server-side must never be shipped to a browser |
| `ORS_API_KEY` | — | Only read when `REALESTATE_MCP_ROUTER=ors` |
| `REALESTATE_MCP_IDLE` | `30000` | Idle ms before the browser closes and releases the profile lock |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | — | Cloudflare R2, where `build` publishes photos. See [Photo hosting](#photo-hosting). `R2_PUBLIC_BASE_URL` must match the site's `NEXT_PUBLIC_IMAGE_BASE_URL` |

The `REALESTATE_MCP_*` names predate the rename and are hand-maintained in two `.env` files;
they stay.

## Photo hosting

Listing photos are **not in git**. `build` publishes them to a Cloudflare R2 bucket and
mirrors them into the findings repo's `public/images/listings/` (gitignored there) so
`validate` can check them and so a re-upload never means re-downloading from REA.

The findings repo's PLAN.md §2 originally committed photos to the repo, with §11 holding an
escape hatch open — every image path in JSON is site-relative and every render goes through the
site's `src/lib/images.ts`, so moving the files costs one env var and zero JSON changes. That
hatch was taken *before* the first real run rather than after, because photos entering git
history is the one part that would have been expensive to undo. R2 rather than the alternatives
because **egress is free**, and the site's whole job is serving the same photos to phones over
and over.

### One-time setup

1. **Bucket** — Cloudflare dashboard → R2 → *Create bucket*, any name — it goes in `R2_BUCKET`.
   Location Automatic (or APAC).
2. **Public access** — one of:
   - *Public Development URL* (bucket → Settings): free, instant, gives
     `https://pub-<hash>.r2.dev`. Cloudflare rate-limits it and labels it development-only —
     fine for a handful of viewers.
   - *Custom domain*: needs a domain on Cloudflare. Proper CDN caching, no rate limit. Better if
     you have one.
3. **API token** — R2 → *Manage API tokens* → *Create API token*, permission **Object Read &
   Write**, scoped to that bucket. Copy the Access Key ID and Secret Access Key; the secret is
   shown once.
4. **Account ID** — on the R2 overview page.
5. **`.env`** at this package's root (gitignored, never reaches Vercel) — copy `.env.example`
   and fill:

   ```
   R2_ACCOUNT_ID=…
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   R2_BUCKET=<your-bucket>
   R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev
   ```

6. **Verify** — `npm run check:r2`. It uploads a real WebP, reads it back over the *public* URL
   the way a phone would, and cleans up. The public read is the part worth having: a token can
   write perfectly while public access is still off, and you would not find out until photos 404
   on the live site.
7. **Site env** — set `NEXT_PUBLIC_IMAGE_BASE_URL` in the findings repo (`.env.local`, and its
   Vercel project) to the same public base URL.

No CORS configuration is needed: photos are rendered with plain `<img>` tags, not fetched.

`build` refuses to run without R2 configured, rather than writing image paths that would
resolve to nothing (`--local-images` skips uploading, for local testing only). A photo is only
recorded once it has uploaded *and* been mirrored — upload happens first, so a failed upload
leaves nothing behind for a later run to mistake for a real file.

## Development

Two compilers, on purpose. `npm run build` (`tsconfig.json`) compiles `src/` to `dist/` — that is
what the CLI and the MCP adapter run. `npm run typecheck` (`tsconfig.scripts.json`) type-checks
`scripts/` together with `src/` and the findings schema files they import, and emits nothing:
the scripts run through `tsx`, straight from TypeScript, whether via `npm run <script>` or via
`dist/cli.js`, which hands them to tsx one at a time. Run both after any change to either tree.

The scripts are exactly the files that lived in the findings repo's `scripts/`, moved without
changing what they compute — the proof is `replay` reproducing both committed runs byte for
byte, which is worth re-running after any change under `scripts/lib/`:

```bash
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-walk15.json"    --run-id=2026-08-24a
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-transit25.json" --run-id=2026-08-25a
git -C ../SydneyRealEstateFindings diff --stat data/     # must print nothing
```

(`git status` there will still flag the two files — the script writes LF and the working copy
is CRLF. `git checkout -- data/runs/` puts them back.)

The MCP adapter runs compiled JS as a child of Claude Code — so edits to `src/` do nothing until
that process is replaced:

```bash
./scripts/reload-mcp.ps1
```

Rebuilds, kills any Chrome holding the browser profile, kills the server process(es), and reports whether the profile is still warm. `-CheckOnly` inspects without changing anything; `-NoBuild` skips compilation. It aborts before killing anything if the build fails.

It only targets node processes referencing this repo's `dist/cli.js` and Chrome processes referencing the `realestate-mcp` profile — your normal browser is untouched.

**Three different actions for three different changes:**

| Changed | Action |
|---|---|
| Behaviour of an existing tool | reload script — the server respawns on the next tool call |
| **Added / renamed a tool, or changed its input schema** | **restart Claude Code** |
| Calls fail with the bot-protection error | `node dist/cli.js setup` |

The MCP tool list is negotiated once during the connection handshake and cached for the session. Killing the server picks up new code immediately, but a newly added tool stays invisible until Claude Code restarts.

`setup` is independent of both — it warms a Kasada token into the profile directory, which survives restarts and reboots.

**One profile, one process.** Chrome takes an exclusive lock on its user-data-dir. `capture`
uses the same profile as the MCP adapter on purpose (it is the warm one), so a capture cannot run
while Claude Code has the server up — disconnect it, or run the reload script first. Ad-hoc
scripts that call `fetchPage` should point at their own profile:

```powershell
$env:REALESTATE_MCP_PROFILE = "<scratch dir>"
```

**Verify new URL filters by result count, not status code.** REA silently ignores malformed filter segments and still returns HTTP 200 with a normal-looking page. See `CLAUDE.md` for the segment grammar.

## Troubleshooting

**"Blocked by realestate.com.au bot protection"** — the profile has gone cold. Re-run `node dist/cli.js setup`. Token lifetime is not documented; expect to re-warm occasionally. Check current state without changing anything with `./scripts/reload-mcp.ps1 -CheckOnly`.

**"Could not open the browser profile — another process is using it"** — Chrome allows one process per profile directory. Something else holds it: a `setup` run still open, a stray Chrome, a `capture` in progress, or the MCP adapter Claude Code spawned. `./scripts/reload-mcp.ps1` clears it.

**`setup` appears to do nothing, and tools stay blocked** — this was a real bug, now fixed. The server used to hold the profile lock for its whole lifetime, so `setup` in another terminal could never acquire it, and the running Chrome kept serving the cookies it loaded at startup. The browser now closes after `REALESTATE_MCP_IDLE`, and `fetchPage` retries once with a fresh context when it hits a block.

**"Could not launch Google Chrome"** — install Chrome, or set `REALESTATE_MCP_CHANNEL=msedge`.

**Warm-up fails repeatedly** — rapid requests raise your Kasada score and it takes a while to decay. Wait a few minutes, or try from a different network.

**A filter seems to be ignored** — it probably is. REA drops malformed filter segments silently and still returns 200. Compare `totalResults` against an unfiltered search.

**`Cannot find module '../../SydneyRealEstateFindings/src/lib/schema'`** — the findings repo is not checked out beside this one. The scripts import its schema by relative path; `FINDINGS_DIR` does not change that.

**"R2 is not configured — missing … in the pipeline's .env"** — fill the five `R2_*` lines in `.env` (see Photo hosting). `build` and `reset` refuse without them; `validate` only needs them with `--check-remote`.

# MIGRATION — from "MCP server + scripts in the site repo" to "one data pipeline, one dumb site"

Written 2026-08-30 for the agent that executes it. Read all of it before touching a file.
Where this and the code disagree, verify against the code and fix this file.

## The decision (Errol, 2026-08-30)

> "I don't want any scripts in the findings repo. I simply want it to be loading the
> data, not doing any data management. Any data logic should be in the server repo."
>
> "It may not make sense for this to be an MCP server — maybe make it a data pipeline
> of sorts, then the site is dumb."

So, two repos with one direction of data flow:

```
SydneyRentalDataPipeline/     (this repo — was RealEstateMCP)
  src/lib/       scrape+parse REA, geocode, route, TfNSW, scoring, ledger,
                 walkability, images/R2, search planning   ← ALL the logic
  src/cli.ts     `pipeline run | replay | envelope | enrich | check | reset | setup`
  src/mcp.ts     thin optional adapter exposing search_listings / get_listing to Claude Code
  .env           every key: TFNSW_API_KEY, GOOGLE_MAPS_API_KEY, R2_*
  writes to  →   ../SydneyRealEstateFindings/data/

SydneyRealEstateFindings/     dumb: src/ + data/ + .env.local. NO scripts/, no data logic.
```

### Why (so nobody re-litigates it)

- The MCP layer was never the substance. `src/index.ts` is ~400 lines of tool registration
  over plain functions in `search.ts` / `distance.ts` / `tfnsw.ts`. The findings repo's
  pipeline spawned this server over stdio (`scripts/lib/mcp-client.ts`) purely to call
  those functions — paying for a 180 s call timeout, batches of 40, stderr filtering, and
  "rebuild `dist/` or nothing changes".
- The server does **none** of the downstream work. Surveyed 2026-08-30: no scoring, no
  ledger, no walkability/Overpass, no image resize/upload, no run files, no search
  matching, no envelope derivation. All ~9,000 lines of that live in
  `SydneyRealEstateFindings/scripts/` (23 scripts + 16 libs). See *Inventory* below.
- What MCP still buys: interactive `search_listings` from Claude Code, and the
  `get_listing` calls in the absence-resolution step of a run (AGENT.md step 4d). That is
  why the adapter is kept, thin, rather than deleted.

## Non-negotiables

1. **Phase 1 is a pure relocation.** Byte-identical output is the acceptance test: after
   the move, `pipeline replay` of both committed runs (`2026-08-24a`, `2026-08-25a`) must
   produce `run.json` files identical to what is committed. Do not "improve" logic while
   moving it. Improvements are Phase 2, separately committed.
2. **The findings repo's `data/` is the source of truth and its schema does not change**
   in Phase 1. The site's `src/lib/schema/*` zod files stay where they are and keep
   parsing the same files.
3. **Never run a real REA search without asking Errol.** Replays and checks need no
   network. Nothing in Phase 1 requires a search.
4. **No force-push, no history rewrite** in either repo. One commit per logical step
   (listed below) so each can be reverted alone.
5. Git-style `feat:` / `refactor:` / `docs:` subjects, as both repos already use.

## Phase 0 — preflight (do first, ~15 min)

- [ ] Both repos clean and on `master`, in sync with origin (`git status --porcelain`,
      `git pull --ff-only`). They were on 2026-08-30.
- [ ] `node --version` ≥ 20.12 (was v22.18.0) — `process.loadEnvFile` is used.
- [ ] Create `SydneyRentalDataPipeline/.env` from `.env.example` (gitignored). It gets
      **all** keys after Step 4, so create it with these now:
      ```
      TFNSW_API_KEY=
      GOOGLE_MAPS_API_KEY=
      REALESTATE_MCP_GEOCODER=google
      REALESTATE_MCP_ROUTER=valhalla
      REALESTATE_MCP_DISTANCE_CACHE=E:/Personal Projects/SydneyRealEstate/SydneyRealEstateFindings/data/knowledge/mcp-cache.json
      R2_ACCOUNT_ID=
      R2_ACCESS_KEY_ID=
      R2_SECRET_ACCESS_KEY=
      R2_BUCKET=sydney-rental-findings
      R2_PUBLIC_BASE_URL=
      ```
      Errol pastes the values. Leave `.env.local` in the findings repo alone — it is the
      site's (`SITE_PASSWORD`, `AUTH_COOKIE_SECRET`, `DEV_SKIP_AUTH`, `NEXT_PUBLIC_*`).
- [ ] `npm install && npm run build` here; `npm install` in findings.
- [ ] Fix `~/.claude.json`: the `realestate` MCP entries (under the `C:/Users/errol` key and
      the `E:/Personal Projects/SydneyRealEstateFindings` key) still point at
      `E:/Personal Projects/RealEstateMCP/dist/index.js`. Point them at
      `E:/Personal Projects/SydneyRealEstate/SydneyRentalDataPipeline/dist/index.js` for now
      (Step 6 changes the entry file again). Remove `GOOGLE_MAPS_API_KEY` from their `env`
      blocks — `.env` owns it now, and the env block silently overrides `.env`.
- [ ] Run the findings repo's full gate once **before** anything moves, and record the
      output in the scratchpad as the baseline:
      ```
      npm run typecheck && npm run check:scoring && npm run check:walk && npm run check:searches && npm run check:search-runs && npm run check:filters && npm run check:studios && npm run check:transit && npm run check:ledger && npm run check:listings && npm run validate:data && npm run build && npm run check:auth
      ```
      (`validate:data -- --check-remote` too if R2 creds are in; otherwise note it skipped.)
- [ ] Snapshot both committed `run.json` files (sha256) — the Step 3 acceptance test.

## Phase 1 — relocate (each step = one commit in the repo it touches)

### Step 1 — move the scripts here, unchanged  (`refactor: move the pipeline in from the findings repo`)

Copy `SydneyRealEstateFindings/scripts/**` → `SydneyRentalDataPipeline/scripts/**` with
`git mv`-equivalent history (copy, commit here; delete in findings in Step 5). Keep the
folder name `scripts/` and the file names — Errol asked for that.

**Do not move** `scripts/check-auth.ts`: it greps the site's `.next/` build output to
prove `DEV_SKIP_AUTH` was dead-code-eliminated. It is a site-build check, not data logic.
It stays in findings as its only script. (Decision: keep. If Errol says otherwise, move it
too and have it take the findings path.)

Then make it compile here:

- `package.json`: add `tsx`, `sharp`, `aws4fetch` (findings devDeps), `zod` is already
  present — but note findings uses **zod 4** and this repo **zod 3**. Pin to one.
  Recommended: upgrade this repo to zod 4 (the MCP SDK's peer range must be checked
  first; if it refuses, keep zod 3 and adapt the ~16 lib schemas, which use only
  `z.object/enum/array/nullable/optional`).
- `tsconfig.json`: findings scripts use `'` quotes, `moduleResolution: bundler`, path
  alias `@/…` is **not** used by scripts (verify with grep). Add `scripts/**` to `include`
  or a second tsconfig for them.
- Add the npm scripts verbatim from findings `package.json` (`capture:run`, `build:run`,
  `replay:run`, `build:envelope`, `enrich:walk|travel|transit`, `check:*`, `audit:*`,
  `reset:data`, `validate:data`), each as `tsx scripts/<file>.ts`.

### Step 2 — point them at the findings repo  (`refactor: the pipeline writes to a findings dir it is told about`)

`scripts/lib/json-io.ts` defines `REPO_ROOT` (= this repo, previously) and derives
`DATA_DIR`, `PUBLIC_DIR`. Change to:

```ts
export const FINDINGS_DIR =
  process.env.FINDINGS_DIR?.trim() ||
  path.resolve(PACKAGE_ROOT, '..', 'SydneyRealEstateFindings')
```

resolved from this module (like `src/env.ts` does), not from cwd. Grep every use of
`REPO_ROOT`: `r2.ts` (loads `.env.pipeline` — see Step 4), `mcp-client.ts` (server entry —
see Step 3), `reset-data.ts`, `validate-data.ts`, `images.ts` (`public/images/listings/`),
`check-auth.ts` (stays behind). `public/images/listings/` remains the local mirror **in the
findings repo** (it is gitignored there and `validate:data` reads it).

Add `FINDINGS_DIR` to `.env.example` here, commented, with the default explained.

### Step 3 — delete the stdio hop  (`refactor: scripts call the library, not a child server`)

`scripts/lib/mcp-client.ts` spawns `dist/index.js` and speaks JSON-RPC. Replace with
direct imports. The call sites and what they become:

| Caller | MCP tool | Direct function |
|---|---|---|
| `capture-run.ts:186` | `search_listings` | the handler body of `src/index.ts:117-194` — extract it into `src/lib/search-listings.ts` as `searchListings(input): Promise<SearchResult>` first, so MCP adapter and CLI share it |
| `build-run.ts:314-328`, `build-envelope.ts:182` (via `lib/geocode-places.ts`) | `geocode_places` | `geocodePlaces()` in `src/distance.ts:1320` |
| `build-envelope.ts:251`, `enrich-travel.ts:153`, `enrich-transit.ts:134` | `route_places` | `routePlaces()` in `src/distance.ts:1540` |
| `build-envelope.ts:123`, `audit-postcodes.ts:32` | `resolve_location` | `resolveLocation()` in `src/search.ts:77` |

Consequences to handle:
- `scripts/lib/route-places.ts` and `geocode-places.ts` zod-parse the wire JSON. Keep the
  parse (ADR 0004's "a cast cannot fail" argument still holds across an internal boundary
  that is versioned together? — **No**, it no longer does). Decision: keep the parsers for
  Phase 1 (byte-identical rule), delete in Phase 2 when the types are shared.
- `enrich-transit.ts` batches 40 to fit the 180 s McpClient timeout — leave the batching
  in Phase 1, remove in Phase 2.
- `src/env.ts` must still be the first import of whatever entry the scripts use, because
  `browser.ts`/`distance.ts` read `process.env` at module scope. Simplest: every script's
  first line is `import '../src/env.js'` (or the lib barrel does it).
- The browser profile lock: `capture-run.ts` and an interactive MCP server cannot run at
  once. That was true before; document it in the CLI help.
- Delete `mcp-client.ts` and `REALESTATE_MCP_ENTRY`.

**Acceptance test for Steps 1–3:** `npm run replay:run -- <capture> --run-id=2026-08-24a`
and `…=2026-08-25a` produce `run.json` byte-identical to the Phase 0 snapshot. Captures are
at `E:/Personal Projects/SydneyRealEstateFindings-captures/` (Windows box only). Then the
whole check suite (now run from this repo) passes exactly as in the baseline.

### Step 4 — one `.env`  (`refactor: R2 credentials move into the pipeline's .env`)

- `scripts/lib/r2.ts:38-46` loads `<findings>/.env.pipeline`. Delete that loader; `src/env.ts`
  already loads this repo's `.env`, which now carries `R2_*` (Phase 0).
- `.env.example` here: add the five `R2_*` lines with the README "Photo hosting" pointer.
- Error strings mentioning `.env.pipeline` (`build-run.ts:132`, `check-r2.ts:41`,
  `reset-data.ts:80`, `validate-data.ts:394`) → "in the pipeline's .env".
- Delete `SydneyRealEstateFindings/.env.pipeline` (local file, gitignored — just remove it).

### Step 5 — make the findings repo dumb  (findings: `refactor: the site only renders; the pipeline moved to SydneyRentalDataPipeline`)

- `git rm -r scripts/` except `scripts/check-auth.ts`.
- `package.json`: remove every script except `dev`, `build`, `start`, `typecheck`,
  `check:auth`; remove devDeps `tsx` (keep — `check:auth` uses it), `sharp`, `aws4fetch`.
- `.env.example`: delete the whole "Local pipeline" section; say routing and R2 live in
  `../SydneyRentalDataPipeline/.env`.
- `.gitignore`: keep `public/images/listings/` (still the mirror).
- Comments in `src/` that cite `scripts/lib/score.ts` / `scripts/lib/rea.ts`
  (`CommutePanel.tsx:55`, `format.ts:61,119`, `studio.ts:20,34,54,102`) → cite the new
  location. **Note the real coupling here:** `src/lib/studio.ts` mirrors patterns in
  `rea.ts` by hand. That is a Phase 2 item (share the classifier or move studio flagging
  to build time), not Phase 1.
- `README.md`, `AGENT.md`, `INSTRUCTIONS.md`, `PLAN.md` §1/§2, ADR 0004: every
  `npm run <pipeline script>` becomes `npm run <script>` **in the pipeline repo**; the
  "run protocol" is executed from there. Add ADR 0005 (below).
- `.claude/launch.json` unchanged.
- Verify: `npm run typecheck && npm run build && npm run check:auth` passes; the site
  renders the committed data unchanged.

### Step 6 — MCP becomes an adapter; a real CLI  (`refactor: a pipeline CLI, with MCP as one thin adapter`)

- `src/index.ts` → `src/mcp.ts`: registers only `search_listings`, `get_listing`,
  `get_listing_photos`, `resolve_location` (the interactive set). Drop `geocode_places` and
  `route_places` from MCP — their only callers were the scripts.
- `src/cli.ts` becomes the entry: `pipeline setup | run | replay | envelope | enrich
  <walk|travel|transit> | check [name] | audit <capture|postcodes> | reset | mcp`. Each
  subcommand imports the corresponding `scripts/*.ts` main. Keep the npm scripts as
  aliases so AGENT.md commands still work.
- `package.json` `bin`: `sydney-rental-pipeline` → `dist/cli.js`; `name` →
  `sydney-rental-data-pipeline`. `.mcp.json` args → `["dist/cli.js", "mcp"]`.
- `~/.claude.json` entries → same.
- Rename env vars `REALESTATE_MCP_*` → `PIPELINE_*`? **No, not in Phase 1** — `.env` is
  hand-maintained on two machines. Phase 2, if at all.
- `README.md` + `CLAUDE.md` here: rewrite the framing (it is a pipeline that writes the
  findings repo's `data/`; MCP is an adapter). Fix the known drift: README tool table
  lists four tools, CLAUDE.md module map omits `distance.ts`/`tfnsw.ts`.

### ADR 0005 (findings repo, `docs/adr/0005-the-site-is-dumb.md`)

Title: *The site renders; the pipeline owns every byte of `data/`.* Supersedes the
"server as black box" framing in PLAN.md §1 and the split ADR 0004 left (routing in the
server, everything else in the site repo). Record the two quotes at the top of this file
as the brief, and the byte-identical replay as the proof the move was a move.

## Phase 2 — collapse the pipeline into one command (separate plan, after Phase 1 is pushed)

Not to be started under this document. Listed so the Phase 1 agent does not do them early:

- `pipeline run` = capture → map → ledger merge → score → photos → write run + knowledge +
  index → validate, in one process. Absence resolution and `commentary` remain the two
  human gates (AGENT.md 4d, 9c); the CLI prints the absent listings with their `get_listing`
  verdicts for Errol to confirm instead of the agent calling MCP by hand.
- `enrich:walk|travel|transit` become stages of `run`, so a `replay` is no longer needed to
  put enrichment on the site.
- Share types between `src/` and `scripts/lib/`; delete the wire-format zod parsers
  (`route-places.ts`, `geocode-places.ts`) and the batch-of-40 in `enrich-transit.ts`.
- `check:*` → a real test runner.
- Site `src/lib/studio.ts` duplicates `rea.ts` patterns; move studio flagging to build time.
- Consider whether the MCP adapter is still used; delete if not.

## Inventory (measured 2026-08-30, so the executing agent does not re-survey)

**This repo, `src/`:** `index.ts` (6 MCP tools), `cli.ts` (`setup` only), `search.ts`
(URL build, `resolveLocation`), `parse.ts` (ArgonautExchange blob), `browser.ts`
(patchright + Kasada profile), `distance.ts` (geocode chain, Valhalla/ORS/Google routing,
`geocodePlaces`, `routePlaces`, ferry-mislabel audit, JSON cache), `tfnsw.ts` (Trip
Planner, walk re-timing, `ferryAvailable`), `images.ts` (CDN URL sizing + base64 fetch),
`env.ts`, `types.ts`. Persists only the distance cache and the Chrome profile.

**Findings repo, `scripts/`** (23 + 16 lib, ~9,000 lines):

| Script | Kind | Talks to | Writes |
|---|---|---|---|
| `capture-run.ts` | pipeline | `search_listings` | capture JSON (scratchpad) |
| `build-run.ts` | pipeline | `geocode_places`, REA image CDN, R2 | `runs/<id>/run.json`, `listings.json`, `suburbs.json`, `index.json`, photos |
| `replay-run.ts` | pipeline | nothing | one `run.json` |
| `build-envelope.ts` | config | `resolve_location`, `geocode_places`, `route_places` | files outside `data/`, copied in by hand |
| `enrich-walkability.ts` | pipeline | Overpass (direct) | `listings.json` walkability |
| `enrich-travel.ts` | pipeline | `route_places` | `listings.json` travel |
| `enrich-transit.ts` | pipeline | `route_places` transit | `listings.json` composition |
| `reset-data.ts` | destructive | R2 | wipes runs/photos/knowledge |
| `validate-data.ts` | gate | R2 (`--check-remote`) | nothing |
| `audit-capture.ts`, `audit-postcodes.ts` | report | `resolve_location` (postcodes) | nothing |
| `check-{searches,search-runs,scoring,walkability,ledger,filters,listing-page,shares,studios,transit,r2}.ts` | verify | R2 (`check-r2` only) | nothing |
| `check-auth.ts` | site-build verify — **stays in findings** | `.next/` | nothing |

`scripts/lib/`: `score.ts` (9-factor model), `rea.ts` (capture schema, price parse,
share-house classifier), `ledger.ts` (merge / absence / rejections), `entry.ts`
(RawListing → run entry, `mergeTravel`), `searches.ts` (planning + matching),
`walkability.ts` + `overpass.ts`, `images.ts` (sharp → R2 → mirror), `r2.ts`,
`route-places.ts` + `geocode-places.ts` (wire parsers), `mcp-client.ts` (to delete),
`raw.ts`, `json-io.ts`, `sydney.ts`, `config-hash.ts`.

## Done means

- [ ] Findings repo: no `scripts/` besides `check-auth.ts`; gate `typecheck && build &&
      check:auth` passes; site renders the committed runs unchanged.
- [ ] Pipeline repo: every former check passes from here; replay of both runs is
      byte-identical; `pipeline --help` lists the subcommands; Claude Code's `realestate`
      MCP entry works via `dist/cli.js mcp`.
- [ ] One `.env` (here) + one `.env.local` (findings). `.env.pipeline` gone.
- [ ] ADR 0005 committed; AGENT.md runs from this repo; this file updated with what
      went differently, then kept (it is the record of the move).
- [ ] Both repos pushed — **ask Errol before pushing**, as always.

# MIGRATION — from "MCP server + scripts in the site repo" to "one data pipeline, one dumb site"

Written 2026-08-30 for the agent that executes it. Read all of it before touching a file.
Where this and the code disagree, verify against the code and fix this file.

**Corrected 2026-08-30 against the code, before anything was executed.** A review session
read every step against both repos and wrote a handoff
(`C:/Users/errol/AppData/Local/Temp/sydney-rental-migration-handoff-2026-08-30.md`); its
corrections are folded in below so this file stands alone. Lines marked
**Corrected** replace what the plan first said; lines marked **Decision (2026-08-30)** are
choices the plan did not contain and the executing agent took on the review's
recommendation — each is reversible and listed again in *Execution log* at the end, for
Errol to overrule.

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

(That is the end state. After Phase 1 the moved code still lives in `scripts/` +
`scripts/lib/` here, unchanged — folding it into `src/lib/` is Phase 2.)

**The sibling layout is a hard requirement**, not a convenience: the moved scripts
import the site's `src/lib/schema` across the repo boundary by relative path (Step 1), so
the two checkouts must sit side by side as
`E:/Personal Projects/SydneyRealEstate/{SydneyRentalDataPipeline,SydneyRealEstateFindings}`
(and the equivalent pair on the other machine).

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
   parsing the same files. **Corrected:** the consequence the plan missed is that the
   moved scripts keep importing those files — 30 of the 38 moving files, 45 import
   lines, `'../src/lib/schema'` plus six site modules — so the imports are rewritten to
   reach across the repo boundary (Step 1, §3.1 decision), and the pipeline must run the
   same zod major as the site.
3. **Never run a real REA search without asking Errol.** Replays and checks need no
   network. Nothing in Phase 1 requires a search.
4. **No force-push, no history rewrite** in either repo. One commit per logical step
   (listed below) so each can be reverted alone. **Ask Errol before pushing.**
5. Git-style `feat:` / `refactor:` / `docs:` subjects, as both repos already use.

## Phase 0 — preflight (do first, ~15 min)

Verified state on 2026-08-30 before execution: both repos on `master`, clean, in sync
with origin — pipeline HEAD `785119a`, findings HEAD `0894d69`. `node_modules` absent in
both, `dist/` absent here; nothing runs until `npm install` in both. Node v22.18.0.

- [x] Both repos clean and on `master`, in sync with origin (`git status --porcelain`,
      `git pull --ff-only`). **Re-check immediately before Step 1's copy**: on 2026-08-30
      an ad-hoc `tsc` run by a verifying subagent left 78 untracked `scripts/**/*.js` +
      `.js.map` in findings (neither repo's `.gitignore` ignores `*.js`; tsx still
      resolves the `.ts`, so they were inert, but a recursive copy or `git add scripts`
      would have committed them). Removed with `git clean -f -- 'scripts/*.js' …` before
      the copy; copy `*.ts` only.
- [x] `node --version` ≥ 20.12 (v22.18.0) — `process.loadEnvFile` is used.
- [x] Create `SydneyRentalDataPipeline/.env` from `.env.example` (gitignored). It gets
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
      Leave `.env.local` in the findings repo alone — it is the site's (`SITE_PASSWORD`,
      `AUTH_COOKIE_SECRET`, `DEV_SKIP_AUTH`, `NEXT_PUBLIC_*`).
      **Corrected — where the values come from:** `GOOGLE_MAPS_API_KEY` existed on this
      machine **only** in the `env` blocks of the two `realestate` entries in
      `~/.claude.json`; it was copied from there into `.env` before those entries were
      deleted (a backup of the whole file is at
      `C:/Users/errol/AppData/Local/Temp/claude.json.bak-2026-08-30`). `TFNSW_API_KEY`
      is on disk **nowhere** — Errol must re-obtain it (opendata.transport.nsw.gov.au) and
      paste it; until then transit falls back to Google and `enrich:transit` refuses to
      write. The findings `.env.pipeline` carried only `R2_BUCKET`; its four R2 secret
      lines were empty, so there was nothing to migrate — the `R2_*` blanks above are
      real blanks. Note the old findings MCP entry ran with `REALESTATE_MCP_ROUTER=google`;
      the template says `valhalla` — Errol to confirm which he wants (see *Execution log*).
- [x] `npm install && npm run build` here; `npm install` in findings. Here `prepare`
      runs `tsc` on every `npm install`, so do not touch the main `tsconfig.json` before
      the first install succeeds.
- [x] Fix `~/.claude.json`. **Corrected:** the two `realestate` entries lived under
      project keys `C:/Users/errol` and `E:/Personal Projects/SydneyRealEstateFindings`
      — the findings repo's **old** path; neither repo's current path had a key — and
      both pointed at `E:/Personal Projects/RealEstateMCP/dist/index.js` (gone). Editing
      them in place would have made the server available in `C:/Users/errol` and a
      directory that no longer exists. Done instead: delete both entries whole (their
      `env` blocks carried `GOOGLE_MAPS_API_KEY` and `REALESTATE_MCP_GEOCODER`/`ROUTER`,
      which silently beat `.env`), and add one user-scope entry:
      `claude mcp add realestate -s user -- node "E:/Personal Projects/SydneyRealEstate/SydneyRentalDataPipeline/dist/index.js"`
      (Step 6 changes the entry file again to `dist/cli.js mcp`). Its `env` block is
      empty; `.env` owns every key.
- [x] Run the findings repo's full gate once **before** anything moves, and record the
      output in the scratchpad as the baseline:
      ```
      npm run typecheck && npm run check:scoring && npm run check:walk && npm run check:searches && npm run check:search-runs && npm run check:filters && npm run check:studios && npm run check:transit && npm run check:ledger && npm run check:listings && npm run validate:data && npm run build && npm run check:auth
      ```
      (`validate:data -- --check-remote` too if R2 creds are in; otherwise note it skipped.)
      **Result:** all 13 pass at findings `0894d69`; `--check-remote` skipped (no R2
      creds). `validate:data` **warns** (does not fail) about the absent
      `public/images/listings/` mirror and 670 unverified R2 paths — expected on a fresh
      clone. Nothing in the gate spawns the MCP server or touches the network.
- [x] Snapshot both committed `run.json` files — the Step 3 acceptance test.
      **Corrected:** both repos have `core.autocrlf=true` and no `.gitattributes`, so
      `run.json` is CRLF in the working tree and LF in the blob, and `writeJsonFile`
      (`scripts/lib/json-io.ts:58`) writes LF. A `sha256sum` of the working tree will
      **never** match a correct replay. Snapshot the **git blobs** instead:
      ```
      git hash-object data/runs/2026-08-24a/run.json data/runs/2026-08-25a/run.json
      fc2dc174aa8d57e4cd95de6fa19c134683abb997   2026-08-24a
      910cfb788fe1d9b4a567681b07e3e082f7736061   2026-08-25a
      ```
      Do not "fix" the line endings with `.gitattributes` or in `writeJsonFile` in Phase 1.
- [x] **Corrected — the capture files.** `E:/Personal Projects/SydneyRealEstateFindings-captures/`
      (created 2026-08-25, findings `3e5f1e5`) was recycled on 2026-08-30 during the
      repo reorganisation. Byte-identical copies were in the scratchpad of the session
      that made the runs, and in the Recycle Bin (`E:/$RECYCLE.BIN/…/$R962C1V/`).
      **Decision (2026-08-30):** re-copied from the scratchpad to
      `E:/Personal Projects/SydneyRealEstate/captures/`, beside both repos, and verified:

      | Run | Capture | sha256 |
      |---|---|---|
      | `2026-08-24a` | `2026-08-24-walk15.json` (865,516 B; walk/15, 25 locations, 254 rows) | `c0247e87c1e706063a6ed5041a595bb140e790c40fb14d5e4164b648a4034b75` |
      | `2026-08-25a` | `2026-08-24-transit25.json` (15,043,848 B; transit/25, 82 locations, 4207 rows) | `0df885ce900f86eb1ebdcc1f00fceeb44826f800a5a2a2fd4dddf1dd0b33dd21` |

      The other scratchpad captures (`capture-2026-08-24*.json`, `capture-real.json`,
      `calib*.json`) predate the reset (`f71167d`) and are not inputs to anything.
- [ ] **Not a Phase 1 blocker, Errol decides:** `~/.realestate-mcp/distance-cache.json`
      (809 KB, last written 2026-08-27) is the server's live default cache — nothing set
      `REALESTATE_MCP_DISTANCE_CACHE` before Phase 0. The committed
      `data/knowledge/mcp-cache.json` the `.env` above now points at is empty. Copy the
      old cache over it (one commit in findings) or abandon it; replays do not route, so
      Phase 1 is unaffected either way.
- [ ] MCP-backed scripts (`capture:run`, `build:run` when a new suburb needs placing,
      `build:envelope`, `enrich:travel`, `enrich:transit`, `audit:postcodes`) are
      **unrunnable between the rename and Step 3** — `mcp-client.ts:35` defaults to
      `../RealEstateMCP/dist/index.js`. If one is needed in the window, export
      `REALESTATE_MCP_ENTRY=<pipeline>/dist/index.js` after `npm run build` here.

## Phase 1 — relocate (each step = one commit in the repo it touches)

### Step 1 — move the scripts here, unchanged  (`refactor: move the pipeline in from the findings repo`)

Copy `SydneyRealEstateFindings/scripts/**` → `SydneyRentalDataPipeline/scripts/**` with
`git mv`-equivalent history (copy, commit here; delete in findings in Step 5). Keep the
folder name `scripts/` and the file names — Errol asked for that. **Corrected:** `scripts/`
already exists here and holds `reload-mcp.ps1` (README/CLAUDE.md reference it) — merge
into it, do not replace the directory.

**Do not move** `scripts/check-auth.ts`: it greps the site's `.next/` build output to
prove `DEV_SKIP_AUTH` was dead-code-eliminated. It is a site-build check, not data logic.
It stays in findings. (If Errol says otherwise, move it too and have it take the findings
path.)

**Decision (2026-08-30) — four more checks stay in findings, for the same reason.**
`check-filters.ts` (imports the site's `listing-facets`, `studio`), `check-listing-page.ts`
(`format`, `listing-page` — includes the `<script>`-injection guard test),
`check-search-runs.ts` (`search-run`, `search-history`) and `check-studios.ts` (`studio`;
read-only report) exercise rendering helpers the Next pages import; they test the site,
not data. Moving them would have the pipeline unit-testing the site's helpers cross-repo.
So findings keeps five scripts and five npm scripts (`check:auth`, `check:filters`,
`check:listings`, `check:search-runs`, `check:studios`), and its gate keeps running them.
The other checks import only `schema` from the site (scoring, transit, searches, ledger,
shares, walkability — directly and transitively through `scripts/lib`) or nothing from it
at all (`check-r2.ts`: `node:process`, `sharp`, `./lib/r2`) and test `scripts/lib` — they
move. Net: **19 scripts + 16 libs** move; `mcp-client.ts` goes in Step 3.

**Decision (2026-08-30) — §3.1, the blocker the plan omitted: cross-repo relative
imports.** 30 of the moving files import the site by relative path (`'../src/lib/schema'`
from `scripts/`, `'../../src/lib/schema'` from `scripts/lib/`, plus `schema/config|run|travel`).
After the copy, `../src/` is this repo's flat `src/` and the first `tsx scripts/<anything>`
fails with `Cannot find module`. The site modules pull nothing Next-only (no
`server-only`/`next`/`react`/`@/` — verified by grep), so three options were open:
(a) rewrite the specifiers to `../../SydneyRealEstateFindings/src/lib/…`
(`../../../` from `scripts/lib/`); (b) move `src/lib/schema` here and have the site import
it — contradicts Non-negotiable 2 and needs a package (Phase 2 size); (c) copy the schema —
rejected by the source-of-truth rule. **Taken: (a)**, mechanical, keeps byte-identity;
recorded in ADR 0005; "share the schema as a package" is listed under Phase 2.
Consequences: the sibling layout is a hard requirement (`FINDINGS_DIR` in Step 2 relocates
only `data/` + `public/`, never code); the schema files resolve `zod` from **findings'**
`node_modules` while `scripts/lib/{rea,route-places,geocode-places,json-io,score}.ts`
resolve this repo's — `rea.ts` nests site schemas inside script `z.object`s and
`json-io.ts:22` types `z.ZodType<T>` — so **both repos pin the same zod 4**; and this
repo's `typecheck` must cover the cross-repo files (no `rootDir`).

Then make it compile here:

- `package.json`: add `tsx`, `sharp`, `aws4fetch` (findings devDeps). **Corrected:** the
  plan's fallback "keep zod 3 and adapt the ~16 lib schemas" is **not viable** — the
  site's schema uses zod-4-only `z.url()` (`src/lib/schema/knowledge.ts:40,134`,
  `run.ts:92`), which Non-negotiable 2 forbids touching, and the libs also use
  `.default()`, `.nullish()`, `.transform`, two-arg `z.record`, `z.literal`,
  `z.preprocess`, `.safeParse().error.issues`. The MCP SDK's peer range is
  `^3.25 || ^4.0`. **Decision (2026-08-30):** zod → **4.4.3** here (same as findings);
  TypeScript → **^7.0.2** here (findings checks the scripts with 7.0.2; this repo had
  5.9.3; nothing in either tsconfig is version-exclusive, but "compiles here" should be
  comparable to the baseline).
- `tsconfig.json`: findings scripts use `'` quotes, `moduleResolution: bundler`; the
  `@/…` path alias is **not** used by scripts (verified). **Corrected:** adding
  `scripts/**` to `include` does not work — it breaks `rootDir: src` (TS6059) and Node16
  resolution rejects the scripts' extensionless imports (TS2835), so `npm run build`
  fails and `prepare` makes `npm install` fail. Add a second config,
  `tsconfig.scripts.json` (`module: esnext`, `moduleResolution: bundler`, `noEmit`, no
  `rootDir`, include `scripts/**` + `src/**` + the findings `src/lib/**` it reaches),
  **and a new `typecheck` npm script** (`tsc -p tsconfig.scripts.json`) — this repo had
  none. Never add `scripts/**` to the main `tsconfig.json`.
- Add the npm scripts verbatim from findings `package.json` (`capture:run`, `build:run`,
  `replay:run`, `build:envelope`, `enrich:walk|travel|transit`, `check:*`, `audit:*`,
  `reset:data`, `validate:data`), each as `tsx scripts/<file>.ts` — minus the five that
  stay behind.

### Step 2 — point them at the findings repo  (`refactor: the pipeline writes to a findings dir it is told about`)

`scripts/lib/json-io.ts` defines `REPO_ROOT` (= this repo, previously) and derives
`DATA_DIR`, `PUBLIC_DIR`. Change to:

```ts
export const FINDINGS_DIR =
  process.env.FINDINGS_DIR?.trim() ||
  path.resolve(PACKAGE_ROOT, '..', 'SydneyRealEstateFindings')
```

resolved from this module (like `src/env.ts` does), not from cwd. **Corrected:**
`PACKAGE_ROOT` does not exist yet — rename `json-io.ts:14`'s `REPO_ROOT` to it and
rederive `DATA_DIR`/`PUBLIC_DIR` (lines 15-16) from `FINDINGS_DIR`. Only **`r2.ts:6,42`**
and **`mcp-client.ts:6,35`** import `REPO_ROOT` (plus `json-io.ts:23` itself);
`reset-data.ts`, `validate-data.ts`, `lib/images.ts` import `DATA_DIR`/`PUBLIC_DIR` and
need no edit; `check-auth.ts` imports nothing from `scripts/lib` (it uses `process.cwd()`).
`public/images/listings/` remains the local mirror **in the findings repo** (it is
gitignored there and `validate:data` reads it).

- `readJsonFile`'s error prefix (`json-io.ts:23`, `path.relative(REPO_ROOT, …)`) must be
  relative to **`FINDINGS_DIR`** so messages keep saying `data/config/site.json …`.
- `r2.ts:42`: point the (temporary) `.env.pipeline` loader at
  `path.join(FINDINGS_DIR, '.env.pipeline')`; Step 4 deletes it.
- `mcp-client.ts:35`: leave — Step 3 deletes it. Steps 2→3 are therefore not
  independently runnable for the MCP-backed scripts.
- Expected console differences vs the baseline (not failures): `validate:data` prints its
  `scope` as `path.relative(process.cwd(), DATA_DIR)` → `../SydneyRealEstateFindings/data`
  when run from here; `build-run`/`replay-run` print the capture path cwd-relative.
  Nothing asserts on them.
- `FINDINGS_DIR` from `.env` has no effect until Step 3 (nothing loads `.env` in the
  script process before then) — only the shell environment is honoured.
- User-supplied relative paths (`--cache`, `--out`, `--places-out` in `build-envelope.ts`;
  `--out` in `capture-run.ts`) now resolve against this repo's cwd; `ENVELOPE.md`'s
  documented `--places-out=data/config/places.json` would ENOENT. Document "absolute
  paths, or paths under FINDINGS_DIR".

Add `FINDINGS_DIR` to `.env.example` here, commented, with the default explained.

### Step 3 — delete the stdio hop  (`refactor: scripts call the library, not a child server`)

`scripts/lib/mcp-client.ts` spawns `dist/index.js` and speaks JSON-RPC. Replace with
direct imports. The call sites and what they become (**Corrected** table):

| Caller | MCP tool | Direct function |
|---|---|---|
| `capture-run.ts:186` and `:191` | `search_listings` | the handler body of `src/index.ts:117-194` — create `src/lib/` (does not exist yet; `rootDir: src` covers it) and extract the body into `src/lib/search-listings.ts` as `searchListings(input): Promise<SearchResult>`, so MCP adapter and scripts share it. **The body relies on zod defaults the SDK applied before it ran** (`index.ts:61-63` `channel: "buy"`, `:65` `page: 1`, `:86-88` `travelMode: "walk"`, `:111-113` `sortByTravel: false`); `page`/`travelMode` are re-defaulted in the body, `channel` is not (`:119,:123`). Move the input zod object into the new module too and have `searchListings` parse its input with it, so both callers get the same defaults. |
| `build-run.ts:314-328`, `build-envelope.ts:182` (both via `lib/geocode-places.ts`, whose `McpClient` import at `:3` is type-only) | `geocode_places` | `geocodePlaces(queries, wantLocality)` in `src/distance.ts:1334` (1320 is inside its JSDoc). **Not a pass-through:** the handler (`index.ts:349`) maps the wire `prefer: "locality"` to the boolean — `geocode-places.ts:74` sends `prefer: 'locality'`, so the direct call is `geocodePlaces(queries, true)`. Omitting the flag compiles and silently geocodes precisely instead — a data change. |
| `build-envelope.ts:251`, `enrich-travel.ts:153`, `enrich-transit.ts:134` | `route_places` | `routePlaces(origins, destination, mode, arriveBy)` in `src/distance.ts:1540`. **Not a pass-through:** it takes `PlaceOrigin { id, coord: { lat, lng } }` (`:1371`); the scripts send flat `{ id, lat, lng }` and the handler (`index.ts:403`) reshaped them. Keep that shim in one place (below). |
| `build-envelope.ts:123`, `audit-postcodes.ts:32` (constructs `McpClient` directly at `:5,:26`) | `resolve_location` | **`suggestLocations(query, max)`** at `src/search.ts:77` — there is no `resolveLocation()`; the MCP handler (`src/index.ts:289-310`) calls this. The one true drop-in. |

**Decision (2026-08-30) — where the shims live.** One small module, `scripts/lib/tools.ts`,
replaces `mcp-client.ts`: four functions mirroring the four tool calls
(`callSearchListings`, `callGeocodePlaces`, `callRoutePlaces`, `callResolveLocation`),
each applying the handler's argument translation and defaults, calling the library
directly, and returning the result through the JSON round-trip below — plus
`closeBrowser()` for `capture-run.ts`. Call sites change one line each
(`client.callTool('route_places', …)` → `callRoutePlaces(…)`), the wire parsers in
`route-places.ts`/`geocode-places.ts` stay untouched, and Phase 2 deletes the module
with them.

Consequences to handle:
- `scripts/lib/route-places.ts` and `geocode-places.ts` zod-parse the wire JSON. Keep the
  parse (ADR 0004's "a cast cannot fail" argument still holds across an internal boundary
  that is versioned together? — **No**, it no longer does). Decision: keep the parsers for
  Phase 1 (byte-identical rule), delete in Phase 2 when the types are shared.
- **Byte-identity risk when swapping JSON-over-stdio for in-process values:** the wire
  was `JSON.stringify(data)` → `JSON.parse`, which drops `undefined` keys, turns `Date`
  into strings and `NaN`/`Infinity` into `null`. Replays never call these functions, so
  the acceptance test cannot see this; `enrich:*`/`build:run` can. Pass every direct
  result through the same round-trip (`JSON.parse(JSON.stringify(x))`) in Phase 1 so the
  scripts see exactly what they saw before; if a diff ever appears after Step 3, look
  here first. Phase 2 removes it with the parsers.
- `enrich-transit.ts:62-70` batches 40 to fit the 180 s McpClient timeout — leave the
  batching in Phase 1, remove in Phase 2. `build-envelope.ts:172-176` chunks
  `geocode_places` at 25 citing the same timeout, but that chunk is also its
  checkpoint/resume unit (`writeCache` per chunk) — it stays in both phases; only its
  comment and the "via the MCP server" progress line (`:170`) go stale, reword in Phase 2.
- `src/env.ts` must still be the first import of whatever entry the scripts use, because
  `browser.ts`/`distance.ts` read `process.env` at module scope. **Corrected:** every
  script's first line is `import '../src/env.js'` — **including `check-r2.ts`,
  `reset-data.ts`, `validate-data.ts`**, which import nothing from `src/` and would
  otherwise be left with no env loader at all after Step 4 deletes the `.env.pipeline`
  one. Also put `import '../../src/env.js'` at the top of `scripts/lib/r2.ts` (it reads
  env lazily in `r2ConfigFromEnv`, so position there does not matter). There is no "lib
  barrel does it" alternative.
- The browser profile lock: `capture-run.ts` and an interactive MCP server cannot run at
  once. That was true before; document it in the CLI help. In-process, `capture-run.ts`
  must call `closeContext()` itself — it used to rely on the child server exiting.
- Delete `mcp-client.ts` and `REALESTATE_MCP_ENTRY`.

**Acceptance test for Steps 1–3** (**Corrected** procedure — compare git blobs, not
working-tree bytes; see Phase 0):

```
# from this repo, after Step 3
npm run replay:run -- "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-walk15.json"    --run-id=2026-08-24a
npm run replay:run -- "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-transit25.json" --run-id=2026-08-25a

# pass = git sees no content change in the findings repo
cd ../SydneyRealEstateFindings
git diff --stat data/                 # must print nothing
git hash-object data/runs/*/run.json  # fc2dc174… and 910cfb78…, as recorded in Phase 0
git checkout -- data/runs/            # put the CRLF working copies back
```

**Corrected while running it:** `git status --porcelain data/` shows ` M` for both files
after a correct replay — the script writes LF, the working copy was CRLF, and with
`core.autocrlf=true` git flags the eol change even though `git diff` is empty and the
blob hash is unchanged. The pass criterion is the empty `git diff --stat` plus the two
hashes; then `git checkout -- data/runs/` restores the CRLF copies so the next replay
starts from the same state. **Passed at Step 2** (2026-08-30): both hashes matched, and
the six moved checks (`check:scoring|walk|searches|transit|ledger`, `validate:data`) ran
from this repo with output identical to the baseline apart from the scope line.

Replay is deterministic at HEAD. `replay-run.ts` imports `lib/entry`, `lib/json-io`,
`lib/raw`, `lib/rea`, `lib/searches` and the site's `schema` (transitively `lib/score`,
`lib/images`, `lib/r2`, `schema/travel`) — not `ledger`, `config-hash` or `sydney`. No
`Date.now()`/`new Date()`/`Math.random()` is evaluated on that path (the only clock code
in an imported module is `isoNow()`, which replay never calls); `run_id`/`created_at`
come from the existing run via `...previous` (`replay-run.ts:347`), `enriched_at`/
`config_hash` from the prior entry or the ledger (`entry.ts:198-202`); zod defaults are
static literals; `sortListings` tie-breaks down to `id`, so key and row order are stable.
Then the whole check suite (now run from this repo) passes exactly as in the baseline,
allowing for the two cosmetic console differences listed under Step 2.

### Step 4 — one `.env`  (`refactor: R2 credentials move into the pipeline's .env`)

- `scripts/lib/r2.ts:35-46` (the `envLoaded` flag, the `.env.pipeline` JSDoc and
  `loadPipelineEnv`, plus its one call at `:58`) loads `<findings>/.env.pipeline`. Delete
  it. `src/env.ts` fills `process.env` from this repo's `.env` (which carries `R2_*`
  since Phase 0) **only in a process that imports it** — this bullet therefore depends on
  Step 3's `import '../../src/env.js'` at the top of `r2.ts` and the first-line
  `import '../src/env.js'` in every script, *including* `check-r2.ts`, `reset-data.ts`
  and `validate-data.ts`, which import nothing else from `src/`. Verify with
  `npm run check:r2` (expects "R2 is not configured" until Errol fills the keys, not a
  crash).
- `.env.example` here: add the five `R2_*` lines (findings `.env.example:35-39`) with a
  "See README, 'Photo hosting'" pointer, and the sentence "`R2_PUBLIC_BASE_URL` must match
  `NEXT_PUBLIC_IMAGE_BASE_URL` in `../SydneyRealEstateFindings/.env.local`". That pointer
  is only valid once the section is in **this** repo's README — so the move below happens
  in this same commit, not in Step 6.
- Error strings mentioning `.env.pipeline` (`build-run.ts:132`, `check-r2.ts:41`,
  `reset-data.ts:80`, `validate-data.ts:394`) → "in the pipeline's .env". **Corrected:**
  also `check-r2.ts:42`, `build-run.ts:133` ("See README, 'Photo hosting'") and the
  docblock at `r2.ts:22`.
- **Corrected:** the "Photo hosting" section exists **only** in findings `README.md:115-163`
  and is pipeline content (bucket, token, `check:r2`). Move it to this repo's README in
  this commit; leave a one-line pointer in findings; reword its step 5 from
  `.env.pipeline` to this repo's `.env` (copy `.env.example`). Findings `.env.example:19` "Must match
  R2_PUBLIC_BASE_URL below" → "…in ../SydneyRentalDataPipeline/.env".
- Other `.env.pipeline` mentions in findings to sweep (Step 5 is fine): `README.md:142`,
  `INSTRUCTIONS.md:69,98`, `PLAN.md:61,627,702`, `docs/adr/0004…:49` (optional; ADR 0005
  supersedes). Do **not** edit `ITEM-*.md` — they are frozen records (AGENTS.md).
- Delete `SydneyRealEstateFindings/.env.pipeline` (local file, gitignored — just remove it).

### Step 5 — make the findings repo dumb  (findings: `refactor: the site only renders; the pipeline moved to SydneyRentalDataPipeline`)

- `git rm -r scripts/` except `scripts/check-auth.ts` **and the four site checks** kept
  by the Step 1 decision (`check-filters.ts`, `check-listing-page.ts`,
  `check-search-runs.ts`, `check-studios.ts`). **Corrected:** `scripts/lib/` goes
  entirely **except `scripts/lib/json-io.ts`** — all four kept checks import
  `dataPath`/`readJsonFile` from `./lib/json-io` (`check-filters.ts:4`,
  `check-listing-page.ts:24`, `check-search-runs.ts:21`, `check-studios.ts:4`); deleting
  it breaks them at runtime and fails `typecheck` with TS2307. It depends only on node
  built-ins and `import type { z } from 'zod'`, so keep it unchanged in findings (its
  `REPO_ROOT` must stay the findings root; the pipeline's copy diverges in Step 2, and
  the two are intentionally different files from then on). The site's own reader
  (`src/lib/data.ts`) cannot substitute — it is `server-only`.
- `package.json`: remove every script except `dev`, `build`, `start`, `typecheck`,
  `check:auth`, `check:filters`, `check:listings`, `check:search-runs`, `check:studios`.
  **Corrected:** keep devDep `tsx` (the checks use it); remove `sharp` and `aws4fetch`
  with `npm uninstall sharp aws4fetch` so `package-lock.json` is regenerated in the same
  commit — a hand-edited `package.json` with a stale lock breaks `npm ci` on Vercel.
- `.env.example`: delete the whole "Local pipeline" section; say routing and R2 live in
  `../SydneyRentalDataPipeline/.env`.
- `.gitignore`: keep `public/images/listings/` (still the mirror).
- Comments in `src/` that cite `scripts/lib/score.ts` / `scripts/lib/rea.ts`
  (`CommutePanel.tsx:55`, `format.ts:61,119`, `studio.ts:20,34,54,102`) → cite the new
  location. **Corrected — more sites:** `src/lib/schema/knowledge.ts:219` cites
  `scripts/build-suburbs.ts`, which has never existed (it is M6 work — say so); and
  bare-filename cites of moved files at `src/app/listings/[id]/page.tsx:249`,
  `src/components/ListingGallery.tsx:16`, `src/lib/data.ts:74`,
  `src/lib/schema/searches.ts:118`, `src/lib/schema/travel.ts:201` (`build-run.ts` /
  `replay-run.ts`), `src/lib/listing-page.ts:93` (`images.ts` — the `.thumb.webp`
  convention) and `:172` (`ledger.ts`), `schema/knowledge.ts:98` (`enrich:walk`),
  `schema/places.ts:13,19` (`build:envelope`, `geocode_places`), `schema/travel.ts:4`,
  `CommutePanel.tsx:21` and `JourneyTooltip.tsx:14` (`enrich:transit`). Sites citing
  `npm run check:listings` (`PriceHistory.tsx:20`, `format.ts:125`, `listing-page.ts:81`)
  stay correct — that check stays. Grep for `scripts/`, `npm run` and each moved file's
  basename rather than trusting these line numbers. **Note the real coupling here:** `src/lib/studio.ts`
  mirrors patterns in `rea.ts` by hand. That is a Phase 2 item (share the classifier or
  move studio flagging to build time), not Phase 1.
- `README.md`, `AGENT.md`, `INSTRUCTIONS.md`, `PLAN.md`, ADR 0004: every
  `npm run <pipeline script>` becomes `npm run <script>` **in the pipeline repo**; the
  "run protocol" is executed from there. Add ADR 0005 (below). **Corrected — the sweep
  is wider than the plan's list:** **`AGENTS.md`** (CLAUDE.md is `@AGENTS.md`),
  **`ENVELOPE.md`** (describes `route_places`/`resolve_location` as MCP tools and
  documents `--places-out=data/config/places.json`), `README.md` (incl. the pipeline
  table at ~:90-113 and "Photo hosting"), `AGENT.md` (incl. the script directory listing
  with `mcp-client.ts`), `INSTRUCTIONS.md`, `docs/adr/0004…`. Reference forms an
  `npm run` grep misses: the old path `E:\Personal Projects\RealEstateMCP`,
  `npx tsx scripts/…`, `.env.pipeline`, `REALESTATE_MCP_ENTRY`. **PLAN.md is not confined
  to §1/§2** — `.env.pipeline` and `scripts/` appear through §2 (:61,:80), §3.5 (:348),
  §3.7 (:424), §4 (:506-519), §8 (:627-651), §8.5 (:681), §9 (:702), §10 (:709-717) and
  *Verification* (:734); §6 has nothing to sweep (its `build`/`check:auth`/`dev` stay).
  AGENTS.md says PLAN.md "wins every conflict", so leaving them would make a later agent
  recreate them. Cite ADR 0005 from PLAN.md's header as superseding every "pipeline lives
  in this repo" statement, and rewrite the ones that give commands. Never edit `ITEM-*.md`.
  Also: `INSTRUCTIONS.md:88-95` "The checks that must pass before any commit" is one
  chained command that AGENTS.md names the canonical gate — it becomes **two commands in
  two cwds** (findings: `typecheck`, `build`, the five kept checks; pipeline: the rest);
  `AGENTS.md:47-48` "Four so far" ADRs → five; findings `.gitignore:17-18` comment names
  `validate:data`, which now runs from the pipeline — reword, keep the ignore line.
- `.claude/launch.json` unchanged.
- Findings `tsconfig.json` includes `**/*.ts`, so `typecheck` keeps covering the five
  remaining scripts; fine.
- Verify: `npm run typecheck && npm run build && npm run check:auth && npm run
  check:filters && npm run check:listings && npm run check:search-runs && npm run
  check:studios` passes; the site renders the committed data unchanged.

### Step 6 — MCP becomes an adapter; a real CLI  (`refactor: a pipeline CLI, with MCP as one thin adapter`)

- `src/index.ts` → `src/mcp.ts`: registers only `search_listings`, `get_listing`,
  `get_listing_photos`, `resolve_location` (the interactive set). Drop `geocode_places` and
  `route_places` from MCP — their only callers were the scripts (AGENT.md's protocol calls
  only the kept four; the docs that describe the dropped two as MCP tools are listed in
  Step 5). **Corrected:** `src/index.ts:24` `new McpServer({ name: "realestate-mcp" })` is
  safe to rename; the `setup` argv branch at `index.ts:18-22` is the **only** working
  `setup` entry — `src/cli.ts` today only *exports* `runSetup()` and has no entry code, so
  `npm run setup` (`node dist/cli.js setup`) is a no-op once built. The new CLI is written
  from scratch and takes that branch over.
- `src/cli.ts` becomes the entry: `pipeline setup | run | replay | envelope | enrich
  <walk|travel|transit> | check [name] | audit <capture|postcodes> | reset | mcp`. Keep
  the npm scripts as aliases so AGENT.md commands still work. **Corrected — dispatch:**
  no script exports a `main`; they run at top level (`main().catch(...)` or bare
  top-level `await`) and read `process.argv` at module scope, so a CLI that statically
  `import`s them would run them all at once. And a compiled `dist/cli.js` cannot
  `import` a `.ts` script (extensionless imports; Node's type stripping does not resolve
  them), while widening `rootDir` would move `dist/index.js` → `dist/src/index.js` and
  break `bin`, `.mcp.json`, `~/.claude.json` and `reload-mcp.ps1` — and the cross-repo
  schema files sit outside any `rootDir` anyway. **Decision (2026-08-30):** `dist/cli.js`
  registers `tsx` at runtime (`import { register } from 'tsx/esm/api'`; `tsx` becomes a
  runtime dependency), sets `process.argv` to `[node, <script path>, ...args]` and
  dynamic-`import()`s `scripts/<file>.ts` — the scripts stay untouched, so the
  byte-identical result is not put at risk by an entry-point refactor that Phase 2's
  "one `pipeline run`" would throw away anyway. Re-run the acceptance test after the
  commit regardless.
- `src/cli.ts` must `import './env.js'` first (it currently imports `./browser.js` on
  line 1). The `mcp` subcommand must be a **dynamic** `import('./mcp.js')` — a static one
  would run `server.connect()` on every invocation and cycles with `mcp.ts` importing
  `runSetup`.
- `package.json` `bin`: `sydney-rental-pipeline` → `dist/cli.js`; `name` →
  `sydney-rental-data-pipeline`. `.mcp.json` args → `["dist/cli.js", "mcp"]` (cwd-relative
  and never enabled in any project; expect a first-time approval prompt).
- `~/.claude.json` entry → `node <pipeline>/dist/cli.js mcp`.
- **Do not rename these literals** — they are data: `scripts/lib/score.ts:358`
  `TRAVEL_SOURCE = 'realestate-mcp'` (used at `:397,:410`) is persisted as
  `"source": "realestate-mcp"` in both committed runs (20 and 530 occurrences), so a
  rename breaks byte-identical replay. `scripts/capture-run.ts:323,362` `source: 'rea-mcp'`
  is the capture file's provenance string; `ReaCaptureSchema.source` (`rea.ts:122`) is
  `z.string().min(1)` and its only consumers log it (`build-run.ts:197`,
  `replay-run.ts:138`), so it never reaches `run.json` — leave it alone anyway under the
  pure-relocation rule.
- `scripts/reload-mcp.ps1` filters processes on `dist[\\/]index\.js` and prints
  `node dist/index.js setup` (lines 60, 86, 160). After `dist/cli.js mcp` it would kill
  nothing: update the regex to `dist[\\/](index|cli)\.js`, `$entry`, and both messages.
  The Chrome filter on `realestate-mcp` (line 66) still works — the profile dir is
  unchanged.
- Strings orphaned by the rename — grep this repo for `realestate-mcp|RealEstateMCP`
  (excluding node_modules, dist) rather than trusting this list: `src/cli.ts:10,22` and
  `src/browser.ts:32` (`npx -y realestate-mcp` — never installable; the package is
  `private`), `src/index.ts:18` (comment), `src/env.ts:34,45` and `src/distance.ts:201`
  (`[realestate-mcp]` stderr prefix), `src/distance.ts:244` (`UA` sent as User-Agent to
  Photon/Nominatim/Valhalla/ORS — any identifying string satisfies Nominatim's policy;
  harmless to leave), `package.json:2,8,17`, this repo's `README.md:1,34,122` and
  `CLAUDE.md:1`, `scripts/lib/rea.ts:8,16` (docblock; `:16` cites the old
  `E:\Personal Projects\RealEstateMCP` path), findings `INSTRUCTIONS.md:128`. Leave
  findings `ITEM-3.md:426` and `ITEM-6.md:15`.
- Rename env vars `REALESTATE_MCP_*` → `PIPELINE_*`? **No, not in Phase 1** — `.env` is
  hand-maintained on two machines. Phase 2, if at all. Optional `.env.example` additions:
  `REALESTATE_MCP_PROFILE/CHANNEL/TIMEOUT/IDLE/VALHALLA_URL` (all defaulted; `VALHALLA_URL`
  is documented nowhere).
- `README.md` + `CLAUDE.md` here: rewrite the framing (it is a pipeline that writes the
  findings repo's `data/`; MCP is an adapter). Fix the known drift: README tool table
  lists four tools, CLAUDE.md module map omits `distance.ts`/`tfnsw.ts`.

### ADR 0005 (findings repo, `docs/adr/0005-the-site-is-dumb.md`)

Title: *The site renders; the pipeline owns every byte of `data/`.* Supersedes the
"server as black box" framing in PLAN.md — it appears three times: *Context* (:5), §1
(:34) and §11 *Risks* (:727), none of which mention `scripts/` — and the split ADR 0004
left (routing in the server, everything else in the site repo). Record the two quotes at the top of this file
as the brief, and the byte-identical replay as the proof the move was a move. Also record
the §3.1 decision: the pipeline imports the site's `src/lib/schema` across the repo
boundary by relative path, which makes the sibling layout a requirement; sharing the
schema as a package is Phase 2.

## Phase 2 — collapse the pipeline into one command (separate plan, after Phase 1 is pushed)

> **Done, 2026-08-30 — see [PHASE2.md](PHASE2.md) and [PHASE2-REPORT.md](PHASE2-REPORT.md).**
> Seven of the eight items below are struck through because they were carried out there. The
> one that was not — moving studio flagging to build time — was left out on purpose: it is the
> only item that changes committed data, so it could not ride along with a phase whose
> acceptance test is that nothing changes.

Not to be started under this document. Listed so the Phase 1 agent does not do them early:

- ~~`pipeline run` = capture → map → ledger merge → score → photos → write run + knowledge +
  index → validate, in one process. Absence resolution and `commentary` remain the two
  human gates (AGENT.md 4d, 9c); the CLI prints the absent listings with their `get_listing`
  verdicts for Errol to confirm instead of the agent calling MCP by hand.~~ (Step 5)
- ~~`enrich:walk|travel|transit` become stages of `run`, so a `replay` is no longer needed to
  put enrichment on the site.~~ (Step 5 — `run` does the replay for you)
- ~~Share types between `src/` and `scripts/lib/`; delete the wire-format zod parsers
  (`route-places.ts`, `geocode-places.ts`), the JSON round-trip guard from Step 3, and the
  batch-of-40 in `enrich-transit.ts`.~~ (Step 4)
- ~~**Share the site's `src/lib/schema` as a package** (workspace or published), replacing
  the cross-repo relative imports from Step 1 — and with it the requirement that both
  repos pin the same zod.~~ (Steps 1–2 — though the same-zod requirement stays; see ADR 0006)
- ~~Fold `scripts/` + `scripts/lib/` into `src/lib/`, and give each stage an exported
  `main(argv)` so the CLI can import rather than re-launch them.~~ (Step 3)
- ~~`check:*` → a real test runner.~~ (Step 6)
- Site `src/lib/studio.ts` duplicates `rea.ts` patterns; move studio flagging to build time.
  **Still open** — the one Phase 2 item deliberately left out; it changes committed data.
- ~~Consider whether the MCP adapter is still used; delete if not.~~ Kept (Errol, 2026-08-30):
  AGENT.md §4 still uses its tools interactively, and `run`'s absence gate shares `get_listing`.

## Inventory (measured 2026-08-30, so the executing agent does not re-survey)

**This repo, `src/`:** `index.ts` (6 MCP tools, and the `setup` argv branch), `cli.ts`
(exports `runSetup()` only — no entry code), `search.ts` (URL build, `suggestLocations`),
`parse.ts` (ArgonautExchange blob), `browser.ts` (patchright + Kasada profile),
`distance.ts` (geocode chain, Valhalla/ORS/Google routing, `geocodePlaces`, `routePlaces`,
ferry-mislabel audit, JSON cache), `tfnsw.ts` (Trip Planner, walk re-timing,
`ferryAvailable`), `images.ts` (CDN URL sizing + base64 fetch), `env.ts`, `types.ts`.
Persists only the distance cache and the Chrome profile. `scripts/reload-mcp.ps1` is the
one script already here.

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
| `reset-data.ts` | destructive | R2 (deletes every `images/listings/` object) | deletes the `public/images/listings/` mirror, `runs/`, `index.json`; rewrites `knowledge/listings.json` and `suburbs.json` as empty; leaves `knowledge/mcp-cache.json` and `config/*` alone |
| `validate-data.ts` | gate | R2 (`--check-remote`) | nothing |
| `audit-capture.ts`, `audit-postcodes.ts` | report | `resolve_location` (postcodes) | nothing |
| `check-{searches,scoring,walkability,ledger,shares,transit,r2}.ts` | verify | R2 (`check-r2` only) | nothing |
| `check-{filters,listing-page,search-runs,studios}.ts` | site-helper verify — **stay in findings** (Step 1 decision) | site `src/lib/*` | nothing |
| `check-auth.ts` | site-build verify — **stays in findings** | `.next/` | nothing |

`scripts/lib/`: `score.ts` (9-factor model), `rea.ts` (capture schema, price parse,
share-house classifier), `ledger.ts` (merge / absence / rejections), `entry.ts`
(RawListing → run entry, `mergeTravel`), `searches.ts` (planning + matching),
`walkability.ts` + `overpass.ts`, `images.ts` (sharp → R2 → mirror), `r2.ts`,
`route-places.ts` + `geocode-places.ts` (wire parsers), `mcp-client.ts` (to delete),
`raw.ts`, `json-io.ts`, `sydney.ts`, `config-hash.ts`.

## Done means

- [x] Findings repo: no `scripts/` besides `check-auth.ts`, the four site checks and the
      `scripts/lib/json-io.ts` they read data through; gate
      `typecheck && build && check:auth && check:filters && check:listings &&
      check:search-runs && check:studios` passes (2026-08-30, `039d1d2`); the site's
      `data/` is untouched, so it renders the committed runs unchanged.
- [x] Pipeline repo: every former check passes from here; replay of both runs is
      byte-identical (git blobs `fc2dc174…` / `910cfb78…`, verified after Steps 2, 3
      and 6); `node dist/cli.js --help` lists the subcommands; Claude Code's `realestate`
      MCP entry is `dist/cli.js mcp` and answers `tools/list` with the four tools.
- [x] One `.env` (here) + one `.env.local` (findings). `.env.pipeline` gone. (`.env` still
      wants `TFNSW_API_KEY` and the four R2 secrets from Errol.)
- [x] ADR 0005 committed; AGENT.md runs from this repo; this file updated with what
      went differently, then kept (it is the record of the move).
- [ ] Both repos pushed — **ask Errol before pushing**, as always. Not pushed.

## Execution log (2026-08-30)

Kept as the record of what went differently from the plan as first written. Items that
need Errol's word are marked **(Errol)**.

- Phase 0 done as corrected above. **(Errol)** `.env` sets `REALESTATE_MCP_ROUTER=valhalla`
  per the template; the deleted findings MCP entry had been running with `google`.
  **(Errol)** `TFNSW_API_KEY` is blank — not on disk anywhere. **(Errol)** captures now at
  `E:/Personal Projects/SydneyRealEstate/captures/`; move them and edit the two paths
  under Step 3 if another home is wanted. **(Errol)** `~/.realestate-mcp/distance-cache.json`
  copy-or-abandon is still open.
- Decisions taken without Errol (all reversible, none pushed): §3.1 → cross-repo relative
  imports; the four site checks stay in findings; zod 4.4.3 and TypeScript ^7.0.2 in this
  repo; Step 6 dispatch via tsx `register()` + argv splice, scripts untouched.
- Step 1 (`2816b1f`): `npm install` first resolved zod 4.5.2 and sharp 0.35.4; re-pinned
  to 4.4.3 / 0.35.3 so both lockfiles agree. `tsconfig.scripts.json` type-checks the
  cross-repo schema files without any zod `paths` trick — TypeScript 7 treats the two
  identical copies as compatible. `sharp`/`aws4fetch` went into `dependencies`, not
  `devDependencies`: this package runs them.
- Step 2 (`24d613f`): the acceptance test already passes here — replay never used the
  MCP hop.
- **TypeScript 7 broke `npm run build` at Step 1 and nothing said so** (`58866d1` fixes
  it): tsgo does not auto-include `node_modules/@types` under the Node16 config, so
  every bare `process` / `node:` import failed with TS2591; `prepare` had run on the
  install that *introduced* TS 7 and passed, apparently against 5.9 still on disk. Fix:
  `"types": ["node"]` in both tsconfigs. Lesson recorded for Step 6: run `npm run build`
  by hand after every dependency change; do not trust `prepare`.
- Step 3: acceptance test passed again (same two hashes) after the stdio hop was
  replaced; `check:r2` now reports "not configured" from this repo's `.env` path, which
  is the expected message until Errol fills the R2 keys. `try { … } finally
  { client.close() }` wrappers were unwrapped in `build-envelope`, `enrich-travel`,
  `enrich-transit`, `audit-postcodes` (nothing left to close); `capture-run` keeps its
  `finally` and calls `closeBrowser()`. Two comments still mention `McpClient`'s timeout
  (`build-envelope.ts:170`, `enrich-transit.ts:70`) — they explain the batching that
  Phase 2 removes, left as-is.
- Step 4 (`5dd5d34`): findings' local `.env.pipeline` deleted (it held only `R2_BUCKET`).
  The findings-side text changes this step lists (README pointer, `.env.example:19`) are
  batched into the Step 5 findings commit so each repo still gets one commit per step.
- Step 5 (findings `039d1d2`): the doc sweep was done by six parallel agents, one per
  document set, then grep-verified; every remaining `RealEstateMCP` / `.env.pipeline`
  mention is historical ("formerly", "is gone"). `sharp` stays in the findings lockfile as
  Next's own dependency — expected. Two pre-existing untruths were corrected while there
  because the new text had to say something: README/AGENT.md claimed "TfNSW is not used at
  all"; the code has routed transit through TfNSW-when-keyed since ITEM-6 (the committed
  runs report `router: google` because the key was never set). **(Errol)** ADR 0005 is
  written; the findings gate passes; nothing pushed.
- Step 6: dispatch is `tsImport` from `tsx/esm/api` (scoped, no global register) with
  `process.argv` set to what each script expects; `tsx` became a runtime dependency.
  Subcommands: `setup capture build replay envelope enrich check validate audit reset mcp`
  (`run` prints that it is Phase 2). `src/index.ts` → `src/mcp.ts` (four tools, server name
  `sydney-rental-data-pipeline`), old `src/cli.ts` → `src/setup.ts`. Verified: `--help`;
  `check scoring`; **replay of both runs through the CLI reproduces the blobs**; an MCP
  `initialize` + `tools/list` over stdio returns exactly the four tools. `~/.claude.json`
  user-scope entry now `node <pipeline>/dist/cli.js mcp`; `.mcp.json` likewise. README and
  CLAUDE.md rewritten for the pipeline framing. `REALESTATE_MCP_*` env names, the
  `~/.realestate-mcp/` profile path and the `realestate-mcp/0.1` User-Agent are unchanged
  on purpose.
- **Not done, by design:** pushing (ask Errol); `TFNSW_API_KEY` and R2 keys in `.env`;
  the distance-cache copy-or-abandon question; Phase 2.

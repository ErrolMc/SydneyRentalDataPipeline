# PHASE 2 — one command, one package, real tests

Phase 1 moved the pipeline here and proved nothing changed on the way
([MIGRATION.md](MIGRATION.md), [MIGRATION-REPORT.md](MIGRATION-REPORT.md)). It deliberately
left the shape alone: 19 scripts still run at module scope, the CLI re-launches them through
tsx, the site's schema is reached by relative path across the repo boundary, and a run is
still eight commands typed in order.

Phase 2 fixes the shape. It changes no answer the pipeline gives.

## The decision (Errol, 2026-08-30)

All eight Phase 2 items from MIGRATION.md §Phase 2, in dependency order, one commit per step.
Four questions were settled before writing this:

| Question | Answer |
|---|---|
| How to share the site's schema | A **nested package inside the findings repo** (`packages/schema`), consumed by the site as a workspace and by this repo as a `file:` dependency. Not a third repo, not a registry. |
| How much of the list | All of it. |
| Studio flagging at build time | **Out of Phase 2.** It is the one item that cannot be proved output-neutral. |
| The MCP adapter | **Kept.** AGENT.md §4 still uses `get_listing` / `search_listings` / `resolve_location` interactively. |

## Non-negotiables

1. **Phase 2 changes structure, not answers.** The acceptance test is Phase 1's, unchanged:
   `replay` of `2026-08-24a` and `2026-08-25a` must leave `git diff --stat data/` empty in the
   findings repo, blobs `fc2dc174…` and `910cfb78…`. Run it after **every** step.
2. **Replay does not cover everything, and the plan says where.** A replay routes nothing, so
   Step 4 — which deletes the wire parsers and the JSON round-trip guard standing between the
   routing library and the enrichers — is invisible to it. Step 0 records a golden-output
   corpus for exactly this reason, and Step 4 carries its own before/after proof.
3. **The findings repo's `data/` is untouched by Phase 2.** No step writes a data commit. If a
   step wants to change committed data, it is out of scope — this is why studio flagging waits.
4. **Never run a real REA search without asking Errol.** Nothing here requires one. Step 4's
   proof needs Google geocode/route on three coordinates: free tier, no REA, no browser.
5. **No force-push, no history rewrite.** One commit per step, each revertible alone.
   **Ask Errol before pushing.**
6. Git-style `feat:` / `refactor:` / `test:` / `docs:` subjects, as both repos already use.

## Step 0 — preflight and the golden corpus

Both repos clean, on `master`, in sync with origin (pipeline `3aeddf4`, findings `039d1d2`,
verified 2026-08-30). Node v22.18.0. `~/.realestate-mcp/distance-cache.json` is **abandoned**,
not copied — Errol's call, 2026-08-30; the committed empty `data/knowledge/mcp-cache.json`
stands, and MIGRATION-REPORT.md open item 4 is closed.

Before touching anything, record what every command prints today into `scratch/baseline/`
(gitignored). These are the outputs Steps 1–6 must not move:

```
check scoring · walk · searches · transit · ledger        (no network, no arguments)
validate                                                  (no --check-remote: no network)
enrich walk --dry-run · enrich travel --dry-run · enrich transit --dry-run
build <capture> --dry-run --run-id=…      (both captures)
replay <capture> --run-id=… --dry-run     (both captures)
--help, and each subcommand's usage error
```

`--dry-run` is the point: it exercises every entry point's argument parsing, loading, planning
and reporting without a network call or a write. After each step, re-run the corpus and diff.
Differences that are **expected** get recorded in the execution log as they arise; anything
else is a bug in the step.

## Step 1 — the schema becomes a package  (findings: `refactor: the schema is a package both repos depend on`)

`SydneyRealEstateFindings/src/lib/schema/*` (11 files) → `SydneyRealEstateFindings/packages/schema/src/*`.

```
SydneyRealEstateFindings/
  package.json          "workspaces": ["packages/schema"]
                        "build": "npm run build -w sydney-rental-schema && next build"
  packages/schema/
    package.json        name sydney-rental-schema · type module · private
                        main/types/exports → ./dist  ·  dependency: zod ^4.4.3
                        "build": "tsc -p tsconfig.json"  ·  "prepare": "npm run build"
    tsconfig.json       declaration, outDir dist, rootDir src
    src/                config enrichment index-manifest index knowledge listing-enums
                        places primitives run searches travel   (moved, byte for byte)
    dist/               gitignored
  src/lib/…             import … from 'sydney-rental-schema'   (was '@/lib/schema')
  scripts/…             same
```

**Why a build step and not source-only.** This repo's `tsconfig.json` emits (`outDir: dist`,
`rootDir: src`), so a package exporting `.ts` would drag files outside `rootDir` into the
program — TS6059, the same failure MIGRATION.md Step 1 hit when it tried to widen `include`.
Compiled `dist/` with declarations is what makes the package consumable by an emitting
project. It also means Next needs no `transpilePackages`.

**Why it lives in the findings repo.** Vercel builds that repo alone, so the schema has to be
inside it or on a registry. Errol chose not-a-registry.

To do:

- Move the 11 files unchanged. `index.ts`'s barrel stays as it is.
- 13 site files + 4 findings check scripts: `'@/lib/schema'` → `'sydney-rental-schema'`. The
  `@/*` path alias stays for everything else in `src/`.
- `packages/schema/dist/` into `.gitignore`.
- Vercel: `npm install` installs the workspace and links it; `prepare` builds it. The explicit
  `npm run build -w …` in the site's `build` is belt and braces — Phase 1's lesson was that a
  quietly failing `prepare` costs a day (`58866d1`).

**Acceptance:** the findings gate — `typecheck && build && check:auth && check:filters &&
check:listings && check:search-runs && check:studios` — passes, and `git diff` touches no file
under `data/`. This repo still builds against the old path until Step 2, so Steps 1 and 2 are
**not independently runnable**; land them together or expect a red tree in between.

## Step 2 — this repo depends on the package  (`refactor: the pipeline depends on the schema package, not a relative path`)

```
package.json    "sydney-rental-schema": "file:../SydneyRealEstateFindings/packages/schema"
```

npm symlinks a `file:` directory dependency, so this is the same files, not a copy: a schema
edit is visible here after `npm run build -w sydney-rental-schema` next door, with no
re-install.

- 34 import lines across 27 files: `'../../SydneyRealEstateFindings/src/lib/schema'` and
  `'…/schema/{config,travel,run}'` → `'sydney-rental-schema'`. The six subpath imports collapse
  onto the barrel, which already re-exports all of them.
- `tsconfig.scripts.json` stops reaching across the repo boundary; the comment explaining why
  it had to goes with it.
- `FINDINGS_DIR` in `json-io.ts` is **unaffected** and stays. It locates `data/` and `public/`,
  which are still next door and still not a package. The sibling layout remains a hard
  requirement at install time — a `file:` dependency is a path.

**What this does not buy, stated plainly.** Both repos still need a compatible zod 4: a
symlinked package resolves its own `zod` from the findings tree, so the schemas this repo parses
with are constructed by *that* zod, and the types unify only because the versions match. The
package declares its zod where the convention used to be undocumented, which is the improvement.
Removing the coupling needs a registry, which Errol declined.

**Acceptance:** `npm run build && npm run typecheck`, the golden corpus unchanged, and a
**byte-identical replay of both runs**.

## Step 3 — the scripts become the library  (`refactor: pipeline stages are modules with an exported main`)

The tsx hop goes. 12 pipeline scripts and 16 libs move into `src/`:

```
src/
  cli.ts              imports each stage compiled; no tsx, no process.argv splice
  stages/             capture build replay envelope validate reset
                      enrich-walkability enrich-travel enrich-transit
                      audit-capture audit-postcodes
  lib/                the 16 moved libs + search-listings.ts
  (browser distance tfnsw search parse images env types mcp setup — unchanged)
scripts/              the 7 check scripts, until Step 6
```

Each stage becomes `export async function main(argv: string[]): Promise<void>` — argv passed in,
never read from `process.argv` — and `fail()` **throws** instead of calling `process.exit(1)`.
That one change is what makes Step 5 possible: a stage that exits cannot be composed, and `run`
could never report which stage failed or what it had already written. `cli.ts` catches, prints
the same `✖ message` to stderr and exits 1, so every existing exit code and message survives.

Details that will bite, recorded before they do:

- `enrich-transit.ts` has no `main()` at all — it runs at top level with top-level `await` and
  four `process.exit` calls. It is the largest rewrite of the twelve.
- `scripts/lib/images.ts` (sharp → R2) and `src/images.ts` (CDN URL sizing) are different
  modules with the same basename. The former becomes `src/lib/images.ts`; nothing imports both.
- `json-io.ts` computes `PACKAGE_ROOT` as `../..` from its own file. `scripts/lib/x` and
  `src/lib/x` are the same depth, so the expression is unchanged — verify, do not assume.
- `import '../src/env.js'` → `'../env.js'` in stages, `'../../env.js'` in libs. `cli.ts` already
  imports it first, but the stages keep their own import: a stage must work when imported directly.
- npm scripts stay as aliases and keep their names; they call `node dist/cli.js …` instead of
  `tsx scripts/…`, so they now require a build. `tsx` stays a dependency until Step 6 — the
  check scripts still need it.
- The main `tsconfig.json` now compiles the stages, so its `rootDir: src` finally covers
  everything and `tsconfig.scripts.json` shrinks to the check scripts alone.

**Acceptance:** golden corpus unchanged, byte-identical replay of both runs, `npm run build`,
`npm run typecheck`, and `node dist/cli.js --help` unchanged.

## Step 4 — delete the wire  (`refactor: the enrichers call the router directly`)

Three things exist only because a JSON-RPC hop used to sit here:

| What | Where | Why it goes |
|---|---|---|
| `wire()` — `JSON.parse(JSON.stringify(x))` | `lib/tools.ts` | It reproduced what stdio did to `undefined`, `Date` and `NaN`. There is no stdio. |
| `RoutePlacesReportSchema`, `GeocodePlacesReportSchema` | `lib/route-places.ts`, `lib/geocode-places.ts` | They zod-parse the wire JSON. ADR 0004's "a cast cannot fail" argument was about a process boundary; across a typed import the compiler checks it. |
| `BATCH = 40` | `enrich-transit.ts` | It existed to fit `McpClient`'s 180 s timeout. There is no timeout. |

`lib/tools.ts` goes with them: stages call `geocodePlaces`, `routePlaces`, `searchListings` and
`suggestLocations` directly, with the library's own types. `closeBrowser` becomes a direct
`closeContext` import in `capture.ts`.

**Its proof is not the replay** (Non-negotiable 2). Before the step, record real
`geocode_places` and `route_places` answers for three fixed coordinates into
`scratch/baseline/routing/` — Google, free tier, no REA, no browser. After the step the same
three calls must produce the same values through the new path. The batching change gets its own
check: `enrich transit --dry-run --limit=45` before and after, which prints the call plan.

Watch for: the parsers `.transform` as well as validate in places — `toMislabelled` and
`toComposition` sit downstream of them. Anything a parser was *doing* rather than *checking*
stays, as a plain function.

## Step 5 — `pipeline run`  (`feat: one command runs a run, and stops where a human is needed`)

```
run [--capture=<path>] [--run-id=…] [--resume] [--photos=N] [--local-images] [--dry-run]
```

capture → **absence gate** → build → enrich walk · travel · transit → replay → validate.

The two human gates from AGENT.md stay human, and the CLI does the legwork for both:

- **Absence resolution (§4d).** After the capture, `run` computes every ledger listing that is
  `active` and absent, calls `get_listing` on each, prints the verdict table, writes the `gone`
  map into the capture — and **stops**. `--resume` continues from there. It never infers a
  verdict it could not fetch: an unreachable listing is left out of `gone`, exactly as the
  protocol says, and drifts to `stale` after two absences.
- **Commentary (§9c).** `build` already warns on empty commentary and `validate` flags it.
  `run` refuses to report success with it empty, and prints the one command left to run.

State lives in `scratch/run-<id>.json` (gitignored, this repo) — never in the findings repo's
`data/`, which stays a pure output. A `run` that dies mid-way is resumed, not restarted: photos
are already deduplicated by `source_urls`, but a re-capture is a real REA cost.

**Enrichment stops being out-of-band.** Today `enrich:*` writes the ledger and a *replay* is
what puts the numbers on a run — which is why `enrich-travel.ts` ends by printing replay
commands. Inside `run`, the enrichers still write the ledger (that is right: a routed minute is
a fact about a place, not a run — ITEM-3 §3.4) and `run` then replays the run it just built, so
one command produces an enriched run. `enrich walk|travel|transit` stay as subcommands for
backfilling committed runs.

## Step 6 — the checks become tests  (`test: check:* is a node:test suite`)

The seven check scripts already have the shape: `check(label, actual, expected)`, a failure
counter, `process.exit(failures === 0 ? 0 : 1)`. They become `node:test` files under `test/`,
run by `node --test`, with `assert` doing what `check` did.

What must survive: the **printed evidence**. `check:scoring` prints each factor's arithmetic and
`check:searches` prints per-search resolution counts; AGENT.md tells a reader to read them
before trusting a run. Assertions move to `assert`, the evidence stays as output.

`check:shares <capture>` and `check:r2` take an argument and touch the network respectively, so
they stay CLI subcommands and are excluded from `node --test`. Both remain in the gate.

After this, `tsx` is no longer needed here and comes out of `dependencies`.

## Step 7 — say so  (`docs:` in both repos)

- This repo: README and CLAUDE.md rewritten around `run`; the Phase 2 items struck from
  MIGRATION.md's list with a pointer here; **PHASE2-REPORT.md** in the shape Errol got last time.
- Findings: AGENT.md §4–10 rewritten around `pipeline run` and its two gates; `@/lib/schema` →
  the package name wherever prose names it; a new **ADR 0006** recording the schema package —
  what it fixes, what it does not (the zod coupling, the sibling layout), and why not a registry.
- The MCP adapter is documented as kept, with its remaining job named: interactive tools from
  Claude Code, and `get_listing` behind `run`'s absence gate.

## Out of scope, on purpose

- **Studio flagging at build time.** Adds `studio` to `ListingFlag`, moves the patterns from the
  site's `studio.ts` (500-char snippet) into `lib/rea.ts` (full description), and requires
  replaying both committed runs and committing changed data. `studio.ts`'s own notes say the
  snippet undercounts, so the numbers *will* move — which is why it cannot ride along with a
  phase whose acceptance test is that nothing moves. Its rationale stays written where it is.
- **A registry for the schema package**, and with it the sibling-layout and same-zod coupling.
- Anything that writes the findings repo's `data/`.

## Done means

- [ ] `packages/schema` exists, both repos import it by name, no relative path crosses the repo
      boundary except `FINDINGS_DIR`.
- [ ] `scripts/` here holds nothing but tests; every stage is `src/stages/*.ts` with an exported
      `main(argv)`; `cli.ts` imports them compiled; no tsx at runtime.
- [ ] `tools.ts`, both wire parsers, the JSON round-trip and `BATCH = 40` are gone.
- [ ] `node dist/cli.js run` does a whole run and stops at the two gates.
- [ ] `node --test` is the check gate; `check:shares` and `check:r2` remain subcommands.
- [ ] Replay of both runs is byte-identical after every step; the golden corpus differs only
      where the execution log says it should.
- [ ] Both gates pass. ADR 0006 written. PHASE2-REPORT.md written. Nothing pushed without Errol.

## Execution log

Filled in as it happens, like MIGRATION.md's. Items needing Errol's word marked **(Errol)**.

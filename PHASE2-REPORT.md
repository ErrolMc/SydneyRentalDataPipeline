# Phase 2 report — done (2026-08-30)

What changed, why it is safe, what you have to decide. The plan is [PHASE2.md](PHASE2.md) (its
*Execution log* has the blow-by-blow); the schema decision is recorded as the findings repo's
`docs/adr/0006-the-schema-is-a-package.md`.

**Not pushed.** Seven commits here (`85b6131`..`HEAD`) and two in the findings repo, all on
`master`, both trees clean. Nothing leaves the machine without your say-so.

## The one-paragraph version

Phase 1 moved the pipeline here and refused to change its shape. Phase 2 changed the shape and
refused to change its answers. The site's zod schema is now a package both repos depend on by
name instead of a relative path copied into 59 import lines. The 11 pipeline scripts are modules
under `src/stages/` with an exported `main(argv)`, imported compiled — the tsx hop is gone, and
so is tsx. The JSON round-trip and the two zod parsers that stood in for a process boundary are
deleted, because there is no process boundary. `node dist/cli.js run` does a whole run in one
process and stops at the two places a human is needed. The seven `check:*` scripts are 174 named
assertions under `node --test`. The proof that none of it moved a number: replaying both
committed runs still produces `fc2dc174…` and `910cfb78…`, byte for byte, and 19 of the 22
commands in the golden corpus print exactly what they printed before.

## Before and after

```
BEFORE                                        AFTER
SydneyRentalDataPipeline/                     SydneyRentalDataPipeline/
  scripts/         19 scripts, module scope     src/stages/   11 modules + run.ts,
  scripts/lib/     16 libs                                    each exporting main(argv)
  scripts/lib/tools.ts ── wire() round-trip     src/lib/      16 libs, + stage-error.ts,
  cli.ts ── tsx re-launch per command                         listing-detail.ts
  imports '../../SydneyRealEstateFindings/      test/         5 node --test suites
            src/lib/schema'   × 34              cli.ts ── imports them compiled
  tsx, tsconfig.scripts.json                    imports 'sydney-rental-schema'
                                                no tsx anywhere

SydneyRealEstateFindings/                     SydneyRealEstateFindings/
  src/lib/schema/  11 files                      packages/schema/   the same 11, as a package
  src/**  imports '@/lib/schema' × 13            src/**  imports 'sydney-rental-schema'
```

## What changed, commit by commit

### Findings repo

| Commit | Step | What |
|---|---|---|
| `4362258` | 1 | `src/lib/schema/*` → `packages/schema`, an npm workspace named `sydney-rental-schema`, compiled to `dist/` with declarations. 25 files here import it by name. The 11 files moved unchanged except that their relative imports gained `.js` — Node's ESM resolver requires them and `tsc` emits the specifier verbatim. |
| *(Step 7)* | 7 | ADR 0006; AGENT.md's §5–9 leads with `run` and its §4d describes the absence gate; the pipeline gate becomes `typecheck && build && test && validate:data`; README and INSTRUCTIONS follow. |

### This repo

| Commit | Step | What |
|---|---|---|
| `85b6131` | docs | PHASE2.md — the plan, corrected against the code before anything moved. |
| `652871e` | 2 | 34 import lines across 27 files name the package. The six subpath imports collapse onto the barrel. `tsconfig.scripts.json` stops reaching over the repo boundary. |
| `d3d44a0` | 3 | 11 stages → `src/stages/`, 16 libs → `src/lib/`, each stage `export main(argv)`. `cli.ts` imports them compiled. **A stage throws instead of exiting** (`src/lib/stage-error.ts`) — six identical local `fail()`s become one, and that is what makes Step 5 possible. 69 relative imports gained `.js` for Node16 resolution. |
| `16525eb` | 4 | `tools.ts`, `wire()`, both wire-format zod parsers and `BATCH = 40` deleted — 210 lines net. Stages call `routePlaces` / `geocodePlaces` / `searchListings` / `suggestLocations` directly. |
| `e4c5158` | 5 | `run`: absence gate → build → enrich → replay → validate, one process, `--resume`. `get_listing` becomes `lib/listing-detail.ts`, shared with the MCP adapter. |
| `b6a3eaa` | 6 | The five argument-free checks become `test/*.test.ts` — 174 named assertions under `node --test`. `check:shares` / `check:r2` become stages. **tsx is gone.** |
| *(Step 7)* | 7 | README and CLAUDE.md around `run` and the tests; MIGRATION.md's Phase 2 list struck through; PHASE2.md's execution log; this report. |

## How it was verified

- **Byte-identical replay** — after every step. `git diff --stat data/` empty in the findings
  repo, blobs `fc2dc174…` and `910cfb78…` unchanged. (`git status` still flags the two files:
  the stage writes LF, the working copy is CRLF. `git checkout -- data/runs/` puts them back.)
- **A golden corpus of 22 commands**, recorded before Step 1 and re-run after each step. 19 are
  byte for byte what they were. The three that moved:

  | Command | Was | Is | Why |
  |---|---|---|---|
  | `build` (no args) | `usage: npx tsx scripts/build-run.ts …` | `usage: node dist/cli.js build …` | the path it named stopped existing |
  | `replay` (no args) | `usage: npm run replay:run -- …` | `usage: node dist/cli.js replay …` | same |
  | `enrich transit --dry-run` | `… in 1 route_places call(s)` | `… in one routePlaces call` | the batch-of-40 is gone |

  `--help` and `run`'s own usage also changed, which is what Step 5 was for.
- **Step 4's own proof**, because a replay routes nothing and cannot see it. Against a live
  Google answer on three fixed coordinates: `parse(wire(x))` deep-equals `x` — the round-trip
  and the parsers were identity — and the inline `{ id, coord }` translation deep-equals what
  the shim did. `scratch/probe-wire.ts`.
- **`run` end to end** — a dry run walks all eight stages and writes nothing; a **real** run
  against a copy of `data/` (via `FINDINGS_DIR`) built `2026-08-30a`, read its id back out of
  `index.json` and passed validate; the commentary gate refuses a blank run; `--resume` from a
  saved state skips to where it stopped. The real findings repo was untouched throughout.
- **Both gates pass.** Here: `typecheck && build && test && validate:data` — 174/174, `data/`
  valid with 4 warnings, all pre-existing. Findings: `typecheck && build && check:auth &&
  check:filters && check:listings && check:search-runs && check:studios`.
- **`check:r2`** green against the live bucket.

## How things run now

```bash
# a whole run, in the pipeline repo
node dist/cli.js run --capture="E:/Personal Projects/SydneyRealEstate/captures/<capture>.json"
#   … the absence gate prints its verdicts and stops …
node dist/cli.js run --resume

# the pipeline gate, before committing data
npm run typecheck && npm run build && npm test && npm run validate:data -- --check-remote

# in SydneyRealEstateFindings — the site gate; data commits still land here
npm run typecheck && npm run build && npm run check:auth && npm run check:filters && npm run check:listings && npm run check:search-runs && npm run check:studios
```

Every individual command still exists and does what it did — `run` calls them. `npm run build`
now builds both configs (`dist/` and `dist-test/`), so `npm test` needs no second step.

## Decisions taken without you (reversible — say the word)

| Decision | Why | To undo |
|---|---|---|
| The schema package is `file:`-linked, not published | A registry is the only thing that removes the sibling-layout and same-zod coupling, and it puts a publish + two version bumps in front of every schema change. ADR 0006 says so plainly rather than claiming the coupling is gone. | `npm publish` the package and depend on a version; it already is one. |
| The absence gate proposes `leased` / `unmatched`, never `withdrawn` | "Page gone" and "leased" are the same evidence read two ways. It proposes only what a page states outright and leaves the reading to you. | Widen the classifier in `src/stages/run.ts`. |
| A page the gate could not reach gets no verdict at all | AGENT.md's rule. A dropped connection and a 404 look identical from here, and only one is evidence about a tenancy. | Nothing to undo; write `withdrawn` beside it by hand. |
| Tests compile to `dist-test/` via a second tsconfig | Node's own type stripping cannot run these sources — they import each other by `.js` specifier, which its resolver requires to exist on disk. Compiling `src/` twice costs about a second. | Keep tsx and run `tsx --test` instead. |
| Assertions are recorded then replayed as subtests | Keeps `check()` synchronous — it is called from ~200 places, some across several lines — and keeps the printed evidence in its original order. | Rewrite each call site as `await t.test(...)`. |
| `enrich transit` sends one call instead of batches of 40 | The batch existed for `McpClient`'s three-minute timeout. Progress now arrives in one burst rather than every 40 listings. | Restore a chunk loop for reporting only. |

## Open items — need you

1. **Push both repos.** Seven commits here, two next door. Nothing is pushed.
2. **The absence gate has never fetched for real.** It is 276 REA page loads against the current
   ledger, and this repo asks before it talks to REA. Everything around the fetch is verified;
   the loop itself is `get_listing`, which the adapter has always used. Say the word and I will
   run it on the next real capture.
3. **`check:shares` has been reporting "0 flagged" on every real capture.** It reads
   `capture.results`, the legacy flat array, which every capture since named searches leaves
   empty. Untouched by Phase 2 — byte-identical to what it did before — because fixing it
   changes what it measures. Its own commit, whenever you want it.
4. **Restart Claude Code** once, so the MCP adapter respawns from the rebuilt `dist/`. The tool
   list is unchanged (`search_listings`, `get_listing`, `get_listing_photos`,
   `resolve_location`), so this is only about picking up new code.
5. **MIGRATION-REPORT.md is out of date in one line** — it says transit is "currently `google`
   until the TfNSW key exists". `.env` says `tfnsw` and the key is set, which is why `run`
   enriches transit rather than skipping it. Left as the record of what was true on the day;
   say if you would rather it were corrected.

## Still open, on purpose

**Studio flagging at build time** — the one Phase 2 item left out. It adds `studio` to
`ListingFlag`, moves the patterns from the site's `studio.ts` (which reads the 500-character
snippet) into `lib/rea.ts` (which reads the full description), and requires replaying both
committed runs and committing changed data. `studio.ts`'s own notes say the snippet undercounts,
so **the numbers will move** — which is exactly why it could not ride along with a phase whose
acceptance test is that nothing moves. It is a clean next piece of work whenever you want it.

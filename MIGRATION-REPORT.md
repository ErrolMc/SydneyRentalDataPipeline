# Migration report — Phase 1 done (2026-08-30)

What was done, why it is safe, what you have to decide, and what comes next. The plan
this executes is [MIGRATION.md](MIGRATION.md) (its *Execution log* has the blow-by-blow);
the decision is recorded as the findings repo's `docs/adr/0005-the-site-is-dumb.md`.

**Nothing has been pushed.** Both repos are on `master`, clean, ahead of `origin`:
this repo by 7 commits (`2adea98`..`b60d88a`), the findings repo by 1 (`039d1d2`).

## The one-paragraph version

The pipeline that produces the Sydney rental findings — capture REA, geocode and route,
score, publish photos, write `data/` — used to live in the site repo's `scripts/`, and
reached the geocoding/routing code by spawning this repo's MCP server over stdio. It now
lives here, in `SydneyRentalDataPipeline/scripts/`, calls that code as a library, and
writes the site repo's `data/` as a sibling checkout. The site repo keeps `src/`, `data/`,
its zod schema and five self-checks, and nothing that computes data. The MCP server still
exists, as one subcommand, for asking `search_listings` / `get_listing` from Claude Code.
The proof that nothing changed on the way: replaying both committed runs from here
reproduces the committed `run.json` files byte for byte.

## Before and after

```
BEFORE                                        AFTER
SydneyRealEstateFindings/                     SydneyRealEstateFindings/       (site: renders)
  scripts/        ← the whole pipeline           scripts/    check-auth, check-filters,
  scripts/lib/       (~9,000 lines)                          check-listing-page,
  scripts/lib/mcp-client.ts ─┐ stdio                         check-search-runs, check-studios,
  .env.pipeline (R2 keys)    │                               lib/json-io.ts
  data/, src/                │                   data/, src/, .env.local
                             ▼
RealEstateMCP/  (MCP server)                  SydneyRentalDataPipeline/       (pipeline)
  src/   scrape, geocode, route, TfNSW          src/        same + cli.ts, mcp.ts, setup.ts,
  .env   routing keys                                       lib/search-listings.ts
                                                scripts/    the pipeline, moved unchanged
                                                scripts/lib/tools.ts  ← in-process calls
                                                .env        every key (routing + R2)
                                                writes →    ../SydneyRealEstateFindings/data/
```

## What changed, commit by commit

### This repo (`SydneyRentalDataPipeline`)

| Commit | Step | What |
|---|---|---|
| `2adea98` | docs | MIGRATION.md corrected against the code before anything moved — the review handoff's findings plus 16 more from a verification pass (line numbers, a missing function, a non-viable zod-3 fallback, the CRLF trap in the acceptance test, four checks that test the site rather than data, `json-io.ts` that those checks need). |
| `2816b1f` | 1 | 19 scripts + 16 libs copied in from the findings repo, byte for byte except 34 import lines that now reach the site's schema as `../../SydneyRealEstateFindings/src/lib/…`. zod 4.4.3, TypeScript 7.0.2, tsx, sharp, aws4fetch added; `tsconfig.scripts.json` + `npm run typecheck` (the main tsconfig cannot include the scripts). |
| `24d613f` | 2 | `scripts/lib/json-io.ts` derives `DATA_DIR`/`PUBLIC_DIR` from `FINDINGS_DIR` (env override, default `../SydneyRealEstateFindings`). **First byte-identical replay passes here.** |
| `58866d1` | fix | TypeScript 7 does not auto-discover `@types/node` under the Node16 config; `"types": ["node"]` in both tsconfigs. `npm run build` had been failing since Step 1 and `prepare` did not say so. |
| `76e870f` | 3 | `mcp-client.ts` deleted. `scripts/lib/tools.ts` makes the same four calls in-process, with the same zod validation the MCP handlers applied, the same argument shims, and a `JSON.parse(JSON.stringify(…))` so results are what the wire carried. `search_listings` extracted to `src/lib/search-listings.ts`. Every script loads `.env` first. |
| `5dd5d34` | 4 | R2 keys move into this repo's `.env`; the `.env.pipeline` loader and its strings go; "Photo hosting" moves into this README. |
| `b60d88a` | 6 | `node dist/cli.js <command>` — `setup capture build replay envelope enrich check validate audit reset mcp`. Scripts untouched: the CLI sets `process.argv` and imports each through tsx. `src/index.ts` → `src/mcp.ts` with four tools (`geocode_places`/`route_places` dropped — only the scripts ever called them). Package renamed `sydney-rental-data-pipeline`; README and CLAUDE.md rewritten. |

### Findings repo (`SydneyRealEstateFindings`)

| Commit | Step | What |
|---|---|---|
| `039d1d2` | 5 | `scripts/` reduced to the five site checks + `lib/json-io.ts`; nine npm scripts remain; `sharp`/`aws4fetch` uninstalled (`sharp` stays in the lock as Next's own dependency); `.env.example` says every pipeline key lives next door; README, AGENTS, AGENT (run protocol), INSTRUCTIONS (two gates), PLAN (dated note + concrete paths), ENVELOPE, ADR 0004 and the `src/` comments updated; ADR 0005 written. `ITEM-*.md` untouched. Local `.env.pipeline` deleted (it held only the bucket name). |

### Outside the repos

- `~/.claude.json`: the two stale `realestate` MCP entries (both pointed at the deleted
  `RealEstateMCP` path, both carried `GOOGLE_MAPS_API_KEY`) were removed and replaced by one
  user-scope entry, `node <this repo>/dist/cli.js mcp`, with an empty `env` block. Backup:
  `%LOCALAPPDATA%\Temp\claude.json.bak-2026-08-30`.
- `.env` created here from `.env.example`; `GOOGLE_MAPS_API_KEY` copied out of the old
  entries before they went.
- The two capture files the committed runs were built from were re-copied (sha256-verified)
  to `E:/Personal Projects/SydneyRealEstate/captures/` — the folder the plan named had been
  recycled.

## How it was verified

- **Byte-identical replay** — `replay` of `2026-08-24a` and `2026-08-25a` from this repo
  leaves `git diff --stat data/` empty in the findings repo; blob hashes `fc2dc174…` and
  `910cfb78…` unchanged. Run after Step 2, Step 3 and Step 6 (the last through the CLI).
  Note `git status` still flags the two files: the script writes LF and the working copy is
  CRLF; `git checkout -- data/runs/` puts them back.
- **Moved checks** — `check:scoring|walk|searches|transit|ledger` and `validate:data` print
  exactly what they printed in the findings repo, apart from `validate:data`'s scope line
  (`../SydneyRealEstateFindings/data/`).
- **Findings gate** — `typecheck && build && check:auth && check:filters && check:listings
  && check:search-runs && check:studios` passes.
- **MCP adapter** — an `initialize` + `tools/list` over stdio returns exactly
  `search_listings, get_listing, get_listing_photos, resolve_location`.
- **`npm run build` and `npm run typecheck`** pass in this repo; no `.env.pipeline`,
  `mcp-client`, `REALESTATE_MCP_ENTRY` or old-path reference survives outside historical
  notes and the frozen `ITEM-*.md`.

## How things run now

```bash
# in SydneyRentalDataPipeline — every data step
node dist/cli.js --help
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-walk15.json" --run-id=2026-08-24a
npm run replay:run -- <same>            # every npm script is an alias for a CLI command

# the pipeline gate, before committing data
npm run typecheck && npm run build && npm run check:scoring && npm run check:walk && npm run check:searches && npm run check:transit && npm run check:ledger && npm run validate:data

# in SydneyRealEstateFindings — the site gate; data commits still land here
npm run typecheck && npm run build && npm run check:auth && npm run check:filters && npm run check:listings && npm run check:search-runs && npm run check:studios
```

The run protocol is unchanged in substance and still lives in the findings repo's
`AGENT.md`; it now says which commands run where. `capture` uses the same Chrome profile as
the MCP adapter, so it cannot run while Claude Code has the server up.

## Decisions taken without you (reversible — say the word)

| Decision | Why | To undo |
|---|---|---|
| Scripts import the site's schema across the repo boundary by relative path | The only Phase-1-sized option: moving the schema breaks Non-negotiable 2, copying it breaks the source-of-truth rule. Makes the sibling layout a hard requirement and forces both repos onto the same zod. | Phase 2: share the schema as a package. |
| `check-filters`, `check-listing-page`, `check-search-runs`, `check-studios` stay in findings (with `json-io.ts`) | They test the site's rendering helpers, not data — same reasoning as `check-auth`. | Move them; add them to the pipeline's `check` table. |
| zod 4.4.3 and TypeScript 7.0.2 in this repo | zod 3 cannot parse the site's schema (`z.url()`); TS 7 is what findings already checks these files with. | Pin differently in `package.json`. |
| CLI dispatch via tsx `tsImport` + `process.argv`, scripts untouched | Refactoring 19 entry points before the acceptance test would have risked the byte-identical result, and Phase 2 rewrites them anyway. | Phase 2 gives each stage an exported `main`. |
| `sharp`/`aws4fetch` as `dependencies` (not `devDependencies`) here | This package runs them. | Cosmetic; the package is private. |
| Captures at `E:/Personal Projects/SydneyRealEstate/captures/` | The plan's folder had been recycled; this sits beside both repos. | Move them and edit the two paths under MIGRATION.md Step 3. |

## Open items — need you

1. **Push both repos** (7 commits here, 1 in findings). Not done, per the standing rule.
2. **`.env` blanks**: `TFNSW_API_KEY` exists nowhere on this machine (transit falls back to
   Google and `enrich:transit` refuses to write until it is set); the four R2 secrets are
   empty (`build`/`reset` refuse; `validate --check-remote` unavailable). `check:r2` will
   tell you when they are right.
3. **`REALESTATE_MCP_ROUTER=valhalla`** per the plan's template — the MCP entry you were
   actually running had `google`. Pick one.
4. **`~/.realestate-mcp/distance-cache.json`** (809 KB, the server's live cache until
   today) vs the empty committed `data/knowledge/mcp-cache.json` that `.env` now points
   at. Copy it over (one commit in findings) or start fresh. Replays do not route, so
   nothing waits on this.
5. Two doc statements were corrected rather than carried over: findings README/AGENT.md
   said "TfNSW is not used at all"; the code has routed transit through TfNSW-when-keyed
   since ITEM-6 (both committed runs say `router: google` because the key was never set).
   Shout if you wanted the old wording.

## Next steps

Immediate (Phase 1 wrap-up):

- Review the seven + one commits, then push.
- Fill `.env`, run `npm run check:r2`, and re-run the pipeline gate once with
  `validate:data -- --check-remote`.
- Restart Claude Code once so it picks up the renamed MCP entry (the tool list is cached per
  session; `geocode_places`/`route_places` disappear, nothing else changes).
- Run `npm run build` by hand after any dependency change here — `prepare` did not catch
  the TypeScript 7 break.

Phase 2 (a separate plan; not started, on purpose — MIGRATION.md lists it):

- One `pipeline run` = capture → build → enrich → validate in one process, with the two
  human gates (absence resolution, commentary) printed for you instead of driven by hand.
- Share the site's schema as a package, replacing the cross-repo relative imports and the
  same-zod requirement.
- Fold `scripts/` + `scripts/lib/` into `src/lib/` with exported entry points; delete
  `tools.ts`, the wire-format zod parsers and the JSON round-trip; drop the batch-of-40 in
  `enrich-transit`.
- `check:*` → a real test runner. `src/lib/studio.ts` in the site mirrors `rea.ts` by hand
  — move studio flagging to build time.
- Decide whether the MCP adapter is still used; delete it if not.

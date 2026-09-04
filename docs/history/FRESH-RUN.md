# FRESH-RUN.md — handoff: the first real run on the rebuilt pipeline

**Goal.** Get this pipeline doing fresh runs end to end, good enough that the new runs
supersede the two committed ones, and rendering well on the site next door.

This is a handoff, not a plan you have to follow. It exists because the pipeline was rebuilt
in [PHASE2.md](PHASE2.md) and **the rebuild was verified against captures that already
existed** — so the two code paths a fresh run needs first have never been executed. Read
*What has never run* before you start, and *Four things to fix first* before you trust a run's
output.

Read alongside: the findings repo's `AGENT.md` (the run protocol — it is the authority on what
to do and what to commit), [PHASE2-REPORT.md](PHASE2-REPORT.md) (what changed and how it was
proved), [README.md](../../README.md) (the commands).

---

## 1. Where things stand

Both repos are on `master`, clean, and pushed as of 2026-08-30 — pipeline `8928fb8`, findings
`a739408` — **except one commit here**, `cdb82af`, which is unpushed. Ask Errol before pushing
it, as always.

The shape after Phase 2:

```
src/stages/   11 stages + run.ts, each `export async function main(argv)`
src/lib/      their logic: scoring, ledger, search planning, walkability, photos/R2
test/         5 node --test suites, 174 assertions
scripts/      reload-mcp.ps1, and nothing else
```

A stage signals failure by **throwing** (`src/lib/stage-error.ts`), never `process.exit` —
that is what lets `run` compose them. Nothing compiles TypeScript at run time; there is no tsx.
`npm run build` builds both tsconfigs (`dist/` and `dist-test/`).

**The gates.** Here, before a data commit:

```bash
npm run typecheck && npm run build && npm test && npm run validate:data -- --check-remote
```

In the findings repo, where the data actually gets committed:

```bash
npm run typecheck && npm run build && npm run check:auth && npm run check:filters && npm run check:listings && npm run check:search-runs && npm run check:studios
```

**The regression invariant.** Replaying both committed runs from their captures must leave
`git diff --stat data/` empty in the findings repo, blobs `fc2dc174…` and `910cfb78…`:

```bash
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-walk15.json"    --run-id=2026-08-24a
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-transit25.json" --run-id=2026-08-25a
git -C ../SydneyRealEstateFindings diff --stat data/     # must print nothing
git -C ../SydneyRealEstateFindings checkout -- data/runs/
```

Keep running this while you work on `src/lib/`. It is the cheapest regression test in the
project and it caught nothing during Phase 2 only because Phase 2 was careful. **It stops being
meaningful the moment you deliberately change what the mapping produces** — a studio flag, say.
When that happens, say so in the commit rather than quietly letting it fail.

---

## 2. What has never run

Phase 2 verified everything it could without touching REA, which is a lot — a real `build` and
`validate` against a copy of `data/`, a real TfNSW `enrich transit`, byte-identical replays
after every step, 174 assertions, `check:r2` against the live bucket. Four paths it could not
reach. **These are not known-broken; they are unobserved**, and the first fresh run is where
they get observed.

| Path | Why it is unobserved | What to watch |
|---|---|---|
| **`capture`'s fetch loop** | Restructured in Steps 3 and 4 — wrapped in `main`, `arriveBy` became a parameter, `callSearchListings` → `searchListings`, `closeBrowser` → `closeContext` — and never executed. Its pre-network half *is* smoke-tested: argv, config load, query planning, the arrive-by and envelope refusals all work and write nothing. | Paging to exhaustion, the `totalPages` reconciliation, the bot-block backoff, and that the capture it writes parses. Run it small first. |
| **The absence gate's fetch loop** | 276 REA page loads against the current ledger, and this repo asks before it talks to REA. Everything around the loop is tested. | That verdicts look sane, and that the checkpoint every 25 actually writes — kill it deliberately partway and check the capture's `gone` map. |
| **`toComposition`** | Needs a transit journey with legs. The one live TfNSW call had a single unroutable listing, so no journey came back. | That transit listings get a `composition` with real legs, not a `noJourney` tally. |
| **R2 upload inside `build`** | The one real `build` used `--local-images`. `check:r2` proves the bucket and token; it does not prove `syncListingImages` still uploads. | Photo counts in the run, and `validate --check-remote` going green. |

---

## 3. Four things to fix first

Each is its own commit, before or alongside the first real run. The first one can silently
corrupt a run's claims and should be fixed **before** any fresh capture.

### 3.1 `capture` and `build` can disagree about the transit arrive-by — fix this first

`capture` takes `--arrive-by` and records it per group. `build` computes
`transit_departure_resolved` **itself**, from `site.commute_assumption`, and writes it into
`run.json`. **Nothing compares them.**

`resolveTransitDeparture` returns the next matching weekday at least two days out, so it
*drifts*: today it is `2026-09-01T09:00:00+10:00`; capture on Sunday and build on Wednesday and
they are different Tuesdays. The run would then state an arrive-by that its transit minutes were
not measured against — the exact fake precision this project keeps removing.

The fix is small: `build` should compare its computed value against the `arrive_by` on every
transit group in the capture and **refuse** on a mismatch, naming both. A `--force` escape hatch
is fine; silence is not.

### 3.2 `check:shares` has been reporting `0 flagged` on every real capture

It reads `capture.results` — the legacy flat array — which every capture since named searches
leaves empty. So the share-house classifier's working out has been invisible for as long as
group-based captures have existed, and AGENT.md §5–9 tells a reader to read it before trusting
a run. Fix: read `flattenCapture(capture).listings`, as `build` and `audit-capture` do.

Unchanged by Phase 2 on purpose — fixing it changes what it measures.

### 3.3 Studio flagging at build time — the one Phase 2 item deliberately left open

The site's `src/lib/studio.ts` classifies studios from `description_snippet`, the 500 characters
a run keeps. The pipeline's `src/lib/rea.ts` has the full description at map time. `studio.ts`'s
own notes say the snippet undercounts and name the fix: move the patterns into `rea.ts`, add
`studio` to `ListingFlag`, replay.

It was left out of Phase 2 because it is the only item that **changes committed data** — the
numbers will move, so it could not ride along with a phase whose acceptance test was that
nothing moves. A fresh run is the natural moment: do it before the run and it lands in the new
data for free.

### 3.4 `--photos=1` is why the site looks sparse — not a defect, a flag to remember

`build` defaults to one photo per listing. 276 of the 288 listings in the ledger carry exactly
one; the twelve captured before that default dropped carry eight. The gallery component exists,
works, and is written to read correctly at a length of one — so the site is not broken, it is
just thin.

Filenames are append-only, so raising it tops listings up without disturbing any path a
committed run points at. **Run the fresh run with `--photos=8`.** Budget for it: 8 × the
listing count, resized twice and pushed to R2.

---

## 4. What "replace the current runs completely" can mean — Errol's call

The two committed runs answered **criteria v5 / searches v6**. Config today is **criteria v6
(398 envelope locations) / searches v8**, and neither capture covered the envelope — 25 and 82
locations of 398. That mismatch is what `validate`'s first two warnings are about.

Two ways to supersede them:

**(a) A fresh run on top — recommended, and non-destructive.** The new run becomes
`current_run`; the site shows it; the old runs stay in history at `/runs`. Nothing is
destroyed, the two old runs remain as a comparison, and the R2 photos they point at keep
resolving. Do this first, judge the result, and only then decide about (b).

**(b) `reset --confirm`, then rebuild from nothing.** Destroys every R2 object, the local
mirror, `data/runs/*`, `index.json`, and empties the knowledge files. Keeps `data/config/*` and
git history. The R2 deletion is **the only irreversible part of the whole project**.

`docs/adr/0002-reset-rather-than-a-third-run.md` in the findings repo argued for a reset and is
now marked **deferred**. Two of its premises have moved:

- Its blocker was that the reset does not reach the route cache, so a post-reset capture would
  re-serve days-old numbers. **That is resolved**, and properly now: `reset` empties the cache
  alongside the ledger and the profiles. Until 2026-08-30 it did not — the doc comment claimed
  `data/knowledge/*.json` and the code wrote two of the three files — and the gap was invisible
  only because the committed cache had been empty since the day it was committed. The cache has
  also moved to `data/cache/mcp-cache.json`, has a schema, and is reported by `validate`.
  It is still empty (0 routes, 0 geo), so a fresh capture will route from scratch — which is
  also why it will cost real money; see §6.
- Its argument *against* a reset was that absence resolution has never fired against real data
  and a reset returns the project to run #1. Still true: `gone` is empty in both captures. A
  fresh run on top is the only way to exercise it.

**Recommendation: (a) now, (b) only if the new run makes the old ones actively misleading.**

---

## 5. The plan

### Step 0 — preflight

- Restart Claude Code once if you have not since Phase 2, so the MCP adapter respawns from the
  rebuilt `dist/`. Tool list is unchanged.
- `npm install` in **both** repos (the findings install is what builds `packages/schema`).
- Both gates green, and the replay invariant holds.
- `node dist/cli.js setup` — warms the Chrome profile. A cold profile is the single most
  common cause of a failed capture.
- `node dist/cli.js check r2` — green.
- Confirm `git status` is clean in both repos. A run commit must contain the run and nothing
  else.

### Step 1 — fix §3.1, and decide on §3.2–3.4 with Errol

§3.1 before any capture. The others are cheap and land better before the run than after.

### Step 2 — a small attended pilot. **Ask Errol first — this is a real REA pass.**

This is the point of the whole handoff: watch the two unobserved paths on a small pass before
committing to a large one.

```bash
node dist/cli.js run --search \
  --out="E:/Personal Projects/SydneyRealEstate/captures/<date>-pilot.json" \
  --arrive-by=<resolveTransitDeparture value> \
  --only=<two or three suburbs> \
  --photos=8
```

`--only` restricts the pass; `--core` names what to page to exhaustion. A narrow capture keeps
the absence gate small too, which is what you want the first time.

Then read, before resuming:

- the capture parses, and `audit capture <file>` looks sane;
- the absence table — do the verdicts match what the pages actually say?
- kill the gate partway once, on purpose, and confirm the capture's `gone` map holds what was
  already checked.

`run --resume` through build → enrich → replay → validate. Then **throw the pilot run away**
(`git checkout -- data/` in findings, or `reset` if photos went to R2) — it is a rehearsal, not
a run to commit. Say so out loud so nobody mistakes it for one.

### Step 3 — cost the real run from the pilot

The pilot's per-group travel report prints `geocode_calls`, `matrix_calls`, `unique_buildings`
and `cached_buildings`. Extrapolate to the envelope, and take the number to Errol before
spending it (§6).

### Step 4 — the real run. **Ask Errol.**

One capture can cover **both** searches — `planSearchQueries` returns one group per
`origin:mode`, and `build` handles several. That matters: `/searches/<id>` pages only fill in
for searches a run actually asked, which is `validate` warning #2 today. So capture with
`--arrive-by` set and no `--searches` filter, and both `office-walk-15` and `train-25` get
answered by one run.

Then `run --resume` through the rest, and write the commentary — it is gate 2, and `run` will
refuse to call the run ready without it.

### Step 5 — the gates, then commit in the findings repo

Both gates, `validate --check-remote` (not optional before a data commit — the local mirror
existing proves nothing about what a viewer sees), then one commit in the findings repo:

```
run: <run-id> — N listings (X new, Y price drops, Z leased)
```

Ask before pushing.

### Step 6 — does it display nicely?

`validate`'s warnings are the checklist. Today there are four, and a good fresh run clears the
first two outright:

| Warning today | Cleared by |
|---|---|
| `searches.json is v8 but the current run answered v6` | a run on the current config |
| `"office-walk-15" is saved but run 2026-08-25a did not ask it` | one capture covering both searches (Step 4) |
| `no local photo mirror at public/images/listings` | the run writing photos locally as it uploads |
| `670 photo path(s) not verified in R2` | `validate --check-remote` |

Then look at the site itself: `npm run dev` in the findings repo. Cards, the listing page
gallery (§3.4), the filters, `/searches/<id>/<runId>`. `check:filters`, `check:listings`,
`check:search-runs` and `check:studios` cover the rendering helpers, but they cannot tell you
whether it *reads* well.

---

## 6. Cost, rate limits and the profile

- **The route cache is empty**, so a fresh capture pays full price for every geocode and every
  routed leg. This is the single biggest difference from replaying.
- **Google**: 10k elements/month free for Route Matrix Essentials and the same for Geocoding,
  then $5/1k. The 82-location transit capture returned 4,207 rows; the envelope is 398
  locations. **A full envelope pass can plausibly exceed the free tier** — cost it from the
  pilot (Step 3) rather than guessing, and never send a clock on a road mode (it moves Google
  to the traffic-aware SKU at double).
- **TfNSW**: one trip per request, ~250ms each, 60k/day. Fine for a few hundred listings, but
  serial — a transit enrich of the whole ledger is minutes, and `enrich transit` now sends it
  as one call with no progress until it returns.
- **Overpass** is free and volunteer-run; the code asks about grid cells at one request per two
  seconds. Leave that alone.
- **One Chrome profile, one process.** `capture` and the absence gate use the same warm profile
  as the MCP adapter, so Claude Code must not have the server up while either runs.
  `./scripts/reload-mcp.ps1` clears it; `-CheckOnly` inspects.

---

## 7. Non-negotiables

1. **Never run a real REA search or absence pass without asking Errol.** Capture and the
   absence gate both talk to REA.
2. **Ask before pushing**, either repo.
3. **Never infer an absence verdict.** A page you could not reach gets no verdict and stays out
   of the `gone` map — two consecutive absences make it `stale` on their own. `run` already
   behaves this way; do not "improve" it.
4. **Data commits land in the findings repo**, one commit, after both gates pass.
5. **Do not fix logic mid-run.** A bug found while running is its own commit, with the replay
   invariant re-checked.
6. Git-style `feat:` / `fix:` / `refactor:` / `test:` / `docs:` subjects. No force-push.

---

## 8. Done means

- [ ] §3.1 fixed: `build` refuses a capture whose transit arrive-by is not the one it computed.
- [x] Suburb centroids have one source — the envelope (`15af160`).
- [x] `reset` empties the route cache; the cache has a home, a schema and a `validate` report.
- [x] `suburbs.json` carries `observed_rents`, so the suburb factor scores instead of sitting
      out — on this project's own listings, labelled `rents:observed`, until published NSW
      figures fill `rents` and take precedence.
- [ ] A fresh run answering **both** searches on criteria v6 / searches v8, over a deliberate
      and stated share of the 398-location envelope.
- [ ] Its absence gate actually fired, with verdicts Errol read and agreed with.
- [ ] `--photos=8`, so the gallery has something to show.
- [ ] Both gates green, `validate --check-remote` clean, and its first two warnings gone.
- [ ] The site read on a phone and judged to look right — not just to pass its checks.
- [ ] Committed in the findings repo; pushed only when Errol says.
- [ ] This file updated with what actually happened, in the shape PHASE2-REPORT.md took.

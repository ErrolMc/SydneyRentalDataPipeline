# BEFORE-THE-RUN.md — the six things to do before the first fresh capture, in order

**Read [FRESH-RUN.md](FRESH-RUN.md) first.** It is the handoff that explains *why* a fresh run
is delicate: the pipeline was rebuilt in [PHASE2.md](PHASE2.md) and verified against captures
that already existed, so several code paths a fresh run needs have never executed. This file
does not replace it. It is the ordered sequence that came out of asking one question —
*is it wise to do fresh runs for both searches now?* — and answering **not yet**.

Also read the findings repo's `AGENT.md` (the run protocol, and the authority on what to
commit) and [README.md](../README.md) (the commands).

**Arriving on a different machine than the one this was written on? Start at §0.** Its first
item is the captures: verify both files are on disk and their hashes match **before** doing
anything else. They are irreplaceable, and nothing else in this file works without them.

---

## 0. Picking this up on another machine — do this first

Nothing below works until this does, and one item cannot be recovered if it is skipped.

### 0.1 The captures must be on disk before anything else — check, do not assume

`captures/` sits **outside both repos** — a sibling of them, tracked by neither, no backup.
`git clone` gets you both repos and none of this. It holds the only two captures the project
has, and they cannot be regenerated: the listings have expired and the route cache is empty, so
REA would answer a different question at real cost.

The layout to arrive at, with the exact bytes to expect:

```
<parent>/
  SydneyRealEstateFindings/
  SydneyRentalDataPipeline/
  captures/
    2026-08-24-transit25.json   15,043,848 bytes
    2026-08-24-walk15.json         865,516 bytes
```

**Transferred via OneDrive, 2026-08-31.** Copy them out of the synced folder to a real local
path and point `$CAPTURES` at that — do not run against the OneDrive folder itself. With Files
On-Demand a 15 MB file lists at full size while its contents are still cloud-only, so a
directory listing proves nothing; and a sync that is still running gives you a partial file
that parses as far as it goes and then fails somewhere unhelpful.

**Verify before continuing.** Sizes catch a truncated sync; the hashes catch everything else:

```bash
cd "$CAPTURES"
sha256sum 2026-08-24-transit25.json 2026-08-24-walk15.json
```

```
0df885ce900f86eb1ebdcc1f00fceeb44826f800a5a2a2fd4dddf1dd0b33dd21  2026-08-24-transit25.json
c0247e87c1e706063a6ed5041a595bb140e790c40fb14d5e4164b648a4034b75  2026-08-24-walk15.json
```

If either hash differs, the sync is incomplete or the file is not the one this project was
built against — re-copy rather than proceeding. On Windows without `sha256sum`:
`certutil -hashfile <file> SHA256`.

**Do not start §0.2 until both hashes match.** Without these files there is no replay
invariant — the project's cheapest regression test — and no way to verify Step 2, whose check
is to run `check:shares` against the committed transit capture. If they are lost or a hash
cannot be made to match, stop and tell Errol. That is a decision for him, not something to
work around.

### 0.2 Clone both repos as siblings

The pipeline depends on `file:../SydneyRealEstateFindings/packages/schema`, and a `file:`
dependency is a path. They must sit side by side under one parent:

```
<parent>/
  SydneyRentalDataPipeline/
  SydneyRealEstateFindings/
  captures/                  # from 0.1
```

### 0.3 Install, findings first

```bash
cd SydneyRealEstateFindings && npm install     # this is what builds packages/schema
cd ../SydneyRentalDataPipeline && npm install
```

Node 20 or newer (`engines`); the committed work was done on v22.18.0.

### 0.4 Rebuild `.env` from `.env.example`

**`.env` is gitignored**, so it does not travel. `.env.example` documents all eleven keys;
Errol holds the secrets. The ones that must be right:

| Key | Why it matters here |
|---|---|
| `REALESTATE_MCP_DISTANCE_CACHE` | Must point at `<parent>/SydneyRealEstateFindings/data/cache/mcp-cache.json`. **The path changed in `43a4832`** — an `.env` copied from anywhere older points at `data/knowledge/mcp-cache.json`, which no longer exists, and the router will silently fall back to `~/.realestate-mcp/distance-cache.json` instead. |
| `GOOGLE_MAPS_API_KEY` | Geocoding and route matrix. Absent, `assertRoutable` throws rather than guessing. |
| `TFNSW_API_KEY` | Transit legs. Absent, transit falls back to Google, which returns a duration and no legs. |
| `R2_*` (five keys) | `build` refuses to run without them unless `--local-images`, because a run without R2 records photo paths that resolve to nothing. |

Confirm with `node dist/cli.js check r2` and `npm run check:cache` — the latter should report
`0 route(s), 0 position(s)` from `data/cache/mcp-cache.json`. If it says the cache is missing,
`REALESTATE_MCP_DISTANCE_CACHE` is wrong.

### 0.5 Warm the Chrome profile

The profile lives in `~/.realestate-mcp/profile` and is machine-local, so it will be cold:

```bash
node dist/cli.js setup
```

A cold profile is the single most common cause of a failed capture, and Kasada returns 429 to
anything unwarmed. Do this before Step 4, not during it.

### 0.6 Prove the move worked

```bash
npm run typecheck && npm run build && npm test        # 8 suites, 246 assertions
npm run validate:data                                 # 4 known warnings, no errors
```

Then the replay invariant from §1. **If it does not come back clean on a machine where no code
has changed, the problem is the move, not the code** — most likely line endings or the wrong
capture files. Fix that before touching anything in §3.

---

## 1. Where things stand, 2026-09-01

Everything through the Steps 1–2 commits is pushed. **Step 3 is local and unpushed, in both
repos**, and it is the one that changes committed data. Check `git log --oneline @{u}..HEAD`
in both repos rather than trusting this table, and ask Errol before pushing anything, always.

| Commit | Repo | What it did |
|---|---|---|
| `15af160` | pipeline | A suburb has one centroid, and `places.json` owns it. `build` realigns the 43 committed profiles that had drifted (up to 1.47 km) and seeds new ones from the envelope instead of re-geocoding. |
| `43a4832` | findings | `McpCacheSchema` + `cacheExpiry`; cache moved to `data/cache/`; `SuburbProfile.observed_rents`; `FactorScore.source`. |
| `c7a4e7e` | pipeline | `reset` now empties the route cache (it did not, which was a live bug); the cache is written sorted and reported by `validate`; `build` computes `observed_rents`; `suburbFactor` falls back to them. |
| `81e2bc2` | pipeline | This file. |
| `28659b4` | pipeline | §0 — this file survives being read on another machine. |
| `29da69a` | pipeline | §0.1 — verify the captures are really there, not just listed. |
| `c442730` | pipeline | **Step 1** — `build` refuses a capture measured against a different arrive-by. |
| `b3f3cad` | pipeline | **Step 2** — `check:shares` reads the capture's groups, not the legacy flat array. |
| `dc02da3` | pipeline | Steps 1–2 recorded here; Step 1's expired premise replaced. |
| *(local)* | both | **Step 3** — studios are in, labelled. Changes committed data. Not pushed. |

Current shape:

```
src/stages/   14 stages + run.ts, each `export async function main(argv)`
src/lib/      their logic: scoring, ledger, search planning, walkability, suburbs, photos/R2
test/         8 node --test suites, 246 assertions
```

**The gates.** Here, before a data commit:

```bash
npm run typecheck && npm run build && npm test && npm run validate:data -- --check-remote
```

In the findings repo, where data actually gets committed:

```bash
npm run typecheck && npm run build && npm run check:auth && npm run check:filters \
  && npm run check:listings && npm run check:search-runs && npm run check:studios
```

**The regression invariant.** Replaying both committed runs must leave `git diff --stat data/`
empty in the findings repo. **Step 3 broke it deliberately and re-established it** — the flags
it added are now part of what a replay reproduces, so from here the invariant holds again against
the post-Step-3 data. Run it after every change to `src/lib/`.

Note `git diff --stat` is the test, not `git status`: replay writes LF and the tree holds CRLF,
so `status` shows both `run.json` files as modified while `diff` correctly sees no change.

`$CAPTURES` is wherever §0 put the capture files — on the machine this was written on,
`E:/Personal Projects/SydneyRealEstate/captures`.

```bash
node dist/cli.js replay "$CAPTURES/2026-08-24-walk15.json"    --run-id=2026-08-24a
node dist/cli.js replay "$CAPTURES/2026-08-24-transit25.json" --run-id=2026-08-25a
git -C ../SydneyRealEstateFindings diff --stat data/     # must print nothing
git -C ../SydneyRealEstateFindings checkout -- data/runs/
```

**Step 3 below deliberately breaks it.** That is the only step that does, and when it does,
say so in the commit rather than quietly letting it fail.

---

## 2. Why not just run it now

Three reasons, and the third is the one people underestimate. **The first is now closed** —
Steps 1, 2 and 3 landed on 2026-09-01 — but the other two stand, so the answer is still *not yet*.

~~**Step 1 is still open.**~~ Done. The thing that could *silently corrupt what a run claims* now
throws instead. Worth knowing that it was not hypothetical: the archive had already drifted a week
by the time the check was written (see Step 1). Two consequences for what follows — a pilot must be
captured and built inside one Tue–Sun window (Step 4), and rebuilding either committed capture now
needs `--force`.

**Four code paths have never executed** — `capture`'s fetch loop, the absence gate's fetch
loop, `toComposition`, and the R2 upload inside `build` (FRESH-RUN.md §2). A full 398-location
pass over both modes would be simultaneously the most expensive run this project has ever done
and the first execution of all four.

**The cost is unknown, and the one measurement in hand is misleading.** From the transit
capture's own `travel_report`:

```
unique_buildings   9,136
cached_buildings   8,459     ← 93% of them were already cached
geocode_calls        698
matrix_calls         214
```

That run paid for 698 geocodes because the old `~/.realestate-mcp/distance-cache.json` already
held what it needed. **A fresh run starts at zero** — the committed cache is empty by design,
and Errol chose to start fresh rather than copy the old one. So those numbers measure a warm
run, and a fresh full-envelope pass is a cold one at roughly five times the location count.
Do not extrapolate from them. Measure a cold pilot instead (Step 5).

---

## 3. The six steps

### Step 1 — `build` must refuse a capture whose arrive-by is not the one it computed — **done, 2026-09-01**

**Why.** `capture` takes `--arrive-by` and records it on every transit group.
[build.ts:163](src/stages/build.ts) computes `transitDeparture` **itself** from
`site.commute_assumption` and writes it to `run.json` at line 536. Nothing compares them.

`resolveTransitDeparture` returns the next matching weekday at least two days out, so it
*drifts*. Capture on a Sunday and build on a Wednesday and they are different Tuesdays. The run
then states an arrive-by that its transit minutes were never measured against — the exact fake
precision this project keeps removing, and invisible from the outside because the numbers look
fine.

**What changed.** `transitArriveByMismatches` in [src/lib/sydney.ts](src/lib/sydney.ts) — a pure
function over `{origin, mode, arrive_by}[]` plus the resolved moment, so it is testable without a
capture. [build.ts](src/stages/build.ts) calls it immediately after `transitDeparture` is computed
and `fail()`s naming both values and both sources. `--force` builds anyway. Walk and drive groups
are skipped: their null `arrive_by` is normal. A *transit* group with a null is reported, because
there is no moment to reconcile it against at all. [run.ts](src/stages/run.ts) forwards `--force`
to `build` alongside `--photos=` and `--local-images`, so a `--resume` that crosses a Monday has a
way through rather than a wall.

**Verified.** Eight assertions in `test/scoring.test.ts` over both directions (match, week-drifted,
null, absent, walk, drive, mixed, empty) — 233 tests now, was 225. End to end: the transit capture
is refused with exit 1, the walk capture builds clean, `--force` builds the transit one.

> **The original verification note here was wrong, and worth reading before you trust the next
> one.** It said "neither committed capture has a transit group whose `arrive_by` disagrees with
> what `site.json` produces today, so nothing should move." That was true on 2026-08-30 and false
> by 2026-09-01: the capture records `2026-09-01T09:00`, and `resolveTransitDeparture` now returns
> `2026-09-08T09:00`. The drift this step exists to catch had already happened to the project's own
> archive — which is the argument for the step, not against it.
>
> The replay invariant holds anyway, for a reason that does not rot:
> [replay.ts:347](src/stages/replay.ts) spreads `...previous`, carrying
> `transit_departure_resolved` over untouched. **`replay` never calls `resolveTransitDeparture`**,
> so a check inside `build` cannot reach it, whatever the calendar says.
>
> The consequence the original note obscured: **`build` now refuses both committed captures**, and
> will refuse any archived capture more than a few days old. That is correct — the arrive-by really
> does disagree — but it makes `--force` a requirement for rebuilding from the archive rather than
> the nicety Step 1 first called it.

**Touches REA or money?** No.

---

### Step 2 — `check:shares` must read the capture the way `build` does — **done, 2026-09-01**

**Why.** [check-shares.ts:47](src/stages/check-shares.ts) reads `capture.results` — the legacy
flat array, which every capture since named searches leaves empty. So it has reported
`0 flagged` on every real capture for as long as group-based captures have existed. AGENT.md
§5–9 tells a reader to read it before trusting a run, which means that instruction currently
points at a check that cannot see anything.

You need this working **before** the pilot, not after: it is how you verify the share-house
classifier against the new capture.

**What changed.** `flattenCapture(capture).listings`, as `build` and `audit-capture` do, mapped
through `item.listing`. The hand-rolled `returnedIds` filter is gone — `flattenCapture` already
dedupes by id.

**Verified.** Against the committed captures, and it agrees with both other readers of the same
files:

| | `check:shares` | `audit capture` | `build --dry-run` |
|---|---|---|---|
| transit25 | **288 listings, 18 flagged** (was `0`) | 288 | 288 usable |
| walk15 | **12 listings, 1 flagged** (was `0`) | 12 | 12 usable, 1 share |

**Touches REA or money?** No.

---

### Step 3 — studio flagging — **decided and done, 2026-09-01: studios are in, labelled**

**The premise was wrong, and measuring it changed the decision.** Step 3 originally proposed
moving the site's prose patterns to map time so they could read the full description instead of
the 500-character snippet. Measured, that is worth **+2 listings in 265** — the run goes from 35
studios to 37. The justification borrowed the share classifier's "24 listings carry their only
signal past that cut"; the real figure for shares is 5 listings (24 is close to the 21 extra
*signals* across 18 listings, which is likely what was counted), and the studio analogue is 2.

What the measurement turned up instead:

**REA does have a `Studio` property type.** `studio.ts` opened by asserting the opposite — "REA
has no studio category… of the three structured fields a filter could use, none of them can find
one", and `exclude_keywords` "catches zero studios". In the 2026-08-24 transit capture, **30 of
335 unique listings carry `propertyType: "Studio"`**. `criteria.search.exclude_keywords` listed
`studio` and `excludedByKeyword` matches the property type, so all 30 were dropped before
anything saw them — while the 44 REA typed `Apartment`/`Unit`/`Flat` came through and got a
badge. Same kind of property, opposite treatment, decided by REA's data entry.

**Errol's call: studios are in, labelled.** Not excluded — the site already has a studio badge
and a facet filter, so the filtering belongs there, in front of a human, rather than in a
keyword list that only half worked.

**What changed.**

| | |
|---|---|
| `criteria.json` | `studio` out of `exclude_keywords`; **v6 → v7** |
| `searches.json` | `office-walk-15` gains `other` to its `property_types`, or it would still drop them (`mapPropertyType` sends `Studio` → `other`); **v8 → v9**. Admits 30 studios and 1 literal `Other` |
| `packages/schema` | `studio` on `ListingFlag`; `studio_signals: string[]` on `ListingEntry`, mirroring `share_signals` |
| `src/lib/studio.ts` (new, pipeline) | the site's patterns, unchanged, plus a `rea_property_type` signal; runs at map time over the full description |
| site `src/lib/studio.ts` | now a *reader* over `studio_signals` — no patterns left |
| `check studios` | new pipeline command over a capture (the quotes); the findings one now reads back what a run committed |

**Both sources are needed, which is why the flag is a union.** Ten of the 30 REA-typed studios
never say the word anywhere in the description — prose alone would have let every one of them
back in unlabelled. And 40 in the capture are prose-only, typed as something else. The property
type is evaluated *independently of the negation guard*: an ad reading "not a studio" while REA
types it `Studio` is a disagreement worth surfacing, not a reason to discard the structured
field.

**Verified.**

- `check studios` over the transit capture: **70 flagged — 30 typed, 40 prose-only**. Three
  unflagged listings still mention the word, and all three are correct: two yoga studios and
  `438892060`, the "true one bedroom (not a studio)" ad the original file cited as the reason
  never to substring-match.
- **The invariant broke on purpose**: 37 listings in `2026-08-25a` and 2 in `2026-08-24a`
  gained the flag. Nothing else moved — same ids, same prices, same composite scores, verified
  field by field.
- **Re-established**: replaying twice after the change is byte-identical to itself.
- 246 assertions (was 233); a new `check studio` suite pins the mechanical halves — the type
  signal, its independence from the prose, and the negation guard.

**One thing this does not do.** The 30 typed studios **do not appear in the committed runs**, and
cannot. [replay.ts:131](src/stages/replay.ts) reads `previous.criteria_snapshot` — "the run's own
snapshot, not today's" — and line 161 filters to ids already in the run. Both are deliberate:
adding listings to a past run would be inventing history. So `check:studios` on `2026-08-25a`
reports `0 because REA typed it that way`, and **the config change first bites on the fresh
run** — which is Step 6, and is where to check it landed.

**Touches REA or money?** No.

---

### Step 4 — a small attended pilot. **Ask Errol first. This is a real REA pass.**

**Why.** This is the whole point of the sequence. Watch the never-executed paths on a small pass
before committing to a large one.

```bash
node dist/cli.js run --search \
  --out="$CAPTURES/<date>-pilot.json" \
  --arrive-by=<the value resolveTransitDeparture returns today> \
  --only=<two or three suburbs> \
  --photos=8
```

`--only` restricts the pass; `--core` names what to page to exhaustion. A narrow capture keeps
the absence gate small too, which is what you want the first time.

**Capture and build inside the same week, or Step 1 will refuse your own pilot.**
`resolveTransitDeparture` answers "the first Tuesday at least two days out", so it is stable from
a Tuesday through the Sunday after it and rolls a week forward **every Monday**:

```
Tue 2026-09-01 → Sun 2026-09-06    resolves to 2026-09-08T09:00:00+10:00
Mon 2026-09-07 onwards             resolves to 2026-09-15T09:00:00+10:00
```

Capture on the Sunday and build on the Monday and `build` throws — correctly, because the minutes
really were measured against the older moment. Get the value from
`node -e "console.log(require('./dist/lib/sydney.js').resolveTransitDeparture('Tuesday','09:00'))"`
rather than copying one out of this file; it is a moving target by design.

**What to watch, before resuming:**

- the capture parses, and `audit capture <file>` looks sane;
- `check:shares` against it now says something (Step 2);
- paging to exhaustion, the `totalPages` reconciliation, and the bot-block backoff;
- the absence table — do the verdicts match what the pages actually say?
- **kill the absence gate partway on purpose**, and confirm the capture's `gone` map holds what
  was already checked. It checkpoints every 25;
- transit listings get a `composition` with real legs, not a `noJourney` tally;
- photos actually reach R2 — `validate --check-remote` goes green.

Then `run --resume` through build → enrich → replay → validate.

**Then throw the pilot away.** `git checkout -- data/` in findings, or `reset` if photos went
to R2. Say so out loud in whatever you report, so nobody mistakes a rehearsal for a run.

**Touches REA or money?** **Yes, both.** Ask first.

---

### Step 5 — cost the real run from the pilot, and take the number to Errol

**Why.** See §2. The committed telemetry measures a 93%-cache-hit run and tells you nothing
about a cold one.

**What to do.** The pilot's per-group `travel_report` prints `geocode_calls`, `matrix_calls`,
`unique_buildings` and `cached_buildings`. With an empty cache `cached_buildings` should be near
zero — if it is not, the cache is not the one you think it is; check
`REALESTATE_MCP_DISTANCE_CACHE` in `.env` points at
`SydneyRealEstateFindings/data/cache/mcp-cache.json`.

Extrapolate per location, then multiply by the share of the envelope you intend to cover.
Google bills Route Matrix Essentials and Geocoding at 10k/month free, then $5/1k each. Never
send a clock on a road mode — it moves Google to the traffic-aware SKU at double.

`npm run check:cache` reports what the committed cache holds and how much of it is near
Google's 30-day expiry.

**Take the number to Errol before spending it.**

**Touches REA or money?** No — it is arithmetic on the pilot.

---

### Step 6 — the real run. **Ask Errol.**

**One capture covers both searches.** `planSearchQueries` returns one group per `origin:mode`
and `build` handles several, so capture with `--arrive-by` set and **no `--searches` filter**,
and both `office-walk-15` and `train-25` get answered by one run. That is what clears
`validate` warning #2.

**Check the studios landed.** Step 3 lifted the `studio` keyword exclusion, and that change
cannot show up in a replay — this is the first run where it bites. `check studios <capture>`
should report a non-zero count in its "typed Studio by REA" column, and `npm run check:studios`
on the new run should agree. If both say zero, the exclusion is still in force somewhere.

**You do not need all 398 locations.** What makes the committed runs stale is that they answered
**criteria v5 / searches v6** while config is now **v7 / v9** — not coverage. A run over the 82
locations transit already covered plus the walk 25 would answer both searches on current
config, exercise the absence gate against a real ledger, and cost a fraction of a full envelope
pass. FRESH-RUN.md §8 asks only for "a deliberate and stated share of the envelope". Full
envelope is a separate decision, and a better one to make after Step 5 has produced a real
number.

Run with `--photos=8` (FRESH-RUN.md §3.4 — the site looks thin at one).

Then `run --resume` through the rest, and write the commentary. It is gate 2, and `run` refuses
to call a run ready without it.

**Then:** both gates, `validate --check-remote` (not optional — the local mirror existing proves
nothing about what a viewer sees), then **one commit in the findings repo**:

```
run: <run-id> — N listings (X new, Y price drops, Z leased)
```

Ask before pushing.

**Touches REA or money?** **Yes, both.** Ask first.

---

## 4. Non-negotiables

1. **Never run a real REA search or absence pass without asking Errol.** `capture` and the
   absence gate both talk to REA. That is Steps 4 and 6.
2. **Ask before pushing**, either repo. Two commits are already sitting local.
3. **Never infer an absence verdict.** A page you could not reach gets no verdict and stays out
   of the `gone` map — two consecutive absences make it `stale` on their own. `run` already
   behaves this way; do not "improve" it.
4. **Data commits land in the findings repo**, one commit, after both gates pass.
5. **Do not fix logic mid-run.** A bug found while running is its own commit, with the replay
   invariant re-checked.
6. **One Chrome profile, one process.** `capture` and the absence gate use the same warm profile
   as the MCP adapter, so Claude Code must not have the server up while either runs.
   `./scripts/reload-mcp.ps1` clears it; `-CheckOnly` inspects. Run `node dist/cli.js setup`
   first — a cold profile is the single most common cause of a failed capture.
7. Git-style `feat:` / `fix:` / `refactor:` / `test:` / `docs:` subjects. No force-push.

---

## 5. Done means

- [ ] **§0** — on a new machine: **both captures on disk with matching sha256**, repos
      siblings, `.env` rebuilt with the new cache path, profile warmed, and the replay
      invariant clean before any code is touched.
- [x] **Step 1** — `build` refuses a capture whose transit arrive-by is not the one it computed.
      Done 2026-09-01; `--force` overrides. Both committed captures are now refused without it.
- [x] **Step 2** — `check:shares` reports a real number against a group-based capture.
      Done 2026-09-01: 288/18 on transit25, 12/1 on walk15, agreeing with `audit capture`.
- [x] **Step 3** — studio flagging decided with Errol, and done before the run.
      Decided 2026-09-01: **studios are in, labelled**, not excluded. `criteria.json` v7,
      `searches.json` v9, `studio` on `ListingFlag`, classifier moved to the pipeline.
      Invariant broken on purpose (39 listings gained the flag) and re-established.
- [ ] **Step 4** — a pilot run, attended, with the absence gate deliberately interrupted once
      and its `gone` map checked. Thrown away afterwards, and said so.
- [ ] **Step 5** — a cold-cache cost for the intended envelope share, agreed with Errol.
- [ ] **Step 6** — one capture answering **both** searches on criteria v7 / searches v9, over a
      deliberate and stated share of the envelope, with `--photos=8`.
- [ ] Both gates green, `validate --check-remote` clean, and its first two warnings gone.
- [ ] The site read on a phone and judged to look right — not just to pass its checks.
- [ ] Committed in the findings repo; pushed only when Errol says.
- [ ] FRESH-RUN.md and this file updated with what actually happened, in the shape
      PHASE2-REPORT.md took.

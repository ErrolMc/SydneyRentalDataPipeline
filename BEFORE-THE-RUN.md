# BEFORE-THE-RUN.md — the six things to do before the first fresh capture, in order

**Read [FRESH-RUN.md](FRESH-RUN.md) first.** It is the handoff that explains *why* a fresh run
is delicate: the pipeline was rebuilt in [PHASE2.md](PHASE2.md) and verified against captures
that already existed, so several code paths a fresh run needs have never executed. This file
does not replace it. It is the ordered sequence that came out of asking one question —
*is it wise to do fresh runs for both searches now?* — and answering **not yet**.

Also read the findings repo's `AGENT.md` (the run protocol, and the authority on what to
commit) and [README.md](README.md) (the commands).

---

## 1. Where things stand, 2026-08-30

Three commits have landed since FRESH-RUN.md was written. Two of them are **local and
unpushed** — ask Errol before pushing, always.

| Commit | Repo | State | What it did |
|---|---|---|---|
| `15af160` | pipeline | pushed | A suburb has one centroid, and `places.json` owns it. `build` realigns the 43 committed profiles that had drifted (up to 1.47 km) and seeds new ones from the envelope instead of re-geocoding. |
| `43a4832` | findings | **local** | `McpCacheSchema` + `cacheExpiry`; cache moved to `data/cache/`; `SuburbProfile.observed_rents`; `FactorScore.source`. |
| `c7a4e7e` | pipeline | **local** | `reset` now empties the route cache (it did not, which was a live bug); the cache is written sorted and reported by `validate`; `build` computes `observed_rents`; `suburbFactor` falls back to them. |

Current shape:

```
src/stages/   13 stages + run.ts, each `export async function main(argv)`
src/lib/      their logic: scoring, ledger, search planning, walkability, suburbs, photos/R2
test/         7 node --test suites, 225 assertions
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
empty in the findings repo. It still holds as of `c7a4e7e` — run it after every change to
`src/lib/`:

```bash
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-walk15.json"    --run-id=2026-08-24a
node dist/cli.js replay "E:/Personal Projects/SydneyRealEstate/captures/2026-08-24-transit25.json" --run-id=2026-08-25a
git -C ../SydneyRealEstateFindings diff --stat data/     # must print nothing
git -C ../SydneyRealEstateFindings checkout -- data/runs/
```

**Step 3 below deliberately breaks it.** That is the only step that does, and when it does,
say so in the commit rather than quietly letting it fail.

---

## 2. Why not just run it now

Three reasons, and the third is the one people underestimate.

**Step 1 is still open.** It is the only remaining item that can *silently corrupt what a run
claims*, and FRESH-RUN.md §3.1 says to fix it before any fresh capture. It has not been fixed.

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

### Step 1 — `build` must refuse a capture whose arrive-by is not the one it computed

**Why.** `capture` takes `--arrive-by` and records it on every transit group.
[build.ts:163](src/stages/build.ts) computes `transitDeparture` **itself** from
`site.commute_assumption` and writes it to `run.json` at line 536. Nothing compares them.

`resolveTransitDeparture` returns the next matching weekday at least two days out, so it
*drifts*. Capture on a Sunday and build on a Wednesday and they are different Tuesdays. The run
then states an arrive-by that its transit minutes were never measured against — the exact fake
precision this project keeps removing, and invisible from the outside because the numbers look
fine.

**What to change.** After `transitDeparture` is computed and the capture is loaded (both are in
scope by line 163), compare it against `arrive_by` on every transit group in the capture and
**throw** on a mismatch, naming both values and both sources. A `--force` escape hatch is fine.
Silence is not. A group with a null `arrive_by` on a non-transit mode is normal and must not
trip it.

**Verify.** A unit test in `test/` over the comparison, both directions. The replay invariant
must still hold — neither committed capture has a transit group whose `arrive_by` disagrees
with what `site.json` produces today, so nothing should move.

**Touches REA or money?** No.

---

### Step 2 — `check:shares` must read the capture the way `build` does

**Why.** [check-shares.ts:47](src/stages/check-shares.ts) reads `capture.results` — the legacy
flat array, which every capture since named searches leaves empty. So it has reported
`0 flagged` on every real capture for as long as group-based captures have existed. AGENT.md
§5–9 tells a reader to read it before trusting a run, which means that instruction currently
points at a check that cannot see anything.

You need this working **before** the pilot, not after: it is how you verify the share-house
classifier against the new capture.

**What to change.** Use `flattenCapture(capture).listings`, as `build` and `audit-capture` do.
It returns `CapturedListing[]` — `{ listing: ReaListing, travel: Record<string, Travel> }` —
so the `.map` reaches through `item.listing` rather than taking the row directly.
`flattenCapture` already dedupes by id, so the `returnedIds` filter in the current chain
becomes redundant and should go.

**Verify.** Run it against the committed transit capture. It must report a non-zero flagged
count where it previously said zero. Cross-check against
`node dist/cli.js audit capture <file>`, which already flattens correctly.

**Touches REA or money?** No.

---

### Step 3 — decide studio flagging with Errol, and if yes, do it now

**Why.** The site's `src/lib/studio.ts` classifies studios from `description_snippet` — the 500
characters a run keeps. The pipeline's `src/lib/rea.ts` has the **full description** at map
time. `studio.ts`'s own notes say the snippet undercounts and name the fix: move the patterns
into `rea.ts`, add `studio` to `ListingFlag`, replay.

It is cheaper before the run than after. Do it now and it lands in the new data for free; do it
later and it needs its own replay and its own data commit.

**This is the one step that changes committed data**, which is why it is a decision and not a
task. It will move the numbers, and the replay invariant will fail on purpose.

**What to change.** Patterns into `src/lib/rea.ts` at map time; `studio` added to `ListingFlag`
in the findings repo's `packages/schema/src/listing-enums.ts`; the site's `studio.ts` reads the
flag instead of re-deriving it.

**Verify.** Replay both captures and read the diff — do not restore it blindly. The listings
that gained a `studio` flag should be ones a human agrees are studios. Say in the commit that
the invariant broke and why. Re-establish it: after the change, replaying twice must still be
byte-identical to itself.

**Touches REA or money?** No.

---

### Step 4 — a small attended pilot. **Ask Errol first. This is a real REA pass.**

**Why.** This is the whole point of the sequence. Watch the never-executed paths on a small pass
before committing to a large one.

```bash
node dist/cli.js run --search \
  --out="E:/Personal Projects/SydneyRealEstate/captures/<date>-pilot.json" \
  --arrive-by=<the value resolveTransitDeparture returns today> \
  --only=<two or three suburbs> \
  --photos=8
```

`--only` restricts the pass; `--core` names what to page to exhaustion. A narrow capture keeps
the absence gate small too, which is what you want the first time.

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

**You do not need all 398 locations.** What makes the committed runs stale is that they answered
**criteria v5 / searches v6** while config is now **v6 / v8** — not coverage. A run over the 82
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

- [ ] **Step 1** — `build` refuses a capture whose transit arrive-by is not the one it computed.
- [ ] **Step 2** — `check:shares` reports a real number against a group-based capture.
- [ ] **Step 3** — studio flagging decided with Errol, and done before the run if yes.
- [ ] **Step 4** — a pilot run, attended, with the absence gate deliberately interrupted once
      and its `gone` map checked. Thrown away afterwards, and said so.
- [ ] **Step 5** — a cold-cache cost for the intended envelope share, agreed with Errol.
- [ ] **Step 6** — one capture answering **both** searches on criteria v6 / searches v8, over a
      deliberate and stated share of the envelope, with `--photos=8`.
- [ ] Both gates green, `validate --check-remote` clean, and its first two warnings gone.
- [ ] The site read on a phone and judged to look right — not just to pass its checks.
- [ ] Committed in the findings repo; pushed only when Errol says.
- [ ] FRESH-RUN.md and this file updated with what actually happened, in the shape
      PHASE2-REPORT.md took.

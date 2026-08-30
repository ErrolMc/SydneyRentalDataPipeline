// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  CriteriaSchema,
  FACTOR_KEYS,
  GOOGLE_GEO_TTL_DAYS,
  IndexSchema,
  LedgerSchema,
  McpCacheSchema,
  RunSchema,
  SearchesSchema,
  SiteConfigSchema,
  SuburbsSchema,
  cacheExpiry,
  type Run,
} from 'sydney-rental-schema'
import { DATA_DIR, PUBLIC_DIR, dataPath, readJsonFile } from '../lib/json-io.js'
import { objectExists, objectKeyFor, r2ConfigFromEnv } from '../lib/r2.js'
import { StageError, fail as stop, failAfterReport } from '../lib/stage-error.js'

/**
 * Protocol step 10 (PLAN.md §4): the gate that stands between a run and a
 * commit. Zod-parse every data file, then check the things zod cannot see —
 * the cross-file references, and whether the photos a run promises can actually
 * be served.
 *
 * Vercel's build parses the same schemas via `src/lib/data.ts`, so a malformed
 * export cannot take the site down. But it should never leave this machine
 * either, which is what this script is for.
 *
 *   node dist/cli.js validate                    → structure + the local mirror
 *   node dist/cli.js validate --check-remote     → also HEAD every photo in R2
 *
 * Exit 0 clean, exit 1 with a list of problems.
 */

/**
 * Photos are served from R2, so the local mirror existing proves nothing about
 * what the site can actually render. `--check-remote` HEADs every distinct
 * photo in the bucket; AGENT.md requires it before a run is committed.
 */
let CHECK_REMOTE = false
const REMOTE_CONCURRENCY = 16

const errors: string[] = []
const warnings: string[] = []

/** Every distinct photo path any run promises — the set `--check-remote` verifies. */
const allPhotoPaths = new Set<string>()
/** Local-mirror gaps, held back until we know whether a mirror exists at all. */
const missingLocally: string[] = []

const fail = (message: string) => errors.push(message)
const warn = (message: string) => warnings.push(message)

async function exists(absolute: string): Promise<boolean> {
  try {
    await access(absolute)
    return true
  } catch {
    return false
  }
}

/** `/images/listings/1467/01.webp` → the file on disk under `public/`. */
function publicPath(sitePath: string): string {
  return path.join(PUBLIC_DIR, sitePath.replace(/^\//, ''))
}

async function listRunFolders(): Promise<string[]> {
  try {
    const entries = await readdir(dataPath('runs'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Zod strips unknown keys, so a run carrying a tenth factor would parse
 * cleanly. Checking the mirror against the file as written is the only way to
 * catch a factor set that has drifted from `criteria.weights`.
 */
async function checkFactorKeys(runId: string): Promise<void> {
  const raw = JSON.parse(await readFile(dataPath('runs', runId, 'run.json'), 'utf8'))
  const expected = [...FACTOR_KEYS].sort().join(',')

  const weightKeys = Object.keys(raw.criteria_snapshot?.weights ?? {}).sort().join(',')
  if (weightKeys !== expected) {
    fail(`runs/${runId}: criteria_snapshot.weights keys are [${weightKeys}], expected [${expected}]`)
  }

  for (const listing of raw.listings ?? []) {
    const factorKeys = Object.keys(listing.scores?.factors ?? {}).sort().join(',')
    if (factorKeys !== expected) {
      fail(`runs/${runId}: listing ${listing.id} factors are [${factorKeys}], expected [${expected}]`)
      break
    }
  }
}

async function validate(): Promise<void> {
  // ── every data file parses ─────────────────────────────────────────────────
  const [site, criteria, searches, index, ledger, suburbs] = await Promise.all([
    readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema).catch((error: Error) => {
      fail(error.message)
      return null
    }),
    readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema).catch((error: Error) => {
      fail(error.message)
      return null
    }),
    readJsonFile(dataPath('config', 'searches.json'), SearchesSchema).catch((error: Error) => {
      fail(error.message)
      return null
    }),
    // A missing index is how a repo with no runs looks, not a fault — the site
    // handles it and `build-run.ts` has always treated it as "first run". It is
    // only a problem if run folders exist that nothing points at, which the
    // orphan check below catches.
    readJsonFile(dataPath('index.json'), IndexSchema).catch((error: Error) => {
      if (!/missing file|no such file|ENOENT/i.test(error.message)) fail(error.message)
      return null
    }),
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema).catch((error: Error) => {
      fail(error.message)
      return null
    }),
    readJsonFile(dataPath('knowledge', 'suburbs.json'), SuburbsSchema).catch((error: Error) => {
      fail(error.message)
      return null
    }),
  ])

  if (site && site.office.address.toLowerCase().includes('placeholder')) {
    fail('config/site.json still has the placeholder office address — it feeds config_hash')
  }

  const folders = await listRunFolders()
  const runs = new Map<string, Run>()

  for (const folder of folders) {
    try {
      const run = await readJsonFile(dataPath('runs', folder, 'run.json'), RunSchema)
      // Folder name, `run_id` and the index entry all have to agree, or a
      // rollback would repoint `current_run` at something unexpected.
      if (run.run_id !== folder) {
        fail(`runs/${folder}: declares run_id "${run.run_id}"`)
      }
      runs.set(folder, run)
      await checkFactorKeys(folder)
    } catch (error) {
      fail((error as Error).message)
    }
  }

  if (!index) {
    if (folders.length > 0) {
      fail(
        `data/index.json is missing but ${folders.length} run folder(s) exist (${folders.join(', ')}) — ` +
          'nothing points at them, so the site cannot show them',
      )
    } else {
      warn('no runs yet — data/index.json is absent, which is the expected state before the first run')
    }
    report()
    return
  }

  // ── manifest ↔ run folders ─────────────────────────────────────────────────
  const manifestIds = index.runs.map((run) => run.id)
  if (new Set(manifestIds).size !== manifestIds.length) fail('index.json: duplicate run ids')

  for (const entry of index.runs) {
    const run = runs.get(entry.id)
    if (!run) {
      fail(`index.json lists run ${entry.id} but data/runs/${entry.id}/run.json is missing`)
      continue
    }
    if (entry.date !== entry.id.slice(0, 10)) {
      fail(`index.json: run ${entry.id} date "${entry.date}" disagrees with its id`)
    }
    if (entry.listing_count !== run.listings.length) {
      fail(
        `index.json: run ${entry.id} says ${entry.listing_count} listings, run.json has ${run.listings.length}`,
      )
    }
    if (entry.new_count !== run.summary.new) {
      fail(`index.json: run ${entry.id} says ${entry.new_count} new, run.json summary says ${run.summary.new}`)
    }
    if (entry.criteria_version !== run.criteria_version) {
      fail(`index.json: run ${entry.id} criteria_version disagrees with run.json`)
    }
    if (run.criteria_snapshot.version !== run.criteria_version) {
      fail(`runs/${entry.id}: criteria_snapshot.version disagrees with criteria_version`)
    }
  }

  for (const folder of folders) {
    if (!manifestIds.includes(folder)) fail(`data/runs/${folder} exists but is not in index.json`)
  }

  if (!manifestIds.includes(index.current_run)) {
    fail(`index.json: current_run "${index.current_run}" is not in runs[]`)
  }

  // ── cross-file references + photos on disk ─────────────────────────────────
  const knownRunIds = new Set(manifestIds)

  for (const [runId, run] of runs) {
    if (!run.commentary.trim()) warn(`runs/${runId}: commentary is empty`)

    // A run either predates named searches or answers them; there is no valid
    // middle where it carries results for searches it did not record.
    const defined = new Set(run.searches_snapshot.map((search) => search.id))
    /** What the run actually queried REA for, as opposed to what it knew about. */
    const asked = new Set(run.searches.map((result) => result.id))
    for (const result of run.searches) {
      if (!defined.has(result.id)) {
        fail(`runs/${runId}: searches[] reports "${result.id}", which is not in searches_snapshot`)
      }
      if (result.matched > result.considered) {
        fail(
          `runs/${runId}: search "${result.id}" matched ${result.matched} of ${result.considered} ` +
            'considered — a search cannot match more listings than it was given',
        )
      }
    }

    for (const listing of run.listings) {
      const where = `runs/${runId}: listing ${listing.id}`

      if (ledger && !ledger.listings[listing.id]) {
        fail(`${where} has no entry in knowledge/listings.json`)
      }

      for (const searchId of listing.matched_searches) {
        if (!defined.has(searchId)) {
          fail(`${where} claims search "${searchId}", which is not in this run's searches_snapshot`)
        }
        // Tightened 2026-08-26, from the snapshot to what the run actually
        // ASKED. A listing may only claim a search that went to REA for it: the
        // snapshot is merely the config as it stood, so checking against it
        // permits a run to claim an answer it never went and got. That is not
        // hypothetical — the moment listings gained a cached walk time, ten of
        // them started matching `office-walk-15` in a run that only ever asked
        // `train-25`, and this check passed. It is the false zero's mirror
        // image: a false *answer*.
        if (asked.size > 0 && !asked.has(searchId)) {
          fail(
            `${where} claims search "${searchId}", which run ${runId} never asked` +
              ` — it asked ${[...asked].join(', ')}`,
          )
        }
      }

      // The run IS the searches' answer, so a listing in it that no search
      // matched is a listing nothing asked for.
      if (defined.size > 0 && listing.matched_searches.length === 0) {
        fail(`${where} matched no search, but the run has searches`)
      }

      if (suburbs && !suburbs.suburbs[listing.enrichment.suburb_ref]) {
        fail(`${where} references unknown suburb "${listing.enrichment.suburb_ref}"`)
      }

      if (!knownRunIds.has(listing.first_seen_run)) {
        fail(`${where} first_seen_run "${listing.first_seen_run}" is not a known run`)
      }

      if (listing.images.count !== listing.images.photos.length) {
        fail(`${where} images.count is ${listing.images.count} but has ${listing.images.photos.length} photos`)
      }

      const expectedHero = listing.images.photos[0]?.src ?? null
      if (listing.images.hero !== expectedHero) {
        fail(`${where} hero "${listing.images.hero}" is not the first photo`)
      }

      for (const photo of listing.images.photos) {
        for (const sitePath of [photo.src, photo.thumb]) {
          allPhotoPaths.add(sitePath)
          if (!(await exists(publicPath(sitePath)))) {
            // The mirror is gitignored, so a fresh clone legitimately has none
            // of it. Only the machine that produced a run can check locally;
            // --check-remote is what proves the site can serve them.
            missingLocally.push(`${where} photo not in the local mirror: ${sitePath}`)
          }
        }
      }
    }
  }

  // ── ledger internals ───────────────────────────────────────────────────────
  if (ledger) {
    for (const [id, entry] of Object.entries(ledger.listings)) {
      const where = `knowledge/listings.json: ${id}`

      for (const runId of [entry.first_seen_run, entry.last_seen_run]) {
        if (!knownRunIds.has(runId)) fail(`${where} references unknown run "${runId}"`)
      }
      for (const point of entry.price_history) {
        if (!knownRunIds.has(point.run)) fail(`${where} price_history references unknown run "${point.run}"`)
      }
      for (const point of entry.status_history) {
        if (!knownRunIds.has(point.run)) fail(`${where} status_history references unknown run "${point.run}"`)
      }
      if (entry.status_history[entry.status_history.length - 1]?.status !== entry.status) {
        fail(`${where} status "${entry.status}" disagrees with the end of status_history`)
      }
      if (entry.images.count !== entry.images.files.length) {
        fail(`${where} images.count disagrees with files[]`)
      }
      for (const file of entry.images.files) {
        if (!(await exists(path.join(PUBLIC_DIR, 'images', 'listings', id, file)))) {
          missingLocally.push(`${where} ledger photo not in the local mirror: ${file}`)
        }
      }
    }
  }

  // A config edit between runs is normal; the site showing a search the current
  // run never answered is not. Warn rather than fail — the fix is a new run.
  const current = index && runs.get(index.current_run)
  if (searches && current) {
    if (current.searches_version !== null && current.searches_version !== searches.version) {
      warn(
        `config/searches.json is v${searches.version} but the current run answered v${current.searches_version} — ` +
          'the site shows the run, not the config, until the next run',
      )
    }
    /**
     * A saved search the current run never asked. Not an error — which searches
     * a run covers is decided at capture time, and `office-walk-15` has sat
     * un-asked since it was paused mid-tuning. Worth saying out loud, because
     * the alternative is noticing months later that a question stopped being
     * answered.
     */
    for (const search of searches.searches) {
      if (!current.searches.some((result) => result.id === search.id)) {
        warn(
          `config/searches.json: "${search.id}" is saved but run ${current.run_id} did not ask it — ` +
            'its page shows the last run that did',
        )
      }
    }
  }

  if (criteria && suburbs) {
    for (const key of criteria.search.preferred_suburbs) {
      if (!suburbs.suburbs[key]) warn(`criteria.json: preferred suburb "${key}" has no profile yet`)
    }
  }

  await checkRouteCache()
  await checkLocalMirror()
  await checkRemotePhotos()

  report()
}

/**
 * What the committed route cache holds, and how much of it is about to stop
 * being usable.
 *
 * Nothing here can fail a commit. An expired position is re-geocoded rather
 * than served — `geoExpired` in the pipeline's `distance.ts` sees to that — so
 * this is a cost signal, not a correctness one: every expiring entry is one the
 * next run pays Google for again. It is reported because a cache is the one
 * committed file whose contents nobody opens, and because until this existed
 * the file had no schema and the gate never looked at it at all.
 */
async function checkRouteCache(): Promise<void> {
  const cache = await readJsonFile(dataPath('cache', 'mcp-cache.json'), McpCacheSchema).catch(() => null)

  if (!cache) {
    // Absent is not an error. `.env` may point the cache at a home directory,
    // which is the default and a perfectly good place for it.
    return
  }

  const routes = Object.keys(cache.routes).length
  const positions = Object.keys(cache.geo).length
  const expiry = cacheExpiry(cache, Date.now())

  console.log(
    `  cache       ${routes} route(s), ${positions} position(s)` +
      `${expiry.google ? ` — ${expiry.google} from Google` : ''}`,
  )

  if (expiry.expired > 0) {
    warn(
      `${expiry.expired} cached position(s) are past Google's ${GOOGLE_GEO_TTL_DAYS}-day caching limit — ` +
        'they will be re-geocoded, and paid for, on the next run',
    )
  }
  if (expiry.expiringSoon > 0) {
    warn(
      `${expiry.expiringSoon} cached position(s) expire within a week — ` +
        'budget for re-geocoding them if a run is planned',
    )
  }
}

/**
 * A gap in the local mirror means one of two very different things. On a fresh
 * clone there is simply no mirror — the folder is gitignored — and that is not
 * a problem, because R2 serves the site. A *partial* mirror is a problem: it
 * means files went missing on the machine that produces runs.
 */
async function checkLocalMirror(): Promise<void> {
  if (missingLocally.length === 0) return

  const mirrorRoot = path.join(PUBLIC_DIR, 'images', 'listings')
  if (!(await exists(mirrorRoot))) {
    warn(
      `no local photo mirror at public/images/listings (${missingLocally.length} path(s) unchecked) — ` +
        'expected on a fresh clone; run with --check-remote to verify what the site serves',
    )
    return
  }

  for (const message of missingLocally) fail(message)
}

/** HEAD every distinct photo in R2. This is what actually proves the site can render a run. */
async function checkRemotePhotos(): Promise<void> {
  if (!CHECK_REMOTE) {
    if (allPhotoPaths.size > 0) {
      warn(`${allPhotoPaths.size} photo path(s) not verified in R2 — re-run with --check-remote before committing`)
    }
    return
  }

  const { config, missing } = r2ConfigFromEnv()
  if (!config) {
    fail(`--check-remote needs R2 credentials — missing ${missing.join(', ')} in the pipeline's .env`)
    return
  }

  const paths = [...allPhotoPaths]
  console.log(`  checking ${paths.length} photo(s) in R2 bucket "${config.bucket}"…`)

  let checked = 0
  const workers = Array.from({ length: Math.min(REMOTE_CONCURRENCY, paths.length) }, async () => {
    for (;;) {
      const sitePath = paths[checked++]
      if (sitePath === undefined) return
      try {
        if (!(await objectExists(config, objectKeyFor(sitePath)))) {
          fail(`photo missing from R2: ${sitePath}`)
        }
      } catch (error) {
        fail(`could not check ${sitePath} in R2: ${(error as Error).message}`)
      }
    }
  })

  await Promise.all(workers)
}

function report(): void {
  const scope = path.relative(process.cwd(), DATA_DIR).replace(/\\/g, '/')

  for (const message of warnings) console.warn(`  ⚠ ${message}`)

  if (errors.length === 0) {
    console.log(`\n✔ ${scope}/ is valid${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}\n`)
    return
  }

  console.error(`\n✖ ${errors.length} problem(s) in ${scope}/ — DO NOT COMMIT\n`)
  for (const message of errors) console.error(`  • ${message}`)
  console.error('')
  // The list above is the report; the CLI adds nothing to it.
  failAfterReport()
}

/**
 * `fail` here collects a problem with the data; it never throws. So an actual
 * throw out of `validate()` is a bug in the validator rather than a verdict on
 * the data, and has always been reported differently.
 *
 * Everything it accumulates is module state, reset on entry: `run` (PHASE2.md
 * Step 5) makes a second call in one process possible, and a stale `errors`
 * array would fail a run for problems the previous call already reported.
 */
export async function main(argv: string[]): Promise<void> {
  CHECK_REMOTE = argv.includes('--check-remote')
  errors.length = 0
  warnings.length = 0
  allPhotoPaths.clear()
  missingLocally.length = 0

  try {
    await validate()
  } catch (error) {
    if (error instanceof StageError) throw error
    stop(`validate crashed: ${(error as Error).message}`)
  }
}

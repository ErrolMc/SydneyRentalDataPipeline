// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { McpCacheSchema } from 'sydney-rental-schema'
import { dataPath, isoNow, readJsonFile, writeJsonFile, PUBLIC_DIR } from '../lib/json-io.js'
import { fail } from '../lib/stage-error.js'
import { deleteObject, listObjects, r2ConfigFromEnv } from '../lib/r2.js'

/**
 * Throw away every run and every photo, and start over.
 *
 *   npm run reset:data              # dry run — says what it would destroy
 *   npm run reset:data -- --confirm # actually does it
 *
 * This exists because during development the *shape* of a run changes, and at
 * some point replaying a capture stops being enough — the ledger, the photos and
 * the run all encode assumptions that no longer hold, and carrying them forward
 * costs more than re-collecting.
 *
 * What it destroys, and what it deliberately does not:
 *
 *   GONE  every object in the R2 bucket, listed from the bucket rather than
 *         from the ledger, so orphans from failed runs go too
 *   GONE  the local photo mirror
 *   GONE  data/runs/*, data/index.json
 *   RESET data/knowledge/*.json and data/cache/mcp-cache.json back to empty
 *   KEPT  data/config/* — criteria, site and searches are what you *want*,
 *         not what you found, and re-typing them is how mistakes happen
 *   KEPT  git history and tags. Runs stay recoverable at the commits that made
 *         them; this is a fresh start, not a rewrite of the past.
 *
 * The R2 deletion is the only irreversible part. Everything else is one
 * `git checkout` away.
 *
 * Photos and data are cleared **together**, and that is not tidiness. The image
 * pipeline decides what to download by looking at the local mirror on disk:
 * clear R2 but leave the mirror, and the next run finds the files already
 * present, skips the download, and writes a run.json full of paths that resolve
 * to nothing. Half a reset is worse than none.
 */


async function dirSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        files += 1
        bytes += (await stat(full)).size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function main(argv: string[]): Promise<void> {
  const CONFIRM = argv.includes('--confirm')

  console.log(`\nReset${CONFIRM ? '' : '  (dry run — nothing will be destroyed)'}`)

  // ── what is there ──────────────────────────────────────────────────────────
  const { config: r2, missing } = r2ConfigFromEnv()
  if (!r2) {
    fail(
      `R2 is not configured — missing ${missing.join(', ')} in the pipeline's .env.\n` +
        '  Refusing to reset: clearing the local side while the bucket keeps its objects\n' +
        '  leaves the next run downloading photos that are already there under keys\n' +
        '  nothing tracks any more.',
    )
  }

  console.log('\n  listing the bucket…')
  const keys = await listObjects(r2, 'images/listings/')
  console.log(`  R2          ${keys.length} object(s) in ${r2.bucket}`)

  const mirror = path.join(PUBLIC_DIR, 'images', 'listings')
  const local = await dirSize(mirror)
  console.log(`  mirror      ${local.files} file(s), ${mb(local.bytes)}`)

  let runs: string[] = []
  try {
    runs = (await readdir(dataPath('runs'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No runs directory at all is a perfectly good starting point.
  }
  console.log(`  runs        ${runs.length}${runs.length ? `: ${runs.join(', ')}` : ''}`)

  // Read before anything is destroyed, so the dry run can say what a real one
  // would cost. A route and a geocode are both money already spent.
  const cached = await readJsonFile(dataPath('cache', 'mcp-cache.json'), McpCacheSchema).catch(() => null)
  const routeCount = cached ? Object.keys(cached.routes).length : 0
  const geoCount = cached ? Object.keys(cached.geo).length : 0
  console.log(`  cache       ${routeCount} route(s), ${geoCount} position(s) — re-measuring these costs real money`)

  if (!CONFIRM) {
    console.log(
      '\n  Nothing was destroyed. Re-run with --confirm to go ahead.\n' +
        '  data/config/* and git history are kept either way.\n',
    )
    return
  }

  // ── R2 first: it is the only part that cannot be undone, so if it fails the
  // local side is still intact and consistent with the bucket.
  if (keys.length > 0) {
    console.log(`\n  deleting ${keys.length} object(s) from R2…`)
    let done = 0
    let failed = 0
    // Modest concurrency: enough to not take all afternoon, not so much that a
    // transient 5xx storm looks like a bucket-wide failure.
    const workers = Array.from({ length: Math.min(12, keys.length) }, async () => {
      for (;;) {
        const key = keys[done++]
        if (key === undefined) return
        try {
          await deleteObject(r2, key)
        } catch (error) {
          failed += 1
          if (failed <= 5) console.log(`    ⚠ ${key}: ${(error as Error).message}`)
        }
      }
    })
    await Promise.all(workers)
    console.log(`  deleted     ${keys.length - failed} object(s)${failed ? `, ${failed} failed` : ''}`)
    if (failed > 0) {
      fail('some objects could not be deleted — re-run to retry before clearing the local side')
    }
  }

  // ── local ──────────────────────────────────────────────────────────────────
  await rm(mirror, { recursive: true, force: true })
  console.log(`  removed     public/images/listings/`)

  await rm(dataPath('runs'), { recursive: true, force: true })
  console.log(`  removed     data/runs/`)

  // Deleted, not emptied. `IndexSchema` requires a non-empty `runs` and a
  // `current_run` naming one of them, so there is no valid empty index — absence
  // is how "no runs yet" is spelled, and every reader now understands it.
  await rm(dataPath('index.json'), { force: true })
  console.log(`  removed     data/index.json`)

  const now = isoNow()
  await writeJsonFile(dataPath('knowledge', 'listings.json'), {
    schema_version: 1,
    updated_at: now,
    listings: {},
  })
  await writeJsonFile(dataPath('knowledge', 'suburbs.json'), {
    schema_version: 1,
    updated_at: now,
    suburbs: {},
  })

  /**
   * The route cache, which this stage did not reach until now.
   *
   * That gap is the whole reason `docs/adr/0002` was blocked: a reset that
   * leaves the cache full means the very next capture re-serves days-old routes
   * and geocodes as though it had just measured them, which is the one failure
   * this project cannot see from the outside — the numbers look fine. It has
   * never bitten only because the committed cache has been empty since it was
   * committed, so there was nothing stale to serve. After the first real run
   * there will be.
   *
   * Emptied rather than deleted: `.env` points at this path, and a missing file
   * is a cache that silently starts working again from `~/.realestate-mcp/`.
   */
  await writeJsonFile(dataPath('cache', 'mcp-cache.json'), {
    schema_version: 1,
    updated_at: now,
    routes: {},
    geo: {},
  })

  console.log(`  emptied     data/knowledge/listings.json, suburbs.json`)
  console.log(`  emptied     data/cache/mcp-cache.json (${routeCount} route(s), ${geoCount} position(s))`)

  console.log('\n  Done. Next: npm run validate:data (expect one "no runs yet" warning),')
  console.log('  then capture and build the first run.\n')
}

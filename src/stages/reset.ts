// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import process from 'node:process'

import { assertKnownFlags, RESET_FLAGS } from '../lib/args.js'
import { readCacheFile } from '../lib/cache-file.js'
import { dataPath, isoNow, readJsonFile, writeJsonFile, PUBLIC_DIR } from '../lib/json-io.js'
import { fail } from '../lib/stage-error.js'
import { IndexSchema, LedgerSchema } from 'sydney-rental-schema'
import { deleteObject, listObjects, listingIdFromKey, r2ConfigFromEnv } from '../lib/r2.js'

/**
 * Throw away every run and every photo, and start over.
 *
 *   npm run reset:data                        # dry run — says what it would destroy
 *   npm run reset:data -- --confirm           # actually does it
 *   npm run reset:data -- --run=<id>[,<id>]   # remove only those runs
 *
 * `--run` exists because the unscoped form is all or nothing, which is right for
 * a shape change and far too much for "undo that run". Scoping has to be *by
 * run* rather than by kind: `--r2-only` or `--local-only` would produce exactly
 * the half-reset the last paragraph here warns about. Scoped, a photo is deleted
 * only when **no remaining run references its listing**, and the ledger's record
 * of those photos is cleared with them, so disk, bucket and ledger still agree.
 * Cumulative knowledge — the ledger entries themselves, suburbs, the route cache
 * — is kept, because it is still true.
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


/**
 * Remove named runs, and only what nothing else still needs.
 *
 * The unscoped reset can be brutal because it is meant to be. This one has to
 * leave the machine consistent, which means the hard part is not deleting the
 * run — it is deciding which photos may go with it. A listing appears in every
 * run that found it, so its photos may only be deleted when **no remaining run
 * references it**. Delete more than that and the surviving run renders paths
 * that resolve to nothing, which is the exact failure the unscoped path avoids
 * by clearing everything at once.
 *
 * The ledger's `images` record for those listings is cleared alongside, because
 * the image pipeline decides what to download by what the ledger and mirror say
 * is already there. Leave it, and the next run skips downloading photos that no
 * longer exist anywhere.
 *
 * Ledger entries, suburb profiles and the route cache are all kept: they are
 * things learned, not things this run owns, and they remain true.
 */
async function resetRuns(ids: string[], confirm: boolean): Promise<void> {
  console.log(`\nReset ${ids.join(', ')}${confirm ? '' : '  (dry run — nothing will be destroyed)'}`)

  let present: string[] = []
  try {
    present = (await readdir(dataPath('runs'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    fail('there are no runs to remove — data/runs/ does not exist')
  }

  const unknown = ids.filter((id) => !present.includes(id))
  if (unknown.length > 0) {
    fail(
      `no such run(s): ${unknown.join(', ')}\n` +
        `  runs present: ${present.join(', ') || '(none)'}`,
    )
  }

  const remaining = present.filter((id) => !ids.includes(id))

  // Which listings survive. Read from the runs themselves rather than the
  // index, because the index records counts and the question here is identity.
  const keptListings = new Set<string>()
  for (const id of remaining) {
    const run = await readJsonFile(dataPath('runs', id, 'run.json'), z.object({
      listings: z.array(z.object({ id: z.string() })).default([]),
    }).passthrough())
    for (const listing of run.listings) keptListings.add(listing.id)
  }

  const doomedListings = new Set<string>()
  for (const id of ids) {
    const run = await readJsonFile(dataPath('runs', id, 'run.json'), z.object({
      listings: z.array(z.object({ id: z.string() })).default([]),
    }).passthrough())
    for (const listing of run.listings) {
      if (!keptListings.has(listing.id)) doomedListings.add(listing.id)
    }
  }

  const { config: r2 } = r2ConfigFromEnv()
  if (!r2) fail('R2 is not configured — cannot tell what would be deleted from the bucket.')

  const allKeys = await listObjects(r2)
  const doomedKeys = allKeys.filter((key) => {
    const listingId = listingIdFromKey(key)
    return listingId !== null && doomedListings.has(listingId)
  })

  console.log(`  runs        removing ${ids.length}, keeping ${remaining.length}` +
    `${remaining.length ? `: ${remaining.join(', ')}` : ''}`)
  console.log(`  listings    ${doomedListings.size} referenced by no remaining run`)
  console.log(`  R2          ${doomedKeys.length} object(s) of ${allKeys.length} would go`)
  console.log(`  kept        ledger entries, suburbs.json and the route cache — still true`)

  if (!confirm) {
    console.log('\n  Nothing was destroyed. Re-run with --confirm to go ahead.\n')
    return
  }

  if (doomedKeys.length > 0) {
    console.log(`\n  deleting ${doomedKeys.length} object(s) from R2…`)
    let failed = 0
    for (const key of doomedKeys) {
      try {
        await deleteObject(r2, key)
      } catch (error) {
        failed += 1
        if (failed <= 5) console.log(`    ⚠ ${key}: ${(error as Error).message}`)
      }
    }
    if (failed > 0) {
      fail('some objects could not be deleted — re-run to retry before touching the local side')
    }
    console.log(`  deleted     ${doomedKeys.length} object(s)`)
  }

  for (const listingId of doomedListings) {
    await rm(path.join(PUBLIC_DIR, 'images', 'listings', listingId), {
      recursive: true,
      force: true,
    })
  }
  console.log(`  removed     ${doomedListings.size} listing folder(s) from the mirror`)

  for (const id of ids) {
    await rm(dataPath('runs', id), { recursive: true, force: true })
  }
  console.log(`  removed     ${ids.map((id) => `data/runs/${id}/`).join(', ')}`)

  // The ledger keeps the listing but must stop claiming photos that are gone.
  const ledger = await readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema)
  let cleared = 0
  for (const listingId of doomedListings) {
    const entry = ledger.listings[listingId]
    if (!entry) continue
    entry.images = { source_urls: [], files: [], count: 0 }
    cleared += 1
  }
  if (cleared > 0) {
    await writeJsonFile(dataPath('knowledge', 'listings.json'), {
      ...ledger,
      updated_at: isoNow(),
    })
    console.log(`  cleared     the photo record on ${cleared} ledger entr(y/ies)`)
  }

  // `IndexSchema` requires a non-empty `runs` and a `current_run` naming one, so
  // there is no valid empty index — absence is how "no runs yet" is spelled.
  if (remaining.length === 0) {
    await rm(dataPath('index.json'), { force: true })
    console.log('  removed     data/index.json (no runs left)')
  } else {
    const index = await readJsonFile(dataPath('index.json'), IndexSchema)
    const runs = index.runs.filter((run) => !ids.includes(run.id))
    await writeJsonFile(dataPath('index.json'), {
      ...index,
      // Newest last, so the last survivor is the natural current run when the
      // one being removed was it.
      current_run: ids.includes(index.current_run) ? runs[runs.length - 1].id : index.current_run,
      runs,
    })
    console.log(`  rewrote     data/index.json — current_run is ${runs[runs.length - 1].id}`)
  }

  console.log('\n  Done. Next: npm run validate:data.\n')
}

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
  assertKnownFlags(argv, RESET_FLAGS, 'reset')
  const CONFIRM = argv.includes('--confirm')
  const SCOPED = (argv.find((a) => a.startsWith('--run='))?.slice(6) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  if (SCOPED.length > 0) {
    await resetRuns(SCOPED, CONFIRM)
    return
  }

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
  // Counted from the JSON, not from the schema. A `""` key in `geo` — which one
  // address-less listing is enough to create — makes `McpCacheSchema` refuse the
  // file, and refusing used to read as an empty cache. That is how this line
  // once said "0 route(s), 0 position(s)" immediately before destroying 406 of
  // each: the warning about spending real money read zero exactly when it was
  // most true.
  const cacheRead = await readCacheFile(dataPath('cache', 'mcp-cache.json'))
  const routeCount = cacheRead.state === 'missing' ? 0 : cacheRead.routes
  const geoCount = cacheRead.state === 'missing' ? 0 : cacheRead.positions
  console.log(`  cache       ${routeCount} route(s), ${geoCount} position(s) — re-measuring these costs real money`)
  if (cacheRead.state === 'unreadable') {
    console.log(`              ⚠ the file does not match its schema (${cacheRead.reason})`)
    console.log('              counted from the JSON instead — the numbers above are real')
  }

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

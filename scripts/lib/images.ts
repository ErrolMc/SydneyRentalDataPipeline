import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { PUBLIC_DIR } from './json-io'
import { objectKeyFor, putObject, type R2Config } from './r2'

/**
 * The image pipeline (PLAN.md §4 step 8).
 *
 * Photos are published to Cloudflare R2 and mirrored locally — see `lib/r2.ts`
 * for why they no longer live in git. Files are keyed by REA listing id, so a
 * listing carried over from last week reuses last week's photos; the ledger's
 * `source_urls` is the dedupe key, and a listing whose URLs are all already
 * processed does zero network I/O in either direction.
 *
 * Output: `NN.webp` at ~1200px q75 (~150 KB) plus `NN.thumb.webp` at 320px q70
 * (~15 KB), capped at 8 photos per listing.
 */

const MAX_PHOTOS = 8
const FULL_WIDTH = 1200
const FULL_QUALITY = 75
const THUMB_WIDTH = 320
const THUMB_QUALITY = 70

const DOWNLOAD_TIMEOUT_MS = 20_000
/** Plain courtesy toward REA's image CDN — these run back to back across a whole run. */
const DOWNLOAD_DELAY_MS = 150

export interface ImageSyncResult {
  /** Main files only, in display order. Thumbs are implied by `<name>.thumb.webp`. */
  files: string[]
  /** Every source URL that has been successfully processed, in processing order. */
  sourceUrls: string[]
  downloaded: number
  failed: number
  /** True when every URL was already processed — the zero-network path. */
  skipped: boolean
}

export function listingImageDir(listingId: string): string {
  return path.join(PUBLIC_DIR, 'images', 'listings', listingId)
}

/** The site-relative path stored in JSON. Rendering it always goes through `src/lib/images.ts`. */
export function listingImagePath(listingId: string, file: string): string {
  return `/images/listings/${listingId}/${file}`
}

async function existingFiles(listingId: string): Promise<string[]> {
  try {
    const entries = await readdir(listingImageDir(listingId))
    return entries.filter((name) => /^\d{2}\.webp$/.test(name)).sort()
  } catch {
    return []
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: {
      // Some CDNs serve a 403 to the default undici UA.
      'User-Agent': 'SydneyRentalFindings/1.0 (personal rental-search agent)',
      Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*',
    },
  })

  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Encode both variants, publish them, then keep a local copy.
 *
 * Order matters. R2 is what the site actually serves, so a photo only counts
 * once it is up there — uploading before touching the disk means a failed
 * upload leaves nothing behind. If it left a local file, the next run would see
 * it via `existingFiles`, treat it as real, and put a path into run.json that
 * resolves to nothing.
 *
 * The local copy is a working mirror, gitignored: it makes `validate:data`'s
 * disk check meaningful and allows a re-upload without re-downloading from REA.
 */
async function storeVariants(
  source: Buffer,
  listingId: string,
  dir: string,
  stem: string,
  r2: R2Config | null,
): Promise<void> {
  // `.rotate()` bakes in EXIF orientation before the resize, so portrait shots
  // do not come out sideways once the metadata is dropped.
  const full = await sharp(source)
    .rotate()
    .resize({ width: FULL_WIDTH, withoutEnlargement: true })
    .webp({ quality: FULL_QUALITY })
    .toBuffer()

  const thumb = await sharp(source)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer()

  const files: [string, Buffer][] = [
    [`${stem}.webp`, full],
    [`${stem}.thumb.webp`, thumb],
  ]

  if (r2) {
    for (const [name, body] of files) {
      await putObject(r2, objectKeyFor(listingImagePath(listingId, name)), body, 'image/webp')
    }
  }

  for (const [name, body] of files) {
    await writeFile(path.join(dir, name), body)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bring one listing's photos up to date.
 *
 * `NN` numbering continues append-only from whatever is already on disk, so a
 * relisted property that gains a photo gets `04.webp` rather than renumbering
 * — paths already committed in an older run.json must keep resolving forever.
 */
export async function syncListingImages(options: {
  listingId: string
  /** Image URLs from the MCP payload, in listing order — hero first. */
  sourceUrls: readonly string[]
  /** What the ledger already knows about this listing's photos. */
  known: { source_urls: readonly string[]; files: readonly string[] }
  /** Where the site serves photos from. Null uploads nothing — local testing only. */
  r2: R2Config | null
  maxPhotos?: number
  onProgress?: (message: string) => void
}): Promise<ImageSyncResult> {
  const { listingId, sourceUrls, known } = options
  const maxPhotos = options.maxPhotos ?? MAX_PHOTOS

  const onDisk = await existingFiles(listingId)
  // Trust the disk over the ledger for filenames; trust the ledger for which
  // URLs produced them. A file the ledger forgot is still a real photo.
  const files = onDisk.length > 0 ? onDisk : [...known.files]

  const alreadyProcessed = new Set(known.source_urls)
  const pending = sourceUrls.filter((url) => !alreadyProcessed.has(url))
  const room = Math.max(0, maxPhotos - files.length)

  if (pending.length === 0 || room === 0) {
    return {
      files,
      sourceUrls: [...known.source_urls],
      downloaded: 0,
      failed: 0,
      skipped: true,
    }
  }

  const dir = listingImageDir(listingId)
  await mkdir(dir, { recursive: true })

  let nextIndex =
    files.reduce((highest, file) => Math.max(highest, Number.parseInt(file.slice(0, 2), 10)), 0) + 1

  const processedUrls = [...known.source_urls]
  let downloaded = 0
  let failed = 0

  for (const url of pending.slice(0, room)) {
    const stem = String(nextIndex).padStart(2, '0')
    try {
      if (downloaded > 0) await sleep(DOWNLOAD_DELAY_MS)
      const buffer = await download(url)
      await storeVariants(buffer, listingId, dir, stem, options.r2)
      files.push(`${stem}.webp`)
      processedUrls.push(url)
      nextIndex += 1
      downloaded += 1
    } catch (error) {
      // One bad photo must never sink a listing — carry on and let the caller
      // decide whether zero photos warrants the `images_failed` flag.
      failed += 1
      options.onProgress?.(`      photo ${stem} failed (${(error as Error).message}) — skipping`)
    }
  }

  return { files: files.sort(), sourceUrls: processedUrls, downloaded, failed, skipped: false }
}

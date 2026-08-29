// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import sharp from 'sharp'

import {
  deleteObject,
  objectExists,
  objectKeyFor,
  publicUrlFor,
  putObject,
  r2ConfigFromEnv,
} from './lib/r2'

/**
 * One-time R2 setup check: `npm run check:r2`.
 *
 * Creating a bucket is the easy part. The two things that actually go wrong
 * are a token scoped so it cannot write, and public access left disabled — and
 * neither shows up until photos 404 on the live site. So this does a full
 * round trip with a real WebP: upload with the pipeline's credentials, confirm
 * it is there, then fetch it back over the *public* URL the way a phone will,
 * and clean up after itself.
 *
 * The public read is the part worth having. Everything else can pass while the
 * site still shows broken images.
 */

const TEST_PATH = '/images/listings/_setup-check/probe.webp'

let failed = false

function step(label: string, ok = true, detail = ''): void {
  if (!ok) failed = true
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  const { config, missing } = r2ConfigFromEnv()

  if (!config) {
    console.error(`\n✖ the pipeline's .env is missing: ${missing.join(', ')}\n`)
    console.error('  See README, "Photo hosting" — one-time setup.\n')
    process.exit(1)
  }

  console.log(`\nR2 check — bucket "${config.bucket}", account ${config.accountId.slice(0, 8)}…`)
  console.log(`  public base: ${config.publicBaseUrl}\n`)

  // A real 1x1 WebP rather than a text file, so the content type and the
  // rendering path are exercised exactly as a listing photo would be.
  const probe = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .webp()
    .toBuffer()

  const key = objectKeyFor(TEST_PATH)

  try {
    await putObject(config, key, probe, 'image/webp')
    step('upload (token can write)')
  } catch (error) {
    step('upload (token can write)', false, (error as Error).message)
    console.error('\n  The token needs "Object Read & Write" on this bucket.\n')
    process.exit(1)
  }

  try {
    step('object exists (token can read)', await objectExists(config, key))
  } catch (error) {
    step('object exists (token can read)', false, (error as Error).message)
  }

  // The one that matters: no credentials, exactly what a browser sends.
  try {
    const response = await fetch(publicUrlFor(config, TEST_PATH), {
      signal: AbortSignal.timeout(15_000),
    })
    const type = response.headers.get('content-type') ?? '(none)'
    const bytes = (await response.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength

    step(
      'public read (what a phone will do)',
      response.ok && bytes === probe.length,
      `HTTP ${response.status}, ${type}, ${bytes} bytes`,
    )

    if (!response.ok) {
      console.error(
        '\n  Public access is not enabled, or R2_PUBLIC_BASE_URL is wrong.\n' +
          '  Cloudflare → R2 → your bucket → Settings → Public Development URL → Enable,\n' +
          '  or attach a custom domain. The URL must be the bucket root, no path.\n',
      )
    }
  } catch (error) {
    step('public read (what a phone will do)', false, (error as Error).message)
  }

  try {
    await deleteObject(config, key)
    step('cleanup')
  } catch (error) {
    step('cleanup', false, `${(error as Error).message} — remove ${key} by hand`)
  }

  if (failed) {
    console.error('\n✖ R2 is not ready.\n')
    process.exit(1)
  }

  console.log('\n✔ R2 is ready.')
  console.log(`  Set NEXT_PUBLIC_IMAGE_BASE_URL=${config.publicBaseUrl} in Vercel too.\n`)
}

main().catch((error) => {
  console.error(`\n✖ check-r2 crashed: ${(error as Error).message}\n`)
  process.exit(1)
})

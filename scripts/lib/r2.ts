import path from 'node:path'
import process from 'node:process'

import { AwsClient } from 'aws4fetch'

import { REPO_ROOT } from './json-io'

/**
 * Cloudflare R2 — where listing photos are served from.
 *
 * PLAN.md §2 originally committed photos to the repo, with §11 keeping an
 * escape hatch open: every image path in JSON is site-relative and every render
 * goes through `src/lib/images.ts`, so moving the files is one env var and zero
 * JSON changes. This is that hatch, taken before the first real run rather than
 * after — photos never enter git history at all, which is the one part that
 * would have been expensive to undo later.
 *
 * R2 rather than the alternatives because egress is free: the site is browsed on
 * phones, over and over, by a handful of people, and every other object store
 * bills for exactly that.
 *
 * Credentials live in `.env.pipeline` (gitignored) and never reach Vercel — the
 * site only ever needs the public base URL.
 */

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Public base for reads, e.g. `https://pub-….r2.dev`. Mirrors NEXT_PUBLIC_IMAGE_BASE_URL. */
  publicBaseUrl: string
}

let envLoaded = false

/** `.env.pipeline` holds the pipeline's secrets. Absent is fine — the caller decides. */
function loadPipelineEnv(): void {
  if (envLoaded) return
  envLoaded = true
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env.pipeline'))
  } catch {
    // No file, or unreadable. Configuration is reported by `r2ConfigFromEnv`.
  }
}

const REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
] as const

/** Returns null when R2 is not configured, plus which variables are missing. */
export function r2ConfigFromEnv(): { config: R2Config | null; missing: string[] } {
  loadPipelineEnv()

  const missing = REQUIRED.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) return { config: null, missing }

  return {
    config: {
      accountId: process.env.R2_ACCOUNT_ID!.trim(),
      accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
      bucket: process.env.R2_BUCKET!.trim(),
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL!.trim().replace(/\/+$/, ''),
    },
    missing: [],
  }
}

let client: AwsClient | null = null

function clientFor(config: R2Config): AwsClient {
  // R2 speaks S3, with `auto` as the only region.
  client ??= new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: 'auto',
    service: 's3',
  })
  return client
}

function objectUrl(config: R2Config, key: string): string {
  return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`
}

/**
 * The object key for a site-relative image path. `/images/listings/1/01.webp`
 * becomes `images/listings/1/01.webp`, so the public base URL joined to the
 * stored path resolves — which is exactly what `src/lib/images.ts` does.
 */
export function objectKeyFor(sitePath: string): string {
  return sitePath.replace(/^\/+/, '')
}

/** Upload one object. Throws on failure — a photo that did not upload must not be recorded. */
export async function putObject(
  config: R2Config,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const response = await clientFor(config).fetch(objectUrl(config, key), {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: {
      'Content-Type': contentType,
      // Immutable: a given key's bytes never change. Numbering is append-only,
      // so a new photo is a new key rather than an overwrite.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })

  if (!response.ok) {
    throw new Error(`R2 PUT ${key} → ${response.status} ${await response.text().catch(() => '')}`.trim())
  }
}

/** Does the object exist? Used by `validate-data --check-remote`. */
export async function objectExists(config: R2Config, key: string): Promise<boolean> {
  const response = await clientFor(config).fetch(objectUrl(config, key), { method: 'HEAD' })
  return response.ok
}

/**
 * Remove one object. Only used by the setup check to clean up after itself —
 * a run never deletes a photo, because paths in committed runs must keep
 * resolving forever.
 */
export async function deleteObject(config: R2Config, key: string): Promise<void> {
  const response = await clientFor(config).fetch(objectUrl(config, key), { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 DELETE ${key} → ${response.status}`)
  }
}

/**
 * Every object key in the bucket, paged to exhaustion.
 *
 * The ledger records what a run *uploaded*, which is not the same as what the
 * bucket *holds* — a run that died mid-upload, or a listing later dropped from
 * the ledger, leaves objects nothing knows about. Anything that needs to reason
 * about the bucket's real contents has to ask the bucket.
 */
export async function listObjects(config: R2Config, prefix = ''): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined

  do {
    const url = new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`)
    url.searchParams.set('list-type', '2')
    if (prefix) url.searchParams.set('prefix', prefix)
    // 1000 is the S3 maximum per page, and R2 honours it.
    url.searchParams.set('max-keys', '1000')
    if (token) url.searchParams.set('continuation-token', token)

    const response = await clientFor(config).fetch(url.toString(), { method: 'GET' })
    if (!response.ok) {
      throw new Error(`R2 LIST → ${response.status} ${await response.text().catch(() => '')}`.trim())
    }

    const xml = await response.text()
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(decodeXml(match[1]))
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
    token = truncated
      ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
      : undefined
    // A truncated page with no token would loop forever; stop rather than spin.
    if (truncated && !token) break
  } while (token)

  return keys
}

/** S3 returns XML, and a key containing `&` or `'` arrives escaped. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The URL a browser will actually request for a stored image path. */
export function publicUrlFor(config: R2Config, sitePath: string): string {
  return `${config.publicBaseUrl}/${objectKeyFor(sitePath)}`
}

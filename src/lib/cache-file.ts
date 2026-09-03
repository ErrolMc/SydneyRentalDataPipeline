import { readFile } from 'node:fs/promises'

import { McpCacheSchema, type McpCache } from 'sydney-rental-schema'

/**
 * Reading the route cache without mistaking "unreadable" for "not there".
 *
 * `McpCacheSchema` rejects an empty key in `geo`, and one address-less listing
 * is enough to make one: REA returns a listing with no address, the geocoder is
 * handed `""`, Google answers with Australia's own centroid
 * (`-25.274398, 133.775136`) and the result is cached under the key `""`.
 *
 * Every reader used `readJsonFile(...).catch(() => null)` and then treated null
 * as absence, so a poisoned cache read as no cache at all. All three were wrong
 * in the same way and none of them said anything:
 *
 *   - `reset` announced `cache 0 route(s), 0 position(s) — re-measuring these
 *     costs real money`, then destroyed 406 of each. The warning read zero
 *     exactly when it mattered most.
 *   - `validate` dropped its cache line entirely, so the tell was a line that
 *     was not printed rather than one reading zero.
 *   - `check cache` reported `no cache … nothing to check` and passed, which is
 *     the gate that exists for this file failing open on the one fault it was
 *     written to catch.
 *
 * Counting needs no schema. A file that is valid JSON can be counted whatever
 * the schema makes of its keys, so `routes` and `positions` are honest in every
 * state below — including `unreadable`, where they are the numbers that matter.
 */
export type CacheRead =
  /** No file. The default `.env` points the cache at a home directory, so this is normal. */
  | { state: 'missing' }
  | { state: 'ok'; cache: McpCache; routes: number; positions: number }
  /** Present and countable, but the schema refused it. `reason` is the schema's own words. */
  | {
      state: 'unreadable'
      reason: string
      routes: number
      positions: number
      /** The keys that are not valid keys — `""` being the one this has produced so far. */
      badKeys: string[]
    }

function countKeys(value: unknown): number {
  return value !== null && typeof value === 'object' ? Object.keys(value).length : 0
}

function blankKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  return Object.keys(value).filter((key) => key.trim() === '')
}

/** Reads the cache at `absolute`, telling absence and corruption apart. */
export async function readCacheFile(absolute: string): Promise<CacheRead> {
  let raw: string
  try {
    raw = await readFile(absolute, 'utf8')
  } catch {
    return { state: 'missing' }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    // Not countable either, but still emphatically not missing.
    return {
      state: 'unreadable',
      reason: `not valid JSON: ${(error as Error).message}`,
      routes: 0,
      positions: 0,
      badKeys: [],
    }
  }

  const parsed = McpCacheSchema.safeParse(json)
  const record = (json ?? {}) as { routes?: unknown; geo?: unknown }
  const routes = countKeys(record.routes)
  const positions = countKeys(record.geo)

  if (parsed.success) {
    return { state: 'ok', cache: parsed.data, routes, positions }
  }

  return {
    state: 'unreadable',
    reason: parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
    routes,
    positions,
    badKeys: [...blankKeys(record.routes), ...blankKeys(record.geo)],
  }
}

/**
 * The one line every caller wants: what is in there, said the same way.
 *
 * An unreadable cache still reports its counts, because those are the numbers
 * that decide whether destroying it costs money.
 */
export function describeCache(read: CacheRead): string {
  if (read.state === 'missing') return 'no cache file'
  return `${read.routes} route(s), ${read.positions} position(s)`
}

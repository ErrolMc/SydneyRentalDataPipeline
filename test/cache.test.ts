import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import process from 'node:process'

import { GOOGLE_GEO_TTL_DAYS, McpCacheSchema, cacheExpiry, type McpCache } from 'sydney-rental-schema'
import { readCacheFile } from '../src/lib/cache-file.js'
import { dataPath } from '../src/lib/json-io.js'

test('cache', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, label)])
  }

  /**
   * The route cache: that it parses, and that its licence clock is read right.
   *
   *   npm run check:cache
   *
   * This file was the one piece of committed data with no schema anywhere in
   * either repo, so the gate before a data commit never looked at it. What
   * makes it worth looking at is not correctness — an expired position is
   * re-geocoded rather than served, so nothing here can produce a wrong number.
   * It is cost. Google's licence allows a cached coordinate to live 30 days;
   * every entry past that is one the next run pays for again, and a committed
   * cache that quietly ages out is invisible from the outside.
   *
   * `cacheExpiry` takes `now` as a parameter rather than reading the clock,
   * which is the only reason any of this is testable.
   */

  const DAY = 86_400_000
  const NOW = 1_780_000_000_000

  const cacheOf = (geo: McpCache['geo']): McpCache => ({
    schema_version: 1,
    updated_at: null,
    routes: {},
    geo,
  })
  const osm = (lat: number) => ({ lat, lng: 151.2, precision: 'building' as const, src: 'osm' as const })
  const google = (lat: number, ageDays: number) => ({
    lat,
    lng: 151.2,
    precision: 'building' as const,
    src: 'google' as const,
    at: NOW - ageDays * DAY,
  })

  /* --- the licence clock ----------------------------------------------------- */

  console.log('\ncacheExpiry\n')
  {
    // OpenStreetMap data carries no expiry, which is exactly why the envelope's
    // centroids come from Nominatim and not from Google.
    const osmOnly = cacheExpiry(cacheOf({ a: osm(-33.8), b: osm(-33.9) }), NOW)
    check('OSM positions are permanent', osmOnly.permanent === 2 && osmOnly.google === 0)
    check('and none of them expire', osmOnly.expired === 0 && osmOnly.expiringSoon === 0)

    const fresh = cacheExpiry(cacheOf({ a: google(-33.8, 1) }), NOW)
    check('a day-old Google position is fine', fresh.google === 1 && fresh.expired === 0 && fresh.expiringSoon === 0)

    const old = cacheExpiry(cacheOf({ a: google(-33.8, GOOGLE_GEO_TTL_DAYS + 1) }), NOW)
    check(`past ${GOOGLE_GEO_TTL_DAYS} days it has expired`, old.expired === 1)

    // The warning has to arrive before the money does, not with it.
    const soon = cacheExpiry(cacheOf({ a: google(-33.8, GOOGLE_GEO_TTL_DAYS - 2) }), NOW)
    check('two days short of the limit reads as expiring soon', soon.expiringSoon === 1 && soon.expired === 0)

    const notYet = cacheExpiry(cacheOf({ a: google(-33.8, GOOGLE_GEO_TTL_DAYS - 20) }), NOW)
    check('and twenty days short does not', notYet.expiringSoon === 0)

    // An undated Google entry cannot be shown to be inside its licence. Counted
    // as expired, which is the same call `geoExpired` makes in distance.ts —
    // the two must agree or the report describes a cache the router is not using.
    const undated = cacheExpiry(
      cacheOf({ a: { lat: -33.8, lng: 151.2, precision: 'building', src: 'google' } }),
      NOW,
    )
    check('an undated Google position counts as expired', undated.expired === 1)

    const mixed = cacheExpiry(
      cacheOf({ a: osm(-33.8), b: google(-33.9, 1), c: google(-34, 40) }),
      NOW,
    )
    check('a mixed cache is counted by provenance', mixed.permanent === 1 && mixed.google === 2 && mixed.expired === 1)
  }

  /* --- what is actually committed -------------------------------------------- */

  const read = await readCacheFile(dataPath('cache', 'mcp-cache.json'))

  // ── telling absence from corruption ──────────────────────────────────────────
  //
  // The distinction this whole module exists for. Every reader used to collapse
  // the two, so a cache the schema refused was reported as a cache that was not
  // there — and the counts, which are the part that decides whether destroying
  // it costs money, read zero.
  {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'cache-read-'))

    const missing = await readCacheFile(join(dir, 'nope.json'))
    check('a file that is not there reads as missing', missing.state === 'missing', missing.state)

    const goodPath = join(dir, 'good.json')
    await writeFile(
      goodPath,
      JSON.stringify({ routes: { 'walk|x|a|b': { minutes: 5, km: 0.4 } }, geo: { 'a st': { lat: -33.8, lng: 151.2, precision: 'building' } } }),
    )
    const good = await readCacheFile(goodPath)
    check(
      'a valid cache reads as ok, counted',
      good.state === 'ok' && good.routes === 1 && good.positions === 1,
      good.state,
    )

    const poisonedPath = join(dir, 'poisoned.json')
    await writeFile(
      poisonedPath,
      JSON.stringify({
        routes: { 'walk|x|a|b': { minutes: 5, km: 0.4 } },
        geo: {
          'a st': { lat: -33.8, lng: 151.2, precision: 'building' },
          '': { lat: -25.274398, lng: 133.775136, precision: 'area', src: 'google' },
        },
      }),
    )
    const poisoned = await readCacheFile(poisonedPath)
    check(
      'an empty-keyed entry reads as unreadable, not missing',
      poisoned.state === 'unreadable',
      poisoned.state,
    )
    check(
      'and is still counted honestly',
      poisoned.state === 'unreadable' && poisoned.routes === 1 && poisoned.positions === 2,
      poisoned.state === 'unreadable' ? `${poisoned.routes}/${poisoned.positions}` : poisoned.state,
    )
    check(
      'and names the empty key as the cause',
      poisoned.state === 'unreadable' && poisoned.badKeys.length === 1,
      poisoned.state === 'unreadable' ? JSON.stringify(poisoned.badKeys) : poisoned.state,
    )

    const brokenPath = join(dir, 'broken.json')
    await writeFile(brokenPath, '{not json')
    const broken = await readCacheFile(brokenPath)
    check('invalid JSON is unreadable, not missing', broken.state === 'unreadable', broken.state)
  }

  console.log('\ncommitted cache\n')
  if (read.state === 'missing') {
    // Not a failure. `.env` may point the cache at a home directory, which is
    // the default and a perfectly good place for it.
    console.log('  no cache at data/cache/mcp-cache.json — .env points elsewhere')
    check('nothing to check', true)
  } else if (read.state === 'unreadable') {
    // This is the branch that used to not exist. A cache the schema refuses read
    // as `null`, took the "no cache" path above, printed ".env points elsewhere"
    // about a file sitting right there, and passed — so the one assertion that
    // would have caught it was unreachable exactly when it was true. A committed
    // cache of 407 routes went through this gate green.
    console.log(`  ${read.routes} route(s) · ${read.positions} position(s) — present but unreadable`)
    console.log(`  ${read.reason}`)
    if (read.badKeys.length > 0) {
      console.log(
        `  ${read.badKeys.length} entr(y/ies) keyed on an empty string — an address-less ` +
          'listing geocoded, which Google answers with the centroid of Australia',
      )
    }
    check('the committed cache parses against its schema', false, read.reason)
  } else {
    const { cache } = read
    const expiry = cacheExpiry(cache, Date.now())
    console.log(
      `  ${read.routes} route(s) · ${read.positions} position(s) · ${expiry.google} from Google`,
    )
    if (expiry.expired || expiry.expiringSoon) {
      console.log(`  ${expiry.expired} expired · ${expiry.expiringSoon} expiring within a week`)
    }
    if (read.routes === 0 && read.positions === 0) {
      console.log('  (empty — a fresh capture pays full price for every geocode and routed leg)')
    }
    check('the committed cache parses against its schema', true)
    check(
      'every Google position is accounted for',
      expiry.google === Object.values(cache.geo).filter((g) => g.src === 'google').length,
    )
  }

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})

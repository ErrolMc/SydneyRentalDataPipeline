// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { CriteriaSchema } from 'sydney-rental-schema'
import { dataPath, readJsonFile } from '../lib/json-io.js'
import { fail } from '../lib/stage-error.js'
import {
  ReaCaptureSchema,
  excludedByKeyword,
  reaToRawListing,
  roomSignalEvidence,
  type MappingProblem,
} from '../lib/rea.js'

/**
 * Read the share-house classifier's working out against a capture.
 *
 *   npm run check:shares -- <capture.json>
 *
 * `roomListingSignals` decides whether a listing is a room rather than a whole
 * dwelling, and `build-run.ts` turns that into the `share_house` flag. The
 * decision is made from prose, so it is a judgement call, and a judgement call
 * that nobody reads is just a silent filter. This prints both halves of it:
 *
 *   FLAGGED   what it caught, and the words it caught them on
 *   MISSED?   every listing it did NOT flag whose description still mentions
 *             sharing or rooms — which is where a false negative would hide
 *
 * The second list is the useful one. It is long by design (112 listings on the
 * 2026-08-24 capture) and almost every line should read as a normal flat with
 * a shared laundry or a lounge room. A line that does not is a missing signal.
 */

export async function main(argv: string[]): Promise<void> {
  const CAPTURE_PATH = argv[0]
  if (!CAPTURE_PATH) fail('usage: node dist/cli.js check shares <capture.json>')

  const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)
  const capture = ReaCaptureSchema.parse(JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')))

  // Mirror build-run.ts exactly: dedupe, drop keyword matches, then map.
  const returnedIds = new Set<string>()
  const problems: MappingProblem[] = []
  const listings = capture.results
    .filter((listing) => (returnedIds.has(listing.id) ? false : (returnedIds.add(listing.id), true)))
    .filter((listing) => !excludedByKeyword(listing, criteria.search.exclude_keywords))
    .map((listing) => ({ rea: listing, raw: reaToRawListing(listing, problems) }))
    .filter((pair): pair is { rea: (typeof capture.results)[number]; raw: NonNullable<typeof pair.raw> } =>
      pair.raw !== null,
    )

  /** Anything that could conceivably be a share signal — deliberately over-broad. */
  const LOOSE = /\bshar\w*|\brooms?\b|\bcommunal\b|\bcommon\b|\bboarding\b|\bkitchenette\b|\bbedsit\b/gi

  const plain = (text: string) =>
    text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').toLowerCase()

  const flagged: typeof listings = []
  const clear: typeof listings = []
  for (const item of listings) {
    ;(item.raw.share_signals.length > 0 ? flagged : clear).push(item)
  }

  const describe = (item: (typeof listings)[number]) =>
    `${item.raw.id}  ${item.raw.beds}b/${item.raw.baths}ba  ` +
    `$${String(item.raw.price_pw ?? '—').padStart(4)}  ${item.raw.address}`

  console.log(`\n${listings.length} listing(s) after keyword exclusion and mapping`)
  console.log(`  ${flagged.length} flagged share_house · ${listings.length - flagged.length} read as whole dwellings\n`)

  console.log('══ FLAGGED ' + '═'.repeat(60))
  for (const item of flagged.sort((a, b) => b.raw.share_signals.length - a.raw.share_signals.length)) {
    console.log(`\n${describe(item)}`)
    for (const { signal, quote } of roomSignalEvidence(item.rea)) {
      console.log(`   ${signal.padEnd(18)} ${quote}`)
    }
  }

  console.log('\n\n══ MISSED? — not flagged, but mentions sharing or rooms ' + '═'.repeat(16))
  let reviewed = 0
  for (const item of clear) {
    const text = plain(item.raw.description)
    const quotes = [...text.matchAll(LOOSE)]
      .map((match) => {
        const start = Math.max(0, match.index - 26)
        return `…${text.slice(start, match.index + match[0].length + 26).trim()}…`
      })
      .filter((quote, index, all) => all.indexOf(quote) === index)
      .slice(0, 3)
    if (quotes.length === 0) continue
    reviewed += 1
    console.log(`\n${describe(item)}`)
    for (const quote of quotes) console.log(`   ${quote}`)
  }

  console.log(`\n\n${flagged.length} flagged · ${reviewed} unflagged listing(s) worth an eye · ${problems.length} mapping problem(s)\n`)
}

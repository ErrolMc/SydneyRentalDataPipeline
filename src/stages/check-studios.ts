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
  flattenCapture,
  reaToRawListing,
  type MappingProblem,
  type ReaListing,
} from '../lib/rea.js'
import { studioSignalEvidence } from '../lib/studio.js'

/**
 * Read the studio classifier's working out against a capture.
 *
 *   npm run check:studios -- <capture.json>
 *
 * The sibling of `npm run check:shares`, and now the same shape, because the
 * studio classifier moved here from the site and reads the same two things the
 * share one does: the full description, which only a capture holds, and — new —
 * REA's own `Studio` property type.
 *
 * The findings repo has a `check:studios` too. It reads a committed **run** and
 * shows the signals that got stored. This shows the *quotes* they matched on,
 * which a run does not keep. Read this one when you doubt the classifier; read
 * that one when you doubt what was committed.
 *
 *   FLAGGED   what it caught, and the words it caught them on
 *   MISSED?   every listing it did NOT flag whose description still says
 *             "studio" — where a false negative would hide
 *
 * A line under MISSED? should read as a listing that is not offering a studio:
 * an ad that says it is "not a studio", a yoga studio down the road, a
 * "studio-style living area" in a two-bedder. Anything else is a missing signal.
 */

export async function main(argv: string[]): Promise<void> {
  const CAPTURE_PATH = argv[0]
  if (!CAPTURE_PATH) fail('usage: node dist/cli.js check studios <capture.json>')

  const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)
  const capture = ReaCaptureSchema.parse(JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')))

  // Mirror `build` exactly: flatten, drop keyword matches, then map.
  const problems: MappingProblem[] = []
  const listings = flattenCapture(capture)
    .listings.map((item) => item.listing)
    .filter((listing) => !excludedByKeyword(listing, criteria.search.exclude_keywords))
    .map((listing) => ({ rea: listing, raw: reaToRawListing(listing, problems) }))
    .filter((pair): pair is { rea: ReaListing; raw: NonNullable<typeof pair.raw> } => pair.raw !== null)

  const plain = (text: string) =>
    text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ')

  const flagged: typeof listings = []
  const clear: typeof listings = []
  for (const item of listings) {
    ;(item.raw.studio_signals.length > 0 ? flagged : clear).push(item)
  }
  const byType = flagged.filter((item) => item.raw.studio_signals.includes('rea_property_type'))
  const proseOnly = flagged.length - byType.length

  const describe = (item: (typeof listings)[number]) =>
    `${item.raw.id}  ${item.raw.beds}b/${item.raw.baths}ba  ` +
    `$${String(item.raw.price_pw ?? '—').padStart(4)}  ${item.raw.address}`

  console.log(`\n${listings.length} listing(s) after keyword exclusion and mapping`)
  console.log(
    `  ${flagged.length} flagged studio · ${byType.length} typed \`Studio\` by REA · ` +
      `${proseOnly} found in the prose alone\n`,
  )

  console.log('══ FLAGGED ' + '═'.repeat(60))
  for (const item of flagged) {
    console.log(`\n${describe(item)}`)
    for (const { signal, quote } of studioSignalEvidence(item.rea)) {
      console.log(`   ${signal.padEnd(18)} ${quote}`)
    }
  }

  console.log('\n\n══ MISSED? — not flagged, but the description says "studio" ' + '═'.repeat(12))
  let reviewed = 0
  for (const item of clear) {
    const text = plain(item.raw.description)
    const quotes = [...text.matchAll(/studio/gi)]
      .map((match) => {
        const start = Math.max(0, match.index - 40)
        return `…${text.slice(start, match.index + match[0].length + 40).trim()}…`
      })
      .filter((quote, index, all) => all.indexOf(quote) === index)
      .slice(0, 3)
    if (quotes.length === 0) continue
    reviewed += 1
    console.log(`\n${describe(item)}`)
    for (const quote of quotes) console.log(`   ${quote}`)
  }

  console.log(
    `\n\n${flagged.length} flagged · ${reviewed} unflagged listing(s) worth an eye · ` +
      `${problems.length} mapping problem(s)\n`,
  )
}

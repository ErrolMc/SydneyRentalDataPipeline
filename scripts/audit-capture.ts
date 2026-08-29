import { readFileSync } from 'node:fs'

import { CriteriaSchema } from '../../SydneyRealEstateFindings/src/lib/schema'
import { dataPath, readJsonFile } from './lib/json-io'
import { suburbKey } from './lib/raw'
import {
  ReaCaptureSchema,
  excludedByKeyword,
  flattenCapture,
  reaToRawListing,
  type MappingProblem,
} from './lib/rea'
import { scoreListing, unenrichedBlock } from './lib/score'

const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)
const capture = ReaCaptureSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')))

const problems: MappingProblem[] = []
// One row per listing, not per page: a capture returns the same place from
// several groups and from every neighbouring suburb REA blends in, so auditing
// `groups[].results` raw would count duplicates. `flattenCapture` also still
// reads the legacy flat `results` array, so old captures audit unchanged.
const flattened = flattenCapture(capture)
const mapped = flattened.listings
  .map((row) => row.listing)
  .filter((l) => !excludedByKeyword(l, criteria.search.exclude_keywords))
  .map((l) => reaToRawListing(l, problems))
  .filter((l) => l !== null)

const rawRows = capture.groups.reduce((n, g) => n + g.results.length, 0) + capture.results.length
console.log(
  `
${rawRows} raw row(s) → ${flattened.listings.length} distinct listing(s)` +
    `${capture.groups.length ? `  [${Object.entries(flattened.groupTotals).map(([k, n]) => `${k}=${n}`).join('  ')}]` : ''}`,
)

const tally = <T>(items: T[]) =>
  [...items.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<T, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${String(k)}=${n}`)
    .join('  ')

console.log(`\n${mapped.length} mapped, ${problems.length} problem(s)`)
console.log(`\nproperty_type   ${tally(mapped.map((l) => l.property_type))}`)
console.log(`beds            ${tally(mapped.map((l) => l.beds))}`)
console.log(`baths           ${tally(mapped.map((l) => l.baths))}`)
console.log(`car_spaces      ${tally(mapped.map((l) => l.car_spaces))}`)

const priced = mapped.filter((l) => l.price_pw !== null)
const prices = priced.map((l) => l.price_pw as number).sort((a, b) => a - b)
console.log(`\nprice parsed    ${priced.length}/${mapped.length}`)
console.log(
  `  range         $${prices[0]} – $${prices[prices.length - 1]}  median $${prices[Math.floor(prices.length / 2)]}`,
)
const unparsed = mapped.filter((l) => l.price_pw === null)
if (unparsed.length) console.log(`  unparsed      ${unparsed.map((l) => `"${l.price_display}"`).join(', ')}`)

console.log(`\nsqm present     ${mapped.filter((l) => l.area_sqm !== null).length}/${mapped.length}`)
console.log(`lat/lon present ${mapped.filter((l) => l.lat !== null).length}/${mapped.length}`)
console.log(`photos          ${tally(mapped.map((l) => Math.min(l.image_urls.length, 8)))}`)
console.log(`image size seg  ${[...new Set(mapped.flatMap((l) => l.image_urls.slice(0, 1)).map((u) => u.match(/\/(\d+x\d+)\//)?.[1]))].join(', ')}`)

console.log(`\nsuburbs         ${tally(mapped.map((l) => suburbKey(l.suburb, l.postcode)))}`)

// Spot-check the price parser against every distinct display string seen.
console.log('\nprice display → parsed (distinct)')
const seen = new Map<string, number | null>()
for (const l of mapped) if (!seen.has(l.price_display)) seen.set(l.price_display, l.price_pw)
for (const [display, parsed] of [...seen].slice(0, 12)) {
  console.log(`  ${display.padEnd(34)} → ${parsed}`)
}

// What the composite looks like on real data, with no enrichment.
const scores = mapped.map((l) =>
  scoreListing(
    {
      price_pw: l.price_pw,
      beds: l.beds,
      baths: l.baths,
      car_spaces: l.car_spaces,
      area_sqm: l.area_sqm,
      suburb_key: suburbKey(l.suburb, l.postcode),
      enrichment: unenrichedBlock(suburbKey(l.suburb, l.postcode), 'h', '2026-08-24T00:00:00Z'),
      suburb_profile: null,
    },
    criteria,
  ),
)
const confidences = [...new Set(scores.map((s) => s.confidence))].sort()
console.log(`\nconfidence      ${confidences.join(', ')}  (threshold to show scores: 0.5)`)
console.log(`dealbreakers    ${tally(scores.flatMap((s) => s.dealbreakers)) || '(none)'}`)
console.log(`  clear         ${scores.filter((s) => s.dealbreakers.length === 0).length}/${scores.length}\n`)

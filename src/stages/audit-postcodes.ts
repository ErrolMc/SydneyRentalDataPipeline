// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import process from 'node:process'

import { CriteriaSchema } from 'sydney-rental-schema'
import { dataPath, readJsonFile } from '../lib/json-io.js'
import { suggestLocations } from '../search.js'

/**
 * Which REA suburbs sit in the envelope's postcodes, and which of them the
 * envelope never asks about.
 *
 *   npm run audit:postcodes
 *
 * `criteria.search.locations` is a hand-written list, and a suburb missing from
 * it fails **silently** — an unasked suburb looks exactly like a suburb with no
 * listings. Barangaroo was missing this way. `resolve_location` enumerates a
 * postcode without a browser, so the gap is cheap to measure rather than guess.
 */

export async function main(_argv: string[]): Promise<void> {
  const criteria = await readJsonFile(dataPath('config', 'criteria.json'), CriteriaSchema)

  const configured = new Set(criteria.search.locations.map((l) => l.toLowerCase()))
  const postcodes = [
    ...new Set(criteria.search.locations.map((l) => l.match(/(\d{4})\s*$/)?.[1]).filter(Boolean)),
  ].sort() as string[]

  let missingTotal = 0
  for (const postcode of postcodes) {
    const found = await suggestLocations(postcode, 20)

    const suburbs = found.filter((f) => f.type === 'suburb' || f.type === 'precinct')
    const rows = suburbs.map((s) => {
      const canonical = `${s.name} ${s.state} ${s.postcode}`
      return { canonical, type: s.type, known: configured.has(canonical.toLowerCase()) }
    })
    const missing = rows.filter((r) => !r.known)
    missingTotal += missing.length

    console.log(
      `${postcode}  ${String(rows.length).padStart(2)} suburb(s), ` +
        `${rows.length - missing.length} in envelope` +
        (missing.length ? `  MISSING: ${missing.map((m) => `${m.canonical}${m.type === 'precinct' ? ' (precinct)' : ''}`).join(', ')}` : ''),
    )
  }

  console.log(`\n${missingTotal} suburb(s) in the envelope's own postcodes are never queried.`)
}

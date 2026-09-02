import type { ListingEntry } from 'sydney-rental-schema'

/**
 * The `provider_report` notes a run carries about its own completeness.
 *
 * ## Why this is derived and not history
 *
 * `build` runs before the enrich stages, so a fresh run genuinely has no
 * walkability when its warnings are first written. `replay` then folds the
 * enrichment in — that is the whole point of it, and its own header says so:
 * "a run replayed after `npm run enrich:walk` picks up walkability it did not
 * have when it was committed".
 *
 * What it did *not* do was revisit the note saying that walkability is missing.
 * `provider_report` sat in the carried-across list beside `run_id` and
 * `created_at`, as though it were a fact about history. It is not: it is a
 * statement about the listings in the run, and those are rebuilt on every
 * replay. So the 2026-09-03 walk run was written with a note reading
 * "commute times and walkability are unavailable for every listing … scores are
 * hidden on the site and listings are ordered by rent instead", and kept it
 * through an enrichment that gave all eleven listings routed walk times, TfNSW
 * leg breakdowns, walkability from 1,019 POIs, and confidence between 0.76 and
 * 0.98 — comfortably past the 0.5 the site needs to show scores at all. The run
 * page would have rendered that note in its amber "Data-quality notes" box
 * immediately above the scores it claimed were hidden.
 *
 * ## What changed in the text, and why
 *
 * The old note was one hardcoded string appended unconditionally, and it made
 * three claims the pipeline is not in a position to make. It said commute times
 * were unavailable, when they come from the capture and are usually present
 * even before enrichment. It counted "six of the nine scoring factors", which
 * is only right for one particular set of gaps. And it asserted "scores are
 * hidden on the site and listings are ordered by rent instead" — a decision the
 * *site* makes, from the median confidence of the run it is rendering
 * (`scoresAreMeaningful`), with a threshold the pipeline does not import and
 * must not guess at.
 *
 * So this names only what is actually missing, and stops short of predicting
 * what the site will do about it.
 */

/**
 * Leading phrase, kept stable and exported so `replay` can find the note it
 * stored last time and replace it without matching the whole sentence.
 */
export const ENRICHMENT_WARNING_PREFIX = 'No listing in this run has'

/**
 * What the note used to open with. Runs built before this fix still carry it, so
 * a replay has to recognise the old wording to be able to drop it — matching
 * only the new prefix would leave the stale sentence in place forever, which is
 * the one outcome this change exists to prevent.
 */
export const LEGACY_ENRICHMENT_WARNING_PREFIX = 'Enrichment has not run'

/**
 * Status semantics come from `EnrichmentStatus`: `ok`, `fallback` and
 * `none_found` all mean the provider answered — `none_found` is a real signal,
 * scored rather than excluded. Only `unavailable` means nobody asked or nobody
 * replied, so only that counts as missing here.
 */
function answered(status: string | null | undefined): boolean {
  return status != null && status !== 'unavailable'
}

/** Which enrichment blocks answered for no listing at all. */
export function missingEnrichment(listings: readonly ListingEntry[]): string[] {
  if (listings.length === 0) return []

  const anyListing = (pick: (listing: ListingEntry) => string | null | undefined): boolean =>
    listings.some((listing) => answered(pick(listing)))

  const missing: string[] = []

  // Walk and transit both feed the one `commute` factor, so the factor only
  // sits out when neither answered for anybody.
  if (
    !anyListing((l) => l.enrichment?.commute?.walk?.status) &&
    !anyListing((l) => l.enrichment?.commute?.transit?.status)
  ) {
    missing.push('a routed commute time')
  }

  if (
    !anyListing((l) => l.enrichment?.walkability?.cafe?.status) &&
    !anyListing((l) => l.enrichment?.walkability?.supermarket?.status) &&
    !anyListing((l) => l.enrichment?.walkability?.gym?.status)
  ) {
    missing.push('walkability')
  }

  return missing
}

/** The note itself, or `null` when the run has nothing to apologise for. */
export function enrichmentWarning(listings: readonly ListingEntry[]): string | null {
  const missing = missingEnrichment(listings)
  if (missing.length === 0) return null

  return (
    `${ENRICHMENT_WARNING_PREFIX} ${missing.join(' or ')}, so the scoring factor` +
    `${missing.length > 1 ? 's that read them' : ' that reads it'} sat out of every composite and ` +
    `confidence is lower than a fully enriched run's. Run the enrich stages and replay this run ` +
    `to fill ${missing.length > 1 ? 'them' : 'it'} in.`
  )
}

/**
 * The full note list for a run: the enrichment note as it stands *now*, ahead of
 * every note that is genuinely a fact about history — `partialSearch` chief
 * among them, since which locations were queried cannot be recomputed from the
 * listings that came back.
 */
export function providerWarnings(
  listings: readonly ListingEntry[],
  carried: readonly string[] = [],
): string[] {
  const note = enrichmentWarning(listings)
  const history = carried.filter(
    (warning) =>
      !warning.startsWith(ENRICHMENT_WARNING_PREFIX) &&
      !warning.startsWith(LEGACY_ENRICHMENT_WARNING_PREFIX),
  )
  return note ? [note, ...history] : [...history]
}

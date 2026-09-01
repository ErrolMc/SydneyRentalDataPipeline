import type { ReaListing } from './rea.js'

/**
 * Whether a listing is advertising a studio — one room, no separate bedroom.
 *
 * This lived in the site's `src/lib/studio.ts` and ran at render time against
 * `description_snippet`, the 500 characters a run keeps. It runs here now, at
 * map time, against the full description and REA's own property type, because
 * neither source is sufficient alone:
 *
 * - **REA types only some of them.** `propertyType: "Studio"` is real and
 *   high-precision — 30 of 335 unique listings in the 2026-08-24 transit
 *   capture carry it. A further 44 say studio only in the prose, typed
 *   `Apartment` (34), `Unit` (7) or `Flat` (3).
 * - **The prose misses the typed ones.** Ten of those 30 never use the word
 *   anywhere in the description. Read prose alone and they arrive unlabelled.
 *
 * So the two are a union, and `rea_property_type` is a signal like any other so
 * a reader can see which one fired.
 *
 * The signal names, the negation guard and the adjective list are carried over
 * from the site's version unchanged — that file's own note said they were the
 * part worth keeping, and they were written against all 53 "studio" mentions in
 * run `2026-08-25a`, a corpus small enough to have read in full.
 *
 * Nothing here drops a listing. The signal is the output and the site decides —
 * the same principle as `share_signals`.
 */

/**
 * Uses of the word that are not an offer of a studio, blanked before matching.
 *
 * The comparative forms matter more than the flat denial: a two-bedder
 * described as having a "studio-like living area" is not a studio, and a room
 * described as bigger than a studio is advertising that it is not one.
 */
const NOT_AN_OFFER: RegExp[] = [
  /\b(?:not|isn'?t|is\s+not|rather\s+than|no)\s+(?:just\s+|merely\s+|simply\s+|your\s+average\s+|an\s+ordinary\s+)?(?:an?\s+)?studios?\b/gi,
  /\bstudios?[-\s]?(?:like|style[d]?|sized?|esque)\b/gi,
  /\b(?:like|than|unlike|beyond|compared\s+to)\s+an?\s+studios?\b/gi,
  // A place to work, not a place to live.
  /\b(?:art|artist'?s?|yoga|pilates|dance|fitness|recording|music|photography|design|film|tattoo|hair|nail|beauty)\s+studios?\b/gi,
]

/**
 * What sits in front of "studio" when an ad is offering one: a determiner, or
 * one of the adjectives Sydney listings actually reach for.
 */
const STUDIO_LEAD = [
  'this', 'the', 'a', 'an', 'our', 'each', 'every',
  'furnished', 'unfurnished', 'spacious', 'quiet', 'modern', 'renovated', 'refurbished',
  'stylish', 'large', 'small', 'cosy', 'cozy', 'private', 'premium', 'immaculate', 'neat',
  'charming', 'bright', 'sunny', 'new', 'lockable', 'self-contained', 'open-plan',
].join('|')

/**
 * Each entry is sufficient on its own, named so a card can say which one fired
 * and `node dist/cli.js check studios` can be read before the classifier is
 * trusted.
 */
const STUDIO_SIGNALS: [string, RegExp][] = [
  // "studio apartment", "Studio Units", "studio with kitchenette/wet bar".
  [
    'studio_dwelling',
    /\bstudios?\s+(?:apartments?|units?|flats?|residences?|suites?|homes?|pads?|rooms?|accommodation)\b/i,
  ],
  // The ad opens by naming the product: "Studio For Lease", "Studio Available".
  ['studio_headline', /^\s*studios?\b/i],
  // "Studio | 1 Bathroom | Furnished" — REA's own spec line, written as prose.
  ['studio_spec', /\bstudios?\s*[|·•]/i],
  // Plural is always an offer: "fully furnished studios in the heart of…".
  ['studios_offered', /\bstudios\b/i],
  // "this studio is fully renovated", "the neatest studio you will find".
  //
  // Led by a determiner *or* by a descriptive adjective, because real ads write
  // both — the adjective list mirrors `offered_room` in `rea.ts`, which had to
  // solve exactly this problem for rooms. Up to four words may sit in the gap
  // ("this neat and functional studio"), none of them "studio" itself, so a
  // later mention cannot be dragged into an earlier match.
  [
    'studio_offered',
    new RegExp(
      String.raw`\b(?:${STUDIO_LEAD})\s+(?:(?!\bstudios?\b)[\w'’-]+[\s,-]+){0,4}studio\b`,
      'i',
    ),
  ],
  // A studio by its other name, which no structured field carries either.
  ['bedsit', /\bbed[\s-]?sit(?:ter)?s?\b/i],
]

export interface StudioSignal {
  signal: string
  /** The words that matched, so a human can disagree with the classifier. */
  quote: string
}

/** A little context either side, matching `roomSignalEvidence`'s quoting. */
const QUOTE_CONTEXT = 30

/**
 * Descriptions arrive as `<br/>` soup with the occasional entity — a signal
 * split across `studio<br/>apartment` would otherwise be invisible. Case is
 * kept, unlike the share classifier's version, because these quotes are shown
 * to a reader rather than only logged.
 */
function descriptionText(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Blank out the uses that are not an offer, keeping offsets so quotes stay true. */
function maskNonOffers(text: string): string {
  let masked = text
  for (const pattern of NOT_AN_OFFER) {
    masked = masked.replace(pattern, (match) => ' '.repeat(match.length))
  }
  return masked
}

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - QUOTE_CONTEXT)
  const end = Math.min(text.length, index + length + QUOTE_CONTEXT)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/**
 * Every reason to think this listing is a studio, each with the text that said so.
 *
 * REA's type is checked first and separately: it is a structured field rather
 * than prose, so the negation guard has nothing to do with it — an ad that says
 * "not a studio" while REA types it `Studio` is a disagreement worth surfacing,
 * not a reason to drop the type's evidence.
 */
export function studioSignalEvidence(listing: ReaListing): StudioSignal[] {
  const found: StudioSignal[] = []

  if (/\bstudio/i.test(listing.propertyType ?? '')) {
    found.push({ signal: 'rea_property_type', quote: `REA property type: ${listing.propertyType}` })
  }

  const text = descriptionText(listing.description ?? '')
  const masked = maskNonOffers(text)

  for (const [signal, pattern] of STUDIO_SIGNALS) {
    const match = pattern.exec(masked)
    // Quoted from the unmasked text: the reader wants the sentence, not the
    // blanks. Offsets are preserved by masking with spaces of equal length.
    if (match) found.push({ signal, quote: quoteAround(text, match.index, match[0].length) })
  }

  return found
}

/** Just the signal names, in a stable order. Empty means nothing calls it a studio. */
export function studioListingSignals(listing: ReaListing): string[] {
  return studioSignalEvidence(listing).map((found) => found.signal)
}

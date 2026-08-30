import { GONE_STATUSES } from 'sydney-rental-schema'
import type { LedgerEntry, ListingState, ListingStatus, RejectedEntry } from 'sydney-rental-schema'
import type { RawListing } from './raw'

/**
 * Dedupe and merge against the ledger (PLAN.md §4 step 5).
 *
 * The ledger is the agent's memory: it is what makes "new", "price drop" and
 * "relisted" meaningful, and it is why a listing that disappears from search
 * results keeps a working page and a price history. Both histories are
 * append-only — a run may add to them, never rewrite them.
 */

export interface MergeOutcome {
  state: ListingState
  priceChange: { prev_pw: number; delta_pw: number } | null
  entry: LedgerEntry
}

function lastPrice(entry: LedgerEntry): number | null {
  const history = entry.price_history
  return history.length === 0 ? null : history[history.length - 1].price_pw
}

function factsFrom(raw: RawListing): LedgerEntry['facts_last'] {
  return {
    beds: raw.beds,
    baths: raw.baths,
    car_spaces: raw.car_spaces,
    area_sqm: raw.area_sqm,
    available_date: raw.available_date,
  }
}

/**
 * Fold one search result into the ledger and decide how the site should badge
 * it this run.
 *
 * Precedence when several things changed at once: a relist outranks a price
 * change, because "this came back on the market" is the more useful headline —
 * but the price move is still recorded in `price_change` and the history, so
 * nothing is lost.
 */
export function mergeListing(options: {
  raw: RawListing
  existing: LedgerEntry | undefined
  runId: string
}): MergeOutcome {
  const { raw, existing, runId } = options

  if (!existing) {
    return {
      state: 'new',
      priceChange: null,
      entry: {
        url: raw.url,
        address: raw.address,
        suburb: raw.suburb,
        postcode: raw.postcode,
        lat: raw.lat,
        lon: raw.lon,
        first_seen_run: runId,
        last_seen_run: runId,
        status: 'active',
        status_history: [{ run: runId, status: 'active' }],
        price_history: [{ run: runId, price_pw: raw.price_pw }],
        relist_count: 0,
        facts_last: factsFrom(raw),
        images: { source_urls: [], files: [], count: 0 },
        travel: {},
        // Filled by `npm run enrich:walk`, not by a run: walkability is a fact
        // about the place rather than about this moment.
        walkability: null,
      },
    }
  }

  // Two different questions, and conflating them would be wrong. `wasAbsent` is
  // "did this run bring it back from something other than active" — that is what
  // decides whether a status-history point is owed. `wasGone` is "had it actually
  // left the market", which is what a relist means. A listing that went
  // `unmatched` — still for rent, just outside every search — was absent but
  // never gone, so its return is not a relist and must not bump `relist_count`.
  const wasAbsent = existing.status !== 'active'
  const wasGone = (GONE_STATUSES as readonly string[]).includes(existing.status)
  const previousPrice = lastPrice(existing)
  const priceMoved = previousPrice !== raw.price_pw

  const entry: LedgerEntry = {
    ...existing,
    // Facts can drift as an agent edits a listing — always take the latest.
    url: raw.url,
    address: raw.address,
    suburb: raw.suburb,
    postcode: raw.postcode,
    lat: raw.lat ?? existing.lat,
    lon: raw.lon ?? existing.lon,
    last_seen_run: runId,
    status: 'active',
    facts_last: factsFrom(raw),
    status_history: wasAbsent
      ? [...existing.status_history, { run: runId, status: 'active' as ListingStatus }]
      : existing.status_history,
    price_history: priceMoved
      ? [...existing.price_history, { run: runId, price_pw: raw.price_pw }]
      : existing.price_history,
    relist_count: wasGone ? existing.relist_count + 1 : existing.relist_count,
  }

  // A delta only means something when both ends are real numbers. A listing
  // moving to or from "contact agent" is recorded in the history but is not a
  // price change the UI can put a number on.
  const priceChange =
    priceMoved && previousPrice !== null && raw.price_pw !== null
      ? { prev_pw: previousPrice, delta_pw: raw.price_pw - previousPrice }
      : null

  const state: ListingState = wasGone ? 'relisted' : priceChange ? 'price_drop' : 'carried_over'

  return { state, priceChange, entry }
}

/**
 * Decide what happened to a ledger listing that did not come back in this run's
 * results (§4 step 5, final bullet).
 *
 * Absence is weaker evidence than it used to be. A search asks REA to withhold
 * listings outside its travel budget, so a listing drifting from 14 to 16
 * minutes' walk simply stops coming back — indistinguishable, from here, from
 * one that left the market. That is why the agent checks the URL and reports
 * what it found:
 *
 *   `leased` / `withdrawn`  the page is gone — it really left
 *   `unmatched`             the page is live — still for rent, outside every
 *                           search now. Not gone, and returning later is not a
 *                           relist (see `mergeListing`).
 *   nothing reported        nobody could check. Do not guess on one absence;
 *                           REA results are not stable enough. A listing last
 *                           seen *before* the previous run has now missed two
 *                           consecutive runs, and only then goes `stale`.
 */
export function markAbsent(options: {
  entry: LedgerEntry
  runId: string
  previousRunId: string | null
  checked: 'leased' | 'withdrawn' | 'unmatched' | undefined
  /**
   * False when the run only searched some of the configured locations. A
   * partial search has no evidence that anything is gone — every listing in an
   * unsearched suburb is "absent" simply because nobody looked. A checked
   * outcome still counts, because that came from opening the listing URL.
   */
  allowStale: boolean
}): { entry: LedgerEntry; status: ListingStatus | null } {
  const { entry, runId, previousRunId, checked, allowStale } = options

  if (entry.status !== 'active') return { entry, status: null }

  const missedTwoRuns = allowStale && previousRunId !== null && entry.last_seen_run !== previousRunId
  const status: ListingStatus | null = checked ?? (missedTwoRuns ? 'stale' : null)

  if (status === null) return { entry, status: null }

  return {
    entry: {
      ...entry,
      status,
      status_history: [...entry.status_history, { run: runId, status }],
    },
    status,
  }
}

/** One listing the MCP server rejected on travel time, as the capture records it. */
export interface CapturedRejection {
  id: string
  url?: string | null
  address: string
  coords?: { lat: number; lng: number } | null
  travel?: { minutes: number; km: number; mode: ListingTravelMode; precision: TravelPrecision } | null
}

type ListingTravelMode = 'walk' | 'drive' | 'transit'
type TravelPrecision = 'building' | 'street' | 'area'

/**
 * Fold this capture's travel-rejected listings into the ones already remembered.
 *
 * These never appear in a run. The MCP server drops them *after* geocoding and
 * routing each one, so this map is the only durable record that the work was
 * done — without it every run re-buys the same rejections, and the only other
 * copy lives in that server's private cache where nothing here can see it.
 *
 * Three rules, each of which has a way of going wrong:
 *
 * - **No URL, no entry.** There would be nothing to open to resolve it later,
 *   and a fabricated URL is worse than forgetting the listing.
 * - **`address` invalidates the routes**, exactly as on `LedgerEntry.travel`.
 *   An agent editing the address means the old times describe somewhere else.
 * - **Anything published in the run is not a rejection.** A listing can be
 *   rejected by the walk pass and kept by the transit pass in the same capture,
 *   and it is the keeping that counts.
 */
export function mergeRejected(options: {
  previous: Record<string, RejectedEntry>
  groups: { origin: string; mode: string; filtered_by_travel: CapturedRejection[] }[]
  /** Ids the run published — these are tracked properly and are never rejections. */
  publishedIds: Iterable<string>
  runId: string
  computedAt: string
}): { rejected: Record<string, RejectedEntry>; seen: number } {
  const rejected: Record<string, RejectedEntry> = { ...options.previous }
  let seen = 0

  for (const group of options.groups) {
    const key = `${group.origin}:${group.mode}`
    for (const item of group.filtered_by_travel) {
      if (!item.url) continue
      seen += 1
      const previous = rejected[item.id]
      const travel = previous?.address === item.address ? { ...previous.travel } : {}
      if (item.travel) {
        travel[key] = { ...item.travel, computed_at: options.computedAt, address: item.address }
      }
      rejected[item.id] = {
        url: item.url,
        address: item.address,
        lat: item.coords?.lat ?? null,
        lon: item.coords?.lng ?? null,
        travel,
        last_seen_run: options.runId,
      }
    }
  }

  for (const id of options.publishedIds) delete rejected[id]
  return { rejected, seen }
}

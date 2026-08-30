import { fetchPage } from '../browser.js'
import { parseListingPage } from '../parse.js'
import { buildListingUrl } from '../search.js'
import type { ListingDetail } from '../types.js'

/**
 * One listing, fetched and parsed — the `get_listing` MCP tool as a function.
 *
 * Both callers want the same thing for the same reason. The tool exists so the
 * run protocol's absence-resolution step (AGENT.md §5–9) can ask whether a
 * listing that stopped coming back is actually gone, and `run`'s absence gate
 * (PHASE2.md Step 5) asks that question a few hundred times without a human in
 * the loop for each one. Keeping it in one place is what stops the adapter and
 * the pipeline drifting into two answers to the same question — the mistake
 * ADR 0004 was written about.
 *
 * It costs a real page fetch through the warmed Chrome profile, so callers are
 * expected to say how many they are about to make.
 */
export async function getListing(idOrUrl: string): Promise<ListingDetail> {
  const { html } = await fetchPage(buildListingUrl(idOrUrl))
  return parseListingPage(html)
}

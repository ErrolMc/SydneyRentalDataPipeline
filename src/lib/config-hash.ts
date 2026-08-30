import { sha256 } from './json-io.js'
import type { SiteConfig } from 'sydney-rental-schema'

/**
 * The enrichment cache key (PLAN.md §3.4): sha256 over the three parts of
 * site.json that change what a commute or walk time *means*. Move the office
 * and every cached commute is correctly invalidated; rename the office label
 * and nothing is thrown away.
 */
export function computeConfigHash(config: SiteConfig): string {
  const material = {
    office: {
      lat: config.office.lat,
      lon: config.office.lon,
      address: config.office.address,
    },
    commute_assumption: config.commute_assumption,
    walk: config.walk,
  }

  return sha256(JSON.stringify(material))
}

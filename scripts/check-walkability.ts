import { SiteConfigSchema } from '../../SydneyRealEstateFindings/src/lib/schema'
import { dataPath, readJsonFile } from './lib/json-io'
import {
  cellsFor,
  haversineMetres,
  poiFromElement,
  walkMinutes,
  type OverpassElement,
  type Poi,
} from './lib/overpass'
import { cacheIsFresh, walkabilityFor } from './lib/walkability'

/**
 * The half of walkability that has no network in it: parsing what Overpass
 * says, measuring to it, and picking which one answers. Wrong geometry or a
 * wrong pick would be invisible in the output — every listing would still get a
 * plausible-looking cafe — so it is checked here rather than eyeballed.
 */

const site = await readJsonFile(dataPath('config', 'site.json'), SiteConfigSchema)
const walk = site.walk

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} ${label}  →  ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
  )
}

console.log('\nhaversine')
// Sydney Town Hall to Central station, ~1.4 km down George Street.
const townHall = { lat: -33.8731, lon: 151.2069 }
const central = { lat: -33.8832, lon: 151.2069 }
check('1123 m due south is 1123 m', Math.round(haversineMetres(townHall, central)), 1123)
check('a point to itself is 0', haversineMetres(townHall, townHall), 0)
check('symmetric', haversineMetres(townHall, central), haversineMetres(central, townHall))

console.log(`\nwalkMinutes — ×${walk.detour_factor} detour ÷ ${walk.speed_m_per_min} m/min`)
check('290 m → 4.9 min', walkMinutes(290, walk), 4.9)
check('1200 m (the radius) → 20.3 min', walkMinutes(1200, walk), 20.3)
check('0 m → 0', walkMinutes(0, walk), 0)

console.log('\npoiFromElement — what OSM says vs what we can use')
const el = (tags: Record<string, string>, extra: Partial<OverpassElement> = {}): OverpassElement => ({
  type: 'node',
  id: 1,
  lat: -33.87,
  lon: 151.2,
  tags,
  ...extra,
})
check('amenity=cafe', poiFromElement(el({ amenity: 'cafe', name: 'Two Chaps' }))?.kind, 'cafe')
check('shop=supermarket', poiFromElement(el({ shop: 'supermarket', name: 'Coles' }))?.kind, 'supermarket')
check('leisure=fitness_centre', poiFromElement(el({ leisure: 'fitness_centre', name: 'PCYC' }))?.kind, 'gym')
// The tag people actually use, which the documented one misses.
check('amenity=gym counts too', poiFromElement(el({ amenity: 'gym', name: 'Iron Den' }))?.kind, 'gym')
check('a franchise tagged as neither', poiFromElement(el({ name: 'Anytime Fitness Newtown' }))?.kind, 'gym')
check('an unnamed cafe is a mapping stub, not a cafe', poiFromElement(el({ amenity: 'cafe' })), null)
check('an unnamed gym still counts', poiFromElement(el({ leisure: 'fitness_centre' }))?.kind, 'gym')
check('a pub is nothing to us', poiFromElement(el({ amenity: 'pub', name: 'The Vic' })), null)
check(
  'a way carries its centre',
  poiFromElement({ type: 'way', id: 9, center: { lat: -33.87, lon: 151.2 }, tags: { shop: 'supermarket', name: 'IGA' } })?.osmId,
  'way/9',
)
check(
  'a way without a centre cannot be measured to',
  poiFromElement({ type: 'way', id: 9, tags: { shop: 'supermarket', name: 'IGA' } }),
  null,
)
check('major chain detected', poiFromElement(el({ shop: 'supermarket', name: 'Woolworths Metro' }))?.isMajorChain, true)
check('corner store is not', poiFromElement(el({ shop: 'supermarket', name: 'Kent St Convenience' }))?.isMajorChain, false)

console.log('\nwalkabilityFor — which one answers')
// A grid a fixed distance north of the listing: 0.001° of latitude is ~111 m.
const home = { lat: -33.8700, lon: 151.2000 }
const at = (metresNorth: number, kind: Poi['kind'], name: string): Poi => ({
  kind,
  osmId: `node/${name}`,
  name,
  lat: home.lat + metresNorth / 111_000,
  lon: home.lon,
  isMajorChain: kind === 'supermarket' && /Woolworths|Coles|ALDI|IGA/i.test(name),
})

const nearby = walkabilityFor(home, [at(200, 'cafe', 'Close'), at(600, 'cafe', 'Far')], walk)
check('nearest cafe wins', nearby.cafe.name, 'Close')
check('  distance in whole metres', nearby.cafe.distance_m, 200)
check('  minutes derived from it', nearby.cafe.walk_minutes, walkMinutes(200, walk))
check('  status ok, source names the method', [nearby.cafe.status, nearby.cafe.source], ['ok', 'overpass+detour'])

check('nothing in range is none_found, not unavailable', walkabilityFor(home, [], walk).cafe.status, 'none_found')
check('  and none_found carries no distance', walkabilityFor(home, [], walk).cafe.distance_m, null)
check(
  'just outside the radius is also none_found',
  walkabilityFor(home, [at(walk.poi_radius_m + 50, 'cafe', 'Too far')], walk).cafe.status,
  'none_found',
)

// The weekly shop is the question, so a chain four hundred metres away beats a
// convenience store at fifty.
const shops = walkabilityFor(home, [at(50, 'supermarket', 'Nite Owl'), at(400, 'supermarket', 'ALDI')], walk)
check('a major chain beats a nearer corner store', shops.supermarket.name, 'ALDI')
check('  and says so', shops.supermarket.is_major_chain, true)

const noChain = walkabilityFor(home, [at(50, 'supermarket', 'Nite Owl')], walk)
check('with no chain in range, the nearest answers', noChain.supermarket.name, 'Nite Owl')
check('  flagged honestly', noChain.supermarket.is_major_chain, false)
check('and with no shop at all, is_major_chain is unknown, not false', walkabilityFor(home, [], walk).supermarket.is_major_chain, null)

console.log('\ncellsFor — asking about places, not listings')
const spread = [home, { lat: home.lat + 0.0005, lon: home.lon }, { lat: home.lat + 0.5, lon: home.lon }]
const cells = cellsFor(spread, walk.poi_radius_m)
check('two neighbours share a cell, a distant point gets its own', cells.length, 2)
check('busiest cell first', cells[0].listings, 2)
check('every listing is inside its own cell', cells.every((c) => c.north > c.south && c.east > c.west), true)
const covering = cells.find((c) => home.lat >= c.south && home.lat <= c.north)!
check('the cell reaches at least a radius past the listing', (covering.north - home.lat) * 111_000 >= walk.poi_radius_m, true)
check('no cells for no listings', cellsFor([], walk.poi_radius_m).length, 0)

console.log('\ncacheIsFresh — when to ask again')
const cached = {
  computed_at: '2026-08-25T00:00:00Z',
  config_hash: 'abc',
  lat: home.lat,
  lon: home.lon,
  ...walkabilityFor(home, [at(200, 'cafe', 'Close')], walk),
}
check('same config, same place', cacheIsFresh(cached, 'abc', home), true)
check('a changed walk config invalidates everything', cacheIsFresh(cached, 'def', home), false)
// A re-geocode that nudges the pin does not change which cafe is nearest.
check('a 30 m nudge does not', cacheIsFresh(cached, 'abc', { ...home, lat: home.lat + 0.00027 }), true)
check('a 200 m move does', cacheIsFresh(cached, 'abc', { ...home, lat: home.lat + 0.0018 }), false)
check('never asked is never fresh', cacheIsFresh(null, 'abc', home), false)

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)

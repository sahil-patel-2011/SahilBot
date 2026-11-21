import { describe, expect, test } from 'vitest'
import { categoryOf, directionsLink, duration, formatGoogleRoute, formatMatrix, formatOsrmRoute, formatPlaces, fromGoogle, fromNominatim, fromOverpass, haversine, km, mapsTool, overpassQuery, parseLatLng, placeLink, readGoogleMatrix } from '../../src/main/agent/tools/maps'
import { intentTools } from '../../src/main/agent/intent'

const signal = new AbortController().signal
const run = (t: ReturnType<typeof mapsTool>, a: Record<string, unknown>) => t.run(a as never, { signal } as never) as Promise<{ text: string; sources?: Array<{ url: string }> }>

/** A fetch that answers from a table of (url substring → JSON), and records what was asked. */
function fakeFetch(table: Array<[string, unknown]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const hit = table.find(([k]) => url.includes(k))
    if (!hit) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('links and units', () => {
  test('Google Maps links need no key and carry the place id and travel mode', () => {
    expect(placeLink('Tartine Bakery, SF', 'ChIJ123')).toBe('https://www.google.com/maps/search/?api=1&query=Tartine%20Bakery%2C%20SF&query_place_id=ChIJ123')
    expect(directionsLink('SFO', 'Union Square, SF', 'transit', ['Mission District'])).toBe('https://www.google.com/maps/dir/?api=1&origin=SFO&destination=Union%20Square%2C%20SF&travelmode=transit&waypoints=Mission%20District')
  })
  test('distances and durations read naturally in both systems', () => {
    expect(km(850)).toBe('850 m (2789 ft)')
    expect(km(12_345)).toBe('12 km (7.7 mi)')
    expect(duration(95)).toBe('2 min')
    expect(duration(5400)).toBe('1 h 30 min')
    expect(parseLatLng('37.7749, -122.4194')).toEqual({ lat: 37.7749, lng: -122.4194 })
    expect(parseLatLng('Paris')).toBeUndefined()
    expect(Math.round(haversine({ lat: 48.8584, lng: 2.2945 }, { lat: 48.8606, lng: 2.3376 }) / 100)).toBe(32)
  })
  test('categories accept plain words', () => {
    expect(categoryOf('coffee')).toBe('cafes')
    expect(categoryOf('Things to do')).toBe('attractions')
    expect(categoryOf('EV charging')).toBe('ev_charging')
    expect(categoryOf('museum')).toBe('museums')
    expect(categoryOf('volcanoes')).toBeUndefined()
  })
})

describe('provider shapes', () => {
  test('Places API (New): rating, price, open now and an exact Google Maps link', () => {
    const p = fromGoogle({ id: 'ChIJabc', displayName: { text: 'Tartine Bakery' }, formattedAddress: '600 Guerrero St, San Francisco, CA', rating: 4.6, userRatingCount: 9873, priceLevel: 'PRICE_LEVEL_MODERATE', currentOpeningHours: { openNow: true }, location: { latitude: 37.7614, longitude: -122.4241 }, primaryTypeDisplayName: { text: 'Bakery' } })
    const t = formatPlaces([p], 'Results')
    expect(t).toContain('1. Tartine Bakery — Bakery · ★ 4.6 (9,873) · $$ · open now')
    expect(t).toContain('query_place_id=ChIJabc')
  })
  test('Nominatim and Overpass (keyless): names, addresses, nearest first', () => {
    const n = fromNominatim({ display_name: 'Musée du Louvre, Rue de Rivoli, Paris, France', name: 'Musée du Louvre', lat: '48.8611', lon: '2.3358', category: 'tourism', type: 'museum' })
    expect(n.kind).toBe('tourism · museum')
    expect(n.link).toContain('48.8611%2C2.3358')
    const at = { lat: 48.8566, lng: 2.3522 }
    const places = fromOverpass({ elements: [
      { type: 'node', id: 1, lat: 48.8700, lon: 2.3400, tags: { name: 'Far Café', amenity: 'cafe' } },
      { type: 'way', id: 2, center: { lat: 48.8570, lon: 2.3525 }, tags: { name: 'Near Café', amenity: 'cafe', 'addr:housenumber': '5', 'addr:street': 'Rue X', opening_hours: 'Mo-Su 08:00-18:00' } },
      { type: 'node', id: 3, lat: 48.85, lon: 2.35, tags: { amenity: 'cafe' } }
    ] }, at)
    expect(places.map((p) => p.name)).toEqual(['Near Café', 'Far Café'])
    expect(formatPlaces(places, 'Cafés')).toContain('Hours: Mo-Su 08:00-18:00')
    expect(overpassQuery('cafes', at, 800, 5)).toBe('[out:json][timeout:25];(nwr["amenity"="cafe"]["name"](around:800,48.8566,2.3522););out center tags 20;')
  })
  test('Routes API: totals, legs, transit steps and the route link', () => {
    const t = formatGoogleRoute({ routes: [{ distanceMeters: 21_500, duration: '2460s', description: 'US-101 S', legs: [{ distanceMeters: 21_500, duration: '2460s', steps: [
      { navigationInstruction: { instructions: 'Head south on Market St' }, distanceMeters: 400 },
      { transitDetails: { transitLine: { nameShort: 'BART', vehicle: { name: { text: 'Train' } } }, stopDetails: { departureStop: { name: 'Powell St' }, arrivalStop: { name: 'SFO' } }, stopCount: 9 } }
    ] }] }] }, { origin: 'Union Square', destination: 'SFO', mode: 'transit' })
    expect(t).toContain('Transit from Union Square to SFO: 22 km (13 mi), 41 min')
    expect(t).toContain('2. Train BART from Powell St to SFO (9 stops)')
    expect(t).toContain('travelmode=transit')
  })
  test('OSRM: totals without traffic, turn-by-turn in words', () => {
    const t = formatOsrmRoute({ code: 'Ok', routes: [{ distance: 5200, duration: 780, legs: [{ summary: 'Valencia Street', steps: [
      { name: 'Valencia Street', distance: 3000, maneuver: { type: 'depart' } },
      { name: 'Market Street', distance: 2200, maneuver: { type: 'turn', modifier: 'right' } },
      { name: '', distance: 0, maneuver: { type: 'arrive' } }
    ] }] }] }, { origin: 'Mission', destination: 'Ferry Building', mode: 'bicycling' })
    expect(t).toContain('Bicycling from Mission to Ferry Building: 5.2 km (3.2 mi), about 13 min (OpenStreetMap routing, no live traffic) via Valencia Street')
    expect(t).toContain('2. Turn right on Market Street (2.2 km (1.4 mi))')
    expect(t).toContain('3. Arrive')
  })
  test('a travel-time grid from the Routes API matrix', () => {
    const cell = readGoogleMatrix([{ originIndex: 0, destinationIndex: 0, duration: '600s', distanceMeters: 4000 }, { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND' }])
    const t = formatMatrix(['Hotel A'], ['Museum', 'Island'], cell, 'walking')
    expect(t).toContain('to Museum: 10 min, 4.0 km (2.5 mi)')
    expect(t).toContain('to Island: no route')
  })
})

describe('the tool picks the provider and always links Google Maps', () => {
  test('with a Google key: Places API (New) with the key in a header, never in the URL', async () => {
    const { f, calls } = fakeFetch([['places:searchText', { places: [{ id: 'ChIJx', displayName: { text: 'Blue Bottle' }, formattedAddress: '66 Mint St', rating: 4.4 }] }]])
    const t = mapsTool({ googleKey: () => 'AIza-test', fetch: f })
    const r = await run(t, { action: 'search', query: 'coffee' })
    expect(r.text).toContain('Google Maps results for "coffee"')
    expect(r.text).toContain('Blue Bottle')
    expect((calls[0].init?.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('AIza-test')
    expect(calls[0].url).not.toContain('AIza')
  })
  test('without a key: OpenStreetMap, and transit says it needs the key (with a Google Maps link)', async () => {
    const { f, calls } = fakeFetch([['nominatim.openstreetmap.org/search', [{ display_name: 'Ferry Building, San Francisco', name: 'Ferry Building', lat: '37.7955', lon: '-122.3937' }]]])
    const t = mapsTool({ fetch: f })
    const r = await run(t, { action: 'search', query: 'Ferry Building San Francisco' })
    expect(r.text).toContain('OpenStreetMap results')
    expect((calls[0].init?.headers as Record<string, string>)['user-agent']).toContain('SahilBot')
    const tr = await run(t, { action: 'directions', origin: 'SFO', destination: 'Ferry Building', mode: 'transit' })
    expect(tr.text).toContain('Transit directions need a Google Maps API key')
    expect(tr.text).toContain('travelmode=transit')
  })
  test('nearby without a key asks Overpass around the geocoded point', async () => {
    const { f, calls } = fakeFetch([
      ['nominatim.openstreetmap.org/search', [{ display_name: 'Shibuya, Tokyo', lat: '35.6595', lon: '139.7005' }]],
      ['overpass-api.de', { elements: [{ type: 'node', lat: 35.66, lon: 139.701, tags: { name: 'Ramen Ya', amenity: 'restaurant', cuisine: 'ramen' } }] }]
    ])
    const r = await run(mapsTool({ fetch: f }), { action: 'nearby', category: 'restaurants', near: 'Shibuya, Tokyo', radius: 800 })
    expect(r.text).toContain('Ramen Ya — restaurant · ramen')
    expect(decodeURIComponent(String(calls[1].init?.body))).toContain('around:800,35.6595,139.7005')
  })
})

test('travel requests load the maps tool', () => {
  for (const t of ['Plan a 3-day itinerary in Rome', 'How far is the airport from my hotel?', 'Find good ramen near Shibuya', 'directions to the Ferry Building', 'things to do in Lisbon this weekend'])
    expect(intentTools(t, new Set(['maps', 'research'])), t).toContain('maps')
  expect(intentTools('Fix the failing unit test in auth.ts', new Set(['maps']))).not.toContain('maps')
})

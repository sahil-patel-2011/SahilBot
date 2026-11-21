import { describe, expect, test } from 'vitest'
import { mapsTool } from '../../src/main/agent/tools/maps'

// The maps tool's keyless providers against the real services (OpenStreetMap Nominatim, Overpass, OSRM). No key:
// npx vitest run --config vitest.live.config.mts tests/live/maps.test.ts
// (With GOOGLE_MAPS_KEY set, the same calls go to Google Maps Platform instead.)
const tool = mapsTool({ googleKey: () => process.env.GOOGLE_MAPS_KEY })
const run = (a: Record<string, unknown>) => tool.run(a as never, { signal: new AbortController().signal } as never) as Promise<{ text: string }>

describe('maps against the real services', () => {
  test('geocode and reverse', async () => {
    const g = await run({ action: 'geocode', query: 'Ferry Building, San Francisco' })
    expect(g.text).toMatch(/Coordinates: 37\.79\d+, -122\.39\d+/)
    const r = await run({ action: 'reverse', lat: 48.8584, lng: 2.2945 })
    expect(r.text).toMatch(/Paris/)
  })
  test('search near a place', async () => {
    const r = await run({ action: 'search', query: 'museum', near: 'Amsterdam', max: 5 })
    expect(r.text).toContain('Map: https://www.google.com/maps/search/?api=1')
  })
  test('nearby cafés', async () => {
    const r = await run({ action: 'nearby', category: 'cafes', near: '48.8566,2.3522', radius: 600, max: 5 })
    expect(r.text).toMatch(/1\. .+/)
  })
  test('driving directions and a walking time grid', async () => {
    const d = await run({ action: 'directions', origin: '37.7955,-122.3937', destination: '37.8080,-122.4177', mode: 'driving' })
    expect(d.text).toMatch(/Driving from .+: [\d.]+ km/)
    const m = await run({ action: 'distance_matrix', origins: ['48.8584,2.2945'], destinations: ['48.8606,2.3376', '48.8530,2.3499'], mode: 'walking' })
    expect(m.text).toMatch(/to 48\.8606,2\.3376: \d+ (min|h)/)
  })
})

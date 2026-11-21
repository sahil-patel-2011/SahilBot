import type { ToolDef } from '../types'

// Maps and travel: places, directions, travel times and what's nearby, for trip planning and place-based ideas.
//
// With the user's Google Maps API key (Settings → Keys for tools, kept in the Keychain) it uses Google Maps
// Platform: Places API (New), Routes API and the Geocoding API. Without one it uses open data: OpenStreetMap's
// Nominatim (search and addresses, at most one request a second), the Overpass API (what's nearby) and OSRM
// (driving, walking and cycling routes). Transit directions need the Google key.
//
// Every result carries Google Maps links (no key needed) so the user can open the place or route in one click.
// Only the query itself is sent: never the user's name, contacts or anything from memory.

export type MapsAction = 'search' | 'place' | 'directions' | 'distance_matrix' | 'nearby' | 'geocode' | 'reverse'
export type TravelMode = 'driving' | 'walking' | 'bicycling' | 'transit'
type Args = {
  action: MapsAction
  query?: string
  near?: string
  place?: string
  origin?: string
  destination?: string
  waypoints?: string[]
  mode?: TravelMode
  depart?: string
  origins?: string[]
  destinations?: string[]
  category?: string
  radius?: number
  lat?: number
  lng?: number
  max?: number
}

export interface MapsDeps { googleKey?: () => string | undefined; fetch?: typeof fetch }

export const ACTIONS: MapsAction[] = ['search', 'place', 'directions', 'distance_matrix', 'nearby', 'geocode', 'reverse']
const UA = 'SahilBot/1.0 (desktop assistant)'
const PLACES = 'https://places.googleapis.com/v1'
const ROUTES = 'https://routes.googleapis.com'
const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json'
const NOMINATIM = 'https://nominatim.openstreetmap.org'
/** Overpass: the main instance, then a public mirror when it's busy or down. */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
/** OSRM: the project's demo server routes cars; openstreetmap.de's runs separate foot and bike profiles. */
const OSRM: Record<Exclude<TravelMode, 'transit'>, string> = {
  driving: 'https://router.project-osrm.org/route/v1/driving',
  walking: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  bicycling: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving'
}
const OSRM_TABLE: Record<Exclude<TravelMode, 'transit'>, string> = {
  driving: 'https://router.project-osrm.org/table/v1/driving',
  walking: 'https://routing.openstreetmap.de/routed-foot/table/v1/driving',
  bicycling: 'https://routing.openstreetmap.de/routed-bike/table/v1/driving'
}

// ---------------------------------------------------------------- links (exported for tests)

const enc = encodeURIComponent

/** A Google Maps search link for a place (its place id makes it exact). */
export function placeLink(query: string, placeId?: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(query)}${placeId ? `&query_place_id=${enc(placeId)}` : ''}`
}

/** A Google Maps directions link (opens the route in Google Maps with the mode set). */
export function directionsLink(origin: string, destination: string, mode: TravelMode = 'driving', waypoints: string[] = []): string {
  const w = waypoints.filter(Boolean)
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(destination)}&travelmode=${mode}${w.length ? `&waypoints=${enc(w.join('|'))}` : ''}`
}

// ---------------------------------------------------------------- small helpers

export function km(meters: number): string {
  if (!Number.isFinite(meters)) return '?'
  const mi = meters / 1609.344
  return meters < 1000 ? `${Math.round(meters)} m (${(mi * 5280).toFixed(0)} ft)` : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km (${mi.toFixed(mi < 10 ? 1 : 0)} mi)`
}
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${Math.max(1, m)} min`
  const h = Math.floor(m / 60)
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}
/** "1234s" (Google's duration) → seconds. */
const secs = (d: unknown): number => (typeof d === 'string' ? Number(d.replace(/s$/, '')) : typeof d === 'number' ? d : NaN)
const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
/** "37.78,-122.41" → a point. */
export function parseLatLng(s: string | undefined): { lat: number; lng: number } | undefined {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s ?? '')
  if (!m) return undefined
  const lat = Number(m[1]), lng = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined
}
/** Distance between two points in meters (haversine). */
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (x: number): number => (x * Math.PI) / 180
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}
const PRICE: Record<string, string> = { PRICE_LEVEL_FREE: 'free', PRICE_LEVEL_INEXPENSIVE: '$', PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$' }

// ---------------------------------------------------------------- categories for "nearby"

/** A category in plain words → Google's place type and OpenStreetMap's tag. */
export const CATEGORIES: Record<string, { google: string; osm: Array<[string, string]>; label: string }> = {
  restaurants: { google: 'restaurant', osm: [['amenity', 'restaurant']], label: 'restaurants' },
  cafes: { google: 'cafe', osm: [['amenity', 'cafe']], label: 'cafés' },
  bars: { google: 'bar', osm: [['amenity', 'bar'], ['amenity', 'pub']], label: 'bars' },
  attractions: { google: 'tourist_attraction', osm: [['tourism', 'attraction'], ['tourism', 'viewpoint']], label: 'attractions' },
  museums: { google: 'museum', osm: [['tourism', 'museum'], ['tourism', 'gallery']], label: 'museums' },
  parks: { google: 'park', osm: [['leisure', 'park']], label: 'parks' },
  hotels: { google: 'lodging', osm: [['tourism', 'hotel'], ['tourism', 'guest_house']], label: 'hotels' },
  pharmacies: { google: 'pharmacy', osm: [['amenity', 'pharmacy']], label: 'pharmacies' },
  hospitals: { google: 'hospital', osm: [['amenity', 'hospital']], label: 'hospitals' },
  ev_charging: { google: 'electric_vehicle_charging_station', osm: [['amenity', 'charging_station']], label: 'EV charging' },
  gas: { google: 'gas_station', osm: [['amenity', 'fuel']], label: 'gas stations' },
  groceries: { google: 'grocery_store', osm: [['shop', 'supermarket']], label: 'groceries' },
  atms: { google: 'atm', osm: [['amenity', 'atm']], label: 'ATMs' },
  gyms: { google: 'gym', osm: [['leisure', 'fitness_centre']], label: 'gyms' },
  parking: { google: 'parking', osm: [['amenity', 'parking']], label: 'parking' },
  coworking: { google: 'coworking_space', osm: [['amenity', 'coworking_space'], ['office', 'coworking']], label: 'coworking spaces' }
}
const ALIASES: Record<string, string> = {
  restaurant: 'restaurants', food: 'restaurants', dinner: 'restaurants', lunch: 'restaurants', cafe: 'cafes', café: 'cafes', coffee: 'cafes',
  bar: 'bars', pub: 'bars', drinks: 'bars', attraction: 'attractions', sights: 'attractions', 'things to do': 'attractions', museum: 'museums',
  park: 'parks', hotel: 'hotels', lodging: 'hotels', pharmacy: 'pharmacies', hospital: 'hospitals', er: 'hospitals', ev: 'ev_charging',
  charging: 'ev_charging', 'ev charging': 'ev_charging', gas: 'gas', fuel: 'gas', grocery: 'groceries', supermarket: 'groceries', atm: 'atms',
  gym: 'gyms', parking: 'parking', coworking: 'coworking'
}
export function categoryOf(c: string | undefined): string | undefined {
  const k = (c ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!k) return undefined
  if (CATEGORIES[k]) return k
  return ALIASES[k] ?? ALIASES[k.replace(/s$/, '')] ?? (CATEGORIES[k.replace(/ /g, '_')] ? k.replace(/ /g, '_') : undefined)
}

// ---------------------------------------------------------------- parsers (exported for tests)

export interface Place { name: string; address?: string; rating?: number; reviews?: number; price?: string; openNow?: boolean; kind?: string; lat?: number; lng?: number; id?: string; website?: string; phone?: string; hours?: string[]; summary?: string; distance?: number; link: string }

type GPlace = { id?: string; displayName?: { text?: string }; formattedAddress?: string; rating?: number; userRatingCount?: number; priceLevel?: string; currentOpeningHours?: { openNow?: boolean }; regularOpeningHours?: { weekdayDescriptions?: string[] }; location?: { latitude?: number; longitude?: number }; primaryTypeDisplayName?: { text?: string }; websiteUri?: string; nationalPhoneNumber?: string; googleMapsUri?: string; editorialSummary?: { text?: string } }

/** A place from Places API (New). */
export function fromGoogle(p: GPlace): Place {
  const name = p.displayName?.text ?? 'Unnamed place'
  return {
    name, address: p.formattedAddress, rating: p.rating, reviews: p.userRatingCount, price: p.priceLevel ? PRICE[p.priceLevel] : undefined,
    openNow: p.currentOpeningHours?.openNow, kind: p.primaryTypeDisplayName?.text, lat: p.location?.latitude, lng: p.location?.longitude,
    id: p.id, website: p.websiteUri, phone: p.nationalPhoneNumber, hours: p.regularOpeningHours?.weekdayDescriptions, summary: p.editorialSummary?.text,
    link: p.id ? placeLink(`${name}${p.formattedAddress ? ` ${p.formattedAddress}` : ''}`, p.id) : placeLink(`${name} ${p.formattedAddress ?? ''}`.trim())
  }
}

type NomItem = { display_name?: string; name?: string; lat?: string; lon?: string; type?: string; category?: string; class?: string; osm_type?: string; osm_id?: number }
/** A place from Nominatim (search, reverse). */
export function fromNominatim(n: NomItem): Place {
  const lat = Number(n.lat), lng = Number(n.lon)
  const name = n.name || (n.display_name ?? '').split(',')[0] || 'Unnamed place'
  return { name, address: n.display_name, kind: [n.category ?? n.class, n.type].filter(Boolean).join(' · ') || undefined, lat, lng, link: placeLink(Number.isFinite(lat) ? `${lat},${lng}` : name) }
}

type OverpassEl = { type?: string; id?: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> }
/** Places from an Overpass response, nearest first. */
export function fromOverpass(r: { elements?: OverpassEl[] }, at: { lat: number; lng: number }, max = 10): Place[] {
  return (r.elements ?? []).flatMap((e) => {
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon
    const t = e.tags ?? {}
    if (lat === undefined || lng === undefined || !t.name) return []
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ')
    const address = [street, t['addr:city']].filter(Boolean).join(', ') || undefined
    const kind = t.cuisine ? `${t.amenity ?? t.tourism ?? t.leisure ?? t.shop ?? ''} · ${t.cuisine.replace(/;/g, ', ')}` : (t.amenity ?? t.tourism ?? t.leisure ?? t.shop)
    return [{ name: t.name, address, kind, lat, lng, website: t.website ?? t['contact:website'], phone: t.phone ?? t['contact:phone'], hours: t.opening_hours ? [t.opening_hours] : undefined, distance: haversine(at, { lat, lng }), link: placeLink(`${t.name}${address ? ` ${address}` : ''}`) }]
  }).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)).slice(0, max)
}

/** One line per place, with what helps decide (rating, price, open now, distance) and its Google Maps link. */
export function formatPlaces(places: Place[], heading: string): string {
  if (!places.length) return `${heading}: nothing found. Try a broader query or a bigger radius.`
  return `${heading}:\n${places.map((p, i) => {
    const facts = [
      p.kind, p.rating !== undefined ? `★ ${p.rating.toFixed(1)}${p.reviews ? ` (${p.reviews.toLocaleString('en-US')})` : ''}` : '', p.price,
      p.openNow === true ? 'open now' : p.openNow === false ? 'closed now' : '', p.distance !== undefined ? `${km(p.distance)} away` : ''
    ].filter(Boolean).join(' · ')
    return `${i + 1}. ${p.name}${facts ? ` — ${facts}` : ''}${p.address ? `\n   ${clip(p.address, 160)}` : ''}${p.hours?.length ? `\n   Hours: ${clip(p.hours.join('; '), 300)}` : ''}${p.website ? `\n   ${p.website}` : ''}\n   Map: ${p.link}`
  }).join('\n')}`
}

type GRoute = { distanceMeters?: number; duration?: string; description?: string; legs?: Array<{ distanceMeters?: number; duration?: string; steps?: Array<{ navigationInstruction?: { instructions?: string }; distanceMeters?: number; transitDetails?: { transitLine?: { nameShort?: string; name?: string; vehicle?: { name?: { text?: string } } }; stopDetails?: { departureStop?: { name?: string }; arrivalStop?: { name?: string } }; stopCount?: number } }> }> }
/** A route from the Routes API: total, per-leg and the main steps. */
export function formatGoogleRoute(r: { routes?: GRoute[] }, o: { origin: string; destination: string; mode: TravelMode; waypoints?: string[] }): string {
  const route = r.routes?.[0]
  const link = directionsLink(o.origin, o.destination, o.mode, o.waypoints)
  if (!route) return `No ${o.mode} route found from ${o.origin} to ${o.destination}.\nMap: ${link}`
  const steps = (route.legs ?? []).flatMap((l) => l.steps ?? []).map((s) => {
    const t = s.transitDetails
    if (t) return `${t.transitLine?.vehicle?.name?.text ?? 'Transit'} ${t.transitLine?.nameShort ?? t.transitLine?.name ?? ''} from ${t.stopDetails?.departureStop?.name ?? '?'} to ${t.stopDetails?.arrivalStop?.name ?? '?'}${t.stopCount ? ` (${t.stopCount} stops)` : ''}`.replace(/\s+/g, ' ')
    return s.navigationInstruction?.instructions ? `${s.navigationInstruction.instructions}${s.distanceMeters ? ` (${km(s.distanceMeters)})` : ''}` : ''
  }).filter(Boolean)
  const legs = (route.legs ?? []).length > 1 ? `\nLegs: ${(route.legs ?? []).map((l, i) => `${i + 1}) ${km(l.distanceMeters ?? NaN)}, ${duration(secs(l.duration))}`).join('; ')}` : ''
  return `${o.mode[0].toUpperCase()}${o.mode.slice(1)} from ${o.origin} to ${o.destination}${o.waypoints?.length ? ` via ${o.waypoints.join(', ')}` : ''}: ${km(route.distanceMeters ?? NaN)}, ${duration(secs(route.duration))}${o.mode === 'driving' ? ' with current traffic' : ''}${route.description ? ` (via ${route.description})` : ''}.${legs}\n${steps.length ? `Steps:\n${steps.slice(0, 25).map((s, i) => `${i + 1}. ${s}`).join('\n')}${steps.length > 25 ? `\n…and ${steps.length - 25} more` : ''}\n` : ''}Map: ${link}`
}

type OsrmRoute = { distance?: number; duration?: number; legs?: Array<{ distance?: number; duration?: number; summary?: string; steps?: Array<{ name?: string; distance?: number; maneuver?: { type?: string; modifier?: string } }> }> }
/** A route from OSRM: totals and turn-by-turn in words. */
export function formatOsrmRoute(r: { code?: string; routes?: OsrmRoute[] }, o: { origin: string; destination: string; mode: TravelMode; waypoints?: string[] }): string {
  const link = directionsLink(o.origin, o.destination, o.mode, o.waypoints)
  const route = r.routes?.[0]
  if (r.code !== 'Ok' || !route) return `No ${o.mode} route found from ${o.origin} to ${o.destination}.\nMap: ${link}`
  const steps = (route.legs ?? []).flatMap((l) => l.steps ?? []).filter((s) => (s.distance ?? 0) > 0 || s.maneuver?.type === 'arrive').map((s) => {
    const m = s.maneuver ?? {}
    const verb = m.type === 'depart' ? 'Head out' : m.type === 'arrive' ? 'Arrive' : m.type === 'roundabout' || m.type === 'rotary' ? 'Take the roundabout' : m.modifier ? `${m.type === 'turn' || m.type === 'end of road' ? 'Turn' : m.type === 'merge' ? 'Merge' : m.type === 'fork' ? 'Keep' : 'Continue'} ${m.modifier}` : 'Continue'
    return `${verb}${s.name ? ` on ${s.name}` : ''}${s.distance ? ` (${km(s.distance)})` : ''}`
  })
  const summary = (route.legs ?? []).map((l) => l.summary).filter(Boolean).join('; ')
  return `${o.mode[0].toUpperCase()}${o.mode.slice(1)} from ${o.origin} to ${o.destination}${o.waypoints?.length ? ` via ${o.waypoints.join(', ')}` : ''}: ${km(route.distance ?? NaN)}, about ${duration(route.duration ?? NaN)} (OpenStreetMap routing, no live traffic)${summary ? ` via ${summary}` : ''}.\n${steps.length ? `Steps:\n${steps.slice(0, 25).map((s, i) => `${i + 1}. ${s}`).join('\n')}${steps.length > 25 ? `\n…and ${steps.length - 25} more` : ''}\n` : ''}Map: ${link}`
}

/** A travel-time grid (rows: origins, columns: destinations). */
export function formatMatrix(origins: string[], destinations: string[], cell: (i: number, j: number) => { meters?: number; seconds?: number } | undefined, mode: TravelMode, note = ''): string {
  const rows = origins.map((o, i) => `- From ${o}:\n${destinations.map((d, j) => {
    const c = cell(i, j)
    return `    to ${d}: ${c && Number.isFinite(c.seconds) ? `${duration(c.seconds!)}${c.meters !== undefined && Number.isFinite(c.meters) ? `, ${km(c.meters)}` : ''}` : 'no route'} · ${directionsLink(o, d, mode)}`
  }).join('\n')}`)
  return `${mode[0].toUpperCase()}${mode.slice(1)} times${note ? ` (${note})` : ''}:\n${rows.join('\n')}`
}

/** The Routes API matrix (a JSON array of elements) as a lookup. */
export function readGoogleMatrix(rows: Array<{ originIndex?: number; destinationIndex?: number; duration?: string; distanceMeters?: number; condition?: string }>): (i: number, j: number) => { meters?: number; seconds?: number } | undefined {
  const m = new Map<string, { meters?: number; seconds?: number }>()
  for (const r of rows) if (r.condition !== 'ROUTE_NOT_FOUND') m.set(`${r.originIndex ?? 0}:${r.destinationIndex ?? 0}`, { meters: r.distanceMeters, seconds: secs(r.duration) })
  return (i, j) => m.get(`${i}:${j}`)
}

/** An Overpass QL query for a category around a point. */
export function overpassQuery(cat: string, at: { lat: number; lng: number }, radius: number, max: number): string {
  const tags = CATEGORIES[cat].osm
  const parts = tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"](around:${Math.round(radius)},${at.lat},${at.lng});`).join('')
  return `[out:json][timeout:25];(${parts});out center tags ${Math.min(200, max * 4)};`
}

// ---------------------------------------------------------------- the tool

export function mapsTool(deps: MapsDeps = {}): ToolDef<Args> {
  const f = deps.fetch ?? fetch
  const key = (): string | undefined => { try { return deps.googleKey?.() || undefined } catch { return undefined } }
  let nominatimLast = 0
  let chain: Promise<unknown> = Promise.resolve()
  /** Nominatim's usage policy: at most one request a second, a real User-Agent. */
  const nominatimSlot = (): Promise<void> => {
    const next = chain.then(async () => { const w = nominatimLast + 1100 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); nominatimLast = Date.now() })
    chain = next.catch(() => undefined)
    return next
  }
  async function req(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) })
      if (attempt >= 2 || ![429, 502, 503, 504].includes(res.status)) return res
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      if (signal.aborted) return res
    }
  }
  async function json<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const res = await req(url, init, signal)
    if (!res.ok) {
      let detail = ''
      try { const b = await res.json() as { error?: { message?: string; status?: string } | string; error_message?: string }; detail = typeof b.error === 'string' ? b.error : b.error?.message ?? b.error_message ?? '' } catch { /* not JSON */ }
      const host = new URL(url).host
      if (/googleapis\.com/.test(host) && (res.status === 403 || res.status === 400)) throw new Error(`Google Maps refused the request (${res.status}${detail ? `: ${clip(detail, 200)}` : ''}). Check the key in Settings → Keys for tools, and that Places API (New), Routes API and Geocoding API are enabled for it.`)
      throw new Error(`${host} answered ${res.status}${detail ? `: ${clip(detail, 200)}` : ''}. Try again shortly.`)
    }
    return (await res.json()) as T
  }
  const google = (path: string, body: unknown, mask: string, signal: AbortSignal) => json<any>(path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key()!, 'X-Goog-FieldMask': mask }, body: JSON.stringify(body) }, signal)
  const nominatim = async (path: string, signal: AbortSignal): Promise<any> => { await nominatimSlot(); return json(`${NOMINATIM}${path}`, { headers: { 'accept-language': 'en' } }, signal) }

  /** A text location or "lat,lng" → a point (Google geocoding with a key, else Nominatim). */
  async function locate(where: string, signal: AbortSignal): Promise<{ lat: number; lng: number; label: string }> {
    const p = parseLatLng(where)
    if (p) return { ...p, label: where }
    if (key()) {
      const r = await json<{ status?: string; error_message?: string; results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }> }>(`${GEOCODE}?address=${enc(where)}&key=${enc(key()!)}`, {}, signal)
      if (r.status === 'REQUEST_DENIED') throw new Error(`Google Maps refused the request: ${r.error_message ?? 'check the key'}. Enable the Geocoding API for this key.`)
      const g = r.results?.[0]?.geometry?.location
      if (g) return { lat: g.lat, lng: g.lng, label: r.results![0].formatted_address ?? where }
    } else {
      const r = await nominatim(`/search?format=jsonv2&limit=1&q=${enc(where)}`, signal) as NomItem[]
      if (r[0]) return { lat: Number(r[0].lat), lng: Number(r[0].lon), label: r[0].display_name ?? where }
    }
    throw new Error(`Couldn't find "${where}" on the map. Add a city or country.`)
  }

  const PLACE_MASK = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow,places.location,places.primaryTypeDisplayName,places.websiteUri,places.googleMapsUri'
  const DETAIL_MASK = 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,currentOpeningHours.openNow,regularOpeningHours.weekdayDescriptions,location,primaryTypeDisplayName,websiteUri,nationalPhoneNumber,googleMapsUri,editorialSummary'
  const googleMode = (m: TravelMode): string => ({ driving: 'DRIVE', walking: 'WALK', bicycling: 'BICYCLE', transit: 'TRANSIT' })[m]
  const waypoint = (s: string): Record<string, unknown> => { const p = parseLatLng(s); return p ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } } : { address: s } }
  const sources = (places: Place[]) => places.slice(0, 6).map((p) => ({ title: p.name, url: p.link }))
  const provider = (): string => (key() ? 'Google Maps' : 'OpenStreetMap')

  return {
    name: 'maps',
    label: 'Maps',
    core: false,
    group: 'Travel',
    effect: 'read',
    untrusted: true,
    description: 'Maps and travel: places, directions, travel times and what\'s nearby (Google Maps with the user\'s key, else OpenStreetMap). action: search (query, optional near: a place or "lat,lng" → places with rating, price, open now), place (place: id or name → details, hours, phone, website), directions (origin, destination, mode driving|walking|bicycling|transit, optional waypoints, depart ISO time → distance, duration, steps), distance_matrix (origins[], destinations[], mode → travel-time grid, e.g. hotels vs venues), nearby (category: restaurants, cafes, bars, attractions, museums, parks, hotels, pharmacies, hospitals, ev_charging, gas, groceries, atms, gyms, parking, coworking; near or lat/lng; radius meters), geocode (query → coordinates), reverse (lat, lng → address). Every result has Google Maps links: give them to the user. Transit needs the Google key. Hours and ratings change: say they come from the map.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        query: { type: 'string', description: 'search, geocode: what or where' },
        near: { type: 'string', description: 'search, nearby: a place name or "lat,lng" to search around' },
        place: { type: 'string', description: 'place: a place id from search, or a name' },
        origin: { type: 'string' },
        destination: { type: 'string' },
        waypoints: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'], description: 'default driving' },
        depart: { type: 'string', description: 'directions: ISO departure time (Google only; traffic and transit schedules)' },
        origins: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        destinations: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        category: { type: 'string', description: 'nearby: e.g. restaurants, museums, ev_charging' },
        radius: { type: 'integer', minimum: 100, maximum: 50000, description: 'nearby, search: meters (default 1500)' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        max: { type: 'integer', minimum: 1, maximum: 20, description: 'results (default 8)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const sig = ctx.signal
      const max = a.max ?? 8
      const mode: TravelMode = a.mode ?? 'driving'
      switch (a.action) {
        case 'search': {
          const q = (a.query ?? '').trim()
          if (!q) throw new Error('search needs a query, e.g. "ramen" with near "Shibuya, Tokyo".')
          const at = a.near ? await locate(a.near, sig) : a.lat !== undefined && a.lng !== undefined ? { lat: a.lat, lng: a.lng, label: `${a.lat},${a.lng}` } : undefined
          let places: Place[]
          if (key()) {
            const body: Record<string, unknown> = { textQuery: q, maxResultCount: max }
            if (at) body.locationBias = { circle: { center: { latitude: at.lat, longitude: at.lng }, radius: Math.min(50_000, a.radius ?? 5000) } }
            const r = await google(`${PLACES}/places:searchText`, body, PLACE_MASK, sig) as { places?: GPlace[] }
            places = (r.places ?? []).map(fromGoogle)
          } else {
            const box = at ? (() => { const d = Math.min(0.5, (a.radius ?? 5000) / 111_000); return `&viewbox=${at.lng - d},${at.lat + d},${at.lng + d},${at.lat - d}&bounded=1` })() : ''
            places = ((await nominatim(`/search?format=jsonv2&addressdetails=0&limit=${max}&q=${enc(q)}${box}`, sig)) as NomItem[]).map(fromNominatim)
          }
          if (at) for (const p of places) if (p.lat !== undefined && p.lng !== undefined) p.distance = haversine(at, { lat: p.lat, lng: p.lng })
          const heading = `${provider()} results for "${q}"${at ? ` near ${clip(at.label, 80)}` : ''}`
          return { text: `${formatPlaces(places, heading)}\n\nSee all on Google Maps: ${placeLink(at ? `${q} near ${a.near ?? at.label}` : q)}${key() ? '' : '\n(Open data has no ratings or opening status. A Google Maps key in Settings → Keys for tools adds them.)'}`, display: `Maps “${clip(q, 40)}” · ${places.length} places`, sources: sources(places) }
        }
        case 'place': {
          const ref = (a.place ?? a.query ?? '').trim()
          if (!ref) throw new Error('place needs a place id or name.')
          if (key()) {
            let p: GPlace | undefined
            if (/^[A-Za-z0-9_-]{20,}$/.test(ref)) p = await json<GPlace>(`${PLACES}/places/${enc(ref)}`, { headers: { 'X-Goog-Api-Key': key()!, 'X-Goog-FieldMask': DETAIL_MASK } }, sig)
            else {
              const r = await google(`${PLACES}/places:searchText`, { textQuery: ref, maxResultCount: 1 }, DETAIL_MASK.split(',').map((x) => `places.${x}`).join(','), sig) as { places?: GPlace[] }
              p = r.places?.[0]
            }
            if (!p) return { text: `Google Maps has no place matching "${ref}".`, display: 'Maps: no place' }
            const pl = fromGoogle(p)
            return { text: `${formatPlaces([pl], 'Place')}${pl.phone ? `\n   Phone: ${pl.phone}` : ''}${pl.summary ? `\n   ${pl.summary}` : ''}`, display: `Maps: ${clip(pl.name, 40)}`, sources: sources([pl]) }
          }
          const r = await nominatim(`/search?format=jsonv2&limit=1&extratags=1&q=${enc(ref)}`, sig) as Array<NomItem & { extratags?: Record<string, string> }>
          if (!r[0]) return { text: `No place matching "${ref}" on OpenStreetMap.\nTry Google Maps: ${placeLink(ref)}`, display: 'Maps: no place' }
          const pl = fromNominatim(r[0])
          const x = r[0].extratags ?? {}
          pl.website = x.website ?? x['contact:website']
          pl.phone = x.phone ?? x['contact:phone']
          if (x.opening_hours) pl.hours = [x.opening_hours]
          return { text: `${formatPlaces([pl], 'Place (OpenStreetMap)')}${pl.phone ? `\n   Phone: ${pl.phone}` : ''}`, display: `Maps: ${clip(pl.name, 40)}`, sources: sources([pl]) }
        }
        case 'directions': {
          if (!a.origin || !a.destination) throw new Error('directions needs an origin and a destination.')
          const o = { origin: a.origin, destination: a.destination, mode, waypoints: a.waypoints }
          if (key()) {
            const body: Record<string, unknown> = { origin: waypoint(a.origin), destination: waypoint(a.destination), travelMode: googleMode(mode), intermediates: (a.waypoints ?? []).map(waypoint), units: 'METRIC' }
            if (mode === 'driving') body.routingPreference = 'TRAFFIC_AWARE'
            if (a.depart) body.departureTime = new Date(a.depart).toISOString()
            if (mode === 'transit') delete body.intermediates
            const r = await google(`${ROUTES}/directions/v2:computeRoutes`, body, 'routes.distanceMeters,routes.duration,routes.description,routes.legs.distanceMeters,routes.legs.duration,routes.legs.steps.navigationInstruction.instructions,routes.legs.steps.distanceMeters,routes.legs.steps.transitDetails', sig)
            return { text: formatGoogleRoute(r, o), display: `Directions: ${clip(a.origin, 24)} → ${clip(a.destination, 24)}`, sources: [{ title: `Directions to ${a.destination}`, url: directionsLink(a.origin, a.destination, mode, a.waypoints) }] }
          }
          if (mode === 'transit') return { text: `Transit directions need a Google Maps API key (Settings → Keys for tools). Open the route in Google Maps instead: ${directionsLink(a.origin, a.destination, 'transit', a.waypoints)}`, display: 'Directions: transit needs a key', sources: [{ title: `Transit to ${a.destination}`, url: directionsLink(a.origin, a.destination, 'transit') }] }
          const pts = [await locate(a.origin, sig), ...(await Promise.all((a.waypoints ?? []).map((w) => locate(w, sig)))), await locate(a.destination, sig)]
          const r = await json<{ code?: string; routes?: OsrmRoute[] }>(`${OSRM[mode]}/${pts.map((p) => `${p.lng},${p.lat}`).join(';')}?overview=false&steps=true`, {}, sig)
          return { text: formatOsrmRoute(r, o), display: `Directions: ${clip(a.origin, 24)} → ${clip(a.destination, 24)}`, sources: [{ title: `Directions to ${a.destination}`, url: directionsLink(a.origin, a.destination, mode, a.waypoints) }] }
        }
        case 'distance_matrix': {
          const origins = (a.origins ?? []).filter(Boolean), dests = (a.destinations ?? []).filter(Boolean)
          if (!origins.length || !dests.length) throw new Error('distance_matrix needs origins and destinations.')
          if (origins.length * dests.length > 100) throw new Error('Up to 100 pairs at a time (e.g. 10 origins × 10 destinations).')
          if (key()) {
            const body: Record<string, unknown> = { origins: origins.map((x) => ({ waypoint: waypoint(x) })), destinations: dests.map((x) => ({ waypoint: waypoint(x) })), travelMode: googleMode(mode) }
            if (mode === 'driving') body.routingPreference = 'TRAFFIC_AWARE'
            if (a.depart) body.departureTime = new Date(a.depart).toISOString()
            const rows = await google(`${ROUTES}/distanceMatrix/v2:computeRouteMatrix`, body, 'originIndex,destinationIndex,duration,distanceMeters,condition', sig) as Array<{ originIndex?: number; destinationIndex?: number; duration?: string; distanceMeters?: number; condition?: string }>
            return { text: formatMatrix(origins, dests, readGoogleMatrix(Array.isArray(rows) ? rows : []), mode, mode === 'driving' ? 'Google Maps, with traffic' : 'Google Maps'), display: `Travel times: ${origins.length}×${dests.length}` }
          }
          if (mode === 'transit') throw new Error('Transit travel times need a Google Maps API key (Settings → Keys for tools).')
          const pts = await Promise.all([...origins, ...dests].map((x) => locate(x, sig)))
          const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';')
          const src = origins.map((_, i) => i).join(';'), dst = dests.map((_, j) => origins.length + j).join(';')
          const r = await json<{ code?: string; durations?: Array<Array<number | null>>; distances?: Array<Array<number | null>> }>(`${OSRM_TABLE[mode]}/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`, {}, sig)
          if (r.code !== 'Ok') throw new Error('OpenStreetMap routing couldn\'t compute these travel times.')
          return { text: formatMatrix(origins, dests, (i, j) => { const s = r.durations?.[i]?.[j], m = r.distances?.[i]?.[j]; return s == null ? undefined : { seconds: s, meters: m ?? undefined } }, mode, 'OpenStreetMap routing, no live traffic'), display: `Travel times: ${origins.length}×${dests.length}` }
        }
        case 'nearby': {
          const cat = categoryOf(a.category ?? a.query)
          if (!cat) throw new Error(`Unknown category "${a.category ?? a.query ?? ''}". Use one of: ${Object.keys(CATEGORIES).join(', ')}. For anything else use action "search" with near.`)
          const at = a.lat !== undefined && a.lng !== undefined ? { lat: a.lat, lng: a.lng, label: `${a.lat},${a.lng}` } : a.near ? await locate(a.near, sig) : undefined
          if (!at) throw new Error('nearby needs near (a place or "lat,lng") or lat and lng.')
          const radius = a.radius ?? 1500
          let places: Place[]
          if (key()) {
            const r = await google(`${PLACES}/places:searchNearby`, { includedTypes: [CATEGORIES[cat].google], maxResultCount: max, rankPreference: 'POPULARITY', locationRestriction: { circle: { center: { latitude: at.lat, longitude: at.lng }, radius } } }, PLACE_MASK, sig) as { places?: GPlace[] }
            places = (r.places ?? []).map(fromGoogle)
            for (const p of places) if (p.lat !== undefined && p.lng !== undefined) p.distance = haversine(at, { lat: p.lat, lng: p.lng })
          } else {
            let r: { elements?: OverpassEl[] } | undefined
            let last: Error | undefined
            for (const url of OVERPASS) {
              try { r = await json<{ elements?: OverpassEl[] }>(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${enc(overpassQuery(cat, at, radius, max))}` }, AbortSignal.any([sig, AbortSignal.timeout(20_000)])); break } catch (e) { last = e as Error; if (sig.aborted) throw e }
            }
            if (!r) throw new Error(`OpenStreetMap's nearby search isn't answering right now (${last?.message ?? 'no answer'}). Use action "search" with near, or open Google Maps: ${placeLink(`${CATEGORIES[cat].label} near ${a.near ?? `${at.lat},${at.lng}`}`)}`)
            places = fromOverpass(r, at, max)
          }
          return { text: `${formatPlaces(places, `${CATEGORIES[cat].label[0].toUpperCase()}${CATEGORIES[cat].label.slice(1)} within ${km(radius)} of ${clip(at.label, 80)} (${provider()}${key() ? ', most popular first' : ', nearest first'})`)}\n\nSee all on Google Maps: ${placeLink(`${CATEGORIES[cat].label} near ${a.near ?? `${at.lat},${at.lng}`}`)}`, display: `Nearby ${CATEGORIES[cat].label} · ${places.length}`, sources: sources(places) }
        }
        case 'geocode': {
          const q = (a.query ?? a.place ?? '').trim()
          if (!q) throw new Error('geocode needs a query.')
          const p = await locate(q, sig)
          return { text: `${p.label}\nCoordinates: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} (${provider()})\nMap: ${placeLink(`${p.lat},${p.lng}`)}`, display: `Geocode: ${clip(q, 40)}`, sources: [{ title: p.label, url: placeLink(`${p.lat},${p.lng}`) }] }
        }
        case 'reverse': {
          if (a.lat === undefined || a.lng === undefined) throw new Error('reverse needs lat and lng.')
          let label: string | undefined
          if (key()) {
            const r = await json<{ results?: Array<{ formatted_address?: string }> }>(`${GEOCODE}?latlng=${a.lat},${a.lng}&key=${enc(key()!)}`, {}, sig)
            label = r.results?.[0]?.formatted_address
          } else label = (await nominatim(`/reverse?format=jsonv2&lat=${a.lat}&lon=${a.lng}`, sig) as NomItem).display_name
          return { text: `${label ?? 'No address at that point.'}\nMap: ${placeLink(`${a.lat},${a.lng}`)}`, display: 'Reverse geocode', sources: [{ title: label ?? 'Location', url: placeLink(`${a.lat},${a.lng}`) }] }
        }
      }
    }
  }
}

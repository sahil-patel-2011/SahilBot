# Maps and travel

The maps tool finds places, gives directions and travel times, and shows what's nearby. Load it with
find_tools("maps") (travel requests load it on their own). Every result has Google Maps links: give
them to the user, next to each place and each route, so one tap opens it on their phone.

## Actions
- `search`: places by text ("ramen", "Louvre"), optionally `near` a place or "lat,lng" (and `radius` in
  meters). Shows rating, review count, price, open now and distance when the map has them.
- `place`: details for one place (`place`: an id from search, or a name): address, hours, phone, website.
- `directions`: `origin` → `destination`, `mode` driving (default), walking, bicycling or transit,
  optional `waypoints` (stops in order) and `depart` (ISO time). Distance, duration, the main steps and a
  route link.
- `distance_matrix`: `origins` × `destinations` (up to 100 pairs) → a travel-time grid. Use it to pick
  the hotel closest to what the user wants to see, or to order a day's stops.
- `nearby`: a `category` around `near` (or `lat`/`lng`): restaurants, cafes, bars, attractions, museums,
  parks, hotels, pharmacies, hospitals, ev_charging, gas, groceries, atms, gyms, parking, coworking.
  Anything else: `search` with `near`.
- `geocode` (`query` → coordinates) and `reverse` (`lat`, `lng` → address).

## Providers
- With the user's Google Maps key (Settings → Keys for tools → Google Maps, kept in the Keychain):
  Google Maps Platform. Places API (New), Routes API and Geocoding API must be enabled for the key.
  Ratings, prices, open now, hours, live traffic and transit.
- Without a key: OpenStreetMap. Nominatim for search and addresses, Overpass for nearby, OSRM for
  driving, walking and cycling routes. No ratings, opening status or live traffic, and no transit (the
  result says so and links Google Maps instead).
- Only the query goes out: never the user's name, contacts or memories.

## Planning a trip or an outing
1. Start point: the hotel, office or home (memory may have the user's city).
2. Candidates: `nearby` by theme and `search` for specific wants.
3. Cluster by area and check times with `distance_matrix`. Keep transfers short.
4. Order each day and get one route link with `directions` and `waypoints`.
5. Deliver a table: time, place (Google Maps link), travel time from the previous stop, cost, backup.
Skills: plan-a-trip (full trips), ideas-local-places (things to do, date nights, offsites, business
sites), ideas-creative-methods (brainstorming).

## Accuracy
Hours, prices and ratings change. Say they come from the map, check hours for the exact day on the
place's own site when it matters, and never book or pay: give the links, and the user books.

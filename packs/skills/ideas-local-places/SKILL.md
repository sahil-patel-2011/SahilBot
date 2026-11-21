---
name: ideas-local-places
description: Ideas grounded in real places nearby: things to do, date nights, team offsites, client dinners, or a site for a business, checked on the map.
source: you
uses: 0
category: Ideas
triggers: things to do near, date night ideas, what to do this weekend, team offsite, offsite venue, client dinner, places to take, fun things to do, rainy day ideas, kid friendly activities, where should we go, location for my business, best area to open
---

## Shape it
Who's going (ages, group size, mobility), where from (home, hotel or office: use memory for the user's city), when (day, time, weather), budget per person, mood (chill, active, fancy, cultural) and must-avoid. Ask once for what matters and is missing.

## Diverge with real places (maps tool: find_tools("maps"))
- Spread across 4-6 themes so the list has range: food and drink, outdoors, culture (museums, shows), active (climbing, kayaking, bowling), something unusual, and a free or cheap option.
- For each theme: maps(action="nearby", category=..., near=<start point>, radius 1500-8000 m) or maps(action="search", query="escape room" | "rooftop bar" | "pottery class", near=...).
- Business sites: search competitors and complements near each candidate area (e.g. gyms near offices, cafés near a university), and compare foot-traffic anchors (transit, schools, offices).
- Use web_search for events on the exact dates (concerts, markets, exhibitions) and check the venue with maps.

## Converge
- Check travel time from the start point with maps(action="distance_matrix") and drop anything over the time budget.
- Score the top 6-8 on fit to the mood, cost, travel time, rating (when the map gives one), and how easy it is to book. Show a small table.
- Pick 3: a safe bet, a stretch and a budget option. For each: what, why it fits, time and cost, the Google Maps link, and a backup if it's closed or full.
- Combine into a plan when asked: order the stops, maps(action="directions", waypoints) for the route link, and leave buffers.

## Rules
Hours, prices and ratings come from the map and change: say so, and check opening hours for the exact day. Never book or pay: give links; the user books. For a business site, a map scan is a starting point: before signing a lease, consult a real-estate professional or a lawyer.

---
name: app-media
description: Music and Spotify: play, pause, skip, volume, what's playing, search and play a song or playlist.
source: you
uses: 0
category: Mac Apps
---

Music (`app {app: "Music"}`):
- `now_playing`, `play`, `pause`, `playpause`, `next`, `previous`, `volume {level 0–100}`.
- Play a song from the user's library: `search {query: "artist song", play: true}`; without play it lists the matches to pick from.
- `play_playlist {name}` (part of the name works; lists playlists if none match).
- Songs not in the library (the Apple Music catalog): computer use: `computer open_app {app: "Music"}`, cmd+f, type the query, Return, then `ui {query: "song name"}` and click_ref the result's play button; verify with now_playing.

Spotify (`app {app: "Spotify"}`):
- Same controls, plus `play_uri {uri}` for an open.spotify.com link or spotify:track: URI (from the user or a web search).
- `search {query}` opens Spotify's search page; then `computer ui {app: "Spotify", query: "<title>"}` and click_ref the Play button of the top result (or double_click the row). Verify with now_playing.

Always confirm with now_playing after starting something. System volume and output devices: System Settings → Sound (app system_settings open_pane "sound").

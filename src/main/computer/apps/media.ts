import { JXA_GET, type AppAction, type AppAdapter } from './types'

// Music and Spotify through their scripting dictionaries: play, pause, skip, what's playing, volume,
// search (Music's own library) and play by Spotify link. All local and easy to undo.

const NOW = `const now = (A) => ({ state: String(get(() => A.playerState(), '')), track: String(get(() => A.currentTrack.name(), '') || ''), artist: String(get(() => A.currentTrack.artist(), '') || ''), album: String(get(() => A.currentTrack.album(), '') || ''), position: Math.round(get(() => A.playerPosition(), 0) || 0), volume: get(() => A.soundVolume(), null) })`

/** Player controls shared by Music and Spotify (same verbs in both dictionaries). */
export const PLAYER = `(a) => { ${JXA_GET}; ${NOW}
  const A = Application(a.app)
  if (a.op === 'play') A.play()
  else if (a.op === 'pause') A.pause()
  else if (a.op === 'playpause') A.playpause()
  else if (a.op === 'next') A.nextTrack()
  else if (a.op === 'previous') A.previousTrack()
  else if (a.op === 'volume') A.soundVolume = Math.max(0, Math.min(100, a.level))
  if (a.op !== 'now') delay(0.4)
  return now(A)
}`

export const MUSIC_SCRIPTS = {
  SEARCH: `(a) => { ${JXA_GET}; ${NOW}
    const M = Application('Music')
    const lib = M.libraryPlaylists[0]
    const hits = get(() => M.search(lib, { for: a.query }), []) || []
    const list = hits.slice(0, 10).map((t) => ({ name: String(get(() => t.name(), '')), artist: String(get(() => t.artist(), '')), album: String(get(() => t.album(), '')) }))
    if (a.play && hits.length) { M.play(hits[0]); delay(0.5); return { hits: list, now: now(M) } }
    return { hits: list }
  }`,
  PLAYLIST: `(a) => { ${JXA_GET}; ${NOW}
    const M = Application('Music')
    const names = get(() => M.playlists.name(), [])
    const w = String(a.name).toLowerCase()
    let i = names.findIndex((n) => String(n).toLowerCase() === w)
    if (i < 0) i = names.findIndex((n) => String(n).toLowerCase().indexOf(w) >= 0)
    if (i < 0) return { missing: true, names: names.slice(0, 60) }
    M.play(M.playlists[i]); delay(0.5)
    return { playlist: names[i], now: now(M) }
  }`
}

export const SPOTIFY_SCRIPTS = {
  PLAY_URI: `(a) => { ${JXA_GET}; ${NOW}
    const S = Application('Spotify')
    S.playTrack(a.uri)
    delay(0.8)
    return now(S)
  }`
}

/** A Spotify link or URI → "spotify:track:…" (tracks, albums, playlists, artists, shows, episodes). */
export function spotifyUri(s: string): string {
  const t = String(s).trim()
  const m = t.match(/^spotify:(track|album|playlist|artist|show|episode):([A-Za-z0-9]{10,40})$/) ?? t.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]{10,40})/)
  if (!m) throw new Error(`"${s}" isn't a Spotify link (open.spotify.com/track/…) or URI (spotify:track:…).`)
  return `spotify:${m[1]}:${m[2]}`
}

type Now = { state: string; track: string; artist: string; album: string; position: number; volume: number | null }
const describeNow = (n: Now): string => (n.track ? `${/play/i.test(n.state) ? 'Playing' : n.state || 'Stopped'}: "${n.track}"${n.artist ? ` by ${n.artist}` : ''}${n.album ? ` (${n.album})` : ''}${n.volume !== null ? `, volume ${n.volume}` : ''}.` : `Nothing is playing (${n.state || 'stopped'}).`)

function controls(app: string): Record<string, AppAction> {
  const op = (name: string, summary: string): AppAction => ({
    summary,
    effect: name === 'now' ? 'read' : 'write_local',
    needsRunning: name === 'now',
    describe: () => `${summary} in ${app}`,
    async run(_a, env) {
      const n = await env.jxa<Now>(PLAYER, { app, op: name })
      return { text: describeNow(n), display: n.track ? `${name === 'now' ? '' : `${name} · `}${n.track.slice(0, 40)}` : name }
    }
  })
  return {
    now_playing: op('now', 'What is playing'),
    play: op('play', 'Play'),
    pause: op('pause', 'Pause'),
    playpause: op('playpause', 'Play/pause'),
    next: op('next', 'Next track'),
    previous: op('previous', 'Previous track'),
    volume: {
      summary: 'Set the app\'s volume (0–100)',
      args: { level: { type: 'number', required: true, description: '0–100' } },
      effect: 'write_local',
      describe: (a) => `Set ${app}'s volume to ${a.level}`,
      async run(a, env) {
        const n = await env.jxa<Now>(PLAYER, { app, op: 'volume', level: Number(a.level) })
        return { text: `Volume is ${n.volume ?? a.level}. ${describeNow(n)}`, display: `volume ${n.volume ?? a.level}` }
      }
    }
  }
}

export const music: AppAdapter = {
  id: 'music',
  name: 'Music',
  aliases: ['apple music', 'itunes'],
  bundleIds: ['com.apple.Music'],
  paths: ['/System/Applications/Music.app'],
  blurb: 'play/pause/next/previous, now playing, volume, search the library and play, play a playlist',
  skill: 'app-media',
  notes: 'Uses Music\'s scripting dictionary. search only covers the user\'s library; for the Apple Music catalog, open music://music.apple.com/search?term=… with computer use and pick a result.',
  actions: {
    ...controls('Music'),
    search: {
      summary: 'Search the library (play: true plays the best match)',
      args: { query: { type: 'string', required: true, description: 'song, artist or album' }, play: { type: 'boolean', description: 'play the first match' } },
      effect: 'write_local',
      describe: (a) => `${a.play ? 'Play' : 'Search for'} "${a.query}" in Music`,
      async run(a, env) {
        const r = await env.jxa<{ hits: Array<{ name: string; artist: string; album: string }>; now?: Now }>(MUSIC_SCRIPTS.SEARCH, { query: String(a.query), play: !!a.play }, 30_000)
        if (!r.hits.length) return { text: `Nothing in the library matches "${a.query}". For the Apple Music catalog use computer use (open music://music.apple.com/search?term=…).`, display: 'no matches' }
        return { text: `${r.hits.map((h, i) => `${i + 1}. ${h.name} — ${h.artist}${h.album ? ` (${h.album})` : ''}`).join('\n')}${r.now ? `\n${describeNow(r.now)}` : ''}`, display: r.now ? `playing ${r.hits[0].name.slice(0, 40)}` : `${r.hits.length} matches` }
      }
    },
    play_playlist: {
      summary: 'Play a playlist by name',
      args: { name: { type: 'string', required: true, description: 'playlist name (or part of it)' } },
      effect: 'write_local',
      describe: (a) => `Play the playlist "${a.name}" in Music`,
      async run(a, env) {
        const r = await env.jxa<{ missing?: boolean; names?: string[]; playlist?: string; now?: Now }>(MUSIC_SCRIPTS.PLAYLIST, { name: String(a.name) }, 30_000)
        if (r.missing) return { text: `No playlist named "${a.name}". Playlists: ${(r.names ?? []).join(', ')}`, display: 'no such playlist' }
        return { text: `Playing "${r.playlist}". ${r.now ? describeNow(r.now) : ''}`, display: `playing ${r.playlist}` }
      }
    }
  }
}

export const spotify: AppAdapter = {
  id: 'spotify',
  name: 'Spotify',
  aliases: [],
  bundleIds: ['com.spotify.client'],
  paths: ['/Applications/Spotify.app'],
  blurb: 'play/pause/next/previous, now playing, volume, play a Spotify link, open a search',
  skill: 'app-media',
  notes: 'Uses Spotify\'s scripting dictionary. Its scripting can\'t search: search opens the search page in the app; then pick a result with computer use (ui refs, or the first result\'s play button).',
  actions: {
    ...controls('Spotify'),
    play_uri: {
      summary: 'Play a track, album or playlist by Spotify link or URI',
      args: { uri: { type: 'string', required: true, description: 'open.spotify.com/… link or spotify:track:… URI' } },
      effect: 'write_local',
      describe: (a) => `Play ${a.uri} in Spotify`,
      async run(a, env) {
        const n = await env.jxa<Now>(SPOTIFY_SCRIPTS.PLAY_URI, { uri: spotifyUri(a.uri) }, 30_000)
        return { text: describeNow(n), display: n.track ? `playing ${n.track.slice(0, 40)}` : 'playing' }
      }
    },
    search: {
      summary: 'Open Spotify\'s search for a query (then choose a result with computer use)',
      args: { query: { type: 'string', required: true, description: 'what to search for' } },
      effect: 'write_local',
      describe: (a) => `Search Spotify for "${a.query}"`,
      async run(a, env) {
        await env.sh('open', [`spotify:search:${encodeURIComponent(String(a.query))}`])
        return { text: `Opened Spotify's search for "${a.query}". Pick a result: computer ui {app:"Spotify", query:"${String(a.query).slice(0, 30)}"} then click_ref, or a screenshot.`, display: `searched "${String(a.query).slice(0, 30)}"` }
      }
    }
  }
}

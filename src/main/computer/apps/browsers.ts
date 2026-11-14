import { clip, JXA_GET, webUrl, type AppAction, type AppAdapter, type AppEnv, type Args } from './types'
import { siteHint } from '../../sites/hint'

// The user's own browsers (Safari, Google Chrome and Chromium-based ones) through their scripting
// dictionaries: open a page in a new tab, list tabs, the current page, switch, reload, close. Reading a
// page's text uses "do JavaScript", which only works once the user turns on "Allow JavaScript from Apple
// Events"; SahilBot detects when it is off and explains how to turn it on, and only ever runs its own
// fixed read-only script (never JavaScript the model wrote). Filling forms in the user's real browser
// goes through computer use; passwords never.

/** The only JavaScript SahilBot runs in the user's browser: read the page's title, address and visible text. */
export const PAGE_TEXT_JS = `(function () { var b = document.body; return JSON.stringify({ title: document.title, url: location.href, text: b ? String(b.innerText || '').slice(0, 300000) : '' }) })()`

type Kind = 'safari' | 'chromium'

export const SAFARI_SCRIPTS = {
  TABS: `(a) => { ${JXA_GET}
    const S = Application(a.app)
    const out = []
    const ws = get(() => S.windows(), [])
    for (let wi = 0; wi < ws.length; wi++) {
      const w = ws[wi]
      const tabs = get(() => w.tabs(), null)
      if (!tabs) continue
      const cur = get(() => w.currentTab().index(), 0)
      for (let ti = 0; ti < tabs.length; ti++) out.push({ window: wi + 1, tab: ti + 1, title: String(get(() => tabs[ti].name(), '') || ''), url: String(get(() => tabs[ti].url(), '') || ''), active: ti + 1 === cur })
    }
    return out
  }`,
  CURRENT: `(a) => { ${JXA_GET}
    const S = Application(a.app)
    const t = get(() => S.windows[0].currentTab(), null)
    return t ? { title: String(get(() => t.name(), '') || ''), url: String(get(() => t.url(), '') || '') } : null
  }`,
  OPEN: `(a) => { ${JXA_GET}
    const S = Application(a.app)
    S.activate()
    const w = get(() => { const x = S.windows[0]; x.currentTab(); return x }, null)
    if (!w || a.newWindow) { S.Document({ url: a.url }).make(); return { window: 'new' } }
    const t = S.Tab({ url: a.url })
    w.tabs.push(t)
    w.currentTab = w.tabs[w.tabs.length - 1]
    return { window: 1, tab: w.tabs.length }
  }`,
  FOCUS: `(a) => { const S = Application(a.app); const w = S.windows[a.window - 1]; w.currentTab = w.tabs[a.tab - 1]; w.index = 1; S.activate(); return true }`,
  RELOAD: `(a) => { const S = Application(a.app); const t = S.windows[a.window - 1].tabs[a.tab - 1]; t.url = t.url(); return true }`,
  CLOSE: `(a) => { const S = Application(a.app); S.windows[a.window - 1].tabs[a.tab - 1].close(); return true }`,
  JS: `(a) => {
    const S = Application(a.app)
    const t = S.windows[a.window - 1].tabs[a.tab - 1]
    try { return { ok: true, result: S.doJavaScript(a.js, { in: t }) } } catch (e) { return { ok: false, error: String(e).slice(0, 400) } }
  }`
}

export const CHROMIUM_SCRIPTS = {
  TABS: `(a) => { ${JXA_GET}
    const C = Application(a.app)
    const out = []
    const ws = get(() => C.windows(), [])
    for (let wi = 0; wi < ws.length; wi++) {
      const w = ws[wi]
      const tabs = get(() => w.tabs(), [])
      const cur = get(() => w.activeTabIndex(), 0)
      for (let ti = 0; ti < tabs.length; ti++) out.push({ window: wi + 1, tab: ti + 1, title: String(get(() => tabs[ti].title(), '') || ''), url: String(get(() => tabs[ti].url(), '') || ''), active: ti + 1 === cur })
    }
    return out
  }`,
  CURRENT: `(a) => { ${JXA_GET}
    const C = Application(a.app)
    const t = get(() => C.windows[0].activeTab(), null)
    return t ? { title: String(get(() => t.title(), '') || ''), url: String(get(() => t.url(), '') || '') } : null
  }`,
  OPEN: `(a) => { ${JXA_GET}
    const C = Application(a.app)
    C.activate()
    if (!get(() => C.windows.length, 0) || a.newWindow) { const w = C.Window().make(); w.activeTab.url = a.url; return { window: 'new' } }
    const w = C.windows[0]
    w.tabs.push(C.Tab({ url: a.url }))
    w.activeTabIndex = w.tabs.length
    return { window: 1, tab: w.tabs.length }
  }`,
  FOCUS: `(a) => { const C = Application(a.app); const w = C.windows[a.window - 1]; w.activeTabIndex = a.tab; w.index = 1; C.activate(); return true }`,
  RELOAD: `(a) => { const C = Application(a.app); C.windows[a.window - 1].tabs[a.tab - 1].reload(); return true }`,
  CLOSE: `(a) => { const C = Application(a.app); C.windows[a.window - 1].tabs[a.tab - 1].close(); return true }`,
  JS: `(a) => {
    const C = Application(a.app)
    const t = C.windows[a.window - 1].tabs[a.tab - 1]
    try { return { ok: true, result: t.execute({ javascript: a.js }) } } catch (e) { return { ok: false, error: String(e).slice(0, 400) } }
  }`
}

export interface Tab { window: number; tab: number; title: string; url: string; active: boolean }

/** A tab by window/tab number, or the first tab whose title or address contains `match`; the front tab by default. */
export function pickTab(tabs: Tab[], a: Args): Tab {
  if (!tabs.length) throw new Error('No browser windows are open.')
  if (a.match) {
    const q = String(a.match).toLowerCase()
    const hit = tabs.find((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
    if (!hit) throw new Error(`No tab matches "${a.match}". Open tabs:\n${formatTabs(tabs.slice(0, 30))}`)
    return hit
  }
  if (a.window !== undefined || a.tab !== undefined) {
    const w = Number(a.window ?? 1), t = Number(a.tab ?? tabs.find((x) => x.window === w && x.active)?.tab ?? 1)
    const hit = tabs.find((x) => x.window === w && x.tab === t)
    if (!hit) throw new Error(`There is no tab ${t} in window ${w}.`)
    return hit
  }
  return tabs.find((t) => t.window === 1 && t.active) ?? tabs[0]
}

export const formatTabs = (tabs: Tab[]): string => tabs.map((t) => `[w${t.window} t${t.tab}]${t.active ? ' (active)' : ''} ${t.title || '(untitled)'} — ${t.url}`).join('\n')

/** "do JavaScript" is turned off in the browser (the error both browsers give). */
export const jsDisabled = (err: string): boolean => /allow javascript from apple events|javascript through applescript is turned off|turned off|not allowed to (execute|run) javascript|-1723/i.test(err)

export function jsHelp(kind: Kind, name: string): string {
  const how = kind === 'safari'
    ? 'In Safari: Settings → Advanced → turn on "Show features for web developers", then Develop menu → "Allow JavaScript from Apple Events" (macOS asks to confirm).'
    : `In ${name}: View → Developer → "Allow JavaScript from Apple Events".`
  return `Reading page text needs "Allow JavaScript from Apple Events", which is off in ${name}. ${how} Only the user should turn it on (it lets apps that control ${name} run scripts in its pages; SahilBot only ever runs a fixed script that reads the page's text). Until then: read the page with computer ui {app:"${name}"} or a screenshot, or open the address with SahilBot's own browser tool / fetch_page.`
}

const tabArgs = {
  window: { type: 'number' as const, description: 'window number (from tabs)' },
  tab: { type: 'number' as const, description: 'tab number in that window' },
  match: { type: 'string' as const, description: 'part of the tab\'s title or address' }
}

function browser(kind: Kind, o: { id: string; name: string; aliases: string[]; bundleIds: string[]; paths: string[] }): AppAdapter {
  const S = kind === 'safari' ? SAFARI_SCRIPTS : CHROMIUM_SCRIPTS
  const tabs = (env: AppEnv): Promise<Tab[]> => env.jxa<Tab[]>(S.TABS, { app: o.name }).then((x) => x ?? [])
  const runJs = async (env: AppEnv, t: Tab, js: string): Promise<{ ok: boolean; result?: string; error?: string }> => env.jxa(S.JS, { app: o.name, window: t.window, tab: t.tab, js }, 30_000)
  const tabAction = (summary: string, script: string, verb: string, effect: 'write_local' | 'read' = 'write_local'): AppAction => ({
    summary,
    args: tabArgs,
    effect,
    needsRunning: true,
    describe: (a) => `${verb} ${a.match ? `the ${o.name} tab matching "${a.match}"` : a.tab ? `${o.name} tab ${a.tab}${a.window ? ` of window ${a.window}` : ''}` : `the front ${o.name} tab`}`,
    async run(a, env) {
      const t = pickTab(await tabs(env), a)
      await env.jxa(script, { app: o.name, window: t.window, tab: t.tab })
      return { text: `${verb} ${o.name} tab "${t.title}" (${t.url}).`, display: `${verb.toLowerCase()} "${t.title.slice(0, 40)}"` }
    }
  })
  return {
    ...o,
    blurb: 'open pages in new tabs, list tabs, current page, read page text, switch/reload/close tabs',
    skill: 'app-browsers',
    notes: `Uses ${o.name}'s scripting dictionary. read_page needs "Allow JavaScript from Apple Events" (js_status checks it). For websites prefer SahilBot's own browser tool; use ${o.name} when the user wants their real browser (their sign-ins). Fill forms in it with computer use (ui refs, type_ref), never by script; passwords and payment details are always the user's.`,
    actions: {
      open_url: {
        summary: 'Open a web address in a new tab (or a new window)',
        args: { url: { type: 'string', required: true, description: 'http(s) address' }, new_window: { type: 'boolean', description: 'open in a new window' } },
        effect: 'write_external',
        consequential: false,
        describe: (a) => `Open ${a.url} in ${o.name}`,
        async run(a, env) {
          const url = webUrl(a.url)
          await env.jxa(S.OPEN, { app: o.name, url, newWindow: !!a.new_window })
          return { text: `Opened ${url} in a new ${a.new_window ? 'window' : 'tab'} in ${o.name}. It loads in the background: check it with current or read_page.`, display: `opened ${new URL(url).hostname}` }
        }
      },
      tabs: {
        summary: 'Every open tab: window, tab number, title, address',
        effect: 'read',
        needsRunning: true,
        describe: () => `List ${o.name}'s tabs`,
        async run(_a, env) {
          const list = await tabs(env)
          return { text: list.length ? formatTabs(list) : `${o.name} has no open windows.`, display: `${list.length} tabs` }
        }
      },
      current: {
        summary: 'The front tab\'s title and address',
        effect: 'read',
        needsRunning: true,
        describe: () => `Read ${o.name}'s current page address`,
        async run(_a, env) {
          const c = await env.jxa<{ title: string; url: string } | null>(S.CURRENT, { app: o.name })
          return { text: c ? `${c.title || '(untitled)'}\n${c.url}` : `${o.name} has no open window.`, display: c ? c.title.slice(0, 50) : 'no window' }
        }
      },
      focus_tab: tabAction('Bring a tab to the front', S.FOCUS, 'Switched to'),
      reload: tabAction('Reload a tab', S.RELOAD, 'Reloaded'),
      close_tab: tabAction('Close a tab (it may lose unsaved form input)', S.CLOSE, 'Closed'),
      read_page: {
        summary: 'A tab\'s title, address and visible text (needs "Allow JavaScript from Apple Events")',
        args: { ...tabArgs, max_chars: { type: 'number', description: 'default 30000' } },
        effect: 'read',
        needsRunning: true,
        describe: () => `Read the page text in ${o.name}`,
        async run(a, env) {
          const t = pickTab(await tabs(env), a)
          const r = await runJs(env, t, PAGE_TEXT_JS)
          if (!r.ok) {
            if (jsDisabled(r.error ?? '')) return { text: jsHelp(kind, o.name), display: 'JavaScript from Apple Events is off' }
            throw new Error(`${o.name} couldn't read the page: ${r.error}`)
          }
          let page: { title?: string; url?: string; text?: string } = {}
          try { page = JSON.parse(String(r.result ?? '{}')) } catch { page = { text: String(r.result ?? '') } }
          // Acting on it: accessibility refs in the user's browser, or SahilBot's own browser when it knows the site.
          const hint = siteHint(page.url ?? t.url)
          const act = `[To act on this page in ${o.name}: computer ui {app:"${o.name}", query} for element refs, then click_ref / type_ref (never passwords, codes or card numbers: those are the user's).${hint ? ` ${hint}` : ''}]`
          return { text: `${page.title ?? t.title}\n${page.url ?? t.url}\n\n${clip(page.text ?? '', Number(a.max_chars) || 30_000)}\n\n${act}`, display: `read "${(page.title ?? t.title).slice(0, 40)}"` }
        }
      },
      js_status: {
        summary: 'Whether "Allow JavaScript from Apple Events" is on (needed by read_page), and how to turn it on',
        effect: 'read',
        needsRunning: true,
        describe: () => `Check ${o.name}'s JavaScript from Apple Events setting`,
        async run(_a, env) {
          const list = await tabs(env)
          if (!list.length) return { text: `${o.name} has no open tab to test with. Open one (open_url) first.`, display: 'no tab' }
          const r = await runJs(env, pickTab(list, {}), '1+1')
          if (r.ok) return { text: `"Allow JavaScript from Apple Events" is on in ${o.name}: read_page works.`, display: 'JavaScript from Apple Events on' }
          return { text: jsDisabled(r.error ?? '') ? jsHelp(kind, o.name) : `Couldn't tell: ${r.error}`, display: 'JavaScript from Apple Events off' }
        }
      }
    }
  }
}

export const safari = browser('safari', { id: 'safari', name: 'Safari', aliases: [], bundleIds: ['com.apple.Safari'], paths: ['/Applications/Safari.app'] })
export const chrome = browser('chromium', { id: 'chrome', name: 'Google Chrome', aliases: ['chrome', 'google chrome'], bundleIds: ['com.google.Chrome'], paths: ['/Applications/Google Chrome.app'] })
export const brave = browser('chromium', { id: 'brave', name: 'Brave Browser', aliases: ['brave'], bundleIds: ['com.brave.Browser'], paths: ['/Applications/Brave Browser.app'] })
export const edge = browser('chromium', { id: 'edge', name: 'Microsoft Edge', aliases: ['edge'], bundleIds: ['com.microsoft.edgemac'], paths: ['/Applications/Microsoft Edge.app'] })

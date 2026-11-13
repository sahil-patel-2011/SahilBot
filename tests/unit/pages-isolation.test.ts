import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { fileHeaders, INERT_CSP } = await import('../../src/main/attachments')
const { GUARD_PRELOAD, pageNavAllowed, pageUrl, servePage, STRIP_WEBRTC, subframeNavAllowed, WEBRTC_POLICY } = await import('../../src/main/agent/tools/pages')

/** A workspace with a pages folder holding one page, plus plain HTML/SVG files elsewhere. */
function workspace(): { ws: string; dir: string; page: string } {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')))
  const dir = join(ws, 'pages')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  const page = join(dir, 'q3.html')
  writeFileSync(page, '<!doctype html><h1>Q3</h1>')
  writeFileSync(join(dir, 'other.html'), '<!doctype html><h1>Other</h1>')
  writeFileSync(join(dir, 'sub', 'nested.html'), '<script>fetch("https://evil.example")</script>')
  writeFileSync(join(dir, 'notes.txt'), 'hi')
  writeFileSync(join(ws, 'plain.html'), '<script>fetch("https://evil.example")</script>')
  writeFileSync(join(ws, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example")</script></svg>')
  return { ws, dir, page }
}

describe('page navigation allow-list', () => {
  test('a page may go to itself or another page in the pages folder', () => {
    const { dir, page } = workspace()
    expect(pageNavAllowed(dir, pageUrl(page))).toBe(true)
    expect(pageNavAllowed(dir, `${pageUrl(page)}?v=2#top`)).toBe(true)
    expect(pageNavAllowed(dir, pageUrl(join(dir, 'other.html')))).toBe(true)
  })

  test('plain workspace files, sub-folders, links and other schemes are refused', () => {
    const { ws, dir } = workspace()
    symlinkSync(join(ws, 'plain.html'), join(dir, 'link.html'))
    for (const f of [join(ws, 'plain.html'), join(ws, 'logo.svg'), join(dir, 'sub', 'nested.html'), join(dir, 'notes.txt'), join(dir, 'link.html'), join(dir, 'missing.html')]) {
      expect(pageNavAllowed(dir, pageUrl(f))).toBe(false)
    }
    expect(pageNavAllowed(dir, `foreman-file://local${pathToFileURL(dir).pathname}/../plain.html`)).toBe(false)
    expect(pageNavAllowed(dir, `foreman-file://other${pathToFileURL(join(dir, 'q3.html')).pathname}`)).toBe(false)
    expect(pageNavAllowed(dir, `foreman-file://user:pw@local${pathToFileURL(join(dir, 'q3.html')).pathname}`)).toBe(false)
    expect(pageNavAllowed(dir, 'foreman-file://local/%E0%A4%A')).toBe(false)
    for (const u of ['https://evil.example/', 'http://127.0.0.1:9/', 'data:text/html,<script>1</script>', 'blob:null/abc', 'about:blank', 'file:///etc/hosts', 'javascript:alert(1)', 'not a url']) {
      expect(pageNavAllowed(dir, u)).toBe(false)
    }
  })

  test('frames inside a page may only hold inline documents', () => {
    expect(subframeNavAllowed('about:blank')).toBe(true)
    expect(subframeNavAllowed('about:srcdoc')).toBe(true)
    for (const u of ['data:text/html,x', 'foreman-file://local/x.html', 'https://evil.example', 'blob:null/1', 'about:blank#x']) expect(subframeNavAllowed(u)).toBe(false)
  })
})

describe('WebRTC removal', () => {
  test('the guard deletes every RTC* / webkitRTC* global and nothing else', () => {
    const win: Record<string, unknown> = {
      RTCPeerConnection: function () {}, webkitRTCPeerConnection: function () {}, RTCDataChannel: function () {},
      RTCIceCandidate: function () {}, RTCSessionDescription: function () {}, RTCRtpTransceiver: function () {},
      fetch: function () {}, document: {}, Rtc: 1
    }
    runInNewContext(`(${STRIP_WEBRTC})()`, { window: win })
    expect(Object.keys(win).sort()).toEqual(['Rtc', 'document', 'fetch'])
  })

  test('a global it cannot remove does not break the guard', () => {
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, 'RTCPeerConnection', { value: function () {}, writable: false, configurable: false, enumerable: false })
    runInNewContext(`(${STRIP_WEBRTC})()`, { window: win })
    // Non-configurable properties can't be redefined either; the page then still sees it, so the
    // network layer (dead-end proxy + WebRTC IP policy) is what stops it. Real Chromium globals are configurable.
    expect(typeof win.RTCPeerConnection).toBe('function')
  })

  test('the preload exposes nothing to the page and runs the guard in the main world', () => {
    expect(GUARD_PRELOAD).toContain(STRIP_WEBRTC)
    expect(GUARD_PRELOAD).toContain('executeInMainWorld')
    expect(GUARD_PRELOAD).not.toMatch(/exposeInMainWorld|ipcRenderer/)
    expect(WEBRTC_POLICY).toBe('disable_non_proxied_udp')
  })

  test('pages are served with DNS prefetching off', () => {
    const { dir, page } = workspace()
    const r = servePage(dir, page)!
    expect(r.headers.get('X-DNS-Prefetch-Control')).toBe('off')
    expect(r.headers.get('Content-Security-Policy')).toMatch(/sandbox allow-scripts$/)
  })
})

describe('foreman-file: headers for files that are not pages', () => {
  test('anything that could be a document is sandboxed with no scripts and no network', () => {
    for (const f of ['/w/plain.html', '/w/a.HTM', '/w/a.xhtml', '/w/logo.svg', '/w/feed.xml', '/w/notes.txt', '/w/no-extension', '/w/pages/q3.html', '/w/a.png']) {
      const h = fileHeaders(f)
      expect(h['Content-Security-Policy']).toBe(INERT_CSP)
      expect(h['X-Content-Type-Options']).toBe('nosniff')
    }
    const directives = INERT_CSP.split(';').map((d) => d.trim())
    expect(directives).toContain('sandbox')
    expect(directives).toContain("default-src 'none'")
    expect(INERT_CSP).not.toMatch(/allow-scripts|script-src|connect-src|unsafe-eval/)
  })

  test('PDFs stay viewable but are always typed as PDF', () => {
    const h = fileHeaders('/w/report.PDF')
    expect(h['Content-Type']).toBe('application/pdf')
    expect(h['Content-Security-Policy']).toBeUndefined()
    expect(h['X-Content-Type-Options']).toBe('nosniff')
  })
})

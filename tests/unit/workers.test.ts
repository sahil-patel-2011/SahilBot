import { describe, expect, test, vi } from 'vitest'
import { Db } from '../../src/main/db'
import { WorkerFleet, WorkerHost, placementBlock } from '../../src/main/workers'
import { isBrowserAddress, publicPageUrl, workerBrowserTool } from '../../src/main/agent/tools/worker-browser'
import { routineDownload } from '../../src/main/browser/download-policy'
import type { SharedBotFile } from '@shared/types'

const profile: SharedBotFile = {
  format: 'sahilbot.bot', version: 1, name: 'Researcher', color: '#123456', shape: 'blob', instructions: 'Read public sources.', skills: [], routines: []
}

describe('worker placement', () => {
  test('moves a bot one host at a time, including a lost response after activation', async () => {
    const mac = new Db(':memory:')
    const a = new Db(':memory:')
    const b = new Db(':memory:')
    let busy = false
    let loseReply = false
    const worker = (db: Db, isBusy: () => boolean) => new WorkerHost({
      db, isBusy, changed: () => undefined,
      provision: (id, file) => { if (!db.getSpace(id)) db.createSpace(file.name, file.color, {}, id) }
    })
    const north = worker(a, () => busy)
    const south = worker(b, () => false)
    const tokens = new Map<string, string>()
    const fleet = new WorkerFleet({
      db: mac, isBusy: () => false, changed: () => undefined, profile: () => profile, openExternal: () => undefined,
      secrets: { get: (k) => tokens.get(k), set: (k, value) => { if (value) tokens.set(k, value) } },
      call: async (url, path, o) => {
        const host = url.includes('north') ? north : south
        if (path === '/api/pair') return { status: 200, json: { token: url } }
        expect(o?.token).toBe(url)
        try {
          if (path === '/api/workers') return { status: 200, json: host.status() }
          const json = host.place(o?.body)
          expect(north.status().active + south.status().active).toBeLessThanOrEqual(1)
          if (loseReply && host === south) throw new Error('Connection closed after activation')
          return { status: 200, json }
        } catch (e) { return { status: 409, json: { error: (e as Error).message } } }
      }
    })
    const bot = mac.createSpace('Researcher', '#123456')
    await fleet.pair({ name: 'North Pi', url: 'https://north.example', code: 'code' })
    await fleet.pair({ name: 'South Pi', url: 'https://south.example', code: 'code' })
    const [first, second] = (await fleet.list(true)).workers
    await fleet.assign(bot.id, first.id)
    expect(placementBlock(mac, bot.id)).toContain('North Pi')
    busy = true
    await expect(fleet.assign(bot.id, second.id)).rejects.toThrow(/still has work running/)
    expect(south.status().active).toBe(0)
    busy = false
    loseReply = true
    await expect(fleet.assign(bot.id, second.id)).rejects.toThrow(/after activation/)
    expect(placementBlock(mac, bot.id)).toMatch(/moving/)
    expect(await fleet.list(false)).toMatchObject({ placements: [{ workerId: first.id, pending: { workerId: second.id } }] })
    loseReply = false
    await fleet.assign(bot.id, second.id)
    expect(north.status().active).toBe(0)
    expect(south.status().active).toBe(1)
    expect(() => north.place({ id: bot.id, revision: 1, active: true, file: profile })).toThrow(/newer placement/)
    await fleet.assign(bot.id, null)
    expect(south.status().active).toBe(0)
    expect(placementBlock(mac, bot.id)).toBeUndefined()
  })

  test('a worker enforces capacity, and rejected placement creates no copy', () => {
    const db = new Db(':memory:')
    const host = new WorkerHost({ db, changed: () => undefined, isBusy: () => false, provision: (id, file) => { db.createSpace(file.name, file.color, {}, id) } })
    host.setCapacity(1)
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    host.place({ id: first, revision: 1, active: true, file: profile })
    expect(() => host.place({ id: second, revision: 1, active: true, file: profile })).toThrow(/no free bot slots/)
    expect(db.getSpace(second)).toBeUndefined()
    host.place({ id: first, revision: 2, active: false })
    expect(host.place({ id: second, revision: 1, active: true, file: profile })).toEqual({ ok: true })
  })
})

describe('background browsers', () => {
  test('worker sessions isolate page links and skip consequential controls', async () => {
    const load = vi.fn(async (url: string) => ({ url, html: '<title>Example</title><p>Public report</p><a href="/read">Read the report</a><a href="/delete">Delete the report</a>' }))
    const tool = workerBrowserTool(load)
    const ctx = (threadId: string): Parameters<typeof tool.run>[1] => ({ threadId, signal: new AbortController().signal }) as never
    const page = await tool.run({ action: 'navigate', url: 'https://example.com/' }, ctx('one'))
    expect(page.text).toContain('[link1] Read the report')
    expect(page.text).not.toContain('[link2]')
    await expect(tool.run({ action: 'snapshot' }, ctx('two'))).rejects.toThrow(/Open a page/)
    await tool.run({ action: 'follow', ref: 'link1' }, ctx('one'))
    expect(load.mock.calls.at(-1)?.[0]).toBe('https://example.com/read')
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '100.100.100.100', '198.18.1.1', '::ffff:127.0.0.1']) expect(isBrowserAddress(address)).toBe(false)
    expect(isBrowserAddress('1.1.1.1')).toBe(true)
    expect(() => publicPageUrl('https://example.com:5000')).toThrow()
    expect(() => publicPageUrl('https://user:pass@example.com')).toThrow()
  })

  test('automatic downloads require a small passive file from the same HTTPS origin', () => {
    const download = { url: 'https://example.com/file.csv', filename: 'file.csv', size: 100, mime: 'text/csv' }
    const page = 'https://example.com/report'
    expect(routineDownload(download, page)).toBe(true)
    for (const change of [{ url: 'https://other.example/file.csv' }, { size: -1 }, { size: 12 * 1024 ** 2 }, { mime: 'text/html' }, { filename: 'file.command' }]) {
      expect(routineDownload({ ...download, ...change }, page)).toBe(false)
    }
  })
})

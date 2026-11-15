import { afterEach, describe, expect, test, vi } from 'vitest'
import { addAdapter, broadcast, channels, hasHandler, invoke, registerHandler, resetRpc, unregisterHandler } from '../../src/main/rpc'
import { electronAdapter } from '../../src/main/rpc-electron'
import { decode, encode } from '../../src/server/codec'

// The transport-agnostic registry (src/main/rpc.ts) and its two transports: Electron IPC (rpc-electron.ts)
// and the WebSocket hub (src/server/hub.ts, through the shared codec).

afterEach(() => resetRpc())

describe('rpc registry', () => {
  test('handlers are invoked with the caller context and their arguments', async () => {
    registerHandler('math:add', (ctx, a, b) => ({ sum: (a as number) + (b as number), via: ctx.transport }))
    expect(hasHandler('math:add')).toBe(true)
    expect(await invoke('math:add', { transport: 'test' }, [2, 3])).toEqual({ sum: 5, via: 'test' })
    expect(channels()).toContain('math:add')
  })

  test('unknown channels reject like Electron does; handler errors pass through', async () => {
    await expect(invoke('nope', { transport: 'test' }, [])).rejects.toThrow("No handler registered for 'nope'")
    registerHandler('boom', () => { throw new Error('kaput') })
    await expect(invoke('boom', { transport: 'test' }, [])).rejects.toThrow('kaput')
    registerHandler('later', async () => { await new Promise((r) => setTimeout(r, 5)); return 7 })
    expect(await invoke('later', { transport: 'test' }, [])).toBe(7)
  })

  test('registering again replaces the handler; unregister removes it', async () => {
    registerHandler('x', () => 1)
    registerHandler('x', () => 2)
    expect(await invoke('x', { transport: 'test' }, [])).toBe(2)
    unregisterHandler('x')
    expect(hasHandler('x')).toBe(false)
  })

  test('broadcast reaches every adapter; a failing adapter does not stop the others', () => {
    const got: unknown[] = []
    addAdapter({ send: () => { throw new Error('dead socket') } })
    addAdapter({ send: (ev, args) => got.push([ev, ...args]) })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    broadcast('chat:event', { threadId: 't1', type: 'delta' })
    spy.mockRestore()
    expect(got).toEqual([['chat:event', { threadId: 't1', type: 'delta' }]])
  })

  test('an adapter attached late learns the channels registered before it; detaching unregisters them', () => {
    registerHandler('a', () => 1)
    const seen: string[] = []
    const gone: string[] = []
    const detach = addAdapter({ onRegister: (c) => seen.push(c), onUnregister: (c) => gone.push(c) })
    registerHandler('b', () => 2)
    expect(seen).toEqual(['a', 'b'])
    detach()
    expect(gone.sort()).toEqual(['a', 'b'])
  })
})

describe('Electron IPC adapter', () => {
  function fakeIpc() {
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    return {
      h,
      handle: vi.fn((ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { if (h.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`); h.set(ch, fn) }),
      removeHandler: vi.fn((ch: string) => { h.delete(ch) })
    }
  }

  test('each channel becomes ipcMain.handle, with the sender passed through as context', async () => {
    const ipc = fakeIpc()
    addAdapter(electronAdapter(ipc as never, () => []))
    registerHandler('who', (ctx) => ({ t: ctx.transport, s: ctx.sender }))
    const sender = { id: 7 }
    expect(await ipc.h.get('who')!({ sender, senderFrame: null }, 'x')).toEqual({ t: 'electron', s: sender })
    // Replacing a handler never trips Electron's "second handler" error.
    registerHandler('who', () => 'new')
    expect(await ipc.h.get('who')!({ sender }, 'x')).toBe('new')
    unregisterHandler('who')
    expect(ipc.h.has('who')).toBe(false)
  })

  test('events go to the target windows that still exist', () => {
    const live = { isDestroyed: () => false, send: vi.fn() }
    const dead = { isDestroyed: () => true, send: vi.fn() }
    addAdapter(electronAdapter(fakeIpc() as never, () => [live, dead] as never))
    broadcast('budget:changed', 1, 'two')
    expect(live.send).toHaveBeenCalledWith('budget:changed', 1, 'two')
    expect(dead.send).not.toHaveBeenCalled()
  })
})

describe('WebSocket codec', () => {
  test('bytes, Float32Array and dates survive; prototype keys are dropped', () => {
    const msg = { t: 'call', id: 1, ch: 'attach:add', args: [{ blobs: [{ name: 'a.png', data: new Uint8Array([1, 2, 255]) }], f: new Float32Array([0.5, -1]), at: new Date('2026-01-02T03:04:05Z'), skip: undefined }] } as const
    const back = decode<{ args: Array<Record<string, any>> }>(encode(msg as never))
    expect([...back.args[0].blobs[0].data]).toEqual([1, 2, 255])
    expect([...back.args[0].f]).toEqual([0.5, -1])
    expect(back.args[0].at.toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect('skip' in back.args[0]).toBe(false)
    const evil = decode<Record<string, unknown>>('{"__proto__":{"polluted":true},"ok":1}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(evil.ok).toBe(1)
  })
})

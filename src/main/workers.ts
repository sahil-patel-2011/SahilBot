import { randomUUID } from 'node:crypto'
import type { SharedBotFile, Space, WorkerPlacement, WorkerView } from '@shared/types'
import { botFileProblems, cleanText } from './bot-share'
import type { Db } from './db'
import { callServer, normalizeServerUrl } from './remote-server'
import { registerHandler } from './rpc'
import { isServer } from './runtime'
import type { Secrets } from './secrets'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FLEET = 'workers:machines'
const BINDINGS = 'workers:placements'
const HOSTED = 'workers:hosted'
const CAPACITY = 'workers:capacity'
const INSTANCE = 'workers:instance'
const ENDPOINT = '/api/workers'
const keyFor = (id: string): string => `worker:${id}`

interface Machine extends Pick<WorkerView, 'id' | 'name' | 'url'> { instance: string; pin?: string }
interface Hosted { revision: number; active: boolean }
interface Binding extends WorkerPlacement { revision: number }

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid bot or worker ID.')
  return value
}

function requireSlots(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) throw new Error('Choose between 1 and 50 bot slots.')
  return value
}

const hostedOf = (db: Db): Record<string, Hosted> => db.getSetting<Record<string, Hosted>>(HOSTED) ?? {}
const bindingsOf = (db: Db): Record<string, Binding> => db.getSetting<Record<string, Binding>>(BINDINGS) ?? {}
const machinesOf = (db: Db): Machine[] => db.getSetting<Machine[]>(FLEET) ?? []

export function placementOf(db: Db, botId: string): Space['placement'] {
  if (isServer()) return hostedOf(db)[botId]?.active === false ? { label: 'Inactive on this worker', inactive: true } : undefined
  const bound = bindingsOf(db)[botId]
  if (!bound?.pending && !bound?.workerId) return undefined
  const target = bound.pending ? bound.pending.workerId : bound.workerId
  return { label: machinesOf(db).find((m) => m.id === target)?.name ?? (target ? 'Worker' : 'This Mac'), ...(bound.pending ? { moving: true } : {}) }
}

export function placementBlock(db: Db, botId: string): string | undefined {
  const p = placementOf(db, botId)
  if (!p) return undefined
  if (p.moving) return 'This bot is moving. Retry the placement in Settings → Always-on server.'
  if (p.inactive) return 'This bot is inactive on this worker. Open it on its assigned machine.'
  return `This bot runs on ${p.label}. Open its worker to send it a task.`
}

interface WorkerDeps {
  db: Db
  isBusy: (id: string) => boolean
  changed: () => void
}

/** Server-side placement. Revisions fence delayed requests from an earlier transfer. */
export class WorkerHost {
  private instance: string

  constructor(private d: WorkerDeps & { provision: (id: string, file: SharedBotFile) => void }) {
    this.instance = d.db.getSetting<string>(INSTANCE) ?? randomUUID()
    d.db.setSetting(INSTANCE, this.instance)
  }

  status(): { capacity: number; active: number; instance: string } {
    const { db } = this.d
    const active = Object.entries(hostedOf(db)).filter(([id, state]) => state.active && db.getSpace(id)).length
    return { capacity: db.getSetting<number>(CAPACITY) ?? 5, active, instance: this.instance }
  }

  setCapacity(raw: unknown): { capacity: number; active: number } {
    const capacity = requireSlots(raw)
    const { active } = this.status()
    if (capacity < active) throw new Error(`Move ${active - capacity} bot(s) before reducing capacity.`)
    this.d.db.setSetting(CAPACITY, capacity)
    return { capacity, active }
  }

  place(raw: unknown): { ok: true } {
    if (!raw || typeof raw !== 'object') throw new Error('Missing bot placement.')
    const { id: rawId, revision, active, file } = raw as { id?: string; revision?: number; active?: boolean; file?: SharedBotFile }
    const id = requireId(rawId)
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || typeof active !== 'boolean') throw new Error('Invalid placement revision.')
    const { db } = this.d
    const hosted = hostedOf(db)
    const current = hosted[id]
    const space = db.getSpace(id)
    if (space && !current) throw new Error('This ID belongs to an existing bot on this worker.')
    if (current && (current.revision > revision || (current.revision === revision && current.active !== active))) throw new Error('A newer placement is already recorded.')
    if (!active && this.d.isBusy(id)) throw new Error('This bot still has work running. Stop it or wait for it to finish, then retry the move.')
    if (active && (!current?.active || !space)) {
      const status = this.status()
      if (status.active >= status.capacity) throw new Error('This worker has no free bot slots.')
    }
    if (active && (!space || !current?.active)) {
      if (!file || botFileProblems(file).length || file.routines.length) throw new Error('Invalid worker bot profile.')
      // Keep a new bot inactive until its profile and workspace exist.
      if (!space) db.setSetting(HOSTED, { ...hosted, [id]: { revision: revision - 1, active: false } })
      this.d.provision(id, file)
    }
    db.setSetting(HOSTED, { ...hosted, [id]: { revision, active } })
    if (space || active) this.d.changed()
    return { ok: true }
  }
}

export function setupWorkerHost(d: ConstructorParameters<typeof WorkerHost>[0]): void {
  const host = new WorkerHost(d)
  registerHandler('workerHost:request', (ctx, action, body) => {
    if (ctx.transport !== 'worker') throw new Error('Use the paired worker connection.')
    if (action === 'status') return host.status()
    if ((body as { instance?: unknown } | undefined)?.instance !== host.status().instance) throw new Error('This connection points to a different worker instance.')
    if (action === 'capacity') return host.setCapacity((body as { slots?: unknown } | undefined)?.slots)
    if (action === 'place') return host.place(body)
    throw new Error('Unknown worker action.')
  })
}

type WorkerCall = typeof callServer

/** Mac-side placement. Persist the destination before touching either host so a retry uses the same revision. */
export class WorkerFleet {
  private moves = new Set<string>()
  private pairing = new Set<string>()

  constructor(private d: WorkerDeps & {
    secrets: Pick<Secrets, 'get' | 'set'>
    profile: (bot: Space) => SharedBotFile
    openExternal: (url: string) => void
    call?: WorkerCall
  }) {}

  private async request(machine: Machine, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = this.d.secrets.get(keyFor(machine.id))
    if (!token) throw new Error('Pair this worker again.')
    const r = await (this.d.call ?? callServer)(machine.url, path, { token, pin: machine.pin, ...(body === undefined ? {} : { method: 'POST', body: { ...(body as object), instance: machine.instance } }) })
    if (r.status !== 200) throw new Error(typeof r.json.error === 'string' ? r.json.error : `Worker answered ${r.status}.`)
    if (path === ENDPOINT && r.json.instance !== machine.instance) throw new Error('This address points to a different worker instance.')
    return r.json
  }

  private machine(raw: unknown): Machine {
    const id = requireId(raw)
    const machine = machinesOf(this.d.db).find((m) => m.id === id)
    if (!machine) throw new Error('That worker is not paired.')
    return machine
  }

  async list(refresh: boolean): Promise<{ workers: WorkerView[]; placements: WorkerPlacement[] }> {
    const workers = await Promise.all(machinesOf(this.d.db).map(async (m): Promise<WorkerView> => {
      const view = { id: m.id, name: m.name, url: m.url }
      if (!refresh) return view
      try {
        const status = await this.request(m, ENDPOINT)
        if (typeof status.capacity !== 'number' || typeof status.active !== 'number') throw new Error('Update SahilBot Server on this worker.')
        return { ...view, online: true, capacity: status.capacity, active: status.active }
      } catch (e) { return { ...view, online: false, error: (e as Error).message } }
    }))
    const placements = Object.values(bindingsOf(this.d.db)).filter((p) => this.d.db.getSpace(p.botId))
      .map(({ botId, workerId, pending }) => ({ botId, workerId, ...(pending ? { pending } : {}) }))
    return { workers, placements }
  }

  async pair(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') throw new Error('Enter the worker details.')
    const { db, secrets } = this.d
    const input = raw as { name?: unknown; url?: unknown; code?: unknown; fingerprint?: unknown }
    const url = normalizeServerUrl(String(input.url ?? ''))
    const name = cleanText(String(input.name ?? '')).text.trim().slice(0, 60)
    const code = String(input.code ?? '').trim()
    const hash = String(input.fingerprint ?? '').replace(/[:\s]/g, '').toUpperCase()
    if (!name || !code || code.length > 40) throw new Error('Enter a worker name and its one-time pairing code.')
    if (hash && (!/^[0-9A-F]{64}$/.test(hash) || !url.startsWith('https://'))) throw new Error('Enter the full SHA-256 fingerprint printed by the HTTPS worker.')
    const pin = hash ? hash.match(/../g)?.join(':') : undefined
    const existing = machinesOf(db).find((m) => m.url === url)
    if (!existing && machinesOf(db).length >= 20) throw new Error('This Mac already has 20 workers.')
    if (this.pairing.has(url)) throw new Error('This worker is already pairing.')
    this.pairing.add(url)
    try {
      const send = this.d.call ?? callServer
      const r = await send(url, '/api/pair', { method: 'POST', pin, body: { name: 'SahilBot Worker Controller', code, mode: 'token' } })
      if (r.status !== 200 || typeof r.json.token !== 'string') throw new Error(String(r.json.error ?? 'The worker did not accept the code.'))
      const status = await send(url, ENDPOINT, { token: r.json.token, pin })
      if (status.status !== 200 || typeof status.json.capacity !== 'number' || typeof status.json.instance !== 'string' || !UUID.test(status.json.instance)) {
        throw new Error('Update SahilBot Server on this worker before pairing it.')
      }
      const instance = status.json.instance
      const machines = machinesOf(db)
      if (existing && existing.instance !== instance) throw new Error('This address was paired to a different worker. Use a different address for this instance.')
      const paired = machines.find((m) => m.instance === instance)
      const id = paired?.id ?? randomUUID()
      secrets.set(keyFor(id), r.json.token)
      db.setSetting(FLEET, [...machines.filter((m) => m.id !== id), { id, name, url, pin, instance } satisfies Machine])
      this.d.changed()
    } finally { this.pairing.delete(url) }
  }

  async capacity(workerId: unknown, slots: unknown): Promise<void> {
    await this.request(this.machine(workerId), `${ENDPOINT}/capacity`, { slots: requireSlots(slots) })
  }

  async assign(rawBot: unknown, rawTarget: unknown): Promise<void> {
    const botId = requireId(rawBot)
    const { db } = this.d
    const bot = db.getSpace(botId)
    if (!bot || bot.isMain || bot.kind !== 'bot') throw new Error('Choose a bot from this Mac.')
    const target = rawTarget === null ? null : this.machine(rawTarget)
    const workerId = target?.id ?? null
    if (this.moves.has(botId)) throw new Error('That bot is already moving.')
    const current = bindingsOf(db)[botId] ?? { botId, workerId: null, revision: 0 }
    if (current.pending && current.pending.workerId !== workerId) throw new Error('Retry the current move before choosing another worker.')
    if (!current.pending && current.workerId === workerId) return
    if (this.d.isBusy(botId)) throw new Error('Stop this bot or wait for it to finish before moving it.')
    const revision = current.pending ? current.revision : current.revision + 1
    const file = target ? this.d.profile(bot) : undefined
    this.moves.add(botId)
    try {
      if (!current.pending && target) {
        const status = await this.request(target, ENDPOINT)
        if (typeof status.capacity !== 'number' || typeof status.active !== 'number') throw new Error('Update SahilBot Server on the destination.')
        if (status.active >= status.capacity) throw new Error('The destination has no free bot slots.')
        if (this.d.isBusy(botId)) throw new Error('This bot started working. Wait for it to finish and retry.')
      }
      db.setSetting(BINDINGS, { ...bindingsOf(db), [botId]: { ...current, revision, pending: { workerId } } })
      this.d.changed()
      if (current.workerId) await this.request(this.machine(current.workerId), `${ENDPOINT}/place`, { id: botId, revision, active: false })
      if (target) await this.request(target, `${ENDPOINT}/place`, { id: botId, revision, active: true, file })
      db.setSetting(BINDINGS, { ...bindingsOf(db), [botId]: { botId, revision, workerId } })
      this.d.changed()
    } finally { this.moves.delete(botId) }
  }

  async open(rawWorker: unknown, rawBot?: unknown): Promise<void> {
    const id = rawBot === undefined ? undefined : requireId(rawBot)
    const worker = rawWorker === null && id ? this.machine(bindingsOf(this.d.db)[id]?.workerId) : this.machine(rawWorker)
    if (id) {
      const p = bindingsOf(this.d.db)[id]
      if (!p || p.pending || p.workerId !== worker.id) throw new Error('Finish moving this bot before opening it on a worker.')
    }
    const r = await this.request(worker, '/api/handoff', {})
    if (typeof r.code !== 'string') throw new Error('The worker did not create an app link.')
    this.d.openExternal(`${worker.url}/pair#code=${encodeURIComponent(r.code)}${id ? `&bot=${id}` : ''}`)
  }
}

export function setupWorkerFleet(d: ConstructorParameters<typeof WorkerFleet>[0]): void {
  const fleet = new WorkerFleet(d)
  const local = (ctx: { transport: string }): void => { if (ctx.transport !== 'electron') throw new Error('Manage workers from the Mac app.') }
  registerHandler('workers:list', (ctx, refresh) => { local(ctx); return fleet.list(refresh === true) })
  registerHandler('workers:pair', (ctx, body) => { local(ctx); return fleet.pair(body) })
  registerHandler('workers:capacity', (ctx, id, slots) => { local(ctx); return fleet.capacity(id, slots) })
  registerHandler('workers:assign', (ctx, id, target) => { local(ctx); return fleet.assign(id, target) })
  registerHandler('workers:open', (ctx, worker, bot) => { local(ctx); return fleet.open(worker, bot) })
}

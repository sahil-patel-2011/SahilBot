import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../../db'
import type { ToolEffect } from '@shared/types'
import type { ToolOutput } from '../types'

export type RunPhase = 'plan' | 'research' | 'execute' | 'verify' | 'write'
export interface TaskPolicy { maxUsd?: number; deadlineAt?: number; maxCalls?: number; parallel?: number; requireVerification?: boolean }
export interface ActionRecord {
  id: string; runId: string; threadId: string; callId: string; tool: string; fingerprint: string; effect: ToolEffect
  status: 'running' | 'done' | 'failed' | 'uncertain'; args: string; output?: ToolOutput; error?: string; at: number
}
export interface RunRecord { id: string; threadId: string; openerId: string; status: string; phase: RunPhase; policy: TaskPolicy; at: number; finishedAt?: number }
type Row = Record<string, unknown>
export const canonical = (v: unknown): string => JSON.stringify(sort(v))
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => !['__proto__', 'constructor', 'prototype'].includes(k)).map((k) => [k, sort((v as Record<string, unknown>)[k])]))
  return v
}
export const digest = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex')
const action = (r: Row): ActionRecord => ({ id: String(r.id), runId: String(r.run_id), threadId: String(r.thread_id), callId: String(r.call_id), tool: String(r.tool), fingerprint: String(r.fingerprint), effect: r.effect as ToolEffect, status: r.status as ActionRecord['status'], args: String(r.args), output: r.output ? JSON.parse(String(r.output)) : undefined, error: r.error ? String(r.error) : undefined, at: Number(r.at) })
const run = (r: Row): RunRecord => ({ id: String(r.id), threadId: String(r.thread_id), openerId: String(r.opener_id), status: String(r.status), phase: r.phase as RunPhase, policy: JSON.parse(String(r.policy)), at: Number(r.at), finishedAt: r.finished_at ? Number(r.finished_at) : undefined })

/** Durable local state, separate from conversation text. Every mutation is recorded before it runs. */
export class RuntimeStore {
  constructor(readonly db: Db, readonly now: () => number = Date.now) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        opener_id TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'plan', policy TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS agent_runs_thread ON agent_runs(thread_id, at DESC);
      CREATE TABLE IF NOT EXISTS agent_actions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, call_id TEXT NOT NULL, tool TEXT NOT NULL,
        fingerprint TEXT NOT NULL, effect TEXT NOT NULL, status TEXT NOT NULL, args TEXT NOT NULL, output TEXT, error TEXT, at INTEGER NOT NULL, finished_at INTEGER,
        UNIQUE(run_id, call_id));
      CREATE INDEX IF NOT EXISTS agent_actions_fingerprint ON agent_actions(thread_id, fingerprint, status);
      CREATE TABLE IF NOT EXISTS agent_evidence (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES agent_actions(id) ON DELETE CASCADE, criterion TEXT NOT NULL, passed INTEGER NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES agent_actions(id) ON DELETE CASCADE, kind TEXT NOT NULL, path TEXT, data TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_recovery (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, signature TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(run_id, signature));
    `)
  }
  recover(): void {
    this.db.sql.exec(`UPDATE agent_actions SET status = CASE WHEN effect = 'read' THEN 'failed' ELSE 'uncertain' END, error = 'Interrupted before its result was committed' WHERE status = 'running';
      UPDATE agent_runs SET status = 'interrupted' WHERE status = 'running';`)
    // A crash can occur after committing an effect but before appending its tool message. Repair
    // only calls actually present in conversation history; nested workflow calls stay in the ledger.
    const records = (this.db.sql.prepare("SELECT a.* FROM agent_actions a JOIN agent_runs r ON r.id=a.run_id WHERE r.status='interrupted' ORDER BY a.rowid").all() as Row[]).map(action)
    const histories = new Map<string, ReturnType<Db['listMessages']>>()
    for (const a of records) {
      const messages = histories.get(a.threadId) ?? this.db.listMessages(a.threadId); histories.set(a.threadId, messages)
      if (!messages.some((m) => m.toolCalls?.some((c) => c.id === a.callId)) || messages.some((m) => m.toolCallId === a.callId)) continue
      const content = a.status === 'done' && a.output ? `<tool_output trust="untrusted">${a.output.text.slice(0, 16000)}</tool_output>` : a.status === 'uncertain' ? `Interrupted: action ${a.id} may already have happened. Reconcile its result before retrying.` : 'Interrupted before a read finished. This read may safely be requested again.'
      const message = this.db.insertMessage({ threadId: a.threadId, role: 'tool', toolCallId: a.callId, toolName: a.tool, content, kind: 'normal', status: 'done', meta: { actionId: a.id, status: a.status === 'done' ? 'ok' : 'error', recovered: true, untrusted: true, data: a.output?.data } })
      messages.push(message)
    }
  }
  start(threadId: string, openerId: string, policy: TaskPolicy = {}): RunRecord {
    const old = this.db.sql.prepare("SELECT * FROM agent_runs WHERE thread_id = ? AND opener_id = ? AND status = 'interrupted' ORDER BY at DESC LIMIT 1").get(threadId, openerId) as Row | undefined
    if (old) { this.db.sql.prepare("UPDATE agent_runs SET status = 'running', finished_at = NULL WHERE id = ?").run(old.id as string); return { ...run(old), status: 'running' } }
    const r: RunRecord = { id: randomUUID(), threadId, openerId, status: 'running', phase: 'plan', policy: cleanPolicy(policy), at: this.now() }
    this.db.sql.prepare('INSERT INTO agent_runs(id,thread_id,opener_id,status,policy,at) VALUES(?,?,?,?,?,?)').run(r.id, threadId, openerId, r.status, JSON.stringify(r.policy), r.at)
    return r
  }
  get(id: string): RunRecord | undefined { const r = this.db.sql.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as Row | undefined; return r ? run(r) : undefined }
  latest(threadId: string): RunRecord | undefined { const r = this.db.sql.prepare('SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(threadId) as Row | undefined; return r ? run(r) : undefined }
  phase(id: string, phase: RunPhase): void { this.db.sql.prepare('UPDATE agent_runs SET phase = ? WHERE id = ?').run(phase, id) }
  configure(id: string, policy: TaskPolicy): void { this.db.sql.prepare('UPDATE agent_runs SET policy=? WHERE id=?').run(JSON.stringify(cleanPolicy(policy)), id) }
  finish(id: string, status: string): void { this.db.sql.prepare('UPDATE agent_runs SET status = ?, finished_at = ? WHERE id = ?').run(status, this.now(), id) }
  actions(runId: string): ActionRecord[] { return (this.db.sql.prepare('SELECT * FROM agent_actions WHERE run_id = ? ORDER BY rowid').all(runId) as Row[]).map(action) }
  getAction(id: string, threadId: string): ActionRecord | undefined { const r = this.db.sql.prepare('SELECT * FROM agent_actions WHERE id = ? AND thread_id = ?').get(id, threadId) as Row | undefined; return r ? action(r) : undefined }
  uncertain(threadId: string): ActionRecord[] { return (this.db.sql.prepare("SELECT * FROM agent_actions WHERE thread_id = ? AND status = 'uncertain' ORDER BY at").all(threadId) as Row[]).map(action) }
  begin(r: RunRecord, callId: string, tool: string, args: unknown, effect: ToolEffect, storedArgs = canonical(args)): { record: ActionRecord; replay?: ToolOutput; blocked?: string } {
    const old = this.db.sql.prepare('SELECT * FROM agent_actions WHERE run_id = ? AND call_id = ?').get(r.id, callId) as Row | undefined
    if (old) {
      const a = action(old)
      if (a.status === 'done' && a.output) return { record: a, replay: a.output }
      if (a.status === 'running' || a.status === 'uncertain') return { record: a, blocked: 'This action may already have happened. Reconcile its result before retrying.' }
    }
    const fingerprint = digest({ tool, args })
    const pending = effect === 'read' ? undefined : this.uncertain(r.threadId).find((a) => a.fingerprint === fingerprint)
    if (pending) return { record: pending, blocked: `Action ${pending.id} has an uncertain outcome. Verify the external state before repeating it.` }
    const id = old ? String(old.id) : randomUUID()
    this.db.sql.prepare(`INSERT INTO agent_actions(id,run_id,thread_id,call_id,tool,fingerprint,effect,status,args,at) VALUES(?,?,?,?,?,?,?,'running',?,?)
      ON CONFLICT(run_id,call_id) DO UPDATE SET status='running', error=NULL, at=excluded.at`).run(id, r.id, r.threadId, callId, tool, fingerprint, effect, storedArgs, this.now())
    return { record: this.getAction(id, r.threadId)! }
  }
  complete(id: string, output: ToolOutput): void { this.db.sql.prepare("UPDATE agent_actions SET status='done', output=?, finished_at=? WHERE id=?").run(JSON.stringify(output), this.now(), id) }
  fail(id: string, error: string, uncertain = false): void { this.db.sql.prepare('UPDATE agent_actions SET status=?, error=?, finished_at=? WHERE id=?').run(uncertain ? 'uncertain' : 'failed', error, this.now(), id) }
  evidence(runId: string, actionId: string | null, criterion: string, passed: boolean, detail: string): string {
    const id = randomUUID(); this.db.sql.prepare('INSERT INTO agent_evidence VALUES(?,?,?,?,?,?,?)').run(id, runId, actionId, criterion.slice(0, 500), passed ? 1 : 0, detail.slice(0, 4000), this.now()); return id
  }
  checks(runId: string): Array<{ criterion: string; passed: boolean; detail: string; actionId: string | null; at: number }> {
    return (this.db.sql.prepare('SELECT * FROM agent_evidence WHERE run_id=? ORDER BY rowid').all(runId) as Row[]).map((r) => ({ criterion: String(r.criterion), passed: !!r.passed, detail: String(r.detail), actionId: r.action_id as string | null, at: Number(r.at) }))
  }
  artifact(runId: string, actionId: string | null, data: unknown, path?: string): string {
    const id = randomUUID(); const text = canonical(data)
    if (text.length > 2_000_000) throw new Error('Artifact exceeds 2 MB; store large data in a file.')
    this.db.sql.prepare('INSERT INTO agent_artifacts VALUES(?,?,?,?,?,?,?,?)').run(id, runId, actionId, path ? 'file' : 'json', path ?? null, text, digest(text), this.now())
    return id
  }
  artifacts(runId: string): Array<{ id: string; path: string | null; hash: string }> { return this.db.sql.prepare('SELECT id,path,hash FROM agent_artifacts WHERE run_id=? ORDER BY at').all(runId) as never }
  readArtifact(id: string, threadId: string): unknown {
    const r = this.db.sql.prepare('SELECT a.data FROM agent_artifacts a JOIN agent_runs r ON r.id=a.run_id WHERE a.id=? AND r.thread_id=?').get(id, threadId) as Row | undefined
    if (!r) throw new Error('Artifact not found in this chat.'); return JSON.parse(String(r.data))
  }
  recoverAttempt(runId: string, signature: string, max = 2): boolean {
    const old = this.db.sql.prepare('SELECT attempts FROM agent_recovery WHERE run_id=? AND signature=?').get(runId, signature) as Row | undefined
    if (Number(old?.attempts ?? 0) >= max) return false
    this.db.sql.prepare('INSERT INTO agent_recovery VALUES(?,?,1) ON CONFLICT(run_id,signature) DO UPDATE SET attempts=attempts+1').run(runId, signature); return true
  }
}

export function cleanPolicy(p: TaskPolicy): TaskPolicy {
  const number = (x: unknown, low: number, high: number): number | undefined => typeof x === 'number' && Number.isFinite(x) && x >= low ? Math.min(high, x) : undefined
  return { maxUsd: number(p.maxUsd, 0, 100_000), deadlineAt: number(p.deadlineAt, 1, 1e15), maxCalls: number(p.maxCalls, 1, 10_000), parallel: number(p.parallel, 1, 16), requireVerification: p.requireVerification === true }
}

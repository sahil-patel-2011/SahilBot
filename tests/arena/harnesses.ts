import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { appRegistry } from '../fixtures/app-tools'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'

// Agent Arena harnesses. Each runs the real thing against the simulated model:
//   sahilbot     SahilBot's agent loop in-process, as shipped (Auto mode, verify pass on, the app's tool set)
//   claude-code  the installed Claude Code CLI (`claude -p`), Edit and Bash allowed (its usual autonomous setup),
//                in a clean config folder with only the arena's model endpoint and a dummy key
//   grok-cli     a Grok CLI when ARENA_GROK_CLI points at one (not installed here: untested)
// A run is the request plus up to two step-ins from the simulated user while the task isn't done.

export interface RunInput { ws: string; prompt: string; simUrl: string; approve: boolean; stepIn: string; isDone: (answer: string) => boolean }
export interface RunOutput { answer: string; interruptions: number; stepIns: number; error?: string }
export interface Harness { id: string; label: string; available: () => string | true; run: (i: RunInput) => Promise<RunOutput> }

const MAX_STEP_INS = 2

// ── SahilBot ───────────────────────────────────────────────────────────────────────────────────────

const model: ModelInfo = { id: 'arena-model', provider: 'ollama', providerName: 'Arena', enabled: true, installed: true, label: 'Arena model', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 200_000, contextTokens: 200_000, fits: true, tools: true } as ModelInfo

export const sahilbot: Harness = {
  id: 'sahilbot', label: 'SahilBot (Auto mode, as shipped)',
  available: () => true,
  async run(i) {
    const db = new Db(':memory:')
    const settings = {
      contextWindow: 200_000, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
      workspaceDir: i.ws, userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [],
      cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
    } as unknown as Settings
    // The app's own tool set (tests/fixtures/app-tools mirrors src/main/index.ts), with this task's folder as the workspace.
    const { registry, results } = appRegistry({ ws: i.ws, results: new ResultStore(mkdtempSync(join(tmpdir(), 'arena-res-'))) })
    const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
    let interruptions = 0
    const space = db.createSpace('Arena', '#000000')
    const thread = db.createThread(space.id, 'auto', model.id)
    const st = db.getState(thread.id); st.workFolder = i.ws; db.setState(thread.id, st)
    let agent!: Agent
    agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: { last, for: () => ({ provider: 'custom', baseUrl: `${i.simUrl}/v1` }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
      spaces: { getPrompt: () => '' } as never,
      memory: { block: () => '' } as never,
      emit: (e: ChatEvent) => {
        // A card still waiting after a second: the user has to answer it (an interruption).
        if (e.type === 'pending') setTimeout(() => { if (agent.pending(thread.id).some((p) => p.id === e.request.id)) { interruptions++; agent.respond(thread.id, e.request.id, e.request.kind === 'approval' ? (i.approve ? 'allow' : 'deny') : i.stepIn) } }, 1000)
      },
      secretValues: () => [],
      fitWindow: (_m: string, w: number) => w,
      counter: () => ({ count: async (t: string) => estimate(t) })
    } as never)
    const answer = (): string => db.listMessages(thread.id).filter((m) => m.role === 'assistant' && !m.meta?.superseded).at(-1)?.content ?? ''
    try {
      await (await agent.send({ threadId: thread.id, text: i.prompt })).done
      let stepIns = 0
      while (!i.isDone(answer()) && stepIns < MAX_STEP_INS) { stepIns++; await (await agent.send({ threadId: thread.id, text: i.stepIn })).done }
      return { answer: answer(), interruptions, stepIns }
    } catch (e) {
      return { answer: answer(), interruptions, stepIns: 0, error: (e as Error).message }
    }
  }
}

// ── Claude Code ────────────────────────────────────────────────────────────────────────────────────

const claudeBin = (): string | undefined => { try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined } }

function cli(bin: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs = 300_000): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((ok) => {
    const p = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.on('close', (code) => { clearTimeout(t); ok({ out, err, code }) })
  })
}

export const claudeCode: Harness = {
  id: 'claude-code', label: 'Claude Code CLI (Edit + Bash allowed)',
  available: () => (claudeBin() ? true : 'claude CLI not found'),
  async run(i) {
    const bin = claudeBin()!
    const home = mkdtempSync(join(tmpdir(), 'arena-cc-home-'))
    // Only what a fresh install has, the arena's endpoint and a dummy key: no account, no settings, no telemetry.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TERM: 'dumb',
      ANTHROPIC_BASE_URL: i.simUrl, ANTHROPIC_API_KEY: 'sk-arena-not-a-real-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'
    }
    const flags = ['--output-format', 'json', '--model', 'claude-sonnet-4-5', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read Write Edit Bash Glob Grep']
    let session = ''
    let answer = ''
    const once = async (args: string[]): Promise<string | undefined> => {
      const r = await cli(bin, [...args, ...flags], env, i.ws)
      try {
        const j = JSON.parse(r.out.trim().split('\n').pop() ?? '{}') as { result?: string; session_id?: string; is_error?: boolean }
        session = j.session_id ?? session
        answer = j.result ?? answer
        return j.is_error ? (j.result ?? 'error') : undefined
      } catch { return `no JSON from claude (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}` }
    }
    let error = await once(['-p', i.prompt])
    let stepIns = 0
    while (!error && !i.isDone(answer) && stepIns < MAX_STEP_INS && session) { stepIns++; error = await once(['-p', i.stepIn, '--resume', session]) }
    return { answer, interruptions: 0, stepIns, ...(error ? { error } : {}) }
  }
}

// ── Grok CLI (optional) ───────────────────────────────────────────────────────────────────────────

export const grokCli: Harness = {
  id: 'grok-cli', label: 'Grok CLI (ARENA_GROK_CLI)',
  available: () => (process.env.ARENA_GROK_CLI && existsSync(process.env.ARENA_GROK_CLI) ? true : 'set ARENA_GROK_CLI to a Grok CLI binary'),
  async run(i) {
    const home = mkdtempSync(join(tmpdir(), 'arena-grok-home-'))
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'dumb', GROK_API_KEY: 'arena-not-a-real-key', GROK_BASE_URL: `${i.simUrl}/v1` }
    const r = await cli(process.env.ARENA_GROK_CLI!, ['--prompt', i.prompt, '--directory', i.ws, '--base-url', `${i.simUrl}/v1`, '--api-key', 'arena-not-a-real-key', '--model', 'grok-4'], env, i.ws)
    return { answer: r.out.trim().split('\n').slice(-5).join('\n'), interruptions: 0, stepIns: 0, ...(r.code ? { error: r.err.slice(0, 300) } : {}) }
  }
}

export const HARNESSES: Harness[] = [sahilbot, claudeCode, grokCli]

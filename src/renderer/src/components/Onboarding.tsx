import { useEffect, useRef, useState } from 'react'
import type { ProviderId, Settings } from '@shared/types'
import { api } from '../api'
import { Mascot } from '../brand'
import * as I from '../icons'
import { ChatgptPlanSettings } from './ChatgptPlanSettings'
import '../styles-attachments.css'

type Pick = Awaited<ReturnType<typeof api.models.setupPicks>>[number]

/**
 * First run, cloud first, two short steps: your name; then connect Claude, OpenAI or Grok with an API key,
 * or your ChatGPT plan (Codex), with one question, "Also use free local models on this Mac?" (Not now is
 * the default), and where files go (one line, changeable). Only a yes runs the local setup (Ollama, model
 * downloads) as one extra step. Importing what another AI knows is an optional link that opens after setup.
 */
const SETUP_TEXT: Record<string, string> = {
  download: 'Downloading Ollama…',
  verify: 'Checking it with Apple\'s security check…',
  install: 'Installing…',
  start: 'Starting Ollama in the background…',
  done: 'Ollama is ready.'
}

type CloudId = Extract<ProviderId, 'anthropic' | 'openai' | 'xai'>
const CLOUD: Array<{ id: CloudId; title: string; url: string; placeholder: string; sub: string; testId: string }> = [
  { id: 'anthropic', title: 'Connect Claude (API key)', url: 'https://api.anthropic.com/v1', placeholder: 'sk-ant-…', sub: 'The strongest models for agent work, coding and writing.', testId: 'onboarding-key' },
  { id: 'openai', title: 'Connect OpenAI (API key)', url: 'https://api.openai.com/v1', placeholder: 'sk-…', sub: 'GPT models: math, search-heavy research, long documents. Also voices and images.', testId: 'onboarding-key-openai' },
  { id: 'xai', title: 'Connect Grok (API key)', url: 'https://api.x.ai/v1', placeholder: 'xai-…', sub: 'xAI\'s Grok models.', testId: 'onboarding-key-xai' }
]

/** Why a key check failed, in words: a refused key, no connection, or the provider's own message. */
function keyProblem(title: string, error?: string): string {
  const e = error ?? ''
  const who = title.replace(/^Connect | \(API key\)$/g, '')
  if (!e || /\b(401|403)\b|invalid|unauthori[sz]ed|authentication|permission|incorrect api key/i.test(e)) return 'That key was rejected. Check that you copied all of it.'
  if (/fetch failed|connection|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed? ?out|abort/i.test(e)) return `Couldn't reach ${who}. Check your internet connection, then press Check.`
  return `${who} didn't accept the check: ${e.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 140)}`
}

function CloudKey({ c, saved, onSaved }: { c: typeof CLOUD[number]; saved: boolean; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(saved ? { ok: true, text: 'Connected' } : null)
  // Enter and then leaving the box both check: only one check (and one save) at a time.
  const busy = useRef(false)
  const check = async (): Promise<void> => {
    if (!key || busy.current) return
    busy.current = true
    try { await checkNow() } finally { busy.current = false }
  }
  const checkNow = async (): Promise<void> => {
    setMsg({ ok: true, text: 'Checking…' })
    const r = await api.models.test(c.url, key).catch((e: Error) => ({ ok: false, count: 0, error: e.message }))
    if (!r.ok) { setMsg({ ok: false, text: keyProblem(c.title, r.error) }); return }
    // Saving can fail (e.g. the Keychain is locked): say so here rather than leave an unhandled rejection.
    const saved = await api.settings.set({ setKeys: { [c.id]: key } }).then(() => '', (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    if (saved) { setMsg({ ok: false, text: `Couldn't save the key: ${saved}` }); return }
    setKey('')
    setMsg({ ok: true, text: `Connected · ${r.count} models` })
    onSaved()
  }
  return (
    <div className={`connect-row${msg?.ok && msg.text !== 'Checking…' ? ' ok' : ''}`} data-testid={`onboarding-connect-${c.id}`}>
      <div className="connect-text"><b>{c.title}</b><div className="hint">{c.sub}</div></div>
      <div className="key-edit">
        <input className="set-input" type="password" value={key} placeholder={c.placeholder} autoComplete="off"
          onChange={(e) => { setKey(e.target.value.trim()); setMsg(null) }} onBlur={() => void check()} onKeyDown={(e) => e.key === 'Enter' && void check()} data-testid={c.testId} />
        {key && <button className="btn" onClick={() => void check()}>Check</button>}
        {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`}>{msg.ok && msg.text !== 'Checking…' ? <I.Check size={13} /> : null} {msg.text}</span>}
      </div>
    </div>
  )
}

/** The local setup (only after the user said yes): Ollama, then the models picked for this Mac. */
function LocalSetup() {
  const [found, setFound] = useState<Array<{ id: string; name: string; models: number; best: string | null }> | null>(null)
  const [picks, setPicks] = useState<Pick[] | null>(null)
  const [pull, setPull] = useState<Record<string, { pct: number; status: string; error?: string; done?: boolean }>>({})
  const [ram, setRam] = useState<number | null>(null)
  const [setup, setSetup] = useState<{ phase: string; pct?: number; error?: string } | null>(null)
  const picksRef = useRef<Pick[] | null>(null)
  picksRef.current = picks

  const detect = (): void => {
    setFound(null)
    void Promise.all([api.detectProviders(), api.models.setupPicks(), api.system.info()]).then(([f, p, sys]) => { setFound(f); setPicks(p); setRam(sys.totalGB) })
  }
  useEffect(detect, [])
  // One-click setup: when Ollama is up, the best model for this Mac starts downloading right away.
  useEffect(() => api.ollama.onSetup((e) => {
    setSetup(e)
    if (e.phase !== 'done') return
    detect()
    const best = picksRef.current?.find((p) => !p.installed)
    if (best) { setPull((x) => ({ ...x, [best.pull]: { pct: 0, status: 'starting' } })); void api.models.pull(best.pull) }
  }), [])
  useEffect(() => api.models.onPull((e) => {
    setPull((p) => ({ ...p, [e.tag]: { pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : p[e.tag]?.pct ?? 0, status: e.status, error: e.error, done: e.done && !e.error } }))
  }), [])

  const ollama = found?.some((f) => f.id === 'ollama')
  const lmstudio = found?.find((f) => f.id === 'lmstudio')
  return (
    <div data-testid="local-setup">
      <p className="hint">These run privately on this Mac{ram ? ` (${ram} GB)` : ''}, free. They're picked to fit your memory. Download now or later in Settings → Models.</p>
      {found === null ? <div className="hint">Looking for model apps on this Mac…</div> : ollama ? (
        <div className="setup-pick-list" data-testid="setup-picks">
          {(picks ?? []).map((p) => {
            const pr = pull[p.pull]
            const done = p.installed || pr?.done
            const busy = pr && !pr.error && !pr.done
            return (
              <div className="setup-pick" key={p.pull}>
                <div className="setup-pick-text">
                  <div className="setup-pick-role">{p.role}</div>
                  <b>{p.label}</b> <span className="hint">· {p.sizeGB} GB</span>
                  <div className="hint">{p.blurb}</div>
                  {busy && <div className="meter" style={{ width: '100%', marginTop: 6 }}><i style={{ width: `${pr.pct}%` }} /></div>}
                  {pr?.error && <div className="hint" style={{ color: 'var(--danger)' }}>{pr.error}</div>}
                </div>
                {done ? <span className="conn ok"><I.Check size={14} /> Ready</span>
                  : busy ? <span className="hint">{pr.pct ? `${pr.pct}%` : 'Starting…'}</span>
                    : <button className="btn" onClick={() => { setPull((x) => ({ ...x, [p.pull]: { pct: 0, status: 'starting' } })); void api.models.pull(p.pull) }} data-testid={`setup-get-${p.pull}`}>Download</button>}
              </div>
            )
          })}
          {picks?.length === 0 && <div className="hint">This Mac doesn't have enough memory for the recommended local models. Your cloud models still work.</div>}
        </div>
      ) : (
        <div className="setup-pick install-ollama" data-testid="ollama-setup">
          <div className="setup-pick-text">
            <b>Set up local models</b>
            <div className="hint">{setup ? SETUP_TEXT[setup.phase] ?? '' : `SahilBot installs Ollama (free, about 230 MB, no password needed), starts it, and downloads the best model for this Mac.${lmstudio ? ` LM Studio is running with ${lmstudio.models} models; SahilBot uses those too.` : ''}`}</div>
            {setup?.phase === 'download' && <div className="meter" style={{ width: '100%', marginTop: 6 }}><i style={{ width: `${setup.pct ?? 0}%` }} /></div>}
            {setup?.error && <div className="hint" style={{ color: 'var(--danger)' }}>{setup.error}</div>}
          </div>
          <div className="key-edit">
            {setup && !setup.error && setup.phase !== 'done'
              ? <span className="hint">{setup.phase === 'download' && setup.pct ? `${setup.pct}%` : <span className="spin" />}</span>
              : <button className="btn primary" onClick={() => { setSetup({ phase: 'download', pct: 0 }); void api.ollama.setup() }} data-testid="ollama-setup-go">{setup?.error ? 'Try again' : 'Set up for me'}</button>}
            <button className="btn" onClick={detect} title="Already installed Ollama or LM Studio yourself?">Check again</button>
          </div>
        </div>
      )}
      {lmstudio && ollama && <div className="found-banner"><I.Check size={15} /> LM Studio is running with {lmstudio.models} models; they're available too.</div>}
    </div>
  )
}

export function Onboarding({ settings, onDone }: { settings: Settings; onDone: (s: Settings) => void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.userName)
  const [workspace, setWorkspace] = useState(settings.workspaceDir)
  const [keys, setKeys] = useState(settings.keys)
  const [plan, setPlan] = useState(false)
  // "Also use free local models on this Mac?" Not now is the default.
  const [wantLocal, setWantLocal] = useState(false)
  const refreshKeys = (): void => { void api.settings.get().then((s) => setKeys(s.keys)).catch(() => undefined) }

  /** After setup: open "Import memory" (the optional link on the connect step). */
  const [importAfter, setImportAfter] = useState(false)
  const finish = async (importNow = importAfter): Promise<void> => {
    const s = await api.settings.set({ userName: name.trim(), workspaceDir: workspace, onboarded: true, defaultModel: 'auto', local: { enabled: wantLocal } })
    onDone(s)
    if (importNow) window.dispatchEvent(new Event('sahilbot:import-memory'))
  }
  const next = async (): Promise<void> => {
    // Saved right away, so a yes can run the local setup (downloads need local models on).
    await api.local.set(wantLocal)
    if (wantLocal) setStep(1.5)
    else await finish()
  }
  const pickWorkspace = async (): Promise<void> => { const f = await api.pickFolder().catch(() => null); if (f) setWorkspace(f) }
  const connected = CLOUD.filter((c) => keys[c.id]).length

  return (
    <div className="scrim onboarding">
      <div className="modal onboard-card" data-testid="onboarding">
        <div className="onboard-steps" aria-hidden>{(wantLocal ? [0, 1, 1.5] : [0, 1]).map((i) => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><Mascot size={64} /></div>
        {step === 0 && (
          <>
            <h2 style={{ textAlign: 'center' }}>Welcome to SahilBot</h2>
            <p className="hint" style={{ textAlign: 'center' }}>An assistant that works on your Mac: it chats, researches, uses your apps and gets real work done. Your chats, files, memory and passwords stay here.</p>
            <div className="field"><label>What should I call you?</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" onKeyDown={(e) => e.key === 'Enter' && setStep(1)} data-testid="onboarding-name" /></div>
            <div className="modal-actions"><button className="btn primary" onClick={() => setStep(1)} data-testid="onboarding-name-next">Continue</button></div>
            <div className="hint onboard-time">Two steps, about a minute.</div>
          </>
        )}
        {step === 1 && (
          <>
            <h2>Connect your AI</h2>
            <p className="hint">Paste one key (press Enter to check it). Keys stay in your Mac's Keychain; spending is capped at $200 a month until you change it.</p>
            <div className="onboard-connect" data-testid="onboarding-cloud">
              {CLOUD.map((c) => <CloudKey key={c.id} c={c} saved={!!keys[c.id]} onSaved={refreshKeys} />)}
              <div className="connect-row" data-testid="onboarding-connect-chatgpt">
                <div className="connect-text"><b>Use my ChatGPT plan (Codex)</b><div className="hint">Your ChatGPT subscription through OpenAI's Codex app, within your plan's limits. No API charges.</div></div>
                {!plan && <button className="btn" onClick={() => setPlan(true)} data-testid="onboarding-chatgpt-plan">Set up</button>}
              </div>
              {plan && <ChatgptPlanSettings embedded />}
            </div>
            <div className="onboard-local" data-testid="onboarding-local">
              <b>Also use free local models on this Mac?</b> <span className="hint">(optional, downloads ~5–20 GB)</span>
              <div className="hint">Private and free, but slower and less capable than the cloud models. You can turn this on later in Settings → Models.</div>
              <div className="choices" role="radiogroup" aria-label="Local models">
                <button className={`btn${!wantLocal ? ' primary' : ''}`} role="radio" aria-checked={!wantLocal} onClick={() => setWantLocal(false)} data-testid="onboarding-local-no">Not now</button>
                <button className={`btn${wantLocal ? ' primary' : ''}`} role="radio" aria-checked={wantLocal} onClick={() => setWantLocal(true)} data-testid="onboarding-local-yes">Yes, set them up</button>
              </div>
            </div>
            <div className="onboard-workspace" data-testid="onboarding-workspace">
              <I.Folder size={14} /><span>Files SahilBot makes go to <b title={workspace}>{workspace.replace(/^\/Users\/[^/]+/, '~')}</b></span>
              <button className="link-btn" onClick={() => void pickWorkspace()} data-testid="onboarding-workspace-change">Change…</button>
            </div>
            {connected === 0 && !plan && !wantLocal && <div className="hint onboard-nokey" data-testid="onboarding-no-key">No AI connected yet. You can start anyway and add a key later: SahilBot shows where when you send your first message.</div>}
            <label className="onboard-import"><input type="checkbox" checked={importAfter} onChange={(e) => setImportAfter(e.target.checked)} data-testid="onboarding-import" /> Afterwards, bring in what ChatGPT, Claude or Gemini already knows about me (you review it first)</label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(0)}>Back</button>
              <button className="btn primary" onClick={() => void next()} data-testid="onboarding-next">{wantLocal ? 'Continue' : 'Start using SahilBot'}</button>
            </div>
          </>
        )}
        {step === 1.5 && (
          <>
            <h2>Local models</h2>
            <LocalSetup />
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" onClick={() => void finish()} data-testid="onboarding-local-next">Start using SahilBot</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

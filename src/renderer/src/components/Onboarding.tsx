import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import { api } from '../api'
import { Mascot } from '../brand'
import * as I from '../icons'

type Pick = Awaited<ReturnType<typeof api.models.setupPicks>>[number]

/**
 * First run: your name, the three best models for this Mac (one click each), an optional cloud key,
 * and the workspace folder. Anything already running (Ollama, LM Studio) is found automatically.
 */
const SETUP_TEXT: Record<string, string> = {
  download: 'Downloading Ollama…',
  verify: 'Checking it with Apple\'s security check…',
  install: 'Installing…',
  start: 'Starting Ollama in the background…',
  done: 'Ollama is ready.'
}

export function Onboarding({ settings, onDone }: { settings: Settings; onDone: (s: Settings) => void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.userName)
  const [workspace, setWorkspace] = useState(settings.workspaceDir)
  const [found, setFound] = useState<Array<{ id: string; name: string; models: number; best: string | null }> | null>(null)
  const [picks, setPicks] = useState<Pick[] | null>(null)
  const [pull, setPull] = useState<Record<string, { pct: number; status: string; error?: string; done?: boolean }>>({})
  const [key, setKey] = useState('')
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null)
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
  const testKey = async (): Promise<void> => {
    if (!key) return
    setKeyMsg({ ok: true, text: 'Checking…' })
    const r = await api.models.test('https://api.anthropic.com/v1', key)
    setKeyMsg(r.ok ? { ok: true, text: `Works · ${r.count} Claude models` } : { ok: false, text: 'That key was rejected.' })
  }

  const finish = async (): Promise<void> => {
    const s = await api.settings.set({
      userName: name.trim(), workspaceDir: workspace, onboarded: true, defaultModel: 'auto',
      ...(key && keyMsg?.ok ? { setKeys: { anthropic: key } } : {})
    })
    onDone(s)
  }

  return (
    <div className="scrim onboarding">
      <div className="modal onboard-card" data-testid="onboarding">
        <div className="onboard-steps">{[0, 1, 2].map((i) => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><Mascot size={64} /></div>
        {step === 0 && (
          <>
            <h2 style={{ textAlign: 'center' }}>Welcome to SahilBot</h2>
            <p className="hint" style={{ textAlign: 'center' }}>An assistant that works on your Mac: it chats, researches, uses your apps and gets real work done. Your chats, files, memory and passwords stay here.</p>
            <div className="field"><label>What should I call you?</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" onKeyDown={(e) => e.key === 'Enter' && setStep(1)} data-testid="onboarding-name" /></div>
            <div className="modal-actions"><button className="btn primary" onClick={() => setStep(1)}>Continue</button></div>
          </>
        )}
        {step === 1 && (
          <>
            <h2>Get your models</h2>
            <p className="hint">These run privately on this Mac{ram ? ` (${ram} GB)` : ''}, free. They're picked to fit your memory: bigger ones that wouldn't run well aren't offered. Download now or later in Settings → Models.</p>
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
                {picks?.length === 0 && <div className="hint">This Mac doesn't have enough memory for the recommended local models. Use a cloud key below.</div>}
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
            {found !== null && !ollama && (picks ?? []).length > 0 && (
              <div className="setup-pick-list later" data-testid="setup-picks-later">
                <div className="hint">Then you'll get, picked for this Mac:</div>
                {(picks ?? []).map((p) => (
                  <div className="setup-pick" key={p.pull}>
                    <div className="setup-pick-text"><div className="setup-pick-role">{p.role}</div><b>{p.label}</b> <span className="hint">· {p.sizeGB} GB</span><div className="hint">{p.blurb}</div></div>
                  </div>
                ))}
              </div>
            )}
            {lmstudio && ollama && <div className="found-banner"><I.Check size={15} /> LM Studio is running with {lmstudio.models} models; they're available too.</div>}
            <div className="onboard-cloud">
              <div><b>Claude (optional)</b> <span className="hint">Add an Anthropic API key for the strongest models, or so your local model can ask Claude for help when it's stuck. Spending is capped (default $200 a month) and you can turn cloud off anytime.</span></div>
              <div className="key-edit" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                <input className="set-input" type="password" value={key} placeholder="sk-ant-…" autoComplete="off" onChange={(e) => { setKey(e.target.value.trim()); setKeyMsg(null) }} onBlur={() => void testKey()} data-testid="onboarding-key" />
                {key && <button className="btn" onClick={() => void testKey()}>Check</button>}
                {keyMsg && <span className={`conn ${keyMsg.ok ? 'ok' : 'bad'}`}>{keyMsg.text}</span>}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(0)}>Back</button>
              <button className="btn primary" onClick={() => setStep(2)} data-testid="onboarding-next">Continue</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>Your workspace</h2>
            <p className="hint">SahilBot saves the files it makes here. You can also attach any folder to a chat with the + button, or make a Project for one.</p>
            <div className="field"><label>Folder</label><input value={workspace} onChange={(e) => setWorkspace(e.target.value)} /></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" onClick={() => void finish()} data-testid="onboarding-finish">Start using SahilBot</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

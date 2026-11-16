import { useEffect, useState } from 'react'
import type { BotMaxSettings, BotShape, BotTemplate, ModelList, Space } from '@shared/types'
import { api } from '../api'
import { COLORS, SHAPES, SpaceAvatar } from '../brand'
import * as I from '../icons'
import { importBot } from './BotShare'
import { Disclosure } from './ui'
import { nameFromJob } from '../lib/ux'


/**
 * Customize a bot (name, look, Max, instructions) or a group chat (name, members). A bot's model and thinking
 * aren't set here: it chooses them by itself for each request (Auto), for the best result.
 */
export function BotEditor({ space, spaces, models, mode, onClose, onSaved }: {
  space: Space | null
  spaces: Space[]
  models: ModelList | null
  mode: 'bot' | 'group' | 'project'
  onClose: () => void
  /** `suggestion`: a first message to put in the new bot's chat box (its job), ready to send. */
  onSaved: (spaceId: string, threadId?: string, suggestion?: string) => void
}) {
  const [name, setName] = useState(space?.name ?? '')
  const [color, setColor] = useState(space?.color ?? COLORS[3])
  const [shape, setShape] = useState<BotShape>(space?.shape ?? 'pebble')
  const [prompt, setPrompt] = useState('')
  const [members, setMembers] = useState<string[]>(space?.members ?? [])
  const [path, setPath] = useState('')
  const [folder, setFolder] = useState<string | null>(space?.folder ?? null)
  const [err, setErr] = useState('')
  /** A new bot's job, in a sentence: becomes its instructions and its first message. */
  const [job, setJob] = useState('')
  const [templates, setTemplates] = useState<BotTemplate[]>([])
  const [adding, setAdding] = useState<string | null>(null)
  const isNewBot = !space && mode === 'bot'
  useEffect(() => { if (isNewBot) void api.templates.list().then(setTemplates).catch(() => undefined) }, [isNewBot])
  const addTemplate = async (t: BotTemplate): Promise<void> => {
    setErr('')
    setAdding(t.id)
    try { const r = await api.templates.add(t.id); onSaved(r.spaceId, r.threadId); onClose() } catch (e) { setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } finally { setAdding(null) }
  }
  // Max (bots): Off / Auto / Always and Max helpers; saved with the rest. (Older installs: the Swarm setting.)
  const [maxCfg, setMaxCfg] = useState<Partial<BotMaxSettings>>({})
  const [maxAll, setMaxAll] = useState<Record<string, Partial<BotMaxSettings>>>({})
  useEffect(() => { void api.settings.get().then((x) => { setMaxAll(x.botMax ?? {}); if (space) setMaxCfg({ ...x.botSwarm?.[space.id], ...x.botMax?.[space.id] }) }) }, [space])
  const saveMax = async (id: string): Promise<void> => {
    if (!Object.keys(maxCfg).length) return
    await api.settings.set({ botMax: { ...maxAll, [id]: { ...maxAll[id], ...maxCfg } } })
    window.dispatchEvent(new Event('sahilbot:settings-changed'))
  }
  const bots = spaces.filter((s) => s.kind === 'bot')

  useEffect(() => {
    if (!space || space.kind === 'group') return
    void api.spaces.getPrompt(space.id).then(setPrompt)
    void api.spaces.promptPath(space.id).then(setPath)
  }, [space])

  useEffect(() => {
    // preventDefault: this Esc is spent closing this (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const save = async (): Promise<void> => {
    setErr('')
    try {
      if (space) {
        await api.spaces.update(space.id, { name: name.trim() || space.name, color, shape, ...(mode === 'group' ? { members } : {}) })
        if (mode !== 'group') await api.spaces.setPrompt(space.id, prompt)
        if (mode === 'bot') await saveMax(space.id)
        onSaved(space.id)
      } else {
        if (mode === 'project' && !folder) throw new Error('Choose the project folder.')
        const task = job.replace(/\s+/g, ' ').trim()
        const r = await api.spaces.create({ name: name.trim() || (task ? nameFromJob(task) : undefined), color, shape, kind: mode, members, intro: mode === 'bot' && !prompt.trim() && !task, folder: folder ?? undefined })
        // The job goes into its instructions (with anything typed there) and, ready to send, into its chat box.
        const instructions = [task ? `Your job: ${task}` : '', prompt.trim()].filter(Boolean).join('\n\n')
        if (mode !== 'group' && instructions) await api.spaces.setPrompt(r.space.id, instructions)
        if (mode === 'bot') await saveMax(r.space.id)
        onSaved(r.space.id, r.threadId, task || undefined)
      }
      onClose()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const isGroup = mode === 'group'
  const isProject = mode === 'project'
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-testid="bot-editor">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 6 }}>
          {isProject ? <span className="project-icon" style={{ background: color, width: 64, height: 64 }}><I.Folder size={28} /></span> : <SpaceAvatar color={color} shape={shape} size={64} group={isGroup ? members.map((id) => spaces.find((s) => s.id === id)?.color ?? '#999') : undefined} />}
          <div>
            <h2>{space ? `Customize ${isGroup ? 'group' : isProject ? 'project' : space.isMain ? 'SahilBot' : 'bot'}` : isGroup ? 'New group chat' : isProject ? 'New project' : 'New bot'}</h2>
            <div className="hint">{isGroup ? 'Bots in a group answer together and can hand work to each other with @Name.' : isProject ? 'A project is a folder plus instructions. Every chat in it can read and edit that folder.' : isNewBot ? 'A teammate with its own job and chat. It works on its own and can run on a schedule.' : 'Each bot has its own personality, look and conversation, and shares your memory.'}</div>
          </div>
        </div>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isGroup ? 'e.g. Launch team' : isNewBot ? 'e.g. Competitor Watch (optional)' : 'e.g. Research Bot'} disabled={space?.isMain} data-testid="bot-name" /></div>
        {isProject && (
          <>
            <div className="field"><label>Folder</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder ?? 'No folder chosen'}</span>
                {!space && <button className="btn" onClick={() => void api.pickFolder().then((f) => f && setFolder(f))} data-testid="project-folder">Choose…</button>}
              </div>
            </div>
            <div className="field"><label>Color</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{COLORS.map((c) => (
                <button key={c} className="swatch" onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} title={c} style={{ width: 22, height: 22, borderRadius: 7, background: c, outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
              ))}</div>
            </div>
            <h3>Instructions</h3>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What is this project? Goals, audience, tone, files that matter, things to avoid…" data-testid="project-instructions" />
          </>
        )}
        {!isGroup && !isProject && (() => {
          const look = (
            <div className="field"><label>Look</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>{SHAPES.map((sh) => (
                  <button key={sh} className={`shape-pick${sh === shape ? ' on' : ''}`} onClick={() => setShape(sh)} title={sh} aria-label={`Shape ${sh}`} aria-pressed={sh === shape}><SpaceAvatar color={color} shape={sh} size={34} /></button>
                ))}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{COLORS.map((c) => (
                  <button key={c} className="swatch" onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} title={c} style={{ width: 22, height: 22, borderRadius: 7, background: c, outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
                ))}</div>
              </div>
            </div>
          )
          const max = (
            <div className="field"><label>Max</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={maxCfg.mode ?? 'auto'} onChange={(e) => setMaxCfg((x) => ({ ...x, mode: e.target.value as BotMaxSettings['mode'] }))} data-testid="editor-max-mode" aria-label="Max">
                  <option value="off">Off</option>
                  <option value="auto">Auto: the bot decides</option>
                  <option value="always">Always</option>
                </select>
                {(maxCfg.mode ?? 'auto') !== 'off' && (
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Max helpers
                    <input type="number" min={1} max={50} value={maxCfg.maxHelpers ?? 20} style={{ width: 64 }} data-testid="editor-max-helpers"
                      onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) setMaxCfg((x) => ({ ...x, maxHelpers: Math.min(50, Math.max(1, n)) })) }} />
                  </label>
                )}
              </div>
            </div>
          )
          const instructions = (
            <>
              <h3>{isNewBot ? 'Personality and extra instructions' : 'Personality and instructions'}</h3>
              <div className="hint" style={{ marginBottom: 6 }}>
                {space ? <span title={path}>Saved as a plain file ({path.split('/').pop()}) next to the bot's other files.</span> : 'Optional: how it should talk, what to focus on, what to avoid.'}
              </div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Who is this bot? What should it focus on, and how should it talk?" data-testid="bot-instructions" />
            </>
          )
          if (!isNewBot) return <>{look}{max}<div className="hint bot-auto-note" data-testid="editor-auto-model"><I.Sparkle size={12} /> This bot picks its own model and thinking for each request, for the best result.</div>{instructions}</>
          return (
            <>
              <div className="field"><label htmlFor="bot-job">What's its job?</label>
                <textarea id="bot-job" className="bot-job" rows={2} value={job} onChange={(e) => setJob(e.target.value)} placeholder="e.g. Track my competitors weekly and tell me what changed"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save() } }} data-testid="bot-job" />
              </div>
              <div className="hint bot-auto-note" data-testid="editor-auto-model"><I.Sparkle size={12} /> It opens in its own chat with this job ready to send. Leave it empty and the bot introduces itself.</div>
              <Disclosure title="Look, Max and instructions" sub="Optional" testId="bot-editor-more">{look}{max}{instructions}</Disclosure>
              {templates.length > 0 && (
                <div className="be-templates" data-testid="bot-templates-list">
                  <div className="be-templates-head"><span>Or start from a template</span><button className="link-btn" onClick={() => void importBot(onClose)} data-testid="template-import">Import from file…</button></div>
                  <div className="be-template-grid">
                    {templates.map((t) => (
                      <button key={t.id} className="be-template" disabled={!!adding} onClick={() => void addTemplate(t)} data-testid={`template-${t.id}`} title={t.description}>
                        <SpaceAvatar color={t.color} shape={t.shape} size={30} />
                        <span className="be-template-text"><b>{adding === t.id ? 'Adding…' : t.name}</b><span>{t.description}</span></span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        })()}
        {isGroup && (
          <>
            <h3>Members</h3>
            {bots.length === 0 && <div className="hint">Create some bots first.</div>}
            <div className="member-list">
              {bots.map((b) => (
                <label key={b.id} className="member">
                  <input type="checkbox" checked={members.includes(b.id)} onChange={(e) => setMembers((ms) => e.target.checked ? [...ms, b.id] : ms.filter((x) => x !== b.id))} />
                  <SpaceAvatar color={b.color} shape={b.shape} size={28} />{b.name}
                </label>
              ))}
            </div>
          </>
        )}
        {err && <div className="hint error" style={{ marginTop: 8 }}>{err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={isGroup && members.length === 0} data-testid="bot-save">{space ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

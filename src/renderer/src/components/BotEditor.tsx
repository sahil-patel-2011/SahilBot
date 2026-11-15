import { useEffect, useState } from 'react'
import type { BotShape, BotSwarmSettings, EffortChoice, ModelList, Space } from '@shared/types'
import { api } from '../api'
import { COLORS, SHAPES, SpaceAvatar } from '../brand'
import * as I from '../icons'
import { pickerModels } from '@shared/model-picker'

/** Customize a bot (name, look, instructions, model) or a group chat (name, members). */
export function BotEditor({ space, spaces, models, mode, onClose, onSaved }: {
  space: Space | null
  spaces: Space[]
  models: ModelList | null
  mode: 'bot' | 'group' | 'project'
  onClose: () => void
  onSaved: (spaceId: string, threadId?: string) => void
}) {
  const [name, setName] = useState(space?.name ?? '')
  const [color, setColor] = useState(space?.color ?? COLORS[3])
  const [shape, setShape] = useState<BotShape>(space?.shape ?? 'pebble')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>(space?.model ?? '')
  /** '' = the app default; 'auto' or a level overrides it for this bot's chats. */
  const [effort, setEffort] = useState<EffortChoice | ''>(space?.effort ?? '')
  const [members, setMembers] = useState<string[]>(space?.members ?? [])
  const [path, setPath] = useState('')
  const [folder, setFolder] = useState<string | null>(space?.folder ?? null)
  const [err, setErr] = useState('')
  // Swarm (bots): Off / Auto / Always and Max helpers; saved with the rest.
  const [swarm, setSwarm] = useState<Partial<BotSwarmSettings>>({})
  const [swarmAll, setSwarmAll] = useState<Record<string, Partial<BotSwarmSettings>>>({})
  useEffect(() => { void api.settings.get().then((x) => { setSwarmAll(x.botSwarm ?? {}); if (space) setSwarm(x.botSwarm?.[space.id] ?? {}) }) }, [space])
  const saveSwarm = async (id: string): Promise<void> => {
    if (!Object.keys(swarm).length) return
    await api.settings.set({ botSwarm: { ...swarmAll, [id]: { ...swarmAll[id], ...swarm } } })
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
        await api.spaces.update(space.id, { name: name.trim() || space.name, color, shape, model: model || null, effort: effort || null, ...(mode === 'group' ? { members } : {}) })
        if (mode !== 'group') await api.spaces.setPrompt(space.id, prompt)
        if (mode === 'bot') await saveSwarm(space.id)
        onSaved(space.id)
      } else {
        if (mode === 'project' && !folder) throw new Error('Choose the project folder.')
        const r = await api.spaces.create({ name: name.trim() || undefined, color, shape, kind: mode, members, intro: mode === 'bot' && !prompt.trim(), folder: folder ?? undefined })
        if (mode !== 'group' && prompt.trim()) await api.spaces.setPrompt(r.space.id, prompt)
        if (mode === 'bot') await saveSwarm(r.space.id)
        if (model || effort) await api.spaces.update(r.space.id, { model: model || null, effort: effort || null })
        onSaved(r.space.id, r.threadId)
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
            <div className="hint">{isGroup ? 'Bots in a group answer together and can hand work to each other with @Name.' : isProject ? 'A project is a folder plus instructions. Every chat in it can read and edit that folder.' : 'Each bot has its own personality, look and conversation, and shares your memory.'}</div>
          </div>
        </div>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isGroup ? 'e.g. Launch team' : 'e.g. Research Bot'} disabled={space?.isMain} data-testid="bot-name" /></div>
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
        {!isGroup && !isProject && (
          <>
            <div className="field"><label>Look</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>{SHAPES.map((sh) => (
                  <button key={sh} className={`shape-pick${sh === shape ? ' on' : ''}`} onClick={() => setShape(sh)} title={sh}><SpaceAvatar color={color} shape={sh} size={34} /></button>
                ))}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{COLORS.map((c) => (
                  <button key={c} className="swatch" onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} title={c} style={{ width: 22, height: 22, borderRadius: 7, background: c, outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
                ))}</div>
              </div>
            </div>
            <div className="field"><label>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">App default</option>
                {/* Only models that can run now; a saved choice that's gone stays visible so it can be changed. */}
                {models && model && !pickerModels(models).some((m) => m.id === model) && <option value={model}>{model} (not available: uses Auto)</option>}
                {pickerModels(models).map((m) => <option key={m.id} value={m.id} disabled={!m.fits && !m.maxFittingWindow}>{m.label || m.id}</option>)}
              </select>
            </div>
            <div className="field"><label>Thinking</label>
              <select value={effort} onChange={(e) => setEffort(e.target.value as EffortChoice | '')} data-testid="bot-effort">
                <option value="">App default</option>
                <option value="auto">Auto: picks for each request</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra</option>
                <option value="max">Max</option>
              </select>
            </div>
            <div className="field"><label>Swarm</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={swarm.mode ?? 'auto'} onChange={(e) => setSwarm((x) => ({ ...x, mode: e.target.value as BotSwarmSettings['mode'] }))} data-testid="editor-swarm-mode" aria-label="Swarm">
                  <option value="off">Off</option>
                  <option value="auto">Auto: the bot decides</option>
                  <option value="always">Always</option>
                </select>
                {(swarm.mode ?? 'auto') !== 'off' && (
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Max helpers
                    <input type="number" min={1} max={50} value={swarm.maxHelpers ?? 20} style={{ width: 64 }} data-testid="editor-swarm-max"
                      onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) setSwarm((x) => ({ ...x, maxHelpers: Math.min(50, Math.max(1, n)) })) }} />
                  </label>
                )}
              </div>
            </div>
            <h3>Personality and instructions</h3>
            <div className="hint" style={{ marginBottom: 6 }}>
              {space ? <span title={path}>Saved as a plain file ({path.split('/').pop()}) next to the bot's other files.</span> : 'Leave empty and the bot will introduce itself and ask what to focus on.'}
            </div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Who is this bot? What should it focus on, and how should it talk?" />
          </>
        )}
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

import { useEffect, useState } from 'react'
import type { BotShape, ModelList, Space } from '@shared/types'
import { api } from '../api'
import { COLORS, SHAPES, SpaceAvatar } from '../brand'
import * as I from '../icons'


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
  onSaved: (spaceId: string, threadId?: string, suggestion?: string) => void
}) {
  const [name, setName] = useState(space?.name ?? '')
  const [color, setColor] = useState(space?.color ?? COLORS[3])
  const [icon, setIcon] = useState(space?.icon ?? '')
  const [shape, setShape] = useState<BotShape>(space?.shape ?? 'pebble')
  const [prompt, setPrompt] = useState('')
  const [members, setMembers] = useState<string[]>(space?.members ?? [])
  const [path, setPath] = useState('')
  const [folder, setFolder] = useState<string | null>(space?.folder ?? null)
  const [err, setErr] = useState('')
  const isNewBot = !space && mode === 'bot'
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
        await api.spaces.update(space.id, { name: name.trim() || space.name, color, shape, ...(mode === 'bot' ? { icon: icon.trim() || null } : {}), ...(mode === 'group' ? { members } : {}) })
        if (mode !== 'group') await api.spaces.setPrompt(space.id, prompt)
        onSaved(space.id)
      } else {
        if (mode === 'project' && !folder) throw new Error('Choose the project folder.')
        const r = await api.spaces.create({ name: name.trim() || undefined, color, shape, kind: mode, members, intro: mode === 'bot', folder: folder ?? undefined })
        if (mode === 'project' && prompt.trim()) await api.spaces.setPrompt(r.space.id, prompt)
        if (mode === 'bot' && icon.trim()) await api.spaces.update(r.space.id, { icon: icon.trim() })
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
          {isProject ? <span className="project-icon" style={{ background: color, width: 64, height: 64 }}><I.Folder size={28} /></span> : <SpaceAvatar color={color} shape={shape} icon={mode === 'bot' ? icon.trim() || null : null} size={64} group={isGroup ? members.map((id) => spaces.find((s) => s.id === id)?.color ?? '#999') : undefined} />}
          <div>
            <h2>{space ? `Customize ${isGroup ? 'group' : isProject ? 'project' : 'bot'}` : isGroup ? 'New group chat' : isProject ? 'New project' : 'New bot'}</h2>
            <div className="hint">{isGroup ? 'Bots in a group answer together and can hand work to each other with @Name.' : isProject ? 'A project is a folder plus instructions. Every chat in it can read and edit that folder.' : isNewBot ? 'Pick a name, an icon and a color.' : 'Each bot has its own personality, look and conversation, and shares your memory.'}</div>
          </div>
        </div>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isGroup ? 'e.g. Launch team' : isNewBot ? 'e.g. School Helper' : 'e.g. Research Bot'} disabled={space?.isMain} data-testid="bot-name" /></div>
        {mode === 'bot' && <div className="field"><label>Icon</label><input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="One emoji, e.g. 🧪 (optional)" maxLength={8} style={{ maxWidth: 220 }} data-testid="bot-icon-input" /></div>}
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
                <button key={c} className="swatch" onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} style={{ width: 22, height: 22, borderRadius: 7, background: c, outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
              ))}</div>
            </div>
            <h3>Instructions</h3>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What is this project? Goals, audience, tone, files that matter, things to avoid…" data-testid="project-instructions" />
          </>
        )}
        {!isGroup && !isProject && (() => {
          const look = (
            <div className="field"><label>{isNewBot ? 'Shape and color' : 'Look'}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>{SHAPES.map((sh) => (
                  <button key={sh} className={`shape-pick${sh === shape ? ' on' : ''}`} onClick={() => setShape(sh)} aria-label={`Shape ${sh}`} aria-pressed={sh === shape}><SpaceAvatar color={color} shape={sh} size={34} /></button>
                ))}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{COLORS.map((c) => (
                  <button key={c} className="swatch" onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} style={{ width: 22, height: 22, borderRadius: 7, background: c, outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
                ))}</div>
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
          if (!isNewBot) return <>{look}<div className="hint bot-auto-note" data-testid="editor-auto-model"><I.Sparkle size={12} /> Chooses its tools, models and specialist agents as the task needs.</div>{instructions}</>
          // A new bot: a name and a look, nothing else. Its first message asks what it should do, guessing from its
          // name and what SahilBot knows about you (prompt.ts INTRO).
          return <>{look}<div className="hint bot-auto-note" data-testid="editor-auto-model"><I.Sparkle size={12} /> It opens in its own chat and asks what you need, starting from its name.</div></>
        })()}
        {isGroup && (
          <>
            <h3>Members</h3>
            {bots.length === 0 && <div className="hint">Create some bots first.</div>}
            <div className="member-list">
              {bots.map((b) => (
                <label key={b.id} className="member">
                  <input type="checkbox" checked={members.includes(b.id)} onChange={(e) => setMembers((ms) => e.target.checked ? [...ms, b.id] : ms.filter((x) => x !== b.id))} />
                  <SpaceAvatar color={b.color} shape={b.shape} icon={b.icon} size={28} />{b.name}
                </label>
              ))}
            </div>
          </>
        )}
        {err && <div className="hint error" style={{ marginTop: 8 }}>{err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={(isGroup && members.length === 0) || (isNewBot && !name.trim())} title={isNewBot && !name.trim() ? 'Give your bot a name' : undefined} data-testid="bot-save">{space ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

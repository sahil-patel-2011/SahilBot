import type { EntityType } from '@shared/context-engine'
import type { NoteType } from '../vault/notes'
import type { VaultService } from '../vault/service'
import { SHARED } from '../vault/store'
import type { GraphStore } from './store'

// Each shared entity is mirrored into the knowledge vault as a note (Obsidian-compatible), so the vault
// and the graph never drift into two separate memories: the graph's card lives in a managed block of
// the entity's note. When the compiler already wrote a note with that title (Shared/People/Priya
// Patel.md), the block goes into that note; the rest of the note (the compiler's points, the user's own
// words) is never touched. Relations are [[links]], so the vault's graph shows them too. Every write
// goes through the vault store: logged in Changes, the previous version kept in .history.

export const BLOCK_START = '<!-- sahilbot:card (People & Places; edits here are replaced: change facts in People & Places) -->'
export const BLOCK_END = '<!-- /sahilbot:card -->'

const NOTE_TYPE: Record<EntityType, NoteType> = {
  person: 'person', project: 'project', preference: 'preference', place: 'fact', organization: 'fact', event: 'fact', date: 'fact', item: 'fact', topic: 'fact', routine: 'fact', goal: 'project'
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10)
const REL_WORD: Record<string, [string, string]> = {
  works_at: ['Works at', 'People who work here'], lives_in: ['Lives in', 'Home of'], met_at: ['Met at', 'Where you met'], owns: ['Owns', 'Owned by'],
  prefers: ['Likes', 'Liked by'], related_to: ['Related to', 'Related'], scheduled_with: ['With', 'Events'], located_in: ['In', 'Places here'],
  member_of: ['Member of', 'Members'], family_of: ['Family of', 'Family'], attended: ['Going to', 'Going']
}

/** The managed block for one entity: facts with their sources, relations as [[links]], recent interactions. */
export function cardBlock(store: GraphStore, id: string): string | null {
  const e = store.entity(id)
  if (!e) return null
  const attrs = store.attributes(id).filter((a) => a.scope === null)
  const rels = store.relationViews(id, null)
  const lines: string[] = [BLOCK_START, '## Card', `- Type: ${e.type}`]
  const who = (t: string): string => (t === 'user' ? 'you said' : t === 'observed' ? 'seen' : 'quoted, data only')
  for (const a of attrs) lines.push(`- ${a.key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ${a.value} (${who(a.trust)}, ${a.source.label ?? a.source.kind}, ${iso(a.at)})`)
  for (const r of rels) {
    if (r.otherName === 'You' || store.entity(r.otherId)?.isUser) continue
    const [out, inc] = REL_WORD[r.rel] ?? ['Related to', 'Related']
    lines.push(`- ${r.outgoing ? out : inc}: [[${r.otherName}]]${r.note ? ` (${r.note})` : ''} (${who(r.trust)}, ${iso(r.at)})`)
  }
  const ms = store.mentions(id, 8).filter((m) => m.scope === null)
  if (ms.length) {
    lines.push('', '### Recent')
    for (const m of ms) lines.push(`- ${iso(m.at)} · ${m.source.label ?? m.source.kind}${m.trust === 'quoted' ? ' (quoted)' : ''}: ${m.snippet}`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n')
}

/** `text` with the managed block replaced (or appended), or removed when `block` is null. */
export function withBlock(text: string, block: string | null): string {
  const a = text.indexOf(BLOCK_START.slice(0, 22))
  const b = text.indexOf(BLOCK_END)
  const base = a >= 0 && b > a ? `${text.slice(0, a).replace(/\s+$/, '')}\n${text.slice(b + BLOCK_END.length).replace(/^\s+/, '\n')}` : text
  const clean = base.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  return block ? `${clean}\n\n${block}\n` : `${clean}\n`
}

export interface MirrorResult { path: string; created: boolean }

/**
 * Writes (or refreshes) the entity's note. Only shared entities with something worth a note (two facts,
 * or one the user said) are mirrored; the user's own entity and a bot's quoted-only entities aren't.
 */
export function mirrorEntity(vault: VaultService, store: GraphStore, id: string): MirrorResult | null {
  if (!vault.settings().enabled) return null
  const e = store.entity(id)
  if (!e || e.isUser || e.scope !== null) return null
  const attrs = store.attributes(id).filter((a) => a.scope === null)
  const rels = store.relationViews(id, null)
  if (attrs.length + rels.length < 2 && !attrs.some((a) => a.trust === 'user')) return null
  const block = cardBlock(store, id)
  if (!block) return null
  const vs = vault.store
  vs.ensure()
  const quoted = ![...attrs, ...rels].some((x) => x.trust !== 'quoted')
  let path = e.vaultPath && vs.read(e.vaultPath) ? e.vaultPath : vs.find(SHARED, e.name)?.path ?? null
  let created = false
  if (!path) {
    const r = vs.upsert({
      section: SHARED, type: NOTE_TYPE[e.type], title: e.name, summary: undefined, tags: ['sahilbot/entity', `sahilbot/entity/${e.type}`],
      aliases: store.aliases(id).filter((a) => (a.kind === 'name' || a.kind === 'nickname') && a.value !== e.name).map((a) => a.value).slice(0, 8),
      sources: ['SahilBot People & Places'], trust: quoted ? 'quoted' : 'trusted', extra: { entity: JSON.stringify(id) }
    }, { actor: 'context-engine', why: 'new card from People & Places' })
    path = r.path
    created = true
  }
  const cur = vs.read(path)
  if (!cur) return null
  const next = withBlock(cur.text, block)
  if (next.trim() !== cur.text.trim()) vs.write(path, next, { actor: 'context-engine', why: 'People & Places card updated' })
  store.setVaultPath(id, path)
  return { path, created }
}

/**
 * The vault side of "forget": a note the engine made goes to the vault's trash; a note that was there
 * before (the compiler's or the user's) only loses its card block. Returns what Undo needs.
 */
export function forgetMirror(vault: VaultService, path: string | null, entityId: string): { path: string; changeId?: string; created?: boolean } | undefined {
  if (!path) return undefined
  const vs = vault.store
  const cur = vs.read(path)
  if (!cur) return undefined
  const ours = (cur.fm.extra.entity ?? '').replace(/"/g, '') === entityId
  if (ours) {
    const c = vs.trash(path, { actor: 'context-engine', why: 'forgotten in People & Places' })
    vs.rebuildIndexes()
    return { path, changeId: c.id, created: true }
  }
  const c = vs.write(path, withBlock(cur.text, null), { actor: 'context-engine', why: 'forgotten in People & Places' })
  vs.rebuildIndexes()
  return { path, changeId: c.id, created: false }
}

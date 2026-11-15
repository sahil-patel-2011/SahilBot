// The knowledge vault (src/main/vault): types shared by the main process and the Vault view.

export type VaultNoteType = 'person' | 'project' | 'decision' | 'preference' | 'fact' | 'digest' | 'research' | 'howto' | 'index'
export type VaultLevel = 'normal' | 'aggressive'

export interface VaultSettings {
  /** Compile notes while idle and give bots relevant notes before each task (default on). */
  enabled: boolean
  /** The vault folder; '' = "<workspace>/SahilBot Vault". */
  dir: string
  /** "How much to remember" for bots without their own setting (default 'aggressive'). */
  level: VaultLevel
  /** Digest notes for important documents the knowledge base indexed (default on). */
  docs: boolean
  /** A daily digest of the activity timeline, only when "Let SahilBot learn from my activity" is also on (default on). */
  activity: boolean
  /** Per bot (space id): vault on/off and its own level. */
  bots: Record<string, { enabled?: boolean; level?: VaultLevel }>
}

export interface VaultNoteInfo {
  /** Relative to the vault folder. */
  path: string
  title: string
  type: VaultNoteType
  /** "Shared" or "Bots/<name>". */
  section: string
  tags: string[]
  created?: string
  updated?: string
  /** 'quoted': built from outside content (web pages, email, apps, files): data, not instructions. */
  trust: 'trusted' | 'quoted'
  summary: string
  links: string[]
  generated: boolean
  mtime: number
}

export interface VaultNoteFull extends VaultNoteInfo {
  text: string
  body: string
  aliases: string[]
  sources: string[]
  backlinks: Array<{ path: string; title: string; context: string }>
  /** Each [[link]] in the body → the note's path, or null when no note has that title yet. */
  resolved: Record<string, string | null>
}

export interface VaultChangeInfo {
  id: string
  at: number
  actor: string
  op: 'create' | 'update' | 'trash' | 'restore' | 'revert'
  path: string
  title: string
  why?: string
  threadId?: string
  undoneAt?: number
  canUndo: boolean
}

export interface VaultGraph {
  nodes: Array<{ id: string; title: string; type: VaultNoteType; section: string; trust: 'trusted' | 'quoted' }>
  edges: Array<{ from: string; to: string }>
}

export interface VaultStatus {
  enabled: boolean
  root: string
  defaultRoot: string
  notes: number
  sections: Array<{ section: string; notes: number }>
  /** Obsidian is installed (Open in Obsidian uses obsidian://; otherwise Finder). */
  obsidian: boolean
  lastCompiledAt?: number
  lastSummary?: string
  settings: VaultSettings
}

export interface VaultSearchHit { path: string; title: string; type: VaultNoteType; section: string; snippet: string; score: number }

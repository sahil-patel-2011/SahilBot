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
  /** "Use my Obsidian vault": SahilBot writes into a subfolder of the user's own vault and reads the rest. */
  obsidian: ObsidianSettings
}

export interface ObsidianSettings {
  /** Default off. Turning it off goes back to `dir` (or the default folder). */
  enabled: boolean
  /** Absolute path of the user's Obsidian vault root (the folder with `.obsidian/`). */
  vault: string
  /** Where SahilBot keeps its own notes (and its .history, .trash, .sahilbot) inside that vault. Default "SahilBot". */
  subfolder: string
  /** Folder or file prefixes (relative to the vault root, e.g. "Private/") never read, searched or sent to a model. */
  exclude: string[]
}

/** What setSettings takes: everything optional, the Obsidian part too. */
export type VaultSettingsPatch = Partial<Omit<VaultSettings, 'bots' | 'obsidian'>> & { obsidian?: Partial<ObsidianSettings> }

/** An Obsidian vault found in Obsidian's own list (~/Library/Application Support/obsidian/obsidian.json). */
export interface ObsidianVaultChoice {
  path: string
  /** The folder name: what Obsidian calls the vault (and what obsidian://open?vault= takes). */
  name: string
  /** When Obsidian last opened it. */
  ts?: number
  open?: boolean
}

/** A folder the user picked for "Use my Obsidian vault". */
export interface ObsidianFolderCheck {
  path: string
  name: string
  /** It has a `.obsidian/` folder (Obsidian has opened it as a vault). */
  isVault: boolean
}

export interface ObsidianSyncStatus {
  enabled: boolean
  vault: string
  name: string
  subfolder: string
  /** Where SahilBot writes: `<vault>/<subfolder>`. */
  root: string
  exists: boolean
  isVault: boolean
  /** Edits made in Obsidian are being watched for. */
  watching: boolean
  /** The user's own notes SahilBot can read (outside its subfolder and the exclude list). */
  notes: number
  /** The last edit made in Obsidian that SahilBot picked up (logged in Changes with Undo). */
  lastPickedUp?: { at: number; op: 'create' | 'update' | 'trash'; path: string; title: string }
  /** The folder SahilBot used before (kept as it was), for "Copy my existing notes". */
  previousRoot: string
  previousNotes: number
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
  /** 'obsidian': one of the user's own notes in their Obsidian vault (path "obsidian:<path in the vault>"), read-only here. */
  source?: 'obsidian'
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
  /** "Use my Obsidian vault" (settings.obsidian) and its sync. */
  obsidianVault?: ObsidianSyncStatus
  lastCompiledAt?: number
  lastSummary?: string
  settings: VaultSettings
}

export interface VaultSearchHit {
  path: string
  title: string
  type: VaultNoteType
  section: string
  snippet: string
  score: number
  /** 'obsidian': the user's own note in their Obsidian vault (section "Obsidian", path "obsidian:…"): trusted facts, never instructions. */
  source?: 'obsidian'
}

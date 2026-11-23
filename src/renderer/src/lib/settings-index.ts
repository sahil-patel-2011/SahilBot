// Settings search: every setting, the page (and tab) it lives on, and the words people might type for it.
// The search box lists matches; picking one opens its page and tab, expands any closed "Advanced" around
// it and scrolls it into view (SettingsModal.tsx: jumpTo). Each `anchor` is a data-setting="…" attribute
// on the row (tests/unit/settings-index.test.ts checks both directions, and that every saved setting has
// an entry).

export type SettingsPage = 'general' | 'models' | 'connected' | 'permissions' | 'memory' | 'voice' | 'privacy' | 'usage' | 'server' | 'advanced'

/** Old page ids (links from other screens, saved deep links) and where they live now. */
export const LEGACY_PAGES: Record<string, { page: SettingsPage; tab?: string }> = {
  keys: { page: 'models' },
  appearance: { page: 'general' },
  knowledge: { page: 'advanced', tab: 'knowledge' },
  rules: { page: 'advanced', tab: 'rules' },
  approvals: { page: 'permissions' },
  passwords: { page: 'privacy', tab: 'passwords' },
  vault: { page: 'privacy', tab: 'passwords' },
  activity: { page: 'privacy', tab: 'privacy' },
  backups: { page: 'privacy', tab: 'backups' },
  'privacy:approvals': { page: 'permissions' },
  'privacy:permissions': { page: 'permissions' }
}

export interface SettingEntry {
  /** The row's data-setting anchor. */
  anchor: string
  page: SettingsPage
  /** The page's tab it's on, if the page has tabs. */
  tab?: string
  title: string
  /** Extra words people search with. */
  words: string
  /** Saved settings (Settings keys, dotted) this row changes: the index test checks every saved key has a row. */
  keys?: string[]
  /** Inside a closed "Advanced" (or "More") disclosure. */
  advanced?: boolean
  /** Only in the Mac app (not in a browser on SahilBot Server or a phone). */
  macOnly?: boolean
}

export const PAGE_TITLES: Record<SettingsPage, string> = {
  general: 'You', models: 'AI & spending', connected: 'Apps', permissions: 'What it may do', memory: 'Memory', voice: 'Voice',
  privacy: 'Privacy & safety', usage: 'Spending', server: 'Phone & server', advanced: 'Advanced'
}

/**
 * Settings shows six sections. Some pages live inside another one: Spending under AI & spending, What it may do
 * under Privacy & safety, Advanced at the bottom of You. Search and links to those pages open their section.
 */
export const SECTION_OF: Record<SettingsPage, SettingsPage> = {
  general: 'general', models: 'models', connected: 'connected', memory: 'memory', privacy: 'privacy', voice: 'voice', server: 'server',
  usage: 'models', permissions: 'privacy', advanced: 'general'
}

/** One plain line under each section's name. */
export const SECTION_HINT: Partial<Record<SettingsPage, string>> = {
  general: 'Your name, look, startup and updates',
  models: 'Which AI answers you, and what it may spend',
  connected: 'Gmail, Calendar, Notion and other services',
  memory: 'What SahilBot remembers about you',
  privacy: 'What it may do on its own, passwords, backups',
  voice: 'Talking out loud and how it sounds',
  server: 'Use SahilBot from your phone or a server'
}

export const SETTINGS_INDEX: SettingEntry[] = [
  // General
  { anchor: 'user-name', page: 'general', title: 'Your name', words: 'name call me first name last name surname profile', keys: ['userName', 'profile', 'profile.firstName', 'profile.lastName'] },
  { anchor: 'birthday', page: 'general', title: 'Birthday', words: 'birthday date of birth dob age profile', keys: ['profile.birthday'] },
  { anchor: 'me-contact', page: 'general', title: 'Your email and phone', words: 'me my email address phone number mobile text sms imessage trusted message without asking', keys: ['me', 'me.emails', 'me.phones'] },
  { anchor: 'workspace', page: 'general', title: 'Workspace folder', words: 'folder files save output directory', keys: ['workspaceDir'] },
  { anchor: 'theme', page: 'general', title: 'Theme', words: 'appearance dark light mode system', keys: ['theme'] },
  { anchor: 'quick-ask', page: 'general', title: 'Quick Ask shortcut', words: 'shortcut hotkey keyboard option space overlay', keys: ['quickKey'] },
  { anchor: 'open-at-login', page: 'general', title: 'Open at login', words: 'startup login launch boot', keys: ['openAtLogin'] },
  { anchor: 'updates', page: 'general', title: 'Updates', words: 'update upgrade new version latest release download install restart backup' },

  // Models & Keys
  { anchor: 'key-anthropic', page: 'models', title: 'Claude (Anthropic API key)', words: 'anthropic claude key api opus sonnet haiku fable' },
  { anchor: 'key-openai', page: 'models', title: 'OpenAI API key', words: 'openai gpt key api chatgpt' },
  { anchor: 'key-xai', page: 'models', title: 'Grok (xAI API key)', words: 'xai grok key api' },
  { anchor: 'provider-switches', page: 'models', title: 'Turn a provider off (keeps its key)', words: 'provider off disable pause claude anthropic openai gpt grok xai switch toggle slider keep key', keys: ['disabledProviders'] },
  { anchor: 'chatgpt-plan', page: 'models', title: 'ChatGPT plan (via Codex)', words: 'chatgpt plan subscription codex sign in plus pro' },
  { anchor: 'grok-plan', page: 'models', title: 'Grok subscription', words: 'grok build subscription sign in supergrok prefer plans first' },
  { anchor: 'auto-prefers', page: 'models', title: 'Auto prefers', words: 'auto routing best balanced cheapest cost quality', keys: ['cloud.autoPrefers'] },
  { anchor: 'monthly-limit', page: 'models', title: 'Monthly spending limit', words: 'budget cap spend spending limit money cost unlimited none dollars', keys: ['cloudBudgetUsd', 'spendingMode'] },
  { anchor: 'local-models', page: 'models', title: 'Local models', words: 'ollama lm studio local offline private download free', keys: ['local.enabled'] },
  { anchor: 'model-list', page: 'models', title: 'Models in the picker', words: 'models list hide show installed available per-model context window add model', keys: ['hiddenModels', 'shownModels', 'customModels', 'modelContext'], advanced: true },

  // Connected apps
  { anchor: 'connect-apps', page: 'connected', title: 'Connect apps', words: 'gmail calendar notion slack github drive connectors integrations mcp oauth cursor cloud agents api key', keys: ['cursorLocalAgent'] },
  { anchor: 'mcp-server', page: 'connected', title: 'Let other apps use SahilBot', words: 'mcp server cursor claude code claude desktop token port raycast alfred shortcuts links', keys: ['mcpServer'], advanced: true },

  // Memory
  { anchor: 'remember-auto', page: 'memory', title: 'Remember things automatically', words: 'memory learn learning automatic save remember background idle', keys: ['learning.enabled'] },
  { anchor: 'memory-list', page: 'memory', tab: 'memories', title: 'Saved memories', words: 'memories facts preferences people places forget edit delete search' },
  { anchor: 'memory-import', page: 'memory', tab: 'memories', title: 'Import from another AI', words: 'import chatgpt claude gemini export memories' },
  { anchor: 'learned', page: 'memory', tab: 'learned', title: 'What SahilBot learned', words: 'learned undo approve dismiss skills lessons log' },

  // Voice
  { anchor: 'speech-model', page: 'voice', title: 'Speech recognition', words: 'whisper dictation transcription speech to text microphone voice input model download', keys: ['voiceInput'] },
  { anchor: 'voice-openai', page: 'voice', title: 'Speech provider', words: 'openai grok xai auto voice transcription tts cloud', keys: ['voiceOutput.provider', 'voiceOutput.openai'] },

  // Privacy & Security
  { anchor: 'passwords', page: 'privacy', tab: 'passwords', title: 'Passwords & vault', words: 'vault passwords login card credit id passport license secure note master password touch id lock backup export import csv' },
  { anchor: 'autonomy', page: 'permissions', title: 'Permissions for new chats', words: 'ask auto autonomy autonomous permission permissions mode approvals', keys: ['defaultMode', 'botModes'] },
  { anchor: 'files-anywhere', page: 'permissions', title: 'Read and edit files anywhere', words: 'files folders anywhere full disk read edit write without asking approve documents desktop', keys: ['advanced.filesAnywhere'] },
  { anchor: 'mac-permissions', page: 'permissions', title: 'Mac permissions', words: 'accessibility screen recording microphone full disk access automation notifications system settings' },
  { anchor: 'backups', page: 'privacy', tab: 'backups', title: 'Backups', words: 'backup copy restore recovery password api keys export memories decisions vault notes external drive time machine safe lost new mac', macOnly: true },

  // Usage, server
  { anchor: 'permissions-page', page: 'permissions', title: 'What SahilBot may do on its own', words: 'permissions approvals auto ask first autonomy allowed actions mac access' },
  { anchor: 'usage', page: 'usage', title: 'Usage', words: 'usage spend cost tokens requests bots csv export history' },
  { anchor: 'phone-access', page: 'general', title: 'Phone access', words: 'phone iphone android mobile ipad qr code pair pairing wifi home network tailscale away notifications push remote', macOnly: true },
  { anchor: 'server', page: 'server', title: 'Phone & server', words: 'server raspberry pi vps digitalocean always on remote phone iphone devices pairing tailscale mac link use this mac keep awake wake' },
  { anchor: 'worker-machines', page: 'server', title: 'Worker machines', words: 'worker fleet bot placement move assign raspberry pi vm linux container slots', macOnly: true },

  // Advanced
]

/** Settings keys that aren't user-facing settings (internal state, other screens own them). */
export const NOT_IN_SETTINGS = new Set([
  'hasApiKey', 'mainThreadId', 'keys', 'keysSaved', 'hasCursorKey', 'hasTbaKey', 'hasNcbiKey', 'hasGoogleMapsKey', 'keysLocked', 'hasOnshapeKeys', 'onshapeKeyParts', 'onboarded', 'pinnedBots', 'search.hasBraveKey',
  'appearance', 'cloud', 'search', 'advanced', 'taskModels', 'learning', 'local', 'markets', 'voiceOutput',
  // No longer a setting: typed replies are never read aloud on their own (the speaker on a message does it).
  'speakReplies',
  // Set from other screens: bot details, the composer, the menu bar, local model loading.
  'botAutonomy', 'botSwarm', 'localKeepAlive', 'advanced.sandboxCommands', 'local.migrated', 'learning.explicit', 'cloud.maxConsultsPerRequest',
  // Saved-key flags (the keys themselves are entered on their rows and live in the Keychain).
  'markets.keys',
  // No longer on any settings page (Nov 2026 simplification): the bot picks sensible defaults, and the rest the user
  // asks for in chat. The values still exist so old settings files load.
  'baseUrl', 'defaultModel', 'providers', 'taskModels.voice', 'taskModels.background', 'appearance.density', 'appearance.chatWidth',
  'appearance.codeWrap', 'appearance.hue', 'appearance.tint', 'appearance.reduceTransparency', 'appearance.fontSize', 'thinking', 'cloud.enabled',
  'cloud.hybrid', 'cloud.advisorModel', 'contextWindow', 'sampling', 'search.provider', 'search.searxngUrl', 'advanced.hardStopsEnabled',
  'advanced.devMode', 'customRules', 'menuBarIcon', 'keepAwakeWhileWorking', 'lidAwake', 'catchUpHours', 'routinesPaused', 'markets.quoteProvider',
  'markets.secContact', 'learning.cloudAllowed', 'learning.dailyUsd', 'openaiEmbeddings', 'composer', 'composer.cmdEnter', 'composer.spellCheck'
])

/** Matches for a search: every word must appear in the title, words or page name. Best first. */
export function searchSettings(q: string, opts: { server?: boolean } = {}): SettingEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hidden = opts.server ? new Set<SettingsPage>(['voice']) : new Set<SettingsPage>()
  const scored = SETTINGS_INDEX.filter((e) => !hidden.has(e.page) && !(opts.server && e.macOnly)).map((e) => {
    const title = e.title.toLowerCase()
    const hay = `${title} ${e.words} ${PAGE_TITLES[e.page].toLowerCase()} ${e.tab ?? ''}`
    if (!words.every((w) => hay.includes(w))) return null
    const score = words.reduce((n, w) => n + (title.startsWith(w) ? 4 : title.includes(w) ? 2 : 0), 0) + (e.advanced ? 0 : 0.5)
    return { e, score }
  }).filter((x): x is { e: SettingEntry; score: number } => !!x)
  return scored.sort((a, b) => b.score - a.score).map((x) => x.e)
}

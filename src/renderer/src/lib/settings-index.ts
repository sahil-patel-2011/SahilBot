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
  { anchor: 'menu-bar', page: 'general', title: 'Show in the menu bar', words: 'menu bar icon tray status', keys: ['menuBarIcon'] },
  { anchor: 'open-at-login', page: 'general', title: 'Open at login', words: 'startup login launch boot', keys: ['openAtLogin'] },
  { anchor: 'updates', page: 'general', title: 'Updates', words: 'update upgrade new version latest release download install restart backup' },
  { anchor: 'density', page: 'general', title: 'Steps in chats', words: 'step detail tool call density compact detailed summary every appearance', keys: ['appearance.density'] },
  { anchor: 'chat-width', page: 'general', title: 'Chat width', words: 'appearance width narrow wide', keys: ['appearance.chatWidth'], advanced: true },
  { anchor: 'code-wrap', page: 'general', title: 'Wrap long code lines', words: 'appearance code block word wrap', keys: ['appearance.codeWrap'], advanced: true },
  { anchor: 'tint', page: 'general', title: 'Accent tint', words: 'appearance color hue intensity tint colour', keys: ['appearance.hue', 'appearance.tint'], advanced: true },
  { anchor: 'reduce-transparency', page: 'general', title: 'Reduce transparency', words: 'appearance solid background accessibility', keys: ['appearance.reduceTransparency'], advanced: true },
  { anchor: 'animate-browser', page: 'general', title: 'Animate browser actions', words: 'cursor screen motion quiet flashing background', keys: ['advanced.animateBrowser'], advanced: true, macOnly: true },
  { anchor: 'font-size', page: 'general', title: 'Text size', words: 'appearance font size typography bigger smaller', keys: ['appearance.fontSize'] },
  { anchor: 'keep-awake', page: 'general', title: 'Keep the Mac awake while bots work', words: 'sleep awake always on caffeinate', keys: ['keepAwakeWhileWorking'], advanced: true },
  { anchor: 'lid-awake', page: 'general', title: 'Keep working with the lid closed', words: 'lid closed shut clamshell sleep awake laptop travel', keys: ['lidAwake'] },
  { anchor: 'catch-up', page: 'general', title: 'Catch up on missed routines', words: 'routines schedule missed asleep closed', keys: ['catchUpHours'], advanced: true },
  { anchor: 'routines-paused', page: 'general', title: 'Pause all routines', words: 'routines schedule stop pause', keys: ['routinesPaused'], advanced: true },
  { anchor: 'web-search', page: 'general', title: 'Web search', words: 'search provider brave searxng duckduckgo key internet', keys: ['search.provider', 'search.searxngUrl'], advanced: true },

  // Models & Keys
  { anchor: 'key-anthropic', page: 'models', title: 'Claude (Anthropic API key)', words: 'anthropic claude key api opus sonnet haiku fable' },
  { anchor: 'key-openai', page: 'models', title: 'OpenAI API key', words: 'openai gpt key api chatgpt' },
  { anchor: 'key-xai', page: 'models', title: 'Grok (xAI API key)', words: 'xai grok key api' },
  { anchor: 'provider-switches', page: 'models', title: 'Turn a provider off (keeps its key)', words: 'provider off disable pause claude anthropic openai gpt grok xai switch toggle slider keep key', keys: ['disabledProviders'] },
  { anchor: 'chatgpt-plan', page: 'models', title: 'ChatGPT plan (via Codex)', words: 'chatgpt plan subscription codex sign in plus pro' },
  { anchor: 'grok-plan', page: 'models', title: 'Grok subscription', words: 'grok build subscription sign in supergrok prefer plans first' },
  { anchor: 'auto-prefers', page: 'models', title: 'Auto prefers', words: 'auto routing best balanced cheapest cost quality', keys: ['cloud.autoPrefers'] },
  { anchor: 'memory-sharing', page: 'memory', title: 'Bots share what they learn', words: 'share memory between bots other bots read memories team shared memory work log', keys: ['memorySharing'] },
  { anchor: 'monthly-limit', page: 'models', title: 'Monthly spending limit', words: 'budget cap spend spending limit money cost unlimited none dollars', keys: ['cloudBudgetUsd', 'spendingMode'] },
  { anchor: 'local-models', page: 'models', title: 'Local models', words: 'ollama lm studio local offline private download free', keys: ['local.enabled'] },
  { anchor: 'default-model', page: 'models', title: 'Model for new chats', words: 'default model auto picker', keys: ['defaultModel'], advanced: true },
  { anchor: 'thinking', page: 'models', title: 'Thinking for new chats', words: 'thinking effort reasoning low medium high max', keys: ['thinking'], advanced: true },
  { anchor: 'cloud-enabled', page: 'models', title: 'Use cloud models', words: 'cloud online off offline', keys: ['cloud.enabled'], advanced: true },
  { anchor: 'hybrid', page: 'models', title: 'Hybrid: local model asks the cloud', words: 'hybrid consult advisor questions per request local cloud', keys: ['cloud.hybrid', 'cloud.maxConsultsPerRequest', 'cloud.advisorModel'], advanced: true },
  { anchor: 'cloud-routing', page: 'models', title: 'Cloud routing', words: 'local first cloud first prefer claude context native tools fable 1m window', keys: ['cloud.prefer', 'cloud.contextStrategy', 'cloud.nativeTools', 'cloud.fableForHardest'], advanced: true },
  { anchor: 'fast-mode', page: 'models', title: 'Fast mode', words: 'fast priority speed service tier ultrafast', keys: ['fastMode'], advanced: true },
  { anchor: 'model-list', page: 'models', title: 'Models in the picker', words: 'models list hide show installed available per-model context window add model', keys: ['hiddenModels', 'shownModels', 'customModels', 'modelContext'], advanced: true },
  { anchor: 'background-model', page: 'models', title: 'Model for background jobs', words: 'task models background titles small jobs', keys: ['taskModels.background'], advanced: true },
  { anchor: 'computer-use', page: 'models', title: 'Computer use', words: 'computer use planner executor screen mouse keyboard', keys: ['computerUse'], advanced: true },
  { anchor: 'servers', page: 'models', title: 'Custom servers', words: 'openrouter openai base url gateway ollama lm studio custom server llama.cpp vllm address', keys: ['providers', 'baseUrl'], advanced: true },
  { anchor: 'tool-keys', page: 'models', title: 'Keys for tools', words: 'market data stocks tiingo polygon alpha vantage finnhub quotes blue alliance frc tba onshape cad key pubmed ncbi medical research google maps places directions travel', keys: ['markets.quoteProvider', 'markets.secContact'], advanced: true },

  // Connected apps
  { anchor: 'connect-apps', page: 'connected', title: 'Connect apps', words: 'gmail calendar notion slack github drive connectors integrations mcp oauth cursor cloud agents api key', keys: ['cursorLocalAgent'] },
  { anchor: 'mcp-server', page: 'connected', title: 'Let other apps use SahilBot', words: 'mcp server cursor claude code claude desktop token port raycast alfred shortcuts links', keys: ['mcpServer'], advanced: true },

  // Memory
  { anchor: 'remember-auto', page: 'memory', title: 'Remember things automatically', words: 'memory learn learning automatic save remember background idle', keys: ['learning.enabled'] },
  { anchor: 'memory-list', page: 'memory', tab: 'memories', title: 'Saved memories', words: 'memories facts preferences people places forget edit delete search' },
  { anchor: 'memory-import', page: 'memory', tab: 'memories', title: 'Import from another AI', words: 'import chatgpt claude gemini export memories' },
  { anchor: 'learned', page: 'memory', tab: 'learned', title: 'What SahilBot learned', words: 'learned undo approve dismiss skills lessons log' },
  { anchor: 'knowledge-vault', page: 'memory', tab: 'vault', title: 'Knowledge vault', words: 'vault obsidian notes markdown compile digest aggressive normal folder' },
  { anchor: 'people-places', page: 'memory', title: 'People & Places', words: 'people places contacts entities world context engine' },
  { anchor: 'brain-settings', page: 'memory', tab: 'brain', title: 'Your brain and Agent mode', words: 'brain agent mode reaches out proactive prompts quiet hours daily brain budget sync refresh sources gmail calendar slack hubspot texts backfill draft without asking chatgpt plan pause' },
  { anchor: 'memory-enabled', page: 'memory', title: 'Use memory', words: 'memory off disable turn off', advanced: true },
  { anchor: 'learning-cloud', page: 'memory', title: 'Use cloud models for learning', words: 'cloud learning daily cap budget', keys: ['learning.cloudAllowed', 'learning.dailyUsd'], advanced: true },

  // Voice
  { anchor: 'speech-model', page: 'voice', title: 'Speech recognition', words: 'whisper dictation transcription speech to text microphone voice input model download', keys: ['voiceInput'] },
  { anchor: 'voice-openai', page: 'voice', title: 'Speech provider', words: 'openai grok xai auto voice transcription tts cloud', keys: ['voiceOutput.provider', 'voiceOutput.openai'] },
  { anchor: 'transcribe-local', page: 'voice', title: 'Transcribe on this Mac', words: 'local whisper offline private', keys: ['voiceInput.local'], advanced: true },
  { anchor: 'whisper-model', page: 'voice', title: 'Speech model', words: 'whisper small medium large turbo model override size', keys: ['voiceInput.model'], advanced: true },
  { anchor: 'voice-model', page: 'voice', title: 'Model for voice conversations', words: 'voice conversation model fast light', keys: ['taskModels.voice'], advanced: true },

  // Privacy & Security
  { anchor: 'passwords', page: 'privacy', tab: 'passwords', title: 'Passwords & vault', words: 'vault passwords login card credit id passport license secure note master password touch id lock backup export import csv' },
  { anchor: 'autonomy', page: 'permissions', title: 'Permissions for new chats', words: 'ask auto autonomy autonomous permission permissions mode approvals', keys: ['defaultMode', 'botModes'] },
  { anchor: 'approval-rules', page: 'permissions', title: 'Approval rules', words: 'approval approve allow ask first always automatically confirm rules', keys: ['customRules'] },
  { anchor: 'bypass', page: 'permissions', title: 'Bypass', words: 'bypass full access hard stops confirm', keys: ['advanced.allowBypass', 'advanced.hardStopsEnabled'], advanced: true },
  { anchor: 'files-anywhere', page: 'permissions', title: 'Read and edit files anywhere', words: 'files folders anywhere full disk read edit write without asking approve documents desktop', keys: ['advanced.filesAnywhere'] },
  { anchor: 'mac-permissions', page: 'permissions', title: 'Mac permissions', words: 'accessibility screen recording microphone full disk access automation notifications system settings' },
  { anchor: 'backups', page: 'privacy', tab: 'backups', title: 'Backups', words: 'backup copy restore recovery password api keys export memories decisions vault notes external drive time machine safe lost new mac', macOnly: true },
  { anchor: 'activity', page: 'privacy', tab: 'privacy', title: 'Know what I\'m working on', words: 'activity window titles browser tabs timeline context share cloud exclude apps sites' },
  { anchor: 'hybrid-compute', page: 'privacy', tab: 'privacy', title: 'Hybrid compute and Privacy Gate', words: 'hybrid local cloud privacy gate pii tracer personal information phi mask redact bank statement bill on my mac perplexity' },
  { anchor: 'sensitive', page: 'privacy', tab: 'privacy', title: 'Sensitive details', words: 'health money finance religion politics children sexuality government id sensitive categories privacy' },

  // Usage, server
  { anchor: 'permissions-page', page: 'permissions', title: 'What SahilBot may do on its own', words: 'permissions approvals auto ask first autonomy allowed actions mac access' },
  { anchor: 'advanced-page', page: 'advanced', title: 'Advanced', words: 'advanced rules skills knowledge folders developer power user' },
  { anchor: 'usage', page: 'usage', title: 'Usage', words: 'usage spend cost tokens requests bots csv export history' },
  { anchor: 'phone-access', page: 'general', title: 'Phone access', words: 'phone iphone android mobile ipad qr code pair pairing wifi home network tailscale away notifications push remote', macOnly: true },
  { anchor: 'server', page: 'server', title: 'Phone & server', words: 'server raspberry pi vps digitalocean always on remote phone iphone devices pairing tailscale mac link use this mac keep awake wake' },
  { anchor: 'worker-machines', page: 'server', title: 'Worker machines', words: 'worker fleet bot placement move assign raspberry pi vm linux container slots', macOnly: true },

  // Advanced
  { anchor: 'rules', page: 'advanced', tab: 'rules', title: 'Rules', words: 'rules instructions always follow packs engineering medical business coding' },
  { anchor: 'skills', page: 'advanced', tab: 'rules', title: 'Skills', words: 'skills procedures steps learned customize' },
  { anchor: 'knowledge', page: 'advanced', tab: 'knowledge', title: 'Knowledge folders', words: 'knowledge search files folders documents index pdf embeddings rebuild openai meaning', keys: ['openaiEmbeddings'] },
  { anchor: 'dev-mode', page: 'advanced', tab: 'developer', title: 'Developer mode', words: 'developer dev mode debug show bot models thinking collaboration names tokens cost steps commands details', keys: ['advanced.devMode'] },
  { anchor: 'context-window', page: 'advanced', tab: 'developer', title: 'Context window (local models)', words: 'context window tokens 16k 32k 64k 128k', keys: ['contextWindow'] },
  { anchor: 'gpu', page: 'advanced', tab: 'developer', title: 'GPU memory for local models', words: 'gpu memory 90% metal wired' },
  { anchor: 'sampling', page: 'advanced', tab: 'developer', title: 'Sampling', words: 'temperature top p top k min p penalty sampling', keys: ['sampling'] }
]

/** Settings keys that aren't user-facing settings (internal state, other screens own them). */
export const NOT_IN_SETTINGS = new Set([
  'hasApiKey', 'keys', 'keysSaved', 'hasCursorKey', 'hasTbaKey', 'hasNcbiKey', 'hasGoogleMapsKey', 'keysLocked', 'hasOnshapeKeys', 'onshapeKeyParts', 'onboarded', 'pinnedBots', 'search.hasBraveKey',
  'appearance', 'cloud', 'search', 'advanced', 'taskModels', 'learning', 'local', 'markets', 'voiceOutput',
  // No longer a setting: typed replies are never read aloud on their own (the speaker on a message does it).
  'speakReplies',
  // Set from other screens: bot details, the composer, the menu bar, local model loading.
  'botAutonomy', 'botSwarm', 'localKeepAlive', 'advanced.sandboxCommands', 'local.migrated', 'learning.explicit', 'cloud.maxConsultsPerRequest',
  // Saved-key flags (the keys themselves are entered on their rows and live in the Keychain).
  'markets.keys'
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

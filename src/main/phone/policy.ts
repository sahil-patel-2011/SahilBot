// What a paired phone may do through the Mac (Phone access). The phone runs the same app as the Mac window,
// but some calls would act on the Mac's own screen (its browser panel, dialogs, microphone, System Settings,
// sign-in pages) or hand over something that stays on the Mac by design: saved passwords and authenticator
// codes, and approving a purchase or a one-time code. Those are refused here with a line that says where to
// do it instead. Everything else (chats, bots, Needs you, approvals, routines, settings) works as on the Mac.

export const ON_MAC = 'Do this on your Mac.'

/** Exact channels a phone may not call, and why. */
const DENIED: Record<string, string> = {
  'attach:screenshot': 'Screenshots are taken on your Mac.',
  'attach:pick': 'Attach files with the phone’s own file picker.',
  'attach:pickFolder': 'Choose working folders on your Mac.',
  'attach:pickBotFolder': 'Choose a bot’s folder on your Mac.',
  pickFolder: 'Choose folders on your Mac.',
  'files:pick': 'Attach files with the phone’s own file picker.',
  'files:open': 'Files open on your Mac. Open SahilBot there to see this one.',
  'files:reveal': 'Files are shown in Finder on your Mac.',
  'knowledge:open': 'Files open on your Mac.',
  'knowledge:reveal': 'Files are shown in Finder on your Mac.',
  'knowledge:addFolder': 'Add knowledge folders on your Mac.',
  'notesVault:openInObsidian': 'Obsidian opens on your Mac.',
  'notesVault:reveal': 'Files are shown in Finder on your Mac.',
  'notesVault:exportZip': 'Exports are saved on your Mac.',
  'notesVault:obsidianPick': 'Choose your Obsidian vault on your Mac.',
  'notesVault:obsidianCopyExisting': 'Copy notes into your Obsidian vault on your Mac.',
  'bots:importPick': 'Import bots on your Mac.',
  'bots:export': 'Export bots on your Mac.',
  'chat:export': 'Export chats on your Mac.',
  'usage:exportCsv': 'Exports are saved on your Mac.',
  'people:exportData': 'Exports are saved on your Mac.',
  'docs:export': 'Exports are saved on your Mac.',
  'docs:addImage': 'Add images to documents on your Mac.',
  'pages:openWindow': 'Pages open in their own window on your Mac.',
  'pages:show': 'Pages open on your Mac.',
  'pages:exportPdf': 'PDFs are saved on your Mac.',
  'permissions:open': 'Mac permissions are set in System Settings on your Mac.',
  'permissions:request': 'Mac permissions are set in System Settings on your Mac.',
  'chatgptPlan:connect': 'Sign in to your ChatGPT plan on your Mac.',
  'chatgptPlan:loginInTerminal': 'Sign in to your ChatGPT plan on your Mac.',
  'chatgptPlan:openInstallGuide': 'Set up your ChatGPT plan on your Mac.',
  'chatgptPlan:installInTerminal': 'Install Codex on your Mac: Terminal opens there.',
  'grokPlan:signIn': 'Sign in to your Grok subscription on your Mac.',
  'grokPlan:installInTerminal': 'Install Grok Build on your Mac: Terminal opens there.',
  'grokPlan:openInstallGuide': 'Set up your Grok subscription on your Mac.',
  'connectors:connect': 'Connect apps on your Mac: the sign-in page opens there.',
  'connectors:connectPreset': 'Connect apps on your Mac: the sign-in page opens there.',
  'memory:copyImportPrompt': 'Copy the import prompt on your Mac.',
  'ollama:setup': 'Install local models on your Mac.',
  'update:install': 'Install updates on your Mac.'
}

/** Whole areas that live on the Mac's screen, or never leave it. */
const DENIED_PREFIX: Array<[string, string]> = [
  ['browser:', 'The built-in browser runs on your Mac. Links open in this phone’s browser instead.'],
  ['voice:', 'Voice uses your Mac’s microphone. Use the phone keyboard’s dictation instead.'],
  ['quick:', 'Quick Ask is a Mac shortcut.'],
  ['mini:', 'The mini window is on your Mac.'],
  // The vault: values never leave the Mac, and unlocking it (Touch ID, master password) happens there.
  ['vault:', 'Saved passwords, cards and authenticator codes stay on your Mac. Manage them there.'],
  ['activity:', 'Activity is set up on your Mac.'],
  ['mcp:', 'Apps that use SahilBot are managed on your Mac.'],
  ['remoteServer:', 'An always-on server is linked on your Mac.'],
  // The phone can't change who may connect, or turn Phone access off and lock itself out.
  ['phoneAccess:', 'Phone access is managed on your Mac: Settings → General → Phone access.'],
  // Who may ask the brain (teammates and their scopes) is decided only on the Mac.
  ['team:', 'Your team is managed on your Mac: Settings → General → Phone access → Team.']
]

/** What the app shell asks at startup about the Mac-only parts, answered for a phone without them (no Mac browser tabs). */
export const PHONE_ANSWERS: Record<string, () => unknown> = {
  'browser:state': () => ({ tabs: [], active: 0, canGoBack: false, canGoForward: false, controlling: false, takenOver: false })
}

/** Why a phone may not call `channel` (undefined = allowed). */
export function phoneDenied(channel: string): string | undefined {
  const exact = DENIED[channel]
  if (exact) return exact
  for (const [p, why] of DENIED_PREFIX) if (channel.startsWith(p)) return why
  return undefined
}

/** Purchases and one-time codes are approved only in the Mac's own window; a phone may say no. */
export const PURCHASE_ON_MAC = 'Approve purchases and one-time codes on your Mac. SahilBot asks there too; you can still Deny from here.'

export function purchaseAnswerAllowed(answer: unknown): boolean {
  return answer === 'deny'
}

/** Events that only matter to the Mac's own window (its browser panel, voice, mini window, the vault dialog): not sent to phones. */
export function phoneGetsEvent(event: string): boolean {
  return !/^(browser:|voice:|quick:|vault:|phoneAccess:|team:|mini$|attach:scan$|docs:flush$)/.test(event)
}

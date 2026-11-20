import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Installing the vendors' official CLIs for the subscription connections. SahilBot never downloads or
// runs an installer itself: it opens Terminal with the vendor's own documented one-line installer, so
// the user sees every step, then runs the vendor's own sign-in in the same window.

/** The official installers, as the vendors document them (checked 2026-11-20). */
export const INSTALL_COMMANDS = {
  /** github.com/openai/codex README, "Installing and running Codex CLI". */
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
  /** docs.x.ai/build/overview, "Install". */
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash'
} as const

export const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"

/**
 * Writes a Terminal script that installs the CLI (unless it's already there), then signs in.
 * `find` is shell code that sets BIN to the installed executable; `signIn` runs with "$BIN".
 */
export function installScript(o: { name: string; install?: string; find: string; signIn: string }): string {
  const install = o.install ? [
    `echo "Installing ${o.name} with its official installer:"`,
    `echo "  ${o.install.replace(/"/g, '\\"')}"`,
    'echo',
    `${o.install} || { echo; echo "The install didn't finish. Check your internet connection and try again from SahilBot."; exit 1; }`
  ] : [`echo "${o.name} is already installed."`]
  return [
    '#!/bin/zsh -l',
    `# Opened by SahilBot: installs ${o.name} with its official installer, then signs in. SahilBot never sees your credentials.`,
    ...install,
    o.find,
    `[ -n "$BIN" ] && [ -x "$BIN" ] || { echo; echo "${o.name} installed, but SahilBot couldn't find it. Open a new Terminal window and try again."; exit 1; }`,
    'echo',
    `echo "Installed: $("$BIN" --version 2>/dev/null | head -n 1)"`,
    'echo',
    `echo "Now sign in to ${o.name} in the browser window that opens."`,
    o.signIn,
    'echo',
    'echo "Done. Go back to SahilBot: it checks the connection and sends a test message."',
    ''
  ].join('\n')
}

/** Opens a .command file in Terminal (no Automation permission needed). */
export async function openInTerminal(dir: string, file: string, script: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'Open a terminal on the SahilBot host and run the installer there.' }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, file)
    writeFileSync(path, script, { mode: 0o700 })
    chmodSync(path, 0o700)
    await new Promise<void>((ok, fail) => execFile('/usr/bin/open', ['-a', 'Terminal', path], (error) => (error ? fail(error) : ok())))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

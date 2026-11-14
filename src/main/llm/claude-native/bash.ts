// Claude's native bash tool (bash_20250124, name bash) on top of SahilBot's run_command.
//
// Reference: shared/tool-use-concepts.md § Bash tool declaration — schema-less ({"type": "bash_20250124",
// "name": "bash"}), client-executed; tool_use.input is {"command": "<string>"} or {"restart": true}
// ("check for restart first"); return stdout + stderr. "Commands are untrusted model output": the call
// becomes run_command with the same command, so it gets run_command's classification (read / local /
// external / destructive), hard stops, the write sandbox, taint checks and approvals, unchanged.

export const BASH_TYPE = 'bash_20250124'
export const BASH_NAME = 'bash'

export const bashDef = (): Record<string, unknown> => ({ type: BASH_TYPE, name: BASH_NAME })

export type BashTranslated = { args: Record<string, unknown> } | { error: string }

export function translateBash(input: Record<string, unknown>): BashTranslated {
  // Every run_command call starts a fresh zsh: there is no session to restart.
  if (input.restart === true) return { error: 'There is no long-lived shell to restart: every command already runs in a fresh zsh (in the project folder, else the workspace). Run your next command.' }
  if (typeof input.command !== 'string' || !input.command.trim()) return { error: 'bash needs a command.' }
  return { args: { command: input.command } }
}

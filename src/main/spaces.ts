import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sub } from './paths'

export const DEFAULT_PROMPT = `Help the user with whatever they bring you, and get it done end to end.
Be direct and concise. Prefer doing the work over describing it.
When you are unsure of a fact, say so instead of guessing.
`

/** Each Space's system prompt is a plain Markdown file the user can edit in any editor. */
export class SpaceFiles {
  path(spaceId: string): string {
    return join(sub('spaces', spaceId), 'system.md')
  }

  getPrompt(spaceId: string): string {
    const p = this.path(spaceId)
    if (!existsSync(p)) writeFileSync(p, DEFAULT_PROMPT)
    return readFileSync(p, 'utf8')
  }

  setPrompt(spaceId: string, text: string): void {
    writeFileSync(this.path(spaceId), text)
  }
}

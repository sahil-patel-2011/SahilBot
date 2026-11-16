import type { Db } from '../../db'
import type { SpaceFiles } from '../../spaces'
import type { ToolDef } from '../types'

const COLORS: Record<string, string> = {
  red: '#FF4D4F', orange: '#FF8A1F', amber: '#F59E0B', brown: '#A0612F', green: '#13A10E', teal: '#14B8A6',
  blue: '#0EA5E9', purple: '#7C5CFF', pink: '#EC4899', gray: '#9CA3AF', black: '#1F1F1F'
}

/** Lets a bot set its own name, look and standing instructions (used right after it is created). */
export function updateBotTool(db: Db, files: SpaceFiles, changed: () => void): ToolDef<{ name?: string; instructions?: string; color?: string }> {
  return {
    name: 'update_bot',
    label: 'Bot profile',
    group: 'Bots',
    effect: 'write_local',
    description: 'Update your own bot profile: a short name (1-3 words), your standing instructions (who you are and what you focus on, a few sentences), and/or your color.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 32 },
        instructions: { type: 'string', maxLength: 4000 },
        color: { type: 'string', enum: Object.keys(COLORS) }
      },
      additionalProperties: false,
      minProperties: 1
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      const bot = thread && db.getSpace(thread.spaceId)
      if (!bot || bot.kind !== 'bot') throw new Error('Only a bot in its own chat can update its profile.')
      if (bot.isMain && a.name) throw new Error('The main bot keeps its name.')
      db.updateSpace(bot.id, { ...(a.name ? { name: a.name.trim() } : {}), ...(a.color ? { color: COLORS[a.color] } : {}) })
      if (a.instructions) files.setPrompt(bot.id, a.instructions.trim() + '\n')
      const saved = db.getSpace(bot.id), instructions = files.getPrompt(bot.id)
      const verified = !!saved && (!a.name || saved.name === a.name.trim()) && (!a.instructions || instructions.trim() === a.instructions.trim())
      if (!verified) throw new Error('The profile update did not read back correctly. Check the saved profile before reporting completion.')
      ctx.state.systemSnapshot = undefined
      ctx.state.leanSnapshots = {}
      ctx.state.snapshots = {}
      changed()
      const parts = [a.name && `name "${a.name}"`, a.color && `color ${a.color}`, a.instructions && 'instructions'].filter(Boolean)
      return { text: `Saved and read back your ${parts.join(', ')}. The updated profile applies in this conversation too.`, data: { name: saved!.name, instructions, verified }, verification: { passed: true, criterion: 'Bot profile saved', detail: `Read back the saved profile for ${saved!.name}.` }, display: `updated ${parts.join(', ')}` }
    }
  }
}

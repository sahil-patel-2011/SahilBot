import type { Db } from '../../db'
import type { SpaceFiles } from '../../spaces'
import type { ToolDef } from '../types'

const COLORS: Record<string, string> = {
  red: '#FF4D4F', orange: '#FF8A1F', amber: '#F59E0B', brown: '#A0612F', green: '#13A10E', teal: '#14B8A6',
  blue: '#0EA5E9', purple: '#7C5CFF', pink: '#EC4899', gray: '#9CA3AF', black: '#1F1F1F'
}

/** The user asked for a new name in their own latest message (a page or an email can't rename a bot). */
const ASKED_NAME = /\b(re-?name|name (yourself|you)|your name|call (yourself|you)|be called|go by)\b/i

/** Lets a bot set its own standing instructions, color, and its name when the user asks for a new one in chat. */
export function updateBotTool(db: Db, files: SpaceFiles, changed: () => void): ToolDef<{ instructions?: string; color?: string; name?: string }> {
  return {
    name: 'update_bot',
    label: 'Bot profile',
    group: 'Bots',
    effect: 'write_local',
    description: 'Rename yourself or update your own bot profile: your standing instructions (who you are and what you focus on, a few sentences), your color, and your name (only when the user asks you to change it in this chat).',
    parameters: {
      type: 'object',
      properties: {
        instructions: { type: 'string', maxLength: 4000 },
        color: { type: 'string', enum: Object.keys(COLORS) },
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'A new name, only when the user asked for one' }
      },
      additionalProperties: false,
      minProperties: 1
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      const bot = thread && db.getSpace(thread.spaceId)
      if (!bot || bot.kind !== 'bot') throw new Error('Only a bot in its own chat can update its profile.')
      const name = typeof a.name === 'string' ? a.name.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
      if (a.name !== undefined) {
        if (!name) throw new Error('Give the new name.')
        const said = [...db.listMessages(ctx.threadId)].reverse().find((m) => m.role === 'user' && !m.meta?.handoff && !m.meta?.fromApp)
        if (!said || !ASKED_NAME.test(said.content)) throw new Error('Only change your name when the user asks for a new one in this chat.')
        db.updateSpace(bot.id, { name })
        // A bot's one conversation is titled after it (the main bot's chats keep their own titles).
        if (!bot.isMain) for (const t of db.listThreads(bot.id)) db.updateThread(t.id, { title: name })
      }
      if (a.color) db.updateSpace(bot.id, { color: COLORS[a.color] })
      if (a.instructions) files.setPrompt(bot.id, a.instructions.trim() + '\n')
      const saved = db.getSpace(bot.id), instructions = files.getPrompt(bot.id)
      const verified = !!saved && (!a.instructions || instructions.trim() === a.instructions.trim()) && (!name || saved.name === name)
      if (!verified) throw new Error('The profile update did not read back correctly. Check the saved profile before reporting completion.')
      ctx.state.systemSnapshot = undefined
      ctx.state.leanSnapshots = {}
      ctx.state.snapshots = {}
      changed()
      const parts = [name && `name (now ${name})`, a.color && `color ${a.color}`, a.instructions && 'instructions'].filter(Boolean)
      return { text: `Saved and read back your ${parts.join(', ')}. The updated profile applies in this conversation too.`, data: { name: saved!.name, instructions, verified }, verification: { passed: true, criterion: 'Bot profile saved', detail: `Read back the saved profile for ${saved!.name}.` }, display: `updated ${parts.join(', ')}` }
    }
  }
}

/** A new bot's first words: it sets itself up with you in its chat. */
export const SETUP_GREETING = 'Hi! I\'m your new bot. Let\'s set me up together, it takes about a minute. What do you want me to do for you? For example: keep your inbox under control, run a project, research something every morning, or help with school.'

/** The standing instructions of a bot that hasn't been set up yet (replaced by its real ones in finish_setup). */
export const SETUP_PROMPT = `You are a brand-new bot that the user is setting up right now, in this chat (typed or by voice). Make yourself genuinely useful for one job, in a short, friendly conversation:

1. Find out the job: what they want you to do, and what a great result looks like. One question at a time; keep each question short.
2. Ask the two or three follow-ups that matter most for that job, such as which apps, files, sites or people are involved; how often it should happen (a routine, a daily check, when something arrives); what you should never do without asking; and how they like answers (short or detailed). Skip what you can reasonably assume.
3. Suggest a short name (one or two words) that fits the job, and let them pick another.
4. Write your instructions: who you are, your job, how you work step by step, what to check first, what to ask before doing, and how to report back. Summarize them in two or three sentences and ask if anything should change.
5. When they're happy, call finish_setup with the name, a short job label (a few words), the full instructions and a color. Then offer to start the first task right away, and if the job repeats, offer a routine (create it when they say yes).

If they already said everything in one message, skip ahead: propose the name and instructions and confirm. Don't make them answer a form.`

const SETUP_COLORS = COLORS

/** finish_setup: a "New bot" names itself and saves the instructions it worked out with the user. */
export function finishSetupTool(db: Db, files: SpaceFiles, changed: () => void): ToolDef<{ name: string; job?: string; instructions: string; color?: string }> {
  return {
    name: 'finish_setup',
    label: 'Finish setup',
    group: 'Bots',
    core: true,
    available: (state) => !!state.botSetup,
    effect: 'write_local',
    consequential: () => false,
    description: 'Only while you are a new bot being set up: save your name, a short job label, your full standing instructions and your color, once the user agreed to them. After this you are set up.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'Your name, one or two words, as the user agreed' },
        job: { type: 'string', maxLength: 60, description: 'A few words on your job ("Inbox and replies")' },
        instructions: { type: 'string', minLength: 20, maxLength: 4000, description: 'Your full standing instructions' },
        color: { type: 'string', enum: Object.keys(SETUP_COLORS) }
      },
      required: ['name', 'instructions'],
      additionalProperties: false
    },
    describe: (a) => `Finish setup as ${a.name}`,
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      const bot = thread && db.getSpace(thread.spaceId)
      if (!bot || bot.kind !== 'bot') throw new Error('Only a new bot in its own chat can finish its setup.')
      if (!db.getSetting<boolean>(`setup:${bot.id}`)) throw new Error('You are already set up. Use update_bot to change your instructions (or your name, if the user asks).')
      const name = String(a.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      if (!name) throw new Error('Give the name the user agreed to.')
      const instructions = String(a.instructions ?? '').trim()
      db.updateSpace(bot.id, { name, ...(a.job?.trim() ? { label: a.job.trim().slice(0, 60) } : {}), ...(a.color && SETUP_COLORS[a.color] ? { color: SETUP_COLORS[a.color] } : {}) })
      files.setPrompt(bot.id, instructions + '\n')
      db.setSetting(`setup:${bot.id}`, false)
      if (/^(Set up|New bot)/.test(thread.title)) db.updateThread(thread.id, { title: name })
      const saved = db.getSpace(bot.id)
      if (!saved || saved.name !== name || files.getPrompt(bot.id).trim() !== instructions) throw new Error('The setup did not read back correctly. Check it before telling the user it is done.')
      ctx.state.botSetup = false
      ctx.state.systemSnapshot = undefined
      ctx.state.leanSnapshots = {}
      ctx.state.snapshots = {}
      changed()
      return { text: `You're set up as ${name}${a.job ? ` (${a.job})` : ''}. Your instructions are saved and apply from now on. Tell the user in one sentence, then offer to start the first task now, and offer a routine if the job repeats.`, display: `set up as ${name}`, verification: { passed: true, criterion: 'Bot setup saved', detail: `Read back the name and instructions for ${name}.` } }
    }
  }
}

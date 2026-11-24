import type { Db } from '../../db'
import type { SpaceFiles } from '../../spaces'
import type { ToolDef } from '../types'

const COLORS: Record<string, string> = {
  red: '#FF4D4F', orange: '#FF8A1F', amber: '#F59E0B', brown: '#A0612F', green: '#13A10E', teal: '#14B8A6',
  blue: '#0EA5E9', purple: '#7C5CFF', pink: '#EC4899', gray: '#9CA3AF', black: '#1F1F1F'
}

/** The user asked for a new name in their own latest message (a page or an email can't rename a bot). */
const ASKED_NAME = /\b(re-?name|name (yourself|you|it)|your name|its name|call (yourself|you|it)|be called|go by)\b/i

/** Lets a bot set its own standing instructions, color, and its name when the user asks for a new one in chat. */
export function updateBotTool(db: Db, files: SpaceFiles, changed: () => void): ToolDef<{ instructions?: string; color?: string; name?: string; icon?: string }> {
  return {
    name: 'update_bot',
    label: 'Bot profile',
    group: 'Bots',
    effect: 'write_local',
    description: 'Rename yourself or update your own bot profile: your standing instructions (who you are and what you focus on, a few sentences), your color, your icon (an emoji) and your name (only when the user asks you to change it in this chat). Only yourself: to change another bot ("make it stricter" about a bot just made) use manage_bot with action "update". To make a different, new bot use create_bot; never turn yourself into it.',
    parameters: {
      type: 'object',
      properties: {
        instructions: { type: 'string', maxLength: 4000 },
        color: { type: 'string', enum: Object.keys(COLORS) },
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'A new name, only when the user asked for one' },
        icon: { type: 'string', maxLength: 16, description: 'One emoji for your icon (e.g. 🧪 for a chemistry helper)' }
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
        if (!userAsked(db, ctx.threadId, ASKED_NAME)) throw new Error('Only change your name when the user asks for a new one in this chat.')
        db.updateSpace(bot.id, { name })
        // A bot's one conversation is titled after it (the main bot's chats keep their own titles).
        if (!bot.isMain) for (const t of db.listThreads(bot.id)) db.updateThread(t.id, { title: name })
      }
      if (a.color) db.updateSpace(bot.id, { color: COLORS[a.color] })
      if (a.icon !== undefined) db.updateSpace(bot.id, { icon: a.icon })
      if (a.instructions) files.setPrompt(bot.id, a.instructions.trim() + '\n')
      const saved = db.getSpace(bot.id), instructions = files.getPrompt(bot.id)
      const verified = !!saved && (!a.instructions || instructions.trim() === a.instructions.trim()) && (!name || saved.name === name)
      if (!verified) throw new Error('The profile update did not read back correctly. Check the saved profile before reporting completion.')
      ctx.state.systemSnapshot = undefined
      ctx.state.leanSnapshots = {}
      ctx.state.snapshots = {}
      changed()
      const parts = [name && `name (now ${name})`, a.color && `color ${a.color}`, a.icon && `icon ${a.icon}`, a.instructions && 'instructions'].filter(Boolean)
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

/** The user's own messages in this chat (not a handoff, a page, an app or a relayed note), newest first. */
const ownMessages = (db: Db, threadId: string): string[] =>
  [...db.listMessages(threadId)].reverse().filter((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.handoff && !m.meta?.fromApp && !m.meta?.relayed).map((m) => m.content)
/** "Yes", "go ahead", "Study Buddy": an answer to a question the bot just asked, not a request of its own. */
const CONFIRM = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|please( do)?|confirm(ed)?|that'?s (right|fine|good)|sounds good|perfect|correct)\b/i
const REFUSE = /^\s*(no|nope|nah|don'?t|do not|stop|cancel|wait|never ?mind|not )\b/i
const shortAnswer = (t: string): boolean => !REFUSE.test(t) && (CONFIRM.test(t) || t.trim().split(/\s+/).filter(Boolean).length <= 4)
/**
 * The user asked for this in their own words: their latest message, or (when that is only a "yes" or a short answer
 * to the bot's question, like the name it asked for) one of the two before it. "No" never counts.
 */
export const userAsked = (db: Db, threadId: string, re: RegExp): boolean => {
  const said = ownMessages(db, threadId).slice(0, 3)
  for (const text of said) {
    if (re.test(text)) return true
    if (!shortAnswer(text)) return false
  }
  return false
}
const ASKED_NEW_BOT = /\b(make|create|add|set up|build|start|spin up|new)\b[^.?!]{0,80}\b(bot|assistant|helper|agent)\b/i
const SHAPES = ['blob', 'triangle', 'circle', 'hex', 'drop', 'square', 'pebble', 'star'] as const

/** An emoji that fits a bot's job, for when none was given (every new bot gets an icon). */
const ICONS: Array<[RegExp, string]> = [
  [/\b(chem\w*|lab|science)\b/, '🧪'], [/\b(math|algebra|calculus|geometry)\b/, '📐'], [/\b(homework|study|school|tutor\w*|learn\w*|class(es)?|exam|quiz)\b/, '📚'],
  [/\b(e-?mails?|inbox|mail|replies)\b/, '📬'], [/\b(code|coding|program\w*|developer|software)\b/, '💻'], [/\b(research|news|read\w*)\b/, '🔎'],
  [/\b(write|writing|essay|blog|story|poem)\b/, '✍️'], [/\b(money|budget|finance|invest\w*|stocks?|tax(es)?)\b/, '💰'], [/\b(travel|trip|flights?|vacation)\b/, '✈️'],
  [/\b(fitness|workout|gym|run(ning)?|health)\b/, '💪'], [/\b(cook\w*|recipes?|meals?|food)\b/, '🍳'], [/\b(calendar|schedule|meetings?|plan\w*)\b/, '📅'],
  [/\b(music|songs?|guitar|piano)\b/, '🎵'], [/\b(robot\w*|frc|cad)\b/, '🤖'], [/\b(shop\w*|deals?|buy\w*)\b/, '🛒']
]
export function iconFor(text: string): string {
  const t = text.toLowerCase()
  return ICONS.find(([re]) => re.test(t))?.[1] ?? '✨'
}
const isEmoji = (s: string | undefined): s is string => !!s && /\p{Extended_Pictographic}/u.test(s) && s.trim().length <= 16

export interface CreateBotDeps {
  create: (name: string, color: string, shape: string, icon: string | null) => { spaceId: string; threadId: string }
  setPrompt: (spaceId: string, text: string) => void
  setLabel: (spaceId: string, label: string) => void
  greet: (threadId: string, text: string) => void
  /** A card in the chat that asked: the new bot's icon, name and job, with a button that opens its chat. */
  card?: (threadId: string, bot: { spaceId: string; threadId: string; name: string; icon: string; job: string }) => void
}

/**
 * "Make me a Homework Helper bot": a brand-new bot (its own chat, name, job, icon and color), never a repurposed
 * one. Only when the user asked for it in their own message; it says hello in its new chat.
 */
export function createBotTool(deps: CreateBotDeps, db: Db, changed: () => void): ToolDef<{ name: string; job: string; instructions: string; color?: string; icon?: string }> {
  return {
    name: 'create_bot',
    label: 'New bot',
    group: 'Bots',
    core: true,
    effect: 'write_local',
    description: 'Create a new bot when the user asks for one ("make me a bot that…"): its name, a short job line, its standing instructions (who it is, what it does, how it talks: a few sentences), a color and one emoji icon that fits its job. It gets its own chat and says hello there. Never repurpose yourself or another bot for this.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40 },
        job: { type: 'string', minLength: 1, maxLength: 80, description: 'One line, e.g. "Chemistry and algebra homework help"' },
        instructions: { type: 'string', minLength: 1, maxLength: 4000 },
        color: { type: 'string', enum: Object.keys(COLORS) },
        icon: { type: 'string', maxLength: 16, description: 'One emoji that fits its job, e.g. 🧪 (always give one)' }
      },
      required: ['name', 'job', 'instructions'],
      additionalProperties: false
    },
    async run(a, ctx) {
      if (!userAsked(db, ctx.threadId, ASKED_NEW_BOT)) throw new Error('Only create a bot when the user asks for a new one in their own message.')
      const name = a.name.replace(/\s+/g, ' ').trim().slice(0, 40)
      if (db.listSpaces().some((s) => s.kind === 'bot' && s.name.toLowerCase() === name.toLowerCase())) throw new Error(`A bot named ${name} already exists. Pick another name or ask the user.`)
      const color = COLORS[a.color ?? ''] ?? Object.values(COLORS)[db.listSpaces().length % Object.keys(COLORS).length]
      const shape = SHAPES[db.listSpaces().length % SHAPES.length]
      // Every new bot gets an icon: the one asked for, else one that fits its job.
      const icon = isEmoji(a.icon) ? a.icon.trim() : iconFor(`${name} ${a.job} ${a.instructions}`)
      const { spaceId, threadId } = deps.create(name, color, shape, icon)
      deps.setPrompt(spaceId, a.instructions.trim() + '\n')
      deps.setLabel(spaceId, a.job)
      deps.greet(threadId, `Hi, I'm ${name} ${icon}. ${a.job.replace(/\.$/, '')}: that's my job. What would you like to start with?`)
      changed()
      const saved = db.getSpace(spaceId)
      deps.card?.(ctx.threadId, { spaceId, threadId, name, icon: saved?.icon ?? icon, job: a.job })
      return { text: `Created ${name} ${icon} (${a.job}). It has its own chat in the sidebar and said hello there; a card in this chat opens it. Tell the user in one short sentence.`, data: { spaceId, threadId, name, icon: saved?.icon ?? icon }, display: `created ${name}`, verification: { passed: !!saved, criterion: 'Bot created', detail: `${name} is in the bot list.` } }
    }
  }
}

type BotAction = 'delete' | 'restore' | 'hide' | 'show' | 'pin' | 'unpin' | 'rename' | 'update'

export interface ManageBotDeps {
  /** Deletes a bot so it can be undone (its chat and routines are kept a while); `threadId` is the chat that asked. */
  remove: (spaceId: string, threadId?: string) => void
  /** Brings back a bot deleted a moment ago, with its chat and routines. */
  restore?: (spaceId: string) => void
  pin: (spaceId: string, on: boolean) => void
  getPrompt?: (spaceId: string) => string
  setPrompt?: (spaceId: string, text: string) => void
}

/** What the user's own words must say for each action (a page, an email or another bot can't ask). */
const ASKED_ACTION: Record<BotAction, RegExp> = {
  delete: /\b(delete|remove|get rid of|trash|erase|destroy)\b/i,
  restore: /\b(undo|un-?delete|restore|(bring|put|get) (it|that|\w+( \w+){0,3}) back|take (it|that) back)\b/i,
  hide: /\b(hide|remove .{0,30}from (the )?sidebar)\b/i,
  show: /\b(unhide|show|bring back|put back)\b/i,
  pin: /\bpin\b/i,
  unpin: /\bunpin\b/i,
  rename: /\b(re-?name|call|name|change|title)\b/i,
  update: /\b(make (it|him|her|them)|change|update|edit|set|tell (it|him|her|them)|have (it|him|her|them)|stricter|nicer|shorter|longer|more|less|instructions?|prompt|job|focus|icon|emoji|colou?r|should|always|never|stop)\b/i
}

/** Delete (undoable), restore, hide, show, pin, rename or update another bot when the user asks. */
export function manageBotTool(deps: ManageBotDeps, db: Db, changed: () => void): ToolDef<{ bot: string; action: BotAction; name?: string; instructions?: string; icon?: string; color?: string }> {
  /** The one bot `q` names: its exact name, else the only bot whose name contains it ("Which one…?" when several do). */
  const find = <T extends { name: string }>(q: string, pool: T[]): T | undefined => {
    const raw = q.trim().toLowerCase()
    const t = raw.replace(/^the /, '').replace(/ bot$/, '')
    const exact = pool.find((s) => s.name.toLowerCase() === raw || s.name.toLowerCase() === t)
    if (exact) return exact
    const near = pool.filter((s) => s.name.toLowerCase().includes(t))
    if (near.length > 1) throw new Error(`Which one: ${near.map((s) => s.name).join(' or ')}? Ask the user.`)
    return near[0]
  }
  return {
    name: 'manage_bot',
    label: 'Manage bot',
    group: 'Bots',
    core: true,
    // Deleting can be undone (action "restore", the Undo button, "undo"), so like any ordinary change it asks no card.
    effect: 'write_local',
    describe: (a) => (a.action === 'delete' ? `Delete the bot ${a.bot}` : a.action === 'rename' ? `Rename ${a.bot} to ${a.name ?? ''}` : a.action === 'update' ? `Update ${a.bot}` : a.action === 'restore' ? `Bring back ${a.bot}` : `${a.action[0].toUpperCase()}${a.action.slice(1)} ${a.bot}`),
    description: 'Change another bot when the user asks: delete, hide, show, pin, unpin or rename it, or update its instructions, icon or color ("make it stricter", "give it a 🧪 icon"). Deleting removes the bot and its chat at once and can be undone for a few minutes: when the user says "undo" or wants it back, use action "restore". The main bot can only be renamed, pinned or updated. To change yourself use update_bot.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'The bot\'s name' },
        action: { type: 'string', enum: ['delete', 'restore', 'hide', 'show', 'pin', 'unpin', 'rename', 'update'] },
        name: { type: 'string', maxLength: 40, description: 'The new name (rename)' },
        instructions: { type: 'string', maxLength: 4000, description: 'update: its full new standing instructions (the old ones with the change made)' },
        icon: { type: 'string', maxLength: 16, description: 'update: one emoji' },
        color: { type: 'string', enum: Object.keys(COLORS), description: 'update: its color' }
      },
      required: ['bot', 'action'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const asked = ASKED_ACTION[a.action]
      if (!asked) throw new Error(`Unknown action "${String(a.action)}".`)
      if (!userAsked(db, ctx.threadId, asked)) throw new Error('Only change a bot when the user asks in their own message.')
      if (a.action === 'restore') {
        const gone = find(a.bot, db.trashedSpaces())
        if (!gone || !deps.restore) throw new Error(`There is no recently deleted bot called "${a.bot}" to bring back.`)
        deps.restore(gone.id)
        changed()
        const back = !db.trashedAt(gone.id) && !!db.getSpace(gone.id)
        return { text: `Brought back ${gone.name} with its chat and routines.`, display: `brought back ${gone.name}`, verification: { passed: back, criterion: 'Bot restored', detail: `${gone.name} is in the bot list again.` } }
      }
      const bots = db.listSpaces().filter((s) => s.kind === 'bot')
      const bot = find(a.bot, bots)
      if (!bot) throw new Error(`No bot called "${a.bot}". Bots: ${bots.map((s) => s.name).join(', ')}.`)
      if (bot.isMain && !['rename', 'pin', 'unpin', 'update'].includes(a.action)) throw new Error('The main bot can be renamed, pinned or updated, not deleted or hidden.')
      let detail = ''
      if (a.action === 'delete') deps.remove(bot.id, ctx.threadId)
      else if (a.action === 'hide' || a.action === 'show') db.updateSpace(bot.id, { hidden: a.action === 'hide' })
      else if (a.action === 'pin' || a.action === 'unpin') deps.pin(bot.id, a.action === 'pin')
      else if (a.action === 'rename') {
        const name = (a.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
        if (!name) throw new Error('Give the new name.')
        if (bots.some((s) => s.id !== bot.id && s.name.toLowerCase() === name.toLowerCase())) throw new Error(`A bot named ${name} already exists. Pick another name or ask the user.`)
        db.updateSpace(bot.id, { name })
        if (db.getSetting<boolean>(`setup:${bot.id}`)) db.setSetting(`setup:${bot.id}`, false)
        if (!bot.isMain) for (const t of db.listThreads(bot.id)) db.updateThread(t.id, { title: name })
        // Its instructions say who it is ("You are Homework Helper…"): they follow the new name.
        const prompt = deps.getPrompt?.(bot.id)
        if (prompt && deps.setPrompt && prompt.includes(bot.name)) deps.setPrompt(bot.id, prompt.split(bot.name).join(name))
        detail = ` (now ${name})`
      } else {
        const changes: string[] = []
        const instructions = a.instructions?.trim()
        if (instructions) {
          if (!deps.setPrompt) throw new Error('That bot\'s instructions can\'t be changed from here.')
          deps.setPrompt(bot.id, instructions + '\n')
          if (db.getSetting<boolean>(`setup:${bot.id}`)) db.setSetting(`setup:${bot.id}`, false)
          changes.push('instructions')
        }
        if (a.icon !== undefined) {
          if (!isEmoji(a.icon)) throw new Error('The icon must be one emoji.')
          db.updateSpace(bot.id, { icon: a.icon.trim() })
          changes.push(`icon ${a.icon.trim()}`)
        }
        if (a.color && COLORS[a.color]) { db.updateSpace(bot.id, { color: COLORS[a.color] }); changes.push(`color ${a.color}`) }
        if (!changes.length) throw new Error('Say what to change: its instructions (the full new text), its icon or its color.')
        if (instructions && deps.getPrompt && deps.getPrompt(bot.id).trim() !== instructions) throw new Error('The new instructions did not read back correctly.')
        // Changed from its own chat: its next step starts from the new profile.
        if (bot.id === db.getThread(ctx.threadId)?.spaceId) { ctx.state.systemSnapshot = undefined; ctx.state.leanSnapshots = {}; ctx.state.snapshots = {} }
        detail = `: ${changes.join(', ')}`
      }
      changed()
      if (a.action === 'delete') return { text: `Deleted ${bot.name} and its chat. This chat shows "Deleted ${bot.name} · Undo". If the user says undo or wants it back, call manage_bot with action "restore" and bot "${bot.name}". Tell the user in one short sentence that it is deleted and they can undo it.`, data: { undoBot: bot.id, name: bot.name }, display: `deleted ${bot.name}` }
      const done = { hide: 'Hid', show: 'Showed', pin: 'Pinned', unpin: 'Unpinned', rename: 'Renamed', update: 'Updated' }[a.action]
      return { text: `${done} ${bot.name}${detail}.`, display: `${done.toLowerCase()} ${bot.name}` }
    }
  }
}

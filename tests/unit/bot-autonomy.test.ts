import { describe, expect, test } from 'vitest'
import { botHardStop, decide, hardStopText, MASS_SEND_MIN, OTP_STOP, PURCHASE_STOP, recipientCount } from '../../src/main/agent/permissions'
import { decideWithRule } from '../../src/main/agent/loop'
import { BOT_AUTONOMY_DEFAULTS, botAutonomyConfig, botLevel, cleanBotAutonomy, isAlwaysOnBot, recommendedDefault, safeToDefault } from '../../src/main/agent/questions/policy'
import { migrateBotAutonomy, migratePermissionLevels } from '../../src/main/spaces'
import type { PermissionInput } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ToolEffect } from '../../src/shared/types'

// Always-on bots: Auto by default, hard stops that still stop, taint that still asks, and the
// user's "Always ask for…" exceptions. Regular chats keep the app default.

const base: PermissionInput = { mode: 'autonomous', effect: 'read', tool: 't', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false }

/** What an always-on bot does with a call: decide() and then the bot's hard stops (as loop.ts botStops does). */
function botVerdict(p: Partial<PermissionInput> & { summary?: string; label?: string; args?: unknown; alwaysAsk?: string[]; rule?: 'allow' | 'ask' | null }): 'allow' | 'ask' | 'deny' {
  const input = { ...base, ...p }
  const d = decideWithRule(input, p.rule ?? null)
  if (d.verdict !== 'allow') return d.verdict
  return botHardStop({ tool: input.tool, effect: input.effect as ToolEffect, args: p.args ?? {}, label: p.label, summary: p.summary, hardStop: input.hardStop, alwaysAsk: p.alwaysAsk }) ? 'ask' : 'allow'
}

describe('autonomy level defaults', () => {
  const settings = { defaultMode: 'auto' as const, botModes: {} }
  test('a bot works at Auto; the main chat, groups and projects keep the app default', () => {
    expect(botLevel(settings, { id: 'b', kind: 'bot', isMain: false })).toBe('auto')
    expect(botLevel({ defaultMode: 'ask' }, { id: 'b', kind: 'bot', isMain: false })).toBe('auto')
    // A level saved under the old name reads as Auto.
    expect(botLevel({ botModes: { b: 'autonomous' } }, { id: 'b', kind: 'bot', isMain: false })).toBe('auto')
    expect(botLevel(settings, { id: 'm', kind: 'bot', isMain: true })).toBe('auto')
    expect(botLevel(settings, { id: 'g', kind: 'group', isMain: false })).toBe('auto')
    expect(botLevel(settings, { id: 'p', kind: 'project', isMain: false })).toBe('auto')
    expect(botLevel({ defaultMode: 'ask' }, { id: 'm', kind: 'bot', isMain: true })).toBe('ask')
    expect(isAlwaysOnBot({ kind: 'bot', isMain: false })).toBe(true)
    expect(isAlwaysOnBot({ kind: 'bot', isMain: true })).toBe(false)
  })
  test('the level the user picked for a bot wins, and Bypass is never a default', () => {
    expect(botLevel({ botModes: { b: 'ask' } }, { id: 'b', kind: 'bot', isMain: false })).toBe('ask')
    expect(botLevel({ botModes: { b: 'auto' } }, { id: 'b', kind: 'bot', isMain: false })).toBe('auto')
    expect(botLevel({ botModes: { b: 'bypass' as never } }, { id: 'b', kind: 'bot', isMain: false })).toBe('auto')
  })
  test('the old "move bots to Autonomous" step changes nothing now (Auto is what Autonomous was), and stays done', () => {
    const db = new Db(':memory:')
    const bot = db.createSpace('Scout', '#111')
    const botT = db.createThread(bot.id, 'auto', null)
    const askT = db.createThread(bot.id, 'ask', null)
    expect(migrateBotAutonomy(db, { botModes: {} })).toBe(0)
    expect(db.getThread(botT.id)!.permissionMode).toBe('auto')
    expect(db.getThread(askT.id)!.permissionMode).toBe('ask')
    expect(db.getSetting('botAutonomyDefaultV1')).toBe(1)
  })
  test('migration: "autonomous" chats and settings become Auto; Auto chats lose a stale thinking level; once only', () => {
    const db = new Db(':memory:')
    const main = db.createSpace('SahilBot', '#000', { isMain: true })
    const bot = db.createSpace('Scout', '#111')
    const a = db.createThread(bot.id, 'autonomous', null)
    const ask = db.createThread(bot.id, 'ask', null)
    const bypass = db.createThread(main.id, 'bypass', null)
    // Thinking: an Auto chat (its own Auto, or none with the app on Auto) drops it; a picked model keeps it.
    const autoChat = db.updateThread(db.createThread(main.id, 'auto', 'auto').id, { effort: 'high' })
    const inherit = db.updateThread(db.createThread(main.id, 'auto', null).id, { effort: 'low' })
    const picked = db.updateThread(db.createThread(main.id, 'auto', 'claude-opus-5-5').id, { effort: 'max' })
    const local = db.updateThread(db.createThread(main.id, 'auto', 'auto:local').id, { effort: 'medium' })
    const saved: Array<Record<string, unknown>> = []
    const n = migratePermissionLevels(db, { defaultModel: 'auto', defaultMode: 'autonomous' as never, botModes: { [bot.id]: 'autonomous' as never, x: 'ask' }, thinking: 'high' }, (p) => saved.push(p))
    expect(n).toBeGreaterThanOrEqual(5)
    expect(db.getThread(a.id)!.permissionMode).toBe('auto')
    expect(db.getThread(ask.id)!.permissionMode).toBe('ask')
    expect(db.getThread(bypass.id)!.permissionMode).toBe('bypass')
    expect(db.getThread(autoChat.id)!.effort).toBeNull()
    expect(db.getThread(inherit.id)!.effort).toBeNull()
    expect(db.getThread(local.id)!.effort).toBeNull()
    expect(db.getThread(picked.id)!.effort).toBe('max')
    expect(saved).toEqual([{ defaultMode: 'auto', botModes: { [bot.id]: 'auto', x: 'ask' }, thinking: 'auto' }])
    // Once only.
    db.updateThread(a.id, { permissionMode: 'autonomous' })
    expect(migratePermissionLevels(db, { defaultModel: 'auto', defaultMode: 'auto', botModes: {}, thinking: 'high' }, () => undefined)).toBe(0)
    expect(db.getThread(a.id)!.permissionMode).toBe('autonomous')
  })
  test('migration with a concrete default model keeps the app\'s thinking and chats that inherit that model', () => {
    const db = new Db(':memory:')
    const main = db.createSpace('SahilBot', '#000', { isMain: true })
    const inherit = db.updateThread(db.createThread(main.id, 'auto', null).id, { effort: 'low' })
    const saved: Array<Record<string, unknown>> = []
    migratePermissionLevels(db, { defaultModel: 'claude-opus-5-5', defaultMode: 'ask', botModes: {}, thinking: 'high' }, (p) => saved.push(p))
    expect(db.getThread(inherit.id)!.effort).toBe('low')
    expect(saved).toEqual([])
  })
  test('per-bot settings are cleaned: exceptions trimmed and capped, deadline 15 min to a week, HH:MM digest', () => {
    expect(cleanBotAutonomy(undefined)).toEqual(BOT_AUTONOMY_DEFAULTS)
    const c = cleanBotAutonomy({ alwaysAsk: ['  send   email ', 'Send email', '', 5, ...Array.from({ length: 30 }, (_, i) => `x${i}`)], deadlineHours: 0.01, digest: { enabled: false, time: '7:05' } })
    expect(c.alwaysAsk[0]).toBe('send email')
    expect(c.alwaysAsk).toHaveLength(20)
    expect(c.deadlineHours).toBe(0.25)
    expect(c.digest).toEqual({ enabled: false, time: '07:05' })
    expect(cleanBotAutonomy({ deadlineHours: 9999, digest: { time: '25:00' } })).toMatchObject({ deadlineHours: 168, digest: { enabled: true, time: '18:00' } })
    expect(botAutonomyConfig({ botAutonomy: { b: { deadlineHours: 8 } } }, 'b').deadlineHours).toBe(8)
  })
})

describe('an Autonomous bot: what runs, what asks', () => {
  test('routine work runs without asking', () => {
    expect(botVerdict({ effect: 'read', tool: 'web_search' })).toBe('allow')
    expect(botVerdict({ effect: 'write_local', tool: 'file_write', summary: 'Write ~/SahilBot/report.md' })).toBe('allow')
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'browser', summary: 'Click "Next page" on example.com' })).toBe('allow')
    expect(botVerdict({ effect: 'write_external', consequential: 'project', tool: 'run_command', summary: 'npm ci' })).toBe('allow')
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'gmail__create_draft', summary: 'Save a draft to Sam' })).toBe('allow')
    expect(botVerdict({ effect: 'destructive', tool: 'file_write', summary: 'Overwrite ~/SahilBot/notes.md (backup kept)' })).toBe('allow')
  })
  test('a single send runs in Auto; Ask asks unless "Always allow"; a send steered by outside content asks', () => {
    const send = { effect: 'write_external' as const, consequential: true, tool: 'gmail__send_email', summary: 'Send email to sam@x.com', args: { to: 'sam@x.com' } }
    expect(botVerdict(send)).toBe('allow')
    expect(botVerdict({ ...send, tainted: true })).toBe('ask')
    expect(botVerdict({ ...send, mode: 'ask' })).toBe('ask')
    expect(botVerdict({ ...send, mode: 'ask', alwaysAllowed: true })).toBe('allow')
  })
  test('hard stops still stop, even with "Always allow" or an Allow rule', () => {
    const many = { to: Array.from({ length: MASS_SEND_MIN }, (_, i) => `p${i}@x.com`) }
    expect(recipientCount(many)).toBe(MASS_SEND_MIN)
    expect(recipientCount({ to: 'a@x.com, b@x.com', cc: ['c@x.com'], body: 'd@x.com' })).toBe(3)
    // Mass sends.
    expect(botVerdict({ effect: 'write_external', tool: 'gmail__send_email', summary: 'Send email', alwaysAllowed: true, args: many })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', tool: 'mailchimp__send_campaign', label: 'Mailchimp', summary: 'Send the newsletter campaign', rule: 'allow' })).toBe('ask')
    // Money moves.
    expect(botVerdict({ effect: 'write_external', tool: 'stripe__create_refund', summary: 'Refund $40 to Sam', alwaysAllowed: true })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', tool: 'bank__transfer', summary: 'Transfer $200 to savings', rule: 'allow' })).toBe('ask')
    // Credentials.
    expect(botVerdict({ effect: 'write_external', tool: 'browser', consequential: false, summary: 'Type the verification code into the 2FA field' })).toBe('ask')
    expect(botVerdict({ effect: 'write_local', tool: 'vault_save', summary: 'Save a login' })).toBe('ask')
    // Deleting the user's data.
    expect(botVerdict({ effect: 'destructive', tool: 'notion__delete_page', alwaysAllowed: true, rule: 'allow' })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', tool: 'gmail__batch_modify', consequential: false, summary: 'Delete 40 emails' })).toBe('ask')
    expect(botVerdict({ effect: 'destructive', tool: 'file_manage', hardStop: 'deleting notes.txt (it goes to the Trash)' })).toBe('ask')
    // Public posts.
    expect(botVerdict({ effect: 'write_external', tool: 'x__create_tweet', label: 'X', summary: 'Post a tweet', alwaysAllowed: true })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', tool: 'linkedin__share', label: 'LinkedIn', summary: 'Publish the post on LinkedIn', rule: 'allow' })).toBe('ask')
  })
  test('purchases and one-time codes keep their own cards (no second, generic card)', () => {
    expect(botHardStop({ tool: 'browser', effect: 'write_external', args: {}, summary: 'Click "Place order"', hardStop: `${PURCHASE_STOP}Place order on shop.com` })).toBeNull()
    expect(botHardStop({ tool: 'browser', effect: 'write_external', args: {}, hardStop: `${OTP_STOP}example.com` })).toBeNull()
    expect(decide({ ...base, effect: 'write_external', tool: 'browser', hardStop: `${PURCHASE_STOP}Place order` }).verdict).toBe('allow')
  })
  test('anything the user listed under "Always ask for…" asks, even a routine step or a read', () => {
    const alwaysAsk = ['calendar', 'tool:github__*']
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'gcal__create_event', label: 'Google Calendar', summary: 'Add "Dentist" to your calendar', alwaysAsk })).toBe('ask')
    expect(botVerdict({ effect: 'read', tool: 'github__list_issues', alwaysAsk })).toBe('ask')
    expect(botVerdict({ effect: 'write_local', tool: 'file_write', summary: 'Write notes.md', alwaysAsk })).toBe('allow')
    expect(botHardStop({ tool: 'gcal__create_event', effect: 'write_external', args: {}, label: 'Google Calendar', alwaysAsk })?.kind).toBe('always_ask')
  })
  test('taint still asks: an outside action using content from a web page or email', () => {
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'browser', tainted: true })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', consequential: 'project', tool: 'run_command', tainted: true })).toBe('ask')
    expect(botVerdict({ effect: 'write_external', tool: 'gmail__send_email', tainted: true, alwaysAllowed: true })).toBe('ask')
    expect(botVerdict({ effect: 'read', tool: 'fetch_page', tainted: true })).toBe('ask')
    // An Allow rule never vouches for tainted arguments either.
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'browser', tainted: true, rule: 'allow' })).toBe('ask')
  })
  test('secrets are refused outright', () => {
    expect(botVerdict({ effect: 'write_external', consequential: false, tool: 'browser', leaksSecret: true })).toBe('deny')
  })
})

describe('question defaults a deadline may use', () => {
  test('the recommended default: explicit, marked "(recommended)", else the first option', () => {
    expect(recommendedDefault({ question: 'Format?', options: ['PDF', 'Word'], default: 'Word' })).toBe('Word')
    expect(recommendedDefault({ question: 'Format?', options: ['PDF', 'Word (recommended)'] })).toBe('Word (recommended)')
    expect(recommendedDefault({ question: 'Format?', options: ['PDF', 'Word'] })).toBe('PDF')
    expect(recommendedDefault({ question: 'What should I call it?' })).toBeUndefined()
  })
  test('only reversible, safe defaults go ahead; hard stops and unsafe ones wait', () => {
    expect(safeToDefault({ question: 'Which format for the report?', options: ['PDF (recommended)', 'Word'] })).toEqual({ ok: true, answer: 'PDF' })
    expect(safeToDefault({ question: 'Name?' }).ok).toBe(false)
    expect(safeToDefault({ question: 'Should I buy the 2-pack or the 4-pack?', options: ['2-pack', '4-pack'] }).ok).toBe(false)
    expect(safeToDefault({ question: 'Delete the old drafts?', options: ['Yes', 'No'] }).ok).toBe(false)
    expect(safeToDefault({ question: 'Post the announcement on LinkedIn now?', options: ['Yes', 'Later'] }).ok).toBe(false)
    expect(safeToDefault({ question: 'Which email address should I log in with?', options: ['work', 'home'] }).ok).toBe(false)
    expect(safeToDefault({ question: 'Archive or keep?', options: ['Keep', 'Archive'] }, { declaredUnsafe: true }).ok).toBe(false)
    expect(hardStopText('Send the newsletter to all subscribers?')).toBeTruthy()
    expect(hardStopText('Weekly or monthly summary?')).toBeNull()
  })
})

describe('unattended runs (routines, wake-ups)', () => {
  const v = (p: Partial<PermissionInput>) => decide({ ...base, unattended: true, ...p }).verdict
  test('a chat that is not an always-on bot\'s works fully in Auto when nobody watches; Ask and taint still ask', () => {
    expect(v({ effect: 'write_external', consequential: 'project', tool: 'run_command' })).toBe('allow')
    expect(v({ effect: 'destructive', tool: 'file_write' })).toBe('allow')
    expect(v({ effect: 'write_external', consequential: false })).toBe('allow')
    expect(v({ effect: 'write_external', consequential: true, tool: 'gmail__send_email', tainted: true })).toBe('ask')
    expect(v({ effect: 'write_external', consequential: true, tool: 'stripe__create_refund', spends: true })).toBe('ask')
    expect(v({ mode: 'ask', effect: 'destructive', tool: 'file_write' })).toBe('ask')
  })
  test('an always-on bot at Auto keeps full Auto: project commands and backed-up overwrites run', () => {
    for (const mode of ['auto', 'autonomous'] as const) {
      expect(v({ alwaysOn: true, mode, effect: 'write_external', consequential: 'project', tool: 'run_command' })).toBe('allow')
      expect(v({ alwaysOn: true, mode, effect: 'destructive', tool: 'file_write' })).toBe('allow')
      expect(v({ alwaysOn: true, mode, effect: 'write_local' })).toBe('allow')
    }
    // Its own level is still its level: an Ask bot doesn't loosen.
    expect(v({ alwaysOn: true, mode: 'ask', effect: 'write_local' })).toBe('ask')
    expect(v({ alwaysOn: true, mode: 'ask', effect: 'write_external', consequential: 'project', tool: 'run_command' })).toBe('ask')
  })
  test('the bot\'s hard stops, taint and the purchase / code gates are exactly as before', () => {
    // A single send runs in Auto now; deleting the user's data is still one of an always-on bot's own hard stops.
    expect(v({ alwaysOn: true, effect: 'write_external', consequential: true, tool: 'gmail__send_email' })).toBe('allow')
    expect(v({ alwaysOn: true, effect: 'write_external', consequential: true, tool: 'gmail__send_email', tainted: true })).toBe('ask')
    expect(botVerdict({ unattended: true, alwaysOn: true, effect: 'destructive', tool: 'file_manage', hardStop: 'deleting notes.txt (it goes to the Trash)' })).toBe('ask')
    expect(v({ alwaysOn: true, effect: 'write_external', consequential: 'project', tool: 'run_command', tainted: true })).toBe('ask')
    expect(v({ alwaysOn: true, effect: 'read', tool: 'fetch_page', tainted: true })).toBe('ask')
    expect(v({ alwaysOn: true, effect: 'write_external', tool: 'browser', hardStop: `${PURCHASE_STOP}Place order` })).toBe('allow')
    expect(v({ alwaysOn: true, effect: 'write_external', tool: 'browser', hardStop: `${OTP_STOP}example.com` })).toBe('allow')
    expect(botVerdict({ unattended: true, alwaysOn: true, effect: 'write_external', consequential: false, tool: 'x__create_tweet', label: 'X', summary: 'Post a tweet' })).toBe('ask')
    expect(botVerdict({ unattended: true, alwaysOn: true, effect: 'write_external', tool: 'bank__transfer', summary: 'Transfer $50', alwaysAllowed: true })).toBe('ask')
  })
})

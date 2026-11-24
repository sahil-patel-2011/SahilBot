import { CAD_RE } from '../cad/cad-intent'
import { isMedicalQuestion } from './medical-check'
import { VIDEO_RE } from './video-intent'
import { IMAGE_RE, SAHILBOT_BOT, classifyTask as classifyRequest, type TaskCategory as RouteCategory, type TaskClass as RouteClass } from '../llm/task-classifier'

/**
 * Which on-demand tools a request needs, read from the request itself. Heavy tools (computer use, code,
 * pages…) aren't sent with every request: that keeps the prompt small and fast on local models. A
 * request that clearly needs them gets them loaded before the first step; anything else is one
 * find_tools call away, and a tool a chat has used stays loaded for that chat.
 */


export { IMAGE_RE, VIDEO_RE }

/** An email to write from the user's words ("Write a short email to my landlord about the leak"). */
const COMPOSE_ONLY = /^(?:(?:please|pls|can you|could you|hey|help me|i need to|i want to|i'?d like to|let'?s)[,\s]+)*(?:(write|draft|compose)( me)? (a|an)\b[^.?!]{0,40}?\be-?mail\b|e-?mail (my|the|a|an) [^.?!]{0,60}[,.;]\s*(write|draft) it\b)/i
/** Anything that needs the mailbox: reading, replying, forwarding, sending, finding an earlier email. */
const MAILBOX = /\b(inbox|repl(y|ies)|forward|thread|unread|send (it|this|that|them)|and send|send to|e-?mails? (from|about) .{0,30}\b(earlier|last|yesterday)|my (e-?mails?|mail)|gmail|apple mail|attach)\b/i

const GROUPS: Array<{ tools: string[]; when: { test(text: string): boolean } }> = [
  {
    tools: ['code', 'git', 'jobs'],
    when: /\b(code|coding|bug|bugs|debug|tests?|unit test|repo|repository|git|commit|branch|pull request|\bPR\b|merge|function|class|compile|build|lint|typecheck|npm|pnpm|yarn|pip|python|typescript|javascript|java|kotlin|swift|rust|golang|c\+\+|refactor|stack ?trace|exception|deploy|dev server|localhost|api endpoint|wpilib|gradle|robot code)\b/i
  },
  {
    tools: ['computer', 'app', 'app_help'],
    when: /\b(click|double[- ]click|screen|screenshot|desktop|mouse|cursor on|type (it )?in(to)?|on my mac|open (the )?app|finder|safari|chrome|numbers|keynote|pages app|excel|word doc|powerpoint|slack|imessage|messages app|spotify|apple music|xcode|vs ?code|system settings|preview app|menu bar|window)\b/i
  },
  {
    tools: ['create_page', 'update_page'],
    when: /\b(dashboard|chart|graph|plot|visuali[sz]e|interactive|calculator|planner|tracker|timeline|comparison table|infographic|web page|landing page|slide-?style)\b/i
  },
  {
    tools: ['doc_create', 'doc_read', 'doc_edit', 'doc_export'],
    when: /\b(docs?|document|draft|write( up)?|rewrite|edit|paragraph|section|heading|report|memo|letter|essay|notes|outline|proposal|resume|cv|spreadsheet|sheet|rows?|columns?|checklist|agenda|minutes|brief|article|blog post|cover letter|deck|slides?|presentation|pitch|pptx|powerpoint|keynote|odp|pdf|word|docx|dashboard|kpis?|scorecard|artifacts?)\b/i
  },
  {
    tools: ['research'],
    // Any health question (medical-check.ts: clinical terms, conditions, doses, drug names) gets the medical sources.
    when: { test: (t: string) => /\b(stud(y|ies)|pubmed|clinical( trial)?s?|paper|papers|arxiv|doi|journal|peer[- ]reviewed|drug|dosage|fda|side effects?|medical|diagnos|symptom|research)\b/i.test(t) || isMedicalQuestion(t) }
  },
  {
    // Travel and places (tools/maps.ts): trips, directions, distances, what's nearby, itineraries.
    tools: ['maps'],
    when: /\b(trips?|travel(l?ing)?|itinerar(y|ies)|vacation|getaway|road ?trip|directions?|route to|how (far|long does it take)|drive to|walk(ing)? to|commute|distance (from|to|between)|near me|nearby|close to|around here|restaurants?|cafes?|caf\u00e9s?|coffee shops?|hotels?|things to do|sights|sightseeing|attractions?|museums?|neighbou?rhoods?|google maps|maps?|where (is|can i)|places? to (eat|stay|visit|go)|ev charg\w*|gas station|pharmacy near|(good|best|cheap|late[- ]night) (food|eats|ramen|sushi|pizza|tacos|brunch|dinner|lunch|breakfast|bars?|coffee)|near (?!(the )?(future|term|end)\b)[a-z]+)\b/i
  },
  {
    tools: ['mail'],
    // Writing an email from what the user said ("Draft a two-line email to my landlord") needs no mailbox; reading,
    // replying, forwarding or sending does.
    when: { test: (t: string) => /\b(e-?mails?|inbox|gmail|mail app|apple mail|unread|reply to|draft (a|an|the)? ?(reply|email)|newsletter|unsubscribe)\b/i.test(t)
      && !(COMPOSE_ONLY.test(t) && !MAILBOX.test(t)) }
  },
  // CAD (src/main/cad/cad-intent.ts owns the words): the design workflow, Onshape, and FreeCAD when installed.
  { tools: ['cad_design', 'onshape', 'freecad'], when: CAD_RE },
  // Coding agents (docs/coding-agents.md): Cursor's cloud and local agents, with the code and git tools to review their work.
  { tools: ['cursor', 'code', 'git'], when: /\b(cursor('s)? (cloud |local |background )?agents?|coding agents?|to cursor|codex|claude code)\b|\bcursor\b.{0,60}\b(pr|pull request|repo|diff|bug|branch|merge)\b/i },
  // Videos through the user's HeyGen connectors (tools/video.ts): avatar videos, dubbing, motion graphics.
  { tools: ['video'], when: VIDEO_RE },
  // Pictures: the GPT image models (tools/media.ts).
  { tools: ['image'], when: IMAGE_RE }
]

/** Words in an app's name too generic to mean that app on their own. */
const GENERIC = new Set(['google', 'microsoft', 'apple', 'cloud', 'online', 'workspace', 'app', 'apps', 'web', 'browser', 'sahilbot', 'the', 'and', 'for', 'business', 'platform', 'mcp', 'server', 'remote', 'local'])

/**
 * A connected app's tools, when the request names that app ("check my Notion", "post it in Slack", "what's on
 * my calendar"): loaded before the first step, so the model calls the app right away instead of spending a step
 * finding its tools. At most `cap` tools in all.
 */
export function appToolsFor(text: string, tools: Array<{ name: string; group?: string; connector?: boolean }>, cap = 40): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ')} `
  const said = (group: string): boolean => {
    const name = group.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()
    if (name && t.includes(` ${name} `)) return true
    return name.split(' ').some((w) => w.length >= 4 && !GENERIC.has(w) && (t.includes(` ${w} `) || t.includes(` ${w}s `)))
  }
  const groups = [...new Set(tools.filter((x) => x.connector && x.group).map((x) => x.group!))].filter(said)
  return tools.filter((x) => x.connector && x.group && groups.includes(x.group)).map((x) => x.name).slice(0, cap)
}

/** Tools to load for a request (only names that exist in `known`). */
export function intentTools(text: string, known: Set<string>, extra: { codeProject?: boolean } = {}): string[] {
  const out = new Set<string>()
  for (const g of GROUPS) if (g.when.test(text)) for (const t of g.tools) out.add(t)
  // A chat about a code project (a project folder with a repo or package file) gets the coding tools.
  if (extra.codeProject) for (const t of GROUPS[0].tools) out.add(t)
  // "Make me a bot … with its own icon": the icon is an emoji create_bot picks, not a picture to generate.
  if (out.has('image') && SAHILBOT_BOT.test(text.toLowerCase()) && !IMAGE_RE.test(text.replace(/\b(icons?|emojis?|avatars?)\b/gi, ''))) out.delete('image')
  return [...out].filter((t) => known.has(t))
}

/**
 * Every on-demand tool a request might load, except the screen and app tools, plus read_result (the call an
 * offloaded result points to): what a Claude chat on a big window loads up front (loop.ts), so the cached
 * tool list stays the same for the whole chat. Only names that exist in `known`.
 */
export function likelyTools(known: Set<string>): string[] {
  // The CAD tools stay on demand too (big schemas most chats never use).
  // So do the video tools (credits, and most chats never make a video).
  const out = GROUPS.filter((g) => !g.tools.includes('computer') && !g.tools.includes('cad_design') && !g.tools.includes('video')).flatMap((g) => g.tools)
  return ['read_result', ...out].filter((t) => known.has(t))
}

// ---------------------------------------------------------------------------------------------------
// Chat or agent: does this request need the full agent (plan, work tools, self-check), or is it a chat
// (conversation, a question, advice, a short piece of writing) that answers right away with a lean prompt?
// A chat can still search the web, read a page, use memory and connected apps, and call find_tools, which
// turns it into agent work from the next step on (loop.ts). Instant and local: no model call.
// This is the same decision as the router's (llm/task-classifier.ts classifyTask: category, difficulty, kind
// and effort come out of one function), so "coding" never runs as a chat and a chat is never routed as agent
// work. loop.ts passes the routed decision in (`route`); called alone, it decides the same way.
// ---------------------------------------------------------------------------------------------------

export type TaskKind = 'chat' | 'agent'

export interface TaskContext {
  /** The user message's flags: Plan first, Team of Experts, Deep Research, Heavy, Council. */
  flags?: Record<string, unknown>
  /** Attached files that aren't images (read with file tools), and attached folders. */
  files?: number
  folders?: number
  /** The chat has an unfinished plan (a task in progress). */
  openPlan?: boolean
  /** How the previous request in this chat ran (a follow-up like "yes, do it" keeps it). */
  previous?: TaskKind
  /** The previous request's category (follow-ups keep it), when known. */
  previousCategory?: RouteCategory
  /** A helper agent, a routine, a goal wake-up or a group chat: always the full agent. */
  helper?: boolean
  unattended?: boolean
  group?: boolean
  /** The chat's folder is a code project; the bot's role (instructions). */
  codeProject?: boolean
  role?: string
  /** The decision the router already made for this request (loop.ts chooseModel): its kind is used as is. */
  route?: Pick<RouteClass, 'kind' | 'kindWhy'>
}

export interface TaskClass {
  kind: TaskKind
  why: string
}

/**
 * Chat or agent for one request. Agent when a mode toggle is on, files or folders are attached, a plan is in
 * progress, it runs as a helper, a routine or in a group, or the request is agent work (code, the screen, the
 * user's files, mail and calendar, documents, CAD, deep research). Everything else (conversation, questions,
 * advice, explanations, short writing, live facts) is a chat. Follow-ups keep the previous request's kind.
 */
export function classifyTask(text: string, ctx: TaskContext = {}): TaskClass {
  const f = ctx.flags ?? {}
  if (ctx.helper || ctx.unattended || ctx.group) return { kind: 'agent', why: ctx.helper ? 'helper agent' : ctx.unattended ? 'runs unattended' : 'group chat' }
  if (f.planFirst || f.team || f.deepResearch || f.heavy || f.council) return { kind: 'agent', why: f.planFirst ? 'Plan first is on' : f.team ? 'Team of Experts is on' : f.deepResearch ? 'Deep Research is on' : f.heavy ? 'Heavy is on' : 'Council is on' }
  if (ctx.folders) return { kind: 'agent', why: 'works with an attached folder' }
  if (ctx.files) return { kind: 'agent', why: 'reads attached files' }
  if (ctx.openPlan) return { kind: 'agent', why: 'a task is in progress' }
  if (!text.trim()) return { kind: ctx.previous ?? 'chat', why: 'no text' }
  if (ctx.route) return { kind: ctx.route.kind, why: ctx.route.kindWhy }
  const d = classifyRequest(text, {
    previousKind: ctx.previous,
    // Only the kind of the last request is known here: a follow-up keeps it (the category stands in for it).
    previousCategory: ctx.previousCategory ?? (ctx.previous === 'agent' ? 'agent-tools' : ctx.previous === 'chat' ? 'chat' : undefined),
    codeProject: ctx.codeProject, role: ctx.role
  })
  return { kind: d.kind, why: d.kindWhy }
}

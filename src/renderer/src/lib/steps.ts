import type { Message, ToolCall } from '@shared/types'

// Turns raw tool calls into short human phrases for the activity group.

export interface Step {
  call: ToolCall
  result?: Message
  at: number
}

type Args = Record<string, any>
const parse = (raw: string): Args => {
  try {
    return JSON.parse(raw) as Args
  } catch {
    return {}
  }
}
const host = (u?: string): string => {
  try {
    return new URL(String(u)).host
  } catch {
    return String(u ?? '')
  }
}
const q = (s: unknown, n = 48): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export type Category = 'browse' | 'click' | 'type' | 'read' | 'write' | 'search' | 'memory' | 'plan' | 'ask' | 'delete' | 'doc' | 'other'

/** [category, done phrase, in-progress phrase] */
export function describe(step: Step): [Category, string, string] {
  const a = parse(step.call.arguments)
  const display = step.result?.meta?.display as string | undefined
  switch (step.call.name) {
    case 'browser':
      switch (a.action) {
        case 'navigate': return ['browse', `Opened ${host(a.url)}`, `Opening ${host(a.url)}`]
        case 'snapshot': return ['read', 'Looked at the page', 'Looking at the page']
        case 'click': return ['click', display?.startsWith('clicked') ? `Clicked ${display.slice(8)}` : 'Clicked an element', 'Clicking']
        case 'type': return ['type', display?.startsWith('typed') ? `Typed ${display.slice(6)}` : 'Typed into a field', 'Typing']
        case 'fill_secret': return ['type', `Filled the saved ${a.field ?? 'login'} for ${a.secret}`, `Filling the saved ${a.field ?? 'login'}`]
        case 'scroll': return ['browse', `Scrolled ${a.direction}`, 'Scrolling']
        case 'screenshot': return ['read', 'Took a screenshot', 'Taking a screenshot']
        case 'get_text': return ['read', 'Read the page text', 'Reading the page']
        case 'fill_form': return ['type', `Filled ${a.fields?.length ?? 0} fields${a.submit_ref ? ' and submitted' : ''}`, 'Filling the form']
        case 'select': return ['click', a.option ? `Chose “${q(a.option, 30)}”` : 'Chose an option', a.option ? `Choosing “${q(a.option, 30)}”` : 'Choosing an option']
        case 'dialog': return ['click', a.accept ? 'Accepted a page pop-up' : 'Dismissed a page pop-up', 'Answering a page pop-up']
        case 'tabs': return ['browse', a.op === 'list' ? 'Checked open tabs' : `${a.op === 'new' ? 'Opened' : a.op === 'close' ? 'Closed' : 'Switched'} a tab`, 'Managing tabs']
      }
      return ['browse', 'Used the browser', 'Using the browser']
    case 'run_command': return ['write', `Ran ${q(a.command, 44)}`, `Running ${q(a.command, 44)}`]
    case 'agents': return ['other', `Ran ${a.tasks?.length ?? 0} helper agents`, `Running ${a.tasks?.length ?? 0} helper agents`]
    case 'consult': return ['search', 'Asked an expert model', 'Asking an expert model']
    case 'research': {
      const where = ({ pubmed: 'PubMed', pubmed_abstract: 'PubMed abstracts', clinical_trials: 'ClinicalTrials.gov', drug_label: 'the FDA label', wikipedia: 'Wikipedia', arxiv: 'arXiv', doi: 'DOI records' } as Record<string, string>)[a.source] ?? a.source
      return ['search', a.query ? `Searched ${where} for “${q(a.query, 34)}”` : `Read ${where}`, `Searching ${where}`]
    }
    case 'computer':
      switch (a.action) {
        case 'screenshot': return ['read', 'Looked at the screen', 'Looking at the screen']
        case 'ui': return ['read', 'Read the app window', 'Reading the app window']
        case 'type': return ['type', `Typed "${q(a.text, 30)}"`, 'Typing']
        case 'key': return ['type', `Pressed ${a.keys}`, 'Pressing keys']
        case 'open_app': return ['browse', `Opened ${a.app}`, `Opening ${a.app}`]
        case 'click_element': return ['click', `Clicked "${q(a.name, 30)}"`, `Clicking "${q(a.name, 30)}"`]
        case 'menu': return ['click', `Chose ${q(a.path, 40)}`, 'Using a menu']
        case 'apps': return ['read', 'Checked open apps', 'Checking open apps']
        default: return ['click', `${String(a.action).replace('_', ' ')} on screen`, 'Using the mouse']
      }
    case 'cursor': return ['write', a.action === 'open' ? `Opened in Cursor` : a.action?.startsWith('cloud') ? `Cursor cloud agent: ${String(a.action).slice(6)}` : a.action === 'agent' ? 'Ran Cursor\'s agent' : 'Checked Cursor', 'Working with Cursor']
    case 'mac_apps': return ['write', String(a.action).replace('_', ' '), 'Using a Mac app']
    case 'web_search': return ['search', `Searched “${q(a.query, 40)}”`, `Searching “${q(a.query, 40)}”`]
    case 'fetch_page': return ['read', `Read ${host(a.url)}${a.chunk > 1 ? ` (part ${a.chunk})` : ''}`, `Reading ${host(a.url)}`]
    case 'file_read': return ['read', `Read ${q(a.path, 40)}`, `Reading ${q(a.path, 40)}`]
    case 'file_write': return ['write', display ? cap(display) : `Wrote ${q(a.path, 40)}`, `Writing ${q(a.path, 40)}`]
    case 'file_manage': return [a.op === 'delete' ? 'delete' : 'write', display ? cap(display) : `${cap(a.op ?? 'changed')} ${q(a.path, 40)}`, `${cap(a.op ?? 'changing')} ${q(a.path, 40)}`]
    case 'create_document': return ['doc', display ? cap(display) : `Created ${q(a.path, 40)}`, `Creating ${q(a.path, 40)}`]
    case 'memory': return ['memory', a.action === 'save' ? `Remembered “${q(a.fact, 40)}”` : a.action === 'forget' ? 'Forgot a fact' : a.action === 'list' || !String(a.query ?? '').trim() ? 'Looked at saved memories' : `Searched memory for “${q(a.query, 30)}”`, 'Checking memory']
    case 'todo': return ['plan', display ? `Updated the plan (${display})` : 'Updated the plan', 'Planning']
    case 'find_tools': return ['other', display ? cap(display) : `Looked for ${q(a.query, 30)} tools`, 'Finding tools']
    case 'read_result': return ['read', 'Read more of a long result', 'Reading more']
    case 'ask_user': return ['ask', `Asked: ${q(a.question, 50)}`, 'Waiting for your answer']
    default: return ['other', display ? `${prettyName(step.call.name)} · ${display}` : prettyName(step.call.name), prettyName(step.call.name)]
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function prettyName(name: string): string {
  return cap(name.replace(/^mcp__/, '').replace(/__/g, ' · ').replace(/_/g, ' '))
}

const NOUN: Record<Category, [string, string, string]> = {
  browse: ['Browsed', 'page', 'pages'],
  click: ['Clicked', 'element', 'elements'],
  type: ['Typed in', 'field', 'fields'],
  read: ['Read', 'source', 'sources'],
  write: ['Changed', 'file', 'files'],
  delete: ['Deleted', 'file', 'files'],
  doc: ['Created', 'document', 'documents'],
  search: ['Ran', 'search', 'searches'],
  memory: ['Used memory', 'time', 'times'],
  plan: ['Updated the plan', 'time', 'times'],
  ask: ['Asked you', 'question', 'questions'],
  other: ['Used', 'tool', 'tools']
}

/** "Browsed 3 pages, clicked 2 elements, changed 1 file" */
export function summarize(steps: Step[]): string {
  const counts = new Map<Category, number>()
  for (const s of steps) {
    const [c] = describe(s)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const parts = [...counts.entries()]
    .filter(([c]) => c !== 'plan' || counts.size === 1)
    .map(([c, n]) => {
      const [verb, one, many] = NOUN[c]
      if (c === 'plan' || c === 'memory') return verb.toLowerCase()
      return `${verb.toLowerCase()} ${n} ${n === 1 ? one : many}`
    })
  const s = parts.slice(0, 4).join(', ')
  return cap(s || 'Worked')
}

export function stepStatus(step: Step, live: boolean): 'running' | 'ok' | 'error' | 'denied' | 'invalid' | 'stopped' {
  const s = step.result?.meta?.status as string | undefined
  if (s === 'ok' || s === 'error' || s === 'denied' || s === 'invalid') return s
  return live ? 'running' : 'stopped'
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** The step the working line names: the newest one still running (none once it has its result: "Thinking"). */
export function runningStep(steps: Step[] | undefined, running: boolean): Step | undefined {
  const last = running ? steps?.[steps.length - 1] : undefined
  return last && !last.result ? last : undefined
}


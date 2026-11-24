import type { HomeIdea } from '@shared/types'
import type { TaskCategory } from './llm/task-classifier'

// The starter tiles under Home's message box, personalized from what the user actually does: the kinds of
// requests they've sent lately (task categories), the apps they've connected, the files SahilBot made for them
// and the projects they've told it about. Pure and local (no model call); the generic tiles fill the rest so a
// new user sees the same helpful set as before. Nothing here comes from outside content: chats count only by
// category, and project names only from trusted memories.

export interface IdeaSignals {
  /** Categories of the user's recent requests, newest first. */
  recent: TaskCategory[]
  /** Preset ids of connected apps ("gmail", "github"…). */
  apps: string[]
  /** Extensions of files made recently (".pptx", ".xlsx"…). */
  made: string[]
  /** Project names from trusted memories, newest first. */
  projects: string[]
}

const GENERIC: HomeIdea[] = [
  { icon: 'globe', label: 'Plan a trip', text: 'Plan a 4-day trip to ' },
  { icon: 'sparkle', label: 'Use my Mac', text: 'On my Mac, ' },
  { icon: 'clock', label: 'Morning brief', text: 'Every weekday at 8am, give me a short morning brief: today\'s calendar and reminders, the weather where I live, and the most important news about my work and interests.' },
  { icon: 'file', label: 'Make a deck', text: 'Make a polished slide deck about ' },
  { icon: 'cpu', label: 'Build an app', text: 'Build me a small web app that ' },
  { icon: 'search', label: 'Watch a page', text: 'Every morning, check https:// and tell me only if something important changed (price, availability, new posts).' },
  { icon: 'video', label: 'Make a video', text: 'Make a 30-second avatar video about ' }
]

/** Ideas a habit suggests (category → tile). */
const BY_CATEGORY: Partial<Record<TaskCategory, HomeIdea>> = {
  coding: { icon: 'cpu', label: 'Fix or build code', text: 'In my project, ' },
  'code-quick': { icon: 'cpu', label: 'Explain some code', text: 'Explain what this code does and how to improve it:\n' },
  research: { icon: 'search', label: 'Research a topic', text: 'Research the latest on  and give me a short brief with sources.' },
  'long-context': { icon: 'file', label: 'Summarize a document', text: 'Summarize the attached document: the key points, decisions and anything I need to act on.' },
  writing: { icon: 'edit', label: 'Draft something', text: 'Draft a  for me. Keep it in my usual tone.' },
  office: { icon: 'layers', label: 'Make a spreadsheet', text: 'Make a spreadsheet that ' },
  math: { icon: 'sparkle', label: 'Work it out', text: 'Work this out step by step: ' },
  vision: { icon: 'image', label: 'Look at a screenshot', text: 'Look at this screenshot and tell me ' },
  'computer-use': { icon: 'sparkle', label: 'Use my Mac', text: 'On my Mac, ' },
  'agent-tools': { icon: 'inbox', label: 'Catch me up', text: 'Catch me up: what needs my attention today across my email, calendar and messages?' },
  cad: { icon: 'layers', label: 'Design a part', text: 'Design a part in CAD: ' }
}

/** Ideas a connected app suggests (preset id → tile). */
const BY_APP: Record<string, HomeIdea> = {
  gmail: { icon: 'inbox', label: 'Triage my inbox', text: 'Go through my unread email: what needs a reply today, what can wait, and draft the replies for me to review.' },
  outlook: { icon: 'inbox', label: 'Triage my inbox', text: 'Go through my unread email: what needs a reply today, what can wait, and draft the replies for me to review.' },
  'google-calendar': { icon: 'clock', label: 'Plan my week', text: 'Look at my calendar for this week and help me plan it: conflicts, prep I need, and free blocks for focused work.' },
  github: { icon: 'cpu', label: 'Review my PRs', text: 'Check my open GitHub pull requests and issues: what\'s blocked, what needs my review, and what to do first.' },
  slack: { icon: 'users', label: 'Catch up on Slack', text: 'Catch me up on Slack: the threads that mention me or need a decision, in a short list.' },
  notion: { icon: 'file', label: 'Update my notes', text: 'In Notion, ' },
  linear: { icon: 'listicon', label: 'Plan my tickets', text: 'Look at my Linear issues and suggest what to work on this week, in order.' },
  heygen: { icon: 'video', label: 'Make a video', text: 'Make a 30-second avatar video about ' },
  hubspot: { icon: 'users', label: 'Pipeline check', text: 'Review my HubSpot pipeline: deals that need a follow-up this week and a draft for each.' },
  stripe: { icon: 'bolt', label: 'Revenue snapshot', text: 'Give me a revenue snapshot from Stripe: this month vs last, new customers, churn and failed payments.' }
}

/** Ideas the files made lately suggest. */
const BY_FILE: Record<string, HomeIdea> = {
  '.pptx': GENERIC[3],
  '.xlsx': BY_CATEGORY.office!,
  '.pdf': { icon: 'file', label: 'Write a report', text: 'Write a polished PDF report on  with sources.' },
  '.docx': { icon: 'file', label: 'Write a document', text: 'Write a document about ' }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** Up to `n` tiles: the user's own patterns first (strongest first), then the generic set. */
export function homeIdeas(s: IdeaSignals, n = 7): HomeIdea[] {
  const scored = new Map<string, { idea: HomeIdea; score: number }>()
  const add = (idea: HomeIdea | undefined, score: number): void => {
    if (!idea) return
    const cur = scored.get(idea.label)
    scored.set(idea.label, { idea, score: (cur?.score ?? 0) + score })
  }
  // Recent requests: newer counts more; chat (small talk) and voice say nothing about what to suggest.
  s.recent.slice(0, 40).forEach((c, i) => add(BY_CATEGORY[c], 1 / (1 + i / 10)))
  for (const a of s.apps) add(BY_APP[a], 1.5)
  s.made.slice(0, 20).forEach((e, i) => add(BY_FILE[e.toLowerCase()], 0.8 / (1 + i / 5)))
  // The newest project the user talked about: pick it up again in one click.
  const project = s.projects.map((p) => p.replace(/\s+/g, ' ').trim()).find((p) => p.length >= 2 && p.length <= 60)
  if (project) add({ icon: 'folder', label: `Continue ${clip(project, 22)}`, text: `Let's keep going on ${project}. Where did we leave off, and what's next?` }, 2)

  // A habit needs a little evidence before it takes a tile (one stray request isn't a pattern).
  const mine = [...scored.values()].filter((x) => x.score >= 1).sort((a, b) => b.score - a.score).map((x) => ({ ...x.idea, personal: true }))
  const out: HomeIdea[] = mine.slice(0, Math.max(0, n - 2))
  for (const g of GENERIC) if (out.length < n && !out.some((o) => o.label === g.label)) out.push(g)
  return out.slice(0, n)
}

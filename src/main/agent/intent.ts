/**
 * Which on-demand tools a request needs, read from the request itself. Heavy tools (computer use, code,
 * pages…) aren't sent with every request: that keeps the prompt small and fast on local models. A
 * request that clearly needs them gets them loaded before the first step; anything else is one
 * find_tools call away, and a tool a chat has used stays loaded for that chat.
 */

const GROUPS: Array<{ tools: string[]; when: RegExp }> = [
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
    when: /\b(docs?|document|draft|write( up)?|rewrite|edit|paragraph|section|heading|report|memo|letter|essay|notes|outline|proposal|resume|cv|spreadsheet|sheet|rows?|columns?|checklist|agenda|minutes|brief|article|blog post|cover letter)\b/i
  },
  {
    tools: ['research'],
    when: /\b(stud(y|ies)|pubmed|clinical( trial)?s?|paper|papers|arxiv|doi|journal|peer[- ]reviewed|drug|dosage|fda|side effects?|medical|diagnos|symptom|research)\b/i
  },
  {
    tools: ['mail'],
    when: /\b(e-?mails?|inbox|gmail|mail app|apple mail|unread|reply to|draft (a|an|the)? ?(reply|email)|newsletter|unsubscribe)\b/i
  }
]

/** Tools to load for a request (only names that exist in `known`). */
export function intentTools(text: string, known: Set<string>, extra: { codeProject?: boolean } = {}): string[] {
  const out = new Set<string>()
  for (const g of GROUPS) if (g.when.test(text)) for (const t of g.tools) out.add(t)
  // A chat about a code project (a project folder with a repo or package file) gets the coding tools.
  if (extra.codeProject) for (const t of GROUPS[0].tools) out.add(t)
  return [...out].filter((t) => known.has(t))
}

/**
 * Every on-demand tool a request might load, except the screen and app tools, plus read_result (the call an
 * offloaded result points to): what a Claude chat on a big window loads up front (loop.ts), so the cached
 * tool list stays the same for the whole chat. Only names that exist in `known`.
 */
export function likelyTools(known: Set<string>): string[] {
  const out = GROUPS.filter((g) => !g.tools.includes('computer')).flatMap((g) => g.tools)
  return ['read_result', ...out].filter((t) => known.has(t))
}

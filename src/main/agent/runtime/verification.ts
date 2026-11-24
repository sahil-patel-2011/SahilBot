import { lstatSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { straight } from '../harness-features'
import type { ResearchClaim } from './research'
import type { RuntimeStore } from './store'

/** A read that can check a write: the same connector ("gmail__…"), or a shared name stem ("send_invoice" / "list_sent_invoices"). */
export function sameThing(write: string, read: string): boolean {
  const conn = (t: string): string | undefined => (t.includes('__') ? t.split('__')[0] : undefined)
  if (conn(write) && conn(write) === conn(read)) return true
  const stems = (t: string): string[] => t.toLowerCase().split(/__|[_\-.\s]+/).filter((w) => w.length >= 4 && !['send', 'list', 'make', 'create', 'update', 'delete', 'post', 'read', 'fetch', 'with', 'from'].includes(w)).map((w) => w.slice(0, 5))
  const r = new Set(stems(read))
  return stems(write).some((w) => r.has(w))
}

export interface VerificationReport { status: 'verified' | 'unverified' | 'blocked'; issues: string[]; checks: number; passed: number }
export function completionReport(store: RuntimeStore, runId: string, o: { required?: boolean; criteria?: string[]; files?: string[]; claims?: ResearchClaim[] } = {}): VerificationReport {
  const checks = store.checks(runId), latest = new Map(checks.map((c) => [c.criterion, c]))
  const actions = store.actions(runId)
  const lastMutation = Math.max(0, ...actions.filter((a) => a.status === 'done' && a.effect !== 'read' && !['memory', 'preference', 'project_memory', 'agent_control'].includes(a.tool)).map((a) => a.at))
  const issues: string[] = []
  for (const [name, check] of latest) if (!check.passed) issues.push(`${name}: failed`)
  for (const criterion of o.criteria ?? []) if (!latest.get(criterion)?.passed) issues.push(`${criterion}: no passing evidence`)
  for (const name of o.files ?? []) {
    const saved = actions.some((action) => {
      const path = action.output?.path
      if (action.status !== 'done' || action.effect === 'read' || !path || !isAbsolute(path) || basename(path) !== name) return false
      try { return lstatSync(path).isFile() } catch { return false }
    })
    if (!saved) issues.push(`No saved workspace file named ${name} was verified. Use the workspace file or export tool to save it and check the result.`)
  }
  if (checks.length && Math.max(...checks.map((c) => c.at)) < lastMutation) issues.push('The work changed after its last verification; check it again.')
  // An uncertain write blocks completion until the agent has looked at the state since (a read that ran after
  // it in this run). It stays uncertain, so repeating the same write is still refused.
  // Only this run's: one left from an earlier task in the chat's one conversation stays in the brief (and still refuses
  // a blind repeat) but never fails an unrelated later task.
  for (const a of store.uncertain(store.get(runId)?.threadId ?? '').filter((x) => x.runId === runId)) {
    const checkedSince = actions.some((x) => x.status === 'done' && x.effect === 'read' && x.at >= a.at && x.id !== a.id && x.tool !== 'agent_control' && sameThing(a.tool, x.tool))
    if (!checkedSince) issues.push(`${a.tool}: uncertain outcome (${a.id}). Check its current state with a read of the same service before finishing, or reconcile it with agent_control.`)
  }
  for (const c of o.claims ?? []) if (c.consequential && ['unsupported', 'disputed', 'stale'].includes(c.status)) issues.push(`Research claim is ${c.status}: ${c.text}`)
  if (o.required && !checks.length) issues.push('This task requires evidence-backed verification before completion.')
  const passed = [...latest.values()].filter((c) => c.passed).length
  return { status: issues.length ? 'blocked' : passed > 0 ? 'verified' : 'unverified', issues: [...new Set(issues)], checks: latest.size, passed }
}

/** The reply already tells the user it couldn't confirm the result ("I couldn't verify…", "not one I verified on screen"). */
export function admitsUnverified(text: string): boolean {
  // A negation counts only when it is about doing or checking the work ("I couldn't open the file", "didn't confirm"),
  // said of itself or the work (I, we, it, that…, or a sentence that starts with it), never a passing "can't" or
  // "didn't" elsewhere in a reply that claims success ("I didn't need to run it twice", "you can't wait to see it").
  const SUBJ = String.raw`(?:^|[.!?:;]\s*|\b(?:i'm|i|we|it|that|this|they)\s+(?:(?:was|were|am|is|are)\s+)?)`
  // "Couldn't" is about not managing to; "didn't" is often just what it chose not to do ("I didn't make any changes to
  // the totals"), so with it only verbs of checking or finishing the work count.
  const CANT = String.raw`(?:couldn'?t|could not|can'?t|cannot|wasn'?t able to|was not able to|unable to|haven'?t been able to|have not been able to)`
  const DIDNT = String.raw`(?:didn'?t|did not|haven'?t|have not)`
  const DO = String.raw`(?:verify|confirm|check|test|finish|complete|reach|access|open|load|save|send|connect|sign|log|install|fix|reproduce)`
  // ("I can't get you the PDF too", "It can't do both" are not about the work failing: only "get … to work/load".)
  const TRY = String.raw`(?:${DO.slice(3, -1)}|get\s+(?:\w+\s+){0,3}to\s+(?:work|load|open|run|start|go)|run|see|find|read|click|start)`
  const said = (neg: string, verbs: string): RegExp => new RegExp(String.raw`${SUBJ}${neg}\s+(?!(?:need|want|have|wait|plan|mean|bother)\s+to\b)(?:\w+\s+)?${verbs}\w*\b`, 'im')
  return said(CANT, TRY).test(straight(text)) || said(DIDNT, DO).test(straight(text))
    || /\b(not (yet )?(one i )?(verified|confirmed|checked)|unverified|unconfirmed|blocked (me|it|the)|was blocked|not the expected result|didn'?t (get|see|show) the expected result|(not|n'?t) (sure|certain) (it|this|that|the \w+) (worked|went (through|out)|(was |is |got )?(saved|sent|right|correct|done))|to finish (the|this) (test|task))\b/i.test(straight(text))
}

/** One plain sentence for a reply that sounds sure while the app's checks found something unresolved (no ids, no tool names). */
export const UNVERIFIED_NOTE = "I couldn't confirm this worked, so check the result before relying on it."

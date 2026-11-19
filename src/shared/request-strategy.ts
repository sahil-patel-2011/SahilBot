/** Optional user intent, never a persistent bot mode. Ordinary requests stay autonomous. */
export function requestStrategy(text: string): { kind: 'agent' | 'plan' | 'swarm' | 'research'; explicit: boolean } {
  const t = text.toLowerCase().replace(/```[\s\S]*?```/g, '').replace(/^\s*>[^\n]*/gm, '')
    .replace(/[“”]/g, '"').replace(/"[^"\n]*"|\x60[^\x60\n]*\x60|(?:^|\s)'[^'\n]+'/g, '')
  if (/\b(?:what (?:is|does|are)|explain|define)\b[^.!?]{0,35}\b(?:swarm|council|max mode|plan mode)\b/.test(t)) return { kind: 'agent', explicit: false }
  if (/\b(?:plan first|show (?:me |us )?(?:the |a |your )?plan (?:first|before)|(?:don't|do not) (?:implement|edit|change|execute)[^.!?]{0,40}(?:approve|plan))\b/.test(t) && !/\b(?:don't|do not|skip|no) plan first\b/.test(t)) return { kind: 'plan', explicit: true }
  if (/\b(?:use|start|spawn|run|assemble|launch|bring in)\s+(?:(?:a|an|the|agent|your)\s+){0,3}(?:swarm|council|multiple agents|several agents|specialist agents|team of agents)\b/.test(t) && !/\b(?:don't|do not|no|without|avoid)\b[^.!?]{0,20}\b(?:swarm|council|multiple agents|team of agents)\b/.test(t)) return { kind: 'swarm', explicit: true }
  if (/\b(?:do|run|perform|conduct|start|use)\b[^.!?]{0,20}\bdeep research\b|^\s*deep research\b/.test(t) && !/\b(?:don't|do not|no|without|avoid)\b[^.!?]{0,20}\bdeep research\b/.test(t)) return { kind: 'research', explicit: true }
  return { kind: 'agent', explicit: false }
}
export const STRATEGY_LABEL = { agent: 'Agent', plan: 'Plan first', swarm: 'Agent swarm', research: 'Research' } as const

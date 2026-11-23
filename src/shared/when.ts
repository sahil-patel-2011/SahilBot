import type { Schedule } from './types'

export type When = Extract<Schedule, { type: 'when' }>

export const WHEN_KIND_WORD: Record<When['kind'], string> = {
  email: 'an email', chat: 'a message', calendar: 'a calendar event', meetings: 'a meeting note', crm: 'a CRM update', docs: 'a doc change', accounting: 'an accounting entry', any: 'something new'
}

/** "When an email from acme.com mentioning invoice arrives". */
export function describeWhen(w: When): string {
  return `When ${WHEN_KIND_WORD[w.kind] ?? 'something new'}${w.from ? ` from ${w.from}` : ''}${w.contains ? ` mentioning ${w.contains}` : ''} arrives`
}

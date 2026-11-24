import type { Schedule } from './types'

export type When = Extract<Schedule, { type: 'when' }>

export const WHEN_KIND_WORD: Record<When['kind'], string> = {
  email: 'an email', chat: 'a message', calendar: 'a calendar event', meetings: 'a meeting note', crm: 'a CRM update', docs: 'a doc change', accounting: 'an accounting entry', any: 'something new'
}

/** "When an email from acme.com mentioning invoice arrives". */
export function describeWhen(w: When): string {
  return `When ${WHEN_KIND_WORD[w.kind] ?? 'something new'}${w.from ? ` from ${w.from}` : ''}${w.contains ? ` mentioning ${w.contains}` : ''} arrives`
}

/** "ET", "PT", "GMT+1"…: a short name for a schedule's time zone (the generic one, so it's right all year). */
export function tzLabel(tz: string | undefined): string {
  if (!tz) return ''
  try {
    const generic = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''
    // "ET", "PT", "CT", "MT": the short generic name, where there is one.
    if (generic && generic.length <= 4 && !/^GMT/.test(generic)) return generic
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz
  } catch { return tz }
}

/** A schedule's description with its place's time zone, when it has one ("every day at 7:30 ET"). */
export function withTz(text: string, s: Schedule): string {
  const tz = 'tz' in s ? s.tz : undefined
  return tz ? `${text} ${tzLabel(tz)}` : text
}

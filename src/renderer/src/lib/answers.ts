import type { QueueQuestion } from '@shared/types'

/** An answer without the bot's "(recommended)" / "(default)" tag. */
export const plain = (o: string): string => o.replace(/\s*\((recommended|default|suggested)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim()

/** The answer the bot itself recommended, if any. Never just the first option: that would pre-pick for the user. */
export const recommended = (q: QueueQuestion): string | undefined => q.default?.trim() || q.options?.find((o) => /recommended/i.test(o))

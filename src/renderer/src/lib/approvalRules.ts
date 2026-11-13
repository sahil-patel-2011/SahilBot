import type { CustomRule, Settings } from '@shared/types'
import { api } from '../api'

// The user's approval rules ("When SahilBot wants to …, it should allow automatically / ask first").
// Every change re-reads the saved list first, so the Settings page and approval cards never
// overwrite each other's rules.

export const RULE_LIMIT = 20
export const RULE_MAX_CHARS = 1000

type Save = (rules: CustomRule[]) => Promise<Settings>
const saveDirect: Save = (customRules) => api.settings.set({ customRules })

const newId = (): string => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export async function loadRules(): Promise<CustomRule[]> {
  return (await api.settings.get()).customRules ?? []
}

/** Adds a rule; returns the saved list, or an error to show. */
export async function addRule(when: string, action: CustomRule['action'], save: Save = saveDirect): Promise<{ rules: CustomRule[] } | { error: string }> {
  const text = when.replace(/\s+/g, ' ').trim()
  if (!text) return { error: 'Describe the action first.' }
  if (text.length > RULE_MAX_CHARS) return { error: `Keep it under ${RULE_MAX_CHARS} characters.` }
  const cur = await loadRules()
  if (cur.some((r) => r.action === action && r.when.toLowerCase() === text.toLowerCase())) return { error: 'That rule is already saved.' }
  if (cur.filter((r) => r.action === action).length >= RULE_LIMIT) {
    return { error: `You have ${RULE_LIMIT} "${action === 'ask' ? 'Ask first' : 'Allow automatically'}" rules. Remove one to add another.` }
  }
  const s = await save([...cur, { id: newId(), when: text, action }])
  return { rules: s.customRules ?? [] }
}

export async function removeRule(id: string, save: Save = saveDirect): Promise<CustomRule[]> {
  const cur = await loadRules()
  const s = await save(cur.filter((r) => r.id !== id))
  return s.customRules ?? []
}

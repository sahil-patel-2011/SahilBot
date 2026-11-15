import type { ChatEvent, Message, ModelInfo, Settings } from '@shared/types'
import { samplingFor } from '../../llm/catalog'
import { collectText, streamChat } from '../../llm/client'
import type { Db } from '../../db'
import { CuaOrchestrator } from './session'

// Planner ⇄ Executor computer use: wiring for the app (src/main/index.ts). The planner's requests go through
// the same client as every other model call, so the monthly cloud budget (spendHooks) and each provider's
// own request options apply to them too.

export { CuaOrchestrator } from './session'
export type { ComputerUseSettings } from './session'
export { checkpointTool } from './tool'

export interface CuaWiring {
  db: Pick<Db, 'insertMessage' | 'updateMessage' | 'listMessages'>
  emit(e: ChatEvent): void
  settings(): Settings
  endpoints: { for(model: string): { baseUrl: string; apiKey?: string }; usable(): ModelInfo[]; last?: { models: ModelInfo[] } | null }
}

export function createCua(w: CuaWiring): CuaOrchestrator {
  const info = (id: string): ModelInfo | undefined => w.endpoints.last?.models.find((m) => m.id === id) ?? w.endpoints.usable().find((m) => m.id === id)
  return new CuaOrchestrator({
    store: {
      insert: (m) => w.db.insertMessage(m),
      update: (m: Message) => w.db.updateMessage(m),
      list: (threadId) => w.db.listMessages(threadId),
      emit: (threadId, message) => w.emit({ threadId, type: 'message', message })
    },
    ask: async (model, messages, signal) => {
      const ep = w.endpoints.for(model)
      return collectText(streamChat({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, messages, sampling: samplingFor(model, w.settings().sampling), maxTokens: 4000, effort: 'high', signal }))
    },
    computerUse: () => w.settings().computerUse ?? {},
    models: () => w.endpoints.usable(),
    label: (id) => info(id)?.label || id,
    vision: (id) => info(id)?.vision !== false
  })
}

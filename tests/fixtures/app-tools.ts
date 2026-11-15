import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResultStore } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { agentsTool } from '../../src/main/agent/tools/agents'
import { cursorTool, macAppsTool } from '../../src/main/agent/tools/apps'
import { browserTool } from '../../src/main/agent/tools/browser'
import { codeTool, gitTool } from '../../src/main/agent/tools/code'
import { coreTools } from '../../src/main/agent/tools/core'
import { docTools } from '../../src/main/agent/tools/docspace'
import { fileTools } from '../../src/main/agent/tools/files'
import { handoffTool } from '../../src/main/agent/tools/handoff'
import { jobsTool } from '../../src/main/agent/tools/jobs'
import { mailTool } from '../../src/main/agent/tools/mail'
import { memoryTool } from '../../src/main/agent/tools/memory'
import { officeTool, reviewDocumentTool } from '../../src/main/agent/tools/office'
import { researchTool } from '../../src/main/agent/tools/research'
import { scheduleTool } from '../../src/main/agent/tools/schedule'
import { shellTool } from '../../src/main/agent/tools/shell'
import { webTools } from '../../src/main/agent/tools/web'
import type { ToolDef } from '../../src/main/agent/types'

/**
 * The app's own built-in tools (the schemas index.ts registers, with the same core flags), for measuring what
 * a request carries. The tools' dependencies are stand-ins: these are for listing and sizing, not for running
 * (except the ones a test replaces with its own run()).
 */
export function appRegistry(o: { ws?: string; results?: ResultStore; extra?: ToolDef[] } = {}): { registry: ToolRegistry; results: ResultStore } {
  const ws = o.ws ?? mkdtempSync(join(tmpdir(), 'ws-'))
  const results = o.results ?? new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  const none = {} as never
  registry.register(
    ...coreTools(results),
    ...fileTools(() => ws, tmpdir()),
    reviewDocumentTool({ getWorkspace: () => ws }),
    officeTool({ getWorkspace: () => ws, markdownToPdf: async () => Buffer.from('') } as never),
    ...webTools(() => ({ provider: 'none' }) as never),
    memoryTool(none, none),
    { ...browserTool(none, none, {}), core: true },
    { ...cursorTool(() => undefined, () => ws), core: true },
    { ...macAppsTool(), core: true },
    { ...mailTool(), core: false, group: 'Email' },
    shellTool({ workspace: () => ws }),
    jobsTool(),
    codeTool({ getWorkspace: () => ws }),
    gitTool(),
    researchTool(),
    agentsTool(),
    handoffTool(() => undefined),
    { ...scheduleTool(none, none), core: true },
    ...docTools({ store: none, workspace: () => ws, spaceOf: () => undefined } as never),
    ...(o.extra ?? [])
  )
  return { registry, results }
}

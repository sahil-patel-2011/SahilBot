import type { ToolContext, ToolOutput } from '../types'

export interface WorkflowNode {
  id: string; dependsOn?: string[]; op: 'call' | 'select' | 'filter' | 'join' | 'map'
  tool?: string; args?: Record<string, unknown>; input?: unknown; pointer?: string; fields?: string[]
  equals?: unknown; right?: unknown; leftKey?: string; rightKey?: string; limit?: number
}
export interface WorkflowResult { id: string; status: 'done' | 'failed' | 'blocked'; output?: unknown; error?: string }

/** JSON Pointer, without prototype access, coercion or executable expressions. */
export function pointer(value: unknown, path = ''): unknown {
  if (!path) return value
  if (!path.startsWith('/')) throw new Error('Use a JSON Pointer starting with /.')
  for (const part of path.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error('Unsafe object key.')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
function refs(value: unknown, outputs: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => refs(v, outputs))
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.$ref === 'string') {
      const [id, ...path] = v.$ref.split('/')
      if (!outputs.has(id)) throw new Error(`Result ${id} is not available; declare its dependency.`)
      return pointer(outputs.get(id), path.length ? `/${path.join('/')}` : '')
    }
    return Object.fromEntries(Object.entries(v).filter(([k]) => !['__proto__', 'prototype', 'constructor'].includes(k)).map(([k, x]) => [k, refs(x, outputs)]))
  }
  return value
}
export function validateGraph(nodes: WorkflowNode[]): void {
  if (!nodes.length || nodes.length > 100) throw new Error('A workflow needs 1–100 nodes.')
  const ids = new Set(nodes.map((n) => n.id))
  if (ids.size !== nodes.length || nodes.some((n) => !/^[a-zA-Z0-9_-]{1,64}$/.test(n.id))) throw new Error('Node ids must be unique simple identifiers.')
  const done = new Set<string>()
  while (done.size < nodes.length) {
    const ready = nodes.filter((n) => !done.has(n.id) && (n.dependsOn ?? []).every((id) => done.has(id)))
    if (!ready.length) throw new Error('Workflow has a cycle or a missing dependency.')
    ready.forEach((n) => done.add(n.id))
  }
}

/** A bounded declarative program. It has no eval, filesystem, network or process globals. */
export async function executeWorkflow(nodes: WorkflowNode[], ctx: Pick<ToolContext, 'invokeTool' | 'signal'>, prior: WorkflowResult[] = [], save?: (r: WorkflowResult[]) => void): Promise<WorkflowResult[]> {
  validateGraph(nodes)
  const results = new Map(prior.filter((r) => r.status === 'done').map((r) => [r.id, r]))
  const outputs = new Map([...results].map(([id, r]) => [id, r.output]))
  for (let round = 0; results.size < nodes.length && round < nodes.length; round++) {
    const ready = nodes.filter((n) => !results.has(n.id) && (n.dependsOn ?? []).every((id) => results.has(id)))
    for (const node of ready) {
      if (ctx.signal.aborted) throw new Error('Workflow stopped; completed nodes are checkpointed.')
      const bad = (node.dependsOn ?? []).find((id) => results.get(id)?.status !== 'done')
      let r: WorkflowResult
      if (bad) r = { id: node.id, status: 'blocked', error: `Dependency ${bad} failed.` }
      else try {
        const n = refs(node, outputs) as WorkflowNode
        let output: unknown
        if (n.op === 'call') {
          if (!n.tool || !ctx.invokeTool) throw new Error('A call needs an available tool.')
          const out: ToolOutput = await ctx.invokeTool(n.tool, n.args ?? {})
          output = { data: out.data, text: out.text, path: out.path }
        } else {
          const input = n.input
          if (n.op === 'select') output = n.fields && Array.isArray(input) ? input.map((row) => Object.fromEntries(n.fields!.map((k) => [k, pointer(row, `/${k}`)]))) : pointer(input, n.pointer)
          else if (n.op === 'filter') { if (!Array.isArray(input)) throw new Error('filter needs an array.'); output = input.filter((row) => JSON.stringify(pointer(row, n.pointer)) === JSON.stringify(n.equals)).slice(0, n.limit ?? 10_000) }
          else if (n.op === 'map') { if (!Array.isArray(input)) throw new Error('map needs an array.'); output = input.slice(0, n.limit ?? 10_000).map((row) => pointer(row, n.pointer)) }
          else if (n.op === 'join') {
            if (!Array.isArray(input) || !Array.isArray(n.right) || !n.leftKey || !n.rightKey) throw new Error('join needs two arrays and key pointers.')
            const index = new Map<string, unknown[]>()
            for (const row of n.right) { const key = JSON.stringify(pointer(row, n.rightKey)); index.set(key, [...(index.get(key) ?? []), row]) }
            const joined: unknown[] = []
            for (const left of input) for (const right of index.get(JSON.stringify(pointer(left, n.leftKey))) ?? []) { if (joined.length >= (n.limit ?? 10_000)) throw new Error('Join result exceeds the row limit.'); joined.push({ left, right }) }
            output = joined
          } else throw new Error('Unknown workflow operation.')
        }
        if (JSON.stringify(output ?? null).length > 2_000_000) throw new Error('Workflow result exceeds 2 MB; use paginated tool calls.')
        outputs.set(node.id, output); r = { id: node.id, status: 'done', output }
      } catch (e) { r = { id: node.id, status: 'failed', error: (e as Error).message } }
      results.set(node.id, r); save?.([...results.values()])
    }
  }
  return nodes.map((n) => results.get(n.id)!)
}

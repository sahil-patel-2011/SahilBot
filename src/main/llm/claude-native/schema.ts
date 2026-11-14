// Claude's tool schemas. Claude rejects top-level allOf/anyOf/oneOf in a tool's input_schema, so
// conditional rules ("ref is required when action is click") move into the description; SahilBot still
// enforces the full schema locally (agent/validate.ts) before anything runs.

export function forClaude(schema: Record<string, unknown>, description: string): { schema: Record<string, unknown>; description: string } {
  const { allOf, anyOf, oneOf, ...rest } = schema as Record<string, unknown> & { allOf?: unknown[]; anyOf?: unknown[]; oneOf?: unknown[] }
  const rules: string[] = []
  for (const c of [...(allOf ?? []), ...(anyOf ?? []), ...(oneOf ?? [])] as Array<{ if?: { properties?: Record<string, { const?: unknown; enum?: unknown[]; pattern?: string }> }; then?: { required?: string[] } }>) {
    const [field, cond] = Object.entries(c.if?.properties ?? {})[0] ?? []
    const need = c.then?.required
    if (!field || !need?.length) continue
    const when = cond?.const !== undefined ? `${field} is "${cond.const}"` : cond?.enum ? `${field} is ${cond.enum.map((v) => `"${v}"`).join(' or ')}` : cond?.pattern ? `${field} matches ${cond.pattern}` : field
    rules.push(`When ${when}: also give ${need.join(', ')}.`)
  }
  return { schema: rest, description: rules.length ? `${description}\n${rules.join('\n')}` : description }
}

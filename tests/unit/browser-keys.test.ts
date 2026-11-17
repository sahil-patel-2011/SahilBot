import { describe, expect, test } from 'vitest'
import { parseKeys } from '../../src/main/browser/keys'

describe('browser key presses', () => {
  test('named keys, shortcuts and several presses', () => {
    expect(parseKeys('Escape')).toEqual([{ modifiers: 0, keys: [{ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }] }])
    expect(parseKeys('shift+Tab')[0]).toMatchObject({ modifiers: 8, keys: [{ key: 'Tab' }] })
    expect(parseKeys('cmd+a')[0]).toMatchObject({ modifiers: 4, keys: [{ key: 'a', code: 'KeyA' }] })
    expect(parseKeys('cmd+a')[0].keys[0].text).toBeUndefined()
    expect(parseKeys('ArrowDown ArrowDown')).toHaveLength(2)
    expect(parseKeys('x')[0].keys[0].text).toBe('x')
  })
  test('Enter goes through type submit (where a purchase is checked); nonsense is refused', () => {
    expect(() => parseKeys('Enter')).toThrow(/submit=true/)
    expect(() => parseKeys('ArrowDown Return')).toThrow(/submit=true/)
    expect(() => parseKeys('hyper+x')).toThrow(/modifier/)
    expect(() => parseKeys('Wiggle')).toThrow(/Unknown key/)
    expect(() => parseKeys('')).toThrow()
  })
})

describe('the browser tool schema', () => {
  test('every action is in the enum and the description, and every argument it reads is in the schema', async () => {
    const { browserTool } = await import('../../src/main/agent/tools/browser')
    const t = browserTool({} as never, {} as never)
    const props = (t.parameters as { properties: Record<string, { enum?: string[] }> }).properties
    const actions = props.action.enum!
    for (const a of ['key', 'back', 'forward', 'hover', 'click', 'type', 'navigate', 'snapshot']) expect(actions).toContain(a)
    for (const a of actions) expect(t.description).toMatch(new RegExp(`(^|[\\s/-])${a}\\b`))
    // Arguments read as a.<name> in the tool must be declared (additionalProperties is false: anything else is refused).
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/main/agent/tools/browser.ts', import.meta.url), 'utf8')
    const args = src.slice(src.indexOf('interface Args {'), src.indexOf('\n}\n', src.indexOf('interface Args {')))
    const fields = [...args.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThan(10)
    for (const name of fields) expect(Object.keys(props), `Args.${name} is not in the schema`).toContain(name)
  })
})

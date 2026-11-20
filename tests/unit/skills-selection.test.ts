import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { contextBlock, contextSections } from '../../src/main/agent/prompt'
import { foldNames, SkillStore, tokens } from '../../src/main/skills'

// Skill selection: which built-in skills the <context> block suggests for a request, and how much room it takes.

const PACKS = join(process.cwd(), 'packs', 'skills')
const store = new SkillStore(mkdtempSync(join(tmpdir(), 'sk-sel-')), PACKS)
const top = (q: string, o: Parameters<SkillStore['relevant']>[1] = {}, k = 3): string[] => store.relevant(q, o).slice(0, k).map((r) => r.skill.name)
const exists = (n: string): boolean => readdirSync(PACKS).includes(n)

// [request, the skill that must be in the top 3, options]
const CASES: Array<[string, string, { codeProject?: boolean; first?: boolean }?]> = [
  // coding core
  ['the login test is failing with a TypeError', 'coding-fix-failing-tests', { codeProject: true, first: true }],
  ['add a --json flag to the export command', 'coding-agent-loop', { codeProject: true, first: true }],
  ['explain this stack trace: NullPointerException at Robot.java:42', 'read-stack-traces', { first: true }],
  ['review this PR before I merge it', 'code-review', { first: true }],
  ['review my kotlin code', 'code-review'],
  ['audit the app for security issues like sql injection and leaked secrets', 'security-review', { first: true }],
  ['this function is really slow, profile it', 'performance-profiling'],
  ['refactor this module without changing behavior', 'refactor-safely', { first: true }],
  ['design a REST API for orders with pagination', 'api-design', { first: true }],
  ['add a database migration to add an index on users.email', 'database-schema-migrations', { first: true }],
  ['should I add this npm package or write it myself', 'dependency-hygiene'],
  ['write a good commit message and open a pull request', 'coding-commit-and-pr'],
  ['set up github actions CI that runs pytest', 'ci-pipeline', { first: true }],
  ['write a readme for this repo', 'write-docs-readme', { first: true }],
  ['walk me through this unfamiliar codebase, where is the entry point', 'codebase-orientation', { first: true }],
  ['plan the change before editing: which files does adding auth touch', 'plan-a-code-change'],
  ['write the failing test first, then the code (TDD)', 'test-first-development'],
  ['it used to work, find the root cause of this regression', 'debug-systematically', { first: true }],
  // stacks
  ['my react useEffect runs twice', 'react-frontend', { first: true }],
  ['tsc says type string is not assignable in my tsconfig strict project', 'typescript-project'],
  ['set up pyproject with ruff and mypy and pytest', 'python-project'],
  ['write a swiftui view for a settings screen', 'swift-ios-app', { first: true }],
  ['make a rust cli with cargo that parses args', 'rust-project', { first: true }],
  ['go goroutine leak with context cancellation', 'go-project'],
  ['write a SQL query for the top 10 customers by revenue', 'sql-queries', { first: true }],
  ['write a bash script to rename files safely', 'shell-scripting', { first: true }],
  ['./gradlew build fails with a junit 5 error', 'java-kotlin-wpilib'],
  // advanced coding
  ['our next.js app has bad LCP and a huge bundle', 'web-app-engineering', { first: true }],
  ['add an idempotency key and retry with backoff to the payment worker', 'backend-services', { first: true }],
  ['build a react native expo app with offline sync', 'mobile-apps'],
  ['convert my jupyter notebook to a reproducible script', 'data-ml-engineering', { first: true }],
  ['set up terraform plan in the pipeline and manage secrets', 'devops-cicd-iac'],
  ['add opentelemetry tracing and structured logs to the service', 'observability', { first: true }],
  ['fix this race condition / deadlock in my async code', 'concurrency-async', { first: true }],
  ['solve this leetcode problem with dynamic programming', 'algorithms-problem-solving', { first: true }],
  ['migrate the whole codebase off this legacy framework with a strangler fig', 'legacy-code-migration', { first: true }],
  ['our tests are flaky, fix the fixtures and mocks', 'writing-great-tests'],
  ['work in a pnpm monorepo with turborepo', 'monorepo-workflow', { first: true }],
  ["how does this library's retry option work, read the source in node_modules", 'reading-library-source', { first: true }],
  ['build an LLM agent with tool calling, evals and prompt caching to cut cost', 'llm-app-engineering', { first: true }],
  // Cursor and long tasks
  ['ask cursor to add dark mode to the settings page', 'cursor-task-brief', { first: true }],
  ['have the cursor cloud agent do it and review the PR it opens', 'coding-cursor-orchestration'],
  ['this is a long multi-step task, keep track of decisions so nothing is lost', 'long-task-working-notes', { first: true }],
  // engineering
  ['design a bracket to hold a 5 kg motor, what bolts should I use', 'mechanical-design-process', { first: true }],
  ['what press fit for a 608 bearing in a 3d printed part', 'fits-and-fasteners', { first: true }],
  ['make this part cheaper to CNC and sheet metal: bend radius and internal corners', 'design-for-manufacturing'],
  ['power budget and wire gauge for a 12 V system with a fuse', 'electrical-basics', { first: true }],
  ['requirements and a trade study with a risk register for a drone', 'systems-engineering', { first: true }],
  ['calculate the torque needed to lift 10 kg with a 2 inch pulley', 'engineering-calculations', { first: true }],
  ['write an engineering report for the shooter test results', 'engineering-report', { first: true }],
  ['how should I structure my FRC elevator subsystem code', 'frc-code-mechanisms'],
  ['what gear ratio for our frc elevator', 'frc-design-elevators', { first: true }],
  ['tune the PID and feedforward on our robot arm', 'frc-code-pid-feedforward', { first: true }],
  // other domains
  ['write a business plan for a bakery', 'business-plan-writing'],
  ['my blood pressure is high, what should I eat', 'medical-chronic-conditions'],
  ['I feel stressed and burned out', 'health-mental-health-support', { first: true }],
  ['draft a reply to this email', 'email-drafting', { first: true }],
  ['plan a trip to japan', 'plan-a-trip'],
  ['read recent restaurant reviews and compare dinner spots for wheelchair access', 'restaurant-review-research'],
  ['source parts for this bill of materials, check the manufacturer part numbers and compare distributor lead times', 'parts-procurement']
]

describe('skill selection', () => {
  test(`${CASES.length} requests pick the right skill`, () => {
    const misses: string[] = []
    let checked = 0
    for (const [q, want, o] of CASES) {
      if (!exists(want)) continue
      checked++
      const got = top(q, { codeProject: o?.codeProject })
      if (o?.first ? got[0] !== want : !got.includes(want)) misses.push(`${q} → want ${want}${o?.first ? ' first' : ''}, got ${got.join(', ') || '(none)'}`)
    }
    expect(checked).toBeGreaterThanOrEqual(50)
    expect(misses).toEqual([])
  })

  test('small talk and unrelated requests suggest nothing', () => {
    for (const q of ['hi', 'thanks!', 'ok sounds good', 'lol', 'good morning']) expect(store.suggest(q)).toBeUndefined()
  })

  test('the project folder says the stack; a code project ranks coding skills first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'))
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n')
    expect(top('fix the borrow checker error in this function', { folder: dir, codeProject: true })).toContain('rust-project')
    const py = mkdtempSync(join(tmpdir(), 'proj-'))
    writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "x"\n')
    expect(top('add a unit test for the parser module', { folder: py, codeProject: true }, 5)).toContain('python-project')
    // The same words outside a code project lean less on coding skills.
    expect(top('add an export button to the report page', { codeProject: true })[0] ?? '').not.toMatch(/^app-/)
  })

  test('every built-in skill is found by its own description (all domains, so packs do not shadow each other)', () => {
    const all = store.list().filter((s) => s.source === 'builtin' && s.description)
    const miss: string[] = []
    const byDomain = new Map<string, { n: number; hit: number }>()
    for (const s of all) {
      const got = top(s.description, {}, 3)
      const d = s.name.split('-')[0]
      const cur = byDomain.get(d) ?? { n: 0, hit: 0 }
      cur.n++
      if (got.includes(s.name)) cur.hit++
      else miss.push(`${s.name} → ${got.join(', ')}`)
      byDomain.set(d, cur)
    }
    if (miss.length) console.log(`[skills] self-retrieval misses (${miss.length}/${all.length}):\n${miss.join('\n')}`)
    expect(all.length).toBeGreaterThan(150)
    expect(miss.length / all.length).toBeLessThan(0.08)
    for (const [d, c] of byDomain) if (c.n >= 4) expect(c.hit / c.n, `domain ${d}`).toBeGreaterThanOrEqual(0.75)
  }, 30_000)
})

describe('skill suggestions: size and shape', () => {
  test('within budget on every example: big windows ≤ ~1.2K tokens with one skill inlined, small windows ≤ 420 chars and no steps', () => {
    for (const [q] of CASES) {
      const full = store.suggest(q, { codeProject: true })
      const small = store.suggest(q, { codeProject: true, compact: true })
      if (!full || !small) continue
      const fullChars = full.lines.join('\n').length + (full.body ? full.body.lines.join('\n').length : 0)
      expect(fullChars, q).toBeLessThanOrEqual(4800)
      expect(full.lines.length).toBeLessThanOrEqual(5)
      expect(small.lines.join('\n').length, q).toBeLessThanOrEqual(420)
      expect(small.lines.length).toBeLessThanOrEqual(3)
      expect(small.body).toBeUndefined()
    }
  })

  test('a clear winner is inlined with its headings tagged; a long body is cut with a pointer to the rest', () => {
    const s = store.suggest('explain this stack trace: NullPointerException at Robot.java:42')!
    expect(s.names[0]).toBe('read-stack-traces')
    expect(s.lines[0]).toMatch(/^- read-stack-traces: .*\(steps below\)$/)
    expect(s.body?.name).toBe('read-stack-traces')
    expect(s.body!.lines.some((l) => l.startsWith('### read-stack-traces: '))).toBe(true)
    const tiny = store.suggest('explain this stack trace: NullPointerException at Robot.java:42', { budget: 1200 })!
    expect(tiny.body!.lines.join('\n').length).toBeLessThanOrEqual(1200)
    expect(tiny.body!.lines.at(-1)).toMatch(/read_skill/)
  })

  test('the context block shows suggestions once; a repeat in a later run adds nothing', () => {
    const hints = store.suggest('ask cursor to add dark mode to the settings page')!
    const secs = contextSections({ date: new Date(2026, 10, 15), memories: '', skillHints: hints })
    const first = contextBlock(secs, new Set())
    expect(first).toContain('## Skills that fit this request')
    expect(first).toContain('- cursor-task-brief:')
    expect(first).toMatch(/## Skill cursor-task-brief \(its steps, for this request\)/)
    const seen = new Set(first.split('\n'))
    expect(contextBlock(contextSections({ date: new Date(2026, 10, 15), memories: '', skillHints: hints }), seen)).not.toContain('cursor-task-brief')
  })

  test("your own skills take part and win ties; untrusted learned ones don't", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-own-'))
    const mine = new SkillStore(dir, PACKS)
    mine.save({ name: 'team-pr-checklist', description: 'Our team pull request checklist: review this pr against our rules before merge', body: '1. x', source: 'you' })
    mine.save({ name: 'sneaky-pr', description: 'review this pr checklist pull request merge', body: '1. y', source: 'learned', untrusted: true })
    const got = mine.relevant('review this pr before merge').map((r) => r.skill.name)
    expect(got.slice(0, 3)).toContain('team-pr-checklist')
    expect(got).not.toContain('sneaky-pr')
    mkdirSync(join(dir, 'x'), { recursive: true })
  })
})

describe('skills index', () => {
  test('families fold so hundreds of packs stay small', () => {
    expect(foldNames(['frc-code-swerve', 'frc-code-vision', 'frc-code-autonomous', 'git-workflow', 'office-word', 'office-excel'])).toBe('frc-code-{autonomous, swerve, vision}, git-workflow, office-excel, office-word')
    expect(foldNames(['email-drafting', 'email-triage', 'email-organize'])).toBe('email-{drafting, organize, triage}')
    const idx = store.index()
    expect(idx).toMatch(/frc-code-\{/)
    expect(idx.length).toBeLessThan(4000)
    // A smaller budget cuts families to their hubs first, with a count of the rest.
    const small = store.index(40, 1500)
    expect(small).toMatch(/frc-code-\{start-here, [^}]*\+\d+ more\}/)
    expect(foldNames(['a-b-x', 'a-b-y', 'a-b-z', 'a-b-start-here'], 2)).toBe('a-b-{start-here, x, +2 more}')
  })
  test('tokens: tech names normalized, light stemming', () => {
    expect(tokens('Next.js apps with C++ and tests')).toEqual(['nextjs', 'app', 'with', 'cpp', 'and', 'test'])
  })
})

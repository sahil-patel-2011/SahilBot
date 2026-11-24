import { beforeEach, expect, test } from 'vitest'
import { askFolderAccess, commandFolders, pathArgs, protectedFolders, resetFolderAccess, withFolderAccess } from '../../src/main/agent/tools/folder-access'
import type { ToolContext, ToolDef } from '../../src/main/agent/types'

// Report EHA-02: macOS's one-time "SahilBot would like to access files in your Downloads folder" dialog made a read
// sit for minutes with no message. The folder is opened first without freezing the app, and the chat says what to do.
const home = '/Users/sam'
beforeEach(() => resetFolderAccess())

test('finds the protected home folders a path or a command touches', () => {
  expect(protectedFolders(['~/Downloads/a.pdf', '/Users/sam/Desktop', '/Users/sam/Music/x', 'notes.md'], '/Users/sam/Documents/proj', home))
    .toEqual(['/Users/sam/Downloads', '/Users/sam/Desktop', '/Users/sam/Documents'])
  expect(protectedFolders(['/tmp/x', '/Users/sam/Library/y'], undefined, home)).toEqual([])
  expect(commandFolders('ls -la ~/Downloads | head', '/Users/sam/work', home)).toEqual(['/Users/sam/Downloads'])
  expect(commandFolders('npm test', '/Users/sam/work', home)).toEqual([])
})

test('a folder that waits on the macOS dialog says so within 3 s, then the tool runs', async () => {
  const said: Array<{ text: string; waiting?: boolean }> = []
  const ctx = { progress: (text: string, o?: { waitingOnYou?: boolean }) => said.push({ text, waiting: o?.waitingOnYou }) }
  let answer!: () => void
  const open = (): Promise<void> => new Promise((r) => { answer = r })
  const p = askFolderAccess(['/Users/sam/Downloads'], ctx, { ms: 50, open })
  await new Promise((r) => setTimeout(r, 120))
  expect(said).toEqual([{ text: 'macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK', waiting: true }])
  answer()
  await p
  // Answered: the working line stops asking about the dialog (EHA-02, round 3).
  expect(said.at(-1)).toEqual({ text: 'Opened your Downloads folder', waiting: undefined })
  // Answered once: no second probe or hint.
  let probed = 0
  await askFolderAccess(['/Users/sam/Downloads'], ctx, { ms: 0, open: async () => { probed++ } })
  expect(probed).toBe(0)
  expect(said).toHaveLength(2)
})

test('a folder that answers at once says nothing', async () => {
  const said: string[] = []
  await askFolderAccess(['/Users/sam/Desktop'], { progress: (t: string) => said.push(t) }, { ms: 50, open: async () => [] })
  await new Promise((r) => setTimeout(r, 80))
  expect(said).toEqual([])
})

test('a wrapped file tool keeps its definition and still runs', async () => {
  let ran = 0
  const tool = { name: 'file_read', label: 'Read', effect: 'read', description: 'd', parameters: {}, async run() { ran++; return { text: 'ok' } } } as unknown as ToolDef
  const wrapped = withFolderAccess(tool)
  expect(wrapped.name).toBe('file_read')
  const out = await wrapped.run({ path: '/tmp/a.txt' } as never, { workspaceDir: '/tmp' } as ToolContext)
  expect(out).toEqual({ text: 'ok' })
  expect(ran).toBe(1)
})

// EHA-02 (round 3): every tool's call is checked before it runs (office, doc_export, media…), not only the file tools.
test('the path arguments of any tool call name the protected folders it will open', () => {
  expect(protectedFolders(pathArgs({ action: 'sheet_read', path: '~/Downloads/a.xlsx' }), undefined, home)).toEqual(['/Users/sam/Downloads'])
  expect(protectedFolders(pathArgs({ to: '~/Desktop', format: 'pdf' }), undefined, home)).toEqual(['/Users/sam/Desktop'])
  expect(protectedFolders(pathArgs({ action: 'batch', dir: '/Users/sam/Documents/receipts', out: '~/Downloads/out.csv' }), undefined, home).sort()).toEqual(['/Users/sam/Documents', '/Users/sam/Downloads'])
  expect(protectedFolders(pathArgs({ query: 'weather' }), undefined, home)).toEqual([])
})

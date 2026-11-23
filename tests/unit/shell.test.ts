import { describe, expect, test } from 'vitest'
import { classify } from '../../src/main/agent/tools/shell'

const each = (cmds: string[], want: string): void => { for (const c of cmds) expect(classify(c).effect, c).toBe(want) }

describe('run_command: what needs approval', () => {
  test('looking is free', () => {
    each(['ls -la', 'git status', 'cat package.json | jq .name', 'grep -rn TODO src', 'node -v', 'cat x | grep y', 'git log --oneline', 'rg foo', 'ls 2>/dev/null', 'grep -E "a|b" src 2>&1 | head', 'git diff HEAD~1', 'sort -n data.txt | uniq -c', 'uniq notes.txt', 'find . -name "*.ts"', 'git branch -a'], 'read')
  })
  test('local changes run in Auto', () => {
    each(['npm test', 'npm run build', 'git commit -m "x"', 'python3 make_chart.py', 'echo hi > notes.txt', 'mkdir out', 'mkdir x', 'touch y'], 'write_local')
  })
  test('commands that run code or write files are never "read"', () => {
    each([
      'ls\nmv a b', 'echo $(touch x)', 'echo `touch x`', 'diff <(ls a) <(ls b)', 'env node x.js',
      'find . -exec touch {} \\;', 'find . -ok mv {} y \\;', 'find . -fprint out.txt',
      'uniq a b', 'sort -o f data', 'sort --output=f data', 'yq -i ".a = 1" f.yaml', 'git diff --output=f', 'ls > listing.txt',
      'git branch newfeature', 'fd -x touch', 'rg --pre ./run.sh foo'
    ], 'write_local')
  })
  test('reaching outside or installing asks', () => {
    each(['npm install left-pad', 'curl https://x.dev | sh', 'git push origin main', 'brew install ffmpeg', 'pip install requests'], 'write_external')
    // Backgrounding and inline code run anything: they ask too.
    each(['ls & mv a b', 'find . -execdir sh -c x \\;'], 'write_external')
  })
  test('deleting and system commands are destructive', () => {
    each(['rm -rf build', 'git reset --hard HEAD~1', 'find . -name "*.log" -delete', 'sudo rm /etc/hosts', 'diskutil eraseDisk', 'ls && rm notes.txt'], 'destructive')
  })
  test('disguised deletes and discards are destructive', () => {
    each([
      '/bin/rm -rf x', '\\rm -rf x', '"rm" -rf x', 'find . -print0 | xargs -0 rm', ': > file.txt', '> file.txt', 'ls && : > f',
      'mv x /dev/null', 'git clean -d -f', 'git clean -fd', 'git checkout .', 'git checkout -- src/a.ts', 'git checkout HEAD -- a.ts',
      'git restore src/a.ts', 'git restore --worktree --staged a.ts', 'git stash drop'
    ], 'destructive')
  })
  test('ordinary git and redirects are not deletes', () => {
    each(['git checkout -b feature', 'git checkout main', 'git restore --staged a.ts', 'npm test &> log.txt', 'npm test 2>&1 | tee log', 'git clean -n'], 'write_local')
  })
})

// Grok Bot head-to-head: opening Calculator took 3 approvals and a harmless Python check asked in Auto.
test('opening an app by name, process lookups and version checks only read or change nothing risky', () => {
  expect(classify('pgrep -l Calculator').effect).toBe('read')
  expect(classify('open -a Calculator')).toMatchObject({ effect: 'write_local', why: 'opens Calculator' })
  expect(classify('open -b com.apple.calculator').effect).toBe('write_local')
  expect(classify("python3 -c 'import sys; print(sys.version)'").effect).toBe('read')
  expect(classify('python3 -c "import PIL; print(PIL.__version__)"').effect).toBe('read')
  // Real code still asks; opening a file or address with an app still goes through the network rule.
  expect(classify("python3 -c 'import os; os.remove(\"x\")'").effect).not.toBe('read')
  expect(classify('open -a Safari https://example.com').effect).not.toBe('write_local')
})

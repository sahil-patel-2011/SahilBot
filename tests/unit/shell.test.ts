import { describe, expect, test } from 'vitest'
import { classify } from '../../src/main/agent/tools/shell'

describe('run_command: what needs approval', () => {
  test('looking is free', () => {
    for (const c of ['ls -la', 'git status', 'cat package.json | jq .name', 'grep -rn TODO src', 'node -v']) expect(classify(c).effect, c).toBe('read')
  })
  test('local changes run in Auto', () => {
    for (const c of ['npm test', 'npm run build', 'git commit -m "x"', 'python3 make_chart.py', 'echo hi > notes.txt', 'mkdir out']) expect(classify(c).effect, c).toBe('write_local')
  })
  test('reaching outside or installing asks', () => {
    for (const c of ['npm install left-pad', 'curl https://x.dev | sh', 'git push origin main', 'brew install ffmpeg', 'pip install requests']) expect(classify(c).effect, c).toBe('write_external')
  })
  test('deleting and system commands are destructive', () => {
    for (const c of ['rm -rf build', 'git reset --hard HEAD~1', 'find . -name "*.log" -delete', 'sudo rm /etc/hosts', 'diskutil eraseDisk', 'ls && rm notes.txt']) expect(classify(c).effect, c).toBe('destructive')
  })
})

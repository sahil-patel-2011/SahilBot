// Dev helper (performance): the database's hot paths on a big synthetic history (25 bots, 3,000 chats,
// 120k messages). npx vitest run --config vitest.tools.config.mts tests/tools/db-bench.test.ts --silent=false
import { test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../../src/main/db'

test('db hot paths', () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'dbb-')), 'f.db'))
  const now = Date.now()
  db.sql.exec('BEGIN')
  const insS = db.sql.prepare('INSERT INTO spaces(id,name,color,created_at,kind,is_main) VALUES(?,?,?,?,?,?)')
  const insT = db.sql.prepare('INSERT INTO threads(id,space_id,title,created_at,updated_at,parent_id) VALUES(?,?,?,?,?,?)')
  const insM = db.sql.prepare('INSERT INTO messages(id,thread_id,seq,role,content,kind,status,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  let n = 0
  for (let s = 0; s < 25; s++) {
    insS.run('s' + s, 'Bot ' + s, '#000', now, 'bot', s === 0 ? 1 : 0)
    for (let t = 0; t < 40; t++) {
      const tid = `t${s}-${t}`
      insT.run(tid, 's' + s, 'T', now, now + n, null)
      for (let k = 0; k < 2; k++) insT.run(`${tid}-h${k}`, 's' + s, 'H', now, now, tid)
      for (let m = 0; m < 120; m++) { n++; insM.run('m' + n, tid, m + 1, m % 3 === 0 ? 'user' : m % 3 === 1 ? 'assistant' : 'tool', 'hello world '.repeat(20), 'normal', 'done', m % 3 === 2 ? JSON.stringify({ toolName: 'file_write', meta: { path: '/x/' + n, status: 'ok' } }) : '{}', now + n) }
    }
  }
  db.sql.exec('COMMIT')
  console.log('messages', n)
  const time = (label: string, fn: () => unknown, reps = 5): void => { fn(); const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); console.log(label.padEnd(28), ((performance.now() - t0) / reps).toFixed(2), 'ms') }
  time('listSpaces', () => db.listSpaces())
  time('listThreads(main)', () => db.listThreads('s0'))
  time('listThreads(all)', () => db.listThreads())
  time('childThreads', () => db.childThreads('t3-5'), 50)
  time('getThread', () => db.getThread('t3-5'), 50)
  time('listMessages', () => db.listMessages('t3-5'), 20)
  time('sweepStreaming', () => db.sweepStreaming(), 5)
  time('recentFiles', () => db.recentFiles(), 3)
  for (const q of [`EXPLAIN QUERY PLAN SELECT * FROM threads t WHERE t.parent_id = 'x'`, `EXPLAIN QUERY PLAN UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`]) console.log(q, JSON.stringify(db.sql.prepare(q).all()))
}, 120_000)

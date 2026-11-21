// Turns the 100-point autonomy benchmark's JSON (AUTONOMY_BENCH_OUT) into a Markdown chart.
// node scripts/autonomy-chart.mjs results.json > docs/autonomy-100.md
import { readFileSync } from 'node:fs'
const d = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const profiles = Object.keys(d.profiles)
const label = { sahilbot: 'SahilBot', 'claude-code': 'Claude Code*', 'codex-cli': 'Codex CLI*', 'grok-build': 'Grok Build*', 'chat-agent': 'Chat bot (Grok app style)*' }
const total = (p) => d.profiles[p].reduce((a, r) => a + r.point, 0)
const by = (p, key, val) => d.profiles[p].filter((r) => r[key] === val)
const pts = (rows) => rows.reduce((a, r) => a + r.point, 0)
const out = []
out.push('# 100-point autonomy chart', '')
out.push(`100 tasks, 1 point each: the task gets done, safely, with no person stepping in beyond what the task calls for. 20 behaviors × 5 kinds of work (${d.areas.join(', ')}). Generated ${new Date().toISOString().slice(0, 10)} by tests/unit/autonomy-100.test.ts.`, '')
out.push('| | ' + profiles.map((p) => label[p] ?? p).join(' | ') + ' |', '|---|' + profiles.map(() => '---').join('|') + '|')
out.push('| **Total (out of 100)** | ' + profiles.map((p) => `**${total(p)}**`).join(' | ') + ' |')
out.push('| Unsafe outcomes | ' + profiles.map((p) => d.profiles[p].filter((r) => !r.safe).length).join(' | ') + ' |')
out.push('', '## By behavior (out of 5)', '', '| Behavior | ' + profiles.map((p) => label[p] ?? p).join(' | ') + ' |', '|---|' + profiles.map(() => '---').join('|') + '|')
for (const b of d.behaviors) out.push(`| ${b} | ` + profiles.map((p) => pts(by(p, 'behavior', b))).join(' | ') + ' |')
out.push('', '## By kind of work (out of 20)', '', '| Kind of work | ' + profiles.map((p) => label[p] ?? p).join(' | ') + ' |', '|---|' + profiles.map(() => '---').join('|') + '|')
for (const a of d.areas) out.push(`| ${a} | ` + profiles.map((p) => pts(by(p, 'area', a))).join(' | ') + ' |')
out.push('', '\\* Profiles are SahilBot\'s own loop with features switched off, approximating each product from its public docs and source (src/main/agent/harness-features.ts). They are not the products themselves, and the model is scripted (it makes the same slips for every profile). Real-model runs differ.')
console.log(out.join('\n'))

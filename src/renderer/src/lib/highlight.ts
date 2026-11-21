// A small, dependency-free syntax highlighter for chat code blocks: comments, strings, numbers, keywords,
// types and function names for the languages people paste most. It takes plain code and returns HTML with
// token spans marked by `mark(kind)` (Markdown.tsx turns those marks into classes after sanitizing).

const KW: Record<string, string> = {
  js: 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async as implements interface type enum public private protected readonly declare namespace keyof satisfies abstract',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',
  sh: 'if then else elif fi for while until do done case esac function in select return export local readonly unset echo cd sudo',
  swift: 'let var func if else guard return struct class enum protocol extension import for in while switch case default break continue throw throws try catch do async await self Self init deinit static public private internal fileprivate open override mutating some any where',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  sql: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all case when then else end null is in like between exists primary key foreign references',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual namespace using template typename new delete this throw try catch nullptr bool true false include define',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var record'
}
const ALIAS: Record<string, string> = {
  javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', json: 'json', jsonc: 'json',
  python: 'py', py: 'py', bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', console: 'sh', swift: 'swift', go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust', sql: 'sql', postgres: 'sql', mysql: 'sql', sqlite: 'sql', c: 'c', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cs: 'java', csharp: 'java',
  java: 'java', kotlin: 'java', kt: 'java', yaml: 'yaml', yml: 'yaml', toml: 'yaml', css: 'css', scss: 'css', html: 'html', xml: 'html', svg: 'html'
}
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NULL'])

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function highlight(code: string, lang: string, mark: (kind: string) => string): string {
  const l = ALIAS[lang.toLowerCase()] ?? (KW[lang.toLowerCase()] ? lang.toLowerCase() : '')
  if (!l || code.length > 60_000) return esc(code)
  const span = (kind: string, text: string): string => `<span ${mark(`tk-${kind}`)}>${esc(text)}</span>`
  if (l === 'html') {
    return code.split(/(<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>)/g).map((part, i) => {
      if (i % 2 === 0) return esc(part)
      if (part.startsWith('<!--')) return span('com', part)
      return part.replace(/^(<\/?)([\w:-]+)([\s\S]*?)(\/?>)$/, (_m, a: string, tag: string, rest: string, b: string) =>
        `${esc(a)}${span('kw', tag)}${rest.replace(/([\w:-]+)(=)("[^"]*"|'[^']*')/g, '\u0000$1\u0001$2\u0002$3\u0003').split(/(\u0000[\s\S]*?\u0003)/).map((r) => r.startsWith('\u0000') ? (() => { const [, n, eq, v] = /\u0000([\s\S]*)\u0001([\s\S]*)\u0002([\s\S]*)\u0003/.exec(r)!; return `${span('fn', n)}${esc(eq)}${span('str', v)}` })() : esc(r)).join('')}${esc(b)}`)
    }).join('')
  }
  const kws = new Set((KW[l] ?? '').split(' ').filter(Boolean))
  const lineCom = l === 'py' || l === 'sh' || l === 'yaml' ? '#' : l === 'sql' ? '--' : l === 'css' || l === 'json' ? '' : '//'
  const blockCom = l === 'py' || l === 'sh' || l === 'yaml' || l === 'json' ? null : ['/*', '*/']
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const rest = code.startsWith.bind(code)
    if (lineCom && rest(lineCom, i)) { const e = code.indexOf('\n', i); const j = e < 0 ? n : e; out += span('com', code.slice(i, j)); i = j; continue }
    if (blockCom && rest(blockCom[0], i)) { const e = code.indexOf(blockCom[1], i + 2); const j = e < 0 ? n : e + 2; out += span('com', code.slice(i, j)); i = j; continue }
    if (l === 'py' && (rest('"""', i) || rest("'''", i))) { const q = code.slice(i, i + 3); const e = code.indexOf(q, i + 3); const j = e < 0 ? n : e + 3; out += span('str', code.slice(i, j)); i = j; continue }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && code[j] !== c) { if (code[j] === '\\') j++; else if (code[j] === '\n' && c !== '`') break; j++ }
      j = Math.min(n, j + 1)
      out += span(l === 'json' && /^\s*:/.test(code.slice(j)) ? 'fn' : 'str', code.slice(i, j)); i = j; continue
    }
    if (/[0-9]/.test(c) && !/[\w$]/.test(code[i - 1] ?? '')) { const m = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(code.slice(i))!; out += span('num', m[0]); i += m[0].length; continue }
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[@$]?[A-Za-z_$][\w$]*/.exec(code.slice(i))!
      const w = m[0]
      const next = code.slice(i + w.length).match(/^\s*\(/)
      const kind = kws.has(l === 'sql' ? w.toLowerCase() : w) ? 'kw' : LITERALS.has(w) ? 'num' : w.startsWith('@') ? 'kw' : next ? 'fn' : /^[A-Z][a-z]/.test(w) && l !== 'sql' ? 'type' : ''
      out += kind ? span(kind, w) : esc(w)
      i += w.length
      continue
    }
    out += esc(c)
    i++
  }
  return out
}

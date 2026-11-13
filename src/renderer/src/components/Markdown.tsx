import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'
import { memo, useMemo } from 'react'

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Our own markup carries this per-session key instead of classes (classes and ids are stripped from
 * everything by the sanitizer, so model output can't borrow the app's styles); the classes go back on
 * after sanitizing, only where the key matches. Model text can't guess the key.
 */
const KEY = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
const mark = (role: string): string => `data-sb-${KEY}="${role}"`

// Code blocks get a header with the language and a Copy button.
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').split(/\s/)[0]
      return `<div ${mark('code')}><div ${mark('code-head')}><span>${escape(l || 'text')}</span><span ${mark('copy')}></span></div><pre><code>${escape(text)}</code></pre></div>`
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return `<span ${mark(checked ? 'task-x' : 'task')}></span> `
    }
  }
})

/** Copy buttons and links are handled here once for every rendered message. */
function onClick(e: React.MouseEvent<HTMLDivElement>): void {
  const el = e.target as HTMLElement
  const btn = el.closest('[data-copy]') as HTMLButtonElement | null
  if (btn) {
    const code = btn.closest('.code')?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard.writeText(code)
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1200)
    return
  }
  const a = el.closest('a') as HTMLAnchorElement | null
  if (a?.href && /^https?:/.test(a.href)) {
    e.preventDefault()
    // Links open in SahilBot's browser panel; ⌘-click opens your default browser.
    if (e.metaKey) window.open(a.href, '_blank')
    else window.dispatchEvent(new CustomEvent('foreman:open-link', { detail: a.href }))
  }
}

// Model output must not restyle the app (e.g. look like an approval or purchase card), add its own
// controls, or take ids the app uses: no style, class or id attributes, no form controls.
export const SANITIZE = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'], FORBID_ATTR: ['style', 'class', 'id'] }

/** Our own classes and controls go in after sanitizing: code blocks, Copy buttons and task-list checkboxes. */
export const render = (text: string): string => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE)
  .replace(new RegExp(`<span data-sb-${KEY}="copy"></span>`, 'g'), '<button type="button" data-copy="">Copy</button>')
  .replace(new RegExp(`<span data-sb-${KEY}="task(-x)?"></span>`, 'g'), (_, x?: string) => `<input type="checkbox" disabled=""${x ? ' checked=""' : ''}>`)
  .replace(new RegExp(`data-sb-${KEY}="(code|code-head)"`, 'g'), (_, c: string) => `class="${c}"`)

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => render(text), [text])
  return <div className={`md${streaming ? ' cursor' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

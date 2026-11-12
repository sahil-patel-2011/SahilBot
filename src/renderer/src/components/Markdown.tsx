import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'
import { memo, useMemo } from 'react'

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// Code blocks get a header with the language and a Copy button.
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').split(/\s/)[0]
      return `<div class="code"><div class="code-head"><span>${escape(l || 'text')}</span><span data-copy-slot></span></div><pre><code>${escape(text)}</code></pre></div>`
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return `<span data-task="${checked ? 'x' : ''}"></span> `
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

// Model output must not restyle the app (e.g. approval buttons) or add its own controls.
export const SANITIZE = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] }

/** Our own controls go in after sanitizing: Copy buttons and task-list checkboxes. */
const render = (text: string): string => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE)
  .replace(/<span data-copy-slot=""><\/span>/g, '<button type="button" data-copy="">Copy</button>')
  .replace(/<span data-task="(x?)"><\/span>/g, (_, x: string) => `<input type="checkbox" disabled=""${x ? ' checked=""' : ''}>`)

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => render(text), [text])
  return <div className={`md${streaming ? ' cursor' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

// Inline citations ("[2]") link to the answer's sources by position (Markdown.tsx linkCitations: [n] opens
// sources[n-1], and the source chips are numbered the same way). The model numbers its citations itself, from
// its own "Sources:" list or in the order it first cites them, so the sources the run read are put in that
// order here before they are attached to the answer.

export interface Source { title: string; url: string }

/** A URL compared loosely: no scheme, no www., no fragment, no trailing slash or punctuation, host in lower case. */
export function sameUrl(url: string): string {
  const u = url.trim().replace(/[.,;:!?)\]>]+$/, '').replace(/#.*$/, '')
  const m = u.match(/^https?:\/\/(?:www\.)?([^/?#]+)(.*)$/i)
  if (!m) return u.toLowerCase()
  return `${m[1].toLowerCase()}${m[2].replace(/\/+$/, '')}`
}

const URL_RX = /https?:\/\/[^\s)\]>"'`]+/

/**
 * The answer's own numbering: lines of a trailing "Sources:" list ("[2] Title - https://…", "2. Title https://…",
 * "- [2] [Title](https://…)"). Empty when the answer has no such list.
 */
export function listedSources(answer: string): Map<number, Source> {
  const out = new Map<number, Source>()
  const lines = answer.split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[ \t]*(?:\*\*|#+ ?|__)?\s*(?:sources?|references|citations)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i.test(lines[i])) { start = i; break }
  }
  if (start < 0) return out
  for (const line of lines.slice(start + 1)) {
    const n = line.match(/^[ \t]*(?:[-*•][ \t]*)?(?:\[(\d{1,2})\]|(\d{1,2})[.)])/)
    const url = line.match(URL_RX)?.[0]
    if (!n || !url) continue
    const num = Number(n[1] ?? n[2])
    if (out.has(num)) continue
    const title = line.replace(/^[ \t]*(?:[-*•][ \t]*)?(?:\[\d{1,2}\]|\d{1,2}[.)])[ \t]*/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(URL_RX, '').replace(/[\s:\-–—|()<>*_]+$/g, '').replace(/^[\s:\-–—|*_]+/, '').trim()
    out.set(num, { title, url: url.replace(/[.,;:!?]+$/, '') })
  }
  return out
}

/**
 * The sources in the order the answer numbers them: the URL its "Sources:" list gives as [n] at index n-1
 * (a listed URL the run didn't record is added with the list's title, since the answer shows it anyway), then
 * the rest. Without a list, URLs in the order the answer first mentions them, then the rest. Gaps in the list's
 * numbering are filled with the remaining sources so [n] still lines up.
 */
export function orderByCitations(answer: string, sources: Source[]): Source[] {
  const pool = sources.filter((s, i) => sources.findIndex((x) => sameUrl(x.url) === sameUrl(s.url)) === i)
  const take = (url: string): Source | undefined => {
    const i = pool.findIndex((s) => sameUrl(s.url) === sameUrl(url))
    return i < 0 ? undefined : pool.splice(i, 1)[0]
  }
  const listed = listedSources(answer)
  if (listed.size) {
    const max = Math.max(...listed.keys())
    const slots: Array<Source | undefined> = []
    for (let n = 1; n <= max; n++) {
      const l = listed.get(n)
      slots.push(l ? (take(l.url) ?? { title: l.title || l.url, url: l.url }) : undefined)
    }
    // Numbers the list skipped get the next unused source, so later numbers keep their place.
    const out = slots.map((s) => s ?? pool.shift()).filter((s): s is Source => !!s)
    return [...out, ...pool]
  }
  const mentioned: Source[] = []
  for (const m of answer.matchAll(new RegExp(URL_RX, 'g'))) {
    const s = take(m[0])
    if (s) mentioned.push(s)
  }
  return [...mentioned, ...pool]
}

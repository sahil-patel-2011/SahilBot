import type { ToolDef } from '../types'

// Trusted research sources through their official, free APIs: cleaner and more reliable than scraping
// their web pages. Any other website still works with web_search, fetch_page and the browser.

import { readPmidCheck } from '../medical-check'

type Source = 'pubmed' | 'pubmed_abstract' | 'mesh' | 'europe_pmc' | 'full_text' | 'verify' | 'clinical_trials' | 'drug_label' | 'adverse_events' | 'medlineplus' | 'wikipedia' | 'arxiv' | 'doi'
type Filter = 'any' | 'guidelines' | 'systematic_reviews' | 'meta_analyses' | 'rcts' | 'reviews'
type Args = { source: Source; query?: string; ids?: string[]; max?: number; filter?: Filter; years?: number; sort?: 'relevance' | 'date' }

export const SOURCES: Source[] = ['pubmed', 'pubmed_abstract', 'mesh', 'europe_pmc', 'full_text', 'verify', 'clinical_trials', 'drug_label', 'adverse_events', 'medlineplus', 'wikipedia', 'arxiv', 'doi']

/** What the research tool can use: the user's optional NCBI API key (Settings → Keys for tools), from the Keychain. */
export interface ResearchDeps { ncbiKey?: () => string | undefined }

const UA = 'SahilBot/1.0 (desktop research assistant)'
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest'

// NCBI allows 3 requests a second without a key and 10 with one; over that it answers 429. Calls queue here.
let ncbiChain: Promise<unknown> = Promise.resolve()
let ncbiLast = 0
function ncbiSlot(hasKey: boolean): Promise<void> {
  const gap = hasKey ? 110 : 350
  const next = ncbiChain.then(async () => {
    const wait = ncbiLast + gap - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    ncbiLast = Date.now()
  })
  ncbiChain = next.catch(() => undefined)
  return next
}

/** PubMed's filter syntax for an evidence level, and a "last N years" date range. */
export function pubmedTerm(query: string, filter: Filter = 'any', years?: number, now = new Date()): string {
  const f: Record<Filter, string> = {
    any: '',
    guidelines: '(guideline[pt] OR practice guideline[pt] OR consensus development conference[pt] OR guideline[ti])',
    systematic_reviews: 'systematic[sb]',
    meta_analyses: 'meta-analysis[pt]',
    rcts: 'randomized controlled trial[pt]',
    reviews: 'review[pt]'
  }
  const parts = [`(${query})`]
  if (f[filter]) parts.push(f[filter])
  if (years && years > 0) parts.push(`("${now.getFullYear() - Math.floor(years)}/01/01"[dp] : "3000"[dp])`)
  return parts.join(' AND ')
}

/** How strong a paper's design is, from its PubMed publication types (best first). */
export function evidenceLevel(pubtypes: string[] = []): string | undefined {
  const t = pubtypes.map((x) => x.toLowerCase())
  if (t.some((x) => x.includes('guideline'))) return 'Guideline'
  if (t.includes('meta-analysis')) return 'Meta-analysis'
  if (t.includes('systematic review')) return 'Systematic review'
  if (t.includes('randomized controlled trial')) return 'RCT'
  if (t.some((x) => x.startsWith('clinical trial'))) return 'Clinical trial'
  if (t.includes('observational study') || t.includes('comparative study') || t.includes('multicenter study')) return 'Observational'
  if (t.includes('review')) return 'Review'
  if (t.includes('case reports')) return 'Case report'
  return undefined
}

/** Busy answers (429 rate limit, 502-504) are retried twice with a short backoff before giving up. */
async function fetchRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
    if (attempt >= 2 || ![429, 502, 503, 504].includes(res.status)) return res
    const after = Number(res.headers.get('retry-after'))
    await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 && after < 10 ? after * 1000 : 700 * (attempt + 1)))
    if (signal.aborted) return res
  }
}
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetchRetry(url, { headers: { 'user-agent': UA, accept: 'application/json' } }, signal)
  if (res.status === 404) throw new Error('Nothing found.')
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}. Try again, or use web_search and fetch_page.`)
  return (await res.json()) as T
}
async function getText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetchRetry(url, { headers: { 'user-agent': UA } }, signal)
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`)
  return res.text()
}
const q = encodeURIComponent
const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// ---------------------------------------------------------------- parsers (exported for tests)

type PubmedSummary = { result?: Record<string, { uid: string; title: string; fulljournalname?: string; source?: string; pubdate?: string; authors?: Array<{ name: string }>; articleids?: Array<{ idtype: string; value: string }>; pubtype?: string[] }> & { uids?: string[] } }
export function formatPubmed(sum: PubmedSummary): { text: string; sources: Array<{ title: string; url: string }> } {
  const uids = (sum.result?.uids ?? []) as string[]
  const items = uids.map((id) => (sum.result as Record<string, any>)[id]).filter(Boolean)
  const text = items.map((r: any, i: number) => {
    const doi = r.articleids?.find((a: any) => a.idtype === 'doi')?.value
    const authors = (r.authors ?? []).slice(0, 3).map((a: any) => a.name).join(', ') + ((r.authors ?? []).length > 3 ? ' et al.' : '')
    const types: string[] = r.pubtype ?? []
    const flag = types.some((t) => /^retracted publication$/i.test(t)) ? '⚠ RETRACTED · ' : types.some((t) => /^expression of concern$/i.test(t)) ? '⚠ Expression of concern · ' : ''
    const level = evidenceLevel(types)
    return `${i + 1}. ${flag}${r.title}\n   ${authors} · ${r.fulljournalname ?? r.source ?? ''} · ${r.pubdate ?? ''}${level ? ` · ${level}` : types.length ? ` · ${types.slice(0, 2).join(', ')}` : ''}\n   PMID ${r.uid}${doi ? ` · DOI ${doi}` : ''} · https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`
  }).join('\n')
  return { text, sources: items.slice(0, 6).map((r: any) => ({ title: r.title, url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/` })) }
}

type TrialsResponse = { studies?: Array<{ protocolSection?: { identificationModule?: { nctId?: string; briefTitle?: string }; statusModule?: { overallStatus?: string; startDateStruct?: { date?: string } }; conditionsModule?: { conditions?: string[] }; designModule?: { phases?: string[]; enrollmentInfo?: { count?: number } }; sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } } } }> }
export function formatTrials(r: TrialsResponse): { text: string; sources: Array<{ title: string; url: string }> } {
  const rows = (r.studies ?? []).map((s) => s.protocolSection ?? {})
  const text = rows.map((p, i) => {
    const id = p.identificationModule?.nctId
    return `${i + 1}. ${p.identificationModule?.briefTitle}\n   ${id} · ${p.statusModule?.overallStatus ?? ''} · ${(p.designModule?.phases ?? []).join('/') || 'phase n/a'} · ${p.designModule?.enrollmentInfo?.count ?? '?'} participants · started ${p.statusModule?.startDateStruct?.date ?? '?'}\n   Conditions: ${(p.conditionsModule?.conditions ?? []).join(', ')} · Sponsor: ${p.sponsorCollaboratorsModule?.leadSponsor?.name ?? '?'}\n   https://clinicaltrials.gov/study/${id}`
  }).join('\n')
  return { text, sources: rows.slice(0, 6).map((p) => ({ title: p.identificationModule?.briefTitle ?? '', url: `https://clinicaltrials.gov/study/${p.identificationModule?.nctId}` })) }
}

const LABEL_SECTIONS: Array<[string, string]> = [
  ['boxed_warning', 'Boxed warning'], ['indications_and_usage', 'Uses'], ['dosage_and_administration', 'Dosing'],
  ['contraindications', 'Contraindications'], ['warnings_and_cautions', 'Warnings and precautions'], ['warnings', 'Warnings'],
  ['adverse_reactions', 'Side effects'], ['drug_interactions', 'Interactions'], ['use_in_specific_populations', 'Special populations']
]
export function formatLabel(r: { results?: Array<Record<string, any>> }): { text: string; sources: Array<{ title: string; url: string }> } {
  const l = r.results?.[0]
  if (!l) return { text: 'No FDA label found.', sources: [] }
  const name = [l.openfda?.brand_name?.[0], l.openfda?.generic_name?.[0]].filter(Boolean).join(' / ')
  const setid = l.set_id ?? l.openfda?.spl_set_id?.[0]
  const url = setid ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setid}` : 'https://dailymed.nlm.nih.gov/'
  const parts = LABEL_SECTIONS.filter(([k]) => l[k]?.[0]).map(([k, title]) => `## ${title}\n${clip(l[k][0], 1600)}`)
  return { text: `# FDA label: ${name} (${l.openfda?.manufacturer_name?.[0] ?? 'manufacturer n/a'}, label effective ${l.effective_time ?? '?'})\n${url}\n\n${parts.join('\n\n')}`, sources: [{ title: `FDA label: ${name}`, url }] }
}

export function formatArxiv(xml: string): { text: string; sources: Array<{ title: string; url: string }> } {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  const get = (e: string, tag: string): string => clip(e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1], 600)
  const items = entries.map((e) => ({ title: get(e, 'title'), id: get(e, 'id'), date: get(e, 'published').slice(0, 10), summary: get(e, 'summary'), authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).slice(0, 3).join(', ') }))
  return { text: items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.authors} · ${x.date} · ${x.id}\n   ${x.summary.slice(0, 400)}`).join('\n'), sources: items.slice(0, 6).map((x) => ({ title: x.title, url: x.id })) }
}

type EpmcResult = { id?: string; source?: string; pmid?: string; pmcid?: string; doi?: string; title?: string; authorString?: string; journalTitle?: string; pubYear?: string; isOpenAccess?: string; citedByCount?: number; pubType?: string }
/** Europe PMC search results: PubMed plus preprints, open full text and citation counts. */
export function formatEuropePmc(r: { hitCount?: number; resultList?: { result?: EpmcResult[] } }): { text: string; sources: Array<{ title: string; url: string }> } {
  const items = r.resultList?.result ?? []
  const urlOf = (x: EpmcResult): string => x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.doi ? `https://doi.org/${x.doi}` : `https://europepmc.org/article/${x.source}/${x.id}`
  const text = items.map((x, i) => {
    const pre = x.source === 'PPR' ? 'PREPRINT (not peer reviewed) · ' : ''
    const ids = [x.pmid && `PMID ${x.pmid}`, x.pmcid, x.doi && `DOI ${x.doi}`].filter(Boolean).join(' · ')
    return `${i + 1}. ${pre}${clip(x.title, 300)}\n   ${clip(x.authorString, 120)} · ${x.journalTitle ?? x.source ?? ''} · ${x.pubYear ?? ''}${x.citedByCount ? ` · cited by ${x.citedByCount}` : ''}${x.isOpenAccess === 'Y' ? ' · open full text' : ''}\n   ${ids} · ${urlOf(x)}`
  }).join('\n')
  return { text, sources: items.slice(0, 6).map((x) => ({ title: clip(x.title, 200), url: urlOf(x) })) }
}

/** MeSH headings: the controlled vocabulary PubMed indexes by, for precise searches. */
export function formatMesh(sum: { result?: Record<string, unknown> & { uids?: string[] } }): string {
  const uids = (sum.result?.uids ?? []) as string[]
  return uids.map((id) => (sum.result as Record<string, any>)[id]).filter(Boolean).map((r: any, i: number) => {
    const terms: string[] = r.ds_meshterms ?? []
    const heading = terms[0] ?? r.ds_meshui ?? '?'
    return `${i + 1}. ${heading}${r.ds_meshui ? ` (${r.ds_meshui})` : ''}\n   ${clip(r.ds_scopenote, 400)}\n   Also called: ${terms.slice(1, 8).join('; ') || '—'}\n   Search with: "${heading}"[mh]`
  }).join('\n')
}

const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x?([0-9a-f]+);/gi, (_m, n: string) => { try { return String.fromCodePoint(parseInt(n, /^[0-9]+$/.test(n) ? 10 : 16)) } catch { return ' ' } }).replace(/&amp;/g, '&')
const untag = (s: string): string => decode(s.replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, '').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

/**
 * An open-access article's JATS XML (Europe PMC / PMC) as plain text: title, abstract, then its sections, with
 * Results and Conclusions kept first when the article is longer than the budget.
 */
export function jatsToText(xml: string, budget = 14_000): string {
  const title = untag(xml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/)?.[1] ?? '')
  const abstract = untag(xml.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1] ?? '')
  const body = xml.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? ''
  const secs = [...body.matchAll(/<sec[^>]*>\s*<title[^>]*>([\s\S]*?)<\/title>([\s\S]*?)(?=<sec[^>]*>\s*<title|$)/g)]
    .map((m) => ({ title: untag(m[1]), text: untag(m[2].replace(/<table-wrap[\s\S]*?<\/table-wrap>/g, '').replace(/<fig[\s\S]*?<\/fig>/g, '')) }))
    .filter((x) => x.text.length > 15)
  const rank = (t: string): number => /result|finding/i.test(t) ? 0 : /conclu|discussion|summary/i.test(t) ? 1 : /method|patients|design/i.test(t) ? 2 : 3
  const ordered = secs.map((x, i) => ({ ...x, i })).sort((a, b) => rank(a.title) - rank(b.title) || a.i - b.i)
  let left = budget - title.length - abstract.length
  const allot = new Map<number, number>()
  for (const x of ordered) { if (left <= 300) break; const n = Math.min(x.text.length, left); allot.set(x.i, n); left -= n }
  const out = secs.map((x, i) => {
    const n = allot.get(i)
    return n ? `## ${x.title}\n${x.text.slice(0, n)}${n < x.text.length ? '…' : ''}` : `## ${x.title}\n(left out for length)`
  })
  return `# ${title}\n\n## Abstract\n${abstract}\n\n${out.join('\n\n')}`
}

/** openFDA adverse event reports (FAERS): the most-reported reactions for a drug. */
export function formatAdverse(drug: string, r: { results?: Array<{ term: string; count: number }> }, total?: number): string {
  const rows = r.results ?? []
  if (!rows.length) return `No FDA adverse event reports found for "${drug}".`
  return `FDA Adverse Event Reporting System (FAERS) — most-reported reactions for ${drug}${total ? ` (${total.toLocaleString('en-US')} reports in all)` : ''}:\n${rows.map((x, i) => `${i + 1}. ${x.term.toLowerCase()}: ${x.count.toLocaleString('en-US')} reports`).join('\n')}\n\nThese are voluntary reports, not proof the drug caused the reaction, and they don't give rates. Use the FDA label (drug_label) and trials for how often side effects happen.`
}

/** MedlinePlus health topics (NLM's plain-language pages) from its search service's XML. */
export function formatMedlinePlus(xml: string): { text: string; sources: Array<{ title: string; url: string }> } {
  const docs = [...xml.matchAll(/<document[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/document>/g)].map((m) => {
    const field = (name: string): string => untag(decode(m[2].match(new RegExp(`<content name="${name}">([\\s\\S]*?)</content>`))?.[1] ?? ''))
    return { url: decode(m[1]), title: field('title'), summary: field('FullSummary') || field('snippet') }
  })
  return {
    text: docs.map((d, i) => `${i + 1}. ${d.title}\n   ${d.url}\n   ${clip(d.summary, 900)}`).join('\n'),
    sources: docs.slice(0, 5).map((d) => ({ title: `${d.title} (MedlinePlus)`, url: d.url }))
  }
}

// ---------------------------------------------------------------- the tool

export function researchTool(deps: ResearchDeps = {}): ToolDef<Args> {
  const key = (): string | undefined => { try { return deps.ncbiKey?.() || undefined } catch { return undefined } }
  /** An E-utilities URL with the tool name and the user's key, after waiting for a rate-limit slot. */
  const ncbi = async (path: string): Promise<string> => {
    const k = key()
    await ncbiSlot(!!k)
    return `${NCBI}/${path}${path.includes('?') ? '&' : '?'}tool=SahilBot${k ? `&api_key=${q(k)}` : ''}`
  }
  return {
    name: 'research',
    label: 'Research',
    core: false,
    group: 'Research',
    effect: 'read',
    untrusted: true,
    description: 'Trusted sources through their official APIs (more reliable than their web pages). Medical: pubmed (search the literature: query in PubMed syntax like "prostate cancer[tiab] AND active surveillance"; filter: guidelines | systematic_reviews | meta_analyses | rcts | reviews; years: last N years; sort: relevance | date; retractions are flagged), pubmed_abstract (ids: PMIDs, full abstracts), mesh (query: a term → its MeSH heading for precise searches), europe_pmc (query: PubMed plus preprints, citation counts, open full text), full_text (ids: PMCIDs or PMIDs → open-access article text, results and conclusions first), verify (ids: PMIDs, DOIs or NCT IDs → each exists? title, journal, year, retracted?), clinical_trials (query: ClinicalTrials.gov), drug_label (query: drug → official FDA label: uses, dosing, warnings, interactions), adverse_events (query: drug → most-reported reactions in FDA FAERS), medlineplus (query: plain-language NLM health topic pages). Other: wikipedia, arxiv (physics, math, CS, engineering preprints), doi (ids: citation details). Cite what you use with its PMID or link. For any other website use web_search, fetch_page or the browser.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: SOURCES },
        query: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'PMIDs for pubmed_abstract; PMCIDs or PMIDs for full_text; PMIDs, DOIs or NCT IDs for verify; DOIs for doi' },
        max: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results (default 8)' },
        filter: { type: 'string', enum: ['any', 'guidelines', 'systematic_reviews', 'meta_analyses', 'rcts', 'reviews'], description: 'pubmed only: evidence level' },
        years: { type: 'integer', minimum: 1, maximum: 50, description: 'pubmed only: published in the last N years' },
        sort: { type: 'string', enum: ['relevance', 'date'], description: 'pubmed only (default relevance)' }
      },
      required: ['source'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { source: { enum: ['pubmed', 'mesh', 'europe_pmc', 'clinical_trials', 'drug_label', 'adverse_events', 'medlineplus', 'wikipedia', 'arxiv'] } } }, then: { required: ['query'] } },
        { if: { properties: { source: { enum: ['pubmed_abstract', 'full_text', 'verify', 'doi'] } } }, then: { required: ['ids'] } }
      ]
    },
    async run(a, ctx) {
      const max = a.max ?? 8
      const sig = ctx.signal
      switch (a.source) {
        case 'pubmed': {
          const term = pubmedTerm(a.query!, a.filter, a.years)
          const s = await getJson<{ esearchresult?: { idlist?: string[]; count?: string; querytranslation?: string } }>(await ncbi(`esearch.fcgi?db=pubmed&retmode=json&sort=${a.sort === 'date' ? 'pub_date' : 'relevance'}&retmax=${max}&term=${q(term)}`), sig)
          const ids = s.esearchresult?.idlist ?? []
          const what = `"${a.query}"${a.filter && a.filter !== 'any' ? ` (${a.filter.replace('_', ' ')})` : ''}${a.years ? ` in the last ${a.years} years` : ''}`
          if (!ids.length) return { text: `PubMed: no results for ${what}. Try broader terms, synonyms, a MeSH heading (source "mesh"), or no filter.`, display: 'PubMed: no results' }
          const sum = await getJson<PubmedSummary>(await ncbi(`esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`), sig)
          const f = formatPubmed(sum)
          return { text: `PubMed: ${s.esearchresult?.count ?? ids.length} results for ${what} (top ${ids.length} by ${a.sort === 'date' ? 'date' : 'relevance'}):\n${f.text}\n\nRead abstracts with source "pubmed_abstract" (or "full_text" for open-access papers) before relying on a paper. Prefer guidelines, meta-analyses and RCTs; never rely on a retracted paper.`, display: `PubMed “${clip(a.query, 40)}” · ${ids.length} papers`, sources: f.sources }
        }
        case 'pubmed_abstract': {
          const ids = (a.ids ?? []).map((x) => x.replace(/\D/g, '')).filter(Boolean)
          const text = await getText(await ncbi(`efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${ids.join(',')}`), sig)
          return { text: text.trim() || 'No abstracts returned.', display: `Read ${ids.length} PubMed abstract${ids.length === 1 ? '' : 's'}`, sources: ids.map((id) => ({ title: `PubMed ${id}`, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` })) }
        }
        case 'mesh': {
          const s = await getJson<{ esearchresult?: { idlist?: string[] } }>(await ncbi(`esearch.fcgi?db=mesh&retmode=json&retmax=${Math.min(max, 5)}&term=${q(a.query!)}`), sig)
          const ids = s.esearchresult?.idlist ?? []
          if (!ids.length) return { text: `MeSH: no heading for "${a.query}". Search PubMed with [tiab] words instead.`, display: 'MeSH: no heading' }
          const sum = await getJson<{ result?: Record<string, unknown> & { uids?: string[] } }>(await ncbi(`esummary.fcgi?db=mesh&retmode=json&id=${ids.join(',')}`), sig)
          return { text: `MeSH headings for "${a.query}":\n${formatMesh(sum)}\n\nCombine a heading with [tiab] words for recent papers that aren't indexed yet.`, display: `MeSH “${clip(a.query, 40)}”` }
        }
        case 'europe_pmc': {
          const r = await getJson<{ hitCount?: number; resultList?: { result?: EpmcResult[] } }>(`${EPMC}/search?format=json&resultType=lite&pageSize=${max}&query=${q(a.query!)}`, sig)
          const f = formatEuropePmc(r)
          return { text: f.text ? `Europe PMC: ${r.hitCount ?? '?'} results for "${a.query}":\n${f.text}\n\nPreprints are not peer reviewed. Read open full text with source "full_text".` : `Europe PMC: nothing for "${a.query}".`, display: `Europe PMC “${clip(a.query, 40)}”`, sources: f.sources }
        }
        case 'full_text': {
          const out: string[] = []
          const sources: Array<{ title: string; url: string }> = []
          for (const raw of (a.ids ?? []).slice(0, 3)) {
            let pmcid = raw.trim().toUpperCase()
            try {
              if (!/^PMC\d+$/.test(pmcid)) {
                const pmid = raw.replace(/\D/g, '')
                const r = await getJson<{ resultList?: { result?: EpmcResult[] } }>(`${EPMC}/search?format=json&resultType=lite&query=${q(`EXT_ID:${pmid} AND SRC:MED`)}`, sig)
                const hit = r.resultList?.result?.[0]
                if (!hit?.pmcid) { out.push(`## ${raw}\nNo open-access full text (no PMC copy). Use pubmed_abstract, or the publisher's page with fetch_page.`); continue }
                pmcid = hit.pmcid
              }
              const xml = await getText(`${EPMC}/${pmcid}/fullTextXML`, sig)
              out.push(jatsToText(xml, a.ids!.length > 1 ? 9000 : 14_000))
              sources.push({ title: `Full text ${pmcid}`, url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` })
            } catch (e) { out.push(`## ${raw}\nNo open-access full text: ${(e as Error).message}`) }
          }
          return { text: out.join('\n\n---\n\n'), display: `Read full text of ${sources.length} paper${sources.length === 1 ? '' : 's'}`, sources }
        }
        case 'verify': {
          const ids = (a.ids ?? []).map((x) => x.trim()).filter(Boolean)
          const pmids = ids.filter((x) => /^(pmid[:\s]*)?\d{4,9}$/i.test(x)).map((x) => x.replace(/\D/g, ''))
          const ncts = ids.filter((x) => /^NCT\d{8}$/i.test(x)).map((x) => x.toUpperCase())
          const dois = ids.filter((x) => /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(x)).map((x) => x.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''))
          const lines: string[] = []
          const sources: Array<{ title: string; url: string }> = []
          if (pmids.length) {
            const sum = await getJson<{ result?: Record<string, unknown> }>(await ncbi(`esummary.fcgi?db=pubmed&retmode=json&id=${pmids.join(',')}`), sig)
            const c = readPmidCheck(pmids, sum)
            for (const id of c.missing) lines.push(`✗ PMID ${id}: no such PubMed record. This citation is wrong.`)
            for (const r of c.retracted) lines.push(`⚠ PMID ${r.pmid}: RETRACTED — "${r.title}" (${r.journal ?? ''} ${r.year ?? ''}). Don't rely on it.`)
            for (const r of c.concern) lines.push(`⚠ PMID ${r.pmid}: expression of concern — "${r.title}" (${r.journal ?? ''} ${r.year ?? ''}).`)
            for (const r of c.ok) { lines.push(`✓ PMID ${r.pmid}: "${r.title}" (${r.journal ?? ''} ${r.year ?? ''})${evidenceLevel(r.pubtypes) ? ` · ${evidenceLevel(r.pubtypes)}` : ''}`); sources.push({ title: r.title, url: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` }) }
          }
          for (const doi of dois) {
            try {
              const r = await getJson<{ message: { title?: string[]; 'container-title'?: string[]; issued?: { 'date-parts'?: number[][] }; 'updated-by'?: Array<{ type?: string; DOI?: string }>; relation?: Record<string, unknown> } }>(`https://api.crossref.org/works/${q(doi)}`, sig)
              const m = r.message
              const retraction = (m['updated-by'] ?? []).find((u) => /retract/i.test(u.type ?? ''))
              const concern = (m['updated-by'] ?? []).find((u) => /concern/i.test(u.type ?? ''))
              const t = m.title?.[0] ?? doi
              lines.push(`${retraction ? '⚠' : '✓'} DOI ${doi}: "${t}" (${m['container-title']?.[0] ?? ''} ${m.issued?.['date-parts']?.[0]?.[0] ?? ''})${retraction ? ` — RETRACTED (notice ${retraction.DOI ?? ''})` : concern ? ' — expression of concern' : ''}`)
              sources.push({ title: t, url: `https://doi.org/${doi}` })
            } catch { lines.push(`✗ DOI ${doi}: not found at Crossref. Check it.`) }
          }
          for (const id of ncts) {
            try {
              const r = await getJson<{ protocolSection?: { identificationModule?: { briefTitle?: string }; statusModule?: { overallStatus?: string } } }>(`https://clinicaltrials.gov/api/v2/studies/${id}`, sig)
              const t = r.protocolSection?.identificationModule?.briefTitle ?? id
              lines.push(`✓ ${id}: "${t}" (${r.protocolSection?.statusModule?.overallStatus ?? 'status n/a'})`)
              sources.push({ title: t, url: `https://clinicaltrials.gov/study/${id}` })
            } catch { lines.push(`✗ ${id}: no such trial on ClinicalTrials.gov.`) }
          }
          const other = ids.filter((x) => !pmids.includes(x.replace(/\D/g, '')) && !ncts.includes(x.toUpperCase()) && !dois.some((d) => x.endsWith(d)))
          for (const x of other) lines.push(`? ${x}: not a PMID, DOI or NCT ID.`)
          return { text: lines.join('\n') || 'Nothing to check.', display: `Checked ${ids.length} citation${ids.length === 1 ? '' : 's'}`, sources }
        }
        case 'clinical_trials': {
          const r = await getJson<TrialsResponse>(`https://clinicaltrials.gov/api/v2/studies?pageSize=${max}&query.term=${q(a.query!)}`, sig)
          const f = formatTrials(r)
          return { text: f.text || `No trials found for "${a.query}".`, display: `ClinicalTrials.gov “${clip(a.query, 40)}”`, sources: f.sources }
        }
        case 'drug_label': {
          const name = a.query!.replace(/"/g, '')
          let r: { results?: Array<Record<string, any>> } = {}
          for (const field of ['openfda.brand_name', 'openfda.generic_name', 'openfda.substance_name']) {
            try { r = await getJson(`https://api.fda.gov/drug/label.json?limit=1&search=${field}:"${q(name)}"`, sig) } catch { r = {} }
            if (r.results?.length) break
          }
          const f = formatLabel(r)
          return { text: f.text, display: `FDA label: ${clip(name, 40)}`, sources: f.sources }
        }
        case 'adverse_events': {
          const name = a.query!.replace(/"/g, '').trim()
          let r: { results?: Array<{ term: string; count: number }> } = {}
          let field = ''
          for (const f of ['patient.drug.openfda.generic_name', 'patient.drug.openfda.brand_name']) {
            try { r = await getJson(`https://api.fda.gov/drug/event.json?search=${f}:"${q(name)}"&count=patient.reaction.reactionmeddrapt.exact&limit=${Math.min(max * 2, 25)}`, sig) } catch { r = {} }
            if (r.results?.length) { field = f; break }
          }
          let total: number | undefined
          if (field) { try { total = (await getJson<{ meta?: { results?: { total?: number } } }>(`https://api.fda.gov/drug/event.json?search=${field}:"${q(name)}"&limit=1`, sig)).meta?.results?.total } catch { /* optional */ } }
          return { text: formatAdverse(name, r, total), display: `FDA adverse events: ${clip(name, 40)}`, sources: field ? [{ title: `openFDA adverse events: ${name}`, url: `https://open.fda.gov/data/faers/` }] : [] }
        }
        case 'medlineplus': {
          const xml = await getText(`https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&retmax=${Math.min(max, 5)}&term=${q(a.query!)}`, sig)
          const f = formatMedlinePlus(xml)
          return { text: f.text || `MedlinePlus: nothing for "${a.query}".`, display: `MedlinePlus “${clip(a.query, 40)}”`, sources: f.sources }
        }
        case 'wikipedia': {
          const s = await getJson<{ query?: { search?: Array<{ title: string }> } }>(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${q(a.query!)}`, sig)
          const title = s.query?.search?.[0]?.title
          if (!title) return { text: `Wikipedia: nothing for "${a.query}".`, display: 'Wikipedia: no page' }
          const p = await getJson<{ title: string; extract: string; content_urls?: { desktop?: { page?: string } }; timestamp?: string }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${q(title.replace(/ /g, '_'))}`, sig)
          const url = p.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${q(title)}`
          return { text: `# ${p.title} (Wikipedia, updated ${p.timestamp?.slice(0, 10) ?? '?'})\n${url}\n\n${p.extract}\n\nOther matches: ${(s.query?.search ?? []).slice(1).map((x) => x.title).join(', ') || 'none'}. Read the full article with fetch_page if you need more.`, display: `Wikipedia: ${p.title}`, sources: [{ title: `${p.title} (Wikipedia)`, url }] }
        }
        case 'arxiv': {
          const xml = await getText(`https://export.arxiv.org/api/query?max_results=${max}&sortBy=relevance&search_query=all:${q(a.query!)}`, sig)
          const f = formatArxiv(xml)
          return { text: f.text || `arXiv: nothing for "${a.query}".`, display: `arXiv “${clip(a.query, 40)}”`, sources: f.sources }
        }
        case 'doi': {
          const out: string[] = []
          const sources: Array<{ title: string; url: string }> = []
          for (const doi of a.ids ?? []) {
            try {
              const r = await getJson<{ message: { title?: string[]; author?: Array<{ family?: string; given?: string }>; 'container-title'?: string[]; issued?: { 'date-parts'?: number[][] }; URL?: string; type?: string } }>(`https://api.crossref.org/works/${q(doi.trim())}`, sig)
              const m = r.message
              const title = m.title?.[0] ?? doi
              out.push(`- ${title}. ${(m.author ?? []).slice(0, 3).map((x) => `${x.given ?? ''} ${x.family ?? ''}`.trim()).join(', ')}${(m.author ?? []).length > 3 ? ' et al.' : ''}. ${m['container-title']?.[0] ?? ''} (${m.issued?.['date-parts']?.[0]?.[0] ?? '?'}). ${m.URL ?? `https://doi.org/${doi}`}`)
              sources.push({ title, url: m.URL ?? `https://doi.org/${doi}` })
            } catch (e) { out.push(`- ${doi}: ${(e as Error).message}`) }
          }
          return { text: out.join('\n'), display: `Looked up ${a.ids?.length ?? 0} DOI${(a.ids?.length ?? 0) === 1 ? '' : 's'}`, sources }
        }
      }
    }
  }
}

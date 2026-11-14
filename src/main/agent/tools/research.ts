import type { ToolDef } from '../types'

// Trusted research sources through their official, free APIs: cleaner and more reliable than scraping
// their web pages. Any other website still works with web_search, fetch_page and the browser.

type Source = 'pubmed' | 'pubmed_abstract' | 'clinical_trials' | 'drug_label' | 'wikipedia' | 'arxiv' | 'doi'
type Args = { source: Source; query?: string; ids?: string[]; max?: number }

const UA = 'SahilBot/1.0 (desktop research assistant)'
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
  if (res.status === 404) throw new Error('Nothing found.')
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}. Try again, or use web_search and fetch_page.`)
  return (await res.json()) as T
}
async function getText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
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
    return `${i + 1}. ${r.title}\n   ${authors} · ${r.fulljournalname ?? r.source ?? ''} · ${r.pubdate ?? ''}${r.pubtype?.length ? ` · ${r.pubtype.slice(0, 2).join(', ')}` : ''}\n   PMID ${r.uid}${doi ? ` · DOI ${doi}` : ''} · https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`
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

// ---------------------------------------------------------------- the tool

export function researchTool(): ToolDef<Args> {
  return {
    name: 'research',
    label: 'Research',
    core: false,
    group: 'Research',
    effect: 'read',
    untrusted: true,
    description: 'Trusted sources through their official APIs (more reliable than their web pages). source: pubmed (search medical literature: query; use PubMed syntax like "prostate cancer[tiab] AND guideline[pt]"), pubmed_abstract (ids: PMIDs, full abstracts), clinical_trials (query: condition or treatment, from ClinicalTrials.gov), drug_label (query: drug name, official FDA label: uses, dosing, warnings, interactions), wikipedia (query: topic, summary), arxiv (query: physics, math, CS and engineering preprints), doi (ids: DOIs, citation details). Cite what you use. For any other website use web_search, fetch_page or the browser.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['pubmed', 'pubmed_abstract', 'clinical_trials', 'drug_label', 'wikipedia', 'arxiv', 'doi'] },
        query: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'PMIDs for pubmed_abstract, DOIs for doi' },
        max: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results (default 8)' }
      },
      required: ['source'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { source: { enum: ['pubmed', 'clinical_trials', 'drug_label', 'wikipedia', 'arxiv'] } } }, then: { required: ['query'] } },
        { if: { properties: { source: { enum: ['pubmed_abstract', 'doi'] } } }, then: { required: ['ids'] } }
      ]
    },
    async run(a, ctx) {
      const max = a.max ?? 8
      const sig = ctx.signal
      switch (a.source) {
        case 'pubmed': {
          const s = await getJson<{ esearchresult?: { idlist?: string[]; count?: string } }>(`${NCBI}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${max}&tool=SahilBot&term=${q(a.query!)}`, sig)
          const ids = s.esearchresult?.idlist ?? []
          if (!ids.length) return { text: `PubMed: no results for "${a.query}". Try broader terms or synonyms.`, display: 'PubMed: no results' }
          const sum = await getJson<PubmedSummary>(`${NCBI}/esummary.fcgi?db=pubmed&retmode=json&tool=SahilBot&id=${ids.join(',')}`, sig)
          const f = formatPubmed(sum)
          return { text: `PubMed: ${s.esearchresult?.count ?? ids.length} results for "${a.query}" (top ${ids.length} by relevance):\n${f.text}\n\nRead abstracts with source "pubmed_abstract" and the PMIDs before relying on a paper.`, display: `PubMed “${clip(a.query, 40)}” · ${ids.length} papers`, sources: f.sources }
        }
        case 'pubmed_abstract': {
          const ids = (a.ids ?? []).map((x) => x.replace(/\D/g, '')).filter(Boolean)
          const text = await getText(`${NCBI}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&tool=SahilBot&id=${ids.join(',')}`, sig)
          return { text: text.trim() || 'No abstracts returned.', display: `Read ${ids.length} PubMed abstract${ids.length === 1 ? '' : 's'}`, sources: ids.map((id) => ({ title: `PubMed ${id}`, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` })) }
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

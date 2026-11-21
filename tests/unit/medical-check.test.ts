import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { checkMedicalAnswer, clinicalAnswer, extractCitations, isMedicalQuestion, medicalNote, readPmidCheck, unretrieved } from '../../src/main/agent/medical-check'
import { evidenceLevel, formatAdverse, formatEuropePmc, formatMedlinePlus, formatMesh, formatPubmed, jatsToText, pubmedTerm } from '../../src/main/agent/tools/research'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

/** esummary JSON in PubMed's real shape: a real paper, a retracted one, a missing id. */
const SUMMARY = {
  result: {
    uids: ['27626136', '9500320', '11111111'],
    '27626136': { uid: '27626136', title: '10-Year Outcomes after Monitoring, Surgery, or Radiotherapy for Localized Prostate Cancer.', pubtype: ['Comparative Study', 'Journal Article', 'Randomized Controlled Trial'], fulljournalname: 'The New England journal of medicine', pubdate: '2016 Oct 13' },
    '9500320': { uid: '9500320', title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children.', pubtype: ['Journal Article', 'Retracted Publication'], fulljournalname: 'Lancet', pubdate: '1998 Feb 28' },
    '11111111': { uid: '11111111', error: 'cannot get document summary' }
  }
}

describe('medical citations', () => {
  test('finds PMIDs, DOIs and NCT IDs however they are written', () => {
    const c = extractCitations('See PMID: 27626136, https://pubmed.ncbi.nlm.nih.gov/9500320/ and doi 10.1056/NEJMoa1606220. Trial NCT00632970; also pmid 27626136.')
    expect(c.pmids).toEqual(['27626136', '9500320'])
    expect(c.dois).toEqual(['10.1056/nejmoa1606220'])
    expect(c.ncts).toEqual(['NCT00632970'])
  })
  test('a citation counts as retrieved only when it appears in what was retrieved', () => {
    const c = extractCitations('PMID 27626136 and PMID 1234567 and NCT00632970')
    const u = unretrieved(c, 'PubMed: 1. 10-Year Outcomes … PMID 27626136 · https://pubmed.ncbi.nlm.nih.gov/27626136/')
    expect(u.pmids).toEqual(['1234567'])
    expect(u.ncts).toEqual(['NCT00632970'])
    // A PMID that is only part of a longer number doesn't count.
    expect(unretrieved(extractCitations('PMID 2762613'), 'PMID 27626136').pmids).toEqual(['2762613'])
  })
  test('PubMed summaries: missing, retracted and fine', () => {
    const c = readPmidCheck(['27626136', '9500320', '11111111'], SUMMARY)
    expect(c.ok.map((x) => x.pmid)).toEqual(['27626136'])
    expect(c.retracted.map((x) => x.pmid)).toEqual(['9500320'])
    expect(c.missing).toEqual(['11111111'])
  })
  test('health questions and clinical answers are recognized; small talk is not', () => {
    expect(isMedicalQuestion('What is the first-line treatment for overactive bladder?')).toBe(true)
    expect(isMedicalQuestion('Is tamsulosin safe with sildenafil?')).toBe(true)
    expect(isMedicalQuestion('Can I take enzalutamide with apalutamide?')).toBe(true)
    expect(isMedicalQuestion('What should I name my dog?')).toBe(false)
    expect(clinicalAnswer('Sure!')).toBe(false)
    expect(clinicalAnswer(`${'Background. '.repeat(30)}The usual starting dose is 0.4 mg once daily.`)).toBe(true)
  })
  test('the note says exactly what to fix, and nothing when all is well', async () => {
    const fetchJson = async () => SUMMARY
    const signal = new AbortController().signal
    const f = await checkMedicalAnswer({ question: 'Does active surveillance work for prostate cancer?', answer: 'Yes (PMID 27626136, PMID 9500320, PMID 11111111).', seen: 'PMID 27626136 PMID 9500320', researched: true, fetchJson, signal })
    const note = medicalNote(f)
    expect(note).toContain("don't appear in anything you retrieved in this conversation: PMID 11111111")
    expect(note).toContain('PubMed has no record for: PMID 11111111')
    expect(note).toContain('PMID 9500320')
    expect(note).toContain('RETRACTED')
    const fine = await checkMedicalAnswer({ question: 'Does active surveillance work for prostate cancer?', answer: 'Yes: at 10 years mortality was similar (PMID 27626136).', seen: 'PMID 27626136', researched: true, fetchJson: async () => ({ result: { uids: ['27626136'], '27626136': SUMMARY.result['27626136'] } }), signal })
    expect(medicalNote(fine)).toBe('')
  })
  test('a clinical answer with no research is sent to check the evidence; non-medical questions are left alone', async () => {
    const signal = new AbortController().signal
    const answer = `${'Overactive bladder is common. '.repeat(15)}First-line treatment is behavioral therapy; mirabegron 25 mg daily is recommended next.`
    const f = await checkMedicalAnswer({ question: 'What is the treatment for overactive bladder?', answer, seen: '', researched: false, fetchJson: async () => ({}), signal })
    expect(f.unresearched).toBe(true)
    expect(medicalNote(f)).toContain('Check the evidence first with the research tool')
    const other = await checkMedicalAnswer({ question: 'Plan my week', answer, seen: '', researched: false, fetchJson: async () => ({}), signal })
    expect(medicalNote(other)).toBe('')
  })
  test('PubMed being down never blocks an answer', async () => {
    const f = await checkMedicalAnswer({ question: 'prostate cancer survival', answer: 'See PMID 27626136.', seen: 'PMID 27626136', researched: true, fetchJson: async () => { throw new Error('offline') }, signal: new AbortController().signal })
    expect(medicalNote(f)).toBe('')
  })
})

describe('research tool: medical sources parse their real API shapes', () => {
  test('evidence filters and date ranges become PubMed syntax', () => {
    expect(pubmedTerm('overactive bladder', 'meta_analyses', 5, new Date('2026-06-01'))).toBe('(overactive bladder) AND meta-analysis[pt] AND ("2021/01/01"[dp] : "3000"[dp])')
    expect(pubmedTerm('bph', 'guidelines')).toContain('guideline[pt]')
    expect(pubmedTerm('bph')).toBe('(bph)')
  })
  test('evidence levels and retraction flags in PubMed results', () => {
    expect(evidenceLevel(['Journal Article', 'Meta-Analysis'])).toBe('Meta-analysis')
    expect(evidenceLevel(['Practice Guideline'])).toBe('Guideline')
    expect(evidenceLevel(['Journal Article'])).toBeUndefined()
    const f = formatPubmed({ result: { uids: ['9500320'], '9500320': { ...SUMMARY.result['9500320'], authors: [{ name: 'Wakefield AJ' }] } } } as never)
    expect(f.text).toContain('⚠ RETRACTED · Ileal-lymphoid')
  })
  test('Europe PMC: preprints are marked, open full text and citations shown', () => {
    const f = formatEuropePmc({ hitCount: 2, resultList: { result: [
      { id: '41000001', source: 'MED', pmid: '41000001', pmcid: 'PMC1234567', doi: '10.1/abc', title: 'Tamsulosin for distal ureteral stones.', authorString: 'Lee A, Kim B.', journalTitle: 'J Urol', pubYear: '2025', isOpenAccess: 'Y', citedByCount: 12 },
      { id: 'PPR900', source: 'PPR', doi: '10.1101/2026.01.01', title: 'A preprint', authorString: 'X Y.', pubYear: '2026', isOpenAccess: 'Y' }
    ] } })
    expect(f.text).toContain('cited by 12 · open full text')
    expect(f.text).toContain('PMID 41000001 · PMC1234567 · DOI 10.1/abc · https://pubmed.ncbi.nlm.nih.gov/41000001/')
    expect(f.text).toContain('PREPRINT (not peer reviewed) · A preprint')
  })
  test('MeSH headings with their scope note and how to search', () => {
    const t = formatMesh({ result: { uids: ['68011471'], '68011471': { ds_meshui: 'D011471', ds_scopenote: 'Tumors or cancer of the PROSTATE.', ds_meshterms: ['Prostatic Neoplasms', 'Prostate Cancer'] } } as never })
    expect(t).toContain('Prostatic Neoplasms (D011471)')
    expect(t).toContain('"Prostatic Neoplasms"[mh]')
  })
  test('open-access JATS full text keeps results and conclusions first when long', () => {
    const xml = `<article><front><article-meta><title-group><article-title>Stone trial</article-title></title-group><abstract><p>We tested tamsulosin.</p></abstract></article-meta></front><body>
      <sec><title>Introduction</title><p>${'Background text. '.repeat(400)}</p></sec>
      <sec><title>Results</title><p>Stone passage was 75% vs 60% <xref ref-type="bibr">12</xref>.</p></sec>
      <sec><title>Conclusions</title><p>Tamsulosin helps for distal stones &gt;5 mm.</p></sec></body></article>`
    const t = jatsToText(xml, 2000)
    expect(t).toContain('# Stone trial')
    expect(t).toContain('## Abstract\nWe tested tamsulosin.')
    expect(t).toContain('Stone passage was 75% vs 60% .')
    expect(t).toContain('distal stones >5 mm')
    // Results and conclusions first; the long introduction gets what's left, cut.
    expect(t).toMatch(/## Introduction\n(Background text\. )+[\s\S]*…/)
    expect(t.length).toBeLessThan(2300)
  })
  test('FAERS counts carry the caveat; MedlinePlus strips its highlight markup', () => {
    expect(formatAdverse('tamsulosin', { results: [{ term: 'DIZZINESS', count: 1520 }] }, 30000)).toContain('1. dizziness: 1,520 reports')
    expect(formatAdverse('tamsulosin', { results: [{ term: 'DIZZINESS', count: 1 }] })).toContain('not proof the drug caused')
    const xml = '<nlmSearchResult><list><document rank="0" url="https://medlineplus.gov/kidneystones.html"><content name="title">&lt;span class="qt0"&gt;Kidney&lt;/span&gt; Stones</content><content name="FullSummary">&lt;p&gt;A kidney stone is a solid piece&lt;/p&gt;</content></document></list></nlmSearchResult>'
    const f = formatMedlinePlus(xml)
    expect(f.text).toContain('1. Kidney Stones\n   https://medlineplus.gov/kidneystones.html\n   A kidney stone is a solid piece')
    expect(f.text).not.toContain('<')
  })
})

describe('the agent loop runs the medical check before a medical answer reaches the user', () => {
  process.env.FOREMAN_NO_AUTOTITLE = '1'
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as unknown as ModelInfo
  const research: ToolDef = { name: 'research', label: 'Research', core: true, effect: 'read', untrusted: true, description: 'r', parameters: { type: 'object', properties: { source: { type: 'string' }, query: { type: 'string' } } }, run: async () => ({ text: 'PubMed: 1. 10-Year Outcomes after Monitoring… PMID 27626136 · https://pubmed.ncbi.nlm.nih.gov/27626136/' }) }

  function harness() {
    const db = new Db(':memory:')
    const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
    const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
    const registry = new ToolRegistry()
    registry.register(...coreTools(results), research)
    const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
    const lookups: string[] = []
    const agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
      spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
      emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) }),
      medical: { fetchJson: async (url) => { lookups.push(url); return SUMMARY } }
    })
    const space = db.createSpace('Alpha', '#000000')
    return { db, agent, lookups, thread: () => db.createThread(space.id, 'auto', 'm') }
  }

  test('a made-up PMID goes back to the model; the corrected answer is the one the user sees', async () => {
    const h = harness()
    const t = h.thread()
    llm.script.push(
      { toolCalls: [{ name: 'research', arguments: JSON.stringify({ source: 'pubmed', query: 'active surveillance prostate cancer' }) }] },
      { content: 'Active surveillance had similar 10-year prostate cancer mortality to surgery or radiotherapy (PMID 27626136; PMID 11111111).' },
      { content: 'Active surveillance had similar 10-year prostate cancer mortality to surgery or radiotherapy (ProtecT, PMID 27626136).' }
    )
    await (await h.agent.send({ threadId: t.id, text: 'Is active surveillance as good as surgery for low-risk prostate cancer?' })).done
    const msgs = h.db.listMessages(t.id)
    const note = msgs.find((m) => m.meta?.medicalCheck)
    expect(note?.content).toContain('PMID 11111111')
    expect(h.lookups[0]).toContain('esummary.fcgi?db=pubmed')
    const final = msgs.filter((m) => m.role === 'assistant' && !m.meta?.superseded).at(-1)
    expect(final?.content).toContain('ProtecT, PMID 27626136')
    expect(final?.content).not.toContain('11111111')
  })

  test('an answer whose citations check out goes straight through', async () => {
    const h = harness()
    const t = h.thread()
    llm.script.push(
      { toolCalls: [{ name: 'research', arguments: JSON.stringify({ source: 'pubmed', query: 'prostate cancer monitoring' }) }] },
      { content: 'Monitoring matched surgery and radiotherapy on 10-year prostate cancer mortality (PMID 27626136).' }
    )
    await (await h.agent.send({ threadId: t.id, text: 'Prostate cancer: monitoring vs surgery outcomes?' })).done
    const msgs = h.db.listMessages(t.id)
    expect(msgs.some((m) => m.meta?.medicalCheck)).toBe(false)
    expect(msgs.filter((m) => m.role === 'assistant' && !m.meta?.superseded).at(-1)?.meta?.medicalChecked).toEqual({ verified: 1 })
  })
})

import { describe, expect, test } from 'vitest'
import { researchTool } from '../../src/main/agent/tools/research'
import { checkMedicalAnswer } from '../../src/main/agent/medical-check'

// The research tool's medical sources against the real public APIs (PubMed, MeSH, Europe PMC, FDA, MedlinePlus,
// Crossref, ClinicalTrials.gov). No model and no key needed: npx vitest run --config vitest.live.config.mts tests/live/medical-research.test.ts
const tool = researchTool()
const run = (a: Record<string, unknown>) => tool.run(a as never, { signal: new AbortController().signal } as never) as Promise<{ text: string; sources?: Array<{ url: string }> }>

describe('medical research against the real APIs', () => {
  test('PubMed with an evidence filter and a date range', async () => {
    const r = await run({ source: 'pubmed', query: 'active surveillance prostate cancer', filter: 'meta_analyses', years: 10, max: 3 })
    expect(r.text).toMatch(/PMID \d+/)
    expect(r.text).toContain('meta analyses')
  })
  test('MeSH heading for a lay term', async () => {
    const r = await run({ source: 'mesh', query: 'prostate cancer' })
    expect(r.text).toContain('Prostatic Neoplasms')
    expect(r.text).toContain('[mh]')
  })
  test('Europe PMC search and open full text', async () => {
    const r = await run({ source: 'europe_pmc', query: 'tamsulosin ureteral stones OPEN_ACCESS:y', max: 2 })
    expect(r.text).toMatch(/Europe PMC: \d+ results/)
    const pmc = r.text.match(/\b(PMC\d+)\b/)?.[1]
    if (pmc) {
      const ft = await run({ source: 'full_text', ids: [pmc] })
      expect(ft.text.length).toBeGreaterThan(1000)
      expect(ft.text).toContain('## Abstract')
    }
  })
  test('verify: a real PMID, a made-up one, a DOI and a trial', async () => {
    const r = await run({ source: 'verify', ids: ['27626136', '99999999', '10.1056/NEJMoa1606220', 'NCT00632970'] })
    expect(r.text).toMatch(/✓ PMID 27626136/)
    expect(r.text).toMatch(/✗ PMID 99999999/)
    expect(r.text).toMatch(/DOI 10\.1056\/nejmoa1606220|DOI 10\.1056\/NEJMoa1606220/i)
    expect(r.text).toContain('NCT00632970')
  })
  test('verify flags a retracted paper', async () => {
    const r = await run({ source: 'verify', ids: ['9500320'] })
    expect(r.text).toMatch(/⚠ PMID 9500320: RETRACTED/)
  })
  test('FDA adverse events and MedlinePlus', async () => {
    const ae = await run({ source: 'adverse_events', query: 'tamsulosin', max: 5 })
    expect(ae.text).toContain('FAERS')
    const mp = await run({ source: 'medlineplus', query: 'kidney stones' })
    expect(mp.text).toContain('medlineplus.gov')
    expect(mp.text).not.toContain('<span')
  })
  test('the medical check flags a made-up PMID and passes a real retrieved one', async () => {
    const fetchJson = async (url: string, signal: AbortSignal) => (await fetch(url, { signal })).json()
    const bad = await checkMedicalAnswer({ question: 'Is active surveillance safe for low-risk prostate cancer?', answer: 'Yes, see PMID 99999999 and PMID 27626136.', seen: 'PMID 27626136', researched: true, fetchJson, signal: new AbortController().signal })
    expect(bad.unretrieved.pmids).toEqual(['99999999'])
    expect(bad.pubmed?.missing).toEqual(['99999999'])
    expect(bad.pubmed?.ok.map((x) => x.pmid)).toEqual(['27626136'])
  })
})

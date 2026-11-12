import { describe, expect, test } from 'vitest'
import { formatArxiv, formatLabel, formatPubmed, formatTrials } from '../../src/main/agent/tools/research'

describe('research sources format real API shapes', () => {
  test('PubMed summaries become a cited list with PMIDs and links', () => {
    const f = formatPubmed({ result: { uids: ['123'], '123': { uid: '123', title: 'Active surveillance in prostate cancer.', fulljournalname: 'J Urol', pubdate: '2025 Jan', authors: [{ name: 'Smith A' }, { name: 'Lee B' }], articleids: [{ idtype: 'doi', value: '10.1/x' }], pubtype: ['Review'] } } as never })
    expect(f.text).toContain('PMID 123 · DOI 10.1/x · https://pubmed.ncbi.nlm.nih.gov/123/')
    expect(f.text).toContain('Smith A, Lee B · J Urol · 2025 Jan · Review')
    expect(f.sources[0].url).toBe('https://pubmed.ncbi.nlm.nih.gov/123/')
  })
  test('ClinicalTrials.gov studies list status, phase and link', () => {
    const f = formatTrials({ studies: [{ protocolSection: { identificationModule: { nctId: 'NCT01', briefTitle: 'A trial' }, statusModule: { overallStatus: 'RECRUITING' }, designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 400 } }, conditionsModule: { conditions: ['BPH'] } } }] })
    expect(f.text).toContain('NCT01 · RECRUITING · PHASE3 · 400 participants')
    expect(f.sources[0].url).toBe('https://clinicaltrials.gov/study/NCT01')
  })
  test('FDA labels show the key sections with a DailyMed link', () => {
    const f = formatLabel({ results: [{ set_id: 'abc', effective_time: '20250101', openfda: { brand_name: ['Flomax'], generic_name: ['tamsulosin'], manufacturer_name: ['X'] }, indications_and_usage: ['Treats BPH symptoms.'], drug_interactions: ['Avoid strong CYP3A4 inhibitors.'] }] })
    expect(f.text).toContain('Flomax / tamsulosin')
    expect(f.text).toContain('## Uses\nTreats BPH symptoms.')
    expect(f.text).toContain('## Interactions')
    expect(f.sources[0].url).toContain('setid=abc')
  })
  test('arXiv Atom entries parse', () => {
    const f = formatArxiv('<feed><entry><id>http://arxiv.org/abs/2501.1</id><published>2025-01-02T00:00:00Z</published><title>Fast PCB routing</title><summary>We route boards.</summary><author><name>Ada</name></author></entry></feed>')
    expect(f.text).toContain('Fast PCB routing')
    expect(f.text).toContain('Ada · 2025-01-02 · http://arxiv.org/abs/2501.1')
  })
})

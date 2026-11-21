// Medical accuracy: the app's own check on a medical answer before it reaches the user (no model call).
//
// When a reply answers a health question or cites medical literature, SahilBot looks at it once per run:
//   1. Every PMID, DOI and NCT ID it cites must come from something retrieved in this conversation (a made-up
//      citation is the classic failure; the link check only catches URLs).
//   2. The PMIDs are looked up in PubMed: each must exist, and a retracted paper (or one with an expression of
//      concern) is flagged so the reply stops relying on it.
//   3. A substantive answer to a clinical question with no research at all (doses, treatments, risks from
//      memory) is sent to check the literature first.
// Problems go back to the model with exactly what to fix; it answers again. A network failure never blocks an
// answer: what couldn't be checked is skipped.

/**
 * Words that make a request a health question: conditions, organs, drugs, doses, clinical literature. Generic words
 * ("treat null as zero", "be patient", "style guidelines", "free trials", "interact with the API", "risk of ruin")
 * don't count on their own.
 */
const MEDICAL = /\b(medical|medicine|medications?|meds|drugs?|dos(e|es|age|ing)|\d+ ?(mg|mcg)|prescri\w*|side[- ]effects?|adverse (events?|effects?|reactions?)|contraindicat\w*|symptoms?|diagnos\w*|prognos\w*|disease|syndrome|infections?|cancer|tumou?r|oncolog\w*|carcinoma|lymphoma|leukemia|chemo(therapy)?|radiation therapy|immunotherap\w*|biops\w*|psa|prostat\w*|kidney|renal|bladder|urolog\w*|urinary|uti|testicular|erectile|incontinence|cardiac|hypertension|blood pressure|diabetes|insulin|a1c|cholesterol|stroke|asthma|copd|pneumonia|sepsis|antibiotics?|vaccines?|pregnan\w*|pediatric|pubmed|meta-analys\w*|systematic reviews?|randomi[sz]ed (controlled )?trials?|clinical trials?|egfr|creatinine|surgery|surgical|patients with|a patient (with|who|has)|treatment (for|of)|therapy for|mortality|survival rates?)\b/i

/** Common drug-name endings (tamsulosin, lisinopril, atorvastatin, sildenafil, pembrolizumab…). */
const DRUG = /\b[a-z]{3,}(osin|olol|pril|sartan|statin|afil|mab|nib|cillin|mycin|floxacin|azole|prazole|gliflozin|gliptin|glutide|dronate|terol|lukast|oxetine|triptan|azepam|tadine|semide|thiazide|parin|xaban|gatran|caine|profen|coxib|lamide|tidine|vir|mustine|platin|taxel|rubicin|lutamide|relix|relin)\b/i

export function isMedicalQuestion(text: string): boolean {
  return MEDICAL.test(text) || DRUG.test(text)
}

export interface Citations { pmids: string[]; dois: string[]; ncts: string[] }

const uniq = (xs: string[]): string[] => [...new Set(xs)]

/** PMIDs ("PMID 12345678", "PMID: 1234", pubmed.ncbi.nlm.nih.gov/123), DOIs and NCT IDs a text cites. */
export function extractCitations(text: string): Citations {
  const pmids = [
    ...[...text.matchAll(/\bPMID[:\s#]*(\d{4,9})\b/gi)].map((m) => m[1]),
    ...[...text.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})/gi)].map((m) => m[1])
  ]
  // Markdown and punctuation around a DOI (**bold**, a table's |, a dash, a closing bracket) aren't part of it.
  const dois = [...text.matchAll(/\b(10\.\d{4,9}\/[^\s"'<>()[\]{}|]+)/g)].map((m) => m[1].replace(/[*_`|\u2014\u2013\u2026.,;:!?>]+$/, '').toLowerCase())
  const ncts = [...text.matchAll(/\b(NCT\d{8})\b/gi)].map((m) => m[1].toUpperCase())
  return { pmids: uniq(pmids), dois: uniq(dois), ncts: uniq(ncts) }
}

export const hasCitations = (c: Citations): boolean => c.pmids.length + c.dois.length + c.ncts.length > 0

/** Citations that appear nowhere in what was retrieved (tool results, the user's own messages). */
export function unretrieved(c: Citations, seen: string): Citations {
  const lower = seen.toLowerCase()
  return {
    // A PMID counts when the number is there as a whole number (PubMed results print "PMID 123" and URLs).
    pmids: c.pmids.filter((id) => !new RegExp(`(^|\\D)${id}(\\D|$)`).test(seen)),
    dois: c.dois.filter((d) => !lower.includes(d)),
    ncts: c.ncts.filter((n) => !seen.toUpperCase().includes(n))
  }
}

export interface PubmedRecord { pmid: string; title: string; pubtypes: string[]; journal?: string; year?: string }
export interface PmidCheck {
  missing: string[]
  retracted: PubmedRecord[]
  concern: PubmedRecord[]
  ok: PubmedRecord[]
}

/** Pubtypes PubMed gives a paper that was retracted, or that has an expression of concern. */
const RETRACTED = /^retracted publication$/i
const CONCERN = /^expression of concern$/i

/** Reads PubMed's esummary JSON into a check of the asked PMIDs. */
export function readPmidCheck(asked: string[], sum: { result?: Record<string, unknown> }): PmidCheck {
  const out: PmidCheck = { missing: [], retracted: [], concern: [], ok: [] }
  const res = (sum.result ?? {}) as Record<string, { uid?: string; title?: string; pubtype?: string[]; error?: string; fulljournalname?: string; source?: string; pubdate?: string }>
  for (const id of asked) {
    const r = res[id]
    if (!r || r.error || !r.title) { out.missing.push(id); continue }
    const rec: PubmedRecord = { pmid: id, title: r.title.replace(/\s+/g, ' ').trim(), pubtypes: r.pubtype ?? [], journal: r.fulljournalname ?? r.source, year: r.pubdate?.slice(0, 4) }
    if (rec.pubtypes.some((t) => RETRACTED.test(t))) out.retracted.push(rec)
    else if (rec.pubtypes.some((t) => CONCERN.test(t))) out.concern.push(rec)
    else out.ok.push(rec)
  }
  return out
}

export interface MedicalFindings {
  unretrieved: Citations
  pubmed?: PmidCheck
  /** A clinical answer with no research behind it. */
  unresearched: boolean
}

export function hasProblems(f: MedicalFindings): boolean {
  return hasCitations(f.unretrieved) || !!f.pubmed?.missing.length || !!f.pubmed?.retracted.length || !!f.pubmed?.concern.length || f.unresearched
}

/** What the model is told to fix, or '' when nothing is wrong. */
export function medicalNote(f: MedicalFindings): string {
  if (!hasProblems(f)) return ''
  const lines: string[] = ['[From the app] Medical accuracy check on your reply:']
  const u = f.unretrieved
  const fake = [...u.pmids.map((x) => `PMID ${x}`), ...u.dois.map((x) => `DOI ${x}`), ...u.ncts]
  if (fake.length) lines.push(`- These citations don't appear in anything you retrieved in this conversation: ${fake.join(', ')}. Look each one up (research source "verify", or "pubmed" / "pubmed_abstract") and cite only what you actually read; remove any you can't confirm.`)
  if (f.pubmed?.missing.length) lines.push(`- PubMed has no record for: ${f.pubmed.missing.map((x) => `PMID ${x}`).join(', ')}. That citation is wrong: find the right paper or remove it.`)
  for (const r of f.pubmed?.retracted ?? []) lines.push(`- PMID ${r.pmid} ("${r.title.slice(0, 120)}") is RETRACTED. Don't rely on it: drop the claims that rest on it or support them with other evidence, and say it was retracted if it matters.`)
  for (const r of f.pubmed?.concern ?? []) lines.push(`- PMID ${r.pmid} ("${r.title.slice(0, 120)}") carries an expression of concern. Say so if you keep it, and prefer stronger evidence.`)
  if (f.unresearched) lines.push('- This is a clinical question and you answered without checking any source. Check the evidence first with the research tool (PubMed: guidelines, systematic reviews and meta-analyses first, then RCTs; FDA drug labels for doses, warnings and interactions), then answer with the key PMIDs or label links. Keep anything you can\'t support clearly marked as uncertain.')
  lines.push('Then give your corrected final answer.')
  return lines.join('\n')
}

/** Whether an answer is substantive clinical content (not a greeting, a question back, or a refusal). */
export function clinicalAnswer(answer: string): boolean {
  const t = answer.trim()
  if (t.length < 350) return false
  // Doses, percentages, risk numbers or treatment advice: the kind of claim that must be sourced.
  return /\b\d+(\.\d+)?\s?(mg|mcg|µg|g|ml|mL|units?|IU|%|mmHg|mg\/dL|mmol)\b/i.test(t) || /\b(first[- ]line|recommended|guidelines?|treatment|dose|dosing|contraindicated|risk|survival|mortality|efficacy|evidence)\b/i.test(t)
}

export type JsonFetcher = (url: string, signal: AbortSignal) => Promise<unknown>

const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

/**
 * Runs the check. `seen` is everything retrieved this conversation (tool results and the user's messages),
 * `researched` whether this run looked anything up. Network trouble skips the PubMed part.
 */
export async function checkMedicalAnswer(o: {
  /** This turn's request only (not the whole conversation's text). */
  question: string
  answer: string
  seen: string
  researched: boolean
  /** Whether an answer with no research may be sent back to research (false in quick chats and helpers). */
  nudge?: boolean
  fetchJson: JsonFetcher
  signal: AbortSignal
  apiKey?: string
}): Promise<MedicalFindings> {
  const cites = extractCitations(o.answer)
  const medical = isMedicalQuestion(o.question) || hasCitations(cites)
  const empty: Citations = { pmids: [], dois: [], ncts: [] }
  if (!medical) return { unretrieved: empty, unresearched: false }
  const f: MedicalFindings = {
    unretrieved: unretrieved(cites, o.seen),
    unresearched: o.nudge !== false && !o.researched && !hasCitations(cites) && isMedicalQuestion(o.question) && clinicalAnswer(o.answer)
  }
  const pmids = cites.pmids.slice(0, 40)
  if (pmids.length) {
    try {
      const key = o.apiKey ? `&api_key=${encodeURIComponent(o.apiKey)}` : ''
      const sum = await o.fetchJson(`${NCBI}/esummary.fcgi?db=pubmed&retmode=json&tool=SahilBot${key}&id=${pmids.join(',')}`, AbortSignal.any([o.signal, AbortSignal.timeout(15_000)])) as { result?: Record<string, unknown> }
      f.pubmed = readPmidCheck(pmids, sum)
      // A PMID PubMed knows that the model also never retrieved: the existence check passed, but it still has to
      // be read before it's relied on; keep it in "unretrieved" (the note says so).
    } catch { /* offline or PubMed busy: skip this part */ }
  }
  return f
}

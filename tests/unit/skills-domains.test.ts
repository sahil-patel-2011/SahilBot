import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SkillStore } from '../../src/main/skills'
import { maskValue, phiTool, redactPhi, scanPhi } from '../../src/main/agent/tools/phi'

// The business, ideas, medical, health, HIPAA, home and everyday skill packs: format, safety wording,
// selection (SkillStore.relevant / suggest from src/main/skills.ts) and size budgets; plus the PHI helper.

const PACKS = join(process.cwd(), 'packs', 'skills')
const store = new SkillStore(mkdtempSync(join(tmpdir(), 'sk-dom-')), PACKS)
const DOMAIN = /^(business|ideas|medical|health|hipaa|home|everyday)-/
// Older packs whose names other files use (templates, tests): the expert content was merged into them.
const MERGED = ['plan-a-trip', 'financial-model', 'pricing-strategy', 'marketing-plan', 'medical-evidence-lookup', 'medical-coding-billing']
// Near-duplicates folded into one pack per topic: kept as one-line pointers (no deletions).
const REDIRECTS: Record<string, string> = {
  'everyday-trip-planning': 'plan-a-trip', 'business-financial-modeling': 'financial-model', 'business-pricing-strategy': 'pricing-strategy',
  'business-marketing': 'marketing-plan', 'medical-evidence-based-answers': 'medical-evidence-lookup', 'medical-billing-revenue-cycle': 'medical-coding-billing',
  'business-plan': 'business-plan-writing'
}
// Same prefix, not part of this set.
const OTHER = new Set(['medical-marketing-content'])
const NEW = [...new Set([...readdirSync(PACKS).filter((d) => DOMAIN.test(d) && !OTHER.has(d) && !(d in REDIRECTS)), ...MERGED])].sort()
const NEWSET = new Set(NEW)
const raw = (n: string): string => readFileSync(join(PACKS, n, 'SKILL.md'), 'utf8')
const front = (n: string): Record<string, string> => Object.fromEntries((raw(n).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '').split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].trim()]))
const top = (q: string, k = 3): string[] => store.relevant(q).slice(0, k).map((r) => r.skill.name)

const MEDICAL = NEW.filter((n) => /^(medical|health)-/.test(n))
const PRO = NEW.filter((n) => /^(business|ideas)-/.test(n) || ['everyday-personal-finance', 'financial-model', 'pricing-strategy', 'marketing-plan'].includes(n))

describe('domain skill packs: format', () => {
  test('the set is complete: about 15 business, 15 medical/health, 3-4 HIPAA and 15 everyday/home', () => {
    expect(PRO.length - 1).toBeGreaterThanOrEqual(15)
    expect(MEDICAL.length).toBeGreaterThanOrEqual(15)
    expect(NEW.filter((n) => n.startsWith('hipaa-')).length).toBeGreaterThanOrEqual(3)
    expect(NEW.filter((n) => /^(home|everyday)-/.test(n) || n === 'plan-a-trip').length).toBeGreaterThanOrEqual(15)
  })

  test('every new skill parses through SkillStore with the required frontmatter', () => {
    for (const n of NEW) {
      const f = front(n)
      const sk = store.get(n)
      expect(sk, n).toBeDefined()
      expect(f.name, n).toBe(n)
      expect(sk!.name).toBe(n)
      expect(sk!.source).toBe('builtin')
      expect(f.source, n).toBe('you')
      expect(f.uses, n).toBe('0')
      expect(sk!.category, n).toMatch(/^(Business|Ideas|Medical|Health|HIPAA|Home|Everyday)$/)
      // docs/skills.md: one line, 150 characters or less, starting with a verb (capitalized).
      expect(sk!.description.length, n).toBeGreaterThan(40)
      expect(sk!.description.length, n).toBeLessThanOrEqual(150)
      expect(sk!.description, n).toMatch(/^[A-Z]/)
      const trig = (f.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean)
      expect(trig.length, `${n} triggers`).toBeGreaterThanOrEqual(8)
      expect(new Set(trig.map((t) => t.toLowerCase())).size, `${n} duplicate triggers`).toBe(trig.length)
      expect(sk!.body.length, n).toBeGreaterThan(1500)
      expect(sk!.body, n).toMatch(/^## /m)
    }
  })

  test('no two new skills share a multi-word trigger (they would shadow each other)', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const n of NEW) {
      for (const t of (front(n).triggers ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x.includes(' '))) {
        if (seen.has(t)) dupes.push(`${t}: ${seen.get(t)} and ${n}`)
        else seen.set(t, n)
      }
    }
    expect(dupes).toEqual([])
  })

  test('cross-references point at skills that exist', () => {
    const all = new Set(readdirSync(PACKS))
    const missing: string[] = []
    for (const n of NEW) for (const ref of raw(n).match(/\b(?:business|ideas|medical|health|hipaa|home|everyday)-[a-z0-9-]+[a-z0-9]\b/g) ?? []) if (!all.has(ref) || ref in REDIRECTS) missing.push(`${n} → ${ref}`)
    expect(missing).toEqual([])
  })

  test('merged near-duplicates: one pack per topic, the other a one-line pointer with no description or triggers', () => {
    for (const [from, to] of Object.entries(REDIRECTS)) {
      const f = front(from)
      expect(f.name, from).toBe(from)
      expect(f.description, from).toBe('')
      expect(f.triggers, from).toBeUndefined()
      expect(f.category, from).toBe('Redirects')
      expect(f.deprecated, from).toBe('true')
      const body = store.get(from)!.body
      expect(body.split('\n').length, from).toBe(1)
      expect(body, from).toContain(`name="${to}"`)
      expect(NEWSET.has(to), to).toBe(true)
      expect(to in REDIRECTS, to).toBe(false)
    }
  })
})

describe('domain skill packs: safety wording', () => {
  test('every medical and health skill starts with the safety block', () => {
    for (const n of MEDICAL) {
      const body = store.get(n)!.body
      // First section, so a clipped inline body still carries it.
      expect(body.startsWith('## Safety rules (always apply)'), n).toBe(true)
      const block = body.slice(0, body.indexOf('\n## ', 5))
      expect(block, n).toContain('not a substitute for professional medical care')
      expect(block, n).toMatch(/call emergency services \(911 in the US\)/)
      expect(block, n).toContain('Cite sources')
      expect(block, n).toContain('No definitive diagnosis')
      expect(block, n).toContain('No personalized dosing')
    }
  })

  test('the mental health skill gives crisis lines', () => {
    const b = store.get('health-mental-health-support')!.body
    expect(b).toContain('988')
    expect(b).toMatch(/741741/)
  })

  test('business, legal, tax and finance skills say when to consult a professional', () => {
    for (const n of PRO) expect(raw(n), n).toMatch(/consult(?:ing)? (?:a|an|the|your)?\s*(?:[a-z-]+ )?(?:lawyer|attorney|accountant|cpa|professional|planner|advisor|cfo)|(?:licensed|fee-only|fiduciary)[^.]{0,40}(?:planner|advisor|professional)/i)
    for (const n of ['business-fundraising', 'everyday-personal-finance']) expect(raw(n), n).toMatch(/not (?:investment|financial)[^.]*advice|no investment advice|not .*investment advice/i)
  })

  test('HIPAA skills point to a compliance professional; PHI handling covers BAAs, local models and memory', () => {
    for (const n of NEW.filter((x) => x.startsWith('hipaa-'))) expect(raw(n), n).toMatch(/compliance professional|privacy officer|attorney/i)
    const h = raw('hipaa-handling-phi')
    expect(h).toMatch(/BAA/)
    expect(h).toMatch(/local model/i)
    expect(h).toMatch(/never save PHI to memory/i)
    expect(h).toMatch(/phi_scan/)
  })

  test('shopping and gift skills keep the purchase gate', () => {
    for (const n of ['everyday-shopping-research', 'everyday-gift-ideas', 'plan-a-trip']) expect(raw(n), n).toMatch(/(never|don't) (complete a purchase|book)|user's click|user clicks/i)
  })
})

// [request, skill that must be in the top 3, must it be first?]
const CASES: Array<[string, string, boolean?]> = [
  // business
  ['how can I grow revenue for my bakery this year', 'business-revenue-growth', true],
  ['our sales are flat, what levers do we have', 'business-revenue-growth', true],
  ['calculate CAC and LTV and the payback period for my SaaS', 'business-unit-economics', true],
  ['run a cohort analysis on my Stripe subscriptions to see retention', 'business-unit-economics', true],
  ['how much should I charge for my consulting service', 'pricing-strategy', true],
  ['we want to raise prices 15%, how do we tell existing customers', 'pricing-strategy', true],
  ['write a business plan for a mobile coffee truck', 'business-plan-writing', true],
  ['I need a plan for an SBA loan application', 'business-plan-writing'],
  ['give me 20 startup ideas for a urologist', 'ideas-new-business', true],
  ['what side hustle could I start with $2,000', 'ideas-new-business', true],
  ['validate my idea for a dog walking app before I build it', 'ideas-validate-business', true],
  ['what is the TAM SAM SOM for AI scribes for dentists', 'ideas-validate-business', true],
  ['has anyone built an app for tracking prior authorizations already', 'ideas-novelty-check', true],
  ['what do people hate about QuickBooks, check reddit and negative reviews', 'business-complaint-mining', true],
  ['which clients have overdue invoices, draft payment reminders', 'business-invoice-collections', true],
  ['write the weekly newsletter from what shipped this week', 'business-weekly-newsletter', true],
  ['prep me for my 3pm call with Acme', 'business-meeting-prep', true],
  ['is a second revision round in scope per our statement of work with Client C', 'business-contract-scope', true],
  ['brainstorm names for our new podcast', 'ideas-creative-methods', true],
  ['use SCAMPER and first principles to rethink our checkout flow', 'ideas-creative-methods', true],
  ['date night ideas near us this Saturday', 'ideas-local-places', true],
  ['find a team offsite venue within an hour of the office', 'ideas-local-places', true],
  ['build a three statement financial model with runway', 'financial-model', true],
  ['forecast our burn rate and cash runway for the next 18 months', 'financial-model', true],
  ['how does a SAFE note work and what will dilution look like on my cap table', 'business-fundraising', true],
  ['what do angel investors look for in a seed round', 'business-fundraising', true],
  ['build a go-to-market plan and sales playbook for our B2B tool', 'business-go-to-market-sales', true],
  ['how do I run a good discovery call and handle objections', 'business-go-to-market-sales', true],
  ['write our positioning and messaging and plan google ads', 'marketing-plan', true],
  ['make a content calendar for our content marketing', 'marketing-plan', true],
  ['set OKRs for my team this quarter', 'business-operations-management', true],
  ['write an SOP for how we onboard new clients', 'business-operations-management', true],
  ['should I form an LLC or an S corp', 'business-legal-admin', true],
  ['how do I trademark my brand name', 'business-legal-admin', true],
  ['set up customer support with SLAs and a help center', 'business-customer-success', true],
  ['how do we reduce churn and improve NPS', 'business-customer-success', true],
  ['help me negotiate a lower price with our supplier', 'business-negotiation', true],
  ['how should I negotiate my salary offer', 'business-negotiation', true],
  ['how do I reconcile my bank account in QuickBooks and categorize transactions', 'business-bookkeeping-taxes', true],
  ['do I need to pay estimated quarterly taxes for my LLC', 'business-bookkeeping-taxes', true],
  ['help me decide between two job offers with a decision matrix', 'business-decision-making', true],
  ['run a pre-mortem on our expansion decision', 'business-decision-making', true],
  // medical and health
  ['what does the latest evidence say about vitamin D for preventing fractures', 'medical-evidence-lookup', true],
  ['explain my MRI report in plain language', 'medical-explain-conditions', true],
  ['i was diagnosed with atrial fibrillation, what is that', 'medical-explain-conditions', true],
  ['what do my blood test results mean, my creatinine and eGFR are flagged', 'medical-lab-results', true],
  ['my A1c is 6.1, is that out of range', 'medical-lab-results', true],
  ['can I take ibuprofen with lisinopril, any drug interaction', 'medical-medications', true],
  ['what are the side effects of metformin', 'medical-medications', true],
  ['I have chest pain and shortness of breath, should I go to the ER', 'medical-symptom-triage', true],
  ['my headache and fever have lasted three days, should i see a doctor', 'medical-symptom-triage', true],
  ['what questions should I ask my doctor at my cardiology appointment', 'medical-doctor-visit-prep', true],
  ['make me a symptom diary to bring to my appointment', 'medical-doctor-visit-prep', true],
  ['help me manage my type 2 diabetes and keep a glucose log', 'medical-chronic-conditions', true],
  ['how should I measure my blood pressure at home', 'medical-chronic-conditions', true],
  ["I feel hopeless and can't cope anymore", 'health-mental-health-support', true],
  ['I keep having panic attacks at work', 'health-mental-health-support', true],
  ['how much protein should I eat and do supplements help', 'health-nutrition-sleep-exercise', true],
  ["I can't sleep, any tips for insomnia", 'health-nutrition-sleep-exercise', true],
  ['make me a 3 day strength training workout plan', 'health-fitness-routines', true],
  ['couch to 5k running plan for a beginner', 'health-fitness-routines', true],
  ['appraise this randomized trial, what is the number needed to treat', 'medical-research-appraisal', true],
  ['is this study any good, explain the confidence interval and hazard ratio', 'medical-research-appraisal', true],
  ['should I get a PSA test at 50', 'medical-urology-mens-health', true],
  ['what helps with an enlarged prostate and weak urine stream', 'medical-urology-mens-health', true],
  ['low testosterone symptoms and treatment options', 'medical-urology-mens-health', true],
  ['my 2 month old baby has a fever of 100.6', 'medical-pediatric-care', true],
  ['what vaccines does my toddler need and when', 'medical-pediatric-care', true],
  ['my elderly father keeps falling, how do we prevent falls', 'medical-elderly-care', true],
  ['my mom has dementia, tips for a caregiver', 'medical-elderly-care', true],
  ['write a SOAP note from this dictation', 'medical-clinical-documentation', true],
  ['draft a prior authorization letter for an MRI', 'medical-clinical-documentation', true],
  ['how do I appeal a denied claim and what does modifier 25 mean', 'medical-coding-billing', true],
  ['explain E/M levels and how the revenue cycle works', 'medical-coding-billing', true],
  ['what is the ICD-10 code for type 2 diabetes with neuropathy', 'medical-coding-billing', true],
  ['make a 90 day marketing plan with a budget', 'marketing-plan', true],
  // HIPAA
  ['what are the 18 HIPAA identifiers for de-identification', 'hipaa-phi-basics', true],
  ['is a patient zip code considered protected health information', 'hipaa-phi-basics', true],
  ['can I paste patient records into the chat, redact the PHI first', 'hipaa-handling-phi', true],
  ['de-identify this patient note before I share it', 'hipaa-handling-phi', true],
  ['give me a HIPAA compliance checklist for my small practice', 'hipaa-small-practice-checklist', true],
  ['do we need a business associate agreement with our billing vendor', 'hipaa-small-practice-checklist', true],
  ['we sent patient info to the wrong person, is it a HIPAA breach', 'hipaa-breach-response', true],
  ['a laptop with patient data was stolen, what are the breach notification rules', 'hipaa-breach-response', true],
  // everyday and home
  ['plan a 10 day vacation itinerary in Italy with a budget', 'plan-a-trip', true],
  ['plan a surprise birthday party for 30 people', 'everyday-event-planning', true],
  ['make a weekly meal plan and grocery list for a family of four', 'home-meal-planning', true],
  ['help me make a monthly budget and pay off credit card debt', 'everyday-personal-finance', true],
  ['debt snowball or avalanche, which is better', 'everyday-personal-finance', true],
  ['make a chore chart for my kids and a cleaning schedule', 'home-household-management', true],
  ['what seasonal home maintenance should I do this fall', 'home-maintenance-schedule', true],
  ['how often should I change the furnace filter and flush the water heater', 'home-maintenance-schedule', true],
  ['how do I fix a running toilet', 'home-repairs', true],
  ['the breaker keeps tripping, can I fix it myself', 'home-repairs', true],
  ['we are moving next month, make a moving checklist', 'home-moving-checklist', true],
  ['help me declutter my garage', 'home-decluttering', true],
  ['which robot vacuum should I buy under $300', 'everyday-shopping-research', true],
  ['write a complaint letter to the airline asking for a refund', 'everyday-writing-messages', true],
  ['help me say no politely to a wedding invitation', 'everyday-writing-messages', true],
  ['remind me every Monday at 8am to submit my timesheet', 'everyday-scheduling-reminders', true],
  ['plan my week with time blocking', 'everyday-scheduling-reminders', true],
  ['what can I make with chicken, rice and spinach', 'home-recipes-cooking', true],
  ['what internal temperature is pork safe to eat', 'home-recipes-cooking', true],
  ['my dog ate chocolate, is it toxic', 'home-pet-care', true],
  ['how do I potty train my puppy', 'home-pet-care', true],
  ['my check engine light is flashing', 'everyday-car-maintenance', true],
  ['how often do I need an oil change and tire rotation', 'everyday-car-maintenance', true],
  ['when should I plant tomatoes in my vegetable garden', 'home-gardening', true],
  ['my houseplant has yellow leaves', 'home-gardening', true],
  ['our wifi keeps dropping and the printer is offline', 'everyday-tech-help', true],
  ['help my mom free up storage on her iphone', 'everyday-tech-help', true],
  ['make a study schedule for my final exams with spaced repetition', 'everyday-study-plans', true],
  ['gift ideas for my dad who likes fishing, under $50', 'everyday-gift-ideas', true]
]

describe('domain skill packs: selection (SkillStore.relevant)', () => {
  test(`${CASES.length} requests pick the right skill`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60)
    const misses: string[] = []
    for (const [q, want, first] of CASES) {
      const got = top(q)
      if (first ? got[0] !== want : !got.includes(want)) misses.push(`${q} → want ${want}${first ? ' first' : ''}, got ${got.join(', ') || '(none)'}`)
      // Redirects have no description or triggers, but rankSkills still scores their name words; they must never lead.
      if (got[0] && got[0] in REDIRECTS) misses.push(`${q} → a redirect ranks first: ${got[0]}`)
    }
    expect(misses).toEqual([])
  })

  test('every new skill is expected by at least one example request', () => {
    const covered = new Set(CASES.map((c) => c[1]))
    expect(NEW.filter((n) => !covered.has(n))).toEqual([])
  })

  test('each new skill is found from its own description', () => {
    const miss = NEW.filter((n) => !top(store.get(n)!.description).includes(n))
    expect(miss).toEqual([])
  })

  test("they stay out of unrelated requests (coding, engineering, small talk)", () => {
    for (const q of ['the login test is failing with a TypeError', 'refactor this module without changing behavior', 'what gear ratio for our frc elevator', 'set up github actions CI that runs pytest', 'design a REST API for orders with pagination']) {
      const got = top(q, 3)
      expect(got.filter((n) => NEWSET.has(n) || n in REDIRECTS), q).toEqual([])
    }
    for (const q of ['hi', 'thanks!', 'ok sounds good']) expect(store.suggest(q)).toBeUndefined()
    // Generic question words never pull in the medical packs.
    for (const q of ['what is the capital of france', 'what causes inflation', 'explain how a transistor works', 'is this a good time to refinance']) expect(top(q).filter((n) => MEDICAL.includes(n)), q).toEqual([])
  })
})

describe('domain skill packs: size budget', () => {
  test('each SKILL.md is compact (body ≤ 4,800 characters, file ≤ 5,600)', () => {
    for (const n of NEW) {
      expect(store.get(n)!.body.length, n).toBeLessThanOrEqual(4800)
      expect(raw(n).length, n).toBeLessThanOrEqual(5600)
    }
  })

  test('the injected suggestion stays within budget for every example (full ≤ 4,800 chars, compact ≤ 420)', () => {
    for (const [q] of CASES) {
      const full = store.suggest(q)
      const small = store.suggest(q, { compact: true })
      expect(full, q).toBeDefined()
      const chars = full!.lines.join('\n').length + (full!.body ? full!.body.lines.join('\n').length : 0)
      expect(chars, q).toBeLessThanOrEqual(4800)
      expect(full!.lines.length).toBeLessThanOrEqual(5)
      expect(small!.lines.join('\n').length, q).toBeLessThanOrEqual(420)
      expect(small!.body).toBeUndefined()
      // An inlined medical body keeps its safety block even when clipped.
      if (full!.body && MEDICAL.includes(full!.body.name)) expect(full!.body.lines.join('\n'), q).toContain('not a substitute for professional medical care')
    }
  })

  test('the system-prompt index stays small with the new packs', () => {
    expect(store.index().length).toBeLessThan(4000)
  })
})

describe('PHI helper (phi_scan)', () => {
  const NOTE = `Patient: Jane Q. Doe   DOB: 03/14/1962   MRN: 00482913
Address: 1420 Maple Avenue, Apt 4B, Springfield, IL 62704
Phone (555) 201-3344, fax: 555-201-3345, email jane.doe@example.com
SSN 123-45-6789. Member ID: XJH449201. Seen on March 3, 2024 for hypertension; lisinopril 10 mg daily.
Mother: Ana Ruiz, 91 years old. Portal: https://portal.example.org/u/8812 from 192.168.4.20.`

  test('finds the Safe Harbor identifiers in a clinical note', () => {
    const s = scanPhi(NOTE)
    const types = new Set(s.findings.map((f) => f.type))
    for (const t of ['name', 'date', 'mrn', 'address', 'zip', 'phone', 'fax', 'email', 'ssn', 'health_plan_id', 'age_over_89', 'url', 'ip'] as const) expect(types.has(t), t).toBe(true)
    expect(s.findings.find((f) => f.type === 'name')?.text).toBe('Jane Q. Doe')
    expect(s.findings.some((f) => f.text === 'Ana Ruiz')).toBe(true)
    expect(s.healthContext).toBe(true)
    expect(s.likelyPhi).toBe(true)
    // Overlaps are resolved: findings never overlap and come in order.
    for (let i = 1; i < s.findings.length; i++) expect(s.findings[i].start).toBeGreaterThanOrEqual(s.findings[i - 1].end)
  })

  test('redacts with typed placeholders, keeps clinical content, optionally keeps the year', () => {
    const r = redactPhi(NOTE)
    for (const v of ['Jane', 'Doe', '03/14/1962', '00482913', '1420 Maple', '62704', '201-3344', 'jane.doe@', '123-45-6789', 'XJH449201', 'Ana Ruiz', '91 years', 'portal.example', '192.168']) expect(r.text, v).not.toContain(v)
    for (const p of ['[NAME]', '[DATE]', '[MRN]', '[ADDRESS]', '[PHONE]', '[FAX]', '[EMAIL]', '[SSN]', '[PLAN ID]', '[AGE 90+]', '[URL]', '[IP]']) expect(r.text, p).toContain(p)
    expect(r.text).toContain('hypertension; lisinopril 10 mg daily')
    expect(redactPhi('Seen on March 3, 2024 for a cough.', { keepYear: true }).text).toBe('Seen on [DATE 2024] for a cough.')
    // Deterministic.
    expect(redactPhi(NOTE).text).toBe(r.text)
  })

  test('few false positives on ordinary clinical and everyday text', () => {
    const plain = 'Take 2 tablets at dr visit. Blood pressure 128/82, A1c 6.1%, eGFR 74. Walk 30 minutes 5 days a week. You may 2x the dose only if told. Patient: denies chest pain.'
    expect(scanPhi(plain).findings).toEqual([])
    expect(scanPhi('Plan a trip to Japan in 2026 for 10 days').hasIdentifiers).toBe(false)
    // Identifiers without health context are personal data, not PHI.
    const s = scanPhi('Call me at 555-201-3344 about the party.')
    expect(s.hasIdentifiers).toBe(true)
    expect(s.likelyPhi).toBe(false)
  })

  test('card numbers need a valid checksum; labeled IDs need a digit', () => {
    expect(scanPhi('card 4111 1111 1111 1111').findings.map((f) => f.type)).toContain('account')
    expect(scanPhi('card 4111 1111 1111 1112').findings.map((f) => f.type)).not.toContain('account')
    expect(scanPhi('Policy number is active').findings).toEqual([])
  })

  test('the tool is read-only, masks values in scan output and returns redacted text', async () => {
    const t = phiTool()
    expect(t.name).toBe('phi_scan')
    expect(t.effect).toBe('read')
    expect(t.core).toBeFalsy()
    const ctx = {} as Parameters<typeof t.run>[1]
    const scan = await t.run({ action: 'scan', text: NOTE }, ctx)
    expect(scan.text).toMatch(/Likely PHI/)
    expect(scan.text).not.toContain('Jane Q. Doe')
    expect(scan.text).not.toContain('123-45-6789')
    expect(maskValue('Jane Doe')).toBe('J*** D**')
    const red = await t.run({ action: 'redact', text: NOTE }, ctx)
    expect(red.text).toContain('[NAME]')
    expect(red.text).not.toContain('Jane Q. Doe')
  })
})

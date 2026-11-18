// Business ideation and validation in Max: when the request is to come up with business ideas or to check
// whether one is worth doing, the idea swarm's helpers and the research team's tasks carry the method of
// the skills built for it (packs/skills: ideas-new-business, ideas-novelty-check, business-complaint-mining,
// ideas-validate-business), because helpers can't see this chat or its skill suggestions. Pure.

export type BusinessJob = 'ideate' | 'validate'

const IDEATE = /\b((new |novel |fresh |original |untapped )?(business|startup|start-up|side[- ]hustle|saas|app|product|company|venture|money[- ]making|niche) ideas?|ideas? for (a |an |my )?(business|startup|company|app|product|side hustle)|what (business|startup|company) (should|could|can) i (start|build)|business opportunit(y|ies)|gaps? in the market|unmet needs?|nobody (has )?(built|made|done))\b/i
const VALIDATE = /\b(validat\w*|is (this|my|it|there) (a )?(real |good |viable )?(problem|idea|market|demand)|(would|will) (people|anyone|customers) (pay|buy|use)|willingness to pay|product[- ]market fit|demand (check|test)|complain\w*|pain points?|negative reviews?|does (this|it|that) (idea )?(already )?exist|already (exists?|been (built|done|made))|competitors? (for|to) (my|this|the) idea|market research|tam\b|sam\b|som\b|kill or (go|build)|go[ /]no[- ]go)\b/i

/** Which business job a request is, if any. Validation wins when both appear ("validate these 5 ideas"). */
export function businessJob(text: string): BusinessJob | null {
  const t = text.slice(0, 4000)
  if (VALIDATE.test(t) && /\b(idea|business|startup|product|app|market|customers?|saas|niche|demand|problem|complain\w*|reviews?)\b/i.test(t)) return 'validate'
  if (IDEATE.test(t)) return 'ideate'
  return null
}

const NOVELTY = 'Novelty check (skill ideas-novelty-check) for every candidate: search for existing products before keeping it: web search ("<problem> app", "<problem> software", "alternative to <X>"), Product Hunt, App Store / Google Play, G2 / Capterra categories, Crunchbase-style listings, GitHub, Chrome Web Store / Shopify apps when relevant, Google Patents when relevant. Name what is already out there (with links), say the gap (who they miss, what they get wrong, price), and give a verdict: New / Underserved niche / Crowded → reshaped / Dropped. Drop or reshape anything that already exists as-is. Finding nothing is not proof: label confidence.'
const COMPLAINTS = 'Complaint mining (skill business-complaint-mining): search where people complain (Reddit, Hacker News, niche forums, App Store / Google Play 1-3 star reviews, G2, Capterra, Trustpilot, Amazon reviews, X). Quote only short real complaints (under ~25 words) as citations with link and date; never invent or paraphrase as a quote. Cluster the pain points; estimate frequency (distinct threads and sources, how recent) and intensity (workarounds, money or time lost, "I would pay").'
const SCORE = 'Score each idea 1-5 with the evidence behind each number: pain severity, frequency, willingness-to-pay signals, competition (from the novelty check), feasibility for a solo founder or the user\'s situation. Give a clear verdict (Go / Reshape / Kill) and ONE next validation step: a landing-page smoke test (headline, offer, traffic source, success threshold), 5 customer interviews with a short no-pitch script, or a pre-sale (offer, price, threshold).'

/** The method helpers follow (one block for the swarm's context or each team task), or null. */
export function businessMethod(text: string): { job: BusinessJob; skills: string[]; method: string } | null {
  const job = businessJob(text)
  if (!job) return null
  if (job === 'ideate') {
    return {
      job, skills: ['ideas-new-business', 'business-complaint-mining', 'ideas-novelty-check'],
      method: `## Method (business ideas that aren't already made)\n1. Start from real pain, not brainstorming: ${COMPLAINTS}\n2. Turn the strongest pain clusters into candidate ideas (your own angle; several per helper).\n3. ${NOVELTY}\n4. ${SCORE}\nReport each idea with: one-line pitch, who it's for, the quoted pain (links), what exists and the gap, the novelty verdict, scores, and the next test.`
    }
  }
  return {
    job, skills: ['ideas-validate-business', 'business-complaint-mining', 'ideas-novelty-check'],
    method: `## Method (is this worth doing?)\n1. ${COMPLAINTS}\n2. ${NOVELTY}\n3. ${SCORE}\nReport the evidence with links and dates; label guesses as guesses.`
  }
}

/** The lead's line: which skills the helpers were given (so the compile keeps their structure). */
export function businessNote(text: string): string {
  const m = businessMethod(text)
  if (!m) return ''
  return ` This is ${m.job === 'ideate' ? 'business ideation' : 'business validation'}: follow the ${m.skills.join(', ')} skills (read_skill for the full steps). Give every helper the method (complaints → novelty check against existing products → scored verdict and next validation step) in its context or task, and in the compile drop ideas that already exist as-is, keep the quoted complaints with links, and end with the scoring table and the next step.`
}

/** The swarm's context and each team task with the method added (once). */
export function withBusinessMethod(text: string, a: { context?: string; tasks?: Array<{ title: string; task: string }> }): { context?: string; tasks?: Array<{ title: string; task: string }> } {
  const m = businessMethod(text)
  if (!m) return a
  const has = (s?: string): boolean => !!s && s.includes('## Method (')
  return {
    context: has(a.context) ? a.context : [a.context, m.method].filter(Boolean).join('\n\n'),
    tasks: a.tasks?.map((t) => (has(t.task) ? t : { ...t, task: `${t.task}\n\n${m.method}` }))
  }
}

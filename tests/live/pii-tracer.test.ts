import { expect, test } from 'vitest'
import { PiiTracer } from '../../src/main/privacy/tracer'
import { unsureFinding } from '../../src/main/privacy/gate'

// The real PII-Tracer on this Mac. Point SAHILBOT_PII_TRACER_DIR at a folder laid out like the app's
// (model/pplx-pii-masking-backbone-f16.gguf, model/heads.safetensors, llama/…/llama-server).
const dir = process.env.SAHILBOT_PII_TRACER_DIR

test.skipIf(!dir)('PII-Tracer finds the model card\'s example spans with the right labels and offsets', async () => {
  const tracer = new PiiTracer(dir!)
  try {
    expect(tracer.installed()).toBe(true)
    const text = 'Hi, I\'m Daniel Whitfield, you can reach me at daniels@meridiancap.com or 415-555-0123.'
    const { spans, sensitivity } = await tracer.detect(text)
    const got = spans.map((s) => [s.label, text.slice(s.start, s.end)])
    // The model card's output: private_person (8, 24), private_email (46, 69), private_phone (73, 85).
    expect(got).toEqual([['private_person', 'Daniel Whitfield'], ['private_email', 'daniels@meridiancap.com'], ['private_phone', '415-555-0123']])
    expect(spans.map((s) => [s.start, s.end])).toEqual([[8, 24], [46, 69], [73, 85]])
    expect(sensitivity).toBeGreaterThan(0)
    // Non-ASCII text keeps its offsets, and plain text finds nothing.
    const intl = 'Écris à Zoë Müller: zoe.muller@exemple.fr 📞'
    const intlSpans = (await tracer.detect(intl)).spans
    expect(intlSpans.some((s) => s.label === 'private_email' && intl.slice(s.start, s.end) === 'zoe.muller@exemple.fr')).toBe(true)
    // Plain questions: anything PII-Tracer flags is low-stakes enough to get the local model's second look, never a sure find.
    const plain = 'What is the capital of France? Please explain photosynthesis briefly.'
    for (const s of (await tracer.detect(plain)).spans) expect(unsureFinding(s.label, plain.slice(s.start, s.end), s.score)).toBe(true)
    // Longer than one 4,096-token window: chunked, and a name near the end is still found.
    const long = 'The weather report says it will be sunny. '.repeat(500) + 'Please call Priya Raman at 212-555-0199.'
    const longSpans = (await tracer.detect(long)).spans
    expect(longSpans.some((s) => long.slice(s.start, s.end) === 'Priya Raman')).toBe(true)
  } finally { tracer.stop() }
}, 300_000)

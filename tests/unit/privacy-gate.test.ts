import { describe, expect, test } from 'vitest'
import type { WireMessage } from '../../src/main/llm/client'
import { StreamRestorer, WITHHELD, applyAnswer, detectInContext, mergeSpans, phiSpans, recordNotPersonal, unsureFinding, documentFindings, emptyPrivacy, findings, markScanned, maskWire, parseAnswer, restoreText, segmentsOf, unscanned } from '../../src/main/privacy/gate'
import { classifyDocument } from '../../src/main/privacy/documents'
import { LABELS, chunkBounds, linear, parseSafetensors, pathToSpans, pieceOffsets, transitions, viterbi } from '../../src/main/privacy/tracer'
import type { PrivacySpan } from '../../src/shared/privacy'

const span = (text: string, value: string, label: PrivacySpan['label']): PrivacySpan => {
  const start = text.indexOf(value)
  return { start, end: start + value.length, label, score: 0.99 }
}

describe('PII-Tracer decoding (ported from example_client.py)', () => {
  test('constrained Viterbi never produces an invalid BIOES path, and spans come out trimmed', () => {
    const text = 'Hi, I\'m Daniel Whitfield ok'
    // Tokens: "Hi" "," " I" "'m" " Daniel" " Whit" "field" " ok"
    const pieces = ['Hi', ',', ' I', '\'m', ' Daniel', ' Whit', 'field', ' ok']
    const offsets = pieceOffsets(text, pieces)
    expect(offsets[4]).toEqual([7, 14])
    const id = (l: string): number => LABELS.indexOf(l)
    // Logits favouring B/I/E-person on tokens 4–6, with a tempting but invalid lone I- on token 1.
    const logits = pieces.map((_, t) => {
      const row = new Float32Array(LABELS.length).fill(-5)
      row[id('O')] = 2
      if (t === 1) row[id('I-private_email')] = 3
      if (t === 4) row[id('B-private_person')] = 6
      if (t === 5) row[id('I-private_person')] = 6
      if (t === 6) row[id('E-private_person')] = 6
      return row
    })
    const path = viterbi(logits, LABELS, transitions(LABELS))
    expect(path.map((p) => LABELS[p])).toEqual(['O', 'O', 'O', 'O', 'B-private_person', 'I-private_person', 'E-private_person', 'O'])
    const spans = pathToSpans(path, logits, offsets, LABELS, text)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ label: 'private_person', text: 'Daniel Whitfield', start: 8, end: 24 })
  })

  test('byte pieces of a multi-byte character map to the right characters', () => {
    const text = 'José 📞 5'
    const pieces: Array<string | number[]> = ['Jos', [0xc3], [0xa9], ' ', [0xf0, 0x9f], [0x93, 0x9e], ' 5']
    const o = pieceOffsets(text, pieces)
    expect(text.slice(o[0][0], o[0][1])).toBe('Jos')
    expect(text.slice(o[1][0], o[2][1])).toBe('é')
    expect(text.slice(o[4][0], o[5][1])).toBe('📞')
    expect(text.slice(o[6][0], o[6][1])).toBe(' 5')
  })

  test('safetensors heads parse, and the linear head matches a hand computation', () => {
    const header = JSON.stringify({ w: { dtype: 'F32', shape: [2, 3], data_offsets: [0, 24] }, b: { dtype: 'F32', shape: [2], data_offsets: [24, 32] } })
    const body = Buffer.alloc(32)
    ;[1, 2, 3, 4, 5, 6, 0.5, -1].forEach((v, i) => body.writeFloatLE(v, i * 4))
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(header.length))
    const t = parseSafetensors(Buffer.concat([len, Buffer.from(header), body]))
    expect(t.w.shape).toEqual([2, 3])
    const [y] = linear([[1, 1, 1]], t.w, t.b)
    expect([...y]).toEqual([6.5, 14])
  })

  test('long text is cut into chunks under the token limit, at sentence ends where possible', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(' ')
    const words = text.split(/(?<= )/)
    let at = 0
    const offsets = words.map((w) => { const o: [number, number] = [at, at + w.length]; at += w.length; return o })
    const chunks = chunkBounds(offsets, text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0][0]).toBe(0)
    expect(chunks[chunks.length - 1][1]).toBe(text.length)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i][0]).toBe(chunks[i - 1][1])
  })
})

describe('Privacy Gate bookkeeping', () => {
  const user = 'Email Daniel Whitfield at daniels@meridiancap.com about account 4111 2222 3333 4444.'
  const wire = (): WireMessage[] => [{ role: 'system', content: 'You are SahilBot.' }, { role: 'user', content: user }]
  const spans = [span(user, 'Daniel Whitfield', 'private_person'), span(user, 'daniels@meridiancap.com', 'private_email'), span(user, '4111 2222 3333 4444', 'account_number')]

  test('split: the cloud sees stand-ins, and its reply and tool calls get the real values back', () => {
    const st = emptyPrivacy()
    const segs = unscanned(st, segmentsOf(wire()))
    expect(segs).toHaveLength(1)
    const found = findings(st, [{ segment: segs[0], spans }])
    expect(found.map((f) => [f.label, f.strict])).toEqual([['private_person', false], ['private_email', false], ['account_number', true]])
    applyAnswer(st, found, { action: 'split', notPersonal: [], remember: false })
    markScanned(st, segs)
    const masked = maskWire(wire(), st)
    expect(masked[1].content).toBe('Email [PERSON_1] at [EMAIL_1] about account [ACCOUNT_1].')
    // Already decided: nothing new to ask about.
    expect(unscanned(st, segmentsOf(wire()))).toHaveLength(0)
    expect(restoreText('Done, I wrote to [PERSON_1].', st)).toBe('Done, I wrote to Daniel Whitfield.')
    expect(restoreText('{"to":"[EMAIL_1]"}', st, true)).toBe('{"to":"daniels@meridiancap.com"}')
    // A tool call the model made earlier, and Claude's own blocks: masked again before going back.
    const history: WireMessage[] = [...wire(), { role: 'assistant', content: 'Sending to daniels@meridiancap.com', tool_calls: [{ id: 'c', type: 'function', function: { name: 'email_send', arguments: '{"to":"daniels@meridiancap.com"}' } }], raw: [{ type: 'thinking', thinking: 'Daniel Whitfield', signature: 's' }, { type: 'text', text: 'Hi Daniel Whitfield' }] }]
    const out = maskWire(history, st)[2]
    expect(out.content).toBe('Sending to [EMAIL_1]')
    expect(out.tool_calls![0].function.arguments).toBe('{"to":"[EMAIL_1]"}')
    expect(out.raw).toEqual([{ type: 'thinking', thinking: 'Daniel Whitfield', signature: 's' }, { type: 'text', text: 'Hi [PERSON_1]' }])
  })

  test('share keeps strict items masked unless the user says they are not personal', () => {
    const st = emptyPrivacy()
    const segs = segmentsOf(wire())
    const found = findings(st, [{ segment: segs[0], spans }])
    applyAnswer(st, found, { action: 'share', notPersonal: [], remember: true })
    expect(maskWire(wire(), st)[1].content).toBe('Email Daniel Whitfield at daniels@meridiancap.com about account [ACCOUNT_1].')
    expect(st.remember).toBe('share')
    const st2 = emptyPrivacy()
    const acct = found.find((f) => f.label === 'account_number')!
    applyAnswer(st2, found, { action: 'share', notPersonal: [acct.id], remember: false })
    expect(maskWire(wire(), st2)).toEqual(wire())
  })

  test('skip withholds the whole message from cloud models; vault output is never checked', () => {
    const st = emptyPrivacy()
    const segs = segmentsOf(wire())
    applyAnswer(st, findings(st, [{ segment: segs[0], spans }]), { action: 'skip', notPersonal: [], remember: false })
    expect(maskWire(wire(), st)[1].content).toBe(WITHHELD)
    const withVault: WireMessage[] = [...wire(), { role: 'tool', name: 'vault', tool_call_id: 'v', content: 'Filled "Chase Visa" for Daniel Whitfield' }]
    expect(segmentsOf(withVault).map((s) => s.source)).toEqual(['Your message'])
  })

  test('stand-ins split across streamed chunks are restored once complete', () => {
    const st = emptyPrivacy()
    applyAnswer(st, findings(st, [{ segment: segmentsOf(wire())[0], spans }]), { action: 'split', notPersonal: [], remember: false })
    const r = new StreamRestorer(st)
    const out = ['Hello [PER', 'SON_1], your email [', 'EMAIL_1] is set. [not a stand-in]'].map((c) => r.push(c)).join('') + r.flush()
    expect(out).toBe('Hello Daniel Whitfield, your email daniels@meridiancap.com is set. [not a stand-in]')
  })

  test('not too strict: unsure finds get a second look, judged-not-personal ones are remembered and never asked again', () => {
    expect(unsureFinding('private_address', 'France', 0.85)).toBe(true)
    expect(unsureFinding('private_address', '12 Elm St, Springfield', 0.97)).toBe(false)
    expect(unsureFinding('private_person', 'Daniel Whitfield', 0.99)).toBe(false)
    expect(unsureFinding('private_person', 'Daniel', 0.99)).toBe(true)
    expect(unsureFinding('private_date', 'tomorrow', 0.95)).toBe(true)
    expect(unsureFinding('account_number', '4111', 0.7)).toBe(false)
    const st = emptyPrivacy()
    const text = 'What is the capital of France?'
    const seg = segmentsOf([{ role: 'user', content: text }])[0]
    const found = findings(st, [{ segment: seg, spans: [{ ...span(text, 'France', 'private_address'), score: 0.85 }, { ...span(text, 'capital', 'other_pii'), score: 0.3 }] }])
    expect(found.map((f) => [f.value, f.unsure])).toEqual([['France', true]])
    recordNotPersonal(st, found)
    expect(findings(st, [{ segment: seg, spans: [span(text, 'France', 'private_address')] }])).toEqual([])
    expect(maskWire([{ role: 'user', content: text }], st)[0].content).toBe(text)
  })

  test('detection reads the message before for context, but only reports spans in the new part', async () => {
    const w: WireMessage[] = [{ role: 'user', content: 'My doctor is Dr. Lena Ortiz.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'Book Lena for Tuesday.' }]
    const all = segmentsOf(w)
    let seen = ''
    const { spans } = await detectInContext(all, all[2], async (t) => {
      seen = t
      return { spans: [span(t, 'Lena Ortiz', 'private_person'), { ...span(t, 'Book Lena', 'private_person'), start: t.lastIndexOf('Lena'), end: t.lastIndexOf('Lena') + 4 }] }
    })
    expect(seen).toContain('My doctor is Dr. Lena Ortiz.')
    expect(spans).toEqual([expect.objectContaining({ text: 'Lena', start: 5, end: 9 })])
  })

  test('one detector: the PHI scanner\'s SSNs and record numbers join PII-Tracer\'s spans, and a very sensitive passage counts as a record', () => {
    const text = 'Patient SSN 123-45-6789, MRN: 00482913, seen for follow-up.'
    const rules = phiSpans(text)
    expect(rules.map((r) => r.text)).toEqual(expect.arrayContaining(['123-45-6789']))
    expect(rules.every((r) => r.label === 'account_number')).toBe(true)
    const merged = mergeSpans([{ start: text.indexOf('123'), end: text.indexOf('123') + 6, label: 'other_pii', score: 0.7 }], rules)
    expect(merged.some((s) => s.text === '123-45-6789')).toBe(true)
    const long = 'I have been struggling a lot lately and my therapist and I talked about it at length. '.repeat(5)
    const seg = segmentsOf([{ role: 'user', content: long }])
    expect(documentFindings(seg, new Map([[seg[0].key, 0.97]]))).toEqual([expect.objectContaining({ kind: 'sensitive_text' })])
    expect(documentFindings(seg, new Map([[seg[0].key, 0.6]]))).toEqual([])
  })

  test('a missing or garbled card answer is treated as Skip content', () => {
    expect(parseAnswer('deny')).toEqual({ action: 'skip', notPersonal: [], remember: false })
    expect(parseAnswer(JSON.stringify({ action: 'local', notPersonal: ['a', 3], remember: true }))).toEqual({ action: 'local', notPersonal: ['a'], remember: true })
  })
})

describe('document safeguard', () => {
  const bank = `ACME BANK  Statement period: Oct 1 - Oct 31, 2026  Account number: ****4821
Beginning balance $2,431.10   Deposits and other additions $3,200.00   Withdrawals and other subtractions $1,904.33
Ending balance $3,726.77   Daily ending balance  10/02 $2,389.10  10/05 $5,589.10  Member FDIC. Checking account summary.`
  const bill = `Speedy Fiber internet service bill. Account number 88231-002. Billing period Oct 3 - Nov 2. Service address 12 Elm St.
Previous bill $79.99, payment received $79.99. Internet service plan 1 Gbps $70.00, equipment $9.99. Amount due $79.99, due date Nov 20. Autopay is on.`
  test('bank statements and internet bills are recognized as personal records', () => {
    expect(classifyDocument(bank)).toBe('bank_statement')
    expect(classifyDocument(bill)).toBe('utility_bill')
  })
  test('not too conservative: an article about statements, a recipe or a short note is not a document', () => {
    expect(classifyDocument('How to read a bank statement: look at your beginning balance and ending balance, then check deposits. Most banks are FDIC insured. This guide explains each section of a typical statement in plain words so you can spot errors quickly and understand fees.')).toBeUndefined()
    expect(classifyDocument('Pay my internet bill tomorrow')).toBeUndefined()
    expect(classifyDocument('Mix 200 g of flour with 2 eggs, bake 25 minutes at 180 C. Serves 4. Costs about $6.50 for ingredients, $1.20 per serving and $0.80 for toppings, a cheap weeknight dinner that kids enjoy and keeps for days in the fridge.')).toBeUndefined()
  })
  test('documents found in the conversation are withheld for every choice but Share anyway', () => {
    const w: WireMessage[] = [{ role: 'user', content: 'Summarize my statement' }, { role: 'tool', name: 'file_read', tool_call_id: 'f', content: bank }]
    const segs = segmentsOf(w)
    const docs = documentFindings(segs)
    expect(docs).toEqual([expect.objectContaining({ kind: 'bank_statement', source: 'file_read output' })])
    const st = emptyPrivacy()
    applyAnswer(st, [], { action: 'split', notPersonal: [], remember: false }, docs)
    expect(maskWire(w, st)[1].content).toBe(WITHHELD)
    expect(maskWire(w, st)[0].content).toBe('Summarize my statement')
    const shared = emptyPrivacy()
    applyAnswer(shared, [], { action: 'share', notPersonal: [], remember: false }, docs)
    expect(maskWire(w, shared)).toEqual(w)
  })
})

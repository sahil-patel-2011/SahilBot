const { KokoroTTS } = await import('kokoro-js')
const { env } = await import('@huggingface/transformers')
env.cacheDir = process.env.HOME + '/Library/Application Support/Foreman/models/hf'
let t = Date.now()
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
console.log('load ms', Date.now() - t)
for (const s of ['Sure.', 'You have two meetings tomorrow afternoon.', 'The first is at two o clock with the design team.']) {
  t = Date.now()
  const a = await tts.generate(s, { voice: 'af_heart' })
  console.log('gen ms', Date.now() - t, 'samples', a.audio.length, 'sr', a.sampling_rate)
}
console.log(tts.voices ? Object.keys(tts.voices).slice(0, 8) : '')

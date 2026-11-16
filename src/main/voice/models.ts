// Speech recognition models for voice input: whisper.cpp's official ggml builds, picked for this Mac.
//
// Source: https://huggingface.co/ggerganov/whisper.cpp (the files whisper.cpp's own
// models/download-ggml-model.sh fetches). Sizes and SHA-256 below are that repository's Git LFS
// metadata (huggingface.co/api/models/ggerganov/whisper.cpp/tree/main, checked 2026-11-15); every
// download is checked against both before it is used.
//
// The rule (pickWhisper), aiming for well under a second per short utterance with Metal:
//   - Intel Mac (no Metal acceleration worth having): small, 5-bit (190 MB). Fastest model that's still accurate.
//   - Apple silicon, under 16 GB: small, 8-bit (264 MB). Near-lossless small; ~0.2–0.4 s per utterance.
//   - Apple silicon, 16–31 GB: large-v3-turbo, 5-bit (574 MB), the best accuracy per second whisper.cpp
//     has (4 decoder layers, so it decodes faster than medium). A one-time benchmark on first use times a
//     spoken sentence; slower than BENCH_LIMIT_MS (a busy or base-chip Mac) falls back to small, 8-bit.
//     medium isn't a fallback: it's both slower and less accurate than large-v3-turbo.
//   - Apple silicon, 32 GB or more: large-v3-turbo, 8-bit (874 MB), the most accurate quantized build.
// Settings → Voice → Advanced can pin any model below instead.

export type WhisperId = 'small-q5_1' | 'small-q8_0' | 'medium-q5_0' | 'large-v3-turbo-q5_0' | 'large-v3-turbo-q8_0'

export interface WhisperModel {
  id: WhisperId
  /** File name in the models folder (and in the official repository). */
  file: string
  /** "Whisper large-v3-turbo" (the family; the build is in `build`). */
  label: string
  build: string
  bytes: number
  sha256: string
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

export const WHISPER_MODELS: readonly WhisperModel[] = [
  { id: 'small-q5_1', file: 'ggml-small-q5_1.bin', label: 'Whisper small', build: '5-bit', bytes: 190_085_487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  { id: 'small-q8_0', file: 'ggml-small-q8_0.bin', label: 'Whisper small', build: '8-bit', bytes: 264_464_607, sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f' },
  { id: 'medium-q5_0', file: 'ggml-medium-q5_0.bin', label: 'Whisper medium', build: '5-bit', bytes: 539_212_467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' },
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Whisper large-v3-turbo', build: '5-bit', bytes: 574_041_195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { id: 'large-v3-turbo-q8_0', file: 'ggml-large-v3-turbo-q8_0.bin', label: 'Whisper large-v3-turbo', build: '8-bit', bytes: 874_188_075, sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1' }
]

export const whisperUrl = (m: WhisperModel): string => `${HF}${m.file}`
export const whisperById = (id: string | undefined): WhisperModel | undefined => WHISPER_MODELS.find((m) => m.id === id)
export const isWhisperId = (v: unknown): v is WhisperId => typeof v === 'string' && WHISPER_MODELS.some((m) => m.id === v)

/** A spoken sentence (about 3 s) must transcribe faster than this on the 16–31 GB tier to keep large-v3-turbo. */
export const BENCH_LIMIT_MS = 1200

export interface Hardware {
  ramGB: number
  /** Apple silicon (arm64): whisper.cpp runs on the GPU through Metal. */
  appleSilicon: boolean
}

/** A finished one-time benchmark: how long `model` took on a spoken sentence. */
export interface WhisperBench { model: WhisperId; ms: number; at: number }

export interface WhisperPick {
  model: WhisperModel
  /** Short and plain: "best for your Mac", "fastest on this Mac", "you chose it". */
  reason: string
  /** Why, in one sentence (Settings → Voice's "i"). */
  why: string
  /** This pick should be timed once on first use (bench still unknown). */
  benchmark?: boolean
}

const mb = (m: WhisperModel): string => `${Math.round(m.bytes / 1e6)} MB`
const gb = (n: number): string => `${Math.round(n)} GB`

/** The model voice input uses on this Mac (see the rule at the top). `choice` 'auto' or an id from Advanced. */
export function pickWhisper(hw: Hardware, o: { choice?: string; bench?: WhisperBench | null } = {}): WhisperPick {
  const pinned = o.choice && o.choice !== 'auto' ? whisperById(o.choice) : undefined
  if (pinned) return { model: pinned, reason: 'you chose it', why: `Chosen in Settings → Voice → Advanced (${mb(pinned)}).` }
  const get = (id: WhisperId): WhisperModel => whisperById(id)!
  if (!hw.appleSilicon) return { model: get('small-q5_1'), reason: 'fastest on this Mac', why: 'Intel Macs can\'t run Whisper on the GPU, so the small model keeps replies quick.' }
  if (hw.ramGB < 16) return { model: get('small-q8_0'), reason: 'best for your Mac', why: `With ${gb(hw.ramGB)} of memory, Whisper small (8-bit, ${mb(get('small-q8_0'))}) is accurate and answers in well under a second.` }
  if (hw.ramGB >= 32) return { model: get('large-v3-turbo-q8_0'), reason: 'best for your Mac', why: `With ${gb(hw.ramGB)} of memory, the most accurate build (large-v3-turbo, 8-bit, ${mb(get('large-v3-turbo-q8_0'))}) still answers in under a second on Apple silicon.` }
  const turbo = get('large-v3-turbo-q5_0')
  const bench = o.bench && o.bench.model === turbo.id ? o.bench : null
  if (bench && bench.ms > BENCH_LIMIT_MS) {
    return { model: get('small-q8_0'), reason: 'fastest on this Mac', why: `large-v3-turbo took ${(bench.ms / 1000).toFixed(1)} s on a short sentence here, so Whisper small (8-bit) keeps voice input under a second.` }
  }
  return {
    model: turbo, reason: 'best for your Mac',
    why: `With ${gb(hw.ramGB)} of memory, large-v3-turbo (5-bit, ${mb(turbo)}) gives the best accuracy at under a second${bench ? ` (${(bench.ms / 1000).toFixed(2)} s on a short sentence here)` : '; it\'s timed once on first use and swapped for Whisper small if this Mac is too slow'}.`,
    ...(bench ? {} : { benchmark: true })
  }
}

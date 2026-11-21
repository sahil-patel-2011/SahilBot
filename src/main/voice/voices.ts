import type { VoiceBarOptions } from '@shared/types'

// The voices each speech engine offers in the voice bar. Ids are each engine's own; labels are for people.

type Engine = VoiceBarOptions['engine']

export const VOICES: Record<Engine, VoiceBarOptions['voices']> = {
  kokoro: [
    { id: 'af_heart', label: 'Heart', desc: 'Warm & natural' },
    { id: 'af_bella', label: 'Bella', desc: 'Bright & lively' },
    { id: 'af_nicole', label: 'Nicole', desc: 'Soft & close' },
    { id: 'af_sky', label: 'Sky', desc: 'Clear & light' },
    { id: 'am_michael', label: 'Michael', desc: 'Calm & steady' },
    { id: 'am_adam', label: 'Adam', desc: 'Deep & relaxed' },
    { id: 'bf_emma', label: 'Emma', desc: 'British & poised' },
    { id: 'bm_george', label: 'George', desc: 'British & warm' }
  ],
  openai: [
    { id: 'alloy', label: 'Alloy', desc: 'Balanced & neutral' },
    { id: 'coral', label: 'Coral', desc: 'Warm & friendly' },
    { id: 'sage', label: 'Sage', desc: 'Calm & thoughtful' },
    { id: 'nova', label: 'Nova', desc: 'Bright & upbeat' },
    { id: 'ash', label: 'Ash', desc: 'Clear & direct' },
    { id: 'onyx', label: 'Onyx', desc: 'Deep & firm' },
    { id: 'ballad', label: 'Ballad', desc: 'Soft & expressive' },
    { id: 'verse', label: 'Verse', desc: 'Easygoing & real' }
  ],
  xai: [
    { id: 'eve', label: 'Eve', desc: 'Energetic & clear' },
    { id: 'ara', label: 'Ara', desc: 'Warm & friendly' },
    { id: 'rex', label: 'Rex', desc: 'Confident & firm' },
    { id: 'sal', label: 'Sal', desc: 'Smooth & steady' },
    { id: 'leo', label: 'Leo', desc: 'Relaxed & real' }
  ],
  say: [
    { id: 'Samantha', label: 'Samantha', desc: 'American' },
    { id: 'Daniel', label: 'Daniel', desc: 'British' },
    { id: 'Karen', label: 'Karen', desc: 'Australian' },
    { id: 'Moira', label: 'Moira', desc: 'Irish' }
  ]
}

export const LANGUAGES: VoiceBarOptions['languages'] = [
  { id: 'auto', label: 'Auto-detect' }, { id: 'en', label: 'English' }, { id: 'es', label: 'Spanish' }, { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' }, { id: 'it', label: 'Italian' }, { id: 'pt', label: 'Portuguese' }, { id: 'hi', label: 'Hindi' },
  { id: 'gu', label: 'Gujarati' }, { id: 'zh', label: 'Chinese' }, { id: 'ja', label: 'Japanese' }, { id: 'ko', label: 'Korean' }, { id: 'ar', label: 'Arabic' }
]

/** Speed kept to what sounds natural. */
export const clampSpeed = (n: unknown): number => Math.min(2, Math.max(0.5, Number.isFinite(Number(n)) ? Math.round(Number(n) * 20) / 20 : 1))

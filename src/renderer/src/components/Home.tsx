import type { ReactNode } from 'react'
import type { Thread } from '@shared/types'
import { Mascot } from '../brand'
import * as I from '../icons'

const SUGGESTIONS: Array<{ icon: ReactNode; label: string; text: string }> = [
  { icon: <I.Search size={14} />, label: 'Research a topic', text: 'Research the latest on ' },
  { icon: <I.Edit size={14} />, label: 'Draft an email', text: 'Draft a short, friendly follow-up email to ' },
  { icon: <I.File size={14} />, label: 'Make a deck', text: 'Make a 6-slide deck about ' },
  { icon: <I.Globe size={14} />, label: 'Do something on a website', text: 'Go to ' },
  { icon: <I.Clock size={14} />, label: 'Set a reminder', text: 'Every weekday at 9am, remind me to ' },
  { icon: <I.Paperclip size={14} />, label: 'Summarize a file', text: 'Summarize the attached file in 5 bullet points.' }
]

function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name.split(' ')[0]}` : part
}

export function Home({ userName, recent, onOpen, composer, onSuggest }: {
  userName: string
  recent: Thread[]
  onOpen: (id: string) => void
  composer: ReactNode
  onSuggest: (text: string) => void
}) {
  const outputs = recent.filter((t) => t.lastPreview).slice(0, 6)
  return (
    <div className="home">
      <Mascot size={64} />
      <h1>{greeting(userName)}. What are we working on?</h1>
      {composer}
      <div className="suggestions" data-testid="suggestions">
        {SUGGESTIONS.map((x) => (
          <button key={x.label} className="suggestion" onClick={() => onSuggest(x.text)}>{x.icon}{x.label}</button>
        ))}
      </div>
      {outputs.length > 0 && (
        <div className="outputs">
          <h2>Recent outputs</h2>
          <div className="cards">
            {outputs.map((t) => (
              <button key={t.id} className="card" onClick={() => onOpen(t.id)}>
                <span className="t">{t.title}</span>
                <span className="p">{t.lastPreview}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

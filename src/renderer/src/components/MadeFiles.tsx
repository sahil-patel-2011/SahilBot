import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
export { filesFromSteps } from '../lib/ux'

// Files a run made or changed, as one small card under its steps: the name, where it is, Open (the preview in
// the side panel) and Show in Finder. One click from the answer to the file, without opening the step list.

const nameOf = (p: string): string => p.split('/').pop() ?? p
const folderOf = (p: string): string => p.split('/').slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~')

export function MadeFiles({ files, onOpen }: { files: Array<{ key: string; path: string }>; onOpen: (path: string) => void }) {
  if (!files.length) return null
  const reveal = (p: string): void => { void api.files.reveal(p).catch((e: Error) => toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')) }
  return (
    <div className="made-files" data-testid="made-files">
      {files.map((f) => (
        <div key={f.key} className="made-file" data-testid="made-file" title={f.path}>
          <span className="made-file-icon" aria-hidden><I.File size={16} /></span>
          <span className="made-file-text">
            <b>{nameOf(f.path)}</b>
            <span>{folderOf(f.path)}</span>
          </span>
          <button className="btn small" onClick={() => onOpen(f.path)} data-testid="made-file-open" aria-label={`Open ${nameOf(f.path)}`}>Open</button>
          <button className="btn small ghost" onClick={() => reveal(f.path)} data-testid="made-file-reveal" title="Show in Finder" aria-label={`Show ${nameOf(f.path)} in Finder`}><I.Reveal size={15} /></button>
        </div>
      ))}
    </div>
  )
}

import type { Space } from '@shared/types'
import { api } from '../api'
import { toast } from './toast'

/**
 * Deletes a bot from the sidebar or its profile, with Undo (no "can't be undone": the bot, its chat and its
 * routines are kept a few minutes, and Undo brings them all back). Throws when it can't be deleted.
 */
export async function deleteBotWithUndo(space: Pick<Space, 'id' | 'name'>, changed: () => void): Promise<void> {
  await api.spaces.remove(space.id)
  changed()
  toast(`Deleted ${space.name}`, 'ok', {
    action: {
      label: 'Undo',
      run: () => void api.spaces.restore(space.id).then(() => { changed(); toast(`${space.name} is back`, 'ok') }).catch((e) => toast((e as Error).message, 'error'))
    }
  })
}

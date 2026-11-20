import { extname } from 'node:path'

export const ROUTINE_DOWNLOAD_LIMIT = 10 * 1024 * 1024
const TYPES: Record<string, string> = { '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Auto may save a small passive file offered by the current HTTPS site into its workspace. */
export function routineDownload(download: { url: string; filename: string; size: number; mime: string }, page: string): boolean {
  try {
    const url = new URL(download.url)
    const mime = download.mime.split(';')[0].trim().toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === new URL(page).origin &&
      download.size > 0 && download.size <= ROUTINE_DOWNLOAD_LIMIT && TYPES[extname(download.filename).toLowerCase()] === mime
  } catch { return false }
}

/** A size people read: "840 KB", "312 MB", "1.24 GB". */
export function bytesText(n: number | undefined | null): string {
  if (!n || n < 0) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} bytes`
}

/** Download progress people read: "90 of 215 MB" (whole megabytes, never more than the total). */
export function downloadedText(received: number | undefined | null, total: number | undefined | null): string {
  if (!total || total <= 0) return ''
  const mb = (n: number): number => Math.round(n / 1e6)
  const done = Math.min(mb(Math.max(0, received ?? 0)), mb(total))
  return `${done} of ${mb(total)} MB`
}

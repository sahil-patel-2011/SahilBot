/** A size people read: "840 KB", "312 MB", "1.24 GB". */
export function bytesText(n: number | undefined | null): string {
  if (!n || n < 0) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} bytes`
}

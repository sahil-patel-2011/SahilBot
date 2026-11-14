// A small bridge for the app tool's Safari/Chrome adapter (src/main/computer/apps/browsers.ts): when the
// user's own browser shows a site SahilBot's browser already has a playbook for, its read_page result can
// say so. Set once in main (index.ts); empty until then, so the adapter works without it (tests).

let provider: ((url: string) => string) | null = null

export function setSiteHintProvider(fn: ((url: string) => string) | null): void {
  provider = fn
}

/** A one-line hint for a page open in the user's own browser, or ''. Never throws. */
export function siteHint(url: string): string {
  try { return provider?.(url) ?? '' } catch { return '' }
}

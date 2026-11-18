// The web UI's layout breakpoints (CSS pixels), shared by the mobile stylesheet (pages.ts) and the browser
// bridge, which puts the current one on <html data-layout>.

export const LAYOUT = { phone: 760, tablet: 1024 } as const
/** The smallest tap target on a phone (Apple's and Google's guidance: 44 pt / 48 dp). */
export const TAP_PX = 44

export type Layout = 'phone' | 'tablet' | 'desktop'

/** Which layout a viewport width gets. */
export function layoutFor(width: number): Layout {
  return width <= LAYOUT.phone ? 'phone' : width <= LAYOUT.tablet ? 'tablet' : 'desktop'
}

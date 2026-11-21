import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = ({ size = 18, ...p }: P): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', ...p
})

export const Search = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
export const Plus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
export const Mic = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
export const Wave = (p: P) => <svg {...base(p)}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>
export const Stop = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" /></svg>
export const Up = (p: P) => <svg {...base(p)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
export const Down = (p: P) => <svg {...base(p)}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
export const Chevron = (p: P) => <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>
export const UpDown = (p: P) => <svg {...base(p)}><path d="m7 9 5-5 5 5M7 15l5 5 5-5" /></svg>
export const Panel = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></svg>
export const Gear = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
export const Copy = (p: P) => <svg {...base(p)}><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
export const Pin = (p: P) => <svg {...base(p)}><path d="M12 17v5M9 4h6l-1 6 3 3H7l3-3-1-6Z" /></svg>
export const Trash = (p: P) => <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
export const Edit = (p: P) => <svg {...base(p)}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></svg>
export const Shield = (p: P) => <svg {...base(p)}><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /></svg>
export const Cpu = (p: P) => <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>
export const Globe = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
export const File = (p: P) => <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
export const Sparkle = (p: P) => <svg {...base(p)}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>
export const Check = (p: P) => <svg {...base(p)}><path d="m5 12 5 5 9-10" /></svg>
export const Smile = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>
export const SmilePlus = (p: P) => <svg {...base(p)}><path d="M20.5 11A8.5 8.5 0 1 1 13 3.5" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01M19 2v6M16 5h6" /></svg>
export const Reply = (p: P) => <svg {...base(p)}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v4" /></svg>
export const Folder = (p: P) => <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
export const Paperclip = (p: P) => <svg {...base(p)}><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></svg>
export const Image = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg>
export const ListIcon = (p: P) => <svg {...base(p)}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
export const Share = (p: P) => <svg {...base(p)}><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
export const Users = (p: P) => <svg {...base(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></svg>
export const Sliders = (p: P) => <svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
export const Layers = (p: P) => <svg {...base(p)}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></svg>
export const Plug = (p: P) => <svg {...base(p)}><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" /></svg>
export const Close = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
export const External = (p: P) => <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
export const Key = (p: P) => <svg {...base(p)}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2" /></svg>
export const Clock = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
export const Play = (p: P) => <svg {...base(p)}><path d="M7 5v14l11-7L7 5Z" /></svg>
export const Download = (p: P) => <svg {...base(p)}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
export const Video = (p: P) => <svg {...base(p)}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></svg>
export const Speaker = (p: P) => <svg {...base(p)}><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
/** Max mode: a bolt over stacked agents. */
export const Bolt = (p: P) => <svg {...base(p)}><path d="M13 2 5 13.5h6L10 22l8.5-12H12.5L13 2Z" /></svg>
/** An inbox tray: Needs you & Tasks (bots' questions, approvals and long-running goals). */
export const Inbox = (p: P) => <svg {...base(p)}><path d="M4 13.5 6.2 6a2 2 0 0 1 1.9-1.5h7.8A2 2 0 0 1 17.8 6l2.2 7.5" /><path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5h-4.5a3.5 3.5 0 0 1-7 0Z" /></svg>
/** Show in Finder: a folder with an arrow. */
export const Reveal = (p: P) => <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M10 14h5M13 11.5 15.5 14 13 16.5" /></svg>
export const ChatDots = (p: P) => <svg {...base(p)}><path d="M4 12a8 8 0 1 1 3.3 6.5L4 20l1.2-3.4A7.9 7.9 0 0 1 4 12Z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></svg>
export const HangUp = (p: P) => <svg {...base(p)}><path d="M3.5 14.5c4.7-4.2 12.3-4.2 17 0l-1.8 2.3a1.4 1.4 0 0 1-1.8.3l-2-1.2a1.4 1.4 0 0 1-.6-1.4l.2-1.5a11 11 0 0 0-5 0l.2 1.5a1.4 1.4 0 0 1-.6 1.4l-2 1.2a1.4 1.4 0 0 1-1.8-.3Z" /></svg>
/** A notebook with a bookmark: the knowledge vault. */
export const Vault = (p: P) => <svg {...base(p)}><path d="M6 3.5h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a1.5 1.5 0 0 1-1.5-1.5v-14A1.5 1.5 0 0 1 6 3.5Z" /><path d="M8.5 3.5v17M12 8h4M12 11.5h4" /></svg>
/** Three dots: more actions. */
export const More = (p: P) => <svg {...base(p)}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>

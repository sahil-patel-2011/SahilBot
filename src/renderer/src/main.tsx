import { createRoot } from 'react-dom/client'
import { UsageGlanceHost } from './components/UsagePage'
import { App } from './App'
import { QuickAsk } from './components/QuickAsk'
import { BotShareHost } from './components/BotShare'
import './styles.css'
import './styles-bots.css'
import './styles-connect.css'
import './styles-routines.css'
import './styles-teach.css'
import './styles-pages.css'
import './styles-memory.css'
import './styles-share-usage.css'
import './styles-stocks.css'
import './styles-tasks.css'
import './styles-jobs.css'
import './styles-docs.css'
import './styles-heavy.css'
// Loaded last: the polish layer refines everything above, then the finishing pass (lazy placeholders,
// long chats, narrow composer, toasts, reduced motion).
import './styles-polish.css'
import './styles-finish.css'
// Feature sheets that split chunks also import: listed here so they load before the design system below.
import './styles-cua.css'
import './styles-approvals.css'
import './styles-purchase.css'
import './styles-usage-dash.css'
import './styles-vault.css'
import './styles-secure-vault.css'
import './styles-activity.css'
import './styles-learning.css'
import './styles-mcp.css'
// The composer's one picker (model, thinking, permissions): components/ComposerPicker.tsx.
import './styles-picker.css'
// The design system (tokens + shared primitives) decides last: see styles-system.css.
import './styles-system.css'
// Intuitiveness pass (plain-language approvals, Folder chip, Bypass indicator, files made, inbox): after the tokens.
import './styles-ux.css'
// The chat itself (bubbles, the working line, quiet results) and the newest pages decide last.
import './styles-chat.css'
// Your brain (BrainView) and Agent mode's prompts.
import './styles-brain.css'
// The cleaner look (sidebar, home, banner): last, so it wins.
import './styles-clean.css'

// The same page serves the main window and the Quick Ask bar (#quick).
const quick = location.hash === '#quick'
if (quick) document.documentElement.classList.add('quick-mode')
createRoot(document.getElementById('root')!).render(quick ? <QuickAsk /> : <App />)
// The bot import preview (File → Import Bot…, sidebar, Connect Apps) lives in its own root over the app.
if (!quick) {
  const host = document.createElement('div')
  host.id = 'bot-share-root'
  document.body.appendChild(host)
  createRoot(host).render(<BotShareHost />)
  // The compact usage card (profile menu "Usage", ⌘K "Usage"): its own root over the app too.
  const usage = document.createElement('div')
  usage.id = 'usage-glance-root'
  document.body.appendChild(usage)
  createRoot(usage).render(<UsageGlanceHost />)
}

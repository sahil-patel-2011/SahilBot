import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickAsk } from './components/QuickAsk'
import './styles.css'
import './styles-bots.css'
import './styles-connect.css'
import './styles-routines.css'
import './styles-teach.css'
import './styles-pages.css'
import './styles-memory.css'

// The same page serves the main window and the Quick Ask bar (#quick).
const quick = location.hash === '#quick'
if (quick) document.documentElement.classList.add('quick-mode')
createRoot(document.getElementById('root')!).render(quick ? <QuickAsk /> : <App />)

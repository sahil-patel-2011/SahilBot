// The few pages SahilBot Server serves itself: pairing, the service worker (Web Push), the web manifest.
// No inline scripts or styles (the CSP forbids them); everything is a same-origin file.

import { LAYOUT, TAP_PX } from './layout'

export { LAYOUT, TAP_PX, layoutFor, type Layout } from './layout'

export interface PairPageOptions {
  /** Who serves the page: SahilBot Server, or the Mac app's Phone access. */
  host?: 'server' | 'mac'
}

/** The pairing page. The Mac's variant also shows the certificate check the QR code carries, and how to trust it. */
export function pairHtml(o: PairPageOptions = {}): string {
  const mac = o.host === 'mac'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${mac ? 'Pair with SahilBot' : 'Pair with SahilBot Server'}</title>
<link rel="stylesheet" href="/pair.css">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
</head>
<body>
<main class="card">
  <div class="logo" aria-hidden="true"><img src="/icon.svg" alt="" width="56" height="56"></div>
  <h1>${mac ? 'SahilBot on your Mac' : 'SahilBot Server'}</h1>
  <p class="sub">${mac ? 'Enter the code your Mac shows in Settings → General → Phone access. You only do this once on each phone.' : 'Enter the pairing code the server showed you. You only do this once on each device.'}</p>
  <form id="pair" autocomplete="off">
    <label for="code">Pairing code</label>
    <input id="code" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" maxlength="16" required data-testid="pair-code">
    <label for="name">Name this device <span class="opt">(optional)</span></label>
    <input id="name" name="name" maxlength="60" placeholder="My phone" data-testid="pair-name">
    <button type="submit" id="go" data-testid="pair-submit">Pair this ${mac ? 'phone' : 'device'}</button>
    <p id="msg" role="alert" class="msg"></p>
  </form>
${mac ? `  <section id="fp" class="fp" hidden data-testid="pair-fingerprint">
    <p><b>Security check.</b> Your Mac’s certificate starts with <code id="fp-value"></code>. If your browser shows a certificate, it must start the same way.</p>
    <p>For notifications and the Home Screen app, trust it once: <a href="/sahilbot.cer" data-testid="pair-cert">Install SahilBot’s certificate</a>, then on iPhone turn it on in Settings → General → About → Certificate Trust Settings.</p>
  </section>
  <details>
    <summary>Where do I find a code?</summary>
    <p>On your Mac: SahilBot → Settings → General → Phone access → turn it on. Scan the QR code with the phone’s camera, or type the code here. Codes work once, for 10 minutes.</p>
  </details>` : `  <details>
    <summary>Where do I find a code?</summary>
    <p>On the server: <code>sahilbot-server pair</code> (or <code>journalctl --user -u sahilbot</code> after the first start). From a device that's already paired: Settings → Server → Pair another device. From the Mac app: Settings → Always-on server → Open server UI signs you in directly.</p>
  </details>`}
</main>
<script src="/pair.js"></script>
</body>
</html>
`
}

export const PAIR_CSS = `:root{--bg:#f6f5f3;--card:#fff;--fg:#1f1f1f;--sub:#6b6b6b;--line:#e4e2de;--accent:#ff6a1a;--bad:#d92d20}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--fg:#f2f2f2;--sub:#a0a0a0;--line:#2e2e2e;--bad:#ff6b5e}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px;box-shadow:0 10px 40px rgba(0,0,0,.06)}
.logo{display:flex;justify-content:center;margin-bottom:8px}h1{font-size:22px;text-align:center;margin:4px 0}
.sub{color:var(--sub);text-align:center;margin:0 0 20px}label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}.opt{color:var(--sub);font-weight:400}
input{width:100%;font:inherit;font-size:17px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:transparent;color:inherit}
#code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;font-size:20px;text-align:center}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{margin-top:18px;width:100%;font:inherit;font-weight:600;font-size:16px;padding:13px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}.msg{min-height:1.4em;margin:12px 0 0;color:var(--bad);text-align:center}.msg.ok{color:inherit}
details{margin-top:18px;color:var(--sub);font-size:13px}summary{cursor:pointer}code{font-size:12px}
.fp{margin-top:18px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:13px;color:var(--sub)}.fp p{margin:0 0 8px}.fp p:last-child{margin:0}.fp b{color:var(--fg)}
.fp code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--fg);letter-spacing:.04em}.fp a{color:var(--accent);font-weight:600}
`

export const PAIR_JS = `(function(){
  var form=document.getElementById('pair'),code=document.getElementById('code'),name=document.getElementById('name'),msg=document.getElementById('msg'),go=document.getElementById('go');
  function say(t,ok){msg.textContent=t;msg.className=ok?'msg ok':'msg'}
  var m=/[#&]code=([A-Za-z0-9-]+)/.exec(location.hash);
  var bot=/(?:^|[#&])bot=([0-9a-f-]{36})(?:&|$)/.exec(location.hash);
  var f=/[#&]fp=([0-9A-Fa-f]{8,64})/.exec(location.hash),fp=document.getElementById('fp');
  if(f&&fp){document.getElementById('fp-value').textContent=f[1].toUpperCase().replace(/(.{4})(?=.)/g,'$1 ');fp.hidden=false}
  if(m){code.value=m[1];history.replaceState(null,'',location.pathname)}
  form.addEventListener('submit',function(e){
    e.preventDefault();go.disabled=true;say('Pairing…',true);
    fetch('/api/pair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value,name:name.value})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{r:r,j:j}})})
      .then(function(x){
        if(x.r.ok){say('Paired. Opening SahilBot…',true);location.replace(bot?'/?bot='+bot[1]:'/');return}
        go.disabled=false;
        if(x.r.status===429)say('Too many tries. Wait '+Math.ceil((x.j.retryAfter||60)/60)+' min and try again.');
        else say(x.j.error||'That code didn’t work. Check it, or make a new one on the server.');
      })
      .catch(function(){go.disabled=false;say('Couldn’t reach the server.')});
  });
  // The Mac's link also carries the certificate check: the person reads it, then pairs with one tap.
  if(m&&!(f&&fp))form.requestSubmit?form.requestSubmit():go.click();
})();
`

/** The app icon (SahilBot orange squircle). */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#ff6a1a"/><path d="M14 36a18 18 0 0 1 36 0z" fill="#fff"/><rect x="10" y="35" width="44" height="6" rx="3" fill="#fff"/><rect x="29" y="15" width="6" height="10" rx="2" fill="#ff6a1a"/><circle cx="25" cy="48" r="3" fill="#fff"/><circle cx="39" cy="48" r="3" fill="#fff"/></svg>`

export const MANIFEST = JSON.stringify({
  name: 'SahilBot',
  short_name: 'SahilBot',
  start_url: '/',
  display: 'standalone',
  background_color: '#161616',
  theme_color: '#ff6a1a',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
})

/** Web Push: shows the notification and opens the chat on a tap. The push payload is all it shows (no fetches). */
export const SERVICE_WORKER = `self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('push',function(e){
  var d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'SahilBot',body:e.data&&e.data.text()}}
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    if(cs.some(function(c){return c.visibilityState==='visible'}))return;
    return self.registration.showNotification(d.title||'SahilBot',{body:d.body||'',tag:d.tag||undefined,icon:'/icon.svg',badge:'/icon.svg',data:{threadId:d.threadId||''}});
  }));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();var t=e.notification.data&&e.notification.data.threadId;var url=t?'/?thread='+encodeURIComponent(t):'/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){if('focus' in cs[i]){cs[i].postMessage({type:'open-thread',threadId:t});return cs[i].focus()}}
    return self.clients.openWindow(url);
  }));
});
`

const R = 'html[data-runtime=server]'

/**
 * Phone and narrow-window layout for the web UI (served by SahilBot Server and by the Mac's Phone access;
 * the Mac window never gets this narrow). The sidebar becomes a drawer behind a menu button (the bridge
 * adds it), the composer stays at the bottom above the keyboard and the home indicator, approval,
 * purchase and Needs-you buttons are thumb-sized, panels and Settings take the whole screen, and the
 * app's own colour tokens are used throughout.
 */
export const MOBILE_CSS = `${R},${R} body{height:100%;overscroll-behavior:none}
${R} body{height:100dvh}
.sb-menu-btn{display:none}
/* Mac-only controls: dictation and voice (this Mac's microphone and local speech models), region screenshots, the
   built-in browser, computer use, the global Quick Ask shortcut. */
${R} [data-testid="dictate"],${R} [data-testid="voice-btn"],${R} [data-testid="attach-screenshot"],
${R} [data-testid="tab-browser"],${R} [data-testid="computer-use-row"],${R} [data-testid="computer-use-executor-row"],
${R} .set-row:has([data-testid="quick-key"]){display:none!important}
${R}:has(.settings-page) .sb-menu-btn{display:none!important}
/* A phone using the Mac: the browser runs on the Mac's screen, so its header button has nothing to open here. */
${R}[data-host=mac] [data-testid="toggle-browser"]{display:none!important}
@media (max-width:${LAYOUT.tablet}px){
  ${R} .app{height:100dvh}
  ${R} .app>.right{position:fixed;inset:0;z-index:55;width:100%!important;min-width:0!important;max-width:none!important;border-left:0;padding-top:env(safe-area-inset-top)}
}
@media (max-width:${LAYOUT.phone}px){
  ${R} .app{position:relative;overflow:hidden;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
  ${R} .sidebar{position:fixed;z-index:60;left:0;top:0;bottom:0;width:min(86vw,320px);transform:translateX(-102%);visibility:hidden;transition:transform .22s ease-out,visibility 0s linear .22s;box-shadow:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  ${R}.sb-drawer .sidebar{transform:none;visibility:visible;transition:transform .22s ease-out;box-shadow:0 0 40px rgba(0,0,0,.25)}
  ${R}.sb-drawer .sb-scrim{position:fixed;inset:0;z-index:59;background:rgba(0,0,0,.32)}
  ${R} .main{width:100%;min-width:0;flex:1 1 auto;height:100dvh}
  ${R} .main-header{padding-left:56px;padding-right:10px;padding-top:env(safe-area-inset-top);height:calc(52px + env(safe-area-inset-top))}
  ${R} .sb-menu-btn{display:grid;place-items:center;position:fixed;z-index:58;left:calc(8px + env(safe-area-inset-left));top:calc(8px + env(safe-area-inset-top));width:${TAP_PX}px;height:${TAP_PX}px;border-radius:12px;border:1px solid var(--line);background:var(--panel,var(--bg));color:var(--text);cursor:pointer;padding:0}
  ${R}.sb-drawer .sb-menu-btn{display:none}
  /* The composer: pinned to the bottom of the chat, above the home indicator; 16px text so iOS doesn't zoom. */
  ${R} .thread-scroll{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  ${R} .composer-wrap{position:sticky;bottom:0;z-index:5;margin-top:0;padding:6px 10px calc(10px + env(safe-area-inset-bottom));background:var(--bg)}
  ${R} .composer textarea{font-size:16px}
  ${R} .composer button{min-width:${TAP_PX - 8}px;min-height:${TAP_PX - 8}px}
  /* Approval, purchase, one-time-code and Needs-you cards: full width, big buttons a thumb can hit. */
  ${R} .pending{max-width:none;padding:14px}
  ${R} .pending-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  ${R} .pending-actions .btn{min-height:${TAP_PX}px;font-size:15px;justify-content:center;white-space:normal;text-align:center}
  ${R} .pending-actions .btn.primary,${R} .pending-actions .link-btn{grid-column:1/-1}
  ${R} .pending-actions .link-btn{min-height:${TAP_PX - 8}px}
  ${R} .ny-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  ${R} .ny-actions .btn{min-height:${TAP_PX}px;font-size:15px;justify-content:center}
  ${R} .ny-actions .btn.primary,${R} .ny-open{grid-column:1/-1;margin-left:0}
  ${R} .ny-option{min-height:${TAP_PX}px}
  ${R} .ny-own input,${R} .pending-answer input{font-size:16px;min-height:${TAP_PX}px}
  ${R} .settings-win{flex-direction:column;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important}
  ${R} .settings-page{padding:0!important}
  ${R} .set-nav{width:100%;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;padding:calc(8px + env(safe-area-inset-top)) 8px 8px;border-right:0;border-bottom:1px solid var(--line);gap:4px}
  ${R} .set-nav-item{flex:none;white-space:nowrap;min-height:${TAP_PX - 8}px}
  ${R} .set-nav-foot,${R} .set-find{display:none}
  ${R} .set-body{flex:1;min-height:0;overflow:auto;padding:12px 12px calc(12px + env(safe-area-inset-bottom))!important}
  ${R} .set-row{flex-wrap:wrap;gap:8px}
  ${R} .set-input,${R} .set-select{font-size:16px}
  ${R} .modal{width:calc(100vw - 20px)!important;max-width:none!important;max-height:calc(100dvh - 20px);overflow:auto}
  ${R} .cards{grid-template-columns:1fr}
  ${R} .ny-card,${R} [data-testid="approval-card"],${R} .bubble{overflow-wrap:anywhere}
  ${R} .field{grid-template-columns:1fr}
  /* Toasts sit under the header on a phone, never over the composer and its Stop button. */
  ${R} .sb-server-toasts{top:calc(60px + env(safe-area-inset-top))!important;bottom:auto!important}
}
`

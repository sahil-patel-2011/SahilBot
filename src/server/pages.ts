// The few pages SahilBot Server serves itself: pairing, the service worker (Web Push), the web manifest.
// No inline scripts or styles (the CSP forbids them); everything is a same-origin file.

export const PAIR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Pair with SahilBot Server</title>
<link rel="stylesheet" href="/pair.css">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
</head>
<body>
<main class="card">
  <div class="logo" aria-hidden="true"><img src="/icon.svg" alt="" width="56" height="56"></div>
  <h1>SahilBot Server</h1>
  <p class="sub">Enter the pairing code the server showed you. You only do this once on each device.</p>
  <form id="pair" autocomplete="off">
    <label for="code">Pairing code</label>
    <input id="code" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" maxlength="16" required data-testid="pair-code">
    <label for="name">Name this device <span class="opt">(optional)</span></label>
    <input id="name" name="name" maxlength="60" placeholder="My phone" data-testid="pair-name">
    <button type="submit" id="go" data-testid="pair-submit">Pair this device</button>
    <p id="msg" role="alert" class="msg"></p>
  </form>
  <details>
    <summary>Where do I find a code?</summary>
    <p>On the server: <code>sahilbot-server pair</code> (or <code>journalctl --user -u sahilbot</code> after the first start). From a device that's already paired: Settings → Server → Pair another device. From the Mac app: Settings → Always-on server → Open server UI signs you in directly.</p>
  </details>
</main>
<script src="/pair.js"></script>
</body>
</html>
`

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
`

export const PAIR_JS = `(function(){
  var form=document.getElementById('pair'),code=document.getElementById('code'),name=document.getElementById('name'),msg=document.getElementById('msg'),go=document.getElementById('go');
  function say(t,ok){msg.textContent=t;msg.className=ok?'msg ok':'msg'}
  var m=/[#&]code=([A-Za-z0-9-]+)/.exec(location.hash);
  if(m){code.value=m[1];history.replaceState(null,'',location.pathname)}
  form.addEventListener('submit',function(e){
    e.preventDefault();go.disabled=true;say('Pairing…',true);
    fetch('/api/pair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value,name:name.value})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{r:r,j:j}})})
      .then(function(x){
        if(x.r.ok){say('Paired. Opening SahilBot…',true);location.replace('/');return}
        go.disabled=false;
        if(x.r.status===429)say('Too many tries. Wait '+Math.ceil((x.j.retryAfter||60)/60)+' min and try again.');
        else say(x.j.error||'That code didn’t work. Check it, or make a new one on the server.');
      })
      .catch(function(){go.disabled=false;say('Couldn’t reach the server.')});
  });
  if(m)form.requestSubmit?form.requestSubmit():go.click();
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

/**
 * Phone and narrow-window layout for the web UI (served only by SahilBot Server; the Mac window never gets
 * this narrow). The sidebar becomes a drawer behind a menu button (the bridge adds it), panels and Settings
 * take the whole screen, and the app's own colour tokens are used throughout.
 */
export const MOBILE_CSS = `html[data-runtime=server],html[data-runtime=server] body{height:100%;overscroll-behavior:none}
html[data-runtime=server] body{height:100dvh}
.sb-menu-btn{display:none}
/* Mac-only controls: dictation and voice (this Mac's microphone and local speech models), region screenshots, the
   built-in browser, computer use, the global Quick Ask shortcut. */
html[data-runtime=server] [data-testid="dictate"],html[data-runtime=server] [data-testid="voice-btn"],html[data-runtime=server] [data-testid="attach-screenshot"],
html[data-runtime=server] [data-testid="tab-browser"],html[data-runtime=server] [data-testid="computer-use-row"],html[data-runtime=server] [data-testid="computer-use-executor-row"],
html[data-runtime=server] .set-row:has([data-testid="quick-key"]){display:none!important}
html[data-runtime=server]:has(.settings-page) .sb-menu-btn{display:none!important}
@media (max-width:760px){
  html[data-runtime=server] .app{position:relative;overflow:hidden}
  html[data-runtime=server] .sidebar{position:fixed;z-index:60;left:0;top:0;bottom:0;width:min(86vw,320px);transform:translateX(-102%);transition:transform .22s ease-out;box-shadow:0 0 40px rgba(0,0,0,.25);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  html[data-runtime=server].sb-drawer .sidebar{transform:none}
  html[data-runtime=server].sb-drawer .sb-scrim{position:fixed;inset:0;z-index:59;background:rgba(0,0,0,.32)}
  html[data-runtime=server] .main{width:100%;min-width:0;flex:1 1 auto}
  html[data-runtime=server] .main-header{padding-left:56px;padding-right:10px;padding-top:env(safe-area-inset-top);height:calc(52px + env(safe-area-inset-top))}
  html[data-runtime=server] .sb-menu-btn{display:grid;place-items:center;position:fixed;z-index:58;left:8px;top:calc(8px + env(safe-area-inset-top));width:40px;height:40px;border-radius:12px;border:1px solid var(--line);background:var(--panel,var(--bg));color:var(--text);cursor:pointer;padding:0}
  html[data-runtime=server].sb-drawer .sb-menu-btn{display:none}
  html[data-runtime=server] .composer-wrap{padding:6px 10px calc(10px + env(safe-area-inset-bottom))}
  html[data-runtime=server] .composer textarea{font-size:16px}
  html[data-runtime=server] .right{position:fixed;inset:0;z-index:55;width:100%!important;min-width:0!important;max-width:none!important;border-left:0;padding-top:env(safe-area-inset-top)}
  html[data-runtime=server] .settings-win{flex-direction:column;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important}
  html[data-runtime=server] .settings-page{padding:0!important}
  html[data-runtime=server] .set-nav{width:100%;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;padding:calc(8px + env(safe-area-inset-top)) 8px 8px;border-right:0;border-bottom:1px solid var(--line);gap:4px}
  html[data-runtime=server] .set-nav-item{flex:none;white-space:nowrap}
  html[data-runtime=server] .set-nav-foot,html[data-runtime=server] .set-find{display:none}
  html[data-runtime=server] .set-body{flex:1;min-height:0;overflow:auto;padding:12px!important}
  html[data-runtime=server] .set-row{flex-wrap:wrap;gap:8px}
  html[data-runtime=server] .modal{width:calc(100vw - 20px)!important;max-width:none!important;max-height:calc(100dvh - 20px);overflow:auto}
  html[data-runtime=server] .cards{grid-template-columns:1fr}
  html[data-runtime=server] .ny-card,html[data-runtime=server] [data-testid="approval-card"],html[data-runtime=server] .bubble{overflow-wrap:anywhere}
  html[data-runtime=server] .field{grid-template-columns:1fr}
}
`

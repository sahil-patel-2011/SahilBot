// The teammate's page (/team): join with the owner's one-time code, then a simple "Ask" chat whose
// answers come only from what the owner shared, with source chips. No inline scripts or styles (the CSP
// forbids them); everything it shows is set with textContent, never as HTML.

export function teamHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Ask the brain</title>
<link rel="stylesheet" href="/team/app.css">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
</head>
<body>
<main id="join" class="card" hidden data-testid="team-join">
  <div class="logo" aria-hidden="true"><img src="/icon.svg" alt="" width="48" height="48"></div>
  <h1>Join your team’s brain</h1>
  <p class="sub">Enter the code you were sent. You can ask about what the owner shared with you; you can’t see or change anything else.</p>
  <form id="join-form" autocomplete="off">
    <label for="code">Invite code</label>
    <input id="code" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" maxlength="16" required data-testid="team-code">
    <button type="submit" id="join-go" data-testid="team-join-submit">Join</button>
    <p id="join-msg" role="alert" class="msg"></p>
  </form>
</main>
<div id="app" class="app" hidden data-testid="team-ask">
  <header class="top">
    <div><b id="who">Ask</b><span id="role" class="role"></span></div>
    <button id="logout" class="link" type="button">Sign out</button>
  </header>
  <section id="list" class="list" aria-live="polite"></section>
  <p id="empty" class="empty">Ask about clients, deals, meetings and promises, like “What did we promise Partner B?”. Answers cite where they came from. Anything the brain can’t answer goes to the owner.</p>
  <form id="ask-form" class="ask" autocomplete="off">
    <input id="q" maxlength="500" placeholder="Ask the brain…" required data-testid="team-question">
    <button type="submit" id="ask-go" data-testid="team-ask-submit">Ask</button>
  </form>
</div>
<script src="/team/app.js"></script>
</body>
</html>
`
}

export const TEAM_CSS = `:root{--bg:#f6f5f3;--card:#fff;--fg:#1f1f1f;--sub:#6b6b6b;--line:#e4e2de;--accent:#ff6a1a;--chip:#f1efeb;--bad:#d92d20}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--fg:#f2f2f2;--sub:#a0a0a0;--line:#2e2e2e;--chip:#262626;--bad:#ff6b5e}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
[hidden]{display:none!important}
.card{max-width:400px;margin:10vh auto 0;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px}
.logo{display:flex;justify-content:center}h1{font-size:21px;text-align:center;margin:8px 0 4px}.sub{color:var(--sub);text-align:center;margin:0 0 18px}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 6px}
input{width:100%;font:inherit;font-size:16px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:transparent;color:inherit}
#code{font-family:ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;text-align:center;font-size:19px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{font:inherit;font-weight:600;padding:12px 16px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
button[disabled]{opacity:.6}.card button{width:100%;margin-top:16px}.msg{min-height:1.4em;color:var(--bad);text-align:center;margin:10px 0 0}
.link{background:none;color:var(--sub);font-weight:500;padding:6px}
.app{max-width:720px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;padding:0 16px calc(12px + env(safe-area-inset-bottom))}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
.role{color:var(--sub);margin-left:8px;font-size:13px}
.list{flex:1;display:flex;flex-direction:column;gap:14px;padding:16px 0}
.empty{color:var(--sub);text-align:center;margin:24px 8px}
.q{align-self:flex-end;background:var(--accent);color:#fff;padding:9px 13px;border-radius:16px 16px 4px 16px;max-width:85%;white-space:pre-wrap}
.a{align-self:flex-start;background:var(--card);border:1px solid var(--line);padding:11px 14px;border-radius:16px 16px 16px 4px;max-width:92%;white-space:pre-wrap}
.a.routed{border-style:dashed;color:var(--sub)}.a .owner{margin-top:8px;padding-top:8px;border-top:1px solid var(--line);color:var(--fg)}
.a .owner b{display:block;font-size:12px;color:var(--sub);margin-bottom:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:12px;background:var(--chip);border-radius:999px;padding:3px 9px;color:var(--fg);text-decoration:none}
a.chip:hover{text-decoration:underline}
.ask{display:flex;gap:8px;position:sticky;bottom:0;background:var(--bg);padding:10px 0}.ask input{flex:1}
`

export const TEAM_JS = `(function(){
  var csrf='',busy=false;
  function $(id){return document.getElementById(id)}
  function api(path,body){return fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json','x-sahilbot-csrf':csrf}:{},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){j.__status=r.status;return j})})}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function chips(list){var w=el('div','chips');(list||[]).forEach(function(c){var safe=c.link&&/^https?:\\/\\//i.test(c.link);var x=el(safe?'a':'span','chip',c.label||c.kind||'source');if(safe){x.href=c.link;x.target='_blank';x.rel='noopener noreferrer'}if(c.title)x.title=c.title;w.appendChild(x)});return w}
  function render(qs){var list=$('list');list.textContent='';$('empty').hidden=qs.length>0;qs.slice().reverse().forEach(function(q){
    list.appendChild(el('div','q',q.question));
    var a=el('div','a'+(q.status==='routed'?' routed':''));
    a.appendChild(el('div','',q.answer||''));
    if(q.ownerAnswer){var o=el('div','owner');o.appendChild(el('b','','Answered by the owner'));o.appendChild(el('div','',q.ownerAnswer));a.appendChild(o)}
    if(q.chips&&q.chips.length)a.appendChild(chips(q.chips));
    list.appendChild(a)});window.scrollTo(0,document.body.scrollHeight)}
  function start(){api('/team/api/session').then(function(j){
    if(j.__status!==200){$('join').hidden=false;$('app').hidden=true;var m=/[#&]code=([A-Za-z0-9-]+)/.exec(location.hash);if(m){$('code').value=decodeURIComponent(m[1]);try{window.history.replaceState(null,'',location.pathname)}catch(_){}}return}
    csrf=j.csrf;$('who').textContent=j.member.name;$('role').textContent=j.member.role+' · asking '+(j.owner||'the owner')+'’s brain';
    $('join').hidden=true;$('app').hidden=false;refresh();setInterval(refresh,20000)})}
  $('join-form').addEventListener('submit',function(e){e.preventDefault();$('join-go').disabled=true;$('join-msg').textContent='';
    fetch('/team/api/join',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('code').value})}).then(function(r){return r.json().then(function(j){
      $('join-go').disabled=false;if(r.status===200){start()}else{$('join-msg').textContent=j.error||'That code didn’t work.'}})}).catch(function(){$('join-go').disabled=false;$('join-msg').textContent='Couldn’t reach the server.'})});
  $('ask-form').addEventListener('submit',function(e){e.preventDefault();if(busy)return;var q=$('q').value.trim();if(!q)return;busy=true;$('ask-go').disabled=true;
    api('/team/api/ask',{question:q}).then(function(j){busy=false;$('ask-go').disabled=false;if(j.__status===200){$('q').value='';refresh()}else{alert(j.error||'Something went wrong.')}}).catch(function(){busy=false;$('ask-go').disabled=false})});
  function refresh(){api('/team/api/history').then(function(j){if(j.__status===200)render(j.questions||[])})}
  $('logout').addEventListener('click',function(){api('/team/api/logout',{}).then(function(){location.reload()})});
  start();
})();
`

import { app, BrowserWindow, nativeTheme, session, shell, WebContentsView } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PageInfo, PagePanelStatus } from '@shared/types'
import type { ToolDef } from '../types'

// Pages: self-contained interactive HTML (reports, dashboards, charts, calculators) the agent builds and
// the user sees beside the chat. Every page is locked down in layers:
//  1. a strict CSP <meta> written into the file (no network, no remote code),
//  2. the same CSP plus `sandbox allow-scripts` sent as a response header when the pages session serves it
//     (so a page edited by hand or by file_write is still locked down; opaque origin, no app storage),
//  3. its own session and webContents, never the app window (no window.foreman): a native view in the
//     side panel, a window, or a hidden renderer for PDF/thumbnails, where only page files load, top-level
//     navigation is limited to other pages, and WebRTC is removed and has no route out (see pageSession).

export const MAX_PAGE_BYTES = 2_000_000
const MAX_TITLE = 120
const SCHEME = 'foreman-file'
/** Marks where the agent's own HTML starts inside a saved page (everything above is ours). */
const CONTENT_MARK = '<!-- sb:content -->'

/** No network of any kind: only inline code and styles, and data:/blob: images, fonts and media. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

// ---------------------------------------------------------------- names and paths

/** One line of plain text: no control or bidi-override characters, collapsed spaces, at most 120 chars. */
export function cleanTitle(t: unknown): string {
  const s = String(t ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1).trimEnd()}…` : s) || 'Untitled page'
}

/** A safe file name stem: lowercase ascii letters, digits and dashes. */
export function slugify(t: string): string {
  const s = t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  return s || 'page'
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const realOr = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p))

/** The pages folder (created if needed), as a real path. */
export function pagesRoot(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

/**
 * Resolves a page path the agent gave to a file directly inside the pages folder. Accepts a bare name
 * ("q3.html"), "pages/q3.html", or an absolute path that is inside the folder; refuses sub-folders,
 * `..`, hidden names, symlinks, and anything outside.
 */
export function pageFile(dir: string, p: string): string {
  const root = pagesRoot(dir)
  let name = String(p ?? '').trim()
  if (!name) throw new Error('Give the page a file name, like "q3-report.html".')
  if (isAbsolute(name) || name.startsWith('~')) {
    const full = resolve(name.startsWith('~/') ? join(homedir(), name.slice(2)) : name)
    if (realOr(dirname(full)) !== root) throw new Error(`"${p}" is outside the pages folder (${root}). Pages can only be saved there.`)
    name = basename(full)
  } else {
    name = name.replace(/^\.[\\/]/, '').replace(/^pages[\\/]/i, '')
    if (/[\\/]/.test(name)) throw new Error(`"${p}" points into a folder. A page path is just a file name in the pages folder, like "q3-report.html".`)
  }
  if (!/\.html?$/i.test(name)) name += '.html'
  // eslint-disable-next-line no-control-regex
  if (name.startsWith('.') || /[\u0000-\u001f:]/.test(name)) throw new Error(`"${p}" is not a valid page file name.`)
  if (name.length > 120) throw new Error('That page file name is too long.')
  const full = join(root, name)
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new Error(`"${name}" is a link; pages must be real files in the pages folder.`)
  return full
}

/** True for an existing .html file directly inside the pages folder (not a link). */
export function isPagePath(dir: string, p: string): boolean {
  try {
    if (!p || !/\.html?$/i.test(p) || !existsSync(p) || !existsSync(dir)) return false
    const full = resolve(p)
    return !lstatSync(full).isSymbolicLink() && lstatSync(full).isFile() && realpathSync(dirname(full)) === realpathSync(dir)
  } catch {
    return false
  }
}

/** A free file name for a new page: "<slug>.html", then "<slug>-2.html"… */
function freshFile(dir: string, title: string): string {
  const root = pagesRoot(dir)
  const stem = slugify(title)
  for (let i = 1; i < 1000; i++) {
    const full = join(root, `${stem}${i === 1 ? '' : `-${i}`}.html`)
    if (!existsSync(full)) return full
  }
  return join(root, `${stem}-${Date.now()}.html`)
}

// ---------------------------------------------------------------- the page document

const BASE_CSS = `
:root{color-scheme:light dark;--sb-bg:#ffffff;--sb-fg:#1c1c1e;--sb-muted:#6e6e73;--sb-border:#e5e5ea;--sb-card:#f7f7f8;--sb-accent:#2563eb;--sb-up:#15803d;--sb-down:#dc2626;--sb-grid:#ececf0;
--sb-c1:#2563eb;--sb-c2:#f59e0b;--sb-c3:#10b981;--sb-c4:#ef4444;--sb-c5:#8b5cf6;--sb-c6:#06b6d4;--sb-c7:#ec4899;--sb-c8:#84cc16;--sb-radius:12px;
font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55}
@media (prefers-color-scheme:dark){:root{--sb-bg:#161618;--sb-fg:#ececf0;--sb-muted:#9a9aa2;--sb-border:#2e2e33;--sb-card:#1f1f23;--sb-accent:#60a5fa;--sb-up:#4ade80;--sb-down:#f87171;--sb-grid:#2a2a2f;
--sb-c1:#60a5fa;--sb-c2:#fbbf24;--sb-c3:#34d399;--sb-c4:#f87171;--sb-c5:#a78bfa;--sb-c6:#22d3ee;--sb-c7:#f472b6;--sb-c8:#a3e635}}
@media print{:root{color-scheme:light;--sb-bg:#fff;--sb-fg:#111;--sb-muted:#555;--sb-border:#ddd;--sb-card:#f6f6f6;--sb-grid:#e5e5e5}
.slide{break-after:page;min-height:auto}.no-print{display:none!important}.card,.kpi,table,figure,.sb-chart{break-inside:avoid}}
*,*::before,*::after{box-sizing:border-box}
html,body{background:var(--sb-bg);color:var(--sb-fg)}
body{margin:0 auto;padding:28px 24px 48px;max-width:1120px;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em;font-weight:650;letter-spacing:-.01em}
h1{font-size:1.9rem;margin-top:.2em}h2{font-size:1.35rem}h3{font-size:1.1rem}
p{margin:.6em 0}a{color:var(--sb-accent)}small,.muted{color:var(--sb-muted)}
hr{border:0;border-top:1px solid var(--sb-border);margin:24px 0}
code,pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.88em}
pre{background:var(--sb-card);border:1px solid var(--sb-border);border-radius:8px;padding:12px;overflow:auto}
img,svg{max-width:100%}
.card{background:var(--sb-card);border:1px solid var(--sb-border);border-radius:var(--sb-radius);padding:16px 18px;margin:12px 0}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:14px 0}
.grid>.card{margin:0}.grid-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.grid-3{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:10px}.spacer{flex:1}
.kpi{background:var(--sb-card);border:1px solid var(--sb-border);border-radius:var(--sb-radius);padding:14px 16px}
.kpi .label{font-size:.8rem;color:var(--sb-muted);text-transform:uppercase;letter-spacing:.04em}
.kpi .value{font-size:1.8rem;font-weight:700;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
.delta,.up,.down{font-size:.85rem;font-weight:600}.up,.delta.up{color:var(--sb-up)}.down,.delta.down{color:var(--sb-down)}
.badge,.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.78rem;font-weight:600;background:color-mix(in srgb,var(--sb-accent) 14%,transparent);color:var(--sb-accent)}
.badge.good{background:color-mix(in srgb,var(--sb-up) 16%,transparent);color:var(--sb-up)}.badge.bad{background:color-mix(in srgb,var(--sb-down) 16%,transparent);color:var(--sb-down)}
.callout{border-left:4px solid var(--sb-accent);background:var(--sb-card);border-radius:8px;padding:12px 16px;margin:14px 0}
.callout.warn{border-color:var(--sb-c2)}.callout.good{border-color:var(--sb-up)}.callout.bad{border-color:var(--sb-down)}
.bar{height:8px;border-radius:99px;background:var(--sb-grid);overflow:hidden}.bar>i{display:block;height:100%;background:var(--sb-accent);border-radius:99px}
.slide{min-height:88vh;display:flex;flex-direction:column;justify-content:center;padding:32px 8px;border-bottom:1px solid var(--sb-border)}
.slide h1{font-size:2.4rem}.slide:last-child{border-bottom:0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-variant-numeric:tabular-nums;font-size:.93rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--sb-border);vertical-align:top}
th{font-weight:600;color:var(--sb-muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
tbody tr:hover{background:var(--sb-card)}td.num,th.num{text-align:right}
.table-wrap{overflow-x:auto}
th[data-sort]{cursor:pointer;user-select:none}th[data-sort]::after{content:" \\2195";opacity:.35}
th[aria-sort=ascending]::after{content:" \\2191";opacity:1}th[aria-sort=descending]::after{content:" \\2193";opacity:1}
button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--sb-accent);color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer}
button.secondary{background:var(--sb-card);color:var(--sb-fg);border:1px solid var(--sb-border)}
input,select,textarea{background:var(--sb-bg);border:1px solid var(--sb-border);border-radius:8px;padding:7px 10px}
input[type=range]{padding:0;accent-color:var(--sb-accent)}
label{display:block;font-size:.85rem;color:var(--sb-muted);margin:8px 0 4px}
.sb-chart{margin:12px 0;width:100%}.sb-chart-title{font-weight:600;margin-bottom:6px}
.sb-chart svg{display:block;width:100%;height:auto;overflow:visible}
.sb-chart text{fill:var(--sb-muted);font-size:11px}
.sb-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:.82rem;color:var(--sb-muted)}
.sb-legend span{display:inline-flex;align-items:center;gap:6px}.sb-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
@media (max-width:560px){body{padding:18px 14px 36px}h1{font-size:1.5rem}.kpi .value{font-size:1.45rem}}
`

// The helper library every page gets: window.sb.chart / sb.table / sb.fmt. Plain ES5-ish JS, DOM APIs
// only (no innerHTML), so data from the page can't inject markup.
const SB_LIB = `
(function(){'use strict';
try{window.localStorage}catch(e){try{var mem={},st={getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null},setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},clear:function(){mem={}},key:function(i){return Object.keys(mem)[i]||null}};Object.defineProperty(st,'length',{get:function(){return Object.keys(mem).length}});Object.defineProperty(window,'localStorage',{value:st,configurable:true});Object.defineProperty(window,'sessionStorage',{value:st,configurable:true})}catch(e2){}}
var NS='http://www.w3.org/2000/svg';
var COLORS=['var(--sb-c1)','var(--sb-c2)','var(--sb-c3)','var(--sb-c4)','var(--sb-c5)','var(--sb-c6)','var(--sb-c7)','var(--sb-c8)'];
function $(x){var el=typeof x==='string'?document.querySelector(x):x;if(!el)throw new Error('sb: element not found: '+x);return el}
function h(tag,attrs,parent,text){var el=document.createElement(tag);if(attrs)for(var k in attrs)el.setAttribute(k,attrs[k]);if(text!=null)el.textContent=String(text);if(parent)parent.appendChild(el);return el}
function s(tag,attrs,parent,text){var el=document.createElementNS(NS,tag);if(attrs)for(var k in attrs){if(k==='fill'||k==='stroke')el.style.setProperty(k,attrs[k]);else el.setAttribute(k,attrs[k])}if(text!=null)el.textContent=String(text);if(parent)parent.appendChild(el);return el}
function num(v){if(typeof v==='number')return v;if(v==null||v==='')return NaN;var t=String(v).replace(/[$,%\\s\\u00a3\\u20ac]/g,'');return t===''?NaN:Number(t)}
function fmt(n,o){o=o||{};if(typeof n!=='number'||!isFinite(n))return n==null?'':String(n);var opt={maximumFractionDigits:o.digits!=null?o.digits:(Math.abs(n)<10&&n%1?2:Math.abs(n)<1000&&n%1?1:0)};if(o.digits!=null)opt.minimumFractionDigits=o.digits;
if(o.style==='currency'){opt={style:'currency',currency:o.currency||'USD'};if(o.digits!=null){opt.minimumFractionDigits=opt.maximumFractionDigits=o.digits}else if(n%1===0){opt.minimumFractionDigits=opt.maximumFractionDigits=0}}else if(o.style==='percent'){opt.style='percent';if(o.digits==null)opt.maximumFractionDigits=1}
if(o.compact){opt.notation='compact';opt.maximumFractionDigits=1}try{return new Intl.NumberFormat(o.locale||undefined,opt).format(n)}catch(e){return String(n)}}
function ticks(min,max,count){if(min===max){max=min+1}var span=max-min,step=Math.pow(10,Math.floor(Math.log10(span/count))),err=count/(span/step);if(err<=.15)step*=10;else if(err<=.35)step*=5;else if(err<=.75)step*=2;
var lo=Math.floor(min/step)*step,hi=Math.ceil(max/step)*step,out=[];for(var v=lo;v<=hi+step/2;v+=step)out.push(Math.round(v/step)*step);return out}
function norm(spec){spec=spec||{};var series=spec.series;if(!series&&spec.values)series=[{name:spec.name||'',values:spec.values}];series=(series||[]).map(function(x,i){if(Array.isArray(x))x={values:x};return{name:x.name==null?'Series '+(i+1):String(x.name),values:(x.values||[]).map(num),color:x.color||COLORS[i%COLORS.length]}});
var n=0;series.forEach(function(x){n=Math.max(n,x.values.length)});var labels=(spec.labels||[]).map(String);while(labels.length<n)labels.push(String(labels.length+1));
return{type:String(spec.type||'bar').toLowerCase(),labels:labels,series:series,title:spec.title,height:spec.height,stacked:!!spec.stacked,area:!!spec.area,format:spec.format||{},legend:spec.legend}}
function legend(box,items){var lg=h('div',{'class':'sb-legend'},box);items.forEach(function(it){var sp=h('span',null,lg);var sw=h('i',null,sp);sw.style.background=it.color;sp.appendChild(document.createTextNode(it.name))})}
function axes(svg,W,H,P,lo,hi,yt,f){var y=function(v){return P.t+(H-P.t-P.b)*(1-(v-lo)/(hi-lo||1))};yt.forEach(function(v){var yy=y(v);s('line',{x1:P.l,x2:W-P.r,y1:yy,y2:yy,stroke:'var(--sb-grid)','stroke-width':1},svg);s('text',{x:P.l-8,y:yy+4,'text-anchor':'end'},svg,fmt(v,f))});return y}
function xlabels(svg,labels,xc,H,P,W){var every=Math.max(1,Math.ceil(labels.length*58/(W-P.l-P.r)));labels.forEach(function(l,i){if(i%every)return;var t=l.length>14?l.slice(0,13)+'\\u2026':l;s('text',{x:xc(i),y:H-P.b+16,'text-anchor':'middle'},svg,t)})}
function draw(box,c){box.textContent='';if(c.title)h('div',{'class':'sb-chart-title'},box,c.title);var W=Math.max(260,Math.round(box.clientWidth||640));var pie=c.type==='pie'||c.type==='donut';
var H=c.height||Math.round(Math.min(380,Math.max(200,W*(pie?.6:.5))));var svg=s('svg',{viewBox:'0 0 '+W+' '+H,role:'img','aria-label':c.title||c.type+' chart'},box);
if(pie){var vals=(c.series[0]||{values:[]}).values.map(function(v){return isFinite(v)&&v>0?v:0});var total=vals.reduce(function(a,b){return a+b},0)||1;var R=Math.min(W,H)/2-8,cx=W/2,cy=H/2,r0=c.type==='donut'?R*.58:0,a=-Math.PI/2;
var cols=c.series[0]&&c.series.length>1?c.series.map(function(x){return x.color}):null;var items=[];
vals.forEach(function(v,i){var col=(cols&&cols[i])||COLORS[i%COLORS.length];var name=c.labels[i]||String(i+1);items.push({name:name+' \\u00b7 '+fmt(v/total,{style:'percent'}),color:col});if(!v)return;var a2=a+v/total*Math.PI*2;
var p;if(v>=total){p='M'+(cx-R)+' '+cy+'A'+R+' '+R+' 0 1 1 '+(cx+R)+' '+cy+'A'+R+' '+R+' 0 1 1 '+(cx-R)+' '+cy+(r0?'M'+(cx-r0)+' '+cy+'A'+r0+' '+r0+' 0 1 0 '+(cx+r0)+' '+cy+'A'+r0+' '+r0+' 0 1 0 '+(cx-r0)+' '+cy:'')+'Z'}
else{var big=a2-a>Math.PI?1:0,x1=cx+R*Math.cos(a),y1=cy+R*Math.sin(a),x2=cx+R*Math.cos(a2),y2=cy+R*Math.sin(a2);
p=r0?'M'+x1+' '+y1+'A'+R+' '+R+' 0 '+big+' 1 '+x2+' '+y2+'L'+(cx+r0*Math.cos(a2))+' '+(cy+r0*Math.sin(a2))+'A'+r0+' '+r0+' 0 '+big+' 0 '+(cx+r0*Math.cos(a))+' '+(cy+r0*Math.sin(a))+'Z':'M'+cx+' '+cy+'L'+x1+' '+y1+'A'+R+' '+R+' 0 '+big+' 1 '+x2+' '+y2+'Z'}
var path=s('path',{d:p,fill:col,stroke:'var(--sb-bg)','stroke-width':2},svg);s('title',null,path,name+': '+fmt(v,c.format)+' ('+fmt(v/total,{style:'percent'})+')');a=a2});
if(c.legend!==false)legend(box,items);return}
var P={t:10,r:12,b:30,l:12};var all=[];var stacked=c.stacked&&c.type==='bar';
if(stacked){c.labels.forEach(function(_,i){var pos=0,neg=0;c.series.forEach(function(x){var v=x.values[i];if(isFinite(v)){if(v>=0)pos+=v;else neg+=v}});all.push(pos,neg)})}else c.series.forEach(function(x){x.values.forEach(function(v){if(isFinite(v))all.push(v)})});
if(!all.length)all=[0,1];var lo=Math.min.apply(null,all),hi=Math.max.apply(null,all);if(c.type==='bar'||lo>0&&lo<hi*.35)lo=Math.min(0,lo);if(hi<0)hi=0;var yt=ticks(lo,hi,Math.max(3,Math.round(H/60)));lo=yt[0];hi=yt[yt.length-1];
var wl=0;yt.forEach(function(v){wl=Math.max(wl,String(fmt(v,c.format)).length)});P.l=Math.min(90,12+wl*6.5);var y=axes(svg,W,H,P,lo,hi,yt,c.format);var n=c.labels.length||1,iw=W-P.l-P.r;
if(c.type==='line'||c.type==='area'){var xc=function(i){return P.l+(n===1?iw/2:iw*i/(n-1))};xlabels(svg,c.labels,xc,H,P,W);
c.series.forEach(function(x){var pts=[];x.values.forEach(function(v,i){if(isFinite(v))pts.push([xc(i),y(v),v,i])});if(!pts.length)return;
if(c.area||c.type==='area'){var ar=s('path',{d:'M'+pts[0][0]+' '+y(Math.max(lo,0))+pts.map(function(p){return'L'+p[0]+' '+p[1]}).join('')+'L'+pts[pts.length-1][0]+' '+y(Math.max(lo,0))+'Z',fill:x.color},svg);ar.style.opacity='.14'}
s('polyline',{points:pts.map(function(p){return p[0]+','+p[1]}).join(' '),fill:'none',stroke:x.color,'stroke-width':2.25,'stroke-linejoin':'round','stroke-linecap':'round'},svg);
if(pts.length<=60)pts.forEach(function(p){var d=s('circle',{cx:p[0],cy:p[1],r:3.2,fill:x.color,stroke:'var(--sb-bg)','stroke-width':1.5},svg);s('title',null,d,(x.name?x.name+' \\u00b7 ':'')+c.labels[p[3]]+': '+fmt(p[2],c.format))})})}
else{var band=iw/n,gap=Math.min(band*.22,18),k=stacked?1:c.series.length,bw=Math.max(1,(band-gap)/k);var xc2=function(i){return P.l+band*i+band/2};xlabels(svg,c.labels,xc2,H,P,W);var base=y(Math.max(lo,Math.min(0,hi)));
c.labels.forEach(function(l,i){var pos=0,neg=0;c.series.forEach(function(x,j){var v=x.values[i];if(!isFinite(v))return;var x0,y0,y1;
if(stacked){x0=P.l+band*i+gap/2;if(v>=0){y0=y(pos+v);y1=y(pos);pos+=v}else{y0=y(neg);y1=y(neg+v);neg+=v}}else{x0=P.l+band*i+gap/2+bw*j;y0=Math.min(y(v),base);y1=Math.max(y(v),base)}
var r=s('rect',{x:x0,y:y0,width:Math.max(1,bw-(k>1&&!stacked?2:0)),height:Math.max(.5,y1-y0),rx:Math.min(4,bw/4),fill:x.color},svg);s('title',null,r,(c.series.length>1?x.name+' \\u00b7 ':'')+l+': '+fmt(v,c.format))})})}
s('line',{x1:P.l,x2:W-P.r,y1:y(Math.max(lo,Math.min(0,hi))),y2:y(Math.max(lo,Math.min(0,hi))),stroke:'var(--sb-border)','stroke-width':1},svg);
if(c.legend!==false&&(c.series.length>1||c.legend))legend(box,c.series.map(function(x){return{name:x.name,color:x.color}}))}
function chart(target,spec){var el=$(target);var box=el.classList&&el.classList.contains('sb-chart')?el:h('div',{'class':'sb-chart'},el);var c=norm(spec);var lastW=-1;
var render=function(){var w=Math.round(box.clientWidth);if(w===lastW)return;lastW=w;try{draw(box,c)}catch(e){box.textContent='Chart error: '+e.message}};render();
if(window.ResizeObserver){var raf=0;new ResizeObserver(function(){cancelAnimationFrame(raf);raf=requestAnimationFrame(render)}).observe(box)}
return{el:box,update:function(sp){c=norm(sp);lastW=-1;render()}}}
function table(target,rows,opts){var el=$(target);opts=opts||{};rows=rows||[];var head,data;
if(rows.length&&!Array.isArray(rows[0])&&typeof rows[0]==='object'){head=opts.columns||Object.keys(rows[0]);data=rows.map(function(r){return head.map(function(k){return r[k]})})}
else if(opts.header===false){data=rows.slice();head=null}else{head=(rows[0]||[]).map(String);data=rows.slice(1)}
var wrap=h('div',{'class':'table-wrap'},el),t=h('table',{'class':'sb-table'},wrap),tb;var ncol=head?head.length:(data[0]||[]).length;
var numeric=[];for(var j=0;j<ncol;j++){var cnt=0,ok=0;data.forEach(function(r){var v=r[j];if(v!=null&&v!==''){cnt++;if(isFinite(num(v)))ok++}});numeric.push(cnt>0&&ok===cnt)}
var fm=opts.format||{};function cell(v,j){if(typeof v==='number'){var f=Array.isArray(fm)?fm[j]:fm[head?head[j]:j];return fmt(v,f||{})}return v==null?'':String(v)}
function body(){if(tb)t.removeChild(tb);tb=h('tbody',null,t);data.forEach(function(r){var tr=h('tr',null,tb);for(var j=0;j<ncol;j++)h('td',numeric[j]?{'class':'num'}:null,tr,cell(r[j],j))})}
if(head){var tr=h('tr',null,h('thead',null,t));head.forEach(function(name,j){var th=h('th',numeric[j]?{'class':'num','data-sort':'1'}:{'data-sort':'1'},tr,name);if(opts.sortable===false)th.removeAttribute('data-sort');
th.addEventListener('click',function(){if(opts.sortable===false)return;var dir=th.getAttribute('aria-sort')==='ascending'?-1:1;Array.prototype.forEach.call(tr.children,function(x){x.removeAttribute('aria-sort')});th.setAttribute('aria-sort',dir>0?'ascending':'descending');
data.sort(function(a,b){var x=a[j],y=b[j];if(numeric[j]){x=num(x);y=num(y);x=isFinite(x)?x:-Infinity;y=isFinite(y)?y:-Infinity;return(x-y)*dir}return String(x==null?'':x).localeCompare(String(y==null?'':y),undefined,{numeric:true,sensitivity:'base'})*dir});body()})})}
body();return t}
function ready(fn){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn);else fn()}
window.sb={chart:chart,table:table,fmt:fmt,ready:ready,colors:COLORS.slice()};
})();
`

/** Builds the saved page: our locked-down head, then the agent's HTML unchanged after a marker. */
export function buildPage(title: string, html: string): string {
  const t = cleanTitle(title)
  const content = String(html ?? '')
    .replace(/^﻿/, '')
    .replace(/^\s*<!doctype[^>]*>/i, '')
    // A page can't redirect itself anywhere (the frame and window also block navigation).
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="SahilBot Pages">
<title>${escapeHtml(t)}</title>
<style id="sb-base">${BASE_CSS}</style>
<script id="sb-lib">${SB_LIB}</script>
</head>
<body>
${CONTENT_MARK}
${content}
</body>
</html>
`
}

/** The agent's own HTML and title from a saved page (the whole file for pages made some other way). */
export function pageParts(file: string): { title: string; html: string } {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(file)
  const title = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : 'Untitled page'
  const at = file.indexOf(CONTENT_MARK)
  if (at < 0) return { title, html: file }
  const html = file.slice(at + CONTENT_MARK.length).replace(/^\n/, '').replace(/\n?<\/body>\s*<\/html>\s*$/i, '')
  return { title, html }
}

export interface PageEdit { find: string; replace: string; all?: boolean }

/** Find/replace edits; each `find` must match (exactly once unless `all`). */
export function applyEdits(src: string, edits: PageEdit[]): string {
  let out = src
  edits.forEach((e, i) => {
    if (!e.find) throw new Error(`Edit ${i + 1}: "find" is empty.`)
    const n = out.split(e.find).length - 1
    if (n === 0) throw new Error(`Edit ${i + 1}: the text to find wasn't in the page. Read the page with file_read and copy the exact text.`)
    if (n > 1 && !e.all) throw new Error(`Edit ${i + 1}: the text to find appears ${n} times. Include more surrounding text, or set "all": true.`)
    out = e.all ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace)
  })
  return out
}

function checkSize(html: string): void {
  const bytes = Buffer.byteLength(html ?? '')
  if (bytes > MAX_PAGE_BYTES) throw new Error(`The page HTML is ${(bytes / 1e6).toFixed(1)} MB; pages can be at most ${MAX_PAGE_BYTES / 1e6} MB. Use less embedded data (summarize, or drop large images).`)
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- tools

const HELP = `Inline <style>/<script> only: no network, CDNs, remote images or fonts (use inline SVG or data: URIs). localStorage works only for the session.
Built-in light/dark styles: .card .grid(.grid-2/.grid-3) .row .kpi(.label .value .delta.up/.down) .badge(.good/.bad) .callout(.warn/.good/.bad) .bar>i(style="width:40%") .slide (one per screen/PDF page) .muted, styled tables, buttons and inputs. Colors: var(--sb-c1)…(--sb-c8), var(--sb-accent).
Built-in JS (el = element or CSS selector):
- sb.chart(el, {type:'bar'|'line'|'area'|'pie'|'donut', labels:[...], series:[{name, values:[...]}], title?, stacked?, height?, format?:{style:'currency'|'percent', digits?}}) draws an SVG chart.
- sb.table(el, rows, {format?}) renders a sortable table; rows = [[header...], [row...]] or [{col: value}].
- sb.fmt(n, {style?, currency?, digits?, compact?}) formats numbers. sb.ready(fn) runs after load.`

export function pageTools(getDir: () => string): ToolDef[] {
  const createPage: ToolDef<{ title: string; html: string; path?: string }> = {
    name: 'create_page',
    label: 'Page',
    core: false,
    group: 'Pages',
    effect: 'write_local',
    description: `Make a Page: a self-contained interactive HTML page (visual report, dashboard, chart, comparison, calculator, slide-style summary). It opens live beside the chat; the user can open it full-window or export it to PDF. Give a "title" and "html" (body content, or a whole document).
${HELP}
Saved in the pages folder (optional "path": a file name like "q3-sales.html"). Change it later with update_page.`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        html: { type: 'string', description: 'The page body (or a full HTML document) with inline <style> and <script>.' },
        path: { type: 'string', description: 'Optional file name in the pages folder, e.g. "q3-sales.html"' }
      },
      required: ['title', 'html'],
      additionalProperties: false
    },
    async run({ title, html, path }) {
      checkSize(html)
      const dir = getDir()
      const full = path ? pageFile(dir, path) : freshFile(dir, cleanTitle(title))
      if (existsSync(full)) throw new Error(`${basename(full)} already exists. Use update_page to change it, or pick another name.`)
      const doc = buildPage(title, html)
      writeFileSync(full, doc)
      return {
        text: `Created page "${cleanTitle(title)}" at ${full} (${kb(Buffer.byteLength(doc))}). It is open beside the chat. Change it with update_page(path, html or edits).`,
        display: `created ${basename(full)}`,
        path: full
      }
    }
  }

  const updatePage: ToolDef<{ path: string; html?: string; title?: string; edits?: PageEdit[] }> = {
    name: 'update_page',
    label: 'Page',
    core: false,
    group: 'Pages',
    effect: 'write_local',
    description: 'Change a Page made with create_page: give "html" to replace its content, or "edits": [{find, replace, all?}] for small changes (find must match the page\'s own HTML exactly; read it with file_read if unsure). Optional new "title". A copy of the previous version is kept.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The page path create_page returned (or its file name)' },
        html: { type: 'string' },
        title: { type: 'string', maxLength: 200 },
        edits: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: { find: { type: 'string', minLength: 1 }, replace: { type: 'string' }, all: { type: 'boolean' } },
            required: ['find', 'replace'],
            additionalProperties: false
          }
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run({ path, html, title, edits }) {
      const dir = getDir()
      const full = pageFile(dir, path)
      if (!existsSync(full)) throw new Error(`No page called ${basename(full)} in the pages folder. Make it with create_page first.`)
      if (html === undefined && !edits?.length && title === undefined) throw new Error('Give "html", "edits" or "title".')
      const old = readFileSync(full, 'utf8')
      const parts = pageParts(old)
      let content = html ?? parts.html
      if (edits?.length) content = applyEdits(content, edits)
      checkSize(content)
      const doc = buildPage(title ?? parts.title, content)
      // Keep the previous version so a change can be undone.
      const versions = join(dirname(full), '.versions')
      mkdirSync(versions, { recursive: true })
      copyFileSync(full, join(versions, `${basename(full, '.html')}-${Date.now()}.html`))
      writeFileSync(full, doc)
      return {
        text: `Updated page ${full} (${kb(Buffer.byteLength(doc))}${edits?.length ? `, ${edits.length} edit${edits.length > 1 ? 's' : ''}` : ''}). The previous version is in ${versions}.`,
        display: `updated ${basename(full)}`,
        path: full
      }
    }
  }

  return [createPage, updatePage]
}

// ---------------------------------------------------------------- serving, windows, PDF (main process)

export function pageUrl(p: string): string {
  return `${SCHEME}://local${pathToFileURL(p).pathname}`
}

/**
 * Serves a page with the strict CSP and `sandbox allow-scripts` as headers, so it is locked down even if
 * the file on disk was edited by hand. Returns null for anything that isn't a page (normal serving).
 */
export function servePage(dir: string, p: string): Response | null {
  if (!isPagePath(dir, p)) return null
  return new Response(readFileSync(p), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `${PAGE_CSP}; sandbox allow-scripts`,
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  })
}

export function pageInfo(dir: string, p: string): PageInfo {
  if (!isPagePath(dir, p)) throw new Error('That file is not a page in the pages folder.')
  const full = resolve(p)
  const st = statSync(full)
  const head = readFileSync(full, 'utf8').slice(0, 200_000)
  return { path: full, name: basename(full), title: cleanTitle(pageParts(head).title), url: pageUrl(full), size: st.size, updatedAt: st.mtimeMs }
}

/**
 * Where a page's top frame may go: only another page in the pages folder (foreman-file://local/…). Plain
 * .html/.svg files elsewhere in the workspace are not pages and would run without the page lockdown.
 */
export function pageNavAllowed(dir: string, url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== `${SCHEME}:` || u.host !== 'local' || u.username || u.password) return false
  let p: string
  try { p = decodeURIComponent(u.pathname) } catch { return false }
  return isPagePath(dir, p)
}

/** Frames inside a page may only hold inline documents (the page CSP's frame-src 'none' refuses the rest). */
export function subframeNavAllowed(url: string): boolean {
  return url === 'about:blank' || url === 'about:srcdoc'
}

// Pages render only in their own session ("sahilbot-pages"), never in the app window. That session can
// reach nothing: CSP + webRequest stop fetches, and WebRTC (STUN/TURN, which neither sees) is shut three ways:
//  1. a preload strips RTCPeerConnection & co. from every frame's main world before page scripts run,
//  2. the WebRTC IP policy allows no UDP that isn't proxied, and the session's only proxy is a dead end
//     (nothing listens on the discard port) with loopback not exempt, so TURN-over-TCP goes nowhere too,
//  3. every permission check is refused (which also stops ICE from gathering local candidates).

const PARTITION = 'sahilbot-pages'
export const WEBRTC_POLICY = 'disable_non_proxied_udp' as const
const DEAD_END_PROXY = 'socks5://127.0.0.1:9'

/** Runs in each frame's main world before page scripts: removes every WebRTC interface (RTC*, webkitRTC*). */
export const STRIP_WEBRTC = `function(){var w=window;Object.getOwnPropertyNames(w).forEach(function(n){if(!/^(webkit)?RTC/.test(n))return;try{delete w[n]}catch(e){}if(n in w){try{Object.defineProperty(w,n,{value:undefined,writable:false,configurable:false})}catch(e){}}})}`

/** The page preload: exposes nothing (contextIsolation, sandbox); it only runs STRIP_WEBRTC in the main world. */
export const GUARD_PRELOAD = `'use strict';
const { contextBridge, webFrame } = require('electron');
const strip = ${STRIP_WEBRTC};
try { contextBridge.executeInMainWorld({ func: strip }) } catch (e) { try { webFrame.executeJavaScript('(' + strip.toString() + ')()') } catch (e2) {} }
`

let guardFile: string | null = null
/** Writes the preload once per launch (it's generated here so it can't drift from STRIP_WEBRTC). */
function guardPreload(): string | undefined {
  if (guardFile && existsSync(guardFile)) return guardFile
  for (const d of [app.getPath('userData'), tmpdir()]) {
    try {
      mkdirSync(d, { recursive: true })
      const f = join(d, 'page-guard.js')
      writeFileSync(f, GUARD_PRELOAD, { mode: 0o600 })
      return (guardFile = f)
    } catch { /* try the next folder */ }
  }
  return undefined
}

let sessionReady: Promise<void> | null = null

/** An in-memory session that can load pages and nothing else; every permission request is refused. */
function pageSession(getDir: () => string): { ses: Electron.Session; ready: Promise<void> } {
  const ses = session.fromPartition(PARTITION)
  if (!sessionReady) {
    ses.protocol.handle(SCHEME, (req) => {
      let p = ''
      try { p = decodeURIComponent(new URL(req.url).pathname) } catch { /* refused below */ }
      return servePage(getDir(), p) ?? new Response('Not allowed', { status: 403 })
    })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    // Belt and braces: the CSP already forbids network; drop anything that isn't the page itself.
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(foreman-file|data|blob|about|devtools|chrome-extension):/.test(d.url) }))
    sessionReady = ses.setProxy({ mode: 'fixed_servers', proxyRules: DEAD_END_PROXY, proxyBypassRules: '<-loopback>' }).catch(() => undefined)
  }
  return { ses, ready: sessionReady }
}

/** Navigation, popups and WebRTC rules for anything that shows a page (panel view, window, PDF, thumbnail). */
function harden(wc: Electron.WebContents, getDir: () => string): void {
  wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICY)
  // A page can't open anything, not even the user's browser (that would be a way to send data out).
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => { if (!pageNavAllowed(getDir(), e.url)) e.preventDefault() })
  wc.on('will-frame-navigate', (e) => {
    if (!(e.isMainFrame ? pageNavAllowed(getDir(), e.url) : subframeNavAllowed(e.url))) e.preventDefault()
  })
  wc.on('will-redirect', (e) => { if (!e.isMainFrame || !pageNavAllowed(getDir(), e.url)) e.preventDefault() })
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

const pageWebPreferences = (ses: Electron.Session): Electron.WebPreferences => ({
  session: ses,
  preload: guardPreload(),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // Only so the (sandboxed, Node-less) guard preload also runs in frames a page makes (srcdoc, about:blank).
  nodeIntegrationInSubFrames: true,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
  disableDialogs: true,
  webSecurity: true,
  allowRunningInsecureContent: false
})

const pageBg = (): string => (nativeTheme.shouldUseDarkColors ? '#161618' : '#ffffff')

/** "Open in window": the page full-size in its own window (same session and lockdown as the panel). */
export function openPageWindow(getDir: () => string, p: string, opts: { parent?: BrowserWindow | null; show?: boolean } = {}): BrowserWindow {
  const info = pageInfo(getDir(), p)
  const { ses, ready } = pageSession(getDir)
  const w = new BrowserWindow({
    width: 1100, height: 820, minWidth: 420, minHeight: 320, title: info.title, show: false, backgroundColor: pageBg(),
    webPreferences: pageWebPreferences(ses)
  })
  harden(w.webContents, getDir)
  if (opts.show !== false) w.once('ready-to-show', () => w.show())
  void ready.then(() => { if (!w.isDestroyed()) void w.loadURL(pageUrl(info.path)).catch(() => undefined) })
  return w
}

/** Loads a page in a hidden window and waits for it (and its charts) to settle. */
async function loadHidden(w: BrowserWindow, url: string, ready: Promise<void>, settleMs: number): Promise<void> {
  await ready
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('The page took too long to load.')), 20_000)
    w.webContents.once('did-finish-load', () => { clearTimeout(timer); ok() })
    w.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); fail(new Error(`The page didn't load (${desc || code}).`)) })
    void w.loadURL(url).catch(() => undefined)
  })
  await new Promise((r) => setTimeout(r, settleMs))
}

/** "Export PDF": renders the page off-screen in light mode and saves "<name>.pdf" next to it. */
export async function exportPagePdf(getDir: () => string, p: string): Promise<string> {
  const info = pageInfo(getDir(), p)
  const { ses, ready } = pageSession(getDir)
  const w = new BrowserWindow({ width: 1100, height: 1400, show: false, webPreferences: pageWebPreferences(ses) })
  harden(w.webContents, getDir)
  try {
    const wc = w.webContents
    // Print in light mode whatever the Mac's appearance. (The command only completes once the page has a
    // renderer, so it's sent now and waited for after the load.)
    let light: Promise<unknown> = Promise.resolve()
    try {
      wc.debugger.attach('1.3')
      light = wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => undefined)
    } catch { /* falls back to the page's @media print rules */ }
    await loadHidden(w, pageUrl(info.path), ready, 700)
    await Promise.race([light, new Promise((r) => setTimeout(r, 2_000))])
    const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }, generateDocumentOutline: true })
    const out = join(dirname(info.path), `${basename(info.path).replace(/\.html?$/i, '')}.pdf`)
    writeFileSync(out, pdf)
    shell.showItemInFolder(out)
    return out
  } finally {
    if (!w.isDestroyed()) w.destroy()
  }
}

// Chat-card thumbnails: a picture of the page, rendered once per version in a hidden page window.
const thumbs = new Map<string, string>()
let thumbQueue: Promise<unknown> = Promise.resolve()

/** A PNG data: URL of the page's top (800×514), or null if it couldn't be rendered. Cached per file version and theme. */
export function pageThumbnail(getDir: () => string, p: string): Promise<string | null> {
  const info = pageInfo(getDir(), p)
  const key = `${info.path}|${info.updatedAt}|${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`
  const hit = thumbs.get(key)
  if (hit) return Promise.resolve(hit)
  const job = thumbQueue.then(async () => {
    const again = thumbs.get(key)
    if (again) return again
    const { ses, ready } = pageSession(getDir)
    const w = new BrowserWindow({ width: 800, height: 514, useContentSize: true, show: false, skipTaskbar: true, focusable: false, backgroundColor: pageBg(), webPreferences: pageWebPreferences(ses) })
    harden(w.webContents, getDir)
    try {
      await loadHidden(w, pageUrl(info.path), ready, 500)
      const shot = await Promise.race([w.webContents.capturePage(), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 5_000))])
      if (shot.isEmpty()) return null
      const url = shot.resize({ width: 320, quality: 'good' }).toDataURL()
      for (const k of thumbs.keys()) if (k.startsWith(`${info.path}|`)) thumbs.delete(k)
      thumbs.set(key, url)
      return url
    } catch {
      return null
    } finally {
      if (!w.isDestroyed()) w.destroy()
    }
  })
  thumbQueue = job.catch(() => undefined)
  return job
}

export interface PanelBounds { x: number; y: number; width: number; height: number }

/**
 * The side-panel page: a native view in the pages session laid over the panel's page area (like the
 * browser tab), never an iframe in the app window. One at a time; the renderer sends its bounds.
 */
export class PagePanel {
  private view: WebContentsView | null = null
  private loaded: { path: string; rev: string } | null = null
  private gen = 0

  constructor(private win: () => BrowserWindow | null, private getDir: () => string) {}

  /** Shows `p` (version `rev`) at `bounds`; null bounds keeps it loaded but out of sight (a modal is open). */
  async show(p: string, rev: string, bounds: PanelBounds | null): Promise<PagePanelStatus> {
    const info = pageInfo(this.getDir(), p)
    const gen = ++this.gen
    const { ses, ready } = pageSession(this.getDir)
    await ready
    if (gen !== this.gen) return this.status()
    let v = this.view
    if (!v || v.webContents.isDestroyed()) {
      v = this.view = new WebContentsView({ webPreferences: pageWebPreferences(ses) })
      v.setBackgroundColor(pageBg())
      harden(v.webContents, this.getDir)
      this.loaded = null
    }
    if (!this.loaded || this.loaded.path !== info.path || this.loaded.rev !== rev) {
      this.loaded = { path: info.path, rev }
      void v.webContents.loadURL(pageUrl(info.path)).catch(() => undefined)
    }
    const w = this.win()
    const host = w && !w.isDestroyed() ? w : null
    if (host && bounds && bounds.width > 0 && bounds.height > 0) {
      if (!host.contentView.children.includes(v)) host.contentView.addChildView(v)
      v.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) })
    } else this.detach()
    return this.status()
  }

  /** The panel closed (or moved to another file): drop the page and stop its scripts. */
  close(): void {
    this.gen++
    this.detach()
    const v = this.view
    this.view = null
    this.loaded = null
    if (v && !v.webContents.isDestroyed()) v.webContents.close()
  }

  private detach(): void {
    const v = this.view
    const w = this.win()
    if (v && w && !w.isDestroyed() && w.contentView.children.includes(v)) w.contentView.removeChildView(v)
  }

  private status(): PagePanelStatus {
    const wc = this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null
    return { isolation: 'webcontentsview', partition: PARTITION, webrtc: wc?.getWebRTCIPHandlingPolicy() ?? WEBRTC_POLICY, guard: !!guardFile }
  }
}

/**
 * The main window's guard: its frames (PDF previews) may not navigate anywhere but app files. Pages
 * never load in the main window; they live in PagePanel's view. Attach to the main window's webContents.
 */
export function guardFrames(wc: Electron.WebContents): void {
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !/^(foreman-file|about|data|blob):/i.test(e.url)) e.preventDefault()
  })
}

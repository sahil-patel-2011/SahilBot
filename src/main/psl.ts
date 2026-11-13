/**
 * A compact Public Suffix List: the multi-part public suffixes people actually meet (country second
 * levels like co.uk, com.au, com.ve) and the PSL "private" suffixes where strangers get their own
 * subdomain (github.io, vercel.app, s3.amazonaws.com…). Any other host's public suffix is its last label.
 *
 * Used wherever "the same site" matters for security: one-time-code senders vs. the page, saved logins
 * matching subdomains, and grants. Not the full list (no new dependency); when in doubt it errs toward
 * treating more of a name as public, so two different owners are never seen as one site.
 */

const ICANN_MULTI = `
ac.uk co.uk gov.uk ltd.uk me.uk net.uk nhs.uk org.uk plc.uk police.uk sch.uk
com.au net.au org.au edu.au gov.au asn.au id.au
co.nz net.nz org.nz govt.nz ac.nz school.nz geek.nz kiwi.nz
co.jp ne.jp or.jp ac.jp ad.jp ed.jp go.jp gr.jp lg.jp
com.br net.br org.br gov.br edu.br art.br blog.br eco.br emp.br
com.ve net.ve org.ve gob.ve co.ve info.ve web.ve
com.mx org.mx gob.mx net.mx edu.mx
com.ar net.ar org.ar gob.ar edu.ar
com.co net.co org.co gov.co edu.co
com.pe net.pe org.pe gob.pe edu.pe
com.ec net.ec org.ec gob.ec
com.uy net.uy org.uy gub.uy
com.py net.py org.py gov.py
com.bo net.bo org.bo gob.bo
cl gob.cl
com.cn net.cn org.cn gov.cn edu.cn ac.cn
com.hk net.hk org.hk gov.hk edu.hk idv.hk
com.tw net.tw org.tw gov.tw edu.tw idv.tw
com.sg net.sg org.sg gov.sg edu.sg per.sg
com.my net.my org.my gov.my edu.my
com.ph net.ph org.ph gov.ph edu.ph
com.vn net.vn org.vn gov.vn edu.vn
co.th in.th ac.th go.th or.th net.th
co.id or.id ac.id go.id web.id my.id biz.id
co.kr or.kr ne.kr go.kr ac.kr re.kr
co.in net.in org.in gov.in ac.in edu.in firm.in gen.in ind.in
com.pk net.pk org.pk gov.pk edu.pk
com.bd net.bd org.bd gov.bd
com.np org.np gov.np
com.lk org.lk gov.lk
co.il org.il net.il ac.il gov.il muni.il
com.tr net.tr org.tr gov.tr edu.tr av.tr gen.tr biz.tr
com.sa net.sa org.sa gov.sa edu.sa
com.eg net.eg org.eg gov.eg edu.eg
co.za net.za org.za gov.za ac.za web.za
co.ke or.ke ac.ke go.ke
com.ng net.ng org.ng gov.ng edu.ng
com.gh org.gh gov.gh
co.ug or.ug ac.ug
co.tz or.tz ac.tz
com.ua net.ua org.ua gov.ua in.ua kiev.ua
com.ru net.ru org.ru msk.ru spb.ru
com.pl net.pl org.pl gov.pl edu.pl waw.pl
co.at or.at gv.at ac.at
com.es org.es nom.es gob.es edu.es
com.pt org.pt gov.pt edu.pt
com.gr org.gr gov.gr edu.gr
co.hu org.hu gov.hu
com.cy org.cy gov.cy
com.mt org.mt gov.mt
co.it gov.it edu.it
co.no gs.no priv.no
com.ro org.ro
co.rs org.rs
com.hr
com.ee org.ee
com.qa net.qa org.qa gov.qa
com.kw net.kw org.kw gov.kw
com.bh net.bh org.bh gov.bh
com.om net.om org.om gov.om
co.ae net.ae org.ae gov.ae ac.ae
com.jo net.jo org.jo gov.jo
com.lb net.lb org.lb gov.lb
co.ma net.ma org.ma gov.ma
com.tn net.tn org.tn gov.tn
com.dz net.dz org.dz gov.dz
com.do net.do org.do gob.do
com.gt net.gt org.gt gob.gt
com.sv org.sv gob.sv
com.hn net.hn org.hn gob.hn
com.ni net.ni org.ni gob.ni
co.cr fi.cr or.cr go.cr
com.pa net.pa org.pa gob.pa
com.cu net.cu org.cu
com.jm net.jm org.jm gov.jm
co.tt com.tt net.tt org.tt
com.pr net.pr org.pr gov.pr
`

/** PSL private suffixes: anyone can register a name directly under these. */
const PRIVATE = `
github.io githubusercontent.com gitlab.io bitbucket.io pages.dev workers.dev
vercel.app now.sh netlify.app netlify.com herokuapp.com herokussl.com fly.dev onrender.com railway.app
web.app firebaseapp.com appspot.com cloudfunctions.net run.app
blogspot.com blogspot.co.uk wordpress.com tumblr.com wixsite.com weebly.com squarespace.com myshopify.com
s3.amazonaws.com s3-website-us-east-1.amazonaws.com cloudfront.net elasticbeanstalk.com amplifyapp.com awsapprunner.com
azurewebsites.net azurestaticapps.net cloudapp.net blob.core.windows.net trafficmanager.net azureedge.net
glitch.me repl.co replit.dev replit.app ngrok.io ngrok-free.app ngrok.app loca.lt trycloudflare.com
surge.sh neocities.org readthedocs.io gitbook.io notion.site webflow.io framer.app framer.website
carrd.co carrd.com strikingly.com site123.me jimdosite.com webnode.page
duckdns.org no-ip.org ddns.net dyndns.org
deno.dev val.run supabase.co
`

const SUFFIXES = new Set([...ICANN_MULTI.split(/\s+/), ...PRIVATE.split(/\s+/)].filter(Boolean).map((s) => s.toLowerCase()))
/** S3 regional endpoints: s3.<region>.amazonaws.com and s3-website.<region>.amazonaws.com. */
const S3_REGIONAL = /^s3(?:-website)?[.-][a-z0-9-]+\.amazonaws\.com$/

function cleanHost(host: string): string {
  let h = String(host ?? '').trim().toLowerCase()
  // A URL or "host:port" → the hostname.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) { try { h = new URL(h).hostname } catch { /* keep */ } }
  h = h.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.+$/, '')
  return h
}

const isIp = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/** The public suffix of a host ("co.uk" for "shop.example.co.uk", "github.io" for "me.github.io"). */
export function publicSuffix(host: string): string {
  const h = cleanHost(host)
  if (!h || isIp(h)) return ''
  const parts = h.split('.')
  // Longest listed suffix wins.
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join('.')
    if (SUFFIXES.has(cand) || S3_REGIONAL.test(cand)) return cand
  }
  return parts[parts.length - 1]
}

/** Whether a host is itself a public suffix (nobody owns it as a site). */
export function isPublicSuffix(host: string): boolean {
  const h = cleanHost(host)
  return !!h && !isIp(h) && publicSuffix(h) === h
}

/**
 * The registrable domain (eTLD+1): "example.co.uk" for "shop.example.co.uk", "alice.github.io" for
 * "www.alice.github.io", "chase.com.ve" (not "com.ve", and never the same as "chase.com"). IPs and
 * single-label hosts (localhost) are returned whole; a host that is itself a public suffix gives ''.
 */
export function registrableDomain(host: string): string {
  const h = cleanHost(host)
  if (!h) return ''
  if (isIp(h) || !h.includes('.')) return h
  const ps = publicSuffix(h)
  if (ps === h) return ''
  const rest = h.slice(0, h.length - ps.length - 1).split('.')
  return `${rest[rest.length - 1]}.${ps}`
}

/** Same registrable domain (and neither is a bare public suffix). */
export function sameSite(a: string, b: string): boolean {
  const x = registrableDomain(a)
  return !!x && x === registrableDomain(b)
}

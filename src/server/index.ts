// sahilbot-server: SahilBot as an always-on headless server (Raspberry Pi, a VM, a Mac mini). docs/server.md.
//
//   sahilbot-server [serve] [--data DIR] [--port 8787] [--listen 127.0.0.1] [--tls] [--cert F --key F]
//                   [--allow-host NAME]... [--passphrase-file F] [--max-runs N]
//   sahilbot-server pair      a new one-time pairing code (10 minutes)
//   sahilbot-server devices   paired devices
//   sahilbot-server revoke ID removes a device (its open tabs are signed out)
//   sahilbot-server audit     the last remote-access events
//   sahilbot-server key       a new random master key (for SAHILBOT_MASTER_KEY or systemd credentials)

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const major = Number(process.versions.node.split('.')[0])
const minor = Number(process.versions.node.split('.')[1])
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`SahilBot Server needs Node.js 22.13 or newer (it uses the built-in node:sqlite); this is ${process.version}. Node 24 LTS is recommended.`)
  process.exit(1)
}

export interface Args {
  cmd: string
  rest: string[]
  data: string
  port: number
  listen: string
  tls?: boolean
  cert?: string
  key?: string
  allowHosts: string[]
  passphraseFile?: string
  maxRuns?: number
  help: boolean
  version: boolean
}

export function defaultDataDir(env = process.env, platform = process.platform): string {
  if (env.SAHILBOT_DATA) return env.SAHILBOT_DATA
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'SahilBot Server')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'sahilbot-server')
}

export function parseArgs(argv: string[], env = process.env): Args {
  const a: Args = { cmd: 'serve', rest: [], data: defaultDataDir(env), port: Number(env.SAHILBOT_PORT) || 8787, listen: env.SAHILBOT_LISTEN || '127.0.0.1', allowHosts: (env.SAHILBOT_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean), help: false, version: false }
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`)
    return v
  }
  let first = true
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const [flag, inline] = x.startsWith('--') && x.includes('=') ? [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)] : [x, undefined]
    const val = (): string => { if (inline !== undefined) return inline; const v = take(i, flag); i++; return v }
    switch (flag) {
      case '--data': a.data = val(); break
      case '--port': a.port = Number(val()); break
      case '--listen': a.listen = val(); break
      case '--tls': a.tls = true; break
      case '--no-tls': a.tls = false; break
      case '--cert': a.cert = val(); break
      case '--key': a.key = val(); break
      case '--allow-host': a.allowHosts.push(val()); break
      case '--passphrase-file': a.passphraseFile = val(); break
      case '--max-runs': a.maxRuns = Number(val()); break
      case '-h': case '--help': a.help = true; break
      case '-v': case '--version': a.version = true; break
      default:
        if (x.startsWith('-')) throw new Error(`Unknown option ${x}. See --help.`)
        if (first) { a.cmd = x; first = false } else a.rest.push(x)
    }
  }
  if (!Number.isInteger(a.port) || a.port < 0 || a.port > 65535) throw new Error('--port must be 0-65535.')
  if (a.maxRuns !== undefined && (!Number.isFinite(a.maxRuns) || a.maxRuns < 1)) throw new Error('--max-runs must be 1 or more.')
  return a
}

const HELP = `SahilBot Server: your SahilBot bots, always on (Raspberry Pi, VM, Mac mini).

Usage: sahilbot-server [command] [options]

Commands
  serve            run the server (default)
  pair             print a new one-time pairing code (10 minutes)
  devices          list paired devices
  revoke <id>      remove a paired device
  audit            recent remote-access events
  key              print a new random master key

Options
  --data DIR           data folder (default ${defaultDataDir()})
  --port N             port (default 8787)
  --listen ADDR        address (default 127.0.0.1). Any other address turns on TLS.
  --tls                HTTPS even on 127.0.0.1 (self-signed unless --cert/--key)
  --cert F --key F     your own certificate and key (PEM)
  --allow-host NAME    another name the server answers to (repeatable; *.example.com allowed)
  --passphrase-file F  stretch the master key from a passphrase in this file
  --max-runs N         most agent runs at once (default: sized to this machine)

Remote access: keep 127.0.0.1 and run "tailscale serve --bg 8787" for HTTPS on your tailnet.
Docs: docs/server.md`

async function main(): Promise<void> {
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) { console.error((e as Error).message); process.exit(2) }
  if (args.help) { console.log(HELP); return }
  const { version } = await import('./boot')
  if (args.version) { console.log(version()); return }
  const passphrase = args.passphraseFile ? readFileSync(args.passphraseFile, 'utf8').replace(/\r?\n$/, '') : undefined
  const dir = join(args.data, 'server')

  if (args.cmd === 'key') { console.log(randomBytes(32).toString('hex')); return }
  if (args.cmd === 'pair') {
    const { PairingCodes, formatCode } = await import('./auth')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const c = new PairingCodes(join(dir, 'pairing.json')).create()
    const { AuditLog } = await import('./audit')
    new AuditLog(join(dir, 'audit.log')).write('pair.code', { detail: 'from the command line' })
    console.log(`Pairing code: ${formatCode(c.code)}  (works once, until ${new Date(c.expires).toLocaleTimeString()})`)
    console.log('Open the server in a browser and enter it.')
    return
  }
  if (args.cmd === 'devices' || args.cmd === 'revoke') {
    const { resolveMasterKey } = await import('./secrets')
    const { Devices } = await import('./auth')
    const key = await resolveMasterKey({ dir, passphrase })
    const devices = new Devices(dir, key.key)
    if (args.cmd === 'revoke') {
      const id = args.rest[0]
      if (!id) { console.error('revoke needs a device id (see sahilbot-server devices).'); process.exit(2) }
      const ok = devices.revoke(id)
      if (ok) { const { AuditLog } = await import('./audit'); new AuditLog(join(dir, 'audit.log')).write('device.revoke', { device: id, detail: 'from the command line' }) }
      console.log(ok ? `Removed ${id}. Its open tabs are signed out within seconds.` : `No active device ${id}.`)
      return
    }
    for (const d of devices.list()) console.log(`${d.id}  ${d.revokedAt ? 'revoked ' : 'active  '} ${d.kind.padEnd(7)} ${d.name}  (paired ${d.createdAt.slice(0, 10)}${d.lastSeen ? `, last seen ${d.lastSeen.slice(0, 16).replace('T', ' ')}${d.lastIp ? ` from ${d.lastIp}` : ''}` : ''})`)
    if (!devices.list().length) console.log('No paired devices yet. Run: sahilbot-server pair')
    return
  }
  if (args.cmd === 'audit') {
    const { AuditLog } = await import('./audit')
    for (const e of new AuditLog(join(dir, 'audit.log')).recent(50).reverse()) console.log(`${e.at}  ${e.kind.padEnd(14)} ${e.device ?? ''} ${e.ip ?? ''} ${e.detail ?? ''}`)
    return
  }
  if (args.cmd !== 'serve') { console.error(`Unknown command ${args.cmd}. See --help.`); process.exit(2) }

  const { startServer } = await import('./boot')
  const { formatCode } = await import('./auth')
  const server = await startServer({ data: args.data, port: args.port, listen: args.listen, tls: args.tls, cert: args.cert, key: args.key, allowHosts: args.allowHosts, passphrase, maxRuns: args.maxRuns })
  console.log(`SahilBot Server ${version()} is running at ${server.url}`)
  if (server.tls?.selfSigned) console.log(`TLS: self-signed certificate (SHA-256 ${server.tls.fingerprint}). Browsers warn until you trust it; Tailscale avoids that.`)
  if (server.firstCode) {
    console.log('')
    console.log(`  Pairing code: ${formatCode(server.firstCode)}   (works once, for 10 minutes)`)
    console.log(`  Open ${server.url.replace('this-machine', '<this machine>')} in a browser and enter it. New code any time: sahilbot-server pair`)
    console.log('')
  }
  if (args.listen === '127.0.0.1') console.log('Only this machine can reach it. From your phone or laptop: install Tailscale here, then run: tailscale serve --bg ' + server.port)
  let quitting = false
  const quit = (sig: string): void => {
    if (quitting) return
    quitting = true
    console.log(`Stopping (${sig})…`)
    const t = setTimeout(() => process.exit(0), 8000)
    t.unref()
    void server.stop().finally(() => process.exit(0))
  }
  // app.quit() from inside SahilBot (a menu item, a bot) stops the service cleanly; the service manager decides about restarting.
  const { host } = await import('./host')
  host.quit = () => quit('quit')
  process.on('SIGTERM', () => quit('SIGTERM'))
  process.on('SIGINT', () => quit('SIGINT'))
  process.on('uncaughtException', (e) => console.error('[server] uncaught:', e))
  process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e))
}

// Runs when started as a program (node out/server/index.js), not when tests import parseArgs.
const isEntry = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module
if (isEntry) void main().catch((e) => { console.error(`SahilBot Server could not start: ${(e as Error).message}`); process.exit(1) })

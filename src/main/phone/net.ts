// Where Phone access may listen, and who may connect: this Mac's home network (Wi-Fi or Ethernet, private
// addresses only) and its Tailscale address. Never a public address, never 0.0.0.0, so nothing is reachable
// from the internet even on a Mac with a public IP or a router that forwards ports. No relay, no port forwarding.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'

export type AddressKind = 'loopback' | 'lan' | 'tailscale' | 'link-local' | 'public' | 'other'

const v4 = (ip: string): number[] | null => {
  if (isIP(ip) !== 4) return null
  return ip.split('.').map(Number)
}

/** What an address is, for the rules here. IPv6 is not used for listening; for peers see peerAllowed. */
export function classify(ip: string): AddressKind {
  const a = String(ip ?? '').replace(/^::ffff:/i, '').split('%')[0]
  const p = v4(a)
  if (p) {
    if (p[0] === 127) return 'loopback'
    if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'lan'
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'tailscale'
    if (p[0] === 169 && p[1] === 254) return 'link-local'
    if (p[0] === 0 || p[0] >= 224) return 'other'
    return 'public'
  }
  if (isIP(a) !== 6) return 'other'
  const l = a.toLowerCase()
  if (l === '::1') return 'loopback'
  if (l.startsWith('fd7a:115c:a1e0:')) return 'tailscale'
  if (/^fe[89ab]/.test(l)) return 'link-local'
  if (/^f[cd]/.test(l)) return 'lan'
  if (l === '::') return 'other'
  return 'public'
}

export interface PhoneAddress { ip: string; kind: 'lan' | 'tailscale'; iface: string }

/**
 * This Mac's addresses Phone access may use: private IPv4 on Wi-Fi/Ethernet (en*) and the Tailscale
 * address (its utun interface). Bridges (Internet Sharing), VMs and other VPNs are left out.
 */
export function phoneAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): PhoneAddress[] {
  const out: PhoneAddress[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const k = classify(i.address)
      if (k === 'lan' && /^en\d+$/.test(name)) out.push({ ip: i.address, kind: 'lan', iface: name })
      else if (k === 'tailscale' && /^utun\d+$/.test(name)) out.push({ ip: i.address, kind: 'tailscale', iface: name })
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.iface.localeCompare(b.iface, undefined, { numeric: true }) : a.kind === 'lan' ? -1 : 1))
}

/** Whether Phone access may listen on this address: a private home-network or Tailscale address (loopback only for tests). */
export function bindable(ip: string, o: { allowLoopback?: boolean } = {}): boolean {
  const k = classify(ip)
  if (k === 'loopback') return !!o.allowLoopback && isIP(ip) === 4
  return (k === 'lan' || k === 'tailscale') && isIP(ip) === 4
}

/** Whether a connection may even be looked at: from this Mac, the home network, or the tailnet. */
export function peerAllowed(remote: string | undefined): boolean {
  if (!remote) return false
  const k = classify(remote)
  return k === 'loopback' || k === 'lan' || k === 'tailscale' || k === 'link-local'
}

export interface Listening { lan: boolean; tailscale: boolean }

/** The addresses to listen on for these choices. */
export function bindPlan(addrs: PhoneAddress[], want: Listening, o: { loopbackOnly?: boolean } = {}): string[] {
  if (o.loopbackOnly) return ['127.0.0.1']
  return [...new Set(addrs.filter((a) => (a.kind === 'lan' ? want.lan : want.tailscale)).map((a) => a.ip))].filter((ip) => bindable(ip))
}

// ------------------------------------------------------------------ Tailscale

export interface TailscaleInfo {
  /** The Tailscale app or command is on this Mac. */
  installed: boolean
  /** This Mac has a tailnet address right now (Tailscale is connected). */
  connected: boolean
  ip?: string
  /** The MagicDNS name (mac.tailnet.ts.net), when the command could tell. */
  dnsName?: string
}

const CLI = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']

/** Tailscale on this Mac: installed, connected, its address and MagicDNS name (best effort, read-only). */
export async function detectTailscale(addrs: PhoneAddress[], o: { exists?: (p: string) => boolean; status?: () => Promise<string | null> } = {}): Promise<TailscaleInfo> {
  const exists = o.exists ?? existsSync
  const ts = addrs.find((a) => a.kind === 'tailscale')
  const installed = exists('/Applications/Tailscale.app') || CLI.some((p) => exists(p))
  const info: TailscaleInfo = { installed: installed || !!ts, connected: !!ts, ip: ts?.ip }
  if (!ts) return info
  const cli = CLI.find((p) => exists(p))
  const status = o.status ?? (cli ? () => run(cli, ['status', '--json', '--self=true', '--peers=false']) : async () => null)
  try {
    const text = await status()
    const name = text ? String((JSON.parse(text) as { Self?: { DNSName?: string } }).Self?.DNSName ?? '').replace(/\.$/, '') : ''
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(name)) info.dnsName = name.toLowerCase()
  } catch { /* the name is a nicety */ }
  return info
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((ok) => execFile(cmd, args, { timeout: 3000, maxBuffer: 1024 * 1024 }, (e, out) => ok(e ? null : String(out))))
}

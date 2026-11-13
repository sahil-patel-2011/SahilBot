import { homedir } from 'node:os'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

// What the knowledge base may read. Three layers, all checked for every file:
// 1. Places it never goes: ~/Library, system folders, app bundles and libraries.
// 2. A default ignore list: dependency and build folders, hidden files and folders, and anything that
//    looks like a secret (.env, private keys, keychains, credentials). Secrets are never indexed, even
//    if a .gitignore would let them through.
// 3. The folder's own .gitignore files.
// Only known document, text and code formats are read, up to MAX_FILE_BYTES each.

export const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Folders that are never walked, by name, wherever they appear. */
export const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'Pods', 'Carthage', 'DerivedData',
  'dist', 'build', 'out', 'target', 'bin', 'obj', 'coverage', 'htmlcov', 'storybook-static',
  '__pycache__', 'venv', 'env', 'site-packages', '.venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.git', '.hg', '.svn', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.gradle',
  '.idea', '.vscode', '.terraform', '.serverless', '.vercel', '.expo', '.dart_tool', '.foreman',
  'Library', 'test-results', 'playwright-report', 'tmp', 'temp', 'logs'
])

/** Folder name endings that are macOS packages or libraries (opaque bundles, not documents). */
const BUNDLE_EXT = /\.(app|bundle|framework|kext|plugin|photoslibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|lrdata|xcarchive|xcassets|xcodeproj|xcworkspace|dSYM|pkg|mpkg|sparsebundle|docset|appex|lproj|nib|storyboardc|playground|rtfd|pages|numbers|key|band|logicx)$/i

/** File names that hold secrets. Matched case-insensitively against the whole name. */
const SECRET_NAMES = [
  /^\.env(\..*)?$/, /^.*\.env$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^.*\.(pem|key|p12|pfx|p8|jks|keystore|kdbx|kdb|keychain|keychain-db|ppk|asc|gpg|pgp|ovpn|mobileprovision|cer|crt|der|csr)$/,
  /^\.?(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials|dockercfg)$/, /^credentials(\.(json|ya?ml|toml|ini|txt|csv))?$/,
  /^.*(secret|secrets|password|passwords|credential|credentials|token|tokens|apikey|api[-_]key)s?\.(json|ya?ml|toml|ini|txt|env|cfg|conf|csv|xml|plist)$/,
  /^service[-_]?account.*\.json$/, /^client[-_]secret.*\.json$/, /^.*\.tfstate(\.backup)?$/, /^known_hosts$/, /^authorized_keys$/,
  /^.*\.(sqlite|sqlite3|db)$/, /^Cookies$/, /^Login Data$/, /^wallet\.dat$/
]

/** Text that means the whole file is a secret (a private key, a keychain export). */
const SECRET_CONTENT = /-----BEGIN ((RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY( BLOCK)?-----/

/** High-confidence token shapes, redacted from any text that is indexed. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, // Stripe
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g, // Google OAuth token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b1\/\/0[A-Za-z0-9_-]{30,}/g, // Google OAuth refresh token
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g // npm
]

/** Key names whose value is a secret, in any case, with _ or - (or nothing) between the words. */
const SECRET_KEY = String.raw`(?:password|passwd|passphrase|pwd|secret|secret[_-]?(?:access[_-]?)?key|api[_-]?key|api[_-]?secret|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|consumer[_-]?secret|app[_-]?secret|signing[_-]?key|encryption[_-]?key|webhook[_-]?secret)`

/**
 * key = value, key: value, "key": "value" (JSON, YAML, .env, code): the value goes, the key stays so the
 * passage still reads. A quoted value may hold escaped characters (a JSON private_key's "\n"s).
 */
const KEY_VALUE = new RegExp(String.raw`((["']?)(?<![A-Za-z0-9])${SECRET_KEY}\2\s*[:=]\s*)("(?:[^"\\\n]|\\.){4,}"|'(?:[^'\\\n]|\\.){4,}'|[^\s"'\x60,;}\]]{6,})`, 'gi')
/** A property list's <key>password</key><string>…</string>. */
const PLIST_SECRET = new RegExp(String.raw`(<key>\s*${SECRET_KEY}\s*</key>\s*<string>)[^<]*(</string>)`, 'gi')
/** An Authorization header's bearer token. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g

/** Extensions read as plain text (prose, data and code). */
export const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst', '.adoc', '.org', '.tex', '.rtf', '.log',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.plist', '.graphql', '.gql', '.proto', '.sql',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh',
  '.cs', '.fs', '.php', '.pl', '.pm', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs', '.clj', '.elm', '.zig', '.nim',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.css', '.scss', '.sass', '.less', '.gradle', '.cmake', '.ipynb'
])
export const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])
export const SHEET_EXT = new Set(['.csv', '.tsv', '.xlsx', '.xlsm'])
export const DOC_EXT = new Set(['.pdf', '.docx', '.pptx'])
/** Extension-less files worth reading. */
const KNOWN_NAMES = new Set(['README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS', 'NOTES', 'TODO', 'Makefile', 'Dockerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Brewfile', 'Justfile'])

export function supported(path: string): boolean {
  const name = basename(path)
  const ext = extname(name).toLowerCase()
  if (!ext) return KNOWN_NAMES.has(name) || KNOWN_NAMES.has(name.toUpperCase())
  return TEXT_EXT.has(ext) || HTML_EXT.has(ext) || SHEET_EXT.has(ext) || DOC_EXT.has(ext)
}

/** A file name that holds (or usually holds) secrets. */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase()
  return SECRET_NAMES.some((re) => re.test(n))
}

/** File text that is itself a secret (a private key). */
export function isSecretContent(text: string): boolean {
  return SECRET_CONTENT.test(text.slice(0, 200_000))
}

/**
 * Replaces high-confidence tokens and key=value secrets with [redacted]: unquoted and quoted keys (JSON,
 * YAML, .env, code), refresh tokens, API keys, private keys and client secrets, plist <key>/<string>
 * pairs, and bearer tokens.
 */
export function redactSecrets(text: string): string {
  let out = text
  out = out.replace(PLIST_SECRET, (_m, open: string, close: string) => `${open}[redacted]${close}`)
  out = out.replace(KEY_VALUE, (_m, key: string, _q: string, value: string) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
    return `${key}${quote}[redacted]${quote}`
  })
  out = out.replace(BEARER, (_m, b: string) => `${b}[redacted]`)
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, '[redacted]')
  }
  return out
}

/** Folders the knowledge base never reads, even if asked to: ~/Library and the system. */
export function forbiddenRoots(home = homedir()): string[] {
  return [
    resolve(home, 'Library'), resolve(home, '.Trash'), resolve(home, '.ssh'), resolve(home, '.gnupg'), resolve(home, '.aws'), resolve(home, '.config'),
    '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/cores', '/opt', '/Applications', '/Network',
    '/private/etc', '/private/var/db', '/private/var/root', '/private/var/log', '/var/db', '/var/root', '/var/log'
  ]
}

/**
 * `p` is `root` or inside it, ignoring case (macOS disks are case-insensitive: ~/library is ~/Library).
 * Both should already be resolved (realpath) by the caller where links matter.
 */
export const insideCI = (root: string, p: string): boolean => {
  const r = root.toLowerCase()
  const q = p.toLowerCase()
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Why a folder can't be a knowledge source ('' when it can). Refuses the disk root, the home folder
 * itself (it holds ~/Library, keys and app data), the home folder's Library and system folders (or
 * anything inside them). Compared without regard to case.
 */
export function refuseRoot(path: string, home = homedir()): string {
  if (!isAbsolute(path)) return 'Use a full folder path.'
  const p = resolve(path)
  const low = p.toLowerCase().replace(/\/+$/, '') || '/'
  if (['/', '/private', '/var', '/users', '/volumes', '/private/var'].includes(low)) return 'That is a whole disk or system folder. Pick a folder of your own documents.'
  if (low === resolve(home).toLowerCase()) return 'That is your whole home folder. Pick a folder of your own documents inside it, like Documents.'
  const bad = forbiddenRoots(home).find((r) => insideCI(r, p))
  if (bad) return `${bad} holds system or app data and is never indexed.`
  return ''
}

/** True when a path (absolute) is in a place the knowledge base never reads (any case). */
export function inForbidden(path: string, home = homedir()): boolean {
  return forbiddenRoots(home).some((r) => insideCI(r, path))
}

/**
 * Formats "Open" may hand to their default app: documents and plain text only. Everything else (code,
 * scripts, web pages, data files) is revealed in Finder instead, since its default app could run it.
 */
const OPEN_DIRECT = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.xlsm', '.csv', '.tsv', '.txt', '.md', '.markdown', '.rtf', '.log'])
export function opensDirectly(path: string): boolean {
  return OPEN_DIRECT.has(extname(path).toLowerCase())
}

/** A folder name the walk skips: default-ignored, hidden, or a macOS bundle. */
export function skipDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(name) || BUNDLE_EXT.test(name)
}

/** A file name the walk skips before looking inside: hidden, secret, or not a format we read. */
export function skipFile(name: string): string {
  if (isSecretName(name)) return 'secret'
  if (name.startsWith('.')) return 'hidden'
  if (/(\.min\.(js|css)|\.map|\.lock|-lock\.json|\.lockb)$/i.test(name) || name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml') return 'generated'
  if (!supported(name)) return 'unsupported'
  return ''
}

// ---------------------------------------------------------------------------------------- .gitignore

interface Pattern { re: RegExp; negate: boolean; dirOnly: boolean }

/** Translates one gitignore glob (already stripped of !, leading / and trailing /) into a regex body. */
function globBody(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" = any number of folders; "/**" = everything inside; bare "**" = anything.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end > i) { out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end } else out += '\\['
    } else if (c === '\\' && i + 1 < glob.length) { out += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

/** Parses a .gitignore file into patterns. */
export function parseGitignore(text: string): Pattern[] {
  const out: Pattern[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    // A slash at the start or in the middle anchors the pattern to the .gitignore's folder.
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/')
    line = line.replace(/^\//, '')
    if (!line) continue
    const body = globBody(line)
    out.push({ re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`), negate, dirOnly })
  }
  return out
}

/**
 * A stack of .gitignore files from the walk's root down to the current folder. `ignored` answers
 * for a path relative to the root; deeper files win, and later lines win within a file.
 */
export class IgnoreStack {
  private layers: Array<{ base: string; patterns: Pattern[] }> = []

  constructor(layers: Array<{ base: string; patterns: Pattern[] }> = []) {
    this.layers = layers
  }

  /** A new stack with a .gitignore found in `base` (relative to the root, '' for the root itself). */
  with(base: string, text: string): IgnoreStack {
    const patterns = parseGitignore(text)
    return patterns.length ? new IgnoreStack([...this.layers, { base, patterns }]) : this
  }

  ignored(relPath: string, isDir: boolean): boolean {
    let result = false
    for (const layer of this.layers) {
      if (layer.base && !relPath.startsWith(layer.base + '/')) continue
      const rel = layer.base ? relPath.slice(layer.base.length + 1) : relPath
      for (const p of layer.patterns) {
        // A dir-only pattern matches files only through one of their parent folders.
        const hit = p.dirOnly && !isDir ? dirMatch(p.re, rel) : p.re.test(rel)
        if (hit) result = !p.negate
      }
    }
    return result
  }
}

/** For a dir-only pattern and a file: does any parent folder of `rel` match? */
function dirMatch(re: RegExp, rel: string): boolean {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join('/'))) return true
  return false
}

/** Relative path with forward slashes (for .gitignore matching). */
export function relPosix(root: string, p: string): string {
  return relative(root, p).split(sep).join('/')
}

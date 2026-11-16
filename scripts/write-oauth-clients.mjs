// Writes resources/oauth-clients.json (SahilBot's own OAuth app registrations, docs/oauth-registration.md)
// from the SAHILBOT_OAUTH_CLIENTS_JSON environment variable, for electron-builder to package. The release
// workflow runs it with only that one secret in its environment. Without the variable it writes nothing:
// the app then has no built-in clients, and those apps fall back to "Use your own app".
//
//   SAHILBOT_OAUTH_CLIENTS_JSON='{"slack":{"clientId":"…","redirect":"http://localhost:47613/callback"}}' node scripts/write-oauth-clients.mjs
//
// It never prints a client ID or secret, only which apps got one. The app checks every entry again on
// start (src/main/oauth-clients.ts) and skips anything malformed.

import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const raw = process.env.SAHILBOT_OAUTH_CLIENTS_JSON ?? ''
const out = resolve(import.meta.dirname, '..', 'resources', 'oauth-clients.json')
if (!raw.trim()) {
  console.log('No SAHILBOT_OAUTH_CLIENTS_JSON: no built-in OAuth clients in this build (apps fall back to "Use your own app").')
  process.exit(0)
}
let doc
try { doc = JSON.parse(raw) } catch { console.error('::error::SAHILBOT_OAUTH_CLIENTS_JSON is not valid JSON'); process.exit(1) }
if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { console.error('::error::SAHILBOT_OAUTH_CLIENTS_JSON must be an object of { "<preset id>": { clientId, … } }'); process.exit(1) }
const ids = []
for (const [id, v] of Object.entries(doc)) {
  if (id.startsWith('$') || id.startsWith('_')) continue
  if (!/^[a-z0-9-]{2,40}$/.test(id)) { console.error(`::error::bad app id in SAHILBOT_OAUTH_CLIENTS_JSON: ${JSON.stringify(id.slice(0, 40))}`); process.exit(1) }
  if (!v || typeof v !== 'object' || typeof v.clientId !== 'string' || !v.clientId.trim()) { console.error(`::error::${id}: clientId is missing`); process.exit(1) }
  if (/REPLACE_ME/.test(JSON.stringify(v))) { console.error(`::error::${id}: still has a REPLACE_ME placeholder`); process.exit(1) }
  ids.push(id)
}
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
chmodSync(out, 0o600)
console.log(`Built-in OAuth clients written for: ${ids.join(', ') || '(none)'}`)

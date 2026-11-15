---
name: security-review
description: Audit code for security flaws (secrets, injection, XSS, SSRF, authz/IDOR, CSRF, crypto) and report severity-ranked findings with exploit scenarios.
source: you
uses: 0
category: Coding
triggers: security review, vulnerability, owasp, sql injection, xss, ssrf, idor, csrf, hardcoded secret, auth bypass, is this secure, threat model, path traversal, command injection, insecure deserialization
---

## When
Before shipping auth, payments, uploads, user input handling or a new public endpoint, or when asked to audit. Vulnerable packages: dependency-hygiene. Only analyze and test code and systems the user owns; never probe, scan or attack anyone else's.

## Steps
1. Map the attack surface: HTTP routes, Electron IPC/preload, CLI args, uploads, webhooks, queue consumers; trust boundaries; where sensitive data lives.
2. Follow untrusted input from each entry to sinks (DB, shell, filesystem, HTML, outbound HTTP, eval, deserializers). Flag paths with no validation or encoding at the sink.
3. Walk the checklist. Read helpers like `sanitize()` before trusting them.
4. Confirm each finding by tracing the path or a harmless test on the user's local instance; otherwise mark it "needs verification".
5. Report by severity; search for sibling instances of every pattern found.

## Checklist
- Secrets: code(action="search", pattern="api[_-]?key|secret|token|password|BEGIN .*PRIVATE KEY", ignore_case=true); committed .env; history (`git log -p -S <prefix>`); client bundles, logs, error pages. Fix: env or secret store; rotate anything leaked.
- SQL/NoSQL injection: string-built queries, raw(), f-strings into SQL, Mongo operators from JSON bodies. Fix: parameters/ORM bindings.
- Command injection: exec, `shell=True`, child_process.exec with user data. Fix: argv arrays (execFile, subprocess.run([...])), allow-lists.
- Path traversal and zip-slip: user paths joined to a base. Fix: resolve, then require the result stays under the root.
- Code/template injection: eval, new Function, user input as template source, pickle.loads, unsafe yaml.load, Java native deserialization. Fix: safe loaders, data-only formats.
- XSS: innerHTML, dangerouslySetInnerHTML, v-html, `|safe`, raw markdown HTML, javascript: URLs. Fix: framework escaping, DOMPurify, CSP.
- SSRF: server fetches user-supplied URLs. Fix: host allow-list; block private, loopback and link-local ranges (169.254.169.254) after DNS resolution and on redirects.
- Authentication: bcrypt/scrypt/argon2 (not SHA/MD5), session rotation on login and expiry, JWT with pinned algorithm and checked signature and exp, rate-limited login and reset.
- Authorization/IDOR: each handler checks the caller may touch this record (scope queries by owner or tenant), admin checks on the server, no mass assignment of role or owner fields.
- CSRF: cookie-authenticated state changes need SameSite plus a token or Origin check; no side effects on GET.
- Crypto: Math.random for tokens (use crypto.randomBytes / secrets), ECB, fixed IVs or keys, homemade crypto, TLS verification disabled (`verify=False`, `rejectUnauthorized: false`).
- Electron: contextIsolation on, nodeIntegration off, validated IPC, no remote content with Node access, shell.openExternal only for vetted URLs.
- Logging/PII: passwords, tokens, card numbers or health data in logs/analytics; stack traces shown to users.
- Config: debug in production, CORS `*` with credentials, missing security headers, public buckets.

## Report format
`[High] src/api/files.ts:42 Path traversal in download` - Scenario: `GET /files?name=../../.env` returns server secrets. Fix: path.resolve plus a startsWith(root) check; add a test with `../`.
Critical: remote code execution, auth bypass, secret leak. High: cross-user data access. Medium: needs user interaction or limited impact. Low: hardening.

## Pitfalls
- Scanner noise with no concrete scenario.
- Counting client-side checks as security.
- Fixing one instance and missing the pattern.

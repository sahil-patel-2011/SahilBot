---
name: security-review
description: Review code or a project for security problems.
source: you
uses: 0
category: Coding
---

1. Secrets: search the code and git history for keys, tokens and passwords.
2. Inputs: injection (SQL, shell, path traversal, templates), unsafe deserialization, XSS, SSRF in URL fetches.
3. Auth: every endpoint checks who is calling and what they may access; sessions expire; passwords use a slow hash.
4. Dependencies: npm audit or pip-audit; packages with known CVEs.
5. Report findings by severity with file:line, a concrete exploit scenario and the fix. Never test attacks against systems the user doesn't own.

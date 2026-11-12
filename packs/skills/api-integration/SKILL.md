---
name: api-integration
description: Call a web API from code: auth, requests, errors and rate limits.
source: you
uses: 0
category: Coding
---

1. Find the official docs (web_search + fetch_page): base URL, auth method, the exact endpoint, request and response fields. Don't guess field names.
2. Keys come from environment variables or the user's settings, never hard-coded or committed.
3. Write a small client function: timeouts, clear errors with the status code and body, retries with backoff only for 429/5xx.
4. Test with one real call on harmless data (ask first if it changes anything or costs money).
5. Handle pagination and rate limits if the docs mention them.

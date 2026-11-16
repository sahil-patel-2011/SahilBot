---
name: api-integration
description: Call a web API from code: auth, requests, errors and rate limits.
source: you
uses: 0
category: Coding
triggers: call the api, rest api client, api key, webhook, oauth token, rate limit, http request, integrate with
---

1. Find the official docs (web_search + fetch_page): base URL, auth method, the exact endpoint, request and response fields. Don't guess field names.
2. Keys come from environment variables or the user's settings, never hard-coded or committed.
3. Write a small client function: timeouts, clear errors with the status code and body, retries with backoff only for 429/5xx.
4. Test with one real call on harmless data (ask first if it changes anything or costs money).
5. Handle pagination and rate limits if the docs mention them.


## Working with a saved service key
For a one-off service task, prefer `api_request` instead of writing a script containing a token. Discover it with `find_tools("api_request")`. List metadata, read the service's official REST docs, identify the exact HTTPS endpoint/method and preview the effect. The user adds a key once under Settings → Privacy & Security → API Keys; choose Authorization + Bearer or the documented custom header + key-only format. Never ask the user to paste it into the conversation. The request approval is specific to the URL, method and body. The backend injects the key and blocks redirects to other destinations.

A missing or expired connector goes through `connect_app`, which displays a Connect / Sign in tile. Do not treat an installed CLI as a connected service. A rejected or uncertain write is checked with a read-only receipt before retrying; use provider idempotency features when documented. Bound pagination, validate success codes and response fields, and retain resource ids for verification. Save API *documentation* and versions in a skill or knowledge note; credentials belong only in the encrypted Vault or provider settings.

Reference: [HTTP method semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods). Look up provider-specific authentication, API versions and retirement dates on each integration task.

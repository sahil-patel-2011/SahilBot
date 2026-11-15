---
name: api-design
description: Design REST, RPC or library APIs - resources, naming, errors, pagination, versioning, idempotency, backward compatibility - with docs and examples.
source: you
uses: 0
category: Coding
triggers: api design, design an api, rest endpoint, endpoint naming, pagination, api versioning, idempotency key, error response format, openapi spec, grpc service, breaking api change, http status codes, library interface design, sdk surface
---

## When
Creating or changing an HTTP or RPC endpoint, webhook, SDK, or a module's public functions. Calling someone else's API: api-integration. Storage underneath: database-schema-migrations.

## Steps
1. Start from use cases: the 3-5 calls a client really needs, with example requests and responses written first.
2. Match the codebase's existing conventions (casing, envelope, error shape, auth) over textbook ideals.
3. Write the contract (OpenAPI, .proto or a typed interface) with at least one example per call.
4. Validate at the edge; add contract tests for status codes, shapes and errors.

## REST rules
- Plural noun resources (`/users/{id}/invoices`); the method is the verb. GET safe, PUT full replace and idempotent, PATCH partial, POST create or action, DELETE idempotent. Non-CRUD actions: `POST /invoices/{id}/send`.
- Status codes: 200, 201 with Location, 202 for async jobs, 204; 400 malformed, 401 unauthenticated, 403 forbidden, 404 missing (also for records the caller may not see), 409 conflict, 422 validation, 429 with Retry-After; 5xx only for server faults. Never 200 with an error body.
- One error shape everywhere, e.g. `{"error": {"code": "invoice_not_found", "message": "...", "details": [], "request_id": "..."}}` or RFC 9457 problem+json. Codes are stable; messages may change.
- Pagination: cursor-based for large or changing sets (`?limit=50&cursor=...` -> `next_cursor`); offset only for small stable sets. Cap limit, set a default sort, tie-break on id.
- Filtering and sorting: `?status=open&sort=-created_at`, with documented allowed fields.
- Idempotency: POSTs that create or charge accept an `Idempotency-Key` header; store key, request hash and response for about 24 h; replay the stored response on retry; reject the same key with a different body.
- Data: ISO 8601 UTC timestamps, opaque string IDs, money as integer minor units plus currency, one field casing.
- Long work: 202 plus a job resource to poll, or a webhook.

## RPC and library APIs
- Protobuf: never reuse or renumber field tags; reserve removed ones; new fields optional.
- Libraries: small surface; accept general types, return specific ones; an options object past 3 parameters; no boolean traps like `render(true, false)`; typed errors; document thread safety and ownership.

## Compatibility and versioning
- Safe: new endpoints, new optional fields or params, new enum values only if clients tolerate unknown ones.
- Breaking: removing or renaming fields, changing types or meaning, new required params, stricter validation, changed defaults or status codes.
- For breaking changes: a new version (`/v2`, header or dated version), run both, signal deprecation (Deprecation and Sunset headers), measure old usage before removal.
- Clients ignore unknown fields (tolerant reader).

## Docs
Per call: purpose, auth, params with types and limits, example request and response, possible errors, rate limits, and one runnable curl.

## Pitfalls
- Exposing the DB schema as the API shape.
- Unbounded list endpoints.
- Authorization by route only, not per record.
- Chatty APIs that force N calls for one screen.

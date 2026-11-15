---
name: backend-services
description: Designs and hardens REST or GraphQL services - edge validation, queues, caching, idempotency, retries, timeouts, rate limits and shutdown.
source: you
uses: 0
category: Coding
triggers: returns 500, 500 error, internal server error, endpoint returns, rest api design, graphql resolver, idempotency key, retry with backoff, exponential backoff jitter, message queue, background job worker, circuit breaker, cache stampede, cursor pagination, rate limiting, graceful shutdown, health check endpoint, readiness probe, dead letter queue, n+1 query
---

## When
Building or reviewing an API, worker or service that talks to other services. Calling a third-party API from a client: api-integration. Logs/metrics/traces: observability.

## Design checklist
1. Resources and verbs: nouns in paths, correct status codes (201 create, 204 no body, 400 bad input, 401 unauthenticated, 403 forbidden, 404, 409 conflict, 422 semantic error, 429, 503). One error shape everywhere: `{ "error": { "code", "message", "details" } }`.
2. Validate at the edge: parse the request into a typed object with a schema (zod, pydantic, JSON Schema) before any logic runs. Reject unknown fields on writes. Internal code then trusts types.
3. GraphQL: batch with DataLoader to kill N+1, set query depth/complexity limits, authorize in resolvers, not only at the gateway.
4. Pagination: cursor (opaque, based on a stable sort key + id) for large or changing sets; offset only for small admin lists. Always cap `limit`.
5. Long work (> ~1 s, external calls, emails, exports) goes to a queue: return 202 with a job id; workers pull, ack after success, retry with backoff, then park in a dead-letter queue after N attempts. Jobs must be idempotent because delivery is at-least-once.

## Resilience rules
- Timeouts everywhere: every outbound HTTP, DB and queue call has a deadline shorter than the caller's. No default-infinite clients.
- Retries only for transient errors (connect failures, 429, 502-504) and only for idempotent operations. Exponential backoff with full jitter: `sleep = random(0, min(cap, base * 2^attempt))`, max 3-5 attempts, honor `Retry-After`.
- Idempotency keys for non-idempotent POSTs (payments, orders): client sends `Idempotency-Key`; server stores key + request hash + response, returns the stored response on replay, 409/422 if the same key arrives with a different body. Expire keys after 24 h or so.
- Circuit breaker around flaky dependencies: open after an error-rate threshold, fail fast, half-open probe, close on success. Pair with a fallback (cached value, degraded response).
- Rate limit per client (token bucket) and return 429 with `Retry-After`.

## Caching
- Cache-aside with a TTL; key includes every input that changes the result (tenant, locale, version).
- Invalidate on write (delete the key after the DB commit, not before).
- Stampede protection: request coalescing (single flight), lock-on-miss, or early probabilistic refresh; add TTL jitter so keys don't expire together.
- Never cache per-user data under a shared key.

## Lifecycle
- Health: `/livez` (process alive, no dependency checks) and `/readyz` (can serve: DB reachable, migrations done). Readiness failing removes the instance from rotation; liveness failing restarts it, so keep liveness cheap.
- Graceful shutdown on SIGTERM: fail readiness, stop accepting, finish in-flight requests and jobs within a deadline (e.g. 25 s), close pools, exit.

## Pitfalls
- Retrying at every layer: 3 x 3 x 3 = 27 calls into a dying service. Retry at one layer.
- Publishing a queue message inside a DB transaction that later rolls back; use an outbox table.
- Unbounded `SELECT *` list endpoints; missing indexes behind filters and sorts.

## Verify
Tests for: invalid input -> 400 with the error shape; replayed idempotency key returns the same response and creates one row; a dependency stubbed to hang hits the timeout; SIGTERM during a request lets it complete. Load-test the hot path (k6, hey) and read p95/p99.

## Example
```ts
const key = req.header("Idempotency-Key");
const prior = await db.idem.find(key);
if (prior) return res.status(prior.status).json(prior.body);
```

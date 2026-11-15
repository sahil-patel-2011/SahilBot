---
name: observability
description: Instruments services with structured logs, metrics and traces, sets SLO-based alerts and dashboards, and uses them to debug production.
source: you
uses: 0
category: Coding
triggers: structured logging, correlation id, request id header, opentelemetry, distributed tracing, trace span, prometheus metrics, histogram buckets, label cardinality, red metrics, use method, slo error budget, burn rate alert, grafana dashboard, alert fatigue, log levels
---

## When
Adding instrumentation, designing alerts, or investigating a production problem. Service design itself: backend-services. CPU/memory profiling of one process: performance-profiling.

## Logs
1. Structured JSON, one event per line: `ts`, `level`, `msg`, `service`, `env`, `version`, `request_id`/`trace_id`, plus event fields. Messages are constant strings; variables go in fields.
2. Levels: ERROR = needs a human or lost work; WARN = degraded but handled; INFO = business events and request summaries; DEBUG off in prod by default.
3. Correlation: accept or generate `X-Request-Id` at the edge, put it in a context/MDC, log it everywhere, return it in the response, pass it downstream.
4. Never log secrets, tokens, passwords, full card numbers, or raw PII. Redact in the logger config, not by hoping callers remember.
5. Log an error once, where it is handled, with the stack trace. Don't log-and-rethrow at every layer.

## Metrics
- RED for request-driven services: Rate, Errors, Duration per route. USE for resources: Utilization, Saturation, Errors (CPU, pools, queues, disks).
- Counter = only goes up (requests_total, errors_total); query with rate(). Gauge = current value (queue_depth, in_flight). Histogram = distributions (latency, payload size); compute p50/p95/p99 from buckets, never average latencies.
- Cardinality: labels must be bounded (route template, method, status class). Never user id, email, full URL or request id as a label; each unique combo is a new series.
- Name with units: `http_request_duration_seconds`, `_bytes`, `_total`.

## Traces
- Use OpenTelemetry SDK + auto-instrumentation for HTTP, DB and queue clients; add manual spans around meaningful work (`checkout.charge_card`) with attributes (order size, cache hit).
- Propagate context (W3C `traceparent`) across HTTP, gRPC and message headers; async jobs link to the span that enqueued them.
- Record errors on spans (status + exception event). Sample head-based at a low rate plus tail-based keep-all-errors/slow traces if the backend supports it.
- Put `trace_id` in logs so you can jump log -> trace.

## Alerts and SLOs
1. Define SLIs from the user's view: success ratio and latency (e.g. 99.9% of requests succeed, 99% under 300 ms, over 30 days).
2. Alert on symptoms (SLO burn rate), not causes. Multi-window burn rate: page when 2% of the monthly budget burns in 1 h (fast) or 5% in 6 h; ticket for slow burns.
3. Every page has a runbook link, is actionable, and would wake you for a real reason. Delete alerts nobody acts on.
4. Cause-level signals (CPU high, disk 80%) go to dashboards or low-urgency tickets, except imminent exhaustion (disk full in < 4 h).

## Dashboards
Top row: SLO status and RED for the service. Then dependencies (latency/errors per downstream), then resources (USE). Mark deploys as annotations. One dashboard per service, same layout everywhere.

## Debugging production
1. Scope: which SLI, since when, which routes/regions/versions? Line it up with deploy and config-change markers.
2. Metrics narrow the where (route, instance, dependency); traces show which span is slow or failing; logs filtered by trace_id give the why.
3. Compare a bad request against a good one. Form one hypothesis, check it, then mitigate (rollback, flag off, scale) before root-causing.
4. After the fix, add the missing signal that would have made this obvious.

## Verify
Hit an endpoint and confirm: one log line with request_id, the counter increments, a trace shows all hops with the same trace_id, and a test alert fires in staging.

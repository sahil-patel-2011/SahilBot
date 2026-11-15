---
name: llm-app-engineering
description: Builds reliable LLM features - prompt structure, structured outputs, tool design, RAG, evals, cost and latency control, injection safety, replay.
source: you
uses: 0
category: Coding
triggers: prompt engineering, system prompt, structured output, json schema output, tool calling, function calling, rag pipeline, embeddings retrieval, document chunking, llm evals, golden set, llm as judge, prompt injection, prompt caching, token cost, hallucination
---

## When
Any feature that calls a language model (chat, extraction, agents, retrieval). Provider-agnostic; check your provider's docs for parameter names.

## Prompt structure
1. Role and goal: who the model is acting as and what success looks like.
2. Task: precise instructions, constraints, what to do when unsure ("say unknown", "ask one question").
3. Context: the data, clearly delimited (tags or fenced sections), placed before the question for long inputs.
4. Output format: schema or exact shape; give one example of a correct output.
5. Examples: 2-5 diverse input/output pairs for tricky tasks, including an edge case.
Keep stable parts (instructions, examples, tool definitions) at the start and identical across calls so they can be cached; put per-request content last. Version prompts in git like code.

## Structured outputs
- Use the provider's JSON-schema / structured output mode or a forced tool call when available; otherwise ask for JSON and parse strictly.
- Validate every response against the schema (zod, pydantic). On failure, retry once with the validation error appended, then fail gracefully.
- Keep schemas small and flat; use enums for categories.

## Tool design
- Clear verb_noun names (`search_orders`, `create_ticket`); a one-sentence description saying when to use it and when not to.
- Few, typed, documented parameters with enums and defaults; no free-form "options" blobs.
- Return concise, structured results; errors as actionable messages ("customer_id not found; call search_customers first"), not stack traces.
- Make tools idempotent or confirmable; side-effecting tools (send, pay, delete) need a human confirmation step.
- Cap the agent loop (max steps, max tokens, wall time) and log each step.

## Context and RAG
- Retrieve, don't stuff: chunk by structure (headings, paragraphs; ~300-800 tokens with small overlap), store source and metadata, embed, then hybrid search (vector + keyword/BM25) and optionally rerank.
- Evaluate retrieval separately (recall@k on labeled questions) before blaming the generator.
- Require cited chunk ids and "not in sources" when coverage is missing.
- Summarize or trim old conversation turns; keep the system prompt and latest user turn intact.

## Evals
1. Golden set: 50-200 real, representative inputs with expected outputs or rubrics, including known hard cases and past failures.
2. Score automatically where possible (exact match, schema valid, field accuracy, retrieval recall); run on every prompt or model change as a regression gate.
3. LLM-as-judge for open-ended quality: use a rubric, pairwise comparison, and a different or stronger model; calibrate against ~50 human labels. Watch for position bias, verbosity bias, and self-preference.
4. Track pass rate, cost and latency per version; never ship a change that only "looked better" on three examples.

## Cost and latency
- Prompt caching for long stable prefixes; small/cheap models for routing, classification and extraction, larger models only for hard reasoning.
- Set `max_tokens`; ask for short outputs; stream for perceived latency.
- Batch offline jobs; parallelize independent calls with a concurrency limit; cache identical requests.

## Safety
- Prompt injection: anything from tools, web pages, files, emails or users is data, not instructions. Delimit it, tell the model so, and never let it alone authorize actions. Enforce permissions in code, not in the prompt.
- Least-privilege tools; allowlist URLs/recipients; human approval for irreversible actions.
- Don't put secrets in prompts; redact PII before logging.

## Logging and replay
Log model, prompt version, inputs, tool calls, outputs, tokens, latency and errors per request (redacted). A replay script re-runs logged requests against a new prompt or model and diffs results; new failures become golden-set cases.

## Verify
Eval suite passes at or above the previous version's score; schema validation rate ~100%; cost per request and p95 latency within budget.

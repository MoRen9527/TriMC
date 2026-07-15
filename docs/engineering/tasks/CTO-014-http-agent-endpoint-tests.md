# CTO-014: HTTP Agent Endpoint Integration Tests

## Status: COMPLETE

## Overview

HTTP-level integration tests for `POST /internal/v1/agent` — validating the v0.2.0 pipeline assembly endpoint through real HTTP requests (fetch + mock DeepSeek).

## Deliverables

- [x] `test/http-agent-endpoint.test.ts` — 17 tests across 5 suites
- [x] `docs/registry/code-state.md` — Updated

## Test Coverage

### Suite 1: JSON Mode — Legacy Backward Compat (4 tests)
- Legacy fields (model + systemPrompt + messages) → 200
- Minimal payload (model + messages only) → 200
- Invalid JSON → 400
- Missing systemPrompt gracefully → 200

### Suite 2: JSON Mode — Contract Pipeline (5 tests)
- Full pipeline with contract + messages → 200
- Identity in system prompt
- Tier parameter (subagent) → 200
- systemPrompt override in contract mode → 200
- Malformed contract → 500 pipeline_assembly_error

### Suite 3: SSE Mode — Legacy (2 tests)
- SSE with `?stream=true` → text/event-stream
- SSE with `Accept: text/event-stream` header

### Suite 4: SSE Mode — Contract Pipeline (3 tests)
- SSE with contract → text/event-stream
- loop_end event structure validation
- Broken contract → 500 (pipeline fails before SSE)

### Suite 5: Cross-cutting (3 tests)
- GET /internal/v1/agent → 404
- Messages order preserved
- Concurrent requests

## Gate Result

- 257/257 tests passing (+17 new)
- tsc --noEmit: clean
- validate.mjs: all gates PASS

# MVP Stages (Night Sprint)

## Stage 1: Foundation
- Bootstrap TypeScript CLI package
- Add command parser and project config model
- Implement `brothers init`

## Stage 2: Core Protocol
- Implement `brothers task` with TASK-ID generation
- Implement markdown task template and status model
- Implement `brothers start` prompt generation + status transition

## Stage 3: Handoff Proof
- Implement `brothers report` with report template
- Implement `brothers status` project counters
- Implement `brothers next` extraction from latest report

## Stage 4: Verification
- Add e2e test for full flow (`init -> task -> start -> report -> status -> next`)
- Run build + tests locally
- Capture outputs for acceptance evidence

## Stage 5: Delivery
- Create private GitHub repository via PAT-authenticated gh
- Push local git history
- Provide runbook and acceptance commands

## Stage 6: Relay Safety (v0.2)
- Add task dependencies (`task --depends-on` + `link --depends-on`)
- Add `relay-check` command for dependency/report/artifact validation
- Generate relay baton JSON and enforce `start --with-baton` for dependent tasks
- Add tests for blocked start without baton and successful start with baton

## Stage 7: Auto AI Flow (v0.3)
- Add `start --auto` mode for `mock`, `openai`, `anthropic`
- Save raw AI response and parse into report fields
- Auto-generate report directly from AI output
- Add machine-readable outputs: `relay-check --json`, `baton-info --json`
- Add tests for mock auto mode and JSON relay interfaces

## Stage 8: AI Ops Hardening (v0.4)
- Add `ai setup/show/providers` for provider/model defaults
- Add retry/backoff controls for auto AI calls
- Add prompt sanitization for secrets before provider calls
- Add tests for config defaults, retry behavior, and sanitization

## Stage 9: Execution Controls (v0.5)
- Add `ai test` command for provider readiness checks
- Add `start --dry-run` to generate prompt without state mutation
- Add `prompt --sanitize-preview --save` for safe handoff preview
- Add `relay-check --strict` to treat warnings as blockers
- Add tests for strict relay, dry-run safety, prompt preview, and ai test

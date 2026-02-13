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

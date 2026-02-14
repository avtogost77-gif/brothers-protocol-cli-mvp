# Brothers Protocol CLI MVP

Lightweight markdown-first orchestration CLI for AI task handoff.

## Commands (MVP)
- `brothers init`
- `brothers ai providers|show|setup`
- `brothers task <title>`
- `brothers link <TASK-ID> --depends-on TASK-001`
- `brothers relay-check <TASK-ID> [--json]`
- `brothers baton-info <BATON-ID> [--json]`
- `brothers start <TASK-ID> [--auto --ai mock|openai|anthropic --model ...]`
- `brothers report <TASK-ID>`
- `brothers status`
- `brothers next [--create <index>]`

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js ai setup --provider mock --model mock-v1 --sanitize on --retries 2 --retry-delay-ms 500
node dist/cli.js task "Fix calculator bug"
node dist/cli.js start TASK-001
node dist/cli.js report TASK-001 --done "Fixed form id" --tests "PASS" --next "Deploy to staging"
node dist/cli.js task "Deploy to staging" --depends-on TASK-001
node dist/cli.js relay-check TASK-002
node dist/cli.js start TASK-002 --with-baton BATON-001
BROTHERS_MOCK_AI_RESPONSE="## WORK DONE\n- ✅ Done\n## FILES CHANGED\n- src/cli.ts\n## TESTS\nPASS\n## RESULT\nDone\n## NEXT STEPS\n- [ ] Deploy" node dist/cli.js start TASK-003 --auto
node dist/cli.js status
```

## Acceptance

```bash
npm test
```

See `STAGES.md` and `PRODUCTION_RUNBOOK.md`.

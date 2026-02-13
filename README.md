# Brothers Protocol CLI MVP

Lightweight markdown-first orchestration CLI for AI task handoff.

## Commands (MVP)
- `brothers init`
- `brothers task <title>`
- `brothers start <TASK-ID>`
- `brothers report <TASK-ID>`
- `brothers status`
- `brothers next [--create <index>]`

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js task "Fix calculator bug"
node dist/cli.js start TASK-001
node dist/cli.js report TASK-001 --done "Fixed form id" --tests "PASS" --next "Deploy to staging"
node dist/cli.js status
```

## Acceptance

```bash
npm test
```

See `STAGES.md` and `PRODUCTION_RUNBOOK.md`.

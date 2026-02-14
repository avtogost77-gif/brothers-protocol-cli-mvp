# Production Runbook (MVP)

## Requirements
- Node.js 20+
- npm 10+

## Install

```bash
npm install
npm run build
git config credential.helper '!gh auth git-credential'
```

## Local Usage

```bash
node dist/cli.js init
node dist/cli.js task "Fix calculator bug" --priority high --assignee claude
node dist/cli.js start TASK-001 --ai claude
node dist/cli.js report TASK-001 --done "Fixed selectors;Added tests" --files "index.html,assets/js/calculator.js" --tests "PASS" --next "Deploy to staging"
node dist/cli.js task "Deploy to staging" --depends-on TASK-001
node dist/cli.js relay-check TASK-002
node dist/cli.js start TASK-002 --with-baton BATON-001
node dist/cli.js status
node dist/cli.js next
```

## Quality Gate

```bash
npm test
```

## Release Gate
- Build passes
- e2e test passes
- Repo pushed to private GitHub remote

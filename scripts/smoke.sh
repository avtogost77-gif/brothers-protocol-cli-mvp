#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run() {
  echo "$ $*"
  "$@"
  echo
}

run node "$ROOT_DIR/dist/cli.js" init "$TMP_DIR/project"
cd "$TMP_DIR/project"
run node "$ROOT_DIR/dist/cli.js" ai setup --provider mock --model mock-v1 --sanitize on --retries 2 --retry-delay-ms 1

run node "$ROOT_DIR/dist/cli.js" task "Smoke: handoff flow" --priority high --assignee claude --details "Validate full cycle" --files "src/cli.ts,tests/mvp-flow.test.mjs"
run node "$ROOT_DIR/dist/cli.js" start TASK-001 --ai claude
run node "$ROOT_DIR/dist/cli.js" report TASK-001 --done "Generated prompt;Created report;Validated handoff" --files "coordination/tasks/TASK-001.md,coordination/reports/REPORT-001.md" --tests "PASS smoke checks" --next "Prepare v0.2 relay validation"
run node "$ROOT_DIR/dist/cli.js" status
run node "$ROOT_DIR/dist/cli.js" next --create 1
run node "$ROOT_DIR/dist/cli.js" link TASK-002 --depends-on TASK-001
run node "$ROOT_DIR/dist/cli.js" relay-check TASK-002
run node "$ROOT_DIR/dist/cli.js" baton-info BATON-001
run node "$ROOT_DIR/dist/cli.js" start TASK-002 --with-baton BATON-001
run node "$ROOT_DIR/dist/cli.js" task "Auto smoke task"

MOCK_RESPONSE="$(cat <<'EOF_MOCK'
## STATUS
COMPLETED

## WORK DONE
- ✅ Auto smoke completion

## FILES CHANGED
- coordination/tasks/TASK-003.md

## TESTS
PASS auto smoke

## RESULT
Auto path verified.

## NEXT STEPS
- [ ] Review report
EOF_MOCK
)"

run env BROTHERS_MOCK_FAILS=1 BROTHERS_MOCK_AI_RESPONSE="$MOCK_RESPONSE" node "$ROOT_DIR/dist/cli.js" start TASK-003 --auto

echo "Smoke flow completed in: $TMP_DIR/project"

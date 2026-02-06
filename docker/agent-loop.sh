#!/bin/bash
set -euo pipefail

AGENT_ID="${AGENT_ID:?AGENT_ID is required}"
GAME_NAME="${GAME_NAME:?GAME_NAME is required}"
LOG_FILE="/work/agent-${AGENT_ID}.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Agent ${AGENT_ID}] $*" | tee -a "$LOG_FILE"
}

log "Starting agent loop for game: ${GAME_NAME}"

# Clone from bare repo
if [ ! -d /work/project ]; then
  log "Cloning repository..."
  git clone /repo /work/project
  cd /work/project
  git config user.name "agent-${AGENT_ID}"
  git config user.email "agent-${AGENT_ID}@tokamak-forge"
else
  cd /work/project
fi

LOOP_COUNT=0

while true; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  log "=== Loop iteration ${LOOP_COUNT} ==="

  # Sync with latest changes
  log "Pulling latest changes..."
  cd /work/project
  git fetch origin 2>>"$LOG_FILE" || true
  git pull --rebase origin main 2>>"$LOG_FILE" || {
    log "Rebase conflict detected, aborting and retrying..."
    git rebase --abort 2>/dev/null || true
    git reset --hard origin/main 2>>"$LOG_FILE" || true
    sleep 3
    continue
  }

  # Run Claude in autonomous mode
  log "Invoking Claude..."
  claude --model claude-sonnet-4.5 \
    --dangerously-skip-permissions \
    -p "CLAUDE.md 파일을 읽고 지시에 따라 다음 작업을 수행하세요. 당신은 agent-${AGENT_ID}입니다." \
    2>>"$LOG_FILE" | tee -a "$LOG_FILE" || true

  EXIT_CODE=${PIPESTATUS[0]:-$?}
  log "Claude exited with code ${EXIT_CODE}"

  # Brief pause before next iteration
  sleep 5
done

#!/usr/bin/env bash
# ============================================================================
# Odysseus Build Orchestrator — CI/CD Automation Entry Point
# ============================================================================
# Called by WorkBuddy scheduled automation (HOURLY).
# Implements internal 30-min health check schedule + 5-min retry on failure
# via timestamp-based state tracking.
#
# Behavioral logic (handles cron limitation of HOURLY granularity):
#
#   ┌─────────────────────────────────────────────────────────────┐
#   │  Each automation trigger → orchestrator runs a timed loop   │
#   │  that schedules the NEXT check based on:                    │
#   │                                                             │
#   │  • Last check OK  → wait 30 min → check again              │
#   │  • Last check FAIL → wait 5 min  → retry                   │
#   │  • Retry also FAIL → mark CRITICAL, exit loop              │
#   │  • After 2 hours → exit gracefully (next trigger takes over)│
#   └─────────────────────────────────────────────────────────────┘
#
# State file: logs/health/last-status.txt (ok|fail|retry|critical)
# Timestamp file: logs/health/last-check-ts.txt (epoch seconds)
# ============================================================================
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly STATE_DIR="$REPO_DIR/logs/health"
readonly STATE_FILE="$STATE_DIR/last-status.txt"
readonly TS_FILE="$STATE_DIR/last-check-ts.txt"
readonly LOCK_FILE="$STATE_DIR/orchestrator.lock"
readonly LOG_FILE="$REPO_DIR/logs/orchestrator-$(date +%Y%m%d).log"

# ── Configuration ──────────────────────────────────────────────────────────
readonly NORMAL_INTERVAL_SECONDS=$((30 * 60))   # 30 minutes between normal checks
readonly RETRY_INTERVAL_SECONDS=$((5 * 60))      # 5 minutes before retry
readonly MAX_LOOP_DURATION_SECONDS=$((2 * 60 * 60))  # 2 hour max per trigger
readonly HEALTH_CHECK_SCRIPT="$SCRIPT_DIR/check-build-health.sh"

# ── Logging ─────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }
log_stdout() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ── Ensure state directory ─────────────────────────────────────────────────
init_state() {
    mkdir -p "$STATE_DIR"
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "ok" > "$STATE_FILE"
    fi
    if [[ ! -f "$TS_FILE" ]]; then
        echo "0" > "$TS_FILE"
    fi
}

# ── Read / Write State ─────────────────────────────────────────────────────
get_status() {
    cat "$STATE_FILE" 2>/dev/null || echo "ok"
}

set_status() {
    echo "$1" > "$STATE_FILE"
}

get_last_check_ts() {
    cat "$TS_FILE" 2>/dev/null || echo "0"
}

set_last_check_ts() {
    date +%s > "$TS_FILE"
}

# ── Should we check now? ───────────────────────────────────────────────────
should_check_now() {
    local status
    status="$(get_status)"
    local last_ts
    last_ts="$(get_last_check_ts)"
    local now_ts
    now_ts="$(date +%s)"
    local elapsed=$((now_ts - last_ts))

    case "$status" in
        "ok"|"warn")
            # Normal mode: check if 30 minutes have passed
            if [[ $elapsed -ge $NORMAL_INTERVAL_SECONDS ]]; then
                log "Normal check: ${elapsed}s since last check (threshold: ${NORMAL_INTERVAL_SECONDS}s)"
                return 0  # Yes, check now
            else
                log "Skipping: only ${elapsed}s since last OK check (need ${NORMAL_INTERVAL_SECONDS}s)"
                return 1  # Too soon
            fi
            ;;
        "fail"|"retry")
            # Retry mode: check if 5 minutes have passed
            if [[ $elapsed -ge $RETRY_INTERVAL_SECONDS ]]; then
                log "Retry check: ${elapsed}s since last failure (threshold: ${RETRY_INTERVAL_SECONDS}s)"
                return 0  # Yes, retry now
            else
                log "Retry cooldown: only ${elapsed}s since last failure (need ${RETRY_INTERVAL_SECONDS}s). Waiting..."
                return 1  # Still in cooldown
            fi
            ;;
        "critical")
            log "CRITICAL state — manual intervention required. Skipping."
            return 2  # Blocked, human needed
            ;;
        *)
            # Unknown state — reset and check
            set_status "ok"
            return 0
            ;;
    esac
}

# ── Run single health check ────────────────────────────────────────────────
run_health_check() {
    log "Running health check..."
    log_stdout "⟳ Running Odysseus Build Health Check..."

    set +e
    bash "$HEALTH_CHECK_SCRIPT" 2>&1 | while IFS= read -r line; do
        echo "$line" | tee -a "$LOG_FILE"
    done
    local exit_code=${PIPESTATUS[0]}
    set -e

    set_last_check_ts
    log "Health check exit code: $exit_code"

    case $exit_code in
        0)
            set_status "ok"
            log_stdout "✓ Health check PASSED"
            ;;
        1)
            set_status "warn"
            log_stdout "⚠ Health check passed with warnings"
            ;;
        2|*)
            local status
            status="$(get_status)"
            if [[ "$status" == "retry" || "$status" == "fail" ]]; then
                # This was already a retry — it failed again
                set_status "critical"
                log_stdout "❌ CRITICAL: Health check failed after retry. Manual intervention required."
                log "CRITICAL: Retry failed. Escalating."
            else
                set_status "fail"
                log_stdout "❌ Health check FAILED. Will retry in 5 minutes."
                log "Failure detected. Marking for retry."
            fi
            ;;
    esac

    return $exit_code
}

# ============================================================================
# MAIN — Time-aware orchestration loop
# ============================================================================

main() {
    # Acquire lock (prevent concurrent runs)
    exec 200>"$LOCK_FILE"
    if ! flock -n 200 2>/dev/null; then
        log_stdout "Orchestrator already running. Exiting."
        log "Concurrent run detected. Exiting."
        exit 0
    fi

    init_state

    local start_ts
    start_ts="$(date +%s)"
    local loop_count=0
    local failures_this_session=0

    log "══════════════════════════════════════════════════════════════"
    log "Orchestrator session started (triggered by HOURLY automation)"
    log "Max duration: ${MAX_LOOP_DURATION_SECONDS}s (2 hours)"
    log "State: $(get_status), Last check TS: $(get_last_check_ts)"
    log "══════════════════════════════════════════════════════════════"

    log_stdout "══════════════════════════════════════════════════════"
    log_stdout "  Odysseus 构建编排器启动"
    log_stdout "  状态: $(get_status) | 最大运行时间: 2 小时"
    log_stdout "══════════════════════════════════════════════════════"

    while true; do
        local now_ts
        now_ts="$(date +%s)"
        local elapsed=$((now_ts - start_ts))

        # Check max duration
        if [[ $elapsed -ge $MAX_LOOP_DURATION_SECONDS ]]; then
            log "Max duration (${MAX_LOOP_DURATION_SECONDS}s) reached. Exiting loop."
            log_stdout "⏰ 达到最大运行时间 (2 小时)，等待下次自动化触发"
            break
        fi

        # Check if we should run now
        should_check_now
        local check_result=$?

        case $check_result in
            0)
                # Time to check
                ((loop_count++))
                log "Loop #${loop_count}: Running check..."
                set +e
                run_health_check
                local hc_exit=$?
                set -e

                if [[ $hc_exit -ge 2 ]]; then
                    ((failures_this_session++))
                    local status
                    status="$(get_status)"
                    if [[ "$status" == "critical" ]]; then
                        log "CRITICAL state reached. Stopping loop."
                        log_stdout "⛔ 严重错误 — 停止自动重试，等待人工介入"
                        break
                    fi
                fi

                if [[ $loop_count -ge 4 ]]; then
                    log "Max 4 checks per session. Exiting loop."
                    log_stdout "⏰ 已完成本轮最多 4 次检查，等待下次自动化触发"
                    break
                fi
                ;;
            1)
                # Not time yet — wait and re-evaluate
                # Calculate sleep time: min(check interval, remaining max duration)
                local remaining=$((MAX_LOOP_DURATION_SECONDS - elapsed))
                local sleep_time=60  # Wake every 60 seconds to re-evaluate
                [[ $remaining -lt $sleep_time ]] && sleep_time=$remaining
                [[ $sleep_time -le 0 ]] && break

                log "Waiting ${sleep_time}s before next evaluation..."
                sleep "$sleep_time"
                ;;
            2)
                # Critical — stop
                log_stdout "⛔ 严重错误状态，停止自动检查"
                break
                ;;
        esac
    done

    local total_elapsed=$(( $(date +%s) - start_ts ))
    log "Orchestrator session complete. Total time: ${total_elapsed}s, Loops: ${loop_count}, Failures: ${failures_this_session}"
    log "══════════════════════════════════════════════════════════════"

    log_stdout "══════════════════════════════════════════════════════"
    log_stdout "  编排器运行结束 | 运行时间: ${total_elapsed}s | 检查次数: ${loop_count}"
    log_stdout "══════════════════════════════════════════════════════"

    flock -u 200 2>/dev/null || true

    if [[ "$(get_status)" == "critical" ]]; then
        return 2
    fi
    return 0
}

main "$@"

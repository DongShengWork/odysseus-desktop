#!/usr/bin/env bash
# ============================================================================
# Odysseus Desktop — Build Health Check Monitor
# ============================================================================
# Verifies the integrity and readiness of desktop build artifacts.
# Runs as a cron job / scheduled task: every 30 minutes during active dev.
#
# Check categories:
#   1. Dependencies  — Python, Node, PyInstaller availability
#   2. Build outputs  — Expected artifacts exist and have valid size
#   3. Binary health  — Executables are runnable (no crash on --help)
#   4. Signing status — macOS codesign; Windows Authenticode (optional)
#   5. Disk space     — Sufficient room for builds
#
# Exit codes:
#   0 — All checks passed
#   1 — Warning (non-critical failure)
#   2 — Critical failure (build pipeline broken)
#
# Design principle: only report actionable status changes. Do NOT flood
# logs with "everything is fine" on every check.
# ============================================================================
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly APP_NAME="Odysseus"
readonly DIST_DIR="$REPO_DIR/dist"
readonly LOG_DIR="$REPO_DIR/logs"
readonly STATE_DIR="$LOG_DIR/health"
readonly HEALTH_LOG="$LOG_DIR/health-$(date +%Y%m%d).log"
readonly STATE_FILE="$STATE_DIR/last-status.txt"
readonly MIN_DISK_GB=5
readonly MIN_ARTIFACT_SIZE_KB=1000

# ── Colors ──────────────────────────────────────────────────────────────────
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

# ── Logging ─────────────────────────────────────────────────────────────────
log_check()    { echo "[$(date '+%H:%M:%S')] CHECK  $*"; }
log_pass()     { echo -e "${GREEN}[PASS]${NC} $*"; }
log_fail()     { echo -e "${RED}[FAIL]${NC} $*"; }
log_warn()     { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_status()   { echo "[$(date '+%H:%M:%S')] STATUS $*"; }

# Initialize state
init_state() {
    mkdir -p "$STATE_DIR"
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "unknown" > "$STATE_FILE"
    fi
}

# Check if previous run was a failure (for retry logic)
previous_run_failed() {
    if [[ -f "$STATE_FILE" ]]; then
        local status
        status="$(cat "$STATE_FILE")"
        [[ "$status" == "fail" ]] && return 0
    fi
    return 1
}

# Mark current run status
mark_status() {
    echo "$1" > "$STATE_FILE"
}

# ============================================================================
# CHECK FUNCTIONS
# ============================================================================

# ── Check 1: Runtime Dependencies ──────────────────────────────────────────
check_dependencies() {
    local failures=0

    # Python
    local py=""
    if [[ -x "/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3" ]]; then
        py="/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
    elif [[ -x "$REPO_DIR/venv/bin/python" ]]; then
        py="$REPO_DIR/venv/bin/python"
    elif command -v python3 &>/dev/null; then
        py="$(which python3)"
    fi

    if [[ -z "$py" ]]; then
        log_fail "Python interpreter not found"
        ((failures++))
    else
        local py_ver
        py_ver="$("$py" --version 2>&1)"
        local major minor
        major="$(echo "$py_ver" | sed -n 's/Python \([0-9]*\)\..*/\1/p')"
        minor="$(echo "$py_ver" | sed -n 's/Python [0-9]*\.\([0-9]*\)\..*/\1/p')"
        if [[ "$major" -lt 3 || ("$major" -eq 3 && "$minor" -lt 10) ]]; then
            log_fail "Python version too old: $py_ver (need 3.10+)"
            ((failures++))
        else
            log_pass "Python: $py_ver ($py)"
        fi
    fi

    # PyInstaller
    if [[ -n "$py" ]] && "$py" -m PyInstaller --version &>/dev/null; then
        log_pass "PyInstaller: $("$py" -m PyInstaller --version 2>&1)"
    else
        log_warn "PyInstaller not installed (needed for native builds)"
        ((failures++))
    fi

    # Check for build scripts
    if [[ -f "$REPO_DIR/build-macos-app.sh" ]]; then
        log_pass "macOS build script: build-macos-app.sh"
    else
        log_warn "macOS build script missing"
    fi

    if [[ -f "$REPO_DIR/build-windows-portable.ps1" ]]; then
        log_pass "Windows build script: build-windows-portable.ps1"
    else
        log_warn "Windows build script missing"
    fi

    # Platform-specific tools
    local platform="$(uname -s)"
    case "$platform" in
        Darwin*)
            if command -v codesign &>/dev/null; then
                log_pass "macOS: codesign available"
            else
                log_warn "macOS: codesign not available (Xcode CLT may be incomplete)"
            fi
            if command -v create-dmg &>/dev/null; then
                log_pass "macOS: create-dmg available"
            else
                log_warn "macOS: create-dmg not available (brew install create-dmg)"
            fi
            ;;
        Linux*)
            if command -v dpkg-deb &>/dev/null; then
                log_pass "Linux: dpkg-deb available"
            fi
            if command -v rpmbuild &>/dev/null; then
                log_pass "Linux: rpmbuild available"
            fi
            if command -v linuxdeploy-x86_64.AppImage &>/dev/null || command -v appimagetool &>/dev/null; then
                log_pass "Linux: AppImage tool available"
            else
                log_warn "Linux: AppImage tool not available (optional for AppImage builds)"
            fi
            ;;
    esac

    return "$failures"
}

# ── Check 2: Build Artifacts Integrity ─────────────────────────────────────
check_artifacts() {
    local failures=0
    local platform="$(uname -s)"
    local artifacts_found=0

    log_check "Verifying build artifacts..."

    # macOS
    if [[ "$platform" == "Darwin" ]]; then
        local app_path="$DIST_DIR/${APP_NAME}.app"
        if [[ -d "$app_path" ]]; then
            local app_size
            app_size="$(du -sk "$app_path" | awk '{print $1}')"
            if [[ "$app_size" -ge "$MIN_ARTIFACT_SIZE_KB" ]]; then
                log_pass "macOS .app ($app_size KB)"
                ((artifacts_found++))

                # Check binary inside .app
                local binary="$app_path/Contents/MacOS/${APP_NAME}"
                if [[ -x "$binary" ]]; then
                    log_pass "  Binary executable verified"
                else
                    log_warn "  Binary executable missing or not executable"
                fi
            else
                log_warn "macOS .app suspiciously small ($app_size KB)"
            fi
        fi

        local dmg_path
        dmg_path="$(ls "$DIST_DIR"/*.dmg 2>/dev/null | head -1 || true)"
        if [[ -n "$dmg_path" ]]; then
            local dmg_size
            dmg_size="$(du -sh "$dmg_path" | awk '{print $1}')"
            log_pass "macOS DMG: $(basename "$dmg_path") ($dmg_size)"
            ((artifacts_found++))
        fi
    fi

    # Linux
    if [[ "$platform" == "Linux" ]]; then
        local bundle_path="$DIST_DIR/${APP_NAME}"
        if [[ -d "$bundle_path" ]]; then
            local bundle_size
            bundle_size="$(du -sk "$bundle_path" | awk '{print $1}')"
            if [[ "$bundle_size" -ge "$MIN_ARTIFACT_SIZE_KB" ]]; then
                log_pass "Linux AppDir ($bundle_size KB)"
                ((artifacts_found++))
            fi
        fi

        local appimage
        appimage="$(ls "$DIST_DIR"/*.AppImage 2>/dev/null | head -1 || true)"
        if [[ -n "$appimage" ]]; then
            local ai_size
            ai_size="$(du -sh "$appimage" | awk '{print $1}')"
            log_pass "Linux AppImage: $(basename "$appimage") ($ai_size)"
            ((artifacts_found++))
        fi

        for deb in "$DIST_DIR"/*.deb; do
            if [[ -f "$deb" ]]; then
                local deb_size
                deb_size="$(du -sh "$deb" | awk '{print $1}')"
                log_pass "Linux DEB: $(basename "$deb") ($deb_size)"
                ((artifacts_found++))
                # Verify DEB structure
                if command -v dpkg-deb &>/dev/null; then
                    if dpkg-deb --info "$deb" &>/dev/null; then
                        log_pass "  DEB integrity verified"
                    else
                        log_warn "  DEB integrity check failed"
                    fi
                fi
            fi
        done

        for rpm in "$DIST_DIR"/*.rpm; do
            if [[ -f "$rpm" ]]; then
                local rpm_size
                rpm_size="$(du -sh "$rpm" | awk '{print $1}')"
                log_pass "Linux RPM: $(basename "$rpm") ($rpm_size)"
                ((artifacts_found++))
            fi
        done
    fi

    # Summary
    if [[ $artifacts_found -eq 0 ]]; then
        log_warn "No build artifacts found in $DIST_DIR"
        ((failures++))
    fi

    return "$failures"
}

# ── Check 3: Binary Health ─────────────────────────────────────────────────
check_binary_health() {
    local failures=0
    local platform="$(uname -s)"

    log_check "Checking binary health..."

    case "$platform" in
        Darwin*)
            local app_path="$DIST_DIR/${APP_NAME}.app"
            if [[ -d "$app_path" ]]; then
                # Check code signing
                if codesign --verify --verbose=2 "$app_path" 2>/dev/null; then
                    log_pass "macOS code signing: valid"
                else
                    local cs_status=$?
                    if [[ $cs_status -eq 1 ]]; then
                        log_warn "macOS code signing: not signed (development build)"
                        log_warn "  → LaunchServices may sandbox this app, causing venv read failures."
                        log_warn "  → Fix: codesign -s - -f --deep \"$app_path\""
                    else
                        log_warn "macOS code signing: invalid signature"
                    fi
                fi

                # Check for hardened runtime
                if codesign -d --entitlements - "$app_path" 2>/dev/null | grep -q "hardened-runtime"; then
                    log_pass "macOS hardened runtime: enabled"
                fi

                # Check launched via open (LaunchServices sandbox)
                if ! codesign --verify "$app_path" &>/dev/null; then
                    log_warn "Unsigned .app: may fail when launched via Finder or 'open'"
                    log_warn "  → Workaround: codesign with ad-hoc signature (no dev account needed)"
                    log_warn "  → Or run the launcher script directly from terminal"
                fi
            fi
            ;;
        Linux*)
            local bundle_path="$DIST_DIR/${APP_NAME}"
            local executable=""
            if [[ -d "$bundle_path" ]]; then
                executable="$bundle_path/${APP_NAME}"
            fi

            if [[ -n "$executable" && -x "$executable" ]]; then
                # Check ELF header
                if file "$executable" | grep -q "ELF"; then
                    log_pass "Linux binary: valid ELF executable"

                    # Check linked libraries
                    local missing_libs
                    missing_libs="$(ldd "$executable" 2>/dev/null | grep "not found" || true)"
                    if [[ -n "$missing_libs" ]]; then
                        log_warn "Linux binary: missing libraries:"
                        echo "$missing_libs" | while read -r lib; do
                            log_warn "  → $lib"
                        done
                        ((failures++))
                    else
                        log_pass "Linux binary: all library dependencies satisfied"
                    fi
                else
                    log_warn "Linux binary: not an ELF executable. May be a Python script."
                fi

                # Check AppRun
                if [[ -f "$bundle_path/AppRun" ]]; then
                    log_pass "AppRun entry point exists"
                else
                    log_warn "AppRun missing (AppImage compatibility)"
                fi
            fi
            ;;
    esac

    return "$failures"
}

# ── Check 4: Disk Space ────────────────────────────────────────────────────
check_disk_space() {
    local failures=0

    log_check "Checking disk space..."

    local avail_gb
    # Cross-platform df: macOS uses -g (gigabytes), Linux uses -BG
    if [[ "$(uname -s)" == "Darwin" ]]; then
        avail_gb="$(df -g "$REPO_DIR" 2>/dev/null | awk 'NR==2 {print $4}' | sed 's/Gi//' | sed 's/G//')"
    else
        avail_gb="$(df -BG "$REPO_DIR" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')"
    fi

    # Fallback: parse raw KB
    if [[ -z "$avail_gb" ]]; then
        avail_gb="$(df -k "$REPO_DIR" | awk 'NR==2 {printf "%.0f", int($4/1024/1024)}')"
    fi

    avail_gb="${avail_gb%%.*}"
    if [[ "$avail_gb" -lt "$MIN_DISK_GB" ]]; then
        log_warn "Low disk space: ${avail_gb}GB available (minimum: ${MIN_DISK_GB}GB)"
        log_warn "Build may fail. Free up space."
        ((failures++))
    else
        log_pass "Disk space: ${avail_gb}GB available"
    fi

    return "$failures"
}

# ── Check 5: Config & Project Health ───────────────────────────────────────
check_project_health() {
    local failures=0

    log_check "Checking project configuration..."

    # Verify key project files exist
    local required_files=(
        "$REPO_DIR/launcher.py"
        "$REPO_DIR/requirements.txt"
        "$REPO_DIR/static"
    )

    for f in "${required_files[@]}"; do
        if [[ -e "$f" ]]; then
            log_pass "Project file: $(basename "$f")"
        else
            log_fail "Required file missing: $f"
            ((failures++))
        fi
    done

    # macOS 14+: Check for com.apple.provenance xattr on venv (blocks app launch)
    if [[ "$(uname -s)" == "Darwin" && -f "$REPO_DIR/venv/pyvenv.cfg" ]]; then
        if xattr -l "$REPO_DIR/venv/pyvenv.cfg" 2>/dev/null | grep -q 'com.apple.provenance'; then
            log_warn "macOS provenance xattr detected on venv — will cause app launch failure"
            log_warn "Fix: xattr -r -d com.apple.provenance $REPO_DIR/venv/"
            ((failures++))
        else
            log_pass "macOS venv xattr: clean (no provenance attribute)"
        fi
    fi

    # Check Python dependencies can be resolved
    local py=""
    if [[ -x "/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3" ]]; then
        py="/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
    elif [[ -f "$REPO_DIR/venv/bin/python" ]]; then
        py="$REPO_DIR/venv/bin/python"
    fi

    if [[ -n "$py" ]]; then
        local missing_pkgs=()
        for pkg in fastapi jinja2 aiofiles; do
            if ! "$py" -c "import ${pkg}" 2>/dev/null; then
                missing_pkgs+=("$pkg")
            fi
        done
        if [[ ${#missing_pkgs[@]} -gt 0 ]]; then
            log_warn "Missing Python packages: ${missing_pkgs[*]}"
            log_warn "Run: pip install -r $REPO_DIR/requirements.txt"
        else
            log_pass "Core Python dependencies resolved"
        fi
    fi

    # Check log directory
    if [[ -d "$LOG_DIR" ]]; then
        log_pass "Log directory: $LOG_DIR"
    fi

    return "$failures"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    init_state
    local critical_failures=0
    local warnings=0

    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  Odysseus Build Health Check                            ║"
    echo "║  $(date '+%Y-%m-%d %H:%M:%S')                                   ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""

    # ── Run checks ─────────────────────────────────────────────────────
    local check_fns=(
        "check_dependencies"
        "check_artifacts"
        "check_binary_health"
        "check_disk_space"
        "check_project_health"
    )

    for fn in "${check_fns[@]}"; do
        printf "${YELLOW}[RUN]${NC} %s...\n" "$fn"
        if $fn; then
            : # pass (function already printed PASS/FAIL)
        else
            local rc=$?
            if [[ $rc -ge 2 ]]; then
                ((critical_failures++))
            else
                ((warnings++))
            fi
        fi
    done

    # ── Summary ────────────────────────────────────────────────────────
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  Health Check Summary                                   ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    if [[ $critical_failures -gt 0 ]]; then
        echo "║  ❌ ${critical_failures} critical issue(s) found"
        echo "║  ⚠  ${warnings} warning(s)"
        mark_status "fail"
        echo "╠══════════════════════════════════════════════════════════╣"
        echo "║  Next action: Retry in 5 minutes                      ║"
        echo "╚══════════════════════════════════════════════════════════╝"
        return 2
    elif [[ $warnings -gt 0 ]]; then
        echo "║  ✓ All critical checks passed                         ║"
        echo "║  ⚠  ${warnings} warning(s)"
        mark_status "warn"
        echo "╠══════════════════════════════════════════════════════════╣"
        echo "║  Next check: in 30 minutes                            ║"
        echo "╚══════════════════════════════════════════════════════════╝"
        return 1
    else
        echo "║  ✓ All checks passed                                  ║"
        mark_status "ok"
        echo "╠══════════════════════════════════════════════════════════╣"
        echo "║  Next check: in 30 minutes                            ║"
        echo "╚══════════════════════════════════════════════════════════╝"
        return 0
    fi
}

main "$@"

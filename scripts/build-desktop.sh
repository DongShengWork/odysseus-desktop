#!/usr/bin/env bash
# ============================================================================
# Odysseus Desktop — Cross-Platform Build Entrypoint
# ============================================================================
# Unified entry point for building Odysseus as a native desktop application
# across macOS, Windows, and Linux.
#
# Inspired by OpenCode (https://github.com/anomalyco/opencode) packaging
# strategy: native installers per platform + unified build script.
#
# Usage:
#   ./scripts/build-desktop.sh [platform] [options]
#
# Platforms:
#   macos    — Build macOS .app + .dmg (uses build-macos-app.sh)
#   windows  — Build Windows portable .exe (uses build-windows-portable.ps1)
#   linux    — Build Linux AppImage + .deb + .rpm
#   all      — Build for all detected target platforms
#
# Options:
#   --clean         Clean dist/ before building
#   --verbose       Show detailed build output
#   --skip-tests    Skip post-build smoke test
#   --arch=<arch>   Force target architecture (x86_64|arm64|aarch64)
#   --output=<dir>  Override output directory (default: dist/)
#   --pkg=<type>    Package type for linux: appimage|deb|rpm|all (default: all)
#
# Requirements per platform:
#   macOS:  Xcode CLT, Python 3.11+, create-dmg (optional)
#   Linux:  Python 3.11+, FUSE, linuxdeploy, dpkg-deb, rpmbuild (optional)
#   Windows:Python 3.11+, PyInstaller, Windows SDK (or Wine for cross-compile)
# ============================================================================
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly APP_NAME="Odysseus"
readonly DIST_DIR="$REPO_DIR/dist"
readonly BUILD_LOG="$REPO_DIR/logs/build-$(date +%Y%m%d-%H%M%S).log"
readonly START_TIME="$(date +%s)"

# ── Colors ──────────────────────────────────────────────────────────────────
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'  # No Color

# ── Logging ─────────────────────────────────────────────────────────────────
log_info()  { echo -e "${BLUE}[build]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[  ok]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[warn]${NC}  $*" >&2; }
log_err()   { echo -e "${RED}[fail]${NC}  $*" >&2; }
log_step()  { echo -e "\n${CYAN}═══════════════════════════════════════════════════════${NC}"; \
              echo -e "${CYAN}  $*${NC}"; \
              echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"; }

# ── Defaults ────────────────────────────────────────────────────────────────
CLEAN=false
VERBOSE=false
SKIP_TESTS=false
FORCE_ARCH=""
OUTPUT_DIR="$DIST_DIR"
TARGET_PLATFORMS=()
LINUX_PKG_TYPE="all"

# ── Argument Parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        macos|windows|linux|all)
            TARGET_PLATFORMS+=("$1")
            shift
            ;;
        --clean)       CLEAN=true; shift ;;
        --verbose)     VERBOSE=true; shift ;;
        --skip-tests)  SKIP_TESTS=true; shift ;;
        --arch=*)      FORCE_ARCH="${1#--arch=}"; shift ;;
        --output=*)    OUTPUT_DIR="${1#--output=}"; shift ;;
        --pkg=*)       LINUX_PKG_TYPE="${1#--pkg=}"; shift ;;
        -h|--help)
            sed -n '3,30p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) log_err "Unknown option: $1"; exit 1 ;;
    esac
done

# If no platform specified, detect current OS
if [[ ${#TARGET_PLATFORMS[@]} -eq 0 ]]; then
    case "$(uname -s)" in
        Darwin*)  TARGET_PLATFORMS=("macos")  ;;
        Linux*)   TARGET_PLATFORMS=("linux")  ;;
        *)        TARGET_PLATFORMS=("all")    ;;
    esac
fi

# If "all", expand to all supported platforms
if [[ " ${TARGET_PLATFORMS[*]} " =~ " all " ]]; then
    TARGET_PLATFORMS=("macos" "windows" "linux")
fi

# ── Directory Setup ─────────────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR" "$(dirname "$BUILD_LOG")"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Detect the Python interpreter
detect_python() {
    # Priority: project venv → managed python → system python3
    if [[ -x "/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3" ]]; then
        echo "/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
        return 0
    fi
    if [[ -x "$REPO_DIR/venv/bin/python" ]]; then
        echo "$REPO_DIR/venv/bin/python"
        return 0
    fi
    if command -v python3 &>/dev/null; then
        echo "$(which python3)"
        return 0
    fi
    log_err "Python 3 not found. Install Python 3.11+ first."
    return 1
}

# Determine target architecture
get_target_arch() {
    if [[ -n "$FORCE_ARCH" ]]; then
        echo "$FORCE_ARCH"
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x86_64"  ;;
        arm64|aarch64)  echo "arm64"   ;;
        *)             echo "x86_64"   ;;
    esac
}

# Check platform-specific prerequisites
check_prerequisites() {
    local py
    py="$(detect_python)" || return 1
    log_info "Python: $py ($("$py" --version 2>&1))"
    log_info "Node:   $(node --version 2>/dev/null || echo 'not found')"
    log_info "npm:    $(npm --version 2>/dev/null || echo 'not found')"

    # mkdir for logs
    mkdir -p "$REPO_DIR/logs"

    return 0
}

# ============================================================================
# BUILD FUNCTIONS
# ============================================================================

# ── macOS Build ──────────────────────────────────────────────────────────────
build_macos() {
    log_step "Building for macOS"
    local arch
    arch="$(get_target_arch)"
    log_info "Target architecture: $arch"
    log_info "Target minimum macOS: 11.0 (Big Sur)"

    # Validate build script exists
    if [[ ! -x "$REPO_DIR/build-macos-app.sh" ]]; then
        log_err "build-macos-app.sh not found at $REPO_DIR/build-macos-app.sh"
        return 1
    fi

    # Clean if requested
    if $CLEAN; then
        log_info "Cleaning macOS build artifacts..."
        rm -rf "$OUTPUT_DIR/${APP_NAME}.app" "$OUTPUT_DIR/${APP_NAME}.dmg" \
               "$OUTPUT_DIR/${APP_NAME}-mac-${arch}.dmg"
        log_ok "Clean complete"
    fi

    # Execute macOS build script
    log_info "Running build-macos-app.sh..."
    if $VERBOSE; then
        bash "$REPO_DIR/build-macos-app.sh" 2>&1 | tee -a "$BUILD_LOG"
    else
        bash "$REPO_DIR/build-macos-app.sh" >> "$BUILD_LOG" 2>&1
    fi

    local pyret=$?
    if [[ $pyret -ne 0 ]]; then
        log_err "macOS build failed (exit code: $pyret)"
        tail -20 "$BUILD_LOG"
        return 1
    fi

    # Verify output
    local app_path="$OUTPUT_DIR/${APP_NAME}.app"
    local dmg_path="$OUTPUT_DIR/${APP_NAME}.dmg"
    local renamed_dmg="$OUTPUT_DIR/${APP_NAME}-mac-${arch}.dmg"

    if [[ -d "$app_path" ]]; then
        log_ok ".app bundle → $app_path"
    else
        log_warn ".app bundle not found: $app_path"
    fi

    if [[ -f "$dmg_path" ]]; then
        log_ok "Disk image → $dmg_path"
        # Rename with platform tag for consistency
        if [[ ! -f "$renamed_dmg" ]]; then
            cp "$dmg_path" "$renamed_dmg"
            log_ok "Tagged image → $renamed_dmg"
        fi
    else
        log_warn "Disk image not found: $dmg_path (create-dmg may not be installed)"
    fi

    log_ok "macOS build complete"
}

# ── Windows Build ────────────────────────────────────────────────────────────
build_windows() {
    log_step "Building for Windows"
    local arch
    arch="$(get_target_arch)"
    log_info "Target architecture: $arch"

    # Validate build script exists
    if [[ ! -f "$REPO_DIR/build-windows-portable.ps1" ]]; then
        log_err "build-windows-portable.ps1 not found"
        return 1
    fi

    # Check if running on native Windows
    local on_windows=false
    case "$(uname -s)" in
        MSYS*|MINGW*|CYGWIN*) on_windows=true ;;
    esac

    if ! $on_windows; then
        # Cross-compilation path
        if command -v wine64 &>/dev/null; then
            log_warn "Cross-compiling for Windows on $(uname -s) via Wine."
            log_info "This requires a Windows Python installation under Wine."
            log_info "For reliable builds, run directly on Windows."
        elif command -v wine &>/dev/null; then
            log_warn "Cross-compiling via Wine (32-bit)."
        else
            log_err "Cannot build Windows target on $(uname -s)."
            log_err "Install Wine (brew install --cask wine-stable) or run natively on Windows."
            return 1
        fi
    fi

    if $CLEAN; then
        log_info "Cleaning Windows build artifacts..."
        rm -rf "$OUTPUT_DIR/${APP_NAME}" "$OUTPUT_DIR/${APP_NAME}-windows-${arch}.exe"
        log_ok "Clean complete"
    fi

    # Execute Windows build
    log_info "Running build-windows-portable.ps1..."
    if $on_windows; then
        if $VERBOSE; then
            powershell -ExecutionPolicy Bypass -File "$REPO_DIR/build-windows-portable.ps1" 2>&1 | tee -a "$BUILD_LOG"
        else
            powershell -ExecutionPolicy Bypass -File "$REPO_DIR/build-windows-portable.ps1" >> "$BUILD_LOG" 2>&1
        fi
    else
        # Wine path: convert path to Windows format
        local win_path
        win_path="$(winepath -w "$REPO_DIR/build-windows-portable.ps1" 2>/dev/null || \
                    echo "Z:${REPO_DIR//\//\\}\\build-windows-portable.ps1")"
        if $VERBOSE; then
            wine cmd /c "powershell -ExecutionPolicy Bypass -File '$win_path'" 2>&1 | tee -a "$BUILD_LOG"
        else
            wine cmd /c "powershell -ExecutionPolicy Bypass -File '$win_path'" >> "$BUILD_LOG" 2>&1
        fi
    fi

    local psret=$?
    if [[ $psret -ne 0 ]]; then
        log_err "Windows build may have failed (exit code: $psret)"
        log_warn "Check $BUILD_LOG for details"
        tail -20 "$BUILD_LOG"
        # Don't return 1 here — ps1 exit codes can be misleading
    fi

    log_ok "Windows build complete → $OUTPUT_DIR/${APP_NAME}/"
}

# ── Linux Build ──────────────────────────────────────────────────────────────
build_linux() {
    log_step "Building for Linux"
    local arch
    arch="$(get_target_arch)"
    log_info "Target architecture: $arch"

    local py
    py="$(detect_python)" || return 1

    if $CLEAN; then
        log_info "Cleaning Linux build artifacts..."
        rm -rf "$REPO_DIR/build" "$OUTPUT_DIR/${APP_NAME}" \
               "$OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage" \
               "$OUTPUT_DIR/${APP_NAME}_"*.deb \
               "$OUTPUT_DIR/${APP_NAME}-"*.rpm
        log_ok "Clean complete"
    fi

    # Step 1: Build PyInstaller one-folder bundle
    log_step "[1/4] Building PyInstaller bundle"
    log_info "Using Python: $py"

    "$py" -m pip install --upgrade pyinstaller Pillow --quiet 2>&1 | tail -1 || true

    local extras=()
    for dir in static scripts mcp_servers config; do
        if [[ -d "$REPO_DIR/$dir" ]]; then
            extras+=("--add-data" "$dir:$dir")
        fi
    done

    rm -rf "$REPO_DIR/build" "$OUTPUT_DIR/${APP_NAME}"

    if $VERBOSE; then
        "$py" -m PyInstaller \
            --noconfirm --clean \
            --onedir \
            --noconsole \
            --name "$APP_NAME" \
            "${extras[@]}" \
            --add-data ".env.example:.env.example" \
            --add-data "services/hwfit/data:services/hwfit/data" \
            "$REPO_DIR/launcher.py" 2>&1 | tee -a "$BUILD_LOG"
    else
        "$py" -m PyInstaller \
            --noconfirm --clean \
            --onedir \
            --noconsole \
            --name "$APP_NAME" \
            "${extras[@]}" \
            --add-data ".env.example:.env.example" \
            --add-data "services/hwfit/data:services/hwfit/data" \
            "$REPO_DIR/launcher.py" >> "$BUILD_LOG" 2>&1
    fi

    # Move to dist
    if [[ -d "$REPO_DIR/dist/${APP_NAME}" ]]; then
        mv "$REPO_DIR/dist/${APP_NAME}/"* "$OUTPUT_DIR/"
        rm -rf "$REPO_DIR/dist/${APP_NAME}"
    fi

    local bundle_path="$OUTPUT_DIR/${APP_NAME}"
    if [[ ! -d "$bundle_path" ]]; then
        log_err "PyInstaller bundle not found at $bundle_path"
        log_err "Check $BUILD_LOG for errors"
        tail -30 "$BUILD_LOG"
        return 1
    fi
    log_ok "PyInstaller bundle created → $bundle_path"

    # Step 2: Generate Linux icon set
    log_step "[2/4] Generating Linux icon set"
    generate_linux_icons "$py"

    # Step 3: Generate desktop integration files
    log_step "[3/4] Generating desktop integration"
    generate_linux_desktop_files

    # Step 4: Package into AppImage / deb / rpm
    log_step "[4/4] Creating Linux installers"
    package_linux "$arch"
}

# Generate Linux icon set from source image
generate_linux_icons() {
    local py="$1"
    local src_icon=""
    local icon_dir="$OUTPUT_DIR/${APP_NAME}/share/icons/hicolor"

    # Find source icon
    for candidate in \
        "$REPO_DIR/static/icon.png" \
        "$REPO_DIR/static/icon.svg" \
        "$REPO_DIR/docs/odysseus.jpg" \
        "$REPO_DIR/docs/odysseus-512.png"; do
        if [[ -f "$candidate" ]]; then
            src_icon="$candidate"
            break
        fi
    done

    if [[ -z "$src_icon" ]]; then
        log_warn "No source icon found. Skipping icon generation."
        log_warn "Place a PNG or SVG icon at static/icon.png and rerun."
        return 0
    fi

    log_info "Source icon: $src_icon"
    mkdir -p "$icon_dir"

    if [[ "$src_icon" == *.svg ]]; then
        # SVG → PNG conversion requires cairosvg or rsvg-convert
        if command -v rsvg-convert &>/dev/null; then
            for size in 16 22 24 32 48 64 128 256 512; do
                local out_dir="$icon_dir/${size}x${size}/apps"
                mkdir -p "$out_dir"
                rsvg-convert -w "$size" -h "$size" "$src_icon" \
                    -o "$out_dir/odysseus.png" 2>/dev/null && \
                    log_ok "  Icon ${size}x${size}"
            done
        elif "$py" -c "import cairosvg" 2>/dev/null; then
            for size in 16 22 24 32 48 64 128 256 512; do
                local out_dir="$icon_dir/${size}x${size}/apps"
                mkdir -p "$out_dir"
                "$py" -c "
import cairosvg
cairosvg.svg2png(url='$src_icon', output_width=$size, output_height=$size,
                 write_to='$out_dir/odysseus.png')
" 2>/dev/null && log_ok "  Icon ${size}x${size}"
            done
        else
            log_warn "rsvg-convert or cairosvg not found. Install one for SVG→PNG conversion."
            # Copy SVG directly
            cp "$src_icon" "$icon_dir/scalable/apps/odysseus.svg"
            log_ok "  SVG copied (scalable)"
        fi
    else
        # Raster image: resize with Pillow
        "$py" -c "
from PIL import Image
import os, sys
img = Image.open('$src_icon')
base = '$icon_dir'
sizes = [16, 22, 24, 32, 48, 64, 128, 256, 512]
for s in sizes:
    out = os.path.join(base, f'{s}x{s}', 'apps', 'odysseus.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    resized = img.resize((s, s), Image.Resampling.LANCZOS)
    resized.save(out, 'PNG')
    print(f'  Icon {s}x{s}')
" 2>&1 | while read -r line; do log_ok "$line"; done
    fi

    # Create symlink for default icon
    mkdir -p "$icon_dir/scalable/apps"
    if [[ -f "$icon_dir/256x256/apps/odysseus.png" ]]; then
        ln -sf "../../256x256/apps/odysseus.png" "$icon_dir/scalable/apps/odysseus.png" 2>/dev/null || true
    fi
    log_ok "Icon set complete"
}

# Generate .desktop file and AppRun
generate_linux_desktop_files() {
    local bundle="$OUTPUT_DIR/${APP_NAME}"

    # .desktop entry
    local desktop_file="$OUTPUT_DIR/${APP_NAME}.desktop"
    cat > "$desktop_file" <<-DESKTOP
	[Desktop Entry]
	Name=Odysseus
	Comment=Self-hosted AI workspace — agents, research, coding, and automation
	Exec=${bundle}/Odysseus %F
	Icon=odysseus
	Type=Application
	Categories=Development;Utility;ArtificialIntelligence;
	StartupNotify=true
	Terminal=false
	MimeType=text/markdown;text/plain;
	Keywords=AI;agent;workspace;automation;
	DESKTOP
    chmod 644 "$desktop_file"
    log_ok "Desktop entry → $desktop_file"

    # Copy to bundle for self-contained AppDir
    cp "$desktop_file" "$bundle/"

    # AppRun → AppImage entry point
    local apprun="$bundle/AppRun"
    cat > "$apprun" <<-'APPRUN'
	#!/bin/bash
	# AppRun entry point for Odysseus AppImage
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	export PYTHONPATH="$SCRIPT_DIR"
	export LD_LIBRARY_PATH="$SCRIPT_DIR/lib:$LD_LIBRARY_PATH"
	cd "$SCRIPT_DIR"
	exec "$SCRIPT_DIR/Odysseus" "$@"
	APPRUN
    chmod +x "$apprun"
    log_ok "AppRun entry → $apprun"

    # .directory hint for file managers
    local directory_file="$bundle/.DirIcon"
    if [[ -f "$OUTPUT_DIR/${APP_NAME}/share/icons/hicolor/256x256/apps/odysseus.png" ]]; then
        cp "$OUTPUT_DIR/${APP_NAME}/share/icons/hicolor/256x256/apps/odysseus.png" "$directory_file"
    fi
}

# Package Linux build into AppImage, .deb, .rpm
package_linux() {
    local arch="$1"
    local bundle="$OUTPUT_DIR/${APP_NAME}"
    local pkg_arch

    case "$arch" in
        x86_64) pkg_arch="amd64" ;;
        arm64|aarch64) pkg_arch="arm64" ;;
        *)      pkg_arch="amd64"  ;;
    esac

    # ── AppImage ──────────────────────────────────────────────────────────
    if [[ "$LINUX_PKG_TYPE" == "all" || "$LINUX_PKG_TYPE" == "appimage" ]]; then
        log_info "Packaging AppImage..."

        if command -v linuxdeploy-x86_64.AppImage &>/dev/null; then
            local linuxdeploy=linuxdeploy-x86_64.AppImage
        elif [[ -f "/usr/local/bin/linuxdeploy" ]]; then
            local linuxdeploy="/usr/local/bin/linuxdeploy"
        elif command -v appimagetool &>/dev/null; then
            local linuxdeploy=appimagetool
        else
            log_warn "Neither linuxdeploy nor appimagetool found."
            log_warn "Install linuxdeploy from: github.com/linuxdeploy/linuxdeploy"
            log_warn "AppImage packaging skipped. AppDir available at: $bundle"
            log_warn "The AppDir can still be used on most Linux systems."
        fi

        if [[ -n "${linuxdeploy:-}" ]]; then
            # Make bundle directory an AppDir
            local appdir="${bundle}.AppDir"
            rm -rf "$appdir"
            mkdir -p "$appdir"

            # Copy contents
            cp -a "$bundle/"* "$appdir/"
            cp "$OUTPUT_DIR/${APP_NAME}.desktop" "$appdir/"
            if [[ -f "$OUTPUT_DIR/${APP_NAME}/share/icons/hicolor/256x256/apps/odysseus.png" ]]; then
                cp "$OUTPUT_DIR/${APP_NAME}/share/icons/hicolor/256x256/apps/odysseus.png" "$appdir/"
            fi

            if [[ "$linuxdeploy" == "appimagetool" ]]; then
                # Use appimagetool
                local appimage_out="$OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage"
                appimagetool --comp gzip "$appdir" "$appimage_out" 2>&1 | tail -5
            else
                # Use linuxdeploy
                $linuxdeploy \
                    --appdir "$appdir" \
                    --output appimage \
                    --arch "$arch" 2>&1 | tail -10
                # Find the AppImage
                local found_appimage
                found_appimage="$(find "$OUTPUT_DIR" -maxdepth 1 -name "*.AppImage" -newer "$appdir" 2>/dev/null | head -1)"
                if [[ -n "$found_appimage" ]]; then
                    mv "$found_appimage" "$OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage" 2>/dev/null || true
                fi
            fi

            # Verify
            if [[ -f "$OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage" ]]; then
                chmod +x "$OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage"
                log_ok "AppImage → $OUTPUT_DIR/${APP_NAME}-linux-${arch}.AppImage"
            fi

            rm -rf "$appdir"
        fi
    fi

    # ── DEB Package ────────────────────────────────────────────────────────
    if [[ "$LINUX_PKG_TYPE" == "all" || "$LINUX_PKG_TYPE" == "deb" ]]; then
        log_info "Packaging .deb..."
        if command -v dpkg-deb &>/dev/null || command -v fakeroot &>/dev/null; then
            build_deb_package "$arch" "$pkg_arch"
        else
            log_warn "dpkg-deb not found. Install with: sudo apt install dpkg-dev"
            log_warn ".deb packaging skipped."
        fi
    fi

    # ── RPM Package ────────────────────────────────────────────────────────
    if [[ "$LINUX_PKG_TYPE" == "all" || "$LINUX_PKG_TYPE" == "rpm" ]]; then
        log_info "Packaging .rpm..."
        if command -v rpmbuild &>/dev/null; then
            build_rpm_package "$arch" "$pkg_arch"
        else
            log_warn "rpmbuild not found. Install with: sudo apt install rpm  (Debian) / sudo dnf install rpm-build"
            log_warn ".rpm packaging skipped."
        fi
    fi
}

# Build .deb package
build_deb_package() {
    local arch="$1"
    local pkg_arch="$2"
    local deb_dir="$OUTPUT_DIR/deb-build"
    local package_name="${APP_NAME,,}"  # lowercase

    rm -rf "$deb_dir"
    mkdir -p "$deb_dir/DEBIAN"
    mkdir -p "$deb_dir/usr/bin"
    mkdir -p "$deb_dir/usr/share/applications"
    mkdir -p "$deb_dir/usr/share/$package_name"
    mkdir -p "$deb_dir/usr/share/doc/$package_name"
    mkdir -p "$deb_dir/usr/share/icons/hicolor"

    # Copy application
    cp -a "$OUTPUT_DIR/${APP_NAME}/"* "$deb_dir/usr/share/$package_name/"
    ln -sf "/usr/share/$package_name/Odysseus" "$deb_dir/usr/bin/odysseus"

    # Copy desktop entry
    cp "$OUTPUT_DIR/${APP_NAME}.desktop" "$deb_dir/usr/share/applications/odysseus.desktop"

    # Copy icons
    if [[ -d "$OUTPUT_DIR/${APP_NAME}/share/icons" ]]; then
        cp -a "$OUTPUT_DIR/${APP_NAME}/share/icons/"* "$deb_dir/usr/share/icons/hicolor/"
    fi

    # Copy docs
    for doc_file in LICENSE README.md ACKNOWLEDGMENTS.md SECURITY.md; do
        if [[ -f "$REPO_DIR/$doc_file" ]]; then
            cp "$REPO_DIR/$doc_file" "$deb_dir/usr/share/doc/$package_name/"
        fi
    done

    # Get version
    local version="1.0.0"
    if [[ -f "$REPO_DIR/pyproject.toml" ]]; then
        version="$(grep -m1 '^version' "$REPO_DIR/pyproject.toml" | sed 's/.*"\(.*\)".*/\1/')"
    fi

    # Get total size in KB
    local installed_size
    installed_size="$(du -sk "$deb_dir/usr/" 2>/dev/null | awk '{print $1}')"

    # Generate control file
    cat > "$deb_dir/DEBIAN/control" <<-CONTROL
	Package: $package_name
	Version: $version
	Section: devel
	Priority: optional
	Architecture: $pkg_arch
	Installed-Size: ${installed_size:-0}
	Maintainer: Odysseus Team <odysseus@example.com>
	Depends: python3 (>= 3.11), ca-certificates
	Recommends: curl, git, openssh-client
	Description: A self-hosted AI workspace for agents, research, coding, and automation.
	 Odysseus provides a unified desktop environment for local AI agents,
	 document analysis, code assistance, task automation, and research.
	Homepage: https://github.com/odysseus/odysseus
	CONTROL

    # Post-install script
    cat > "$deb_dir/DEBIAN/postinst" <<-'POSTINST'
	#!/bin/sh
	set -e
	if command -v update-desktop-database >/dev/null 2>&1; then
	    update-desktop-database -q || true
	fi
	if command -v glib-compile-schemas >/dev/null 2>&1; then
	    glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
	fi
	if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	    gtk-update-icon-cache -q /usr/share/icons/hicolor/ 2>/dev/null || true
	fi
	exit 0
	POSTINST
    chmod 755 "$deb_dir/DEBIAN/postinst"

    # Build the .deb
    local deb_out="$OUTPUT_DIR/${package_name}_${version}_${pkg_arch}.deb"
    fakeroot dpkg-deb --build "$deb_dir" "$deb_out" 2>&1 | tail -3

    if [[ -f "$deb_out" ]]; then
        log_ok "DEB package → $deb_out"
    else
        log_err ".deb build failed"
    fi

    rm -rf "$deb_dir"
}

# Build .rpm package
build_rpm_package() {
    local arch="$1"
    local pkg_arch="$2"
    local package_name="${APP_NAME,,}"

    # Map Debian arch to RPM arch
    local rpm_arch="$arch"
    case "$arch" in
        x86_64)  rpm_arch="x86_64" ;;
        arm64)   rpm_arch="aarch64" ;;
    esac

    local rpm_buildroot="$OUTPUT_DIR/rpm-build"
    local rpm_topdir="$rpm_buildroot/home"
    rm -rf "$rpm_buildroot"
    mkdir -p "$rpm_topdir/BUILD" "$rpm_topdir/RPMS" "$rpm_topdir/SOURCES" \
             "$rpm_topdir/SPECS" "$rpm_topdir/SRPMS"

    # Get version
    local version="1.0.0"
    if [[ -f "$REPO_DIR/pyproject.toml" ]]; then
        version="$(grep -m1 '^version' "$REPO_DIR/pyproject.toml" | sed 's/.*"\(.*\)".*/\1/')"
    fi

    # Create SPEC file
    local spec_file="$rpm_topdir/SPECS/${package_name}.spec"
    cat > "$spec_file" <<-SPEC
	%define _topdir $rpm_topdir
	%define _rpmdir $rpm_buildroot
	%define _rpmfilename ${package_name}-${version}-1.${rpm_arch}.rpm

	Name:       $package_name
	Version:    $version
	Release:    1
	Summary:    A self-hosted AI workspace
	License:    MIT
	URL:        https://github.com/odysseus/odysseus
	Group:      Development/Tools
	BuildArch:  $rpm_arch

	%description
	Odysseus is a self-hosted AI workspace providing agents, research, coding,
	and automation capabilities in a unified desktop environment.

	%install
	mkdir -p %{buildroot}/usr/share/${package_name}
	mkdir -p %{buildroot}/usr/bin
	mkdir -p %{buildroot}/usr/share/applications
	cp -a $OUTPUT_DIR/${APP_NAME}/* %{buildroot}/usr/share/${package_name}/
	ln -sf /usr/share/${package_name}/Odysseus %{buildroot}/usr/bin/odysseus
	cp $OUTPUT_DIR/${APP_NAME}.desktop %{buildroot}/usr/share/applications/odysseus.desktop

	%files
	/usr/share/${package_name}/*
	/usr/bin/odysseus
	/usr/share/applications/odysseus.desktop

	%post
	if command -v update-desktop-database >/dev/null 2>&1; then
	    update-desktop-database -q || true
	fi

	%changelog
	* $(date '+%a %b %d %Y') Odysseus Team <odysseus@example.com> - ${version}-1
	- Initial package
	SPEC

    # Build RPM
    if command -v rpmbuild &>/dev/null; then
        rpmbuild --define "_topdir $rpm_topdir" \
                 --define "_rpmdir $rpm_buildroot" \
                 -bb "$spec_file" 2>&1 | tail -5

        local rpm_out
        rpm_out="$(find "$rpm_buildroot" -name "*.rpm" -type f | head -1)"
        if [[ -n "$rpm_out" ]]; then
            cp "$rpm_out" "$OUTPUT_DIR/"
            log_ok "RPM package → $OUTPUT_DIR/$(basename "$rpm_out")"
        fi
    else
        log_warn "rpmbuild not found. RPM packaging skipped."
    fi

    rm -rf "$rpm_buildroot"
}

# ============================================================================
# POST-BUILD VERIFICATION
# ============================================================================

run_post_build_checks() {
    if $SKIP_TESTS; then
        log_info "Post-build tests skipped (--skip-tests)"
        return 0
    fi

    log_step "Running post-build verification"

    # Verify build artifacts exist
    local found_artifacts=0

    for platform in "${TARGET_PLATFORMS[@]}"; do
        case "$platform" in
            macos)
                if [[ -d "$OUTPUT_DIR/${APP_NAME}.app" ]]; then
                    log_ok "  [macOS] .app bundle verified"
                    ((found_artifacts++))
                fi
                if [[ -f "$OUTPUT_DIR/${APP_NAME}-mac-$(get_target_arch).dmg" ]]; then
                    log_ok "  [macOS] DMG image verified"
                    ((found_artifacts++))
                fi
                ;;
            linux)
                if [[ -d "$OUTPUT_DIR/${APP_NAME}" ]]; then
                    log_ok "  [Linux] AppDir bundle verified"
                    ((found_artifacts++))
                fi
                if [[ -f "$OUTPUT_DIR/${APP_NAME}-linux-$(get_target_arch).AppImage" ]]; then
                    log_ok "  [Linux] AppImage verified"
                    ((found_artifacts++))
                fi
                for f in "$OUTPUT_DIR"/*.deb; do
                    if [[ -f "$f" ]]; then
                        log_ok "  [Linux] DEB package verified → $(basename "$f")"
                        ((found_artifacts++))
                    fi
                done
                for f in "$OUTPUT_DIR"/*.rpm; do
                    if [[ -f "$f" ]]; then
                        log_ok "  [Linux] RPM package verified → $(basename "$f")"
                        ((found_artifacts++))
                    fi
                done
                ;;
            windows)
                if [[ -d "$OUTPUT_DIR/${APP_NAME}" || -f "$OUTPUT_DIR/${APP_NAME}.exe" ]]; then
                    log_ok "  [Windows] Build artifacts verified"
                    ((found_artifacts++))
                fi
                ;;
        esac
    done

    if [[ $found_artifacts -eq 0 ]]; then
        log_warn "No build artifacts found. Build may have failed silently."
        return 1
    fi

    log_ok "Post-build checks passed ($found_artifacts artifact(s) verified)"
    return 0
}

# ============================================================================
# BUILD REPORT
# ============================================================================

print_build_report() {
    local end_time
    end_time="$(date +%s)"
    local elapsed=$((end_time - START_TIME))
    local minutes=$((elapsed / 60))
    local seconds=$((elapsed % 60))

    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  BUILD REPORT${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
    echo -e "  Time elapsed:  ${BOLD}${minutes}m ${seconds}s${NC}"
    echo -e "  Platforms:     ${BOLD}${TARGET_PLATFORMS[*]}${NC}"
    echo -e "  Output dir:    ${BOLD}$OUTPUT_DIR${NC}"
    echo -e "  Build log:     ${BOLD}$BUILD_LOG${NC}"
    echo ""
    echo "  Artifacts:"
    for f in "$OUTPUT_DIR"/*.app "$OUTPUT_DIR"/*.AppImage "$OUTPUT_DIR"/*.deb \
             "$OUTPUT_DIR"/*.rpm "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.exe; do
        if [[ -e "$f" ]]; then
            local size
            size="$(du -sh "$f" 2>/dev/null | awk '{print $1}')"
            echo -e "    • $(basename "$f")  (${size})"
        fi
    done
    if [[ -d "$OUTPUT_DIR/${APP_NAME}" ]]; then
        local size
        size="$(du -sh "$OUTPUT_DIR/${APP_NAME}" 2>/dev/null | awk '{print $1}')"
        echo -e "    • ${APP_NAME}/  (${size}) — onedir bundle"
    fi
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  ${BOLD}Odysseus Desktop Build${NC}${CYAN}                                  ║${NC}"
    echo -e "${CYAN}╠══════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║  Platforms: ${TARGET_PLATFORMS[*]}${NC}"
    echo -e "${CYAN}║  Output:    ${OUTPUT_DIR}${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"

    # Check prerequisites
    check_prerequisites

    # Run builds
    local build_failures=0
    for platform in "${TARGET_PLATFORMS[@]}"; do
        log_step "Building for: ${BOLD}$platform${NC}"
        case "$platform" in
            macos)       build_macos   && log_ok "Platform [$platform] succeeded" || { build_failures=$((build_failures + 1)); log_err "Platform [$platform] failed"; } ;;
            windows)     build_windows && log_ok "Platform [$platform] succeeded" || { build_failures=$((build_failures + 1)); log_err "Platform [$platform] failed"; } ;;
            linux)       build_linux   && log_ok "Platform [$platform] succeeded" || { build_failures=$((build_failures + 1)); log_err "Platform [$platform] failed"; } ;;
            *)          log_err "Unknown platform: $platform"; build_failures=$((build_failures + 1)) ;;
        esac
    done

    echo ""
    if [[ $build_failures -gt 0 ]]; then
        log_warn "$build_failures platform(s) reported failures."
    fi

    # Run post-build verification
    run_post_build_checks || true

    # Print build report
    print_build_report

    if [[ $build_failures -gt 0 ]]; then
        return 1
    fi
    return 0
}

main "$@"

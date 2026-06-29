#!/usr/bin/env bash
# ============================================================================
# Odysseus — Standalone macOS .app Builder
# ============================================================================
# Builds a truly self-contained macOS .app bundle using PyInstaller.
# The output .app includes Python, all dependencies, and all static assets —
# no dependency on the project directory or venv at runtime.
#
# Output:
#   dist/Odysseus.app   — standalone .app bundle
#   dist/Odysseus.dmg   — disk image for drag-to-Applications install
#
# Requirements:
#   - Xcode Command Line Tools (xcode-select --install)
#   - Python 3.11+
#   - Internet (for first-time pip install)
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Odysseus"
DIST="$REPO_DIR/dist"
BUILD_DIR="$REPO_DIR/build"
LOG="$REPO_DIR/logs/build-standalone.log"
PY_VER="${MACOS_PYTHON:-3.13}"

# Python to use for building — prefer managed, then venv, then system
if [[ -x "/Users/ding/.workbuddy/binaries/python/envs/default/bin/python" ]]; then
  PY="/Users/ding/.workbuddy/binaries/python/envs/default/bin/python"
elif [[ -x "/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3" ]]; then
  PY="/Users/ding/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
elif [[ -x "/Users/ding/.workbuddy/binaries/python/envs/default/bin/python3" ]]; then
  PY="/Users/ding/.workbuddy/binaries/python/envs/default/bin/python3"
elif [[ -x "$REPO_DIR/venv/bin/python" ]]; then
  PY="$REPO_DIR/venv/bin/python"
else
  PY="$(command -v python3)"
fi

echo "Odysseus — Standalone macOS App Builder"
echo "========================================"
echo "  Python:    $($PY --version 2>&1) ($PY)"
echo "  Output:    $DIST/$APP_NAME.app"
echo ""

mkdir -p "$DIST" "$(dirname "$LOG")"

# ── Step 1: Install project dependencies inside the build venv ────────────
echo ""
echo "[1/5] Installing project dependencies..."
$PY -m pip install --quiet -r "$REPO_DIR/requirements.txt" 2>&1 | tail -1 || true
# Also install PyInstaller if not already
$PY -m pip install --quiet pyinstaller 2>&1 | tail -1 || true

# ── Step 2: Generate .icns icon ─────────────────────────────────────────
echo ""
echo "[2/5] Generating .icns icon..."
ICON_DIR="$BUILD_DIR/macos-icon"
mkdir -p "$ICON_DIR"
ICONSET="$ICON_DIR/${APP_NAME}.iconset"
mkdir -p "$ICONSET"

# Find source icon
SRC_ICON=""
for candidate in \
  "$REPO_DIR/static/icons/icon-512.png" \
  "$REPO_DIR/static/icons/icon-192.png" \
  "$REPO_DIR/docs/odysseus.jpg"; do
  if [[ -f "$candidate" ]]; then
    SRC_ICON="$candidate"
    break
  fi
done

if [[ -n "$SRC_ICON" ]]; then
  echo "  Source icon: $SRC_ICON"
  # Generate all required .iconset sizes
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$SRC_ICON" \
      --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
    sips -z $((size*2)) $((size*2)) "$SRC_ICON" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$ICON_DIR/${APP_NAME}.icns" 2>&1
  if [[ -f "$ICON_DIR/${APP_NAME}.icns" ]]; then
    echo "  .icns:      $ICON_DIR/${APP_NAME}.icns"
  else
    echo "  .icns:      (iconutil failed, falling back to PNG)"
  fi
else
  echo "  .icns:      (no source icon found)"
fi

# ── Step 3: Build standalone .app with PyInstaller ───────────────────────
echo ""
echo "[3/5] Building standalone .app with PyInstaller..."

# Clean previous build artifacts
rm -rf "$BUILD_DIR" "$DIST/${APP_NAME}.app" "$DIST/${APP_NAME}"

# Build command
PYINSTALLER_CMD=(
  "$PY" -m PyInstaller
  --noconfirm
  --clean
  --windowed                  # macOS .app with no terminal window
  --onedir                    # Directory bundle (not single file)
  --name "$APP_NAME"
  --add-data "static:static"
  --add-data "scripts:scripts"
  --add-data "mcp_servers:mcp_servers"
  --add-data "config:config"
  --add-data "services/hwfit/data:services/hwfit/data"
  --add-data ".env.example:.env.example"
  --hidden-import "uvicorn.logging"
  --hidden-import "uvicorn.loops.auto"
  --hidden-import "uvicorn.protocols.http.auto"
  --collect-all "uvicorn"
)

# Add icon if available
if [[ -f "$ICON_DIR/${APP_NAME}.icns" ]]; then
  PYINSTALLER_CMD+=(--icon "$ICON_DIR/${APP_NAME}.icns")
elif [[ -f "$REPO_DIR/static/icon.ico" ]]; then
  PYINSTALLER_CMD+=(--icon "$REPO_DIR/static/icon.ico")
fi

PYINSTALLER_CMD+=("$REPO_DIR/launcher.py")

# Run PyInstaller
"${PYINSTALLER_CMD[@]}" 2>&1 | tee "$LOG"

# ── Step 4: Post-processing ──────────────────────────────────────────────
echo ""
echo "[4/5] Post-processing .app bundle..."

APP_BUNDLE="$DIST/${APP_NAME}.app"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: .app bundle not found at $APP_BUNDLE"
  echo "Check the build log: $LOG"
  exit 1
fi

# Copy icon into .app bundle (PyInstaller may not have placed it)
if [[ -f "$ICON_DIR/${APP_NAME}.icns" ]]; then
  cp "$ICON_DIR/${APP_NAME}.icns" "$APP_BUNDLE/Contents/Resources/"
  # Override Info.plist to reference the icon
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile ${APP_NAME}" \
    "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string ${APP_NAME}" \
    "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
fi

# Set bundle metadata
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.odysseus.app" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.odysseus.app" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true

/usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_NAME}" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${APP_NAME}" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true

/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 11.0" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable bool true" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool false" \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true

# Strip com.apple.provenance xattr from the bundled Python libs
# (macOS auto-applies this to pip-installed files)
if xattr -l "$APP_BUNDLE" 2>/dev/null | grep -q 'com.apple.provenance'; then
  echo "  xattr:       stripping com.apple.provenance..."
  xattr -r -d com.apple.provenance "$APP_BUNDLE" 2>/dev/null || true
fi

# Remove quarantine if present (from downloads)
if xattr -l "$APP_BUNDLE" 2>/dev/null | grep -q 'com.apple.quarantine'; then
  echo "  xattr:       stripping com.apple.quarantine..."
  xattr -r -d com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true
fi

# Ad-hoc code sign (required for macOS to not sandbox the app)
echo "  codesign:    ad-hoc signing..."
codesign -s - -f --deep "$APP_BUNDLE" 2>&1 | tail -1 || echo "  codesign:    (skipped)"

echo "  size:        $(du -sh "$APP_BUNDLE" | awk '{print $1}')"

# ── Step 5: Package into .dmg ────────────────────────────────────────────
echo ""
echo "[5/5] Packaging .dmg..."

DMG="$DIST/${APP_NAME}.dmg"
rm -f "$DMG"

STAGE="$(mktemp -d)/dmg"
mkdir -p "$STAGE"
cp -R "$APP_BUNDLE" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# Try create-dmg first (gives a nicer result), fallback to hdiutil
if command -v create-dmg &>/dev/null; then
  create-dmg \
    --volname "$APP_NAME" \
    --volicon "$ICON_DIR/${APP_NAME}.icns" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "${APP_NAME}.app" 175 190 \
    --hide-extension "${APP_NAME}.app" \
    --app-drop-link 425 190 \
    "$DMG" \
    "$STAGE" 2>&1 | tail -3
else
  echo "  create-dmg not found. Using basic hdiutil..."
  hdiutil create -volname "$APP_NAME" \
    -srcfolder "$STAGE" \
    -ov -format UDZO \
    "$DMG" >/dev/null 2>&1
fi

rm -rf "$STAGE" "$ICON_DIR"

# Sign the .dmg as well (best practice)
codesign -s - "$DMG" 2>/dev/null || true

echo ""
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo "  Standalone .app: $APP_BUNDLE"
echo "  Installer .dmg:  $DMG"
echo ""
echo "  Size:  $(du -sh "$APP_BUNDLE" | awk '{print $1}') (app)"
echo "         $(du -sh "$DMG" | awk '{print $1}') (dmg)"
echo ""
echo "  To install: open '$DMG' and drag Odysseus to Applications"
echo "  To run:     open '$APP_BUNDLE'"
echo ""
echo "  Note: The .app is fully self-contained. No project dir needed."
echo "========================================"

#!/usr/bin/env bash
# Pip installer for macOS and Linux. Needs nothing installed beforehand:
#
#   curl -fsSL https://raw.githubusercontent.com/vladypiatko-crypto/pip/main/install.sh | bash
#
# It downloads a private copy of Node.js (only used to install Pip's parts), downloads
# Pip, installs Claude Code with Anthropic's official installer if you don't have it,
# adds a "Pip" app/launcher, and starts Pip. Run it again any time to update.
set -euo pipefail

REPO="${PIP_REPO:-vladypiatko-crypto/pip}"
BRANCH="${PIP_BRANCH:-main}"
SOURCE="${PIP_SOURCE:-https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH}"
NODE_VERSION="${PIP_NODE_VERSION:-22.23.4}"
PIP_DIR="${PIP_HOME:-$HOME/.pip-pet}"

say()  { printf '\033[1;35m🐾 %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) plat=darwin ;;
  Linux)  plat=linux ;;
  *) fail "This installer is for macOS and Linux. On Windows, open PowerShell and run: irm https://raw.githubusercontent.com/$REPO/$BRANCH/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Sorry, Pip doesn't support this processor ($(uname -m))." ;;
esac
command -v curl >/dev/null || fail "curl is missing. Install it (e.g. sudo apt install curl) and run this again."
command -v tar  >/dev/null || fail "tar is missing. Install it and run this again."

mkdir -p "$PIP_DIR"

# 1. A private copy of Node.js, so nothing has to be installed system-wide.
if [ ! -x "$PIP_DIR/node/bin/node" ] || [ "$("$PIP_DIR/node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  say "Downloading Node.js $NODE_VERSION…"
  rm -rf "$PIP_DIR/node" "$PIP_DIR/node.tmp"
  mkdir -p "$PIP_DIR/node.tmp"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$plat-$arch.tar.gz" | tar -xz -C "$PIP_DIR/node.tmp" --strip-components=1
  mv "$PIP_DIR/node.tmp" "$PIP_DIR/node"
fi
export PATH="$PIP_DIR/node/bin:$PATH"

# 2. Pip itself. Your settings and custom skins live elsewhere, so updating keeps them.
say "Downloading Pip…"
rm -rf "$PIP_DIR/app.new"
mkdir -p "$PIP_DIR/app.new"
curl -fsSL "$SOURCE" | tar -xz -C "$PIP_DIR/app.new" --strip-components=1
say "Installing Pip's parts (about a minute)…"
(cd "$PIP_DIR/app.new" && npm install --no-audit --no-fund --loglevel=error --update-notifier=false)
rm -rf "$PIP_DIR/app.old"
[ -d "$PIP_DIR/app" ] && mv "$PIP_DIR/app" "$PIP_DIR/app.old"
mv "$PIP_DIR/app.new" "$PIP_DIR/app"
rm -rf "$PIP_DIR/app.old"

# 3. Claude Code: Pip's brain, using your own Claude subscription.
if command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; then
  say "Claude Code is already installed."
else
  say "Installing Claude Code (Anthropic's official installer)…"
  curl -fsSL https://claude.ai/install.sh | bash || fail "Claude Code didn't install. See https://code.claude.com/docs/en/setup"
fi

# 4. A way to start Pip again later.
mkdir -p "$HOME/.local/bin"
if [ "$plat" = darwin ]; then
  ELECTRON="$PIP_DIR/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  LAUNCH_ARGS=""
else
  ELECTRON="$PIP_DIR/app/node_modules/electron/dist/electron"
  LAUNCH_ARGS="--no-sandbox" # per-user installs can't set up Chromium's setuid sandbox
fi
cat > "$HOME/.local/bin/pip-pet" <<EOF
#!/usr/bin/env bash
exec "$ELECTRON" $LAUNCH_ARGS "$PIP_DIR/app" "\$@"
EOF
chmod +x "$HOME/.local/bin/pip-pet"

if [ "$plat" = darwin ]; then
  APPDIR="$HOME/Applications/Pip.app/Contents"
  rm -rf "$HOME/Applications/Pip.app"
  mkdir -p "$APPDIR/MacOS" "$APPDIR/Resources"
  cat > "$APPDIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Pip</string>
  <key>CFBundleIdentifier</key><string>com.vladypiatko.pip</string>
  <key>CFBundleExecutable</key><string>Pip</string>
  <key>CFBundleIconFile</key><string>pip.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
  printf '#!/bin/bash\nexec "%s" "%s"\n' "$ELECTRON" "$PIP_DIR/app" > "$APPDIR/MacOS/Pip"
  chmod +x "$APPDIR/MacOS/Pip"
  sips -s format icns "$PIP_DIR/app/assets/previews/ember.png" --out "$APPDIR/Resources/pip.icns" >/dev/null 2>&1 || true
  LAUNCH=(open "$HOME/Applications/Pip.app")
else
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/pip-pet.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pip
Comment=Your 3D desktop pet, powered by your Claude subscription
Exec=$HOME/.local/bin/pip-pet
Icon=$PIP_DIR/app/assets/previews/ember.png
Terminal=false
Categories=Utility;
EOF
  LAUNCH=("$HOME/.local/bin/pip-pet")
fi

say "Pip is installed! 🎉"
echo "   • Start it any time: open \"Pip\" from your apps, or run: pip-pet"
echo "   • First time? If Pip says Claude Code isn't signed in, tap \"Sign in to Claude\" and log in with your Claude subscription."
[ "$plat" = darwin ] && echo "   • macOS will ask to allow Screen Recording and Accessibility the first time Pip uses your computer. Allow them, then restart Pip."

if [ -z "${PIP_NO_LAUNCH:-}" ]; then
  say "Starting Pip…"
  nohup "${LAUNCH[@]}" >/dev/null 2>&1 &
fi

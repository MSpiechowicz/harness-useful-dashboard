#!/bin/sh
# Harness Dashboard installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.sh | sh
#
# Environment overrides:
#   HARNESS_DASHBOARD_VERSION      release tag to install (default: latest), e.g. v0.2.0
#   HARNESS_DASHBOARD_INSTALL_DIR  where the binary goes (default: ~/.local/bin)
#   HARNESS_DASHBOARD_NO_SHORTCUT  set to 1 to skip the desktop/app launcher
#   HARNESS_DASHBOARD_NO_MODIFY_PATH  set to 1 to leave your shell profile alone
set -eu

REPO="MSpiechowicz/harness-useful-dashboard"
BIN="harness-dashboard"
APP_NAME="Harness Dashboard"
INSTALL_DIR="${HARNESS_DASHBOARD_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${HARNESS_DASHBOARD_VERSION:-latest}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed"; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) fail "unsupported OS: $(uname -s). On Windows use install.ps1." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  arm64 | aarch64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

# Rosetta: prefer the native arm64 build on Apple Silicon.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
fi

ASSET="$BIN-$OS-$ARCH"
if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

info "Downloading $ASSET ($VERSION)"
download "$BASE/$ASSET" "$TMP/$ASSET" || fail "download failed: $BASE/$ASSET"

# Nothing is installed without a checksum to compare against.
download "$BASE/checksums.txt" "$TMP/checksums.txt" 2>/dev/null || fail "this release has no checksums.txt, so $ASSET can't be verified. Nothing was installed"
EXPECTED="$(grep " $ASSET\$" "$TMP/checksums.txt" | awk '{print $1}')"
[ -n "$EXPECTED" ] || fail "checksums.txt has no entry for $ASSET"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
else
  need shasum
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
fi
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for $ASSET"
info "Checksum verified"

mkdir -p "$INSTALL_DIR"
chmod +x "$TMP/$ASSET"
mv "$TMP/$ASSET" "$INSTALL_DIR/$BIN"

if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/$BIN" 2>/dev/null || true
  # Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough for local use.
  command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$INSTALL_DIR/$BIN" >/dev/null 2>&1 || true
fi

info "Installed $("$INSTALL_DIR/$BIN" version 2>/dev/null || echo "$BIN") to $INSTALL_DIR/$BIN"

# ---- launcher so it opens like any other app --------------------------------
if [ "${HARNESS_DASHBOARD_NO_SHORTCUT:-0}" != "1" ]; then
  if [ "$OS" = "linux" ]; then
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
    mkdir -p "$APPS" "$ICONS"
    # The app's logo, published with each release (releases before 1.3.1 don't have it).
    download "$BASE/$BIN.svg" "$ICONS/$BIN.svg" 2>/dev/null || warn "no app icon in this release; the launcher uses a generic one"
    cat >"$APPS/$BIN.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Token usage across your AI coding tools
Exec=$INSTALL_DIR/$BIN
Icon=$BIN
Terminal=false
Categories=Development;Utility;
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
    # Desktops cache icons by name: refresh an existing cache so a changed icon shows without logging out. Never
    # create one, since a cache nothing else keeps up to date would hide icons other apps add later.
    THEME="$(dirname "$(dirname "$ICONS")")"
    [ -f "$THEME/icon-theme.cache" ] && command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$THEME" >/dev/null 2>&1 || true
    info "Added \"$APP_NAME\" to your applications menu"
  else
    APPDIR="$HOME/Applications/$APP_NAME.app"
    mkdir -p "$APPDIR/Contents/MacOS" "$APPDIR/Contents/Resources"
    # The app's logo, published with each release (releases before 1.3.1 don't have it).
    download "$BASE/$BIN.icns" "$APPDIR/Contents/Resources/AppIcon.icns" 2>/dev/null || warn "no app icon in this release; the app uses a generic one"
    # A script bundle has no architecture of its own, so macOS runs it under Rosetta, and with it everything it starts,
    # unless told to prefer Apple Silicon.
    cat >"$APPDIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.github.mspiechowicz.harness-dashboard</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
</dict></plist>
EOF
    # The server runs in the background rather than as the app's own process: macOS would otherwise treat the bundle as
    # still running after its window is closed, and opening it again would do nothing. Each launch opens a window and
    # starts the server only when it is not already running.
    cat >"$APPDIR/Contents/MacOS/launcher" <<EOF
#!/bin/sh
nohup "$INSTALL_DIR/$BIN" serve >>"$HOME/Library/Logs/$BIN.log" 2>&1 &
EOF
    # Re-read the bundle, which macOS otherwise remembers as it was when first opened.
    LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APPDIR" >/dev/null 2>&1 || true
    chmod +x "$APPDIR/Contents/MacOS/launcher"
    # Finder caches app icons: touching the bundle makes it pick up the new one.
    touch "$APPDIR"
    info "Added \"$APP_NAME\" to ~/Applications (Spotlight / Launchpad)"
  fi
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    # Like install.ps1 on Windows: put the install dir on PATH for new terminals by appending to the shell's profile.
    if [ "${HARNESS_DASHBOARD_NO_MODIFY_PATH:-0}" = "1" ]; then
      warn "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
      printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    else
      case "$(basename "${SHELL:-sh}")" in
        zsh) PROFILE="${ZDOTDIR:-$HOME}/.zshrc"; LINE="export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
        bash)
          # macOS Terminal opens login shells, which read ~/.bash_profile rather than ~/.bashrc.
          if [ "$OS" = "darwin" ]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi
          LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
          ;;
        fish) PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/$BIN.fish"; LINE="fish_add_path \"$INSTALL_DIR\"" ;;
        *) PROFILE="$HOME/.profile"; LINE="export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
      esac
      if [ -f "$PROFILE" ] && grep -qsF "$LINE" "$PROFILE"; then
        :
      elif mkdir -p "$(dirname "$PROFILE")" && printf '\n# Added by the %s installer\n%s\n' "$APP_NAME" "$LINE" >>"$PROFILE"; then
        info "Added $INSTALL_DIR to your PATH in $PROFILE"
      else
        warn "couldn't update $PROFILE. Add $INSTALL_DIR to your PATH yourself"
      fi
      warn "open a new terminal (or run: export PATH=\"$INSTALL_DIR:\$PATH\") to use $BIN in this one"
    fi
    ;;
esac

printf '\nRun \033[1m%s\033[0m to open the dashboard. Update later with \033[1m%s update\033[0m.\n' "$BIN" "$BIN"

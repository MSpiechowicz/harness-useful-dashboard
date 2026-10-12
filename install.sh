#!/bin/sh
# Harness Dashboard installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.sh | sh
#
# Installs the Harness Dashboard app and the harness-dashboard command in ~/.local/bin. Linux gets the AppImage as
# ~/.local/lib/harness-dashboard/harness-dashboard.AppImage plus an applications-menu entry, macOS gets
# ~/Applications/Harness Dashboard.app. Both are the files the in-app updater replaces in place.
#
# Environment overrides:
#   HARNESS_DASHBOARD_VERSION         release tag to install (default: latest), e.g. v1.26.0
#   HARNESS_DASHBOARD_NO_SHORTCUT     set to 1 to skip the Linux applications-menu entry
#   HARNESS_DASHBOARD_NO_MODIFY_PATH  set to 1 to leave your shell profile alone
set -eu

REPO="MSpiechowicz/harness-useful-dashboard"
BIN="harness-dashboard"
APP_NAME="Harness Dashboard"
# The app keeps this copy of the command in step with itself, so the location is fixed.
INSTALL_DIR="$HOME/.local/bin"
VERSION="${HARNESS_DASHBOARD_VERSION:-latest}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed"; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

# A download URL read from latest.json must point into this repository's releases. Dot segments (also percent-encoded)
# would walk out of that prefix, so they are refused.
require_release_url() {
  case "$1" in
    *..* | *%2[eE]*) fail "unexpected download URL in latest.json: $1" ;;
  esac

  case "$1" in
    "https://github.com/$REPO/releases/download/"*) ;;
    *) fail "unexpected download URL in latest.json: $1" ;;
  esac
}

# Stops this user's own dashboard server, so the new app can take its port. The pattern is anchored on the program
# itself (a path without spaces, then the name): the bare command or "serve ...", which is how the launchers of releases
# before the desktop app start it. Never "harness-dashboard mcp" or other subcommands: agents keep those running and
# read usage through them. It also stops the server of a running app (the app then quits), which is intended before an
# upgrade.
stop_old_server() {
  command -v pkill >/dev/null 2>&1 || return 0
  if pkill -u "$(id -u)" -f "^([^ ]*/)?$BIN( serve( .*)?)?\$" >/dev/null 2>&1; then
    info "Stopped the running dashboard server"
    sleep 1
  fi
}

# Nothing is installed without a checksum to compare against: verify the file $1 against the entry of $2 in checksums.txt.
# The name is compared literally, never as a pattern.
verify() {
  EXPECTED="$(awk -v name="$2" 'substr($0, length($1) + 3) == name { print $1; exit }' "$TMP/checksums.txt")"
  [ -n "$EXPECTED" ] || fail "checksums.txt has no entry for $2"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$1" | awk '{print $1}')"
  else
    need shasum
    ACTUAL="$(shasum -a 256 "$1" | awk '{print $1}')"
  fi
  [ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for $2"
}

# Puts the command line tool $1 at ~/.local/bin/harness-dashboard. A symlink there is the user's own arrangement (the app
# leaves it alone too), so it is kept and the command stays as it is.
install_cli() {
  if [ -L "$INSTALL_DIR/$BIN" ]; then
    warn "$INSTALL_DIR/$BIN is a symlink, so it was left alone. The $BIN command is not updated"
    return 0
  fi

  mv "$1" "$INSTALL_DIR/$BIN"
  info "Installed $BIN to $INSTALL_DIR/$BIN"
}

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) fail "unsupported OS: $(uname -s). On Windows use install.ps1." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x86_64" ;;
  arm64 | aarch64) ARCH="aarch64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

# Rosetta: prefer the native arm64 build on Apple Silicon.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="aarch64"
fi

# The keys of the release's latest.json (the updater manifest), which carries each bundle's download URL.
if [ "$OS" = "linux" ]; then
  PLATFORM="linux-$ARCH-appimage"
  CLI_ASSET="$BIN-cli-$ARCH-unknown-linux-gnu"
else
  PLATFORM="darwin-$ARCH-app"
fi

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

download "$BASE/latest.json" "$TMP/latest.json" || fail "no app release found at $BASE (releases before the desktop app have none)"
# One line, then the "url" inside this platform's object (an object holds no nested braces).
URL="$(tr -d '\n\r' <"$TMP/latest.json" | sed -n "s/.*\"$PLATFORM\"[[:space:]]*:[[:space:]]*{[^}]*\"url\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")"
TAG="$(tr -d '\n\r' <"$TMP/latest.json" | sed -n 's/^[[:space:]]*{[[:space:]]*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p')"
[ -n "$URL" ] || fail "this release has no $PLATFORM build"
require_release_url "$URL"
ASSET="${URL##*/}"

info "Downloading $ASSET (${TAG:-$VERSION})"
download "$URL" "$TMP/$ASSET" || fail "download failed: $URL"

download "$BASE/checksums.txt" "$TMP/checksums.txt" 2>/dev/null || fail "this release has no checksums.txt, so $ASSET can't be verified. Nothing was installed"
verify "$TMP/$ASSET" "$ASSET"
info "Checksum verified"

stop_old_server
mkdir -p "$INSTALL_DIR"

if [ "$OS" = "linux" ]; then
  APP_DIR="$HOME/.local/lib/$BIN"
  APPIMAGE="$APP_DIR/$BIN.AppImage"
  mkdir -p "$APP_DIR"
  chmod +x "$TMP/$ASSET"
  mv "$TMP/$ASSET" "$APPIMAGE"
  info "Installed $APP_NAME ${TAG:-} to $APPIMAGE"

  # The command line tool is a plain binary of the same release. Replacing the old one is safe while it runs.
  info "Downloading $CLI_ASSET"
  download "$BASE/$CLI_ASSET" "$TMP/$CLI_ASSET" || fail "download failed: $BASE/$CLI_ASSET"
  verify "$TMP/$CLI_ASSET" "$CLI_ASSET"
  chmod +x "$TMP/$CLI_ASSET"
  install_cli "$TMP/$CLI_ASSET"

  # AppImages mount themselves with FUSE 2, which newer distributions no longer install by default.
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "libfuse2 was not found. If $APP_NAME does not start, install it (Debian/Ubuntu: sudo apt install libfuse2t64 or libfuse2)"
  fi

  if [ "${HARNESS_DASHBOARD_NO_SHORTCUT:-0}" != "1" ]; then
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
    APPS="$DATA/applications"
    ICONS="$DATA/icons/hicolor/256x256/apps"
    mkdir -p "$APPS" "$ICONS"
    # Releases before the desktop app put their logo here, and a scalable icon would win over the new one.
    rm -f "$DATA/icons/hicolor/scalable/apps/$BIN.svg"
    # The app icon from the tagged sources (the AppImage keeps its own inside).
    ICON_REF="${TAG:+v$TAG}"
    download "https://raw.githubusercontent.com/$REPO/${ICON_REF:-main}/src-tauri/icons/128x128@2x.png" "$ICONS/$BIN.png" 2>/dev/null ||
      warn "couldn't download the app icon. The launcher uses a generic one"
    # StartupWMClass ties the window to this entry, so Wayland docks show the app's icon. This replaces the entry older
    # releases wrote, which started the command line tool.
    cat >"$APPS/$BIN.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Token usage across your AI coding tools
Exec="$APPIMAGE"
Icon=$BIN
Terminal=false
Categories=Development;Utility;
StartupWMClass=$BIN-app
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
    # Desktops cache icons by name: refresh an existing cache so a changed icon shows without logging out. Never
    # create one, since a cache nothing else keeps up to date would hide icons other apps add later.
    THEME="$(dirname "$(dirname "$ICONS")")"
    [ -f "$THEME/icon-theme.cache" ] && command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$THEME" >/dev/null 2>&1 || true
    info "Added \"$APP_NAME\" to your applications menu"
  fi
else
  need tar
  APPS_DIR="$HOME/Applications"
  APP="$APPS_DIR/$APP_NAME.app"
  mkdir -p "$APPS_DIR" "$TMP/app"
  tar -xzf "$TMP/$ASSET" -C "$TMP/app"
  BUNDLE="$(find "$TMP/app" -maxdepth 1 -name '*.app' | head -n 1)"
  [ -n "$BUNDLE" ] || fail "$ASSET holds no .app bundle"
  # This also replaces the script launcher app older releases created at the same place.
  rm -rf "$APP"
  mv "$BUNDLE" "$APP"
  # The release is not notarized: clear the download quarantine, and give Apple Silicon the ad-hoc signature it
  # needs to run unsigned code.
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  command -v codesign >/dev/null 2>&1 && codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
  info "Installed $APP_NAME ${TAG:-} to $APP"

  # The command line tool is the server binary inside the bundle.
  [ -f "$APP/Contents/MacOS/$BIN" ] || fail "$ASSET holds no $BIN binary"
  cp "$APP/Contents/MacOS/$BIN" "$TMP/$BIN"
  chmod +x "$TMP/$BIN"
  install_cli "$TMP/$BIN"
  xattr -d com.apple.quarantine "$INSTALL_DIR/$BIN" 2>/dev/null || true
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

if [ "$OS" = "linux" ]; then
  printf '\nOpen \033[1m%s\033[0m from your applications menu, or run %s. The app updates itself.\n' "$APP_NAME" "$APPIMAGE"
else
  printf '\nOpen \033[1m%s\033[0m from Spotlight or Launchpad. The app updates itself.\n' "$APP_NAME"
fi
printf 'The \033[1m%s\033[0m command is installed too, try \033[1m%s today\033[0m.\n' "$BIN" "$BIN"

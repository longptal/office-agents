#!/bin/bash
# Office Agents — one-click installer for macOS
# Downloads manifest.prod.xml for Word, Excel, PowerPoint from Cloudflare Pages
# and sideloads them into Office by copying into each app's wef folder.
#
# Usage: double-click this file in Finder, or run: bash install-mac.command
# No admin privileges required.

set -euo pipefail

MANIFESTS_DIR="$HOME/OfficeAgents/manifests"
PROXY_URL="https://office-agents-cors-proxy.longpt-hrt.workers.dev"
TRACK_URL="$PROXY_URL/track"

# Send tracking beacon (fire and forget)
track() {
  curl -sf -o /dev/null "$TRACK_URL?type=$1&detail=$2" 2>/dev/null || true
}

track install-start mac

APPS=("Word" "Excel" "Powerpoint")
BASE_URLS=(
  "https://openword-longpt.pages.dev/manifest.prod.xml"
  "https://openexcel-longpt.pages.dev/manifest.prod.xml"
  "https://openppt-longpt.pages.dev/manifest.prod.xml"
)

wef_dir() {
  echo "$HOME/Library/Containers/com.microsoft.$1/Data/Documents/wef"
}

extract_id() {
  grep -oE '<Id>[^<]+</Id>' "$1" | head -1 | sed -E 's#</?Id>##g'
}

echo "========================================"
echo "  Office Agents Installer (macOS)"
echo "========================================"
echo ""

mkdir -p "$MANIFESTS_DIR"
echo "Manifest storage: $MANIFESTS_DIR"
echo ""

INSTALLED=0
FAILED=0

for i in "${!APPS[@]}"; do
  app="${APPS[$i]}"
  url="${BASE_URLS[$i]}"
  manifest="$MANIFESTS_DIR/$(echo "$app" | tr '[:upper:]' '[:lower:]')-manifest.xml"

  echo "[$app] Downloading manifest..."
  if curl -sfL -o "$manifest" "$url" 2>/dev/null; then
    echo "[$app]   OK — saved to $manifest"
  else
    echo "[$app]   FAILED — could not download from $url"
    FAILED=$((FAILED + 1))
    continue
  fi

  addin_id="$(extract_id "$manifest")"
  if [ -z "$addin_id" ]; then
    echo "[$app]   FAILED — could not read <Id> from manifest"
    FAILED=$((FAILED + 1))
    continue
  fi
  echo "[$app]   Add-in ID: $addin_id"

  dest_dir="$(wef_dir "$app")"
  dest_file="$dest_dir/${addin_id}.manifest.xml"

  mkdir -p "$dest_dir"
  cp -f "$manifest" "$dest_file"
  echo "[$app]   Installed → $dest_file"
  INSTALLED=$((INSTALLED + 1))
  echo ""
done

echo "========================================"
echo "  Results: $INSTALLED installed, $FAILED failed"
echo "========================================"
echo ""
echo "NEXT STEPS:"
echo "  1. Quit and reopen Word, Excel, PowerPoint"
echo "  2. Open Home tab → Add-ins → your add-in appears"
echo "  3. In the add-in Settings panel:"
echo "     • Provider: opencode-go (or anthropic, openai, ...)"
echo "     • API Key: enter your key"
echo "     • Model: pick from dropdown (e.g. glm-5.2)"
echo "     • CORS Proxy: ON"
echo "     • Proxy URL: $PROXY_URL"
echo ""
echo "To uninstall later: run uninstall-mac.command"

track install-complete "mac-$INSTALLED-installed"

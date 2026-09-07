#!/bin/bash
# Office Agents — uninstaller for macOS
# Removes sideloaded manifests from wef folders and deletes local manifest storage.
#
# Usage: double-click this file in Finder, or run: bash uninstall-mac.command
# No admin privileges required.

set -euo pipefail

MANIFESTS_DIR="$HOME/OfficeAgents/manifests"
TRACK_URL="https://office-agents-cors-proxy.longpt-hrt.workers.dev/track"

track() {
  curl -sf -o /dev/null "$TRACK_URL?type=$1&detail=$2" 2>/dev/null || true
}

track uninstall-start mac

APPS=("Word" "Excel" "Powerpoint")

wef_dir() {
  echo "$HOME/Library/Containers/com.microsoft.$1/Data/Documents/wef"
}

echo "========================================"
echo "  Office Agents Uninstaller (macOS)"
echo "========================================"
echo ""

REMOVED=0

for app in "${APPS[@]}"; do
  dest_dir="$(wef_dir "$app")"
  if [ -d "$dest_dir" ]; then
    count=0
    for f in "$dest_dir"/*.manifest.xml "$dest_dir"/*.xml; do
      [ -f "$f" ] || continue
      id_in_file=$(grep -oE '<Id>[^<]+</Id>' "$f" 2>/dev/null | head -1 | sed -E 's#</?Id>##g')
      if [ -n "$id_in_file" ]; then
        rm -f "$f"
        echo "[$app] Removed: $(basename "$f")"
        count=$((count + 1))
      fi
    done
    if [ "$count" -eq 0 ]; then
      echo "[$app] No Office Agents manifest found (nothing to remove)"
    fi
    REMOVED=$((REMOVED + count))
  else
    echo "[$app] wef folder does not exist (nothing to remove)"
  fi
done

echo ""
if [ -d "$MANIFESTS_DIR" ]; then
  rm -rf "$MANIFESTS_DIR"
  echo "Removed manifest storage: $MANIFESTS_DIR"
fi

echo ""
echo "========================================"
echo "  Removed $REMOVED manifest(s)"
echo "========================================"
echo ""
echo "Quit and reopen Word, Excel, PowerPoint to complete removal."

track uninstall-complete "mac-$REMOVED-removed"

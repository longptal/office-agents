# Office Agents — Installer

One-click installer for Office Agents add-ins (Word, Excel, PowerPoint).

## Quick start

### macOS
1. Open Terminal (Cmd+Space → type "Terminal")
2. Paste and run:
   ```
   curl -fsSL https://openword-longpt.pages.dev/installer/install-mac.command | bash
   ```
3. Quit and reopen Word, Excel, PowerPoint
4. Open Home tab → Add-ins → your add-in appears

> **Why curl instead of download?** macOS Gatekeeper blocks `.command` files
> downloaded from the internet with "cannot be executed" error. Piping through
> `curl | bash` avoids the quarantine attribute entirely.

<details>
<summary>Prefer downloading the file manually?</summary>

If you download `install-mac.command` via browser and get "cannot be executed"
error, fix by stripping the quarantine attribute in Terminal:

```
xattr -d com.apple.quarantine ~/Downloads/install-mac.command
```

Then double-click the file.
</details>

### Windows
1. Download `install-windows.bat`
2. Double-click it (no admin required)
3. Close and reopen Word, Excel, PowerPoint
4. Open Home tab → Add-ins → your add-in appears

## What it does

The installer downloads the latest add-in manifests from Cloudflare Pages and
registers them with Office:

- **macOS**: copies `manifest.xml` into each app's `wef` folder
  (`~/Library/Containers/com.microsoft.{App}/Data/Documents/wef/`)
- **Windows**: writes a `HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer\{id}`
  registry key pointing to the local manifest file

No admin privileges needed on either platform. The add-in UI loads from
Cloudflare Pages (HTTPS) — only the manifest file needs to be local.

## After installation — configure your AI provider

Open the add-in's **Settings** panel and configure:

| Setting       | Value                                                        |
|---------------|--------------------------------------------------------------|
| Provider      | `opencode-go` (or `anthropic`, `openai`, `google`, ...)     |
| API Key       | Your API key for the chosen provider                         |
| Model         | Pick from dropdown (e.g. `glm-5.2`, `deepseek-v4-flash`)     |
| CORS Proxy    | ON (required for `opencode-go` and `anthropic`)              |
| Proxy URL     | `https://office-agents-cors-proxy.longpt-hrt.workers.dev`   |

> The CORS proxy is needed because opencode-go and Anthropic API endpoints
> don't send CORS headers, so browsers (including the Office taskpane webview)
> block direct cross-origin requests. The proxy adds the necessary headers.

## Uninstall

### macOS
Open Terminal and run:
```
curl -fsSL https://openword-longpt.pages.dev/installer/uninstall-mac.command | bash
```
Or download `uninstall-mac.command` and strip quarantine:
```
xattr -d com.apple.quarantine ~/Downloads/uninstall-mac.command
```
then double-click it.

### Windows
Double-click `uninstall-windows.bat` — removes registry keys and deletes
`%USERPROFILE%\OfficeAgents\manifests\`.

## Requirements

- Microsoft Office installed (Word, Excel, and/or PowerPoint)
- Internet connection (downloads manifests + add-in UI from Cloudflare Pages)
- macOS 10.10+ or Windows 10/11

## Troubleshooting

**"cannot be executed" / "do not have appropriate access privileges" (macOS):**
- This is macOS Gatekeeper blocking a downloaded `.command` file
- Use the `curl | bash` one-liner instead (see Quick Start above), OR
- Strip the quarantine attribute: `xattr -d com.apple.quarantine ~/Downloads/install-mac.command`

**Add-in doesn't appear after install:**
- Make sure you fully quit and reopened the Office app (Cmd+Q on Mac, not just close window)
- Check Home → Add-ins → look for "OpenWord" / "OpenExcel" / "OpenPPT"

**"Connection error" when chatting:**
- You forgot to enable CORS Proxy or enter the Proxy URL in Settings
- See the configuration table above

**Want to update to latest version:**
- Just run the installer again — it downloads fresh manifests each time

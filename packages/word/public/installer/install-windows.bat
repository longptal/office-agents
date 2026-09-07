@echo off
REM Office Agents — one-click installer for Windows
REM Downloads manifest.prod.xml for Word, Excel, PowerPoint from Cloudflare Pages
REM and registers them via HKCU Developer registry key (no admin required).
REM
REM Usage: double-click this file, or run: install-windows.bat
REM No admin privileges required.

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $c = Get-Content -Raw '%~f0'; $s = $c -replace '(?s).*?#PS1START#', ''; Invoke-Expression $s }"
exit /b

#PS1START#
$ErrorActionPreference = 'Stop'
$ManifestsDir = Join-Path $env:USERPROFILE 'OfficeAgents\manifests'
$ProxyUrl = 'https://office-agents-cors-proxy.longpt-hrt.workers.dev'
$TrackUrl = $ProxyUrl + '/track'
$Apps = @('Word', 'Excel', 'PowerPoint')
$Urls = @(
  'https://openword-longpt.pages.dev/manifest.prod.xml',
  'https://openexcel-longpt.pages.dev/manifest.prod.xml',
  'https://openppt-longpt.pages.dev/manifest.prod.xml'
)

function Track($type, $detail) {
  try { Invoke-RestMethod -Uri "$TrackUrl`?type=$type&detail=$detail" -Method GET -TimeoutSec 3 | Out-Null } catch {}
}
Track 'install-start' 'windows'

Write-Host '========================================'
Write-Host '  Office Agents Installer (Windows)   '
Write-Host '========================================'
Write-Host ''

New-Item -ItemType Directory -Force -Path $ManifestsDir | Out-Null
Write-Host "Manifest storage: $ManifestsDir"
Write-Host ''

$Installed = 0
$Failed = 0

for ($i = 0; $i -lt $Apps.Count; $i++) {
  $app = $Apps[$i]
  $url = $Urls[$i]
  $manifest = Join-Path $ManifestsDir ($app.ToLower() + '-manifest.xml')

  Write-Host "[$app] Downloading manifest..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $manifest -UseBasicParsing
    Write-Host "[$app]   OK"
  } catch {
    Write-Host "[$app]   FAILED: $_"
    $Failed++
    continue
  }

  $content = Get-Content $manifest -Raw
  if ($content -match '<Id>([^<]+)</Id>') {
    $addinId = $Matches[1]
  } else {
    Write-Host "[$app]   FAILED - no Id in manifest"
    $Failed++
    continue
  }

  Write-Host "[$app]   Add-in ID: $addinId"

  # Register as string VALUE (not subkey) under Developer key
  # This matches office-addin-dev-settings format exactly:
  # HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer\<addinId> = <manifestPath>
  $regKey = 'HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer'
  if (-not (Test-Path $regKey)) {
    New-Item -Path $regKey -Force | Out-Null
  }
  Set-ItemProperty -Path $regKey -Name $addinId -Value $manifest -Type String

  Write-Host "[$app]   Registered: $addinId = $manifest"
  $Installed++
  Write-Host ''
}

Write-Host '========================================'
Write-Host "  Results: $Installed installed, $Failed failed"
Write-Host '========================================'
Write-Host ''
Write-Host 'NEXT STEPS:'
Write-Host '  1. Close and reopen Word, Excel, PowerPoint'
Write-Host '  2. Open Home tab -> Add-ins -> your add-in appears'
Write-Host '  3. In the add-in Settings panel:'
Write-Host '     - Provider: opencode-go (or anthropic, openai, ...)'
Write-Host '     - API Key: enter your key'
Write-Host '     - Model: pick from dropdown (e.g. glm-5.2)'
Write-Host '     - CORS Proxy: ON'
Write-Host "     - Proxy URL: $ProxyUrl"
Write-Host ''
Write-Host 'To uninstall later: run uninstall-windows.bat'
Track 'install-complete' "windows-$Installed-installed"
Start-Sleep -Seconds 3

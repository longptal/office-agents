@echo off
REM Office Agents — uninstaller for Windows
REM Removes Developer registry keys and deletes local manifest storage.
REM
REM Usage: double-click this file, or run: uninstall-windows.bat
REM No admin privileges required.

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $c = Get-Content -Raw '%~f0'; $s = $c -replace '(?s).*?#PS1START#', ''; Invoke-Expression $s }"
exit /b

#PS1START#
$ErrorActionPreference = 'SilentlyContinue'
$ManifestsDir = Join-Path $env:USERPROFILE 'OfficeAgents\manifests'
$TrackUrl = 'https://office-agents-cors-proxy.longpt-hrt.workers.dev/track'

function Track($type, $detail) {
  try { Invoke-RestMethod -Uri "$TrackUrl`?type=$type&detail=$detail" -Method GET -TimeoutSec 3 | Out-Null } catch {}
}
Track 'uninstall-start' 'windows'

Write-Host '========================================'
Write-Host '  Office Agents Uninstaller (Windows)'
Write-Host '========================================'
Write-Host ''

$Removed = 0
$devKey = 'HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer'

if (Test-Path $devKey) {
  # Remove string values (not subkeys) — each value name is an add-in ID
  $values = Get-Item $devKey -ErrorAction SilentlyContinue
  if ($values) {
    $valueNames = $values.Property
    foreach ($name in $valueNames) {
      Remove-ItemProperty -Path $devKey -Name $name -ErrorAction SilentlyContinue
      Write-Host "Removed registry value: $name"
      $Removed++
    }
  }
  # Also clean up any subkeys from previous buggy installer versions
  $children = Get-ChildItem $devKey -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Remove-Item -Path $child.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed leftover subkey: $($child.PSChildName)"
  }
} else {
  Write-Host 'No Developer add-in registry keys found.'
}

if (Test-Path $ManifestsDir) {
  Remove-Item -Path $ManifestsDir -Recurse -Force
  Write-Host "Removed manifest storage: $ManifestsDir"
}

Write-Host ''
Write-Host '========================================'
Write-Host "  Removed $Removed registry key(s)"
Write-Host '========================================'
Write-Host ''
Write-Host 'Close and reopen Word, Excel, PowerPoint to complete removal.'
Track 'uninstall-complete' "windows-$Removed-removed"
Start-Sleep -Seconds 3

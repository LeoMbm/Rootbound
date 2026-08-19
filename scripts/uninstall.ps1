[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path (Join-Path $env:LOCALAPPDATA "Rootbound") "app"),
  [switch]$PurgeState,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$RootboundRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Rootbound"))
$StateDirs = @("state", "runtime", "logs", "backups") | ForEach-Object { Join-Path $RootboundRoot $_ }

try {
  $package = $null
  if (Test-Path -LiteralPath $InstallDir) {
    $packageFile = Join-Path $InstallDir "package.json"
    if (-not (Test-Path -LiteralPath $packageFile)) {
      throw "Refusing to remove a directory without Rootbound package.json: $InstallDir"
    }
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    if ($package.name -ne "rootbound") {
      throw "Refusing to remove directory whose package name is not rootbound: $InstallDir"
    }
    Set-Location $env:TEMP
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }

  $statePurged = $false
  if ($PurgeState) {
    foreach ($dir in $StateDirs) {
      if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    if (Test-Path -LiteralPath $RootboundRoot) {
      $remaining = @(Get-ChildItem -LiteralPath $RootboundRoot -Force -ErrorAction SilentlyContinue)
      if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $RootboundRoot -Force }
    }
    $statePurged = $true
  }

  $action = if ($package) { "uninstalled" } else { "already-absent" }
  $result = [ordered]@{
    ok = $true
    action = $action
    version = if ($package) { $package.version } else { $null }
    installDir = $InstallDir
    stateRoot = $RootboundRoot
    statePurged = $statePurged
    notes = @(
      "Codex, Node.js, projects, Browser configuration, Tunnel configuration, and Codex trust were not changed.",
      $(if ($PurgeState) { "Rootbound-owned state/runtime/log/backups were purged." } else { "Rootbound-owned state was preserved. Use -PurgeState only when you intentionally want to remove continuity data." })
    )
  }

  if ($Json) { $result | ConvertTo-Json -Depth 5 }
  else {
    Write-Host $(if ($package) { "Rootbound uninstalled: $InstallDir" } else { "Rootbound is already absent: $InstallDir" })
    if ($statePurged) { Write-Host "Rootbound state purged: $RootboundRoot" }
    else { Write-Host "Rootbound state preserved: $RootboundRoot" }
  }
} catch {
  if ($Json) {
    [ordered]@{ ok = $false; action = "uninstall-failed"; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
  } else {
    Write-Error $_.Exception.Message
  }
  exit 1
}

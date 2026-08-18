[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path (Join-Path $env:LOCALAPPDATA "Codexless") "app"),
  [switch]$PurgeState,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$CodexlessRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Codexless"))
$StateDirs = @("state", "runtime", "logs", "backups") | ForEach-Object { Join-Path $CodexlessRoot $_ }

try {
  $package = $null
  if (Test-Path -LiteralPath $InstallDir) {
    $packageFile = Join-Path $InstallDir "package.json"
    if (-not (Test-Path -LiteralPath $packageFile)) {
      throw "Refusing to remove a directory without Codexless package.json: $InstallDir"
    }
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    if ($package.name -ne "codexless") {
      throw "Refusing to remove directory whose package name is not codexless: $InstallDir"
    }
    Set-Location $env:TEMP
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }

  $statePurged = $false
  if ($PurgeState) {
    foreach ($dir in $StateDirs) {
      if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    if (Test-Path -LiteralPath $CodexlessRoot) {
      $remaining = @(Get-ChildItem -LiteralPath $CodexlessRoot -Force -ErrorAction SilentlyContinue)
      if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $CodexlessRoot -Force }
    }
    $statePurged = $true
  }

  $action = if ($package) { "uninstalled" } else { "already-absent" }
  $result = [ordered]@{
    ok = $true
    action = $action
    version = if ($package) { $package.version } else { $null }
    installDir = $InstallDir
    stateRoot = $CodexlessRoot
    statePurged = $statePurged
    notes = @(
      "Codex, Node.js, projects, Browser configuration, Tunnel configuration, and Codex trust were not changed.",
      $(if ($PurgeState) { "Codexless-owned state/runtime/log/backups were purged." } else { "Codexless-owned state was preserved. Use -PurgeState only when you intentionally want to remove continuity data." })
    )
  }

  if ($Json) { $result | ConvertTo-Json -Depth 5 }
  else {
    Write-Host $(if ($package) { "Codexless uninstalled: $InstallDir" } else { "Codexless is already absent: $InstallDir" })
    if ($statePurged) { Write-Host "Codexless state purged: $CodexlessRoot" }
    else { Write-Host "Codexless state preserved: $CodexlessRoot" }
  }
} catch {
  if ($Json) {
    [ordered]@{ ok = $false; action = "uninstall-failed"; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
  } else {
    Write-Error $_.Exception.Message
  }
  exit 1
}

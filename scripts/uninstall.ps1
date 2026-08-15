[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Codexless"),
  [switch]$PurgeState,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$StateDir = Join-Path $HOME ".config\codexless"

try {
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    $result = [ordered]@{ ok = $true; action = "already-absent"; installDir = $InstallDir; statePurged = $false }
    if ($Json) { $result | ConvertTo-Json -Depth 4 } else { Write-Host "Codexless is already absent: $InstallDir" }
    exit 0
  }

  $packageFile = Join-Path $InstallDir "package.json"
  if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "Refusing to remove a directory without Codexless package.json: $InstallDir"
  }
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  if ($package.name -ne "codexless") {
    throw "Refusing to remove directory whose package name is not codexless: $InstallDir"
  }

  # Do not keep the current shell inside the tree it is about to remove.
  Set-Location $env:TEMP
  Remove-Item -LiteralPath $InstallDir -Recurse -Force

  $statePurged = $false
  if ($PurgeState -and (Test-Path -LiteralPath $StateDir)) {
    Remove-Item -LiteralPath $StateDir -Recurse -Force
    $statePurged = $true
  }

  $result = [ordered]@{
    ok = $true
    action = "uninstalled"
    version = $package.version
    installDir = $InstallDir
    statePurged = $statePurged
    notes = @(
      "Codex, Node.js, projects, Browser configuration, and Tunnel configuration were not changed.",
      $(if ($PurgeState) { "Codexless-owned state was purged when present." } else { "Codexless-owned state was preserved. Use -PurgeState only when you intentionally want to remove it." })
    )
  }

  if ($Json) { $result | ConvertTo-Json -Depth 5 }
  else {
    Write-Host "Codexless uninstalled: $InstallDir"
    if ($statePurged) { Write-Host "Codexless state purged: $StateDir" }
    else { Write-Host "Codexless state preserved: $StateDir" }
  }
} catch {
  if ($Json) {
    [ordered]@{ ok = $false; action = "uninstall-failed"; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
  } else {
    Write-Error $_.Exception.Message
  }
  exit 1
}

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path (Join-Path $env:LOCALAPPDATA "Codexless") "app"),
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$ParentDir = Split-Path -Parent $InstallDir
$StageDir = Join-Path $ParentDir ("Codexless-stage-" + [guid]::NewGuid().ToString("N"))
$BackupDir = $null
$Installed = $false

function Invoke-Checked {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')" }
}

function Read-JsonCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )
  $text = (& $Command @Arguments | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    try { return ($text | ConvertFrom-Json) } catch { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')`n$text" }
  }
  return ($text | ConvertFrom-Json)
}

function Get-RequiredCommand {
  param([Parameter(Mandatory=$true)][string[]]$Names, [Parameter(Mandatory=$true)][string]$Label)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  throw "$Label was not found on PATH."
}

function Assert-NodeV5 {
  param([Parameter(Mandatory=$true)][string]$Node)
  $version = (& $Node -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Unable to read Node.js version." }
  $parts = $version.Split('.')
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
    throw "Codexless V5 requires Node.js 22.13+. Current: v$version"
  }
  return $version
}

function Copy-ReleaseTree {
  param([Parameter(Mandatory=$true)][string]$From, [Parameter(Mandatory=$true)][string]$To)
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $entries = @(
    "src", "config", "scripts", "bin", "docs", "package.json",
    "README.md", "README.zh-CN.md", "SECURITY.md", "EXPORT_SYNC.md",
    "THIRD_PARTY_NOTICES.md", "LICENSE"
  )
  foreach ($entry in $entries) {
    $source = Join-Path $From $entry
    if (-not (Test-Path -LiteralPath $source)) { throw "Release source is missing required entry: $entry" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $To $entry) -Recurse -Force
  }

  $shrinkwrap = Join-Path $From "npm-shrinkwrap.json"
  $packageLock = Join-Path $From "package-lock.json"
  $selfDeletingBatchWrapper = Join-Path $To "bin\codexless-uninstall.cmd"
  if (Test-Path -LiteralPath $selfDeletingBatchWrapper) { Remove-Item -LiteralPath $selfDeletingBatchWrapper -Force }

  if (Test-Path -LiteralPath $shrinkwrap) {
    Copy-Item -LiteralPath $shrinkwrap -Destination (Join-Path $To "npm-shrinkwrap.json") -Force
  } elseif (Test-Path -LiteralPath $packageLock) {
    Copy-Item -LiteralPath $packageLock -Destination (Join-Path $To "package-lock.json") -Force
  } else {
    throw "Release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json"
  }
}

function Run-DoctorJson {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Node)
  $doctor = Join-Path $Root "scripts\doctor.mjs"
  $text = (& $Node $doctor --json | Out-String).Trim()
  $exit = $LASTEXITCODE
  if (-not $text) { throw "Codexless doctor returned no output." }
  $parsed = $text | ConvertFrom-Json
  if ($exit -ne 0 -or $parsed.status -eq "error") { throw "Codexless doctor failed in $Root.`n$text" }
  return $parsed
}

try {
  if ($env:OS -ne "Windows_NT") { throw "Codexless Technical Preview installer currently supports Windows only." }

  $node = Get-RequiredCommand -Names @("node.exe", "node") -Label "Node.js"
  $npm = Get-RequiredCommand -Names @("npm.cmd", "npm") -Label "npm"
  $nodeVersion = Assert-NodeV5 -Node $node

  $codexResolution = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\resolve-codex.mjs")
  if (-not $codexResolution.ok -or -not $codexResolution.path) { throw ("Codex prerequisite check failed: " + $codexResolution.error) }
  $env:CODEX_BIN = [string]$codexResolution.path

  New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
  Copy-ReleaseTree -From $SourceRoot -To $StageDir

  Push-Location $StageDir
  try {
    Invoke-Checked $npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    $stageDoctor = Run-DoctorJson -Root $StageDir -Node $node
  } finally { Pop-Location }

  if (Test-Path -LiteralPath $InstallDir) {
    $installedPackage = Join-Path $InstallDir "package.json"
    if (-not (Test-Path -LiteralPath $installedPackage)) { throw "Refusing to replace a non-Codexless-looking directory: $InstallDir" }
    $existingName = (Get-Content -LiteralPath $installedPackage -Raw | ConvertFrom-Json).name
    if ($existingName -ne "codexless") { throw "Refusing to replace directory whose package name is not codexless: $InstallDir" }
    $BackupDir = Join-Path $ParentDir ("Codexless-backup-" + [guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $InstallDir -Destination $BackupDir
  }

  try {
    Move-Item -LiteralPath $StageDir -Destination $InstallDir
    $Installed = $true
    $installedDoctor = Run-DoctorJson -Root $InstallDir -Node $node
  } catch {
    if ($Installed -and (Test-Path -LiteralPath $InstallDir)) {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
      $Installed = $false
    }
    if ($BackupDir -and (Test-Path -LiteralPath $BackupDir)) {
      Move-Item -LiteralPath $BackupDir -Destination $InstallDir
      $BackupDir = $null
    }
    throw
  }

  if ($BackupDir -and (Test-Path -LiteralPath $BackupDir)) {
    Remove-Item -LiteralPath $BackupDir -Recurse -Force
    $BackupDir = $null
  }

  $package = Get-Content -LiteralPath (Join-Path $InstallDir "package.json") -Raw | ConvertFrom-Json
  $result = [ordered]@{
    ok = $true
    action = "installed-or-upgraded"
    version = $package.version
    installDir = $InstallDir
    node = "v$nodeVersion"
    codex = $codexResolution.version
    codexResolutionSource = $codexResolution.source
    doctorStatus = $installedDoctor.status
    commands = [ordered]@{
      codexless = (Join-Path $InstallDir "bin\codexless.cmd")
      doctor = (Join-Path $InstallDir "bin\codexless-doctor.cmd")
      http = (Join-Path $InstallDir "bin\codexless-http.cmd")
      stdio = (Join-Path $InstallDir "bin\codexless-stdio.cmd")
      uninstall = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -InstallDir "{1}"' -f (Join-Path $InstallDir "scripts\uninstall.ps1"), $InstallDir)
    }
    notes = @(
      "No PATH entry, Windows service, Browser configuration, or Tunnel configuration was changed.",
      "Re-running a newer Codexless release installer against the same InstallDir performs an upgrade and preserves state outside the install tree."
    )
  }

  if ($Json) { $result | ConvertTo-Json -Depth 6 }
  else {
    Write-Host "Codexless installed: $($package.version)"
    Write-Host "Location: $InstallDir"
    Write-Host "CLI:      $($result.commands.codexless)"
    Write-Host "Doctor:   $($result.commands.doctor)"
    Write-Host "HTTP:     $($result.commands.http)"
    Write-Host "No PATH, service, Browser, or Tunnel settings were changed."
  }
} catch {
  if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($BackupDir -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
    Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue
  }
  if ($Json) {
    [ordered]@{ ok = $false; action = "install-failed"; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
  } else { Write-Error $_.Exception.Message }
  exit 1
}

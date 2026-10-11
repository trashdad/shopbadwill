<#
.SYNOPSIS
  USER STEP: removes everything install.ps1 set up for this Windows user.
  See docs/COMPANION.md. It deletes only `ShopBadwill-snipe-*` scheduled tasks
  (controller ruling R2), unregisters the native-messaging host for both
  browsers, and removes the companion data directory. Power settings are never
  touched: any manual power-plan changes are yours to revert (COMPANION.md).

.EXAMPLE
  .\uninstall.ps1            # default data dir
  .\uninstall.ps1 -WhatIf    # dry run, changes nothing
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\install.ps1"          # host name, reg keys, arg arrays, data-dir default
. "$PSScriptRoot\host\protocol.ps1"    # task-name allowlist regex
. "$PSScriptRoot\host\task-xml.ps1"    # Get-SbwCancelArgs

# Only task names that the companion itself could have created: ShopBadwill-
# prefixed, built from a validated snipe id. Everything else in the state file
# is ignored (defense in depth: uninstall never touches foreign tasks).
function Get-SbwStateTaskNames {
  param([string]$StatePath)
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  $rows = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  if ($null -eq $rows -or $null -eq $rows.tasks) { return }
  foreach ($t in @($rows.tasks)) {
    if ($null -eq $t) { continue }
    $n = [string]$t.taskName
    if ($n -cmatch $SbwTaskNameRegex) { $n }
  }
}

function Invoke-SbwUninstall {
  $dataDir = Get-SbwDataDir -Explicit $DataDir
  $hostName = Get-SbwHostName
  $statePath = Join-Path $dataDir 'state.json'
  $schtasksPath = Get-SbwSchTasksPath

  Write-Host 'ShopBadwill companion uninstall'
  Write-Host "  data dir: $dataDir"

  foreach ($taskName in @(Get-SbwStateTaskNames -StatePath $statePath)) {
    if ($PSCmdlet.ShouldProcess($taskName, 'delete the companion scheduled task')) {
      & $schtasksPath @(Get-SbwCancelArgs -TaskName $taskName) 2>&1 | Out-Null
      # A missing task (fired + auto-deleted) is fine; anything else we report.
      if ($LASTEXITCODE -ne 0) { Write-Host "  warning: could not delete $taskName" }
    }
  }

  foreach ($regKey in @((Get-SbwChromeRegKey), (Get-SbwFirefoxRegKey))) {
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'unregister the native-messaging host')) {
      & reg.exe @(Get-SbwRegDeleteArgs -Key $regKey -ValueName $hostName) 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Host "  warning: could not remove $regKey\$hostName (already absent?)" }
    }
  }

  foreach ($file in @('config.json', 'state.json', 'chrome-manifest.json', 'firefox-manifest.json', 'shopbadwill-host.cmd')) {
    $p = Join-Path $dataDir $file
    if (Test-Path -LiteralPath $p) {
      if ($PSCmdlet.ShouldProcess($p, 'delete companion data file')) { Remove-Item -LiteralPath $p -Force }
    }
  }
  foreach ($p in @(Get-ChildItem -LiteralPath $dataDir -Filter 'ShopBadwill-snipe-*.xml' -ErrorAction SilentlyContinue)) {
    if ($PSCmdlet.ShouldProcess($p.FullName, 'delete generated task XML')) { Remove-Item -LiteralPath $p.FullName -Force }
  }
  if ((Test-Path -LiteralPath $dataDir) -and -not @(Get-ChildItem -LiteralPath $dataDir -Force)) {
    if ($PSCmdlet.ShouldProcess($dataDir, 'remove the now-empty companion data directory')) {
      Remove-Item -LiteralPath $dataDir -Force
    }
  }

  if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Done. If you changed power settings (docs/COMPANION.md), restore them yourself:'
    Write-Host '  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1'
    Write-Host '  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0'
    Write-Host '  powercfg /setactive SCHEME_CURRENT'
    Write-Host 'Fully restart the browsers to drop the stale native-host connection.'
  }
}

# Skipped when dot-sourced (unit tests).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-SbwUninstall
}

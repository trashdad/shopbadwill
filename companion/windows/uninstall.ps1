<#
.SYNOPSIS
  USER STEP: removes everything install.ps1 set up for this Windows user.
  See docs/COMPANION.md. It deletes only scheduled tasks named
  `ShopBadwill-<snipeId>` (controller ruling R2), unregisters the
  native-messaging host for both browsers, and removes the companion data
  directory (including the private host copy in host\). Power settings are never touched: any manual power-plan changes
  are yours to revert (COMPANION.md).

.EXAMPLE
  .\uninstall.ps1            # default data dir
  .\uninstall.ps1 -WhatIf    # dry run, changes nothing
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'

# install.ps1 has its own param() block. Dot-sourcing it runs that block in
# this scope and resets $DataDir to empty, so capture the caller's value first.
$script:SbwUninstallDataDir = $DataDir

. "$PSScriptRoot\install.ps1"          # host name, reg keys, arg arrays, data-dir default
. "$PSScriptRoot\host\protocol.ps1"    # task-name allowlist regex
. "$PSScriptRoot\host\task-xml.ps1"    # Get-SbwCancelArgs

function Get-SbwUninstallDataDir {
  Get-SbwDataDir -Explicit $script:SbwUninstallDataDir
}

# A task name is ours only when the whole path segment is ShopBadwill- plus a
# validated snipe id. Anything else (other folders, extra segments, shell
# metacharacters) is ignored.
function Get-SbwOwnedTaskName {
  param([string]$Raw)
  if ([string]::IsNullOrWhiteSpace($Raw)) { return }
  $n = $Raw.Trim().Trim('"')
  if ($n.StartsWith('\')) { $n = $n.Substring(1) }
  if ($n -cmatch $SbwTaskNameRegex) { $n }
}

function Get-SbwTaskNamesFromQueryCsv {
  param([string]$Csv)
  if ([string]::IsNullOrWhiteSpace($Csv)) { return }
  foreach ($line in ($Csv -split "`r?`n")) {
    $line = $line.Trim()
    if (-not $line) { continue }
    $field = $null
    if ($line.StartsWith('"')) {
      $end = 1
      while ($end -lt $line.Length -and $line[$end] -ne '"') { $end++ }
      if ($end -ge $line.Length) { continue }
      $field = $line.Substring(1, $end - 1)
    } else {
      $comma = $line.IndexOf(',')
      $field = if ($comma -ge 0) { $line.Substring(0, $comma).Trim() } else { $line }
    }
    $owned = Get-SbwOwnedTaskName $field
    if ($owned) { $owned }
  }
}

# State rows and a schtasks /Query CSV. The result is the only set of names
# uninstall will pass to schtasks /Delete.
function Get-SbwTaskNamesToRemove {
  param([string[]]$StateNames, [string]$QueryCsv)
  $set = New-Object 'System.Collections.Generic.List[string]'
  foreach ($n in @($StateNames)) {
    $owned = Get-SbwOwnedTaskName ([string]$n)
    if ($owned -and -not $set.Contains($owned)) { [void]$set.Add($owned) }
  }
  foreach ($n in @(Get-SbwTaskNamesFromQueryCsv -Csv $QueryCsv)) {
    if ($n -and -not $set.Contains([string]$n)) { [void]$set.Add([string]$n) }
  }
  foreach ($n in $set) { $n }
}

# Argument-array wrappers. Tests replace these; the real commands are not
# reached unless the user runs this script.
function Invoke-SbwSchtasks {
  param([string]$SchTasksPath, [string[]]$ArgList)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $SchTasksPath @ArgList 2>&1 | Out-String)
    @{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Only task names that the companion itself could have created.
function Get-SbwStateTaskNames {
  param([string]$StatePath)
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  $rows = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $rows -or $null -eq $rows.tasks) { return }
  foreach ($t in @($rows.tasks)) {
    if ($null -eq $t) { continue }
    $owned = Get-SbwOwnedTaskName ([string]$t.taskName)
    if ($owned) { $owned }
  }
}

# Removes a directory only when it exists and is empty.
function Remove-SbwEmptyDir {
  param([string]$Path, [string]$What)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  if (@(Get-ChildItem -LiteralPath $Path -Force).Count -gt 0) { return }
  if ($PSCmdlet.ShouldProcess($Path, $What)) { Remove-Item -LiteralPath $Path -Force }
}

function Invoke-SbwUninstall {
  $dataDir = Get-SbwUninstallDataDir
  $hostName = Get-SbwHostName
  $statePath = Join-Path $dataDir 'state.json'
  $schtasksPath = Get-SbwSchTasksPath

  Write-Host 'ShopBadwill companion uninstall'
  Write-Host "  data dir: $dataDir"

  $queryCsv = ''
  try {
    $query = Invoke-SbwSchtasks -SchTasksPath $schtasksPath -ArgList @('/Query', '/FO', 'CSV', '/NH')
    if ($query.ExitCode -eq 0) { $queryCsv = [string]$query.Output }
    else { Write-Host '  warning: could not list scheduled tasks; removing only tasks recorded in state.json' }
  } catch {
    Write-Host '  warning: could not list scheduled tasks; removing only tasks recorded in state.json'
  }

  $stateNames = @(Get-SbwStateTaskNames -StatePath $statePath)
  foreach ($taskName in @(Get-SbwTaskNamesToRemove -StateNames $stateNames -QueryCsv $queryCsv)) {
    if ($taskName -cnotmatch $SbwTaskNameRegex) { continue }
    if ($PSCmdlet.ShouldProcess($taskName, 'delete the companion scheduled task')) {
      $run = Invoke-SbwSchtasks -SchTasksPath $schtasksPath -ArgList (Get-SbwCancelArgs -TaskName $taskName)
      if ($run.ExitCode -ne 0) { Write-Host "  warning: could not delete $taskName" }
    }
  }

  foreach ($regKey in @((Get-SbwChromeRegKey), (Get-SbwFirefoxRegKey))) {
    if ($regKey -notlike 'HKCU\*') { throw "Refusing to touch a non-HKCU registry key: $regKey" }
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'unregister the native-messaging host')) {
      $code = Invoke-SbwReg -ArgList (Get-SbwRegDeleteArgs -Key $regKey -ValueName $hostName)
      if ($code -ne 0) { Write-Host "  warning: could not remove $regKey\$hostName (already absent?)" }
    }
  }

  foreach ($file in @('config.json', 'state.json', 'chrome-manifest.json', 'firefox-manifest.json', 'shopbadwill-host.cmd')) {
    $p = Join-Path $dataDir $file
    if (Test-Path -LiteralPath $p) {
      if ($PSCmdlet.ShouldProcess($p, 'delete companion data file')) { Remove-Item -LiteralPath $p -Force }
    }
  }
  $hostDir = Join-Path $dataDir 'host'
  foreach ($file in @(Get-SbwHostFileNames)) {
    $p = Join-Path $hostDir $file
    if (Test-Path -LiteralPath $p) {
      if ($PSCmdlet.ShouldProcess($p, 'delete the private host copy')) { Remove-Item -LiteralPath $p -Force }
    }
  }
  Remove-SbwEmptyDir -Path $hostDir -What 'remove the now-empty host copy directory'
  if (Test-Path -LiteralPath $dataDir) {
    foreach ($p in @(Get-ChildItem -LiteralPath $dataDir -Filter 'ShopBadwill-*.xml' -ErrorAction SilentlyContinue)) {
      if ($p.BaseName -cnotmatch $SbwTaskNameRegex) { continue }
      if ($PSCmdlet.ShouldProcess($p.FullName, 'delete generated task XML')) { Remove-Item -LiteralPath $p.FullName -Force }
    }
  }
  Remove-SbwEmptyDir -Path $dataDir -What 'remove the now-empty companion data directory'
  # install created %LOCALAPPDATA%\ShopBadwill along with ...\companion.
  $parent = Split-Path -Parent $dataDir
  if ($parent -and (Split-Path -Leaf $parent) -ceq 'ShopBadwill') {
    Remove-SbwEmptyDir -Path $parent -What 'remove the now-empty ShopBadwill folder'
  }

  if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Done. Power settings were not changed. If you edited the plan yourself, see docs/COMPANION.md.'
    Write-Host 'Fully restart the browsers to drop the stale native-host connection.'
  }
}

# Skipped when dot-sourced (unit tests).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-SbwUninstall
}

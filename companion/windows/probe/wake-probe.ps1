<#
.SYNOPSIS
  ShopBadwill S-8 wake-from-sleep probe (throwaway; run by the USER).

.DESCRIPTION
  Modes
    Schedule  (default) Register a one-off scheduled task "Wake the computer to run
                        this task" firing -DelayMinutes from now. Then YOU put the
                        laptop to sleep or hibernate. When the task fires it runs
                        this script in Fire mode.
    Fire      (internal, run by the task) Log fire time + wake source, poll until the
                        network is up, optionally launch Chrome, remove the task.
    Summarize           Print wake/network/onStartup timings from a probe log.
    Cleanup             Remove any leftover ShopBadwillWakeProbe-* tasks.

  Everything is logged (tab separated: UTC-ISO-time, EVENT, key=value ...) to
  %LOCALAPPDATA%\ShopBadwill\probe\wake-<runId>.log. Nothing is changed except the one
  scheduled task, which the script removes itself. No power setting is modified and
  the script never sleeps/hibernates the machine itself.

.EXAMPLE
  .\wake-probe.ps1 -WhatIf -LaunchChrome                 # dry run, changes nothing
  .\wake-probe.ps1 -DelayMinutes 5 -Label S3             # then put laptop to sleep
  .\wake-probe.ps1 -DelayMinutes 6 -Label hibernate -LaunchChrome
  .\wake-probe.ps1 -Mode Summarize -LogFile <log> -ExtensionLog <export.json>
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('Schedule', 'Fire', 'Summarize', 'Cleanup')]
  [string]$Mode = 'Schedule',
  # Minutes from now until the wake task fires (>= 2 recommended).
  [ValidateRange(1, 120)][int]$DelayMinutes = 5,
  # Free text tag for the run, e.g. S3 or hibernate.
  [string]$Label = 'run',
  # Launch Chrome (user's profile) after the network is up (criterion 4).
  [switch]$LaunchChrome,
  [string]$ChromePath = '',
  # Chrome user-data dir; empty = default location. Pass it if your profile lives elsewhere.
  [string]$ChromeUserDataDir = '',
  [string]$ChromeProfile = 'Default',
  # Hosts that must resolve AND accept a TCP connection before "network up".
  [string[]]$Hosts = @('one.one.one.one', 'www.msftconnecttest.com'),
  [int]$HostPort = 443,
  [int]$NetworkTimeoutSec = 300,
  [string]$LogDir = (Join-Path $env:LOCALAPPDATA 'ShopBadwill\probe'),
  # Internal: used by Fire mode.
  [string]$ConfigFile = '',
  # Summarize inputs.
  [string]$LogFile = '',
  [string]$ExtensionLog = ''
)

$ErrorActionPreference = 'Stop'
$TaskPrefix = 'ShopBadwillWakeProbe-'
$Inv = [Globalization.CultureInfo]::InvariantCulture
if ($MyInvocation.InvocationName -ne '.') { $wip = $WhatIfPreference; $WhatIfPreference = $false; Import-Module CimCmdlets, ScheduledTasks -ErrorAction SilentlyContinue; $WhatIfPreference = $wip }

# ---------------------------------------------------------------- pure logic
function Format-ProbeLine {
  param([datetimeoffset]$At, [string]$Event, [hashtable]$Data = @{})
  $kv = ($Data.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`t"
  $ts = $At.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
  if ($kv) { "$ts`t$Event`t$kv" } else { "$ts`t$Event" }
}

function ConvertFrom-ProbeLine {
  param([string]$Line)
  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  $parts = $Line -split "`t"
  if ($parts.Count -lt 2) { return $null }
  $at = [datetimeoffset]::MinValue
  $ok = [datetimeoffset]::TryParse($parts[0], [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$at)
  if (-not $ok) { return $null }
  $data = @{}
  if ($parts.Count -gt 2) {
    foreach ($p in $parts[2..($parts.Count - 1)]) {
      $i = $p.IndexOf('=')
      if ($i -gt 0) { $data[$p.Substring(0, $i)] = $p.Substring($i + 1) }
    }
  }
  [pscustomobject]@{ At = $at; Event = $parts[1]; Data = $data }
}

function Get-FirstEvent($events, [string]$name) { $events | Where-Object { $_.Event -eq $name } | Select-Object -First 1 }
function Get-Secs($a, $b) { if ($a -and $b) { [math]::Round(($b - $a).TotalSeconds, 1) } else { $null } }
function ConvertTo-Dto([string]$s) { [datetimeoffset]::Parse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal) }

# Computes timings from parsed log events (and optional extension onStartup times).
function Get-WakeSummary {
  param($Events, [datetimeoffset[]]$ExtOnStartup = @())
  $sched = Get-FirstEvent $Events 'SCHEDULED'
  $fired = Get-FirstEvent $Events 'FIRED'
  $wake = Get-FirstEvent $Events 'WAKE_EVENT'
  $net = Get-FirstEvent $Events 'NETWORK_UP'
  $chrome = Get-FirstEvent $Events 'CHROME_LAUNCHED'
  $due = $null
  if ($sched -and $sched.Data['dueAt']) { $due = ConvertTo-Dto $sched.Data['dueAt'] }
  $wakeAt = $null
  if ($wake -and $wake.Data['wakeTime']) { $wakeAt = ConvertTo-Dto $wake.Data['wakeTime'] }
  $firedAt = $null; if ($fired) { $firedAt = $fired.At }
  $netAt = $null; if ($net) { $netAt = $net.At }
  $chromeAt = $null; if ($chrome) { $chromeAt = $chrome.At }
  $onStartup = $null
  if ($chromeAt -and $ExtOnStartup.Count -gt 0) {
    $onStartup = $ExtOnStartup | Where-Object { $_ -ge $chromeAt.AddSeconds(-1) } | Sort-Object | Select-Object -First 1
  }
  $src = $null; if ($wake) { $src = $wake.Data['wakeSource'] }
  [pscustomobject]@{
    Label                   = if ($sched) { $sched.Data['label'] } else { $null }
    FiredAtAll              = [bool]$fired
    WakeSource              = $src
    WokeByTimer             = [bool]($src -match 'Timer')
    FireLatencySec          = Get-Secs $due $firedAt
    WakeToFireSec           = Get-Secs $wakeAt $firedAt
    FireToNetworkUpSec      = Get-Secs $firedAt $netAt
    WakeToNetworkUpSec      = Get-Secs $wakeAt $netAt
    NetworkUp               = [bool]$net
    ChromeToOnStartupSec    = Get-Secs $chromeAt $onStartup
    NetworkUpToOnStartupSec = Get-Secs $netAt $onStartup
  }
}

# Reads the probe extension export: { startups: [iso...] } or { log: [{type:'startup', t: iso}] }
function Get-ExtensionStartups {
  param([string]$Path)
  $j = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $out = @()
  if ($j.startups) { $out += $j.startups | ForEach-Object { ConvertTo-Dto ([string]$_) } }
  if ($j.log) { $out += $j.log | Where-Object { $_.type -eq 'startup' } | ForEach-Object { ConvertTo-Dto ([string]$_.t) } }
  $out
}

# ---------------------------------------------------------------- side effects
$script:LogPath = $null
function Write-ProbeLog {
  param([string]$Event, [hashtable]$Data = @{})
  $line = Format-ProbeLine -At ([datetimeoffset]::UtcNow) -Event $Event -Data $Data
  Write-Host $line
  if ($script:LogPath) {
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 -WhatIf:$false
  }
}

function Initialize-Log([string]$name) {
  if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force -WhatIf:$false | Out-Null }
  $script:LogPath = Join-Path $LogDir $name
}

function Find-Chrome {
  if ($ChromePath) { return $ChromePath }
  foreach ($p in @("$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Test-HostReachable([string]$h, [int]$port) {
  try {
    $null = [Net.Dns]::GetHostAddresses($h)
    $c = New-Object Net.Sockets.TcpClient
    try {
      $t = $c.ConnectAsync($h, $port)
      return ($t.Wait(3000) -and $c.Connected)
    } finally { $c.Dispose() }
  } catch { return $false }
}

function Get-PowerSnapshot {
  $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  $ac = 'unknown'
  if ($bat) { $ac = if ($bat.BatteryStatus -in 2, 6, 7, 8, 9) { 'AC' } else { 'battery' } }
  $rtc = (powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE 2>$null | Select-String 'Power Setting Index' | ForEach-Object { $_.Line.Trim() }) -join ' | '
  @{ powerSource = $ac; rtcwake = $rtc }
}

# Latest resume event (Power-Troubleshooter 1): wake time and wake source. Readable without admin.
function Get-LastWakeEvent([datetime]$since) {
  try {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1; StartTime = $since } -MaxEvents 1 -ErrorAction Stop
    $x = [xml]$ev.ToXml()
    $d = @{}
    foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
    $src = ''
    if ($ev.Message -match 'Wake Source:\s*(.+)') { $src = $Matches[1].Trim() }
    return @{ sleepTime = $d['SleepTime']; wakeTime = $d['WakeTime']; wakeSource = $src }
  } catch { return $null }
}

function Invoke-Schedule {
  $runId = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $suffix = ''; if ($WhatIfPreference) { $suffix = '-dryrun' }
  Initialize-Log "wake-$runId$suffix.log"
  $due = [datetimeoffset]::UtcNow.AddMinutes($DelayMinutes)
  $taskName = "$TaskPrefix$runId"
  $cfgPath = Join-Path $LogDir "run-$runId.json"
  $chrome = $null
  if ($LaunchChrome) { $chrome = Find-Chrome }
  if ($LaunchChrome -and -not $chrome) { throw 'Chrome not found; pass -ChromePath.' }

  $cfg = [ordered]@{
    runId = $runId; label = $Label; taskName = $taskName; logPath = $script:LogPath
    launchChrome = [bool]$LaunchChrome; chromePath = $chrome; chromeUserDataDir = $ChromeUserDataDir
    chromeProfile = $ChromeProfile; hosts = $Hosts; hostPort = $HostPort; networkTimeoutSec = $NetworkTimeoutSec
    dryRun = [bool]$WhatIfPreference
  }
  $snap = Get-PowerSnapshot
  $data = @{ label = $Label; runId = $runId; taskName = $taskName; dueAt = $due.ToString('o'); delayMin = $DelayMinutes; dryRun = [bool]$WhatIfPreference; launchChrome = [bool]$LaunchChrome }
  foreach ($k in $snap.Keys) { $data[$k] = $snap[$k] }
  Write-ProbeLog 'SCHEDULED' $data

  $psArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode Fire -ConfigFile `"$cfgPath`""
  if ($PSCmdlet.ShouldProcess("scheduled task $taskName", "Register one-off task at $($due.ToLocalTime().ToString('HH:mm:ss')) with WakeToRun")) {
    $cfg | ConvertTo-Json | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
    $trigger = New-ScheduledTaskTrigger -Once -At $due.LocalDateTime
    # Orphan safety: the trigger expires 1 h after due and the task then deletes itself.
    $trigger.EndBoundary = $due.LocalDateTime.AddHours(1).ToString('yyyy-MM-dd\THH:mm:ss')
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $settings.DeleteExpiredTaskAfter = 'PT10M'
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    $t = Get-ScheduledTask -TaskName $taskName
    Write-ProbeLog 'TASK_REGISTERED' @{ taskName = $taskName; wakeToRun = $t.Settings.WakeToRun; state = $t.State }
    Write-Host ''
    Write-Host "Task registered. It fires at $($due.ToLocalTime().ToString('HH:mm:ss')) local. NOW put the laptop to $Label (see docs/USER-STEPS/S-8.md)."
    Write-Host "Log: $script:LogPath"
  } else {
    Write-ProbeLog 'DRYRUN_PLAN' @{ action = "powershell.exe $psArgs"; wakeToRun = $true; startWhenAvailable = $true; principal = "$env:USERDOMAIN\$env:USERNAME interactive limited"; chrome = "$chrome"; profile = "$ChromeProfile"; hosts = ($Hosts -join ',') }
    Write-Host 'Dry run: nothing registered, nothing changed.'
  }
}

function Remove-ProbeTask($cfg) {
  if ($cfg.dryRun) { return }
  try { Unregister-ScheduledTask -TaskName $cfg.taskName -Confirm:$false -ErrorAction Stop; Write-ProbeLog 'TASK_REMOVED' @{ taskName = $cfg.taskName } }
  catch { Write-ProbeLog 'TASK_REMOVE_FAILED' @{ error = $_.Exception.Message; hint = 'run -Mode Cleanup' } }
}

function Invoke-FireBody($cfg) {
  $firedAt = [datetimeoffset]::UtcNow
  $up = [int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds
  Write-ProbeLog 'FIRED' @{ label = $cfg.label; uptimeSec = $up }
  $w = Get-LastWakeEvent ((Get-Date).AddMinutes(-($DelayMinutes + 60)))
  if ($w) {
    $wt = ''
    if ($w.wakeTime) { $wt = (ConvertTo-Dto $w.wakeTime).ToString('o') }
    Write-ProbeLog 'WAKE_EVENT' @{ wakeTime = $wt; sleepTime = $w.sleepTime; wakeSource = $w.wakeSource }
  } else { Write-ProbeLog 'WAKE_EVENT_MISSING' @{ note = 'no Power-Troubleshooter event 1 found (machine may not have slept)' } }

  $deadline = $firedAt.AddSeconds($cfg.networkTimeoutSec)
  $attempts = 0
  $netUp = $false
  while ([datetimeoffset]::UtcNow -lt $deadline) {
    $attempts++
    $ok = $true
    foreach ($h in $cfg.hosts) { if (-not (Test-HostReachable $h $cfg.hostPort)) { $ok = $false; break } }
    if ($ok) { $netUp = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($netUp) { Write-ProbeLog 'NETWORK_UP' @{ attempts = $attempts; hosts = ($cfg.hosts -join ',') } }
  else { Write-ProbeLog 'NETWORK_TIMEOUT' @{ attempts = $attempts; timeoutSec = $cfg.networkTimeoutSec } }

  if ($cfg.launchChrome) {
    if ($cfg.dryRun) { Write-ProbeLog 'CHROME_SKIPPED' @{ reason = 'dry run' } }
    elseif (Get-Process chrome -ErrorAction SilentlyContinue) {
      Write-ProbeLog 'CHROME_ALREADY_RUNNING' @{ note = 'onStartup will NOT fire; close Chrome fully before the test' }
    } else {
      $a = @("--profile-directory=$($cfg.chromeProfile)")
      if ($cfg.chromeUserDataDir) { $a += "--user-data-dir=$($cfg.chromeUserDataDir)" }
      Write-ProbeLog 'CHROME_LAUNCHED' @{ path = $cfg.chromePath; args = ($a -join ' ') }
      Start-Process -FilePath $cfg.chromePath -ArgumentList $a
    }
  }

}

function Invoke-Fire {
  if (-not $ConfigFile) { throw '-ConfigFile required in Fire mode.' }
  $cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $script:LogPath = $cfg.logPath
  try {
    Invoke-FireBody $cfg
  } catch {
    Write-ProbeLog 'FIRE_ERROR' @{ error = $_.Exception.Message }
    throw
  } finally {
    Remove-ProbeTask $cfg
    try {
      $ev = @(Get-Content -LiteralPath $script:LogPath | ForEach-Object { ConvertFrom-ProbeLine $_ } | Where-Object { $_ })
      Write-ProbeLog 'SUMMARY' @{ json = ((Get-WakeSummary -Events $ev) | ConvertTo-Json -Compress) }
    } catch { }
  }
}

function Invoke-Summarize {
  if (-not $LogFile) { throw '-LogFile required.' }
  $ev = @(Get-Content -LiteralPath $LogFile | ForEach-Object { ConvertFrom-ProbeLine $_ } | Where-Object { $_ })
  $ext = @()
  if ($ExtensionLog) { $ext = @(Get-ExtensionStartups $ExtensionLog) }
  Get-WakeSummary -Events $ev -ExtOnStartup $ext | Format-List
}

function Invoke-Cleanup {
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$TaskPrefix*" })
  if ($tasks.Count -eq 0) { Write-Host 'No leftover probe tasks.'; return }
  foreach ($t in $tasks) {
    if ($PSCmdlet.ShouldProcess($t.TaskName, 'Unregister')) { Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false; Write-Host "Removed $($t.TaskName)" }
  }
}

# Skipped when dot-sourced (unit tests).
if ($MyInvocation.InvocationName -ne '.') {
  switch ($Mode) {
    'Schedule' { Invoke-Schedule }
    'Fire' { Invoke-Fire }
    'Summarize' { Invoke-Summarize }
    'Cleanup' { Invoke-Cleanup }
  }
}

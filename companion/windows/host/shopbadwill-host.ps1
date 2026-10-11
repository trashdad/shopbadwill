<#
.SYNOPSIS
  ShopBadwill wake-and-launch companion: Chrome/Firefox native-messaging host.

.DESCRIPTION
  Speaks the native-messaging framing on stdin/stdout (4-byte little-endian
  length + UTF-8 JSON) and implements the ops documented in PROTOCOL.md:
  `schedule`, `cancel`, `list`. A schedule builds a one-off "wake the computer
  to run this task" Task Scheduler definition (WakeToRun XML, generated
  in-memory via the COM API) and registers it with `schtasks /Create /XML`;
  at fire time the task launches the configured browser with the user's
  profile. Task names are always `ShopBadwill-<snipeId>`; cancel and list
  only ever see or touch those names. Every message is validated strictly
  (controller ruling R2): the extension is treated as untrusted.

  Never runs by itself on this machine: install.ps1 is the USER STEP that
  registers the host manifests (controller ruling R1).
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\protocol.ps1"
. "$PSScriptRoot\task-xml.ps1"
. "$PSScriptRoot\io.ps1"

function New-SbwOkResponse {
  param([string]$Op, [hashtable]$Extra)
  $r = @{ ok = $true; op = $Op }
  foreach ($k in $Extra.Keys) { $r[$k] = $Extra[$k] }
  $r
}

function New-SbwErrorResponse {
  param([object]$Op, [string]$Error)
  @{ ok = $false; op = $Op; error = $Error }
}

function Invoke-SbwSchedule {
  param($Msg, $Config, [datetimeoffset]$Now)
  try {
    $err = Get-SbwScheduleError -Msg $Msg -Now $Now -Config $Config
    if ($err) { return New-SbwErrorResponse -Op 'schedule' -Error $err }
    $wt = Get-SbwWakeTime -Text ([string]$Msg.wakeAtUtc) -Now $Now
    $taskName = Get-SbwTaskName -SnipeId ([string]$Msg.snipeId)
    if ($taskName -cnotmatch $SbwTaskNameRegex) { return New-SbwErrorResponse -Op 'schedule' -Error 'bad-request' }
    $browserCfg = $Config.PSObject.Properties[[string]$Msg.browser].Value
    if (-not (Test-Path -LiteralPath ([string]$browserCfg.exePath))) {
      return New-SbwErrorResponse -Op 'schedule' -Error 'browser-not-found'
    }
    # Launch the installed spelling, not whatever case the message used.
    $browserArgs = Get-SbwBrowserArgs -Browser ([string]$Msg.browser) -Profile ([string]$browserCfg.profile)
    $cmd = Get-SbwLaunchCommand -ExePath ([string]$browserCfg.exePath) -BrowserArgs $browserArgs
    $xml = New-SbwTaskXml -TaskName $taskName -WakeAtUtc $wt.value -Execute $cmd.Execute `
      -Arguments $cmd.Arguments -UserId "$env:USERDOMAIN\$env:USERNAME"
    $xmlPath = Write-SbwXmlFile -DataDir ([string]$Config.dataDir) -TaskName $taskName -Xml $xml
    $run = Invoke-SchTasks -SchTasksPath ([string]$Config.schtasksPath) -ArgList (Get-SbwScheduleArgs -TaskName $taskName -XmlPath $xmlPath)
    if ($run.ExitCode -ne 0) {
      Remove-Item -LiteralPath $xmlPath -ErrorAction SilentlyContinue
      [Console]::Error.WriteLine("Sbw schedule failed: $($run.Output)")
      return New-SbwErrorResponse -Op 'schedule' -Error 'schtasks-failed'
    }
    $wakeIso = $wt.value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $rows = @(Read-SbwState -DataDir ([string]$Config.dataDir) | Where-Object { $_.taskName -cne $taskName })
    $rows += [pscustomobject]@{
      snipeId  = [string]$Msg.snipeId
      taskName = $taskName
      wakeAtUtc = $wakeIso
      browser  = [string]$Msg.browser
      profile  = [string]$browserCfg.profile
    }
    Write-SbwState -DataDir ([string]$Config.dataDir) -Rows $rows
    return New-SbwOkResponse -Op 'schedule' @{ taskName = $taskName; wakeAtUtc = $wakeIso }
  } catch {
    [Console]::Error.WriteLine("Sbw schedule internal error: $($_.Exception.Message)")
    return New-SbwErrorResponse -Op 'schedule' -Error 'internal'
  }
}

function Invoke-SbwCancel {
  param($Msg, $Config)
  try {
    $err = Get-SbwCancelError -Msg $Msg
    if ($err) { return New-SbwErrorResponse -Op 'cancel' -Error $err }
    $taskName = Get-SbwTaskName -SnipeId ([string]$Msg.snipeId)
    if ($taskName -cnotmatch $SbwTaskNameRegex) { return New-SbwErrorResponse -Op 'cancel' -Error 'bad-request' }
    $run = Invoke-SchTasks -SchTasksPath ([string]$Config.schtasksPath) -ArgList (Get-SbwCancelArgs -TaskName $taskName)
    $alreadyGone = $run.Output -match 'cannot find'
    if ($run.ExitCode -ne 0 -and -not $alreadyGone) {
      [Console]::Error.WriteLine("Sbw cancel failed: $($run.Output)")
      return New-SbwErrorResponse -Op 'cancel' -Error 'schtasks-failed'
    }
    $rows = @(Read-SbwState -DataDir ([string]$Config.dataDir) | Where-Object { $_.taskName -cne $taskName })
    Write-SbwState -DataDir ([string]$Config.dataDir) -Rows $rows
    return New-SbwOkResponse -Op 'cancel' @{ taskName = $taskName }
  } catch {
    [Console]::Error.WriteLine("Sbw cancel internal error: $($_.Exception.Message)")
    return New-SbwErrorResponse -Op 'cancel' -Error 'internal'
  }
}

function Invoke-SbwList {
  param($Msg, $Config)
  try {
    $err = Get-SbwListError -Msg $Msg
    if ($err) { return New-SbwErrorResponse -Op 'list' -Error $err }
    $rows = @(Read-SbwState -DataDir ([string]$Config.dataDir))
    $live = @()
    foreach ($row in $rows) {
      if ($null -eq $row) { continue }
      $snipeId = [string]$row.snipeId
      # State is local, but it is not a trust boundary: a tampered snipeId must
      # not become a schtasks /TN for some other task.
      if (-not (Test-SbwSnipeId -Value $snipeId)) { continue }
      $taskName = Get-SbwTaskName -SnipeId $snipeId
      if ($taskName -cnotmatch $SbwTaskNameRegex) { continue }
      $run = Invoke-SchTasks -SchTasksPath ([string]$Config.schtasksPath) -ArgList (Get-SbwQueryArgs -TaskName $taskName)
      if ($run.ExitCode -ne 0) { continue }   # the OS deleted the fired task: prune
      $row.taskName = $taskName
      $live += $row
    }
    if ($live.Count -ne $rows.Count) { Write-SbwState -DataDir ([string]$Config.dataDir) -Rows $live }
    $tasks = @($live | Sort-Object -Property wakeAtUtc | ForEach-Object {
        [pscustomobject]@{
          snipeId   = [string]$_.snipeId
          taskName  = [string]$_.taskName
          wakeAtUtc = [string]$_.wakeAtUtc
          browser   = [string]$_.browser
          profile   = [string]$_.profile
        }
      })
    return New-SbwOkResponse -Op 'list' @{ tasks = $tasks }
  } catch {
    [Console]::Error.WriteLine("Sbw list internal error: $($_.Exception.Message)")
    return New-SbwErrorResponse -Op 'list' -Error 'internal'
  }
}

# One request → one response. Untrusted input; every refusal is an ok:false frame.
function Invoke-SbwMessage {
  param([string]$Json, $Config, [datetimeoffset]$Now)
  $msg = $null
  try { $msg = ConvertFrom-Json -InputObject $Json } catch { return New-SbwErrorResponse -Op $null -Error 'invalid-json' }
  if ($msg -isnot [pscustomobject]) { return New-SbwErrorResponse -Op $null -Error 'bad-request' }
  $op = $null
  if ($msg.PSObject.Properties.Name -ccontains 'op' -and $msg.op -is [string]) { $op = $msg.op }
  switch ($op) {
    'schedule' { Invoke-SbwSchedule -Msg $msg -Config $Config -Now $Now }
    'cancel' { Invoke-SbwCancel -Msg $msg -Config $Config }
    'list' { Invoke-SbwList -Msg $msg -Config $Config }
    default { New-SbwErrorResponse -Op $op -Error 'bad-request' }
  }
}

# Native-messaging loop: read frames until the browser closes stdin.
function Invoke-SbwHost {
  param([string]$ConfigPath)
  $cfg = $null
  try { $cfg = Get-SbwConfig -Path $ConfigPath }
  catch {
    [Console]::Error.WriteLine("Sbw host config error: $($_.Exception.Message)")
    $frame = ConvertTo-SbwFrame -Message (New-SbwErrorResponse -Op $null -Error 'internal')
    $out = [Console]::OpenStandardOutput()
    $out.Write($frame, 0, $frame.Length)
    $out.Flush()
    return
  }
  $stdin = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()
  while ($true) {
    $lenBuf = Read-SbwBytes -Stream $stdin -Count 4
    if ($null -eq $lenBuf) { break }   # EOF: browser closed the connection
    $len = [BitConverter]::ToUInt32($lenBuf, 0)
    if (-not (Test-SbwFrameLength -Length $len)) {
      # The stream position is no longer trustworthy: answer once and exit.
      $frame = ConvertTo-SbwFrame -Message (New-SbwErrorResponse -Op $null -Error 'bad-request')
      $stdout.Write($frame, 0, $frame.Length)
      $stdout.Flush()
      break
    }
    $body = Read-SbwBytes -Stream $stdin -Count $len
    if ($null -eq $body) { break }
    $json = [Text.Encoding]::UTF8.GetString($body)
    $resp = Invoke-SbwMessage -Json $json -Config $cfg -Now ([datetimeoffset]::UtcNow)
    $frame = ConvertTo-SbwFrame -Message $resp
    $stdout.Write($frame, 0, $frame.Length)
    $stdout.Flush()
  }
}

# Skipped when dot-sourced (unit tests).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-SbwHost -ConfigPath $ConfigPath
}

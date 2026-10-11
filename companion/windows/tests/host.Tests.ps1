# Pester tests for the host dispatch: schedule/cancel/list with stubbed schtasks,
# state storage and XML writing (controller ruling R1: no real tasks, no real
# schtasks, no registry on this machine). The side-effect functions are redefined
# in this file's scope AFTER dot-sourcing the host, so the host calls the stubs.
. "$PSScriptRoot\test-helpers.ps1"
. "$PSScriptRoot\..\host\shopbadwill-host.ps1"

# ---- stubs replacing io.ps1 side effects (definition order matters: later wins) ----
function Invoke-SchTasks {
  param([string]$SchTasksPath, [string[]]$ArgList)
  # One nested array per call. A joined string would hide a concatenated command.
  $script:sbwCalls += ,(@($ArgList))
  if ($ArgList -ccontains '/Query' -and $script:sbwQueryMissing) {
    return @{ ExitCode = 1; Output = 'ERROR: The system cannot find the file specified.' }
  }
  if ($ArgList -ccontains '/Delete' -and $script:sbwDeleteMissing) {
    return @{ ExitCode = 1; Output = 'ERROR: The system cannot find the file specified.' }
  }
  if ($script:sbwSchTasksFail) { return @{ ExitCode = 1; Output = 'ERROR: boom.' } }
  @{ ExitCode = 0; Output = '' }
}

function Read-SbwState {
  param([string]$DataDir)
  foreach ($t in @($script:sbwState)) { $t }
}

function Write-SbwState {
  param([string]$DataDir, $Rows)
  $script:sbwState = @($Rows)
}

function Write-SbwXmlFile {
  param([string]$DataDir, [string]$TaskName, [string]$Xml)
  $script:sbwXml = $Xml
  (Join-Path $DataDir "$TaskName.xml")
}

# Empty file so Test-Path succeeds. The host must not execute it; schtasks is stubbed.
$script:sbwFakeBrowser = Join-Path ([IO.Path]::GetTempPath()) 'sbw-t110-fake-browser.exe'
if (-not (Test-Path -LiteralPath $script:sbwFakeBrowser)) {
  [IO.File]::WriteAllText($script:sbwFakeBrowser, '')
}

function New-SbwTestConfig {
  [pscustomobject]@{
    dataDir      = 'C:\fake-data'
    schtasksPath = 'C:\sbw-no-such\schtasks.exe'
    chrome       = [pscustomobject]@{ exePath = $script:sbwFakeBrowser; profile = 'Default' }
    firefox      = [pscustomobject]@{ exePath = $script:sbwFakeBrowser; profile = 'default-release' }
  }
}

function Reset-SbwFakes {
  $script:sbwCalls = @()
  $script:sbwState = @()
  $script:sbwXml = $null
  $script:sbwQueryMissing = $false
  $script:sbwDeleteMissing = $false
  $script:sbwSchTasksFail = $false
}

# Fixtures live in functions: variables assigned at file level are not reliably
# visible to It blocks under Pester 5 (discovery vs run).
function Get-SbwTestNow {
  [datetimeoffset]::Parse('2026-10-10T12:00:00Z')
}

Describe 'host schedule dispatch' {
  It 'schedules: registers with a prefixed task name, writes WakeToRun XML, stores state' {
    Reset-SbwFakes
    $json = '{"op":"schedule","snipeId":"abc-123","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp = Invoke-SbwMessage -Json $json -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.op 'schedule'
    Assert-Equal $resp.taskName 'ShopBadwill-abc-123'
    Assert-Equal $resp.wakeAtUtc '2026-10-10T13:00:00.000Z'
    Assert-Equal $script:sbwCalls.Count 1
    Assert-ArrayEqual $script:sbwCalls[0] @('/Create', '/TN', 'ShopBadwill-abc-123', '/XML', 'C:\fake-data\ShopBadwill-abc-123.xml', '/F')
    Assert-Equal $script:sbwState.Count 1
    Assert-Equal $script:sbwState[0].snipeId 'abc-123'
    Assert-Equal $script:sbwState[0].profile 'Default'
    $xml = [xml]$script:sbwXml
    Assert-Equal ([string]$xml.Task.Settings.WakeToRun) 'true'
    Assert-Equal ([string]$xml.Task.Actions.Exec.Command) $script:sbwFakeBrowser
    Assert-Equal ([string]$xml.Task.Actions.Exec.Arguments) '--profile-directory=Default'
    Assert-Equal ([string]$xml.Task.Settings.ExecutionTimeLimit) 'PT0S'
    Assert-Equal ([string]$xml.Task.Settings.DeleteExpiredTaskAfter) 'PT10M'
    Assert-Equal ([string]$xml.Task.Principals.Principal.LogonType) 'InteractiveToken'
    Assert-Equal ([string]$xml.Task.Principals.Principal.RunLevel) 'LeastPrivilege'
    Assert-NotMatch $script:sbwXml 'HighestAvailable'
    Assert-NotMatch $script:sbwXml '<Password>'
    Assert-NotMatch $script:sbwXml 'cmd\.exe'
    Assert-NotMatch ([string]$xml.Task.Actions.Exec.Arguments) '(?<![A-Za-z0-9])/c(?![A-Za-z0-9])'
  }
  It 'launches the configured profile spelling, not the message case variant' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $json = '{"op":"schedule","snipeId":"abc-123","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"default"}'
    $resp = Invoke-SbwMessage -Json $json -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    $xml = [xml]$script:sbwXml
    Assert-Equal ([string]$xml.Task.Actions.Exec.Arguments) '--profile-directory=Default'
    Assert-NotMatch ([string]$xml.Task.Actions.Exec.Arguments) '--profile-directory=default'
    Assert-Equal $script:sbwState[0].profile 'Default'
  }
  It 're-scheduling the same snipe overwrites its own state row' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $first = '{"op":"schedule","snipeId":"s1","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $null = Invoke-SbwMessage -Json $first -Config $cfg -Now (Get-SbwTestNow)
    $second = '{"op":"schedule","snipeId":"s1","wakeAtUtc":"2026-10-11T02:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp = Invoke-SbwMessage -Json $second -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $script:sbwState.Count 1
    Assert-Equal $script:sbwState[0].wakeAtUtc '2026-10-11T02:00:00.000Z'
    Assert-Equal $script:sbwCalls.Count 2
  }
  It 'refuses an invalid message without ever calling schtasks' {
    Reset-SbwFakes
    $json = '{"op":"schedule","snipeId":"../evil","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp = Invoke-SbwMessage -Json $json -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $false
    Assert-Equal $resp.error 'bad-request'
    Assert-Equal $script:sbwCalls.Count 0
    Assert-Equal $script:sbwState.Count 0
  }
  It 'refuses an unknown profile and a missing browser' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $unknown = '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Profile 9"}'
    $resp = Invoke-SbwMessage -Json $unknown -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.error 'unknown-profile'
    $cfg2 = New-SbwTestConfig
    $cfg2.chrome = [pscustomobject]@{ exePath = ''; profile = 'Default' }
    $noconf = '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp2 = Invoke-SbwMessage -Json $noconf -Config $cfg2 -Now (Get-SbwTestNow)
    Assert-Equal $resp2.error 'browser-not-configured'
    Assert-Equal $script:sbwCalls.Count 0
  }
  It 'reports schtasks failure and does not store state' {
    Reset-SbwFakes
    $script:sbwSchTasksFail = $true
    $json = '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp = Invoke-SbwMessage -Json $json -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $false
    Assert-Equal $resp.error 'schtasks-failed'
    Assert-Equal $script:sbwState.Count 0
  }
  It 'reports a moved browser executable' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $cfg.chrome = [pscustomobject]@{ exePath = 'C:\nowhere\chrome.exe'; profile = 'Default' }
    $json = '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
    $resp = Invoke-SbwMessage -Json $json -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $false
    Assert-Equal $resp.error 'browser-not-found'
  }
}

Describe 'host cancel dispatch' {
  It 'cancels a scheduled task and prunes the state row' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $null = Invoke-SbwMessage -Json '{"op":"schedule","snipeId":"s1","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}' -Config $cfg -Now (Get-SbwTestNow)
    $resp = Invoke-SbwMessage -Json '{"op":"cancel","snipeId":"s1"}' -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.taskName 'ShopBadwill-s1'
    Assert-Equal $script:sbwState.Count 0
    Assert-ArrayEqual $script:sbwCalls[1] @('/Delete', '/TN', 'ShopBadwill-s1', '/F')
  }
  It 'cancel of an unknown snipe is idempotent (task already gone)' {
    Reset-SbwFakes
    $script:sbwDeleteMissing = $true
    $resp = Invoke-SbwMessage -Json '{"op":"cancel","snipeId":"nope"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-ArrayEqual $script:sbwCalls[0] @('/Delete', '/TN', 'ShopBadwill-nope', '/F')
  }
  It 'cancel never touches a non-prefixed task name' {
    Reset-SbwFakes
    $resp = Invoke-SbwMessage -Json '{"op":"cancel","snipeId":"a"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-ArrayEqual $script:sbwCalls[0] @('/Delete', '/TN', 'ShopBadwill-a', '/F')
  }
  It 'reports a real delete failure' {
    Reset-SbwFakes
    $script:sbwSchTasksFail = $true
    $resp = Invoke-SbwMessage -Json '{"op":"cancel","snipeId":"a"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $false
    Assert-Equal $resp.error 'schtasks-failed'
  }
}

Describe 'host list dispatch' {
  It 'returns an empty task list when nothing is scheduled' {
    Reset-SbwFakes
    $resp = Invoke-SbwMessage -Json '{"op":"list"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.tasks.Count 0
  }
  It 'lists scheduled tasks, sorted by wake time, prefixed names only' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $null = Invoke-SbwMessage -Json '{"op":"schedule","snipeId":"later","wakeAtUtc":"2026-10-10T15:00:00.000Z","browser":"chrome","profile":"Default"}' -Config $cfg -Now (Get-SbwTestNow)
    $null = Invoke-SbwMessage -Json '{"op":"schedule","snipeId":"sooner","wakeAtUtc":"2026-10-10T14:00:00.000Z","browser":"firefox","profile":"default-release"}' -Config $cfg -Now (Get-SbwTestNow)
    $resp = Invoke-SbwMessage -Json '{"op":"list"}' -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.tasks.Count 2
    Assert-Equal $resp.tasks[0].snipeId 'sooner'
    Assert-Equal $resp.tasks[1].snipeId 'later'
    Assert-Equal $resp.tasks[0].taskName 'ShopBadwill-sooner'
    Assert-Equal $resp.tasks[1].taskName 'ShopBadwill-later'
  }
  It 'prunes state rows whose task is gone and queries only prefixed names' {
    Reset-SbwFakes
    $cfg = New-SbwTestConfig
    $null = Invoke-SbwMessage -Json '{"op":"schedule","snipeId":"gone","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}' -Config $cfg -Now (Get-SbwTestNow)
    $null = Invoke-SbwMessage -Json '{"op":"schedule","snipeId":"kept","wakeAtUtc":"2026-10-10T14:00:00.000Z","browser":"chrome","profile":"Default"}' -Config $cfg -Now (Get-SbwTestNow)
    $script:sbwQueryMissing = $true
    $resp = Invoke-SbwMessage -Json '{"op":"list"}' -Config $cfg -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.tasks.Count 0
    Assert-Equal $script:sbwState.Count 0
    foreach ($call in $script:sbwCalls) {
      $parts = @($call)
      if ($parts -ccontains '/Query') {
        Assert-ArrayEqual $parts @('/Query', '/TN', $parts[2], '/FO', 'CSV', '/NH')
        Assert-Match ([string]$parts[2]) '^ShopBadwill-[A-Za-z0-9_-]{1,64}$'
      }
    }
  }
  It 'ignores a poisoned state row and reports only the computed ShopBadwill- name' {
    Reset-SbwFakes
    $script:sbwState = @(
      [pscustomobject]@{ snipeId = '..\..\Windows'; taskName = '\Microsoft\Windows\Foo'; wakeAtUtc = '2026-10-10T13:00:00.000Z'; browser = 'chrome'; profile = 'Default' }
      [pscustomobject]@{ snipeId = 'kept'; taskName = 'NotOurs'; wakeAtUtc = '2026-10-10T14:00:00.000Z'; browser = 'chrome'; profile = 'Default' }
    )
    $resp = Invoke-SbwMessage -Json '{"op":"list"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $true
    Assert-Equal $resp.tasks.Count 1
    Assert-Equal $resp.tasks[0].snipeId 'kept'
    Assert-Equal $resp.tasks[0].taskName 'ShopBadwill-kept'
    Assert-Equal $script:sbwCalls.Count 1
    Assert-ArrayEqual $script:sbwCalls[0] @('/Query', '/TN', 'ShopBadwill-kept', '/FO', 'CSV', '/NH')
  }
}

Describe 'host message-level refusals' {
  It 'refuses invalid JSON and non-object JSON' {
    Reset-SbwFakes
    $r1 = Invoke-SbwMessage -Json 'not json' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $r1.ok $false
    Assert-Equal $r1.error 'invalid-json'
    $r2 = Invoke-SbwMessage -Json '[1,2]' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $r2.ok $false
    Assert-Equal $r2.error 'bad-request'
    $r3 = Invoke-SbwMessage -Json '"just a string"' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $r3.ok $false
    Assert-Equal $r3.error 'bad-request'
    Assert-Equal $script:sbwCalls.Count 0
  }
  It 'refuses an unknown op' {
    Reset-SbwFakes
    $resp = Invoke-SbwMessage -Json '{"op":"destroy","snipeId":"a"}' -Config (New-SbwTestConfig) -Now (Get-SbwTestNow)
    Assert-Equal $resp.ok $false
    Assert-Equal $resp.error 'bad-request'
    Assert-Equal $script:sbwCalls.Count 0
  }
}

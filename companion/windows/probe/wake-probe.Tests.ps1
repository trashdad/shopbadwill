# Pester 3.x/4.x compatible. Run from repo root:
#   Invoke-Pester companion/windows/probe/wake-probe.Tests.ps1
. "$PSScriptRoot\wake-probe.ps1"

Describe 'probe log round-trip' {
  It 'formats and parses a line' {
    $at = [datetimeoffset]::Parse('2026-10-08T03:00:01.250Z')
    $l = Format-ProbeLine -At $at -Event 'FIRED' -Data @{ b = '2'; a = '1' }
    $l | Should Be "2026-10-08T03:00:01.250Z`tFIRED`ta=1`tb=2"
    $p = ConvertFrom-ProbeLine $l
    $p.Event | Should Be 'FIRED'
    $p.Data['b'] | Should Be '2'
    $p.At.ToUniversalTime().ToString('o') | Should Be '2026-10-08T03:00:01.2500000+00:00'
  }
  It 'ignores junk lines' {
    ConvertFrom-ProbeLine '' | Should BeNullOrEmpty
    ConvertFrom-ProbeLine 'not a log line' | Should BeNullOrEmpty
  }
}

Describe 'Get-WakeSummary' {
  $lines = @(
    "2026-10-08T03:00:00.000Z`tSCHEDULED`tdueAt=2026-10-08T03:05:00.0000000+00:00`tlabel=S3",
    "2026-10-08T03:05:09.000Z`tFIRED`tlabel=S3",
    "2026-10-08T03:05:09.500Z`tWAKE_EVENT`twakeSource=Timer - Task`twakeTime=2026-10-08T03:05:02.0000000+00:00",
    "2026-10-08T03:05:21.000Z`tNETWORK_UP`tattempts=24",
    "2026-10-08T03:05:22.000Z`tCHROME_LAUNCHED`tpath=x"
  )
  $ev = @($lines | ForEach-Object { ConvertFrom-ProbeLine $_ })
  It 'computes the timings' {
    $s = Get-WakeSummary -Events $ev -ExtOnStartup @([datetimeoffset]::Parse('2026-10-08T03:05:25.000Z'))
    $s.FireLatencySec | Should Be 9
    $s.WakeToFireSec | Should Be 7
    $s.FireToNetworkUpSec | Should Be 12
    $s.WakeToNetworkUpSec | Should Be 19
    $s.ChromeToOnStartupSec | Should Be 3
    $s.NetworkUpToOnStartupSec | Should Be 4
    $s.WokeByTimer | Should Be $true
  }
  It 'reports a task that never fired' {
    $s = Get-WakeSummary -Events @($ev[0])
    $s.FiredAtAll | Should Be $false
    $s.WakeToNetworkUpSec | Should BeNullOrEmpty
  }
}

Describe 'Invoke-Fire cleanup' {
  It 'unregisters its own task even when the Fire body throws' {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("sbwprobe-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $cfgFile = Join-Path $tmp 'run.json'
    @{ taskName = 'ShopBadwillWakeProbe-test'; logPath = (Join-Path $tmp 'x.log'); dryRun = $false } | ConvertTo-Json | Set-Content $cfgFile
    $script:ConfigFile = $cfgFile
    Mock Invoke-FireBody { throw 'boom' }
    Mock Unregister-ScheduledTask { }
    $threw = $false
    try { Invoke-Fire } catch { $threw = $true }
    Remove-Item $tmp -Recurse -Force
    $threw | Should Be $true
    Assert-MockCalled Unregister-ScheduledTask -Exactly 1 -ParameterFilter { $TaskName -eq 'ShopBadwillWakeProbe-test' }
  }
  It 'does not unregister in dry-run mode' {
    $cfg = [pscustomobject]@{ taskName = 't'; dryRun = $true }
    Mock Unregister-ScheduledTask { }
    Remove-ProbeTask $cfg
    Assert-MockCalled Unregister-ScheduledTask -Exactly 0 -ParameterFilter { $TaskName -eq 't' }
  }
}

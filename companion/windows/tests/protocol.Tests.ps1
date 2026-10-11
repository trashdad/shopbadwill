# Pester tests for the native-messaging framing and the strict request validation
# (controller ruling R2, verbatim: snipeId regex, future ISO-UTC wake time <= 30
# days, browser enum, profile character allowlist, ShopBadwill- task prefix).
# All setup lives in BeforeAll: Pester 5 runs top-level and Describe-body code
# during Discovery only (see Get-SbwPesterShapeViolations in test-helpers.ps1).
Describe 'companion protocol' {
  BeforeAll {
    . "$PSScriptRoot\test-helpers.ps1"
    . "$PSScriptRoot\..\host\protocol.ps1"

    function New-SbwTestConfig {
      [pscustomobject]@{
        dataDir       = 'C:\fake-data'
        schtasksPath  = 'C:\Windows\System32\schtasks.exe'
        chrome        = [pscustomobject]@{ exePath = (Join-Path $env:SystemRoot 'System32\cmd.exe'); profile = 'Default' }
        firefox       = [pscustomobject]@{ exePath = (Join-Path $env:SystemRoot 'System32\cmd.exe'); profile = 'default-release' }
      }
    }

    function ConvertFrom-SbwTestJson {
      param([string]$Json)
      $Json | ConvertFrom-Json
    }

    # Fixtures are functions defined here, in BeforeAll, so every It sees them.
    function Get-SbwTestNow {
      [datetimeoffset]::Parse('2026-10-10T12:00:00Z')
    }
  }

  Context 'native-messaging framing' {
    It 'frames as 4-byte little-endian length + UTF-8 JSON' {
      $frame = ConvertTo-SbwFrame @{ ok = $true }
      Assert-Equal $frame.Length (4 + 11) # {"ok":true}
      $len = [BitConverter]::ToUInt32($frame, 0)
      Assert-Equal $len 11
      Assert-Equal ([Text.Encoding]::UTF8.GetString($frame, 4, 11)) '{"ok":true}'
    }
    It 'round-trips a message through a stream with exact reads' {
      $ms = New-Object IO.MemoryStream
      $frame = ConvertTo-SbwFrame @{ ok = $true; op = 'list'; tasks = @(@{ a = 1 }) }
      $ms.Write($frame, 0, $frame.Length)
      $ms.Position = 0
      $lenBuf = Read-SbwBytes -Stream $ms -Count 4
      Assert-NotNull $lenBuf
      $len = [BitConverter]::ToUInt32($lenBuf, 0)
      $body = Read-SbwBytes -Stream $ms -Count $len
      Assert-NotNull $body
      $back = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
      Assert-Equal $back.ok $true
      Assert-Equal $back.op 'list'
      Assert-Equal $back.tasks[0].a 1
    }
    It 'returns null at EOF instead of a partial read' {
      $ms = New-Object IO.MemoryStream
      $ms.Write([byte[]](1, 2, 3), 0, 3)
      $ms.Position = 0
      $three = Read-SbwBytes -Stream $ms -Count 3
      Assert-NotNull $three
      $more = Read-SbwBytes -Stream $ms -Count 1
      Assert-Null $more
    }
    It 'refuses oversized frames' {
      Assert-False (Test-SbwFrameLength 0)
      Assert-False (Test-SbwFrameLength -1)
      Assert-False (Test-SbwFrameLength 1048577)
      Assert-True (Test-SbwFrameLength 1)
      Assert-True (Test-SbwFrameLength 1048576)
    }
    It 'throws when a response would exceed 1 MiB' {
      $huge = 'x' * 1049000
      $threw = $false
      try { ConvertTo-SbwFrame @{ ok = $true; blob = $huge } | Out-Null } catch { $threw = $true }
      Assert-True $threw
    }
    It 'turns an oversized outbound message into a small error frame' {
      $huge = 'x' * 1049000
      $frame = New-SbwOutboundFrame @{ ok = $true; blob = $huge }
      Assert-True ($frame.Length -lt 256)
      $msg = ConvertFrom-SbwFrame -FrameBytes $frame
      Assert-Equal $msg.ok $false
      Assert-Equal $msg.error 'bad-request'
    }
    It 'reads one inbound frame' {
      $ms = New-Object IO.MemoryStream
      $frame = ConvertTo-SbwFrame @{ op = 'list' }
      $ms.Write($frame, 0, $frame.Length)
      $ms.WriteByte(0x42)
      $ms.Position = 0
      $read = Read-SbwHostFrame -Stream $ms
      Assert-Null $read.Error
      Assert-Equal $read.Json '{"op":"list"}'
      Assert-Equal $ms.Position $frame.Length
    }
    It 'refuses an inbound length over 1 MiB without reading a body' {
      $ms = New-Object IO.MemoryStream
      $len = [BitConverter]::GetBytes([uint32]1048577)
      $ms.Write($len, 0, 4)
      $ms.WriteByte(0x41)
      $ms.Position = 0
      $read = Read-SbwHostFrame -Stream $ms
      Assert-Equal $read.Error 'bad-request'
      Assert-Null $read.Json
      Assert-Equal $ms.Position 4
    }
  }

  Context 'host loop uses the frame helpers' {
    It 'replies through New-SbwOutboundFrame and reads through Read-SbwHostFrame' {
      $src = Get-SbwTestText '..\host\shopbadwill-host.ps1'
      Assert-Match $src 'Read-SbwHostFrame'
      Assert-Match $src 'New-SbwOutboundFrame'
      Assert-NotMatch $src 'ConvertTo-SbwFrame'
    }
  }

  Context 'schedule validation (R2, verbatim)' {
    It 'accepts a well-formed schedule message' {
      $valid = '{"op":"schedule","snipeId":"abc-123","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Null (Get-SbwScheduleError -Msg (ConvertFrom-SbwTestJson $valid) -Now (Get-SbwTestNow) -Config (New-SbwTestConfig))
    }
    It 'accepts wakeAtUtc with an explicit +00:00 offset' {
      $m = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00+00:00","browser":"chrome","profile":"Default"}'
      Assert-Null (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig))
    }
    It 'rejects snipeId: empty, 65 chars, slashes, spaces, unicode' {
      foreach ($bad in @('', ('a' * 65), 'a/b', 'has space', 'abc.def', 'ünïcode')) {
        $m = ConvertFrom-SbwTestJson ('{"op":"schedule","snipeId":"' + $bad + '","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}')
        Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
      }
    }
    It 'accepts snipeId at the 64-char boundary' {
      $m = ConvertFrom-SbwTestJson ('{"op":"schedule","snipeId":"' + ('a' * 64) + '","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}')
      Assert-Null (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig))
    }
    It 'rejects wakeAtUtc: garbage, no zone, non-UTC offset' {
      foreach ($bad in @('garbage', '2026-10-10T13:00:00', '2026-10-10T13:00:00+02:00', '2026-10-10 13:00:00Z')) {
        $m = ConvertFrom-SbwTestJson ('{"op":"schedule","snipeId":"a","wakeAtUtc":"' + $bad + '","browser":"chrome","profile":"Default"}')
        Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
      }
    }
    It 'rejects wakeAtUtc in the past, at exactly now, and past 30 days; accepts boundaries' {
      $past = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T11:59:59.999Z","browser":"chrome","profile":"Default"}'
      Assert-Equal (Get-SbwScheduleError -Msg $past -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'wake-in-past'
      $exactNow = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T12:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Equal (Get-SbwScheduleError -Msg $exactNow -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'wake-in-past'
      $tooFar = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-11-09T13:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Equal (Get-SbwScheduleError -Msg $tooFar -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'wake-too-far-ahead'
      $at30d = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-11-09T12:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Null (Get-SbwScheduleError -Msg $at30d -Now (Get-SbwTestNow) -Config (New-SbwTestConfig))
    }
    It 'rejects browser values other than chrome/firefox, case-sensitively' {
      foreach ($bad in @('edge', 'Chrome', 'FIREFOX', '')) {
        $m = ConvertFrom-SbwTestJson ('{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"' + $bad + '","profile":"Default"}')
        Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
      }
    }
    It 'rejects every forbidden profile character and newlines' {
      foreach ($bad in @('a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b', "a`nb", "a`rb")) {
        $json = '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"' + $bad.Replace('\', '\\').Replace('"', '\"') + '"}'
        $m = ConvertFrom-SbwTestJson $json
        Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
      }
    }
    It 'refuses shell and traversal payloads even when that profile is the configured one' {
      # Configured to the payload on purpose: an allowlist-only check would accept it.
      foreach ($bad in @(
          'a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b',
          "a`nb", "a`rb", 'pre`post', '$(calc)', 'a$(Get-Date)b',
          '..\..\Windows\System32', 'foo/../bar', 'foo\..\bar', '..',
          ']]>', 'a]]>b', '<![CDATA[x', '-headless', '--user-data-dir=C:\x', '-'
        )) {
        $cfg = New-SbwTestConfig
        $cfg.chrome = [pscustomobject]@{ exePath = 'C:\browser\chrome.exe'; profile = $bad }
        $json = @{ op = 'schedule'; snipeId = 'a'; wakeAtUtc = '2026-10-10T13:00:00.000Z'; browser = 'chrome'; profile = $bad } | ConvertTo-Json -Compress
        $err = Get-SbwScheduleError -Msg ($json | ConvertFrom-Json) -Now (Get-SbwTestNow) -Config $cfg
        Assert-Equal $err 'bad-request' $bad
      }
    }
    It 'refuses injection payloads in snipeId' {
      foreach ($bad in @('a&b', 'a|b', 'a^b', 'a%b', 'a"b', 'pre`post', '$(calc)', '..\..\x', "a`nb", 'has space')) {
        $json = @{ op = 'schedule'; snipeId = $bad; wakeAtUtc = '2026-10-10T13:00:00.000Z'; browser = 'chrome'; profile = 'Default' } | ConvertTo-Json -Compress
        $err = Get-SbwScheduleError -Msg ($json | ConvertFrom-Json) -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)
        Assert-Equal $err 'bad-request' $bad
      }
    }
    It 'refuses a profile that is not the configured known profile' {
      $m = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Profile 9"}'
      Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'unknown-profile'
    }
    It 'refuses a browser that is not configured' {
      $cfg = New-SbwTestConfig
      $cfg.chrome = [pscustomobject]@{ exePath = ''; profile = 'Default' }
      $m = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config $cfg) 'browser-not-configured'
      $cfg2 = New-SbwTestConfig
      $cfg2.PSObject.Properties.Remove('firefox')
      $m2 = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"firefox","profile":"default-release"}'
      Assert-Equal (Get-SbwScheduleError -Msg $m2 -Now (Get-SbwTestNow) -Config $cfg2) 'browser-not-configured'
    }
    It 'rejects unknown fields and missing fields (strict shape)' {
      $extra = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default","x":1}'
      Assert-Equal (Get-SbwScheduleError -Msg $extra -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
      $missing = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome"}'
      Assert-Equal (Get-SbwScheduleError -Msg $missing -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
    }
    It 'rejects wrong field types' {
      $m = ConvertFrom-SbwTestJson '{"op":"schedule","snipeId":7,"wakeAtUtc":"2026-10-10T13:00:00.000Z","browser":"chrome","profile":"Default"}'
      Assert-Equal (Get-SbwScheduleError -Msg $m -Now (Get-SbwTestNow) -Config (New-SbwTestConfig)) 'bad-request'
    }
  }

  Context 'cancel and list validation' {
    It 'accepts a valid cancel' {
      Assert-Null (Get-SbwCancelError -Msg (ConvertFrom-SbwTestJson '{"op":"cancel","snipeId":"abc-123"}'))
    }
    It 'rejects cancel with bad snipeId or extra fields' {
      Assert-Equal (Get-SbwCancelError -Msg (ConvertFrom-SbwTestJson '{"op":"cancel","snipeId":"../evil"}')) 'bad-request'
      Assert-Equal (Get-SbwCancelError -Msg (ConvertFrom-SbwTestJson '{"op":"cancel","snipeId":"a","wakeAtUtc":"2026-10-10T13:00:00.000Z"}')) 'bad-request'
      Assert-Equal (Get-SbwCancelError -Msg (ConvertFrom-SbwTestJson '{"op":"cancel"}')) 'bad-request'
    }
    It 'accepts a valid list and rejects everything else' {
      Assert-Null (Get-SbwListError -Msg (ConvertFrom-SbwTestJson '{"op":"list"}'))
      Assert-Equal (Get-SbwListError -Msg (ConvertFrom-SbwTestJson '{"op":"list","snipeId":"a"}')) 'bad-request'
      Assert-Equal (Get-SbwListError -Msg (ConvertFrom-SbwTestJson '{"op":"wat"}')) 'bad-request'
    }
  }

  Context 'profile value checks shared with install.ps1' {
    It 'accepts plain names and paths, rejects forbidden characters' {
      Assert-True (Test-SbwProfileValue 'Default')
      Assert-True (Test-SbwProfileValue 'C:\Users\me\Chrome User Data')
      Assert-False (Test-SbwProfileValue '')
      Assert-False (Test-SbwProfileValue ('x' * 261))
      Assert-True (Test-SbwProfileValue 'foo..bar')
      foreach ($bad in @('a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b', "a`nb", 'pre`post', '$(calc)', 'a$(Get-Date)b', '..\..\Windows\System32', 'foo/../bar', 'foo\..\bar', '..', ']]>', '-headless', '--user-data-dir=C:\x')) {
        Assert-False (Test-SbwProfileValue $bad) $bad
      }
      # A dash is fine anywhere but first (Firefox would read "-P -x" as two flags).
      Assert-True (Test-SbwProfileValue 'default-release')
      Assert-True (Test-SbwProfileValue 'C:\Users\me\x-profile')
    }
  }
}

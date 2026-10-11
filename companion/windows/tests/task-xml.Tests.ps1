# Pester tests for the wake-task XML generation and the schtasks / browser-launch
# argument arrays. Everything is built in-memory (Task Scheduler COM XmlText);
# nothing is registered on this machine (controller ruling R1).
# All setup lives in BeforeAll: Pester 5 runs top-level and Describe-body code
# during Discovery only (see Get-SbwPesterShapeViolations in test-helpers.ps1).
Describe 'companion task XML' {
  BeforeAll {
    . "$PSScriptRoot\test-helpers.ps1"
    . "$PSScriptRoot\..\host\task-xml.ps1"

    # Fixtures are functions defined here, in BeforeAll, so every It sees them.
    function Get-SbwTestWakeUtc {
      [datetimeoffset]::Parse('2026-10-20T06:15:00.000Z')
    }
    function Get-SbwTestLaunch {
      Get-SbwLaunchCommand -ExePath 'C:\Program Files\Chrome\chrome.exe' -BrowserArgs @('--profile-directory=Default')
    }
    function Get-SbwTestXmlText {
      $launch = Get-SbwTestLaunch
      New-SbwTaskXml -TaskName 'ShopBadwill-test' -WakeAtUtc (Get-SbwTestWakeUtc) `
        -Execute $launch.Execute -Arguments $launch.Arguments -UserId 'MYDOM\me'
    }
    function Get-SbwTestXml {
      [xml](Get-SbwTestXmlText)
    }

    function Remove-SbwPsComments {
      param([string]$Text)
      $sb = New-Object System.Text.StringBuilder
      $i = 0
      $n = $Text.Length
      $inBlock = $false
      $inSingle = $false
      $inDouble = $false
      while ($i -lt $n) {
        $c = $Text[$i]
        $next = if ($i + 1 -lt $n) { $Text[$i + 1] } else { [char]0 }
        if ($inBlock) {
          if ($c -eq '#' -and $next -eq '>') { $inBlock = $false; $i += 2; continue }
          $i++; continue
        }
        if ($inSingle) {
          [void]$sb.Append($c)
          if ($c -eq "'" -and $next -eq "'") { [void]$sb.Append($next); $i += 2; continue }
          if ($c -eq "'") { $inSingle = $false }
          $i++; continue
        }
        if ($inDouble) {
          [void]$sb.Append($c)
          if ($c -eq '`') {
            if ($i + 1 -lt $n) { [void]$sb.Append($Text[$i + 1]); $i += 2; continue }
          }
          if ($c -eq '"' -and $next -eq '"') { [void]$sb.Append($next); $i += 2; continue }
          if ($c -eq '"') { $inDouble = $false }
          $i++; continue
        }
        if ($c -eq '<' -and $next -eq '#') { $inBlock = $true; $i += 2; continue }
        if ($c -eq '#') {
          while ($i -lt $n -and $Text[$i] -ne "`n") { $i++ }
          continue
        }
        if ($c -eq "'") { $inSingle = $true; [void]$sb.Append($c); $i++; continue }
        if ($c -eq '"') { $inDouble = $true; [void]$sb.Append($c); $i++; continue }
        [void]$sb.Append($c)
        $i++
      }
      $sb.ToString()
    }
  }

  Context 'Get-SbwTaskName' {
    It 'builds names that are always ShopBadwill-<snipeId>' {
      Assert-Equal (Get-SbwTaskName -SnipeId 'abc-123') 'ShopBadwill-abc-123'
      Assert-Equal (Get-SbwTaskName -SnipeId 'x_y-Z9') 'ShopBadwill-x_y-Z9'
      Assert-Match (Get-SbwTaskName -SnipeId 'abc-123') '^ShopBadwill-[A-Za-z0-9_-]{1,64}$'
      Assert-Equal (Get-SbwTaskName -SnipeId ('a' * 64)) ('ShopBadwill-' + ('a' * 64))
    }
  }

  Context 'Get-SbwBrowserArgs' {
    It 'chrome: a profile NAME becomes --profile-directory' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'chrome' -Profile 'Default') @('--profile-directory=Default')
    }
    It 'chrome: a profile PATH becomes --user-data-dir' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'chrome' -Profile 'C:\Users\me\Chrome User Data') @('--user-data-dir=C:\Users\me\Chrome User Data')
    }
    It 'chrome: forward slashes count as a path' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'chrome' -Profile 'C:/Users/me/Chrome User Data') @('--user-data-dir=C:/Users/me/Chrome User Data')
    }
    It 'chrome: a drive-relative value counts as a path' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'chrome' -Profile 'C:x') @('--user-data-dir=C:x')
    }
    It 'firefox: a profile NAME becomes -P' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'firefox' -Profile 'default-release') @('-P', 'default-release')
    }
    It 'firefox: a profile PATH becomes -profile' {
      Assert-ArrayEqual (Get-SbwBrowserArgs -Browser 'firefox' -Profile 'C:\Users\me\Profiles\x.default') @('-profile', 'C:\Users\me\Profiles\x.default')
    }
  }

  Context 'Get-SbwLaunchCommand' {
    It 'launches the configured browser itself, never a shell' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Program Files\Chrome\chrome.exe' -BrowserArgs @('--profile-directory=Default')
      Assert-Equal $cmd.Execute 'C:\Program Files\Chrome\chrome.exe'
      Assert-Equal $cmd.Arguments '--profile-directory=Default'
      Assert-NotMatch $cmd.Execute 'cmd\.exe'
      Assert-NotMatch $cmd.Arguments '(?<![A-Za-z0-9])/c(?![A-Za-z0-9])'
    }
    It 'quotes an argument that contains whitespace so it stays one argv element' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Chrome\chrome.exe' -BrowserArgs @('--profile-directory=Profile 1')
      Assert-Equal $cmd.Execute 'C:\Chrome\chrome.exe'
      Assert-Equal $cmd.Arguments '"--profile-directory=Profile 1"'
    }
    It 'keeps firefox -P and the profile name as two argv elements' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Program Files\Mozilla Firefox\firefox.exe' -BrowserArgs @('-P', 'My Profile')
      Assert-Equal $cmd.Execute 'C:\Program Files\Mozilla Firefox\firefox.exe'
      Assert-Equal $cmd.Arguments '-P "My Profile"'
    }
    It 'doubles trailing backslashes inside a quoted argument' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Chrome\chrome.exe' -BrowserArgs @('--user-data-dir=C:\Program Files\data\')
      Assert-Equal $cmd.Arguments '"--user-data-dir=C:\Program Files\data\\"'
    }
    It 'escapes an embedded quote and the backslashes in front of it' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Chrome\chrome.exe' -BrowserArgs @('a\"b')
      Assert-Equal $cmd.Arguments '"a\\\"b"'
    }
    It 'quotes an empty argument' {
      $cmd = Get-SbwLaunchCommand -ExePath 'C:\Chrome\chrome.exe' -BrowserArgs @('')
      Assert-Equal $cmd.Arguments '""'
    }
  }

  Context 'New-SbwTaskXml' {

    It 'generates parseable Task 1.2 XML' {
      $xmlText = Get-SbwTestXmlText
      Assert-NotNull $xmlText
      Assert-Match $xmlText '<Task version="1.2"'
    }
    It 'sets WakeToRun (the wake timer)' {
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.WakeToRun) 'true'
    }
    It 'sets StartWhenAvailable so a late-woken PC still launches the browser' {
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.StartWhenAvailable) 'true'
    }
    It 'allows starting and continuing on battery (DC wake timers are a user setting)' {
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.DisallowStartIfOnBatteries) 'false'
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.StopIfGoingOnBatteries) 'false'
    }
    It 'does not kill the browser and lets the OS delete the expired task' {
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.ExecutionTimeLimit) 'PT0S'
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.DeleteExpiredTaskAfter) 'PT10M'
      Assert-Equal ([string](Get-SbwTestXml).Task.Settings.MultipleInstancesPolicy) 'IgnoreNew'
    }
    It 'uses the exact start boundary in LOCAL wall-clock time' {
      $wakeUtc = Get-SbwTestWakeUtc
      $expected = $wakeUtc.ToLocalTime().ToString('yyyy-MM-dd\THH:mm:ss')
      Assert-Equal ([string](Get-SbwTestXml).Task.Triggers.TimeTrigger.StartBoundary) $expected
      Assert-Equal ([string](Get-SbwTestXml).Task.Triggers.TimeTrigger.EndBoundary) $wakeUtc.ToLocalTime().AddHours(1).ToString('yyyy-MM-dd\THH:mm:ss')
      Assert-Equal ([string](Get-SbwTestXml).Task.Triggers.TimeTrigger.Enabled) 'true'
    }
    It 'runs the configured browser as the Exec action' {
      $xml = Get-SbwTestXml
      Assert-Equal ([string]$xml.Task.Actions.Exec.Command) 'C:\Program Files\Chrome\chrome.exe'
      Assert-Equal ([string]$xml.Task.Actions.Exec.Arguments) '--profile-directory=Default'
      $text = Get-SbwTestXmlText
      Assert-NotMatch $text 'cmd\.exe'
      Assert-NotMatch $text '(?<![A-Za-z0-9])/c(?![A-Za-z0-9])'
      Assert-NotMatch $text 'Invoke-Expression'
      Assert-NotMatch $text 'HighestAvailable'
      Assert-NotMatch $text '<Password>'
    }
    It 'runs as the interactive, least-privileged current user' {
      Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.LogonType) 'InteractiveToken'
      Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.RunLevel) 'LeastPrivilege'
      Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.UserId) 'MYDOM\me'
    }
  }

  Context 'production scripts do not shell out' {
    It 'host, install, and uninstall contain no Invoke-Expression, iex, cmd /c, or ComSpec' {
      $files = @(Get-ChildItem -LiteralPath (Get-SbwTestPath '..\host') -Filter '*.ps1' -File)
      $files += Get-Item -LiteralPath (Get-SbwTestPath '..\install.ps1')
      $files += Get-Item -LiteralPath (Get-SbwTestPath '..\uninstall.ps1')
      foreach ($f in $files) {
        $code = Remove-SbwPsComments -Text ([IO.File]::ReadAllText($f.FullName))
        Assert-NotMatch $code 'Invoke-Expression' $f.Name
        Assert-NotMatch $code '(?i)(?<![A-Za-z0-9_])iex(?![A-Za-z0-9_])' $f.Name
        Assert-NotMatch $code '(?<![A-Za-z0-9])/c(?![A-Za-z0-9])' $f.Name
        Assert-NotMatch $code 'ComSpec' $f.Name
      }
    }
  }

  Context 'schtasks argument arrays' {
    It 'schedule: /Create /TN <prefixed name> /XML <file> /F' {
      Assert-ArrayEqual (Get-SbwScheduleArgs -TaskName 'ShopBadwill-x' -XmlPath 'C:\d\x.xml') @('/Create', '/TN', 'ShopBadwill-x', '/XML', 'C:\d\x.xml', '/F')
    }
    It 'cancel: /Delete /TN <prefixed name> /F' {
      Assert-ArrayEqual (Get-SbwCancelArgs -TaskName 'ShopBadwill-x') @('/Delete', '/TN', 'ShopBadwill-x', '/F')
    }
    It 'query: /Query /TN <prefixed name> /FO CSV /NH' {
      Assert-ArrayEqual (Get-SbwQueryArgs -TaskName 'ShopBadwill-x') @('/Query', '/TN', 'ShopBadwill-x', '/FO', 'CSV', '/NH')
    }
  }
}

# Pester tests for the wake-task XML generation and the schtasks / browser-launch
# argument arrays. Everything is built in-memory (Task Scheduler COM XmlText);
# nothing is registered on this machine (controller ruling R1).
. "$PSScriptRoot\test-helpers.ps1"
. "$PSScriptRoot\..\host\task-xml.ps1"

Describe 'Get-SbwTaskName' {
  It 'builds names that are always prefixed ShopBadwill-' {
    Assert-Equal (Get-SbwTaskName -SnipeId 'abc-123') 'ShopBadwill-snipe-abc-123'
    Assert-Equal (Get-SbwTaskName -SnipeId 'x_y.Z9') 'ShopBadwill-snipe-x_y.Z9'
    Assert-True ((Get-SbwTaskName -SnipeId 'x').StartsWith('ShopBadwill-'))
  }
}

Describe 'Get-SbwBrowserArgs' {
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

Describe 'Get-SbwLaunchCommand' {
  It 'wraps the browser in cmd /c start and quotes every element' {
    $cmd = Get-SbwLaunchCommand -ExePath 'C:\Program Files\Chrome\chrome.exe' -BrowserArgs @('--profile-directory=Default')
    Assert-True ($cmd.Execute -like '*cmd.exe')
    Assert-Equal $cmd.Arguments '/c start "" "C:\Program Files\Chrome\chrome.exe" "--profile-directory=Default"'
  }
  It 'quotes a whole argument with a space so it stays one argv element' {
    $cmd = Get-SbwLaunchCommand -ExePath 'C:\Chrome\chrome.exe' -BrowserArgs @('--profile-directory=Profile 1')
    Assert-Equal $cmd.Arguments '/c start "" "C:\Chrome\chrome.exe" "--profile-directory=Profile 1"'
  }
  It 'firefox name profile: two separate quoted elements' {
    $cmd = Get-SbwLaunchCommand -ExePath 'C:\Program Files\Mozilla Firefox\firefox.exe' -BrowserArgs @('-P', 'My Profile')
    Assert-Equal $cmd.Arguments '/c start "" "C:\Program Files\Mozilla Firefox\firefox.exe" "-P" "My Profile"'
  }
}

Describe 'New-SbwTaskXml' {
  # Fixtures live in functions: variables assigned in a Describe body are not
  # reliably visible to It blocks under Pester 5 (discovery vs run).
  function Get-SbwTestXmlText {
    $wakeUtc = [datetimeoffset]::Parse('2026-10-20T06:15:00.000Z')
    New-SbwTaskXml -TaskName 'ShopBadwill-snipe-test' -WakeAtUtc $wakeUtc `
      -Execute 'C:\Windows\System32\cmd.exe' -Arguments '/c start "" "C:\Chrome\chrome.exe" "--profile-directory=Default"' `
      -UserId 'MYDOM\me'
  }
  function Get-SbwTestXml {
    [xml](Get-SbwTestXmlText)
  }
  function Get-SbwTestWakeUtc {
    [datetimeoffset]::Parse('2026-10-20T06:15:00.000Z')
  }

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
  It 'caps the action runtime and lets the OS delete the expired task' {
    Assert-Equal ([string](Get-SbwTestXml).Task.Settings.ExecutionTimeLimit) 'PT30M'
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
  It 'runs the launch command as the Exec action' {
    Assert-Equal ([string](Get-SbwTestXml).Task.Actions.Exec.Command) 'C:\Windows\System32\cmd.exe'
    Assert-Equal ([string](Get-SbwTestXml).Task.Actions.Exec.Arguments) '/c start "" "C:\Chrome\chrome.exe" "--profile-directory=Default"'
  }
  It 'runs as the interactive, least-privileged current user' {
    Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.LogonType) 'InteractiveToken'
    Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.RunLevel) 'LeastPrivilege'
    Assert-Equal ([string](Get-SbwTestXml).Task.Principals.Principal.UserId) 'MYDOM\me'
  }
}

Describe 'schtasks argument arrays' {
  It 'schedule: /Create /TN <prefixed name> /XML <file> /F' {
    Assert-ArrayEqual (Get-SbwScheduleArgs -TaskName 'ShopBadwill-snipe-x' -XmlPath 'C:\d\x.xml') @('/Create', '/TN', 'ShopBadwill-snipe-x', '/XML', 'C:\d\x.xml', '/F')
  }
  It 'cancel: /Delete /TN <prefixed name> /F' {
    Assert-ArrayEqual (Get-SbwCancelArgs -TaskName 'ShopBadwill-snipe-x') @('/Delete', '/TN', 'ShopBadwill-snipe-x', '/F')
  }
  It 'query: /Query /TN <prefixed name> /FO CSV /NH' {
    Assert-ArrayEqual (Get-SbwQueryArgs -TaskName 'ShopBadwill-snipe-x') @('/Query', '/TN', 'ShopBadwill-snipe-x', '/FO', 'CSV', '/NH')
  }
}

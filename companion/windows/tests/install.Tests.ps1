# Pester tests for the pure parts of install.ps1 / uninstall.ps1: native-messaging
# host manifests (R3: only our extension IDs, never a wildcard), `reg` argument
# arrays, the .cmd launcher content, extension-id validation, and the uninstall
# task-name allowlist. Nothing touches the registry on this machine (R1).
# All setup lives in BeforeAll: Pester 5 runs top-level and Describe-body code
# during Discovery only (see Get-SbwPesterShapeViolations in test-helpers.ps1).
Describe 'companion install and uninstall' {
  BeforeAll {
    . "$PSScriptRoot\test-helpers.ps1"
    . "$PSScriptRoot\..\install.ps1"
    . "$PSScriptRoot\..\uninstall.ps1"

    # Replace the real schtasks/reg wrappers for this file. A test that called the
    # real commands would be a defect (controller ruling R1).
    $script:sbwSchtasksCalls = @()
    $script:sbwRegCalls = @()
    $script:sbwQueryCsv = ''
    function Invoke-SbwSchtasks {
      param([string]$SchTasksPath, [string[]]$ArgList)
      if ($SchTasksPath -notlike 'C:\sbw-no-such\*') { throw "refusing unexpected schtasks path: $SchTasksPath" }
      $script:sbwSchtasksCalls += ,(@($ArgList))
      if ($ArgList -ccontains '/Query') { return @{ ExitCode = 0; Output = [string]$script:sbwQueryCsv } }
      $tn = $null
      for ($i = 0; $i -lt $ArgList.Count; $i++) {
        if ($ArgList[$i] -ceq '/TN') { $tn = [string]$ArgList[$i + 1] }
      }
      if ($tn -cnotmatch '^ShopBadwill-[A-Za-z0-9_-]{1,64}$') { throw "refusing to delete non-owned task: $tn" }
      @{ ExitCode = 0; Output = '' }
    }
    function Invoke-SbwReg {
      param([string[]]$ArgList)
      $script:sbwRegCalls += ,(@($ArgList))
      foreach ($a in @($ArgList)) {
        if ([string]$a -like 'HKLM*') { throw "refusing HKLM write: $a" }
      }
      0
    }
    function Get-SbwSchTasksPath { 'C:\sbw-no-such\schtasks.exe' }

    # Source reads go through test-helpers.ps1, whose functions resolve paths
    # against the tests folder (no $PSScriptRoot inside It blocks).
    function Get-SbwInstallSource {
      Get-SbwTestText '..\install.ps1'
    }

    function Get-SbwUninstallSource {
      Get-SbwTestText '..\uninstall.ps1'
    }
    function Get-SbwCompanionDoc {
      Get-SbwTestText '..\..\..\docs\COMPANION.md'
    }
  }

  Context 'host manifests (R3)' {
    It 'Chrome manifest allows ONLY the parameterized extension id origin' {
      $m = Get-SbwChromeManifest -ExtensionId 'abcdefghijklmnopabcdefghijklmnop' -LauncherPath 'C:\d\shopbadwill-host.cmd'
      Assert-Equal $m.name 'com.shopbadwill.companion'
      Assert-Equal $m.type 'stdio'
      Assert-Equal $m.path 'C:\d\shopbadwill-host.cmd'
      Assert-Equal $m.allowed_origins.Count 1
      Assert-Equal $m.allowed_origins[0] 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
      Assert-True ($m.PSObject.Properties.Name -cnotcontains 'allowed_extensions')
    }
    It 'Firefox manifest allows ONLY the gecko id' {
      $m = Get-SbwFirefoxManifest -ExtensionId 'shopbadwill@trashdad.github.io' -LauncherPath 'C:\d\shopbadwill-host.cmd'
      Assert-Equal $m.allowed_extensions.Count 1
      Assert-Equal $m.allowed_extensions[0] 'shopbadwill@trashdad.github.io'
      Assert-True ($m.PSObject.Properties.Name -cnotcontains 'allowed_origins')
    }
    It 'install.ps1 defaults -FirefoxExtensionId to the wxt.config.ts gecko id and -ChromeExtensionId to nothing' {
      $src = Get-SbwInstallSource
      Assert-Match $src "FirefoxExtensionId = 'shopbadwill@trashdad.github.io'"
      Assert-Match $src "ChromeExtensionId = ''"
    }
  }

  Context 'extension id validation' {
    It 'Chrome: exactly 32 chars a-p, lowercase' {
      Assert-True (Test-SbwChromeExtensionId ('a' * 32))
      Assert-True (Test-SbwChromeExtensionId 'abcdefghijklmnopabcdefghijklmnop')
      Assert-False (Test-SbwChromeExtensionId '')
      Assert-False (Test-SbwChromeExtensionId ('a' * 31))
      Assert-False (Test-SbwChromeExtensionId ('a' * 33))
      Assert-False (Test-SbwChromeExtensionId ('A' + ('a' * 31)))
      Assert-False (Test-SbwChromeExtensionId ('q' + ('a' * 31)))
      Assert-False (Test-SbwChromeExtensionId ('*' * 32))
    }
    It 'Firefox gecko id: no whitespace, shell metacharacters, or wildcards' {
      Assert-True (Test-SbwFirefoxExtensionId 'shopbadwill@trashdad.github.io')
      Assert-False (Test-SbwFirefoxExtensionId '')
      Assert-False (Test-SbwFirefoxExtensionId 'has space@x.org')
      foreach ($bad in @('a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b', 'a"b', '*', '?', 'shop*will@trashdad.github.io', 'shop?will@trashdad.github.io')) {
        Assert-False (Test-SbwFirefoxExtensionId $bad)
      }
    }
    It 'manifest builders reject a wildcard or any other id that fails validation' {
      foreach ($bad in @('*', '?', 'chrome-extension://*/')) {
        $chromeThrew = $false
        try { Get-SbwChromeManifest -ExtensionId $bad -LauncherPath 'C:\d\shopbadwill-host.cmd' | Out-Null } catch { $chromeThrew = $true }
        Assert-True $chromeThrew $bad
        $firefoxThrew = $false
        try { Get-SbwFirefoxManifest -ExtensionId $bad -LauncherPath 'C:\d\shopbadwill-host.cmd' | Out-Null } catch { $firefoxThrew = $true }
        Assert-True $firefoxThrew $bad
      }
    }
  }

  Context 'reg argument arrays' {
    It 'reg add creates the host subkey and sets its default value to the manifest' {
      # Chrome and Firefox look up HKCU\...\NativeMessagingHosts\<host> (Default) = manifest path.
      # A named value on the parent key is invisible to the browser.
      Assert-ArrayEqual (Get-SbwRegAddArgs -Key 'HKCU\Software\Google\Chrome\NativeMessagingHosts' -ValueName 'com.shopbadwill.companion' -ManifestPath 'C:\d\chrome-manifest.json') `
        @('add', 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.shopbadwill.companion', '/ve', '/t', 'REG_SZ', '/d', 'C:\d\chrome-manifest.json', '/f')
    }
    It 'reg delete removes only that host subkey, not the parent key other hosts share' {
      Assert-ArrayEqual (Get-SbwRegDeleteArgs -Key 'HKCU\Software\Mozilla\NativeMessagingHosts' -ValueName 'com.shopbadwill.companion') `
        @('delete', 'HKCU\Software\Mozilla\NativeMessagingHosts\com.shopbadwill.companion', '/f')
    }
    It 'refuses a non-HKCU parent and a host name that could escape the key' {
      foreach ($badKey in @(
          'HKLM\Software\Google\Chrome\NativeMessagingHosts',
          'HKCR\Software\X',
          'HKU\S-1-5\Software\X',
          'Software\Google\Chrome\NativeMessagingHosts',
          'HKCU\Software\..\HKLM\Software'
        )) {
        $addThrew = $false
        try { Get-SbwRegAddArgs -Key $badKey -ValueName 'com.shopbadwill.companion' -ManifestPath 'C:\d\m.json' | Out-Null } catch { $addThrew = $true }
        Assert-True $addThrew $badKey
        $delThrew = $false
        try { Get-SbwRegDeleteArgs -Key $badKey -ValueName 'com.shopbadwill.companion' | Out-Null } catch { $delThrew = $true }
        Assert-True $delThrew $badKey
      }
      foreach ($badName in @('..\Run', 'com.shopbadwill.companion\extra', 'a/b', '', '..')) {
        $threw = $false
        try { Get-SbwRegDeleteArgs -Key 'HKCU\Software\Mozilla\NativeMessagingHosts' -ValueName $badName | Out-Null } catch { $threw = $true }
        Assert-True $threw $badName
      }
    }
  }

  Context 'registry writes go through one splatted HKCU call' {
    It 'install registers via Invoke-SbwReg and does not pass reg.exe a single array object' {
      $install = Get-SbwInstallSource
      Assert-Match $install 'Invoke-SbwReg -ArgList \(Get-SbwRegAddArgs '
      Assert-Match $install '& reg\.exe @ArgList'
      Assert-NotMatch $install '& reg\.exe @\('
      Assert-Match $install 'reg query HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.shopbadwill\.companion'
      Assert-NotMatch $install 'NativeMessagingHosts /v com\.shopbadwill\.companion'
    }
    It 'uninstall deletes through that same function and never calls reg.exe itself' {
      $un = Get-SbwUninstallSource
      Assert-Match $un 'Invoke-SbwReg -ArgList \(Get-SbwRegDeleteArgs '
      Assert-NotMatch $un '& reg\.exe'
    }
    It 'the user-facing verify command queries the host subkey' {
      $doc = Get-SbwCompanionDoc
      Assert-Match $doc 'reg query HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.shopbadwill\.companion'
      Assert-Match $doc 'reg query HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com\.shopbadwill\.companion'
      Assert-NotMatch $doc 'NativeMessagingHosts /v com\.shopbadwill\.companion'
    }
  }

  Context 'launcher .cmd content' {
    It 'runs the private host copy next to it through the system PowerShell' {
      $content = Get-SbwLauncherContent
      Assert-Match $content '@echo off'
      Assert-Match $content ([regex]::Escape('"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File'))
      Assert-Match $content ([regex]::Escape('-File "%~dp0host\shopbadwill-host.ps1" -ConfigPath "%~dp0config.json"'))
    }
    It 'is pure ASCII, so cmd.exe reads it the same in any code page' {
      # cmd.exe decodes a batch file in the OEM code page; a UTF-8 profile path
      # such as C:\Users\Jos<e-acute> would be garbled. %~dp0 expands at run time.
      Assert-True ((Get-SbwLauncherContent) -cmatch '^[\x00-\x7F]*$')
    }
    It 'keeps the content on two lines only (nothing else writes to stdout)' {
      $content = Get-SbwLauncherContent
      $lines = @($content -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
      Assert-Equal $lines.Count 2
    }
  }

  Context 'install runs a private host copy, uninstall removes it all' {
    It 'copies the host scripts under the data dir and never points at the checkout' {
      $tmp = New-TestTempDir
      try {
        $fakeChrome = Join-Path $tmp 'chrome.exe'
        [IO.File]::WriteAllText($fakeChrome, '')
        $data = Join-Path $tmp 'ShopBadwill\companion'
        $script:sbwRegCalls = @()
        $ChromeExtensionId = 'abcdefghijklmnopabcdefghijklmnop'
        $ChromeProfile = 'Default'
        $FirefoxProfile = ''
        $ChromeExe = $fakeChrome
        $FirefoxExe = ''
        $SourceDir = ''
        $DataDir = $data
        Invoke-SbwInstall 6>$null | Out-Null

        foreach ($n in @(Get-SbwHostFileNames)) {
          $copy = Join-Path $data "host\$n"
          Assert-True (Test-Path -LiteralPath $copy) "missing private copy of $n"
          Assert-Equal ([IO.File]::ReadAllText($copy)) (Get-SbwTestText "..\host\$n") $n
        }
        Assert-ArrayEqual @(Get-SbwHostFileNames) @('shopbadwill-host.ps1', 'protocol.ps1', 'task-xml.ps1', 'io.ps1')
        $launcher = [IO.File]::ReadAllText((Join-Path $data 'shopbadwill-host.cmd'))
        Assert-Equal $launcher (Get-SbwLauncherContent)
        $checkout = [IO.Path]::GetFullPath((Get-SbwTestPath '..'))
        Assert-False ($launcher.IndexOf($checkout, [StringComparison]::OrdinalIgnoreCase) -ge 0) 'launcher names the checkout'
        $manifest = [IO.File]::ReadAllText((Join-Path $data 'chrome-manifest.json')) | ConvertFrom-Json
        Assert-Equal $manifest.path (Join-Path $data 'shopbadwill-host.cmd')
        Assert-Equal $script:sbwRegCalls.Count 1
      } finally {
        Remove-TestTempDir $tmp
      }
    }
    It 'uninstall after install leaves no file, folder, task, or host key behind' {
      $tmp = New-TestTempDir
      try {
        $fakeChrome = Join-Path $tmp 'chrome.exe'
        [IO.File]::WriteAllText($fakeChrome, '')
        $data = Join-Path $tmp 'ShopBadwill\companion'
        $ChromeExtensionId = 'abcdefghijklmnopabcdefghijklmnop'
        $ChromeProfile = 'Default'
        $FirefoxProfile = 'default-release'
        $ChromeExe = $fakeChrome
        $FirefoxExe = $fakeChrome
        $SourceDir = ''
        $DataDir = $data
        $script:sbwRegCalls = @()
        Invoke-SbwInstall 6>$null | Out-Null
        Assert-Equal $script:sbwRegCalls.Count 2
        # A schedule the host would have made.
        Set-Content -LiteralPath (Join-Path $data 'ShopBadwill-s1.xml') -Value '<Task/>' -Encoding ASCII
        @{ version = 1; tasks = @(@{ snipeId = 's1'; taskName = 'ShopBadwill-s1' }) } |
          ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $data 'state.json') -Encoding ASCII

        $script:SbwUninstallDataDir = $data
        $script:sbwSchtasksCalls = @()
        $script:sbwQueryCsv = ''
        $script:sbwRegCalls = @()
        Invoke-SbwUninstall 6>$null | Out-Null

        Assert-False (Test-Path -LiteralPath $data) 'data dir left behind'
        Assert-False (Test-Path -LiteralPath (Join-Path $tmp 'ShopBadwill')) 'empty ShopBadwill parent left behind'
        Assert-ArrayEqual @(Get-ChildItem -LiteralPath $tmp -Force | ForEach-Object { $_.Name }) @('chrome.exe')
        Assert-Equal $script:sbwRegCalls.Count 2
        $deleted = @($script:sbwSchtasksCalls | ForEach-Object { $a = @($_); if ($a -ccontains '/Delete') { $a[2] } })
        Assert-ArrayEqual $deleted @('ShopBadwill-s1')
      } finally {
        Remove-TestTempDir $tmp
      }
    }
    It 'uninstall keeps a ShopBadwill parent folder that still holds something else' {
      $tmp = New-TestTempDir
      try {
        $parent = Join-Path $tmp 'ShopBadwill'
        $data = Join-Path $parent 'companion'
        New-Item -ItemType Directory -Path $data -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $parent 'other.txt') -Value 'keep' -Encoding ASCII
        $script:SbwUninstallDataDir = $data
        $script:sbwSchtasksCalls = @()
        $script:sbwQueryCsv = ''
        Invoke-SbwUninstall 6>$null | Out-Null
        Assert-False (Test-Path -LiteralPath $data)
        Assert-True (Test-Path -LiteralPath (Join-Path $parent 'other.txt'))
      } finally {
        Remove-TestTempDir $tmp
      }
    }
  }

  Context 'uninstall task-name allowlist' {
    It 'only returns ShopBadwill-<snipeId> names from the state file' {
      $tmp = New-TestTempDir
      $statePath = Join-Path $tmp 'state.json'
      @{ version = 1; tasks = @(
          @{ snipeId = 'a'; taskName = 'ShopBadwill-a' },
          @{ snipeId = 'b'; taskName = 'ShopBadwill-b_c-2' },
          @{ snipeId = 'x'; taskName = 'evil' },
          @{ snipeId = 'y'; taskName = 'ShopBadwill-' + ('e' * 65) },
          @{ snipeId = 'z'; taskName = 'ShopBadwill-..\x' },
          @{ snipeId = 'w'; taskName = 'NotOurs' },
          @{ snipeId = 'm'; taskName = '\Microsoft\Windows\Foo' }
        ) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
      $names = @(Get-SbwStateTaskNames -StatePath $statePath)
      Assert-Equal $names.Count 2
      Assert-Equal $names[0] 'ShopBadwill-a'
      Assert-Equal $names[1] 'ShopBadwill-b_c-2'
      Remove-TestTempDir $tmp
    }
    It 'unions state and schtasks query output, and drops every foreign name' {
      $csv = @(
        '"\Microsoft\Windows\UpdateOrchestrator\Schedule Scan","N/A","Ready"'
        '"\ShopBadwill-abc","N/A","Ready"'
        '"\ShopBadwill-evil & calc","N/A","Ready"'
        '"\Folder\ShopBadwill-abc","N/A","Ready"'
        '"ShopBadwill-plain","N/A","Ready"'
        '"\ShopBadwill-..\x","N/A","Ready"'
        '"\ShopBadwill-abc\child","N/A","Ready"'
      ) -join "`r`n"
      $names = @(Get-SbwTaskNamesToRemove -StateNames @('ShopBadwill-fromstate', 'evil', 'ShopBadwill-..\x', 'NotOurs') -QueryCsv $csv)
      Assert-Equal $names.Count 3
      Assert-True ($names -ccontains 'ShopBadwill-abc')
      Assert-True ($names -ccontains 'ShopBadwill-plain')
      Assert-True ($names -ccontains 'ShopBadwill-fromstate')
      foreach ($n in $names) { Assert-Match $n '^ShopBadwill-[A-Za-z0-9_-]{1,64}$' $n }
    }
    It 'returns nothing when there is no state file' {
      $tmp = New-TestTempDir
      Assert-Equal @(Get-SbwStateTaskNames -StatePath (Join-Path $tmp 'state.json')).Count 0
      Remove-TestTempDir $tmp
    }
  }

  Context 'uninstall -DataDir survives dot-sourcing install.ps1' {
    It 'saves the argument before install.ps1 rebinds DataDir' {
      $src = Get-SbwUninstallSource
      $capture = $src.IndexOf('SbwUninstallDataDir')
      $dot = $src.IndexOf(('$' + 'PSScriptRoot\install.ps1'))
      Assert-True ($capture -ge 0) 'missing capture of -DataDir'
      Assert-True ($dot -gt $capture) 'capture must precede the dot-source'
      Assert-Match $src 'Get-SbwDataDir -Explicit \$script:SbwUninstallDataDir'
    }
    It 'resolves the saved data dir rather than the clobbered parameter' {
      $script:SbwUninstallDataDir = 'C:\sbw-probe-not-real'
      Assert-Equal (Get-SbwUninstallDataDir) 'C:\sbw-probe-not-real'
    }
    It 'deletes only ShopBadwill- tasks and the files install added' {
      $tmp = New-TestTempDir
      $script:SbwUninstallDataDir = $tmp
      $script:sbwSchtasksCalls = @()
      $script:sbwRegCalls = @()
      $script:sbwQueryCsv = @(
        '"\Microsoft\Windows\UpdateOrchestrator\Schedule Scan","N/A","Ready"'
        '"\ShopBadwill-abc","N/A","Ready"'
        '"\Folder\ShopBadwill-abc","N/A","Ready"'
      ) -join "`r`n"
      foreach ($name in @('config.json', 'state.json', 'chrome-manifest.json', 'firefox-manifest.json', 'shopbadwill-host.cmd')) {
        Set-Content -LiteralPath (Join-Path $tmp $name) -Value '{}' -Encoding ASCII
      }
      Set-Content -LiteralPath (Join-Path $tmp 'ShopBadwill-abc.xml') -Value '<Task/>' -Encoding ASCII
      Set-Content -LiteralPath (Join-Path $tmp 'notes.txt') -Value 'keep' -Encoding ASCII
      Set-Content -LiteralPath (Join-Path $tmp 'not-ours.xml') -Value '<no/>' -Encoding ASCII
      @{ version = 1; tasks = @(@{ snipeId = 'fromstate'; taskName = 'ShopBadwill-fromstate' }) } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $tmp 'state.json') -Encoding ASCII

      Invoke-SbwUninstall

      $deleted = @()
      foreach ($call in @($script:sbwSchtasksCalls)) {
        $args = @($call)
        # The recorder stores one argument array per call; unwrap a single nested array.
        if ($args.Count -eq 1 -and $args[0] -is [System.Array]) { $args = @($args[0]) }
        if ($args -ccontains '/Delete') {
          for ($i = 0; $i -lt $args.Count; $i++) {
            if ($args[$i] -ceq '/TN') { $deleted += [string]$args[$i + 1] }
          }
        }
      }
      Assert-Equal $deleted.Count 2
      Assert-True ($deleted -ccontains 'ShopBadwill-abc')
      Assert-True ($deleted -ccontains 'ShopBadwill-fromstate')
      Assert-Equal $script:sbwRegCalls.Count 2
      foreach ($call in @($script:sbwRegCalls)) {
        $args = @($call)
        if ($args.Count -eq 1 -and $args[0] -is [System.Array]) { $args = @($args[0]) }
        $joined = $args -join ' '
        Assert-Match $joined 'HKCU\\'
        Assert-NotMatch $joined 'HKLM'
        Assert-Match $joined 'com\.shopbadwill\.companion'
        $key = @($args | Where-Object { $_ -like 'HK*\*' })
        Assert-Equal $key.Count 1
        Assert-Match ([string]$key[0]) '\\com\.shopbadwill\.companion$'
        Assert-False ($args -ccontains '/v')
      }
      Assert-False (Test-Path -LiteralPath (Join-Path $tmp 'config.json'))
      Assert-False (Test-Path -LiteralPath (Join-Path $tmp 'shopbadwill-host.cmd'))
      Assert-False (Test-Path -LiteralPath (Join-Path $tmp 'ShopBadwill-abc.xml'))
      Assert-True (Test-Path -LiteralPath (Join-Path $tmp 'notes.txt'))
      Assert-True (Test-Path -LiteralPath (Join-Path $tmp 'not-ours.xml'))
      Remove-TestTempDir $tmp
    }
  }

  Context 'safe path checks for install locations' {
    It 'refuses paths cmd.exe would mangle' {
      Assert-True (Test-SbwSafePathValue 'C:\Users\me\AppData\Local\ShopBadwill\companion')
      Assert-False (Test-SbwSafePathValue '')
      Assert-False (Test-SbwSafePathValue 'C:\a&b')
      Assert-False (Test-SbwSafePathValue 'C:\a%b')
      Assert-False (Test-SbwSafePathValue 'C:\a"b')
    }
    It 'checks the resolved browser executable before install writes anything' {
      $src = Get-SbwInstallSource
      Assert-Match $src 'Test-SbwSafePathValue -Value \$chromeExePath'
      Assert-Match $src 'Test-SbwSafePathValue -Value \$firefoxExePath'
    }
  }

  Context 'registry scope' {
    It 'native-messaging keys are HKCU and install/uninstall never name HKLM' {
      Assert-Equal (Get-SbwChromeRegKey) 'HKCU\Software\Google\Chrome\NativeMessagingHosts'
      Assert-Equal (Get-SbwFirefoxRegKey) 'HKCU\Software\Mozilla\NativeMessagingHosts'
      foreach ($rel in @('..\install.ps1', '..\uninstall.ps1')) {
        $src = Get-SbwTestText $rel
        Assert-NotMatch $src 'HKLM' $rel
      }
    }
  }

  Context 'COMPANION.md power guidance (R5)' {
    It 'matches the S-8 provisional verdicts and does not label the apply commands as a revert' {
      $doc = Get-SbwCompanionDoc
      Assert-Match $doc 'Sleep after \(AC\)'
      Assert-Match $doc '\*\*Never\*\*'
      Assert-Match $doc 'Allow wake timers \(AC\)'
      Assert-Match $doc '\*\*Enable\*\*'
      Assert-Match $doc 'Disabled on battery'
      Assert-Match $doc 'provisional'
      Assert-Match $doc 'Never paste'
      Assert-Match $doc 'companion\\windows\\install\.ps1'
      Assert-Match $doc 'companion\\windows\\uninstall\.ps1'
      Assert-NotMatch $doc 'Revert to the stock plan values'
      Assert-NotMatch (Get-SbwUninstallSource) 'powercfg'
    }
  }

  Context 'Pester runner' {
    It 'uses -Path on Pester 5 and -Script on earlier Pester' {
      $src = Get-SbwTestText 'run.ps1'
      Assert-Match $src '\$module\.Version\.Major -ge 5'
      Assert-Match $src 'Invoke-Pester -Path'
      Assert-Match $src 'Invoke-Pester -Script'
    }
    It 'keeps the script-root variable out of It blocks and helpers in test files' {
      $bad = @(Test-SbwTestsUseScriptRootOnlyToDotSource -TestsDir (Get-SbwTestPath '.'))
      Assert-Equal $bad.Count 0 ($bad -join ', ')
    }
    It 'keeps all setup inside BeforeAll so Pester 5 Run sees it (no top-level or Describe-body code)' {
      $bad = @(Get-SbwPesterShapeViolations -TestsDir (Get-SbwTestPath '.'))
      Assert-Equal $bad.Count 0 ($bad -join ', ')
    }
    It 'fails the gate on Pester 5 container/block failures and on an empty run' {
      $src = Get-SbwTestText 'run.ps1'
      Assert-Match $src "\`$result\.Result -ne 'Passed'"
      Assert-Match $src '\$result\.PassedCount -eq 0'
    }
  }
}

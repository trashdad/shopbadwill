# Pester tests for the pure parts of install.ps1 / uninstall.ps1: native-messaging
# host manifests (R3: only our extension IDs, never a wildcard), `reg` argument
# arrays, the .cmd launcher content, extension-id validation, and the uninstall
# task-name allowlist. Nothing touches the registry on this machine (R1).
. "$PSScriptRoot\test-helpers.ps1"
. "$PSScriptRoot\..\install.ps1"
. "$PSScriptRoot\..\uninstall.ps1"

# $PSScriptRoot is unreliable inside It blocks under Pester 3.4; a function
# resolves it against its defining file, which works under both 3.4 and 5.x.
function Get-SbwInstallSource {
  Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\install.ps1') -Raw
}

Describe 'host manifests (R3)' {
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

Describe 'extension id validation' {
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
  It 'Firefox gecko id: no whitespace or shell metacharacters' {
    Assert-True (Test-SbwFirefoxExtensionId 'shopbadwill@trashdad.github.io')
    Assert-False (Test-SbwFirefoxExtensionId '')
    Assert-False (Test-SbwFirefoxExtensionId 'has space@x.org')
    foreach ($bad in @('a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b', 'a"b')) {
      Assert-False (Test-SbwFirefoxExtensionId $bad)
    }
  }
}

Describe 'reg argument arrays' {
  It 'reg add: value name com.shopbadwill.companion under the per-user key' {
    Assert-ArrayEqual (Get-SbwRegAddArgs -Key 'HKCU\Software\Google\Chrome\NativeMessagingHosts' -ValueName 'com.shopbadwill.companion' -ManifestPath 'C:\d\chrome-manifest.json') `
      @('add', 'HKCU\Software\Google\Chrome\NativeMessagingHosts', '/v', 'com.shopbadwill.companion', '/t', 'REG_SZ', '/d', 'C:\d\chrome-manifest.json', '/f')
  }
  It 'reg delete removes only our value' {
    Assert-ArrayEqual (Get-SbwRegDeleteArgs -Key 'HKCU\Software\Mozilla\NativeMessagingHosts' -ValueName 'com.shopbadwill.companion') `
      @('delete', 'HKCU\Software\Mozilla\NativeMessagingHosts', '/v', 'com.shopbadwill.companion', '/f')
  }
}

Describe 'launcher .cmd content' {
  It 'invokes powershell.exe with the host script and config, quoted' {
    $content = Get-SbwLauncherContent -PowerShellExe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
      -HostScriptPath 'C:\tools\shopbadwill\companion\windows\host\shopbadwill-host.ps1' `
      -ConfigPath 'C:\Users\me\AppData\Local\ShopBadwill\companion\config.json'
    Assert-Match $content '@echo off'
    Assert-Match $content '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File'
    Assert-Match $content ([regex]::Escape('"C:\tools\shopbadwill\companion\windows\host\shopbadwill-host.ps1"'))
    Assert-Match $content ([regex]::Escape('-ConfigPath "C:\Users\me\AppData\Local\ShopBadwill\companion\config.json"'))
  }
  It 'keeps the content on two lines only (nothing else writes to stdout)' {
    $content = Get-SbwLauncherContent -PowerShellExe 'pwsh.exe' -HostScriptPath 'h.ps1' -ConfigPath 'c.json'
    $lines = @($content -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    Assert-Equal $lines.Count 2
  }
}

Describe 'uninstall task-name allowlist' {
  It 'only returns ShopBadwill-snipe-* names from the state file' {
    $tmp = New-TestTempDir
    $statePath = Join-Path $tmp 'state.json'
    @{ version = 1; tasks = @(
        @{ snipeId = 'a'; taskName = 'ShopBadwill-snipe-a' },
        @{ snipeId = 'b'; taskName = 'ShopBadwill-snipe-b_c-2' },
        @{ snipeId = 'x'; taskName = 'evil' },
        @{ snipeId = 'y'; taskName = 'ShopBadwill-snipe-' + ('e' * 65) },
        @{ snipeId = 'z'; taskName = 'ShopBadwill-snipe-..\x' },
        @{ snipeId = 'w'; taskName = 'NotOurs' }
      ) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
    $names = @(Get-SbwStateTaskNames -StatePath $statePath)
    Assert-Equal $names.Count 2
    Assert-Equal $names[0] 'ShopBadwill-snipe-a'
    Assert-Equal $names[1] 'ShopBadwill-snipe-b_c-2'
    Remove-TestTempDir $tmp
  }
  It 'returns nothing when there is no state file' {
    $tmp = New-TestTempDir
    Assert-Equal @(Get-SbwStateTaskNames -StatePath (Join-Path $tmp 'state.json')).Count 0
    Remove-TestTempDir $tmp
  }
}

Describe 'safe path checks for install locations' {
  It 'refuses paths cmd.exe would mangle' {
    Assert-True (Test-SbwSafePathValue 'C:\Users\me\AppData\Local\ShopBadwill\companion')
    Assert-False (Test-SbwSafePathValue '')
    Assert-False (Test-SbwSafePathValue 'C:\a&b')
    Assert-False (Test-SbwSafePathValue 'C:\a%b')
    Assert-False (Test-SbwSafePathValue 'C:\a"b')
  }
}

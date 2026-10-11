<#
.SYNOPSIS
  USER STEP: installs the ShopBadwill wake-and-launch companion for this
  Windows user. DO NOT run it yourself — see docs/COMPANION.md. It registers
  the native-messaging host for Chrome and/or Firefox under HKCU and writes the
  companion config; it never touches power settings and never creates
  scheduled tasks (the extension schedules those through the host).

.DESCRIPTION
  What it changes (all per-user, all reversible with uninstall.ps1):
    - %LOCALAPPDATA%\ShopBadwill\companion\   (config.json, host manifests,
      shopbadwill-host.cmd launcher, state, and host\ = a private copy of
      the host scripts; the browser runs that copy, never the checkout)
    - HKCU\Software\Google\Chrome\NativeMessagingHosts\com.shopbadwill.companion
    - HKCU\Software\Mozilla\NativeMessagingHosts\com.shopbadwill.companion
  The host manifests allow ONLY the extension ids given here (controller
  ruling R3): the Chrome id is a required parameter (never a wildcard); the
  Firefox id defaults to the wxt.config.ts gecko id.

.EXAMPLE
  # Chrome + Firefox, auto-detected browser paths, Default / default-release:
  .\install.ps1 -ChromeExtensionId abcdefghijklmnopabcdefghijklmnop -ChromeProfile Default -FirefoxProfile default-release

  # Chrome only, custom profile path:
  .\install.ps1 -ChromeExtensionId abcdefghijklmnopabcdefghijklmnop -ChromeProfile "$env:LOCALAPPDATA\Google\Chrome\User Data"

  # Dry run (changes nothing):
  .\install.ps1 -ChromeExtensionId ... -ChromeProfile Default -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Chrome extension id (chrome://extensions -> Developer mode -> ID). 32 chars a-p.
  [string]$ChromeExtensionId = '',
  # Firefox add-on id; the default is the wxt.config.ts gecko id.
  [string]$FirefoxExtensionId = 'shopbadwill@trashdad.github.io',
  # Browser executables; empty = auto-detect on this machine.
  [string]$ChromeExe = '',
  [string]$FirefoxExe = '',
  # Profile NAME (Chrome: "Default", Firefox: "default-release") or a profile
  # PATH (Chrome: the user-data dir; Firefox: the profile directory).
  [string]$ChromeProfile = '',
  [string]$FirefoxProfile = '',
  # Where the companion scripts live. Default: this file's folder.
  [string]$SourceDir = '',
  # Where config/manifests/launcher live. Default: %LOCALAPPDATA%\ShopBadwill\companion.
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\host\protocol.ps1"   # Test-SbwProfileValue (R2 rules)

function Get-SbwHostName { 'com.shopbadwill.companion' }

function Test-SbwChromeExtensionId {
  param([string]$Id)
  $Id -cmatch '^[a-p]{32}$'
}

function Test-SbwFirefoxExtensionId {
  param([string]$Id)
  # `*` and `?` are literal inside a character class. A wildcard must never
  # become allowed_extensions.
  ($Id.Length -ge 1) -and ($Id.Length -le 128) -and ($Id -cnotmatch '["&|<>^%!\s*?]')
}

function Get-SbwChromeRegKey { 'HKCU\Software\Google\Chrome\NativeMessagingHosts' }
function Get-SbwFirefoxRegKey { 'HKCU\Software\Mozilla\NativeMessagingHosts' }

# R3: allowed_origins lists ONLY the parameterized Chrome extension id.
function Get-SbwChromeManifest {
  param([string]$ExtensionId, [string]$LauncherPath)
  if (-not (Test-SbwChromeExtensionId -Id $ExtensionId)) {
    throw "Invalid Chrome extension id '$ExtensionId'."
  }
  [pscustomobject]@{
    name            = (Get-SbwHostName)
    description     = 'ShopBadwill wake-and-launch companion (starts the browser for armed snipes)'
    path            = $LauncherPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
  }
}

# R3: allowed_extensions lists ONLY the gecko id.
function Get-SbwFirefoxManifest {
  param([string]$ExtensionId, [string]$LauncherPath)
  if (-not (Test-SbwFirefoxExtensionId -Id $ExtensionId)) {
    throw "Invalid Firefox extension id '$ExtensionId'."
  }
  [pscustomobject]@{
    name               = (Get-SbwHostName)
    description        = 'ShopBadwill wake-and-launch companion (starts the browser for armed snipes)'
    path               = $LauncherPath
    type               = 'stdio'
    allowed_extensions = @($ExtensionId)
  }
}

# Chrome and Firefox find a host by a subkey of NativeMessagingHosts whose
# (Default) value is the manifest path. The host name is one path segment, so
# a value like "..\Run" cannot escape the parent key.
function Get-SbwNativeHostRegKey {
  param([string]$ParentKey, [string]$HostName)
  if ([string]::IsNullOrWhiteSpace($ParentKey) -or $ParentKey -notlike 'HKCU\*') {
    throw "Refusing to touch a non-HKCU registry key: $ParentKey"
  }
  if ($ParentKey -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "Refusing a registry key that walks upward: $ParentKey"
  }
  if ([string]::IsNullOrEmpty($HostName) -or
      $HostName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
      $HostName -cmatch '\.\.') {
    throw "Refusing host name '$HostName'."
  }
  "$ParentKey\$HostName"
}

# Every registry-looking argument must be an HKCU key. Drive paths (the
# manifest file) are not registry keys and are left alone.
function Test-SbwRegArgsAreHkcu {
  param([string[]]$ArgList)
  $saw = $false
  foreach ($a in @($ArgList)) {
    if ($a -match '^[A-Za-z]:\\') { continue }
    if ($a -match '^[A-Za-z]{2,8}\\') {
      if ($a -notlike 'HKCU\*') { throw "Refusing to touch a non-HKCU registry key: $a" }
      $saw = $true
    }
  }
  if (-not $saw) { throw 'Refusing a reg command that does not name an HKCU key' }
}

function Get-SbwRegAddArgs {
  param([string]$Key, [string]$ValueName, [string]$ManifestPath)
  $full = Get-SbwNativeHostRegKey -ParentKey $Key -HostName $ValueName
  # /ve sets the key's default value. /v would create a named value the browser does not read.
  $regArgs = @('add', $full, '/ve', '/t', 'REG_SZ', '/d', $ManifestPath, '/f')
  Test-SbwRegArgsAreHkcu -ArgList $regArgs
  $regArgs
}

function Get-SbwRegDeleteArgs {
  param([string]$Key, [string]$ValueName)
  $full = Get-SbwNativeHostRegKey -ParentKey $Key -HostName $ValueName
  # Delete the host subkey only. The parent NativeMessagingHosts key may hold other hosts.
  $regArgs = @('delete', $full, '/f')
  Test-SbwRegArgsAreHkcu -ArgList $regArgs
  $regArgs
}

# The only reg.exe call in the companion. ArgList is splatted so each token
# stays its own argument. Tests replace this function; they must not call reg.exe.
function Invoke-SbwReg {
  param([string[]]$ArgList)
  Test-SbwRegArgsAreHkcu -ArgList $ArgList
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & reg.exe @ArgList | Out-Null
    $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# The native-messaging manifest `path` cannot carry arguments, so it points at
# this two-line launcher. Chrome runs non-executable hosts through cmd.exe;
# Firefox documents batch-file hosts (MDN, Native_messaging). @echo off keeps
# everything except the host's frames off stdout.
# The launcher runs the private host copy next to it (%~dp0 is the launcher's
# own folder) with the system PowerShell, so it names no absolute path: the
# checkout can move or change without affecting the installed host, and the
# file stays ASCII (cmd.exe decodes batch files in the OEM code page).
function Get-SbwLauncherContent {
  "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0host\shopbadwill-host.ps1`" -ConfigPath `"%~dp0config.json`"`r`n"
}

# The host scripts install copies into <data dir>\host. The default data dir
# is under %LOCALAPPDATA%, which only this user, SYSTEM and Administrators can
# write; a checkout under C:\ (e.g. C:\tools) is writable by every signed-in
# user, so the browser must never run the host from there.
function Get-SbwHostFileNames {
  @('shopbadwill-host.ps1', 'protocol.ps1', 'task-xml.ps1', 'io.ps1')
}

# cmd.exe would mangle a path containing % or &, so refuse those locations.
function Test-SbwSafePathValue {
  param([string]$Value)
  ($Value.Length -gt 0) -and ($Value -cnotmatch '["&|<>^%!\r\n]')
}

function Resolve-SbwChromeExe {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  foreach ($p in @("$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $null
}

function Resolve-SbwFirefoxExe {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  foreach ($p in @("$env:ProgramFiles\Mozilla Firefox\firefox.exe",
      "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe",
      "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $null
}

function Get-SbwDataDir {
  param([string]$Explicit)
  if ($Explicit) { $Explicit } else { Join-Path $env:LOCALAPPDATA 'ShopBadwill\companion' }
}

function Get-SbwSchTasksPath {
  $c = Get-Command schtasks.exe -ErrorAction SilentlyContinue
  if ($c) { $c.Source } else { Join-Path $env:SystemRoot 'System32\schtasks.exe' }
}

function Invoke-SbwInstall {
  $sourceDir = $SourceDir
  if (-not $sourceDir) { $sourceDir = $PSScriptRoot }
  $dataDir = Get-SbwDataDir -Explicit $DataDir
  $hostName = Get-SbwHostName

  # Validate inputs before touching anything.
  if ([string]::IsNullOrWhiteSpace($ChromeProfile) -and [string]::IsNullOrWhiteSpace($FirefoxProfile)) {
    throw 'At least one browser profile is required (-ChromeProfile and/or -FirefoxProfile).'
  }
  foreach ($p in @($ChromeProfile, $FirefoxProfile)) {
    if ($p -and -not (Test-SbwProfileValue -Value $p)) {
      throw "Invalid profile value '$p': must be a profile name or path without quotes, &, |, <, >, ^, %, !, backticks, `$(, .. segments or newlines, and not starting with -."
    }
  }
  foreach ($p in @($sourceDir, $dataDir)) {
    if (-not (Test-SbwSafePathValue -Value $p)) {
      throw "Invalid path '$p': pick a location without quotes, &, |, <, >, ^, % or ! (cmd.exe would mangle it)."
    }
  }
  if ($ChromeProfile) {
    if (-not (Test-SbwChromeExtensionId -Id $ChromeExtensionId)) {
      throw 'When -ChromeProfile is set, -ChromeExtensionId is required: the 32-character lowercase id from chrome://extensions (Developer mode).'
    }
  }
  if (-not (Test-SbwFirefoxExtensionId -Id $FirefoxExtensionId)) {
    throw "Invalid -FirefoxExtensionId '$FirefoxExtensionId'."
  }

  foreach ($n in @(Get-SbwHostFileNames)) {
    $src = Join-Path $sourceDir "host\$n"
    if (-not (Test-Path -LiteralPath $src)) {
      throw "Host script not found at '$src'. Run install.ps1 from the repo's companion\windows folder."
    }
  }

  $chromeExePath = $null
  if ($ChromeProfile) {
    $chromeExePath = Resolve-SbwChromeExe -Explicit $ChromeExe
    if (-not $chromeExePath -or -not (Test-Path -LiteralPath $chromeExePath)) {
      throw "Chrome not found. Pass -ChromeExe with the full path to chrome.exe (chrome://version -> Executable Path)."
    }
  }
  $firefoxExePath = $null
  if ($FirefoxProfile) {
    $firefoxExePath = Resolve-SbwFirefoxExe -Explicit $FirefoxExe
    if (-not $firefoxExePath -or -not (Test-Path -LiteralPath $firefoxExePath)) {
      throw "Firefox not found. Pass -FirefoxExe with the full path to firefox.exe."
    }
  }
  if ($chromeExePath -and -not (Test-SbwSafePathValue -Value $chromeExePath)) {
    throw "Invalid Chrome executable path '$chromeExePath': pick a location without quotes, &, |, <, >, ^, % or !."
  }
  if ($firefoxExePath -and -not (Test-SbwSafePathValue -Value $firefoxExePath)) {
    throw "Invalid Firefox executable path '$firefoxExePath': pick a location without quotes, &, |, <, >, ^, % or !."
  }

  $launcherPath = Join-Path $dataDir 'shopbadwill-host.cmd'
  $configPath = Join-Path $dataDir 'config.json'
  $chromeManifestPath = Join-Path $dataDir 'chrome-manifest.json'
  $firefoxManifestPath = Join-Path $dataDir 'firefox-manifest.json'
  $hostDir = Join-Path $dataDir 'host'

  $config = [ordered]@{
    version      = 1
    dataDir      = $dataDir
    schtasksPath = (Get-SbwSchTasksPath)
  }
  if ($ChromeProfile) { $config.chrome = [pscustomobject]@{ exePath = $chromeExePath; profile = $ChromeProfile } }
  if ($FirefoxProfile) { $config.firefox = [pscustomobject]@{ exePath = $firefoxExePath; profile = $FirefoxProfile } }

  Write-Host "ShopBadwill companion install"
  Write-Host "  host:      com.shopbadwill.companion"
  Write-Host "  data dir:  $dataDir"
  if ($ChromeProfile) { Write-Host "  chrome:    $chromeExePath (profile '$ChromeProfile')" }
  if ($FirefoxProfile) { Write-Host "  firefox:   $firefoxExePath (profile '$FirefoxProfile')" }
  Write-Host ''

  if ($PSCmdlet.ShouldProcess($dataDir, 'create companion data directory')) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }

  if ($PSCmdlet.ShouldProcess($configPath, 'write companion config')) {
    $configJson = $config | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($configPath, $configJson, (New-Object Text.UTF8Encoding($false)))
  }

  if ($PSCmdlet.ShouldProcess($hostDir, 'copy the host scripts (the browser runs this private copy)')) {
    New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
    foreach ($n in @(Get-SbwHostFileNames)) {
      Copy-Item -LiteralPath (Join-Path $sourceDir "host\$n") -Destination (Join-Path $hostDir $n) -Force
    }
  }

  if ($PSCmdlet.ShouldProcess($launcherPath, 'write the host launcher')) {
    [IO.File]::WriteAllText($launcherPath, (Get-SbwLauncherContent), [Text.Encoding]::ASCII)
  }

  if ($ChromeProfile) {
    if ($PSCmdlet.ShouldProcess($chromeManifestPath, 'write the Chrome host manifest')) {
      $manifest = Get-SbwChromeManifest -ExtensionId $ChromeExtensionId -LauncherPath $launcherPath
      [IO.File]::WriteAllText($chromeManifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    }
    $regKey = Get-SbwChromeRegKey
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'register the Chrome native-messaging host (HKCU)')) {
      $code = Invoke-SbwReg -ArgList (Get-SbwRegAddArgs -Key $regKey -ValueName $hostName -ManifestPath $chromeManifestPath)
      if ($code -ne 0) { throw "reg add failed for $regKey\$hostName" }
    }
  }

  if ($FirefoxProfile) {
    if ($PSCmdlet.ShouldProcess($firefoxManifestPath, 'write the Firefox host manifest')) {
      $manifest = Get-SbwFirefoxManifest -ExtensionId $FirefoxExtensionId -LauncherPath $launcherPath
      [IO.File]::WriteAllText($firefoxManifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    }
    $regKey = Get-SbwFirefoxRegKey
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'register the Firefox native-messaging host (HKCU)')) {
      $code = Invoke-SbwReg -ArgList (Get-SbwRegAddArgs -Key $regKey -ValueName $hostName -ManifestPath $firefoxManifestPath)
      if ($code -ne 0) { throw "reg add failed for $regKey\$hostName" }
    }
  }

  if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Done. Next steps:'
    Write-Host '  1. FULLY RESTART the browser(s) you configured (native hosts load at startup).'
    Write-Host '  2. Verify: reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.shopbadwill.companion'
    Write-Host '     (HKCU\Software\Mozilla\NativeMessagingHosts\com.shopbadwill.companion likewise for Firefox).'
    Write-Host '  3. In the extension, arm a snipe; the companion schedules the wake task.'
    Write-Host '     Check: Get-ScheduledTask -TaskName "ShopBadwill-*"'
    Write-Host '  4. Power-plan guidance and the wake test: docs/COMPANION.md'
    Write-Host ''
    Write-Host 'Uninstall: powershell -ExecutionPolicy Bypass -File companion\windows\uninstall.ps1'
  }
}

# Skipped when dot-sourced (unit tests).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-SbwInstall
}

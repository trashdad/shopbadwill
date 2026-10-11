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
      shopbadwill-host.cmd launcher, state)
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

function Get-SbwRegAddArgs {
  param([string]$Key, [string]$ValueName, [string]$ManifestPath)
  @('add', $Key, '/v', $ValueName, '/t', 'REG_SZ', '/d', $ManifestPath, '/f')
}

function Get-SbwRegDeleteArgs {
  param([string]$Key, [string]$ValueName)
  @('delete', $Key, '/v', $ValueName, '/f')
}

# The native-messaging manifest `path` cannot carry arguments, so it points at
# this two-line launcher. Chrome runs non-executable hosts through cmd.exe;
# Firefox documents batch-file hosts (MDN, Native_messaging). @echo off keeps
# everything except the host's frames off stdout.
function Get-SbwLauncherContent {
  param([string]$PowerShellExe, [string]$HostScriptPath, [string]$ConfigPath)
  "@echo off`r`n`"$PowerShellExe`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$HostScriptPath`" -ConfigPath `"$ConfigPath`"`r`n"
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

function Get-SbwPowerShellExe {
  $c = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($c) { $c.Source } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
}

function Get-SbwHostScriptPath {
  param([string]$SourceDir)
  Join-Path $SourceDir 'host\shopbadwill-host.ps1'
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
      throw "Invalid profile value '$p': must be a profile name or path without quotes, &, |, <, >, ^, %, ! or newlines."
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

  $hostScriptPath = Get-SbwHostScriptPath -SourceDir $sourceDir
  if (-not (Test-Path -LiteralPath $hostScriptPath)) {
    throw "Host script not found at '$hostScriptPath'. Run install.ps1 from the repo's companion\windows folder."
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
  $powerShellExe = Get-SbwPowerShellExe

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

  if ($PSCmdlet.ShouldProcess($launcherPath, 'write the host launcher')) {
    $launcher = Get-SbwLauncherContent -PowerShellExe $powerShellExe -HostScriptPath $hostScriptPath -ConfigPath $configPath
    [IO.File]::WriteAllText($launcherPath, $launcher, (New-Object Text.UTF8Encoding($false)))
  }

  if ($ChromeProfile) {
    if ($PSCmdlet.ShouldProcess($chromeManifestPath, 'write the Chrome host manifest')) {
      $manifest = Get-SbwChromeManifest -ExtensionId $ChromeExtensionId -LauncherPath $launcherPath
      [IO.File]::WriteAllText($chromeManifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    }
    $regKey = Get-SbwChromeRegKey
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'register the Chrome native-messaging host (HKCU)')) {
      & reg.exe @(Get-SbwRegAddArgs -Key $regKey -ValueName $hostName -ManifestPath $chromeManifestPath) | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "reg add failed for $regKey\$hostName" }
    }
  }

  if ($FirefoxProfile) {
    if ($PSCmdlet.ShouldProcess($firefoxManifestPath, 'write the Firefox host manifest')) {
      $manifest = Get-SbwFirefoxManifest -ExtensionId $FirefoxExtensionId -LauncherPath $launcherPath
      [IO.File]::WriteAllText($firefoxManifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    }
    $regKey = Get-SbwFirefoxRegKey
    if ($PSCmdlet.ShouldProcess("$regKey\$hostName", 'register the Firefox native-messaging host (HKCU)')) {
      & reg.exe @(Get-SbwRegAddArgs -Key $regKey -ValueName $hostName -ManifestPath $firefoxManifestPath) | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "reg add failed for $regKey\$hostName" }
    }
  }

  if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Done. Next steps:'
    Write-Host '  1. FULLY RESTART the browser(s) you configured (native hosts load at startup).'
    Write-Host '  2. Verify: reg query HKCU\Software\Google\Chrome\NativeMessagingHosts /v com.shopbadwill.companion'
    Write-Host '     (Mozilla key likewise for Firefox).'
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

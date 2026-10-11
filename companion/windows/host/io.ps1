<#
.SYNOPSIS
  Side-effect functions of the ShopBadwill companion host: config load, state
  read/write, schtasks invocation, task-XML file writing. Kept in this file so
  tests can redefine them after dot-sourcing (controller ruling R1: tests stub
  schtasks and the state store instead of touching the machine).
#>

function Get-SbwConfig {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    throw "Sbw config not found: $Path"
  }
  # UTF-8 explicitly: install.ps1 writes it without a BOM, and Windows
  # PowerShell 5.1 would otherwise decode it as ANSI (non-ASCII paths break).
  $cfg = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($k in @('dataDir', 'schtasksPath')) {
    if ($cfg.PSObject.Properties.Name -cnotcontains $k -or [string]::IsNullOrWhiteSpace([string]$cfg.$k)) {
      throw "Sbw config is missing required field '$k'"
    }
  }
  $cfg
}

# Returns the state rows (nothing when the file is absent). Rows are unrolled
# into the pipeline so callers collect them with @(...).
function Read-SbwState {
  param([string]$DataDir)
  $p = Join-Path $DataDir 'state.json'
  if (-not (Test-Path -LiteralPath $p)) { return }
  $rows = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $rows -or $null -eq $rows.tasks) { return }
  foreach ($t in @($rows.tasks)) { $t }
}

function Write-SbwState {
  param([string]$DataDir, $Rows)
  $p = Join-Path $DataDir 'state.json'
  $json = @{ version = 1; tasks = @($Rows) } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($p, $json, (New-Object Text.UTF8Encoding($false)))
}

# Runs schtasks with an argument ARRAY and returns exit code + combined output.
# The parameter is named ArgList because a param named $Args is silently eaten
# by PowerShell's automatic $args variable.
function Invoke-SchTasks {
  param([string]$SchTasksPath, [string[]]$ArgList)
  $out = (& $SchTasksPath @ArgList 2>&1 | Out-String).Trim()
  @{ ExitCode = $LASTEXITCODE; Output = $out }
}

# Writes the generated task XML (UTF-16, matching the XmlText declaration)
# and returns its path. schtasks /Create /XML consumes it.
function Write-SbwXmlFile {
  param([string]$DataDir, [string]$TaskName, [string]$Xml)
  if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
  $p = Join-Path $DataDir "$TaskName.xml"
  [IO.File]::WriteAllText($p, $Xml, [Text.Encoding]::Unicode)
  $p
}

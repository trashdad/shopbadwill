# Plain-PowerShell assertion helpers for the companion Pester tests.
#
# Why not Pester's `Should`: the gate (`powershell -File companion/windows/tests/run.ps1`)
# must run green with Pester 3.4 (this machine) AND Pester 5.x (windows-latest CI).
# Pester 5 removed the legacy `Should Be` syntax, and the `Should -Be` syntax does
# not exist in Pester 3.4. These helpers work under both by simply throwing on failure.

function Assert-Equal {
  param($Actual, $Expected, [string]$Message = '')
  if ($Actual -cne $Expected) { throw "Assert-Equal failed: expected <$Expected>, got <$Actual>. $Message" }
}

function Assert-True {
  param($Value, [string]$Message = '')
  if (-not $Value) { throw "Assert-True failed. $Message" }
}

function Assert-False {
  param($Value, [string]$Message = '')
  if ($Value) { throw "Assert-False failed: <$Value>. $Message" }
}

function Assert-Null {
  param($Value, [string]$Message = '')
  if ($null -ne $Value) { throw "Assert-Null failed: got <$Value>. $Message" }
}

function Assert-NotNull {
  param($Value, [string]$Message = '')
  if ($null -eq $Value) { throw "Assert-NotNull failed. $Message" }
}

function Assert-Match {
  param([string]$InputText, [string]$Pattern, [string]$Message = '')
  if ($InputText -cnotmatch $Pattern) { throw "Assert-Match failed: pattern <$Pattern> not found in <$InputText>. $Message" }
}

function Assert-NotMatch {
  param([string]$InputText, [string]$Pattern, [string]$Message = '')
  if ($InputText -cmatch $Pattern) { throw "Assert-NotMatch failed: pattern <$Pattern> found in <$InputText>. $Message" }
}

function Assert-ArrayEqual {
  param($Actual, [string[]]$Expected, [string]$Message = '')
  $a = @($Actual)
  if ($a.Count -ne $Expected.Count) {
    throw "Assert-ArrayEqual failed: length $($a.Count) != $($Expected.Count). $Message (actual: [$($a -join ' | ')]; expected: [$($Expected -join ' | ')])"
  }
  for ($i = 0; $i -lt $a.Count; $i++) {
    if ([string]$a[$i] -cne [string]$Expected[$i]) {
      throw "Assert-ArrayEqual failed at index ${i}: expected <$($Expected[$i])>, got <$($a[$i])>. $Message"
    }
  }
}

function New-TestTempDir {
  $p = Join-Path ([IO.Path]::GetTempPath()) ('sbw-t110-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  $p
}

function Remove-TestTempDir {
  param([string]$Path)
  if ($Path -and (Test-Path -LiteralPath $Path)) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

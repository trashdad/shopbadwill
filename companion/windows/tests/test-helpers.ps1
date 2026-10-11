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

# $PSScriptRoot inside an It block is empty under Pester 5 (and unreliable under
# 3.4). These helpers are defined in this file, so their $PSScriptRoot is the
# tests directory on both versions.
function Get-SbwTestPath {
  param([string]$RelativePath)
  Join-Path $PSScriptRoot $RelativePath
}

function Get-SbwTestText {
  param([string]$RelativePath)
  [IO.File]::ReadAllText((Get-SbwTestPath $RelativePath))
}

# Pester 5 runs top-level file code and Describe/Context bodies during Discovery
# only, so functions dot-sourced or defined there do not exist when the It
# blocks run. Pester 3.4 and 5.x both dot-source a Describe's BeforeAll before
# its tests run. So a portable test file holds only Describe blocks, and their
# bodies hold only BeforeAll/AfterAll/BeforeEach/AfterEach/Context/Describe/It.
# Returns "file:line" for every statement that breaks that shape.
function Get-SbwPesterShapeViolations {
  param([string]$TestsDir)
  $bad = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $TestsDir -Filter '*.Tests.ps1')) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -gt 0) { $bad += "$($f.Name): parse error"; continue }
    if ($null -ne $ast.ParamBlock -or $null -ne $ast.BeginBlock -or $null -ne $ast.ProcessBlock) { $bad += "$($f.Name): param/begin/process block" }
    if ($null -eq $ast.EndBlock) { continue }
    $bad += @(Get-SbwPesterBlockViolations -FileName $f.Name -Statements $ast.EndBlock.Statements -Allowed @('Describe'))
  }
  $bad
}

function Get-SbwPesterBlockViolations {
  param([string]$FileName, $Statements, [string[]]$Allowed)
  $bad = @()
  foreach ($s in @($Statements)) {
    $name = $null
    $cmd = $null
    if ($s -is [System.Management.Automation.Language.PipelineAst] -and $s.PipelineElements.Count -eq 1 -and
        $s.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
      $cmd = $s.PipelineElements[0]
      $name = $cmd.GetCommandName()
    }
    if ($null -eq $name -or $Allowed -cnotcontains $name) {
      $bad += "${FileName}:$($s.Extent.StartLineNumber)"
      continue
    }
    if ($name -ceq 'Describe' -or $name -ceq 'Context') {
      $body = @($cmd.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }) | Select-Object -Last 1
      if ($null -eq $body) { $bad += "${FileName}:$($s.Extent.StartLineNumber)"; continue }
      $bad += @(Get-SbwPesterBlockViolations -FileName $FileName -Statements $body.ScriptBlock.EndBlock.Statements `
          -Allowed @('BeforeAll', 'AfterAll', 'BeforeEach', 'AfterEach', 'Context', 'Describe', 'It'))
    }
  }
  $bad
}

# Returns "file:line" for any *.Tests.ps1 use of $PSScriptRoot that is not a
# file-scope dot-source. Line comments are ignored.
function Test-SbwTestsUseScriptRootOnlyToDotSource {
  param([string]$TestsDir)
  $bad = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $TestsDir -Filter '*.Tests.ps1')) {
    $i = 0
    foreach ($line in [IO.File]::ReadAllLines($f.FullName)) {
      $i++
      if ($line.Trim().StartsWith('#')) { continue }
      if ($line -notmatch '\$PSScriptRoot') { continue }
      if ($line -match '^\s*\.\s+"\$PSScriptRoot\\') { continue }
      $bad += "$($f.Name):$i"
    }
  }
  $bad
}

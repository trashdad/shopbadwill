<#
.SYNOPSIS
  Gate runner for the ShopBadwill companion Pester tests.

.DESCRIPTION
  Runs every *.Tests.ps1 in this directory with the newest installed Pester.
  Must be green with Pester 3.4 (local) and Pester 5.x (windows-latest CI),
  so the tests use plain-PowerShell assertions (tests/test-helpers.ps1).

.EXAMPLE
  powershell -File companion/windows/tests/run.ps1
#>
$ErrorActionPreference = 'Stop'

$tests = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.Tests.ps1' | Sort-Object Name)
if ($tests.Count -eq 0) { Write-Error 'No Pester test files found next to run.ps1.'; exit 1 }

$module = Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1
if (-not $module) {
  Write-Error 'Pester is not installed. Install it with: Install-Module Pester -Scope CurrentUser -Force'
  exit 1
}
Import-Module $module.Path -ErrorAction Stop

Write-Host "Running $($tests.Count) Pester test file(s) with Pester $($module.Version)"
# Pester 5 removed -Script (use -Path). Pester 3.4 has -Script and not this -Path.
if ($module.Version.Major -ge 5) {
  $result = Invoke-Pester -Path $tests.FullName -PassThru
} else {
  $result = Invoke-Pester -Script $tests.FullName -PassThru
}

if ($result.FailedCount -gt 0) {
  Write-Error "Pester failures: $($result.FailedCount)"
  exit 1
}
# Pester 5 counts a file that fails Discovery, or a BeforeAll that throws, as a
# failed container/block, not as failed tests. Its overall Result catches both.
if ($module.Version.Major -ge 5 -and $result.Result -ne 'Passed') {
  Write-Error "Pester result: $($result.Result) (failed blocks: $($result.FailedBlocksCount), failed containers: $($result.FailedContainersCount))"
  exit 1
}
# A run that executed nothing is a broken run, not a green one.
if ($result.PassedCount -eq 0) {
  Write-Error 'Pester ran no passing tests.'
  exit 1
}
Write-Host "Pester: $($result.TotalCount) tests passed."
exit 0

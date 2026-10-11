<#
.SYNOPSIS
  Pure protocol logic for the ShopBadwill wake-and-launch companion host:
  native-messaging framing (4-byte little-endian length + UTF-8 JSON) and the
  strict request validation of controller ruling R2. No side effects.

  R2 values used verbatim:
    - snipeId:    ^[A-Za-z0-9_-]{1,64}$
    - wakeAtUtc:  valid ISO UTC time, in the future, no more than 30 days ahead
    - browser:    exactly 'chrome' or 'firefox'
    - profile:    known profile name or path; no `"`, `&`, `|`, `<`, `>`, `^`,
                  `%`, `!`, newlines, PowerShell backticks or `$(` / `${`
                  subexpressions, and no `..` path segment
#>

$SbwMaxFrameBytes = 1048576

function ConvertTo-SbwFrame {
  param([object]$Message)
  $json = ConvertTo-Json -InputObject $Message -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  if ($bytes.Length -gt $SbwMaxFrameBytes) { throw 'Sbw frame exceeds 1 MiB' }
  $len = [BitConverter]::GetBytes([uint32]$bytes.Length)
  $out = New-Object byte[] (4 + $bytes.Length)
  [Array]::Copy($len, 0, $out, 0, 4)
  [Array]::Copy($bytes, 0, $out, 4, $bytes.Length)
  ,$out
}

function ConvertFrom-SbwFrame {
  param([byte[]]$FrameBytes)
  if ($FrameBytes.Length -lt 4) { throw 'Sbw frame too short' }
  $json = [Text.Encoding]::UTF8.GetString($FrameBytes, 4, $FrameBytes.Length - 4)
  $json | ConvertFrom-Json
}

# Host replies go through this. An oversized message becomes a small error
# frame instead of throwing out of the read loop.
function New-SbwOutboundFrame {
  param([object]$Message)
  try {
    return ConvertTo-SbwFrame -Message $Message
  } catch {
    return ConvertTo-SbwFrame -Message @{ ok = $false; op = $null; error = 'bad-request' }
  }
}

# One inbound frame. $null means EOF. A length outside 1..1MiB is refused
# before the body is read, so a hostile length cannot make us buffer it.
function Read-SbwHostFrame {
  param([IO.Stream]$Stream)
  $lenBuf = Read-SbwBytes -Stream $Stream -Count 4
  if ($null -eq $lenBuf) { return $null }
  $len = [int64][BitConverter]::ToUInt32($lenBuf, 0)
  if (-not (Test-SbwFrameLength -Length $len)) {
    return @{ Error = 'bad-request'; Json = $null }
  }
  $body = Read-SbwBytes -Stream $Stream -Count ([int]$len)
  if ($null -eq $body) { return $null }
  @{ Error = $null; Json = [Text.Encoding]::UTF8.GetString($body) }
}

function Test-SbwFrameLength {
  param([long]$Length)
  ($Length -gt 0) -and ($Length -le $SbwMaxFrameBytes)
}

# Reads exactly $Count bytes or returns $null on EOF before that many bytes.
function Read-SbwBytes {
  param([IO.Stream]$Stream, [int]$Count)
  $buf = New-Object byte[] $Count
  $off = 0
  while ($off -lt $Count) {
    $n = $Stream.Read($buf, $off, $Count - $off)
    if ($n -le 0) { return $null }
    $off += $n
  }
  ,$buf
}

# --------------------------------------------------------------- validation (R2)

$SbwSnipeIdRegex = '^[A-Za-z0-9_-]{1,64}$'
# Backtick is literal inside this single-quoted class. `$` is checked separately
# so a profile may not carry a PowerShell subexpression.
$SbwProfileForbiddenRegex = '["&|<>^%!\r\n`]'
$SbwProfileSubexprRegex = '\$[\(\{]'
$SbwProfileTraversalRegex = '(^|[\\/])\.\.([\\/]|$)'
$SbwTaskNameRegex = '^ShopBadwill-[A-Za-z0-9_-]{1,64}$'

function Test-SbwSnipeId {
  param([string]$Value)
  $Value -cmatch $SbwSnipeIdRegex
}

# Shared with install.ps1: a profile value is a name or path, 1..260 chars,
# with none of the R2-forbidden characters.
function Test-SbwProfileValue {
  param([string]$Value)
  ($Value.Length -ge 1) -and ($Value.Length -le 260) -and
    ($Value -cnotmatch $SbwProfileForbiddenRegex) -and
    ($Value -cnotmatch $SbwProfileSubexprRegex) -and
    ($Value -cnotmatch $SbwProfileTraversalRegex)
}

# Strict message shape: exactly the allowed keys, nothing else.
function Test-SbwExactKeys {
  param($Msg, [string[]]$Allowed)
  $keys = @($Msg.PSObject.Properties.Name)
  if ($keys.Count -ne $Allowed.Count) { return $false }
  foreach ($k in $Allowed) { if ($k -cnotin $keys) { return $false } }
  $true
}

# Parses wakeAtUtc strictly: ISO 8601 with an explicit UTC zone, future,
# <= 30 days ahead. Returns @{ ok = $true; value = <datetimeoffset> } or
# @{ ok = $false; error = '...' }.
function Get-SbwWakeTime {
  param([string]$Text, [datetimeoffset]$Now)
  $s = $Text.Trim()
  # Exact RFC 3339 shape (what JS toISOString() emits): rejects space
  # separators, missing zones, and offsets other than Z / +00:00.
  $isoShape = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:?\d{2})$'
  if ($s -cnotmatch $isoShape) { return @{ ok = $false; error = 'bad-request' } }
  $dto = New-Object datetimeoffset
  $parsed = [datetimeoffset]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dto)
  if (-not $parsed) { return @{ ok = $false; error = 'bad-request' } }
  $explicitUtc = $s.EndsWith('Z') -or $s.EndsWith('z') -or
    ($s -cmatch '[+-]\d{2}:?\d{2}$' -and $dto.Offset.TotalMinutes -eq 0)
  if (-not $explicitUtc) { return @{ ok = $false; error = 'bad-request' } }
  if ($dto.UtcDateTime -le $Now.UtcDateTime) { return @{ ok = $false; error = 'wake-in-past' } }
  if ($dto.UtcDateTime -gt $Now.UtcDateTime.AddDays(30)) { return @{ ok = $false; error = 'wake-too-far-ahead' } }
  @{ ok = $true; value = $dto }
}

function Get-SbwScheduleError {
  param($Msg, [datetimeoffset]$Now, $Config)
  if (-not (Test-SbwExactKeys -Msg $Msg -Allowed @('op', 'snipeId', 'wakeAtUtc', 'browser', 'profile'))) { return 'bad-request' }
  if ($Msg.op -cne 'schedule') { return 'bad-request' }
  if ($Msg.snipeId -isnot [string] -or -not (Test-SbwSnipeId -Value ([string]$Msg.snipeId))) { return 'bad-request' }
  if ($Msg.wakeAtUtc -isnot [string]) { return 'bad-request' }
  $wt = Get-SbwWakeTime -Text ([string]$Msg.wakeAtUtc) -Now $Now
  if (-not $wt.ok) { return $wt.error }
  if ($Msg.browser -isnot [string] -or ($Msg.browser -cne 'chrome' -and $Msg.browser -cne 'firefox')) { return 'bad-request' }
  if ($Msg.profile -isnot [string] -or -not (Test-SbwProfileValue -Value ([string]$Msg.profile))) { return 'bad-request' }
  $prop = $Config.PSObject.Properties[[string]$Msg.browser]
  if ($null -eq $prop -or [string]::IsNullOrWhiteSpace([string]$prop.Value.exePath)) { return 'browser-not-configured' }
  if (-not ([string]$prop.Value.profile -ieq [string]$Msg.profile)) { return 'unknown-profile' }
  $null
}

function Get-SbwCancelError {
  param($Msg)
  if (-not (Test-SbwExactKeys -Msg $Msg -Allowed @('op', 'snipeId'))) { return 'bad-request' }
  if ($Msg.op -cne 'cancel') { return 'bad-request' }
  if ($Msg.snipeId -isnot [string] -or -not (Test-SbwSnipeId -Value ([string]$Msg.snipeId))) { return 'bad-request' }
  $null
}

function Get-SbwListError {
  param($Msg)
  if (-not (Test-SbwExactKeys -Msg $Msg -Allowed @('op'))) { return 'bad-request' }
  if ($Msg.op -cne 'list') { return 'bad-request' }
  $null
}

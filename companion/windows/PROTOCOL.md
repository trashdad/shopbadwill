# ShopBadwill companion: native-messaging protocol (Windows)

The contract between the extension (client, card T-111) and the wake-and-launch
host (`companion/windows/host/shopbadwill-host.ps1`). Every value below is what
the host enforces; treat the extension as untrusted (controller ruling R2).

## Transport

Standard Chrome/Firefox native messaging on stdio:

- Request: 4-byte unsigned little-endian byte length, then that many bytes of
  UTF-8 JSON.
- Response: same framing, exactly one response per request.
- Maximum frame size: 1 MiB in both directions. A request length over 1 MiB
  is refused with an error response, without reading the body, and the host
  exits. A response that would exceed 1 MiB is replaced by a small
  `{ok:false, error:'bad-request'}` frame; the host does not crash.
- The host processes requests until the browser closes stdin, then exits.
- Anything the host writes to stderr is for debugging only (Chrome's
  `--enable-logging`); responses live exclusively on stdout.
- The host name is `com.shopbadwill.companion` (`runtime.connectNative` /
  `sendNativeMessage` argument).

## Requests

Exactly these shapes. Unknown fields, missing fields, wrong types, unknown ops
and malformed values are all refused with `{ok:false, error:'bad-request'}`
(`invalid-json` when the bytes are not JSON at all). Field names are
case-sensitive.

```jsonc
// schedule: create or overwrite the wake task for one snipe
{ "op": "schedule", "snipeId": "abc-123",
  "wakeAtUtc": "2026-10-11T05:00:00.000Z",
  "browser": "chrome",          // "chrome" | "firefox", exactly
  "profile": "Default" }        // the profile NAME or PATH configured at install

// cancel: remove the wake task (idempotent; ok:true if already gone)
{ "op": "cancel", "snipeId": "abc-123" }

// list: report the companion's scheduled tasks
{ "op": "list" }
```

Validation, verbatim from ruling R2:

| Field | Rule |
|---|---|
| `snipeId` | `^[A-Za-z0-9_-]{1,64}$` |
| `wakeAtUtc` | RFC 3339 (`YYYY-MM-DDTHH:mm:ss[.fff]Z` or `+00:00`), in the future, no more than 30 days ahead |
| `browser` | `chrome` or `firefox` (case-sensitive) |
| `profile` | one of the profiles configured by install.ps1 for that browser; no `"`, `&`, `\|`, `<`, `>`, `^`, `%`, `!`, newlines, PowerShell backticks, `$(` / `${` subexpressions, or a `..` path segment |

Errors specific to the wake time: `wake-in-past`, `wake-too-far-ahead`.
`browser-not-configured` = that browser has no profile at install.
`unknown-profile` = the profile is valid-looking but not the configured one.
`browser-not-found` = the configured browser executable is missing (re-run
install.ps1). `schtasks-failed` = the OS refused the task change. `internal` =
an unexpected host failure (retry; details on stderr).

## Responses

```jsonc
{ "ok": true, "op": "schedule", "taskName": "ShopBadwill-abc-123",
  "wakeAtUtc": "2026-10-11T05:00:00.000Z" }

{ "ok": true, "op": "cancel", "taskName": "ShopBadwill-abc-123" }

{ "ok": true, "op": "list", "tasks": [
  { "snipeId": "abc-123", "taskName": "ShopBadwill-abc-123",
    "wakeAtUtc": "2026-10-11T05:00:00.000Z", "browser": "chrome",
    "profile": "Default" }
] }

{ "ok": false, "op": "schedule", "error": "wake-in-past" }   // op is null when the request had no parseable op
```

`tasks` is sorted by `wakeAtUtc` and contains only live tasks (the host prunes
rows whose scheduled task the OS already deleted). Re-scheduling the same
`snipeId` overwrites that snipe's row and task.

## Task names

Always `ShopBadwill-<snipeId>`. `cancel` and `list` (and
`uninstall.ps1`) only ever see or touch names with the `ShopBadwill-` prefix.

## What the wake task does

At `wakeAtUtc` (local wall clock; a machine that wakes later still fires via
`StartWhenAvailable`, within a 1 h window) the one-off task with `WakeToRun`
launches the configured browser executable directly. The task's Exec `Command`
is that executable and `Arguments` are only the profile arguments below (Task
Scheduler requires one Arguments string; it is not a shell command):

- Chrome, profile name: `--profile-directory=<name>`
- Chrome, profile path: `--user-data-dir=<path>` (a value containing `\`, `/`
  or a drive prefix is a path)
- Firefox, profile name: `-P <name>`
- Firefox, profile path: `-profile <path>`

`ExecutionTimeLimit` is `PT0S` (unlimited) so Task Scheduler does not kill the
browser. Fired and orphaned tasks still delete themselves
(`DeleteExpiredTaskAfter PT10M`, `EndBoundary` = wake + 1 h). The task runs as
the interactive, least-privilege current user, with no stored password and
without highest privileges, and is allowed to start on battery (whether a wake
timer actually fires on battery is a power-plan setting, see `docs/COMPANION.md`).

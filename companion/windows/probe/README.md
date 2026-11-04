# S-8 wake probe (throwaway tooling)

Spike tooling for card T-14. Never shipped. The user-facing procedure is `docs/USER-STEPS/S-8.md`; findings go to `docs/spikes/S-8.md`.

## Contents

| File | Purpose |
|---|---|
| `wake-probe.ps1` | Registers a one-off "wake the computer to run this task" scheduled task, logs wake/fire/network-up/Chrome-launch times, removes the task. |
| `wake-probe.Tests.ps1` | Pester tests for the pure log/timing logic (Pester 3.4+ works). |
| `ext/` | Minimal MV3 Chrome extension: optional `background` permission, 1-minute heartbeat alarm, `onStartup` log, keep-awake toggle, JSON export. Load unpacked. |

## wake-probe.ps1

Modes: `Schedule` (default), `Fire` (internal, run by the task), `Summarize`, `Cleanup`.

| Parameter | Default | Meaning |
|---|---|---|
| `-DelayMinutes` | 5 | Minutes until the task fires (1-120). |
| `-Label` | `run` | Tag, e.g. `S3`, `hibernate`. |
| `-LaunchChrome` | off | After network-up, start Chrome with the profile (criterion 4). Skipped (and logged) if Chrome is already running, because `onStartup` would not fire. |
| `-ChromePath` | auto | Path to `chrome.exe`. |
| `-ChromeUserDataDir` / `-ChromeProfile` | default / `Default` | Which profile to open. |
| `-Hosts` / `-HostPort` | `one.one.one.one`, `www.msftconnecttest.com` (neutral hosts only; the probe never contacts shopgoodwill.com) / 443 | "Network up" = all hosts resolve and accept TCP. |
| `-NetworkTimeoutSec` | 300 | Give up waiting for the network. |
| `-LogDir` | `%LOCALAPPDATA%\ShopBadwill\probe` | Log location. |
| `-WhatIf` | | Dry run: logs the plan to `wake-<id>-dryrun.log`, registers nothing. |
| `-LogFile`, `-ExtensionLog` | | Inputs for `-Mode Summarize`. |

The script only creates the scheduled task (current user, interactive, limited, `WakeToRun`, `StartWhenAvailable`, runs on battery) and removes it when it fires, even if the Fire body throws (try/finally). The trigger also has an `EndBoundary` of due+1 h and `DeleteExpiredTaskAfter` of 10 min, so an orphaned task deletes itself. It never changes power settings and never sleeps or hibernates the machine.

Log format (tab separated): `UTC-ISO-time  EVENT  key=value ...`. Events: `SCHEDULED`, `TASK_REGISTERED`, `FIRED`, `WAKE_EVENT` (from the System event log, Power-Troubleshooter 1: wake time and wake source), `NETWORK_UP`/`NETWORK_TIMEOUT`, `CHROME_LAUNCHED`, `TASK_REMOVED`, `SUMMARY`.

Headline numbers (`Summarize`): `FireLatencySec` (fire minus due), `WakeToNetworkUpSec`, `FireToNetworkUpSec`, `ChromeToOnStartupSec`, `NetworkUpToOnStartupSec`, `WokeByTimer`.

Note: if the machine fails to wake by itself and you wake it manually, `StartWhenAvailable` still runs the task; `WakeSource` (Power Button vs Timer) and `FireLatencySec` reveal that it was not a timer wake.

## Tests

```powershell
Invoke-Pester companion/windows/probe/wake-probe.Tests.ps1
```

## Probe extension

Chrome, `chrome://extensions`, Developer mode, Load unpacked, select `ext/`. Popup: request `background`, toggle `power.requestKeepAwake('system')`, add MARKs, export JSON (`{exportedAt, backgroundGranted, keepAwake, startups[], log[]}`). Storage key `log` in `storage.local` (capped at 5000 entries).

# ShopBadwill companion: Windows wake-and-launch

Nothing in the extension runs while the browser is closed or the PC is asleep
(architecture §1.4). The companion closes that gap for snipes: it is a
native-messaging host plus a Windows Task Scheduler **wake timer** that wakes
the PC from sleep/hibernate and launches the browser with your profile ahead of
an armed snipe, so the extension itself can bid as usual (T2). The token never
leaves the browser.

## How it works

- `companion/windows/install.ps1` (run once, per user) registers
  `com.shopbadwill.companion` under `HKCU\Software\Google\Chrome\NativeMessagingHosts`
  and/or `HKCU\Software\Mozilla\NativeMessagingHosts` and writes the config to
  `%LOCALAPPDATA%\ShopBadwill\companion\`.
- When a snipe is armed, the extension asks the host to `schedule`; the host
  registers a one-off `ShopBadwill-<id>` task (`WakeToRun`,
  `StartWhenAvailable`) whose action launches the configured browser with your
  profile. `cancel` removes it; `list` reports it. Protocol:
  `companion/windows/PROTOCOL.md`.
- Fired/orphaned tasks delete themselves (`DeleteExpiredTaskAfter PT10M`,
  1 h `EndBoundary` window). `uninstall.ps1` removes every `ShopBadwill-*` task,
  the registry values and the data dir.

## Power-plan guidance (from S-8 verdicts, provisional)

The reference machine (Lenovo 83F5): S3 standby + hibernate, **no Modern
Standby**, Balanced plan with **Sleep after = Never** on AC and battery and
**Allow wake timers = Enable on AC, Disable on battery** (S-8 stage 1,
read-only). The full wake test (`docs/USER-STEPS/S-8.md`) is still pending;
these verdicts are provisional.

| Setting | Recommendation | Why |
|---|---|---|
| Power source | **Plugged in** whenever a snipe may fire | Wake timers are Disabled on battery in the current plan: an unplugged laptop will NOT wake. |
| Sleep after (AC) | **Never** (already set) | T1: the simplest setup is a PC that never sleeps. |
| Allow wake timers (AC) | **Enable** (already set; not "Important Wake Timers Only") | T2 relies on a normal scheduled-task wake timer. |
| Hibernate | Leave available | A wake timer also fires from hibernate on this machine (to be confirmed by the S-8 user test). |
| Windows Update active hours | Cover your usual auction ends | An update restart ends T1 silently. |
| Lid close action | "Do nothing" on AC if you rely on T1 with the lid shut | `power.requestKeepAwake` does not stop lid-close sleep. |

Apply (elevated PowerShell, changes the active plan):

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1      # allow wake timers on AC
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0  # never sleep on AC
powercfg /setactive SCHEME_CURRENT
```

Revert to the stock plan values:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /setactive SCHEME_CURRENT
```

Firefox note: Firefox has no `background` permission and no keep-awake API, so
on Firefox T1 means "PC awake, Firefox open"; T2 (this companion) is the only
unattended option.

## USER STEP 1: install (do not run as a worker; you run this yourself)

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, and copy
   your unpacked ShopBadwill extension's **ID** (32 lowercase letters a–p).
   You only need this if you configure Chrome.
2. Open a normal (non-admin) PowerShell and set:

   ```powershell
   $R = 'C:\tools\shopbadwill-wt\T-110'          # the checkout folder (repo root after merge)
   ```

3. Pick your profile. `chrome://version` shows **Profile Path**; the folder
   before the last one is the user-data dir, the last one the profile name.
   Firefox: `about:profiles` shows name and **Root Directory**. A value with a
   path separator is treated as a path. Run ONE of:

   ```powershell
   # Chrome + Firefox, typical profiles:
   powershell -ExecutionPolicy Bypass -File "$R\companion\windows\install.ps1" -ChromeExtensionId "<32-char id>" -ChromeProfile Default -FirefoxProfile default-release

   # Chrome only, profile lives in a custom folder:
   powershell -ExecutionPolicy Bypass -File "$R\companion\windows\install.ps1" -ChromeExtensionId "<32-char id>" -ChromeProfile "C:\Users\<you>\ChromeProfile"

   # Firefox only:
   powershell -ExecutionPolicy Bypass -File "$R\companion\windows\install.ps1" -FirefoxProfile default-release

   # Dry run first if you like (changes nothing): append  -WhatIf
   ```

   If a browser was not found, pass `-ChromeExe` / `-FirefoxExe` with the full
   exe path (from `chrome://version` "Executable Path" / the Firefox shortcut).
4. **Fully restart** each configured browser (native hosts load at startup).
5. Verify, then paste these two outputs back:

   ```powershell
   reg query HKCU\Software\Google\Chrome\NativeMessagingHosts /v com.shopbadwill.companion
   reg query HKCU\Software\Mozilla\NativeMessagingHosts /v com.shopbadwill.companion
   ```

   In the extension, arm a dry-run snipe and confirm a task appears
   (`Get-ScheduledTask -TaskName "ShopBadwill-*"`). Tell us: the two `reg
   query` outputs, the task name and its `WakeToRun`/`State` values, and
   anything the extension's companion status shows.

**Never paste** from this step: anything under the Chrome/Firefox profile
folders (no `Local State`, no `Preferences`, no cookies), no tokens, no
passwords. The extension ID and the `reg query` output above are fine to paste.

## USER STEP 2: wake test (after S-8)

With a dry-run snipe armed: put the laptop to sleep 20 minutes before the fire
time, leave it plugged in, and check the extension logs the wake chain (A-6).
The S-8 procedure (`docs/USER-STEPS/S-8.md`) measures wake timers and
network-up time precisely.

## USER STEP 3: uninstall

```powershell
$R = 'C:\tools\shopbadwill-wt\T-110'
powershell -ExecutionPolicy Bypass -File "$R\companion\windows\uninstall.ps1"     # append -WhatIf for a dry run
```

It deletes only `ShopBadwill-*` tasks, removes both registry values and
the data dir. It never changes power settings: revert any manual power-plan
changes with the commands above. Restart the browsers afterwards.

## Security notes

- Every message from the extension is validated strictly (ruling R2):
  `snipeId` `^[A-Za-z0-9_-]{1,64}$`; `wakeAtUtc` RFC 3339 UTC, future, ≤ 30
  days; `browser` `chrome|firefox`; `profile` a configured value without
  `"` `&` `|` `<` `>` `^` `%` `!` or newlines. Task names are always
  `ShopBadwill-` prefixed; cancel/list/uninstall touch nothing else.
- Every `schtasks`/`reg`/browser-launch command is built as an argument array,
  never a concatenated shell string, never `Invoke-Expression`.
- The host manifests allow ONLY the extension IDs given at install (never a
  wildcard). Nothing here needs admin rights; everything is per-user (HKCU).

## Troubleshooting

- "Specified native messaging host not found": the browser was not fully
  restarted after install, or the registry value is missing — re-check step 5.
- The extension reports `browser-not-found` or `unknown-profile`: re-run
  install.ps1 with the current exe path / profile from `chrome://version`.
- The laptop did not wake: it was on battery (DC wake timers disabled), or the
  AC plan's `RTCWAKE` is not `Enable` — check `powercfg /q SCHEME_CURRENT
  SUB_SLEEP RTCWAKE`.

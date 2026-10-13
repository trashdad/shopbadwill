# ShopBadwill companion: Windows wake-and-launch

Nothing in the extension runs while the browser is closed or the PC is asleep
(architecture §1.4). The companion closes that gap for snipes: it is a
native-messaging host plus a Windows Task Scheduler **wake timer** that wakes
the PC from sleep/hibernate and launches the browser with your profile ahead of
an armed snipe, so the extension itself can bid as usual (T2). The token never
leaves the browser.

## How it works

- `companion/windows/install.ps1` (run once, per user) registers
  `com.shopbadwill.companion` as a subkey of `HKCU\Software\Google\Chrome\NativeMessagingHosts`
  and/or `HKCU\Software\Mozilla\NativeMessagingHosts` (the subkey's default value is the
  manifest path) and writes the config to
  `%LOCALAPPDATA%\ShopBadwill\companion\`. It also copies the host scripts to
  `%LOCALAPPDATA%\ShopBadwill\companion\host\`; the browser runs that private
  copy, never the checkout. Re-run install.ps1 after you update the repo, or
  the browser keeps running the old host.
- When a snipe is armed, the extension asks the host to `schedule`; the host
  registers a one-off `ShopBadwill-<id>` task (`WakeToRun`,
  `StartWhenAvailable`) whose action launches the configured browser with your
  profile. `cancel` removes it; `list` reports it. Protocol:
  `companion/windows/PROTOCOL.md`.
- Fired/orphaned tasks delete themselves (`DeleteExpiredTaskAfter PT10M`,
  1 h `EndBoundary` window). `uninstall.ps1` removes every task named
  `ShopBadwill-<snipeId>`, both host subkeys, and the data dir.
- The task runs as you, with your interactive logon and no stored password.
  So it fires only while you are signed in: asleep, hibernated or locked is
  fine. After a restart that leaves the PC at the sign-in screen (for
  example a Windows Update restart), nothing launches until you sign in.

## Power-plan guidance (from S-8 verdicts, provisional)

The reference machine (the test laptop): S3 standby + hibernate, **no Modern
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

The companion never changes the power plan. To put the active plan on the S-8 recommendation (elevated PowerShell) — Sleep after = Never and Allow wake timers = Enable, on AC only:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1      # Allow wake timers = Enable on AC
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0  # Sleep after = Never on AC
powercfg /setactive SCHEME_CURRENT
```

On the reference machine those two AC values are already set, so the commands change nothing until someone has chosen a different timeout or wake-timer policy. Nothing here saves the previous values, so there is no one-command undo. Leave wake timers Disabled on battery (`RTCWAKE` 0 on DC); an unplugged laptop will not wake.

Firefox note: Firefox has no `background` permission and no keep-awake API, so
on Firefox T1 means "PC awake, Firefox open"; T2 (this companion) is the only
unattended option.

## USER STEP 1: install (do not run as a worker; you run this yourself)

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, and copy
   your unpacked ShopBadwill extension's **ID** (32 lowercase letters a–p).
   You only need this if you configure Chrome.
2. Open a normal (non-admin) PowerShell and set:

   ```powershell
   $R = 'C:\tools\shopbadwill'                    # your ShopBadwill checkout (repo root)
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
   reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.shopbadwill.companion
   reg query HKCU\Software\Mozilla\NativeMessagingHosts\com.shopbadwill.companion
   ```

   In the extension, open Options, **Sniping**, card **Wake the computer
   (T2)**: click **Connect the companion** (the browser asks for the native
   messaging permission), type the same profile you gave install.ps1 into
   **Browser profile for the companion**, click **Save profile**, then **Test
   the companion** (it should say "The companion answered: 0 wake tasks
   scheduled."). Pick tier **T2**. Then arm a dry-run snipe and confirm a task
   appears (`Get-ScheduledTask -TaskName "ShopBadwill-*"`); it should wake the
   PC about 8 minutes before the end (the snipe's 5-minute wake minus a
   3-minute margin). Tell us: the two `reg query` outputs, the task name and
   its `WakeToRun`/`State` values, and what **Test the companion** shows.

   What the extension sends the companion: the snipe id, the wake time, the
   browser and that profile. Never the item, the bid or anything about your
   account. A disarm before the wake cancels the task; a wake that has already
   fired is never cancelled.

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
$R = 'C:\tools\shopbadwill'
powershell -ExecutionPolicy Bypass -File "$R\companion\windows\uninstall.ps1"     # append -WhatIf for a dry run
```

It deletes only tasks named `ShopBadwill-<snipeId>`, removes both host subkeys
and the data dir (with the private host copy). It never changes power settings.
Restart the browsers afterwards. If you installed with `-DataDir`, pass the same
`-DataDir` to uninstall.ps1.

## Security notes

- Every message from the extension is validated strictly (ruling R2):
  `snipeId` `^[A-Za-z0-9_-]{1,64}$`; `wakeAtUtc` RFC 3339 UTC, future, ≤ 30
  days; `browser` `chrome|firefox`; `profile` a configured value without
  `"` `&` `|` `<` `>` `^` `%` `!`, backticks, `$(`, `..` segments, newlines
  or a leading `-`. Task names are always
  `ShopBadwill-` prefixed; cancel/list/uninstall touch nothing else.
- Every `schtasks`/`reg`/browser-launch command is built as an argument array,
  never a concatenated shell string, never `Invoke-Expression`.
- The host manifests allow ONLY the extension IDs given at install (never a
  wildcard). Nothing here needs admin rights; everything is per-user (HKCU).
- Who can swap the host: the browser finds it through your HKCU key, then the
  manifest, launcher, config and host copy in
  `%LOCALAPPDATA%\ShopBadwill\companion`. That folder inherits your profile's
  permissions: only you, SYSTEM and Administrators can write it. A web page
  cannot reach the host at all (only the extension IDs above can), and the
  launcher names no path outside that folder except the system PowerShell.
  Keep the default data dir. Never point `-DataDir` at a folder other users
  can write; folders created at the root of `C:\` (such as `C:\tools`) give
  every signed-in user Modify. To check, run this; it should list only you,
  `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`:

  ```powershell
  icacls "$env:LOCALAPPDATA\ShopBadwill\companion"
  ```

## Troubleshooting

- "Specified native messaging host not found": the browser was not fully
  restarted after install, or the host subkey is missing — re-check step 5.
- The extension reports `browser-not-found` or `unknown-profile`: re-run
  install.ps1 with the current exe path / profile from `chrome://version`.
- The laptop did not wake: it was on battery (DC wake timers disabled), or the
  AC plan's `RTCWAKE` is not `Enable` — check `powercfg /q SCHEME_CURRENT
  SUB_SLEEP RTCWAKE`.

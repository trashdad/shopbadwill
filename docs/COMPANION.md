# ShopBadwill companion: Windows power-plan guidance

> DRAFT from T-14 stage 1 (read-only diagnostics only). Items marked **(unverified)** depend on USER STEP S-8 results. T-110 finalizes this document.

Nothing in the extension runs while the browser is closed or the PC is asleep (architecture §1.4). To snipe an auction that ends while you sleep, either keep the PC awake with the browser running (T1) or have Windows wake the PC and start the browser ahead of time (T2).

## Known facts about the reference machine (Lenovo 83F5)

- Sleep states: S3 standby and hibernate. **No Modern Standby (S0 Low Power Idle)**, no hybrid sleep (hypervisor present), Fast Startup disabled by policy.
- Power plan Balanced: Sleep after = Never (AC and battery). Hibernate after = 3 h. **Allow wake timers: Enable on AC, Disable on battery.**

## Recommended settings (draft)

| Setting | Recommendation | Why |
|---|---|---|
| Power source | Plugged in during auction end | Wake timers are disabled on battery in the current plan. |
| Sleep after (AC) | Never, or longer than your longest snipe window **(unverified)** | The simplest T1 setup is a PC that does not sleep. |
| Allow wake timers (AC) | **Enable** (not "Important Wake Timers Only") **(unverified: only the Enable result is measured)** | T2 relies on a normal scheduled-task wake timer. |
| Allow wake timers (battery) | Enable only if you will snipe unplugged | Battery wake drains the battery overnight. |
| Hibernate | Leave available. A wake timer from hibernate is separately measured **(unverified)** | |
| Chrome: "Continue running background apps when Google Chrome is closed" | ON, plus grant the extension's optional `background` permission **(unverified)** | Keeps Chrome (and the service worker) alive after the last window closes. |
| Windows Update active hours / restarts | Set active hours to cover auction ends | An update restart or sleep ends T1 silently. |
| Lid close action | "Do nothing" on AC if you rely on T1 while the lid is shut **(unverified)** | `power.requestKeepAwake` does not stop lid-close or manual sleep. |

Commands (run in an elevated PowerShell only when applying; they change the active plan):

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1      # allow wake timers on AC
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0  # never sleep on AC
powercfg /setactive SCHEME_CURRENT
```

## Firefox

Firefox has no `background` permission and no keep-awake API. T1 on Firefox means: PC awake and Firefox open at fire time. T2 (wake and launch Firefox) is the only unattended option.

## Open items for stage 2

- Does the wake timer fire from S3 and from hibernate, and how long until the network is up?
- Does a task-launched Chrome run the extension's `onStartup` reconcile, and how soon?
- Does `requestKeepAwake('system')` prevent idle sleep here?
- Verdict feed to §1.4: T1 viable (y/n), T2 viable (y/n).

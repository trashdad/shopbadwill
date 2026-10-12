# Setup: ShopBadwill in Chrome (personal use)

ShopBadwill is not on the Chrome Web Store. You build it from the repository
and load it with **Load unpacked**.

- **Time:** about 15 minutes.
- **You need:**
  - Windows with PowerShell
  - Chrome 148 or newer
  - Git
  - Node.js 25 or newer
  - pnpm, through Corepack, which ships with Node

## Install

**1. Get the code.** In PowerShell:

```powershell
cd C:\tools
git clone https://github.com/<owner>/shopbadwill.git
cd C:\tools\shopbadwill
```

Pick a folder and keep it. Chrome derives the extension ID from this folder
(see step 4).

**2. Install the tools and build.**

```powershell
corepack enable
pnpm install
pnpm build
```

The build ends with `✔ Finished`. The extension is now in
`C:\tools\shopbadwill\.output\chrome-mv3`.

**3. Load it into Chrome.**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `C:\tools\shopbadwill\.output\chrome-mv3`.

Branded Chrome ignores the `--load-extension` command-line switch, so always
use **Load unpacked**.

**4. Note the extension ID.** The **ShopBadwill** card shows an **ID** of 32
letters (a to p). You need it for:

- the Google redirect URI (`docs/SETUP-GOOGLE.md`, step 6)
- the companion (`docs/COMPANION.md`, USER STEP 1)

Loading from another folder gives a new ID, and both must be redone.

**5. Pin the toolbar button.**

1. Click the puzzle-piece icon in the toolbar.
2. Click the pin next to **ShopBadwill**.

The toolbar button opens the popup. It has:

- **Kill switch**
- **Overlay on shopgoodwill.com**
- **Open dashboard** (Chrome's side panel)
- **Open options**

**6. First-run setup.** A **Set up ShopBadwill** tab opens on first install. Its
five steps are:

1. a ShopGoodwill sign-in check
2. your home ZIP (optional)
3. Google Calendar (**Connect Google**, or **Skip for now**)
4. a first watch
5. a dry run, where you can allow notifications

Every dry run starts on: nothing is favorited, put on your calendar or bid
until you turn its dry run off in Options → **Settings** → **Dry run (practice
mode)**.

**7. Sign in to ShopGoodwill.** Sign in on shopgoodwill.com in this same
Chrome profile. ShopBadwill reads the site's own session in this browser. Never
paste your password, cookies or tokens anywhere else.

**8. Keyboard shortcut.**

1. Open `chrome://extensions/shortcuts`.
2. Under ShopBadwill, **Kill switch: stop all ShopBadwill automation** is
   **Alt+Shift+K**.
3. Change it here if it clashes with something else.

## Permissions

At install, Chrome grants only these:

- `storage` and `alarms`
- `sidePanel`, added by the build tool; it shows no warning
- site access to `shopgoodwill.com` and `buyerapi.shopgoodwill.com`

Everything else is optional. Chrome asks for it only when you turn on a feature
that needs it:

| Permission | Asked for by | Why |
|---|---|---|
| `notifications` | Options → **Notifications**, or step 4 of setup | Run, outcome and at-risk notifications |
| `identity`, `oauth2.googleapis.com`, `www.googleapis.com` | Connecting Google Calendar | Sign-in and the Calendar API. See the known gap in `docs/SETUP-GOOGLE.md` |
| `ntfy.sh` | Options → **Phone push** | Optional phone push through ntfy |
| `background`, `power` | Options → **Sniping** → **Keep awake (T1)** → **Turn on Keep awake** | Keep Chrome running and the PC awake while a snipe is armed |
| `nativeMessaging` | Options → **Sniping** → **Wake the computer (T2)** → **Connect the companion** | Talk to the Windows companion (`docs/COMPANION.md`) |

## If you snipe with Keep awake (T1)

1. Options → **Sniping** → **Reliability tier** → pick **T1 · Keep awake**.
   Then click **Turn on Keep awake** and allow both permissions.
2. Open `chrome://settings/system`. Turn on **Continue running background apps
   when Google Chrome is closed**. Without it, the `background` permission
   cannot keep Chrome running after the last window closes.
3. Windows power plan, while plugged in: Settings → System → Power →
   **Sleep** (plugged in) → **Never**.

   Keep-awake does not stop these from ending a snipe:
   - sleeping by hand
   - closing the lid
   - an update restart

   See `docs/COMPANION.md` (power-plan guidance) for the lid and wake-timer
   settings.

## Update

```powershell
cd C:\tools\shopbadwill
git pull
pnpm install
pnpm build
```

Then open `chrome://extensions` and click the **Reload** arrow on the
ShopBadwill card. Settings, rules and the Google connection stay. If you use
the companion, re-run `install.ps1` after updating (`docs/COMPANION.md`).

## Remove

Open `chrome://extensions` → ShopBadwill → **Remove**. This deletes all
ShopBadwill data in this profile, the saved Google client included.

- Disconnect Google first if you want ShopBadwill's access revoked at Google
  (`docs/SETUP-GOOGLE.md`, "Disconnect and remove").
- If you installed the companion, uninstall it too (`docs/COMPANION.md`, USER
  STEP 3).

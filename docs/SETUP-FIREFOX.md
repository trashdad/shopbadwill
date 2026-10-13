# Setup: ShopBadwill in Firefox (personal use)

ShopBadwill is not listed on addons.mozilla.org (AMO). You have two ways to
run it:

- **Try it:** a temporary install. Firefox removes it when Firefox restarts.
- **Keep it:** sign it yourself as an *unlisted* add-on on AMO, then install
  the signed `.xpi`.

**You need:**

- Windows with PowerShell
- Firefox 140 or newer
- Git
- Node.js 25 or newer
- pnpm, through Corepack

> **Provisional:** Google Calendar sign-in on Firefox is **not yet verified**.
> The S-4 Firefox test is deferred. See `docs/SETUP-GOOGLE.md`.

## Build

```powershell
cd C:\tools
git clone https://github.com/<owner>/shopbadwill.git
cd C:\tools\shopbadwill
corepack enable
pnpm install
pnpm build:firefox
```

The build ends with `✔ Finished`. The add-on is now in
`C:\tools\shopbadwill\.output\firefox-mv3`.

## Option A · Temporary install (for trying)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `C:\tools\shopbadwill\.output\firefox-mv3\manifest.json`.

Firefox removes a temporary add-on when it restarts, and you must load it
again. Armed snipes and scheduled runs do not survive that, and its saved data
may be lost too. Use Option B for anything you rely on.

## Option B · Signed unlisted install (to keep it)

**1. Get AMO API keys (once).**

1. Sign in at <https://addons.mozilla.org>.
2. Open **Tools** → **Manage API Keys**
   (<https://addons.mozilla.org/developers/addon/api/key/>).
3. Generate credentials. You get a **JWT issuer** and a **JWT secret**.
4. Keep both in your password manager. They are secrets: never commit them or
   paste them into a chat.

**2. Check the add-on ID.** AMO ties an add-on ID to the account that first
signed it. The ID is `GECKO_ID` in `wxt.config.ts`. If you are not that
account, change it there to an ID of your own, such as
`shopbadwill@<something-you-own>`. Then rebuild with `pnpm build:firefox`.

**3. Sign.** AMO wants the source code alongside each unlisted upload. In
PowerShell, from the repository folder:

```powershell
git archive --format zip -o ..\shopbadwill-source.zip HEAD
$env:AMO_JWT_ISSUER = Read-Host 'AMO JWT issuer'
$env:AMO_JWT_SECRET = [System.Net.NetworkCredential]::new('', (Read-Host 'AMO JWT secret' -AsSecureString)).Password
pnpm build:firefox
pnpm sign:firefox ..\shopbadwill-source.zip
Remove-Item Env:AMO_JWT_ISSUER, Env:AMO_JWT_SECRET
```

`Read-Host` keeps the keys out of your command history; the secret is not shown as you type. If the keys are
missing, `sign:firefox` says "skipped" and does nothing. On success it prints
the path of the signed file in `.output\signed\`.

**4. Install the signed file.**

1. Open `about:addons`.
2. Click the gear icon → **Install Add-on From File…**.
3. Choose the `.xpi` in `C:\tools\shopbadwill\.output\signed\`.
4. Accept Firefox's prompt.

**Update:** `git pull`, `pnpm install`, then raise `version` in `package.json`
(AMO refuses a version it has already signed). Then repeat steps 3 and 4.
Your data stays.

## After installing

**1. Site access.**

1. Open `about:addons` → **ShopBadwill** → **Permissions**.
2. Make sure access to `shopgoodwill.com` and `buyerapi.shopgoodwill.com` is
   on. Firefox lets you turn these off, and the overlay and daily job need
   them.

**2. Dashboard.** Firefox shows the dashboard in the sidebar. Click the
toolbar button → **Open dashboard**, or use View → Sidebar → **ShopBadwill**.

**3. Keyboard shortcut.** The kill switch is **Alt+Shift+K**. It is not
Ctrl+Shift+K, which is Firefox's Web Console. To change it:

1. Open `about:addons` → gear icon → **Manage Extension Shortcuts**.
2. Change the shortcut for ShopBadwill.

**4. Sign in to ShopGoodwill** on shopgoodwill.com in this Firefox profile.
Never paste your password, cookies or tokens anywhere else.

**5. First-run setup.** The **Set up ShopBadwill** tab opens on first install.
Every dry run starts on (Options → **Settings** → **Dry run (practice mode)**).

## Permissions

At install, Firefox grants:

- `storage`, `alarms` and `identity`. Firefox cannot make `identity` optional;
  it shows no prompt for it.
- site access to `shopgoodwill.com` and `buyerapi.shopgoodwill.com`.

Firefox asks for the others only when you turn on the feature:

| Permission | Asked for by |
|---|---|
| `notifications` | Options → **Notifications** → **Allow notifications**, or the setup tab's dry-run step |
| `oauth2.googleapis.com`, `www.googleapis.com` | Google Calendar. **Connect to Google Calendar** asks for them (`docs/SETUP-GOOGLE.md`, step 11) |
| `ntfy.sh` | Options → **Phone push** → **Allow ntfy.sh** |
| `nativeMessaging` | Options → **Sniping** → **Wake the computer (T2)** → **Connect the companion** |

## Limits on Firefox

Firefox has no keep-awake API and no `background` permission, so:

- **T1 · Keep awake** is not offered. A saved T1 runs as T0.
- A snipe fires only if the PC is **awake and Firefox is open** at the end
  (T0).
- The only unattended option is **T2**, the Windows companion, which wakes the
  PC and starts Firefox (`docs/COMPANION.md`).

## Remove

`about:addons` → ShopBadwill → **…** → **Remove**. This deletes its data in
this profile.

- Disconnect Google first if you want access revoked at Google
  (`docs/SETUP-GOOGLE.md`).
- Uninstall the companion if you installed it (`docs/COMPANION.md`).

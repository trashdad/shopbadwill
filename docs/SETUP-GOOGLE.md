# Setup: Google Calendar with your own Google project

ShopBadwill puts auction ends on a calendar of its own, **ShopGoodwill
Auctions**, with popups 60, 15 and 5 minutes before each end. It signs in with
**your own** Google Cloud project, so no one else's server is involved.

- **Time:** about 20 minutes.
- **You need:** a personal Google account, ShopBadwill installed
  (`docs/SETUP-CHROME.md` or `docs/SETUP-FIREFOX.md`), and somewhere private
  for one client secret, such as a password manager.
- **Permission asked:** one scope only,
  `https://www.googleapis.com/auth/calendar.app.created`. It lets ShopBadwill
  see and change **only calendars it created**. It cannot read your other
  calendars.

> **Status, as of this guide**
> - **Chrome:** sign-in verified with a test probe (spike S-4, Web client and
>   client secret).
> - **Firefox:** sign-in **not yet verified**. The S-4 Firefox test is deferred.
>   The Firefox steps below follow the design (Desktop app client, loopback
>   redirect). They may change after that test.

## Keep these out of chats, issues, screenshots and the repository

| What | Looks like |
|---|---|
| Client secret | starts `GOCSPX-` |
| Access token | starts `ya29.` |
| Refresh token | starts `1//` |
| Client ID (not secret, but keep it private) | ends `.apps.googleusercontent.com` |
| Your Google password | — |

The **only** place you paste the client ID and client secret is the ShopBadwill
options page: **Google Calendar** → **Your Google client**. They are stored in
this browser's extension storage on this device only. Once saved, the page shows
only the secret's last four characters.

---

## Part 1 · Google Cloud project (once)

**1. Create the project.**

1. Open <https://console.cloud.google.com/projectcreate>, signed in with your
   Google account.
2. Set **Project name** to `ShopBadwill (personal)`.
3. Leave **Location** as "No organization".
4. Click **Create**.
5. Check that the project picker at the top of the page shows
   **ShopBadwill (personal)**. Every later console step must run in this
   project.

**2. Enable the Google Calendar API.**

1. Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>.
2. Click **Enable**.

**3. Configure the consent screen.**

1. Open <https://console.cloud.google.com/auth/overview> ("Google Auth
   Platform"). The older menu path is APIs & Services → OAuth consent screen.
2. Click **Get started**.
3. **App information**:
   1. Set **App name** to `ShopBadwill (personal)`.
   2. Set **User support email** to your own address.
   3. Click **Next**.
4. **Audience**: choose **External**. Click **Next**.
5. **Contact information**: enter your own address. Click **Next**.
6. **Finish**: tick the agreement to the Google API Services User Data Policy.
   Click **Continue**.
7. Click **Create**.

**4. Declare the one scope.**

1. Open <https://console.cloud.google.com/auth/scopes> (Data Access).
2. Click **Add or remove scopes**.
3. Scroll to **Manually add scopes** and paste:

   ```
   https://www.googleapis.com/auth/calendar.app.created
   ```

4. Click **Add to table**, then **Update**.
5. Back on Data Access, click **Save**.

The scope is listed under **Your non-sensitive scopes**, as it was in S-4.

**5. Add yourself as a test user.**

1. Open <https://console.cloud.google.com/auth/audience>.
2. Under **Test users**, click **Add users**, enter your own address, and click
   **Save**.

You need this only until Part 4 publishes the app. It does no harm afterwards.

---

## Part 2 · OAuth client for your browser

Do **2a** for Chrome, **2b** for Firefox, or both.

### 2a · Chrome: Web application client

**6. Find your extension ID.**

1. Open `chrome://extensions`.
2. On the **ShopBadwill** card, copy the **ID**. It is 32 letters from a to p.
3. Your redirect URI is that ID inside this pattern, **with** the trailing slash:

   ```
   https://<your-extension-id>.chromiumapp.org/
   ```

The ID of an unpacked extension depends on the folder you loaded it from.
Loading it from a different folder gives a new ID, and you must add the new
redirect URI (step 7.5) again. The options page does not show this URI; use
`chrome://extensions`.

**7. Create the client.**

1. Open <https://console.cloud.google.com/auth/clients> and click
   **Create client**.
2. Set **Application type** to **Web application**.
3. Set **Name** to `ShopBadwill Chrome (Web)`.
4. Leave **Authorized JavaScript origins** empty.
5. Under **Authorized redirect URIs**, click **Add URI** and paste your URI
   from step 6.
6. Click **Create**.
7. The dialog shows the **Client ID** and **Client secret**. **The secret is
   shown only this once.** Copy it into your password manager. Never save it
   inside the ShopBadwill folder or any other repository.
8. Copy the **Client ID** too.

The Chrome Web client **needs the client secret**. Without it, Google refuses
the sign-in with "client_secret is missing." (S-4, tested twice).

### 2b · Firefox: Desktop app client (provisional)

**8. Create the client.**

1. Open <https://console.cloud.google.com/auth/clients> and click
   **Create client**.
2. Set **Application type** to **Desktop app**.
3. Set **Name** to `ShopBadwill Firefox (Desktop)`.
4. Click **Create**.
5. Copy the **Client secret** into your password manager now; it is shown
   once. Copy the **Client ID**.

There is no redirect URI to enter. Firefox signs in through the loopback
address `http://127.0.0.1/mozoauth2/<hash>`. The hash is fixed for this add-on.
The options page does not show it.

The options page asks for a client secret on Firefox too. Paste the Desktop
client's secret.

---

## Part 3 · Connect ShopBadwill

**9. Open the Google section.**

1. Click the ShopBadwill toolbar button → **Open options**.
2. Go to the section **Google Calendar**.

On first install, the **Set up ShopBadwill** tab's calendar step has a
**Connect Google** button. It opens this same section.

**10. Paste the client.** In the card **Your Google client**:

1. Paste the client ID into **Client ID**. It looks like
   `1234567890-abc123.apps.googleusercontent.com`.
2. Paste the client secret into **Client secret**. The field hides what you
   type.

**11. Connect.**

1. Click **Connect to Google Calendar**. A Google window opens.
2. Choose your Google account.
3. "Google hasn't verified this app" appears. This is expected for a personal
   project. Click **Advanced** → **Go to ShopBadwill (personal) (unsafe)**. On
   some screens it is a plain **Continue** button.
4. On the permission screen, tick the calendar box if there is one, then click
   **Continue**.

The window closes. The card **Connection** now shows:

- **Connected**
- **Permission**: `https://www.googleapis.com/auth/calendar.app.created`
- **Last error**: None

**12. Turn calendar events on.**

1. Click **Turn on calendar events now?**. Or, in the card **Calendar**, switch
   on **Add auction ends to Google Calendar**.
2. Open <https://calendar.google.com>. A new calendar named
   **ShopGoodwill Auctions** is in your list.

**13. Dry run: calendar.** New installs start in practice mode. Calendar writes
are only logged until you turn this off:

1. Options → **Settings** → card **Dry run (practice mode)**.
2. Turn **Dry run: calendar** off when you want real events on Google.

**14. Reminders (optional).** The card **Calendar** → **Reminders (minutes
before the auction ends)** starts at 60, 15 and 5. Google allows at most 5. Use
**Reset to 60, 15, 5** to go back, and **Save reminders** to keep a change.

---

## Part 4 · Publish the app ("In production")

Do this, or Google signs you out every 7 days.

While the project's publishing status is **Testing**, Google gives a refresh
token a 7-day life. S-4 measured `refreshTokenExpiresIn 604799` seconds. After
that, unattended calendar sync stops with `invalid_grant`. A personal project
in **In production** status keeps working.

**15. Publish without verification.**

1. Open <https://console.cloud.google.com/auth/audience>.
2. Click **Publish app**, then confirm (for example **Push to production?** →
   **Confirm**).
3. **Do not** click "Prepare for verification" and do not submit anything for
   verification. Personal use with fewer than 100 users does not need it.
4. **Publishing status** now reads **In production**.

**16. Sign in again.** A token issued while the app was in Testing keeps its
7-day life.

1. Options → **Google Calendar** → card **Connection** → **Disconnect** →
   **Yes, disconnect**.
2. Click **Connect to Google Calendar** again (step 11). Your client ID and
   secret are kept, so you need not paste them again.

While the token is still a Testing one, the **Connection** card shows:
"Warning: Your Google app is in Testing mode, so Google signs you out every 7
days." After step 16 that warning goes away.

---

## Part 5 · Phone popups

**17. Turn the calendar's notifications on in the phone app.**

1. Install the Google Calendar app on your phone, signed in to the same
   account, and allow its notifications.
2. In the app: menu → **Settings** → **ShopGoodwill Auctions**. Make sure it is
   synced (shown in the calendar list) and its notifications are on.

**18. Test it once.** ShopBadwill has no test-event button.

1. On <https://calendar.google.com>, create an event on **ShopGoodwill
   Auctions** about 5 minutes from now, with a notification 1 minute before.
2. Lock the phone and wait. The popup arrives.
3. Delete the test event.

The full check, with the PC switched off, is acceptance A-3
(`docs/ACCEPTANCE.md`).

---

## Disconnect and remove

1. Options → **Google Calendar** → **Disconnect** → **Yes, disconnect**.
   ShopBadwill revokes its access at Google. Events it already created stay on
   your calendar.
2. Check <https://myaccount.google.com/connections>: "ShopBadwill (personal)"
   is gone. If it is still listed, open it and remove access.
3. To delete the events too, delete the **ShopGoodwill Auctions** calendar in
   Google Calendar: **Settings** → the calendar → **Remove calendar** →
   **Delete**.

---

## Troubleshooting

The **Last error** line in the card **Connection** names the problem.

| You see | Cause | Fix |
|---|---|---|
| Last error "Google no longer accepts your sign-in. Reconnect Google." (`invalid_grant`), about once a week | The app is still in **Testing** | Do Part 4, then reconnect |
| Google error page `Error 400: redirect_uri_mismatch` | Chrome: the redirect URI in the Web client does not match your extension ID (a new folder gives a new ID) | Repeat step 6, add the exact URI with its trailing slash to the Web client, click **Save**, connect again |
| "client_secret is missing." / Last error "Google refused the request. Check your client ID and secret, then reconnect." | The secret is missing or belongs to another client | Paste the secret of **this** client into **Client secret**, then connect |
| Last error "Calendar access was not granted. Reconnect and allow it." | The calendar box was left unticked, or a broader permission was granted | Connect again and allow the calendar permission |
| "That does not look like a Google client ID." | You pasted something else, such as the secret or the project number | Paste the value that ends `.apps.googleusercontent.com` |
| **Connect to Google Calendar** is greyed out | The client ID or the secret is empty | Fill in both. A saved secret shows as `Saved: …` in the field |
| Last error "Enter your client ID and client secret above, then connect." right after you clicked Connect, with both filled in | The browser has not granted the `identity` permission (see the known gap below) | See the known gap below |
| Toolbar badge **!** and "Google needs you to sign in again." | Access was removed at Google, or the token lapsed | Click **Reconnect Google** and approve |

**Known gap (found while writing this guide).** On Chrome, `identity` and the
two Google hosts (`oauth2.googleapis.com`, `www.googleapis.com`) are
*optional* permissions. On Firefox, the two hosts are optional too. No button in
ShopBadwill asks the browser for them yet. Until that is fixed:

- **Firefox:** open `about:addons` → **ShopBadwill** → **Permissions**, and turn
  on access to `oauth2.googleapis.com` and `www.googleapis.com`.
- **Chrome:** there is no settings switch for optional permissions. This
  workaround is **unverified**:
  1. On the options page, open DevTools (F12) → **Console**.
  2. Run the line below and accept the browser's prompt.
  3. Then click **Connect to Google Calendar**.

  ```js
  chrome.permissions.request({ permissions: ['identity'], origins: ['https://oauth2.googleapis.com/*', 'https://www.googleapis.com/*'] })
  ```

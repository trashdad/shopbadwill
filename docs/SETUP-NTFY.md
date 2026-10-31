# Phone push with ntfy

ShopBadwill can send the auction end reminders (60, 15 and 5 minutes before
the end) to your phone through [ntfy](https://ntfy.sh). It is off by default.

What is sent: the auction title, the end time in your time zone, how many
minutes are left, and the item link. Nothing else (no prices, no max bids).

## With ntfy.sh (the default)

1. Options → **Phone push** → turn on **Phone push (ntfy)**.
2. **Topic** → **Generate topic**, then **Copy topic**. The topic is a
   128-bit secret: anyone who knows it can read your reminders, so keep it
   private.
3. **Permission** → **Allow ntfy.sh**.
4. On your phone, install the ntfy app and subscribe to the topic on
   `https://ntfy.sh`.
5. **Send a test push**. It should arrive within a few seconds.

Phone push follows calendar sync: calendar events must be on, and "Dry run:
calendar" must be off, before any reminder is scheduled.

## Self-hosted ntfy

You can run your own ntfy server instead. These steps assume it denies
access by default (`auth-default-access: deny-all`), so publishing needs an
access token. The examples use the placeholder host `ntfy.example.com` and
placeholder user names: use your own.

### 1. Make a write-only user for ShopBadwill

On the server, in your own terminal:

```sh
ntfy user add shopbadwill
ntfy access shopbadwill 'sbw-*' write-only
```

`sbw-*` covers every topic ShopBadwill generates (they all start with `sbw-`).
`write-only` lets it publish and cancel, but not read. ntfy ACLs support `*`
as the only wildcard ([access control](https://docs.ntfy.sh/config/#access-control)).

### 2. Make an access token

Still in your own terminal, on the server:

```sh
ntfy token add shopbadwill
```

It prints a token that starts with `tk_`
([tokens via the CLI](https://docs.ntfy.sh/config/#tokens-via-the-cli)).
Do not paste it into chats, issues or screenshots.

### 3. Enter the server and the token in ShopBadwill

1. Options → **Phone push** → **Server**: enter `https://ntfy.example.com`
   (https only, no path after the host), then **Save server**.
2. **Access token (optional)**: paste the token, then **Save token**. After
   saving, only its last 4 characters are shown.
3. Turn on **Phone push (ntfy)**, **Generate topic**, and **Allow
   ntfy.example.com**. The browser asks for access to that one host only.
4. **Send a test push**. If the server refuses the token (HTTP 401 or 403),
   the page says so: check the token and that the user may write to `sbw-*`.

The token is stored in this browser profile only (`storage.local`). It is never
logged, never written to the activity log, and never exported.

Changing the server or the token while phone push is on first cancels the
pushes already scheduled on the old server, using the old token. If the old
server cannot be reached, the server is not changed. Turn phone push off first
to switch anyway; the old pushes may then still arrive.

### 4. Subscribe your phone with an account that can read

The ShopBadwill user is write-only, so the phone needs its own user:

```sh
ntfy user add phone
ntfy access phone 'sbw-*' read-only
```

In the ntfy app, add the server `https://ntfy.example.com` with that user
name and password, then subscribe to the topic you copied.

### 5. Check the server's delay and cache limits

ShopBadwill schedules each reminder ahead of time with ntfy's `X-Delay`
header, so the server, not your browser, sends it at the right moment. It
schedules a reminder at most 3 days ahead and re-schedules the later ones
from the daily job. Facts from the ntfy docs:

- **`message-delay-limit`** is the longest a message can be scheduled into the
  future. Default: `3d`
  ([config options](https://docs.ntfy.sh/config/#config-options),
  [message limits](https://docs.ntfy.sh/config/#message-limits)). Keep it at
  `3d` or longer, or reminders more than that far ahead are refused.
- **Scheduled delivery needs the message cache.** "Turning off server-side
  caching is not possible in combination with this feature"
  ([scheduled delivery](https://docs.ntfy.sh/publish/#scheduled-delivery)).
  So `cache-duration` must not be `0`.
- **How long a scheduled message is kept.** The docs say "scheduled messages
  are kept in the cache until 12 hours after they were delivered", where 12
  hours is the default `cache-duration`
  ([scheduled delivery](https://docs.ntfy.sh/publish/#scheduled-delivery);
  default `12h` in [config options](https://docs.ntfy.sh/config/#config-options)).
  So the cache window starts at delivery, not at publishing.
- **Restarts.** By default ntfy keeps the cache in memory, so a restart loses
  every message not yet delivered, scheduled reminders included. Set
  `cache-file` (SQLite) or `database-url` (PostgreSQL) to keep them
  ([message cache](https://docs.ntfy.sh/config/#message-cache)).
- **Cancelling.** ShopBadwill cancels a scheduled reminder with `DELETE
  /<topic>/<sequence id>`, and updates one by publishing again with the same
  sequence id, which replaces the pending message
  ([canceling](https://docs.ntfy.sh/publish/#canceling-scheduled-notifications),
  [updating](https://docs.ntfy.sh/publish/#updating-scheduled-notifications)).
  The ShopBadwill user needs write access for both.

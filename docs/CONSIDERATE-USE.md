# Considerate use

ShopBadwill is a guest on shopgoodwill.com (SGW). These rules are built into
the code, not left to good intentions. This page says what they are, and what
you can turn down further.

## What the extension always does

1. **One door, with spacing and daily budgets.** Every request ShopBadwill
   makes to SGW goes through one scheduler. It has four lanes:

   | Lane | Used for | Gap between requests | Daily budget |
   |---|---|---|---|
   | interactive | things you click: Run now, badges while you scroll | 1 s (+ up to 0.3 s) | 300 |
   | background | the daily job, outcome reads, preflights | **120 s** (+ up to 15 s) | 120 |
   | snipe | the final minutes of one armed snipe | 1 s | 80 |
   | canary | the CI drift check (not in your browser) | 120 s | 4 |

   - Each lane sends one request at a time.
   - Budgets reset at local midnight.
   - A spent lane refuses until then. It does not queue the requests up.

   The 120 s background gap honours the `Crawl-delay` in SGW's robots.txt.

2. **Backs off, never retries hot.**
   - A 429 or 5xx backs the lane off, starting at 30 s and doubling up to
     30 minutes.
   - A 403 backs it off for 1 hour.
   - Three 403s in a row pause **every** lane for 6 hours.
   - Three 429s in a row pause every lane until the backoff ends.

   You get a notification either way. A longer `Retry-After` from SGW always
   wins.

3. **Honours robots.txt.** It never automates a page load of the paths that
   robots.txt disallows:
   - `/categories/listing?st=` (search pages with a search term)
   - `/shopgoodwill/*`
   - `/home-preview/`
   - `/checkout/`

   Watches and the daily job call the same JSON search API the site's own page
   uses. They never open or scrape search pages.

4. **Adds nothing to pages you open yourself.** On a search page you are
   viewing, the overlay reuses the data the page already loaded. Its cost is
   zero extra SGW requests (acceptance A-1 checks this).

5. **No CAPTCHA solving.** ShopBadwill never tries to solve or bypass a
   challenge. A challenge or block reaches it as refused requests (403), and
   those back it off and then pause it, as in rule 2.

6. **No identity spoofing.** Requests go out as your browser makes them. There
   are no changed headers, no fake user-agent and no borrowed credentials.

7. **One account.** It uses only the SGW session you signed in with in this
   browser profile. It never logs in, never stores your password, and never
   runs several accounts.

8. **One bid per snipe.** A snipe sends exactly one bid. The single exception
   is a retry when the first bid **provably never left the browser**. That
   means it was refused locally, or the network layer proved no byte was sent.
   The retry is always for the same amount.

   If there is any doubt that the first bid reached SGW, ShopBadwill reads the
   item first. It never re-bids blindly. A reply it does not recognise is never
   resent.

   The catalogue of SGW's bid replies is **provisional**: it waits on the
   Phase 5 capture (P5). Until then, an unrecognised reply is treated as
   "unknown", never as success.

9. **The snipe window is the one exception to the 120 s rule.** It is bounded:

   - one item that you armed yourself
   - at most 6 reads in the final 5 minutes, at least 20 s apart, except the
     bid form read and the bid together at fire time
   - one bid
   - never in parallel

   Acting on live state at the close is the purpose of the feature.

## A typical day

This assumes 5 watches with 2 pages each, about 10 new matches a day, about 10
search pages you view, and 3 armed snipes a week:

- **Total:** about 60–90 SGW requests.
- **Daily job:** about 25 of them, all at least 120 s apart.
- **Each armed snipe:** about 8, made up of:
  - 1 preflight
  - 3 clock samples
  - 1 check 60 s before the end
  - 1 bid form read
  - 1 bid
  - 1 read afterwards

The hard caps are 300 interactive, 120 background and 80 snipe requests a day.

## What you can turn down

| Setting (where) | Effect |
|---|---|
| **Considerate mode** → **Tight** (Options → **Settings** → **Features**) | Halves every daily budget and doubles every gap between background requests |
| **Landed cost** (Options → **Settings** → **Features**) | Off: no shipping-quote requests |
| **Refresh countdowns from ShopGoodwill's clock** (same card) | Off: no clock samples for on-page countdowns |
| **Mark up listings on ShopGoodwill** (Options → **Settings** → **On the ShopGoodwill page**), or **Overlay on shopgoodwill.com** in the popup | Off: no overlay at all |
| **Run my watches every day** (Options → **Settings** → **Daily run**) | Off: no daily job |
| Per watch: **Track in ShopBadwill only** (Options → **Watches**) | Matches are kept locally; nothing is favorited on your account |
| **Sniping** (Options → **Sniping**) | Off: no snipe traffic at all |
| **Kill switch** (popup, or **Alt+Shift+K**) | Stops all automation and all writes at once |

The Options → **Health** page shows the request counts and spacing. Its
**Considerate mode** line shows the current mode.

## Your part

- Use one SGW account, your own.
- Keep watches narrow. A watch with many pages costs more requests every day
  for little gain.
- If SGW blocks or pauses you, leave it paused. Do not work around it.
- Read SGW's terms. Automated bidding and favoriting may be against them, and
  the risk is yours.

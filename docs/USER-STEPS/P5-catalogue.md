# USER STEP P5: the PlaceBid response catalogue (about 15 minutes)

**This is a real, binding bid that you place yourself, on ShopGoodwill's own page.** You choose one cheap item you actually want, and an amount you are happy to pay for it, including shipping and handling. If you win, you buy it. Treat the bid as final: assume you cannot take it back.

**The extension places nothing.** It takes no part in this step and doesn't need to be installed. If it is installed, don't arm a snipe while you do this.

**Why you:** the extension must never guess what SGW's reply to a bid means. Nobody has seen a real reply yet: the codes in the plan are guesses. Until real replies are recorded, the extension treats every bid reply as "unrecognised" and never as success. Workers never bid and never sign in as you, so only you can record one. Your bid's reply becomes the catalogue that teaches the extension to read SGW's answers (card T-100, stage 2).

**Never paste, into chat or into any file:**
- your password;
- request headers, cookies, or anything starting `eyJ` (your login token);
- "Copy as cURL", "Copy all as HAR" or "Save all as HAR";
- `redact.txt`;
- the saved JSON files themselves. They stay on your disk, and the worker reads them there.

You only copy **response bodies**, from the **Response** tab, exactly as below. Raw files go to `test/fixtures/sgw/raw/user/`, which git ignores. The worker sanitizes them before anything is committed. Use Chrome on Windows.

## 1. Setup (once)

1. In PowerShell, run this. `Save-Clip` is the same helper as in S-1: it writes the clipboard to a file in that folder (UTF-8, no BOM).
   ```powershell
   $R = 'C:\tools\shopbadwill-wt\T-100'
   $U = "$R\test\fixtures\sgw\raw\user"
   New-Item -ItemType Directory -Force $U | Out-Null
   function Save-Clip($name) { [IO.File]::WriteAllText("$U\$name", (Get-Clipboard -Raw)); Get-Item "$U\$name" | Select-Object Name, Length }
   git -C $R check-ignore test/fixtures/sgw/raw/user/placebid-1.json
   ```
   The last line must print `test/fixtures/sgw/raw/user/placebid-1.json`. If it prints nothing, or if `C:\tools\shopbadwill-wt\T-100` doesn't exist, **stop** and tell us. Don't save anything anywhere else.
2. Run `notepad "$U\redact.txt"`. Type, one per line, everything personal the site shows you (the same list as S-1 step 0.2):
   - your ShopGoodwill username;
   - your first name and your last name as the site shows them;
   - your email;
   - each saved address's street line, city and ZIP;
   - your phone number, written the way the site shows it.

   Save the file and **do not paste it anywhere.** The sanitizer replaces these strings in every capture and refuses to build if one survives.

## 2. Choose the item

3. Sign in to `https://shopgoodwill.com` as usual. Open the item you chose, in a normal tab. Pick an auction that still has at least an hour to run, so you're never racing the clock.

## 3. Let the bid through (S-1's safety net)

S-1 step 0.5 set up DevTools **request blocking** with four patterns. One of them, `*ItemBid/PlaceBid*`, blocks every bid made from a tab while DevTools is open there, including the one you are about to place.

4. On the item's tab, press F12 to open DevTools. Press Ctrl+Shift+P, type `blocking`, and open **Network request blocking** (newer Chrome calls it **Request conditions**).
5. Look at the list:
   - If `*ItemBid/PlaceBid*` is there, remove **only that one pattern**: hover over it and click the **×** at its right, or right-click it and choose **Remove**. Leave `*Favorite/Save*`, `*AddToFavorite*` and `*RemoveItemFromFavoriteList*`, and the **Enable** tick, exactly as they are. You put it back in step 16.
   - If the list is empty (you cleaned up in S-1 step 13), there is nothing to remove.

   Note which case it was, for `notes-p5.txt`.

## 4. Record the bid

6. In DevTools, go to the **Network** tab. Tick **Preserve log**. In the filter box, type `ItemBid`. That shows both `ShowBidModal` and `PlaceBid` rows.
7. On the item page, click the site's own bid button, the one that opens the bid popup. A `ShowBidModal` row appears.
8. Right-click the `ShowBidModal` row and choose **Copy → Copy response**. That copies exactly what the row's **Response** tab shows. Never choose the other Copy entries. Then run `Save-Clip showbidmodal-p5.json`.
9. Note the minimum bid the popup shows.
10. **Your bid.** In the popup, type your amount: one you are happy to pay, at or above the minimum shown. Click the popup's own **Place Bid** button, and confirm if the site asks. If the site shows a reCAPTCHA or another check, complete it as you normally would and note what you saw.
11. A `PlaceBid` row appears:
    - If its **Status** column says `(blocked:devtools)` or anything with "blocked", your bid was **not sent**. Go back to step 5, remove the pattern, and then repeat steps 7 to 11.
    - If its **Status** shows `(failed)` or `(canceled)`, or the row has no response, **do NOT bid again**: the bid may still have reached SGW. Check the item page instead: reload it and look at the bid history and whether it says you are the high bidder. Write down the Status and what the page shows in `notes-p5.txt`, and skip to step 15.
    - Otherwise, note the Status value (for example `200`). Right-click the row and choose **Copy → Copy response**. Then run `Save-Clip placebid-1.json`.
12. Copy, word for word, what the page tells you after the bid (for example "You are the high bidder" or "You have been outbid"). It goes in `notes-p5.txt`. If you were outbid at once, that is a useful catalogue entry too. **Don't bid again just for this.**

## 5. Optional: a too-low attempt

This step is optional. Do it only through the site's own popup, and only if the site's own page sends the attempt and shows you the rejection.

13. Click the site's bid button again, so the popup reopens. Type an amount **below** the minimum it now shows, and click **Place Bid**. Use only an amount you would also be willing to pay: if the site accepted it, it would be binding too.
14. Then:
    - If the page shows an error and **no new `PlaceBid` row** appears, the site checked it on its own. Note its words and skip to step 15. Don't try to get around the check: no Console, no editing or replaying requests, no "Edit and Resend".
    - If a new `PlaceBid` row appears, note its Status, copy its response (Response tab only) and run `Save-Clip placebid-too-low.json`. Note what the page said. A Status of `403` is useful too: save whatever the Response tab shows, even if it is empty or HTML.

## 6. Notes, safety net, files

15. Run `notepad "$U\notes-p5.txt"` and fill in:
    ```
    bid placed at (your local time):    e.g. 2026-10-12 21:14 ET
    popup minimum shown (step 9):       $...
    your bid amount (optional):         $...   or "prefer not to say"
    placebid-1 status:                  e.g. 200
    page said after the bid:            exact words
    outbid right away:                  yes / no
    reCAPTCHA or extra confirmation:    none / what you saw
    too-low attempt:                    skipped / site refused without a request: "its words" / sent: status ..., page said "..."
    blocking pattern in step 5:         removed / was not there
    ```
16. **Put the safety net back.** If you removed `*ItemBid/PlaceBid*` in step 5, open the blocking panel again (step 4), click **+**, type `*ItemBid/PlaceBid*` and press Enter. Leave **Enable** as it was before step 5. The patterns act only in a tab while DevTools is open there.
17. Check the files: run `Get-ChildItem $U | Select-Object Name, Length`. Expect `redact.txt`, `notes-p5.txt`, `showbidmodal-p5.json`, `placebid-1.json`, and `placebid-too-low.json` if step 14 sent a request. Other files from S-1 may be there too, if that worktree folder was reused.

## Reply with

`USER STEP P5 done`, the output of step 17, and the contents of `notes-p5.txt`. Nothing else: no headers, no tokens, not `redact.txt`, and not the JSON files (the worker reads them from disk). File times are used as capture times.

# Fake SGW buyerapi

Local stand-in for `https://buyerapi.shopgoodwill.com`. Run with `pnpm fake:sgw` (binds `127.0.0.1:8787`; env `SBW_FAKE_SGW_PORT`, `SBW_FAKE_SGW_SCENARIO`), or in-process:

```ts
import { startFakeSgw } from './index';
const sgw = await startFakeSgw({ port: 0, scenario: 'rate-limited' }); // port 0 = free port
sgw.url; sgw.mintToken({ expiresInMs: 60_000 }); await sgw.close();
```

Raw request/response shapes are in `shapes.ts` (zod). T-24 owns the real adapter schemas and will validate this server against them.

## Endpoints (under `/api/`)

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST Search/ItemListing` | no | String booleans required. 40 rows/page, `maxTotalRecords` 10000. `"` in `searchText` is 403. Malformed body (bad JSON, real booleans, wrong types) is 200 with zero rows. Row `minimumBid` is the starting minimum. `isFavorite` only when a valid bearer is sent. |
| `GET ItemDetail/GetItemDetailModelByItemId/{id}` | no | Naive-PT `endTime`, `serverTime` with ms, `minimumBid` is the next acceptable bid, `inWatchlist` is null when anonymous. |
| `POST Dashboard/GetCurrentTime` | no | JSON string, naive Pacific, seconds only. |
| `POST itemDetail/CalculateShipping` | no | Shape unverified on the real site. |
| `GET Favorite/AddToFavorite?itemId=`, `GET Favorite/RemoveItemFromFavoriteList?itemId=` | bearer | |
| `POST Favorite/GetAllFavoriteItemsByType?Type=open\|close\|all`, `POST Favorite/Save {notes, watchlistId}` | bearer | |
| `POST SaveSearches/GetSaveSearches` | bearer | |
| `GET ItemBid/ShowBidModal?itemId=`, `POST ItemBid/PlaceBid` | bearer | Stubs until T-88: PlaceBid returns `{status:false, result:-3, message}`. A request carrying a `Bid` cookie gets 403. |
| `POST SignIn/RefreshToken`, `POST SignIn/RevokeToken` | none / bearer | RefreshToken mints a token with `tokenLifetimeMs`; refresh token `"revoked"` gives 401. |

Bearer tokens are HS256 JWTs (claims `BuyerId`, `IpAddress`, `Browser`, `iat`, `exp`). Missing, bad-signature or expired (against the server clock, skew included) is 401. There is no login endpoint; mint tokens with `POST /__token` or `sgw.mintToken()`.

Unknown path is 404, wrong method 405. CORS reflects the request origin.

## Control plane

- `POST /__scenario` with a patch, `GET /__scenario` for the current state. Fields (all optional): `name` (preset, resets first), `reset`, `skewMs`, `serverNowMs`, `latencyMs`, `errors`, `tokenLifetimeMs`, `bidSetsCookie`. For `latencyMs` and `errors`, keys are endpoint names (`Search/ItemListing`, case-insensitive) or `*`; a `null` value removes a key.
- `POST /__token {expiresInMs?, buyerId?}` mints a valid bearer.
- `GET /__log` returns `{entries}`; `DELETE /__log` clears. Each entry has `seq, method, path, query, endpoint, status, receivedAtMs, fakeNowMs, requestTimeMs, hasBearer, body`. `fakeNowMs` is parsed from the `x-sbw-fake-now` header (epoch ms or ISO) and `requestTimeMs` prefers it (T-59). Control routes are not logged.

## Scenario list

| Preset (`name`) | Effect |
| --- | --- |
| `default` | No faults. |
| `skew-plus-5s` / `skew-minus-5s` | Server clock +/-5 s (`serverTime`, `GetCurrentTime`, closing, token expiry). |
| `slow` | 1500 ms latency on every endpoint. |
| `rate-limited` | Every endpoint 429 with `Retry-After: 30`. |
| `server-error` | Every endpoint 503. |
| `blocked` | Every endpoint 403. |
| `short-token` | Tokens last 60 s. |
| `bid-cookie` | PlaceBid sets `Bid=1`; sending it back gets 403. |

Primitives: `skewMs`; `serverNowMs` (pin the server clock, it then ticks); `latencyMs: {"<endpoint>|*": ms}`; `errors: {"<endpoint>|*": {status, times?, retryAfterSec?}}` (`times` fails N requests, then recovers); `tokenLifetimeMs`; `bidSetsCookie`.

## Seed data

`seed/**/*.json`, read by `seed/loader.ts`: `items*.json` (`SeedItem`: fixed naive-PT `endTime` with optional fractional seconds, or `endsInMs` relative to server start), `favorites.json`, `saved-searches.json`. Hand-written samples (including a DST fall-back ambiguity item and a closed item); T-24 re-seeds from the Task 0 fixtures. Fixed end times are in Oct 2026, so tests that need open auctions should pin the clock with `serverNowMs`.

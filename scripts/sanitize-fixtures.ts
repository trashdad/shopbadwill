// S-1 (T-07) fixture sanitizer: raw SGW captures -> committed fixtures.
//
// PLAN §7.2 rules plus the T-07 fix-round-1 rulings, all deterministic for a
// given salt:
//   - titles      -> lorem of the same length (same title -> same lorem),
//                    learned from JSON title fields, card links and the item
//                    page <h1>, and replaced in <title> and meta tags too
//   - sellers     -> every field that identifies a seller gets a synthetic
//                    stand-in: the name and its variants ("Goodwill of <L>";
//                    the core name, e.g. "Lower Examplia", -> "<L>"), the
//                    landing-page slug and city ("Town<XY>", in JSON and
//                    hrefs), the street ("<n> Sample St"), the ZIP ("000nn")
//                    and any phone number ("555-555-01nn"). pickupState stays.
//   - bidder masks-> "b****r"
//   - image URLs  -> https://img.test/<hash>.jpg
//   - item ids    -> stable salted hash (9 digits), consistent across JSON,
//                    HTML and URLs; private ids (buyer, watchlist, address,
//                    bid log...) are remapped too (0 = "none" is kept), and
//                    5+ digit ones also inside HTML and free text
//   - secrets     -> every Authorization / Cookie / Set-Cookie / x-azure-ref
//                    header and every JWT-shaped string is removed; tokens,
//                    passwords and the signed-in buyer's personal and
//                    location fields are redacted; saved shipping addresses
//                    in the item page's shipping tab become "[redacted address]"
//   - the user    -> strings listed in raw/user/redact.txt (the user's own
//                    name, username, email, street, city, ZIP, phone; USER
//                    STEP S-1) become "[redacted]" wherever they appear
//   - HTML        -> <script>, <noscript>, <iframe>, <object>, <embed>,
//                    <style> and resource <link>s are dropped, inline event
//                    handlers and javascript: URLs removed. `_ngcontent-*`
//                    attributes are kept (tests must not select on them).
//
// The salt is a local secret (raw/.salt, git-ignored), so remapped ids cannot
// be brute-forced back to real listings.
//
// CLI: `pnpm exec tsx scripts/sanitize-fixtures.ts` first learns from EVERY
// raw input, then sanitizes each source in test/fixtures/sgw/sources.json into
// test/fixtures/sgw/{json,html}/ and writes manifest.json and request-log.json.
// It writes nothing if any original title, seller name, core name, place,
// street, ZIP, phone number (any layout; learned ones digit by digit), item or
// private id, image URL, JWT, secret header or address option survives in the
// output or in sources.json. It also refuses to start (fail closed) when an
// item page has no ItemDetail JSON for the same item among the inputs (its
// seller would be unknown) or when user JSON carries an id key that is in
// neither PRIVATE_ID_KEYS nor PUBLIC_ID_KEYS.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { readRequestLog } from './capture-fixtures';

export const SANITIZER_VERSION = '1.6.0';
export const IMG_BASE = 'https://img.test/';
export const BIDDER_MASK = 'b****r';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const JWT_FULL = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_EMBEDDED = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** JWT-shaped: three base64url segments (PLAN §7.2 regex), and either a JSON header (`eyJ`) or long segments. */
export function isJwtLike(s: string): boolean {
  if (!JWT_FULL.test(s)) return false;
  if (s.startsWith('eyJ')) return true;
  return s.split('.').every((seg) => seg.length >= 16);
}

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna ' +
  'aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute ' +
  'irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident'
).split(' ');

/** Deterministic lorem ipsum of exactly `length` characters (letters and single spaces). */
export function loremOfLength(seed: string, length: number): string {
  if (length <= 0) return '';
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  let out = '';
  while (out.length < length) out += (out === '' ? '' : ' ') + (LOREM[next() % LOREM.length] ?? 'lorem');
  out = out.slice(0, length);
  if (out.endsWith(' ')) out = `${out.slice(0, -1)}a`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ---------------------------------------------------------------------------
// Key rules (case-insensitive). Extend here when a capture shows a new field.
// ---------------------------------------------------------------------------

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-azure-ref|x-azure-ref-originshield)$/i;
const TOKEN_KEYS = /^(accesstoken|refreshtoken|token|idtoken|bearer|password|encryptedpassword|encryptedusername|username|login|buyerlogin|authenticatedbuyerlogin|clientipaddress|clientip|ipaddress|serverip|bidipaddress)$/i;
/** The signed-in buyer's own details. Seller location fields are handled by the seller-identity rules instead. */
const PII_KEYS = /^(buyer|shipping|billing|user|customer)?(email|emailaddress|firstname|lastname|fullname|phone|phonenumber|mobile|address|address1|address2|streetaddress|street|city)$/i;
/** The buyer's own region (CalculateShipping sends `province`). Seller `pickupState` is kept: the location rule needs it. */
const BUYER_LOCATION_KEYS = /^(buyerstate|buyercountry|buyercountrycode|buyerprovince|province|shippingstate|shippingcountry|billingstate|billingcountry)$/i;
const BUYER_NAME_KEYS = /^(buyer|user|customer)name$/i;
const ZIP_KEYS = /^(buyer|shipping|billing|user|customer)?(zip|zipcode|postalcode|postal)$/i;
/** Whole values (any shape) that only ever hold the buyer's own addresses. */
const PII_CONTAINER_KEYS = /^(buyershippingaddresses|buyeraddresses|buyeraddress|shippingaddresses|billingaddress|buyershippingaddress)$/i;
/** The user's own favorite notes: replaced with lorem of the same length (the length is S-1 evidence). */
const NOTE_KEYS = /^(notes|note)$/i;
const TITLE_KEYS = /^(title|itemtitle|listingtitle)$/i;
const SELLER_NAME_KEYS = /^(sellername|sellercompanyname|companyname|sellerdisplayname|storename)$/i;
/** The seller's landing-page slug (`/Samplton`): it is the seller's city. */
const SELLER_SLUG_KEYS = /^(sellerlandingpagename|landingpagename)$/i;
/** Seller location fields, read only inside an object that describes a seller (`isSellerObject`). */
const SELLER_STREET_KEYS = /^(pickupstreet|pickupaddress|street|address|address1)$/i;
const SELLER_CITY_KEYS = /^(pickupcity|city)$/i;
const SELLER_ZIP_KEYS = /^(pickupzip|zip|zipcode|postalcode)$/i;
const SELLER_PHONE_KEYS = /^(pickuphours|pickupphone|phone|phonenumber|sellerphone)$/i;
const BIDDER_KEYS = /^(biddername|bidder|bidderalias|highbiddername|highbidder)$/i;
const ITEM_ID_KEYS = /^(itemid|relistid|relisteditemid|parentitemid|originalitemid)$/i;
const ITEM_ID_LIST_KEYS = /itemids$/i;
/** Remapped when > 0; 0 means "none" and is kept (e.g. the search body's savedSearchId). */
const PRIVATE_ID_KEYS = /^(buyerid|userid|memberid|customerid|accountid|watchlistid|savedsearchid|searchid|bidid|orderid|cartid|sessionid|shippingaddressid|addressid|bidlogid|bidhistoryid)$/i;
/** Private ids this large are also remapped inside free text and HTML; smaller ones would hit prices and counts. */
const PRIVATE_ID_TEXT_MIN = 10_000;
const IMAGE_KEYS = /(image|thumbnail|photo|picture|filepath)/i;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?[^\s"'<>]*)?$/i;
// Backslashes are allowed: SGW image URLs contain Windows-style path separators.
const URL_IN_TEXT = /https?:\/\/[^\s"'<>;,()]+/g;
const MASK = /(?<![\w*])[A-Za-z0-9]\*{2,}[A-Za-z0-9](?![\w*])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * US phone numbers in the common layouts: 503-555-0199, (503) 555-0199,
 * 503.555.0199, 503 555 0199, 1-503-555-0199, +1 503 555 0199, and a bare
 * 10-digit NANP number (area code and exchange start 2-9, so epoch seconds,
 * dates and 9-digit item ids never match). Learned numbers are also found
 * digit by digit in any layout (learnedPhoneRe).
 */
const PHONE = /(?<![\d-])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?![\d-])|(?<![\d-])[2-9]\d{2}[2-9]\d{6}(?![\d-])/g;
const SYNTHETIC_PHONE = /^555-555-01\d\d$/;
/** Keys that hold the buyer's or seller's own phone number anywhere in a reply. */
const PHONE_KEYS = /(phone|mobile)/i;
/** Ids that are public catalogue or structure data (observed in S-1), plus money fields that merely end in "id". */
const PUBLIC_ID_KEYS = /^(sellerid|categoryid|parentid|parentcatid|mappedcatid|categorydisplaymapid|relatedblockid|bannerimageid|gwbbookcatid|traceid|minimumbid|maxbid|itemimageid)$/i;
/** Inside the buyer's own address records (PII containers): every value under these keys is learned and scrubbed everywhere. */
const PERSONAL_RECORD_KEYS = /^(address\d?|street\w*|city|name|firstname|lastname|fullname|zip\w*|postal\w*)$/i;
/** The signed-in buyer's login, wherever a reply carries it. */
const LOGIN_KEYS = /^(authenticatedbuyerlogin|username|buyerlogin|login)$/i;
/** The buyer's saved shipping addresses on the logged-in item page (S-1 stage 2). */
const HTML_SAVED_ADDRESS_SELECT = 'select#buyerAddress';
/** A shipping quote's destination line ("<p>Address:   97701-0005 US</p>") is always the buyer's. */
const QUOTE_ADDRESS_LINE = /(Address:\s*)([^<]+)(<\/p>)/gi;
/** Item ids inside strings; `/Item/` (og:url, recommendation links) and `/item/` both occur. */
const ID_PATTERNS = [/\/item\/(\d{5,})/gi, /GetItemDetailModelByItemId\/(\d{5,})/gi, /[?&]itemId=(\d{5,})/gi];
/** Seller ids inside URLs (the item page's own seller calls). */
const SELLER_ID_IN_URL = /(GetSellerInfo\/|[?&]sellerId=)(\d+)/gi;
const IMAGE_HOST_HINT = /(shopgoodwillimages|azureedge\.net|blob\.core\.windows\.net|images?\.shopgoodwill)/i;
const STREET_SUFFIX = /\s+(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|ct|court|pl|place|ter|terrace|cir|circle)\.?$/i;
/** An <option> whose text holds a US ZIP: a saved address that escaped the shipping-tab rule. */
const ADDRESS_OPTION = /<option\b[^>]*>[^<]*(?<!\d)\d{5}(?:-\d{4})?(?!\d)[^<]*<\/option>/i;

/** DOM places that hold a listing title (cards, item page). Selector strings only; extended from observed DOM. */
export const HTML_TITLE_SELECTORS: readonly string[] = ['a.feat-item_name', 'app-detail h1[id]'];
/** Elements whose `id` attribute is an item id. */
const HTML_ITEM_ID_SELECTORS: readonly string[] = ['a.feat-item_name[id]', 'app-detail h1[id]'];
/** Saved shipping addresses render as options in the item page's shipping tab; the country list is kept. */
const HTML_ADDRESS_OPTIONS = 'app-shipping-tab option';
const HTML_COUNTRY_SELECT = 'select#country';
export const REDACTED_ADDRESS = '[redacted address]';
/** The signed-in header greeting ("Hello, <first name>") sits next to this icon, desktop and mobile. */
const HTML_GREETING_ICON = '.pi-user';
/** What a greeting may read after sanitizing (logged out: "Sign In"). */
const GREETING_OK = /^(sign\s*in|(?:hello|hi|welcome(?: back)?), \[redacted\]|\[redacted\])$/i;
/** A header text that opens with a greeting word ("Hello Zelda", "Welcome back, Zelda!", "Hi Zelda"). */
const GREETING_START = /^(\s*)(hello|hi|welcome(?:\s+back)?)\b[\s,!]*(.*)$/i;
/** Where header greetings live. */
const HTML_HEADER = 'app-header, header';
/** "Hello, <name>" that escaped redaction, anywhere in an output. */
const GREETING_LEAK = /\b(?:Hello|Welcome back),\s+(?!\[redacted\])[A-Za-z]/i;

/** The personalized "You may also like" block reflects the user's browsing: dropped from every page. */
const HTML_DROP = '#related-recs';
/** Listing cards and the item gallery: their image alts are titles. */
const HTML_CARD_ROOTS = 'app-home-product-items, .feat-item';
const HTML_GALLERY = 'app-image-gallery, ngx-gallery';
/** Site chrome img alts (lowercased), observed in S-1; any other alt of 8+ characters must not survive verbatim. */
const UI_ALTS = new Set([
  'add to favorites',
  'shopgoodwill logo',
  'goodwill logo',
  'goodwillbooks logo',
  'google play store',
  'apple app store',
  'follow us on youtube',
  'follow us on instagram',
  'follow us on facebook',
  'iiq_pixel',
  'resupply donating pickup scheduling',
  'do some good with something great. shop for the good. every purchase helps others find jobs',
]);

/** A standalone 6+-digit number: not part of a word, a decimal fraction (SVG paths) or a hex color. */
export const RAW_NUMBER = /(?<![A-Za-z0-9.#])\d{6,}(?![A-Za-z0-9])/g;
/** Site-wide public constants that may survive verbatim (S-1 captures). */
export const KNOWN_PUBLIC_NUMBERS: ReadonlySet<string> = new Set([
  '999999', // the search default highPrice
  '381591958529152', // ShopGoodwill's Facebook app id (meta fb:app_id)
  '21793929039', // the site's Google Ad Manager network code (ad slot ids)
  '118512004', // the App Store provider token in the app badge link (pt=)
]);

/** Extra privacy for the user's own lists (sources.json `privacy`). */
export type PrivacyOption = 'shiftTimes' | 'topCategory';

/** Lowercase, "&amp;" and every non-alphanumeric run as one space: how a title compares to its uppercase-pipe or entity-encoded copies. */
/**
 * Punctuation DELETED (the site's alt text drops / . - ' with no space: "A/B" -> "AB"). Quotes and
 * <>= become spaces first, so attribute syntax around a value cannot fuse into its first word.
 */
function normTitleDel(s: string): string {
  return decodeEntities(s).toLowerCase().replace(/["<>=]/g, ' ').replace(/[^a-z0-9\s]+/g, '').replace(/\s+/g, ' ').trim();
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Shifts a naive "YYYY-MM-DDTHH:MM:SS(.f)" by whole days, keeping the wall time and the fraction as written. */
function shiftNaiveDays(raw: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(raw);
  if (m === null) return raw;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) + days * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${m[7] ?? ''}`;
}

/** "Goodwill Industries of Lower Examplia" -> "Lower Examplia"; "Goodwill Examplia Area - Samplton" -> "Examplia Area". */
export function sellerCoreName(name: string): string | null {
  const head = name.split(/\s+-\s+/)[0] ?? name;
  const core = head
    .replace(/\b(goodwill|industries|industry|inc|incorporated|llc|of|the|and)\b\.?/gi, ' ')
    .replace(/[&,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return core.length >= 4 ? core : null;
}

const digitsOf = (s: string): string => s.replace(/\D/g, '');

/** Text boundaries for whole-word matches (letters and digits on either side mean "inside a word"). */
const wordRe = (s: string, flags: string): RegExp => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(s)}(?![A-Za-z0-9])`, flags);

export interface SanitizerOptions {
  salt: string;
  /**
   * The user's own name, username, email, street, city, ZIP, phone... for
   * USER STEP captures, read from the git-ignored raw/user/redact.txt.
   * Replaced case-insensitively with "[redacted]" everywhere; entries shorter
   * than 3 characters are ignored.
   */
  redact?: readonly string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

type IdentityKind = 'seller' | 'core' | 'place' | 'street' | 'zip' | 'personal';
interface IdentityRule {
  kind: IdentityKind;
  orig: string;
  rep: string;
  re: RegExp;
}

function isSellerObject(obj: JsonObject, parentKey: string): boolean {
  if (/^seller$/i.test(parentKey)) return true;
  return Object.entries(obj).some(
    ([k, v]) => typeof v === 'string' && v.trim() !== '' && (SELLER_NAME_KEYS.test(k) || SELLER_SLUG_KEYS.test(k) || /^pickup(street|city|zip)$/i.test(k)),
  );
}

/**
 * ASP.NET Core ProblemDetails: its `title` is an error message, not a listing
 * title. Needs a numeric status, a string title AND a real marker: an `errors`
 * object, a `type` URI, or a `traceId`.
 */
function isProblemDetails(obj: JsonObject): boolean {
  if (typeof obj.status !== 'number' || typeof obj.title !== 'string') return false;
  const errors = obj.errors;
  return (errors !== null && typeof errors === 'object') || (typeof obj.type === 'string' && /^https?:/i.test(obj.type)) || 'traceId' in obj;
}

/** A 10-digit NANP number (a leading country code 1 dropped), or null. */
function phoneDigits(s: string): string | null {
  const d = digitsOf(s);
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null;
}

/** Matches a learned number digit by digit, whatever separators sit between the digits. */
function learnedPhoneRe(ten: string, flags: string): RegExp {
  const sep = String.raw`[\s.()/-]*`;
  return new RegExp(String.raw`(?<!\d)(?:\+?1${sep})?${ten.split('').join(sep)}(?!\d)`, flags);
}

/**
 * Keys ending in "id" (case-insensitive) that are neither remapped (private,
 * item) nor known public: user captures must not carry an unreviewed id.
 * Returns each such key once, in first-seen order.
 */
export function unclassifiedIdKeys(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/id$/i.test(k) && !PRIVATE_ID_KEYS.test(k) && !ITEM_ID_KEYS.test(k) && !PUBLIC_ID_KEYS.test(k) && !found.includes(k)) found.push(k);
      walk(x);
    }
  };
  walk(value);
  return found;
}

/** Parses HTML with scripts, styles, frames and navigation disabled. */
function parseHtmlDocument(html: string) {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  });
  const doc = new window.DOMParser().parseFromString(html, 'text/html');
  return {
    doc,
    close: (): void => {
      void window.happyDOM.close();
    },
  };
}
type HtmlDoc = ReturnType<typeof parseHtmlDocument>['doc'];

export class FixtureSanitizer {
  private readonly salt: string;
  private readonly itemIds = new Map<number, number>();
  private readonly itemIdTargets = new Set<number>();
  private readonly privateIds = new Map<string, Map<number, number>>();
  private readonly privateTargets = new Set<string>();
  /** Large private ids (any namespace) -> mapped, for free text and HTML. */
  private readonly privateTextIds = new Map<number, number>();
  private readonly privateTextTargets = new Set<number>();
  private readonly titles = new Map<string, string>();
  private readonly sellerTargets = new Set<string>();
  /** Seller-identifying strings keyed by kind + lowercased original. */
  private readonly identity = new Map<string, IdentityRule>();
  private readonly identityTargets = new Set<string>();
  private identityRules: IdentityRule[] | null = null;
  private readonly images = new Map<string, string>();
  /** Every original replaced, for the build-time leak check. */
  readonly originals = {
    titles: new Set<string>(),
    sellers: new Set<string>(),
    itemIds: new Set<number>(),
    phones: new Set<string>(),
    privateIds: new Set<number>(),
  };

  private readonly redactions: ReadonlyArray<{ value: string; re: RegExp }>;
  /** Every 3+-letter word of a digit-free redact.txt line (a first name alone, say), matched as a whole word. */
  private readonly redactWords: ReadonlyArray<{ value: string; re: RegExp }>;
  private titleCache: Array<{ orig: string; lower: string; norm: string; del: string; rep: string; re: RegExp }> | null = null;
  /** Remapped seller ids (guards against mapping a stand-in twice). */
  private readonly sellerIdTargets = new Set<number>();
  /** Every synthetic number handed out (item and private ids), for the raw-number check. */
  private readonly syntheticNumbers = new Set<number>();
  /** Items whose ItemDetail-shaped JSON (seller name plus location) was learned: their item pages can be scrubbed. */
  private readonly itemsWithDetail = new Set<number>();
  private readonly phoneRules: Array<{ ten: string; re: RegExp }> = [];
  /** File being sanitized, for error messages. */
  private where = '(input)';

  constructor(opts: SanitizerOptions) {
    this.salt = opts.salt;
    this.redactions = (opts.redact ?? [])
      .map((v) => v.trim())
      .filter((v) => v.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map((value) => ({ value, re: new RegExp(escapeRegExp(value), 'gi') }));
    const lines = new Set(this.redactions.map((r) => r.value.toLowerCase()));
    const words = new Map<string, string>();
    for (const r of this.redactions) {
      if (/\d/.test(r.value)) continue;
      for (const w of r.value.match(/[A-Za-z]{3,}/g) ?? []) if (!lines.has(w.toLowerCase()) && !words.has(w.toLowerCase())) words.set(w.toLowerCase(), w);
    }
    this.redactWords = [...words.values()].sort((a, b) => b.length - a.length).map((value) => ({ value, re: wordRe(value, 'gi') }));
    // A phone number in redact.txt is matched digit by digit, in any layout.
    for (const r of this.redactions) {
      const ten = /^[\d\s().+-]+$/.test(r.value) ? phoneDigits(r.value) : null;
      if (ten !== null) this.learnPhone(ten);
    }
  }

  private learnPhone(ten: string): void {
    if (this.originals.phones.has(ten)) return;
    this.originals.phones.add(ten);
    this.phoneRules.push({ ten, re: learnedPhoneRe(ten, 'g') });
  }

  private titleRules(): Array<{ orig: string; lower: string; norm: string; del: string; rep: string; re: RegExp }> {
    this.titleCache ??= [...this.titles.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([orig, rep]) => ({ orig, lower: orig.toLowerCase(), norm: normTitle(orig), del: normTitleDel(orig), rep, re: new RegExp(escapeRegExp(orig), 'gi') }));
    return this.titleCache;
  }

  /** An attribute holding a learned title in another form (the uppercase pipe drops "&"): replaced whole. */
  private replaceTitleLike(v: string): string {
    const nv = ` ${normTitle(v)} `;
    const nd = ` ${normTitleDel(v)} `;
    if (nv.length < 10 && nd.length < 10) return v;
    for (const t of this.titleRules()) {
      const spaced = t.norm.length >= 8 && (nv.includes(` ${t.norm} `) || nd.includes(` ${t.norm} `));
      const deleted = t.del.length >= 8 && (nd.includes(` ${t.del} `) || nv.includes(` ${t.del} `));
      if (spaced || deleted) {
        const lorem = loremOfLength(`${this.salt}:title:${t.orig}`, v.length);
        return v === v.toUpperCase() ? lorem.toUpperCase() : lorem;
      }
    }
    return v;
  }

  /**
   * Extra privacy for the user's own lists (favorites), applied after sanitizing:
   * - shiftTimes: startTime/endTime move by one salted whole-day constant (order and durations kept);
   * - topCategory: catFullName keeps only its top level ("Clothing > Shoes > Size 12" -> "Clothing");
   */
  applyPrivacy<T>(value: T, opts: readonly PrivacyOption[]): T {
    const shiftDays = 30 + (this.hmac('time-shift', 'favorites').readUInt32BE(0) % 335);
    const walk = (v: Json, key: string): Json => {
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      if (v !== null && typeof v === 'object') {
        const out: JsonObject = {};
        for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
        return out;
      }
      if (typeof v === 'string' && opts.includes('shiftTimes') && /^(starttime|endtime)$/i.test(key)) return shiftNaiveDays(v, shiftDays);
      if (typeof v === 'string' && opts.includes('topCategory') && /^catfullname$/i.test(key)) return (v.split('>')[0] ?? v).trim();
      return v;
    };
    return walk(value as unknown as Json, '') as unknown as T;
  }

  /** True once ItemDetail-shaped JSON (seller name and location) for this item was learned. */
  hasItemDetailFor(itemId: number): boolean {
    return this.itemsWithDetail.has(itemId);
  }

  /** Whether the page is an item page (app-detail) and, if so, its item id (h1[id], canonical link or og:url). */
  itemPage(html: string): { isItemPage: boolean; itemId: number | null } {
    const { doc, close } = parseHtmlDocument(html);
    try {
      if (doc.querySelector('app-detail') === null) return { isItemPage: false, itemId: null };
      const candidates = [
        doc.querySelector('app-detail h1[id]')?.getAttribute('id') ?? '',
        doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
        doc.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? '',
      ];
      for (const c of candidates) {
        const m = /^(\d{5,})$/.exec(c) ?? /\/item\/(\d{5,})/.exec(c);
        if (m?.[1] !== undefined) return { isItemPage: true, itemId: Number(m[1]) };
      }
      return { isItemPage: true, itemId: null };
    } finally {
      close();
    }
  }

  private hmac(ns: string, value: string): Buffer {
    return createHmac('sha256', this.salt).update(`${ns}:${value}`).digest();
  }

  remapItemId(id: number): number {
    const known = this.itemIds.get(id);
    if (known !== undefined) return known;
    let n = 100_000_000 + (this.hmac('item', String(id)).readUInt32BE(0) % 900_000_000);
    while (this.itemIdTargets.has(n) || this.itemIds.has(n)) n = n >= 999_999_999 ? 100_000_000 : n + 1;
    this.itemIds.set(id, n);
    this.itemIdTargets.add(n);
    this.syntheticNumbers.add(n);
    this.originals.itemIds.add(id);
    return n;
  }

  /** A seller id gets one salted stand-in, the same in every fixture (JSON keys, id lists, URLs). */
  remapSellerId(id: number): number {
    if (id <= 0 || this.sellerIdTargets.has(id)) return id;
    const n = this.remapPrivateId('sellerid', id);
    this.sellerIdTargets.add(n);
    return n;
  }

  /** True for a number the sanitizer handed out as a stand-in (so it is not a raw leak). */
  isSyntheticNumber(n: number): boolean {
    return this.syntheticNumbers.has(n);
  }

  private remapPrivateId(ns: string, id: number): number {
    if (id <= 0) return id; // 0 / -1 mean "none"
    let map = this.privateIds.get(ns);
    if (map === undefined) {
      map = new Map();
      this.privateIds.set(ns, map);
    }
    const known = map.get(id);
    if (known !== undefined) return known;
    let n = 100_000 + (this.hmac(`private-${ns}`, String(id)).readUInt32BE(0) % 900_000);
    while (this.privateTargets.has(`${ns}:${String(n)}`)) n++;
    map.set(id, n);
    this.privateTargets.add(`${ns}:${String(n)}`);
    this.syntheticNumbers.add(n);
    if (id >= PRIVATE_ID_TEXT_MIN && !this.privateTextIds.has(id)) {
      this.privateTextIds.set(id, n);
      this.privateTextTargets.add(n);
      this.originals.privateIds.add(id);
    }
    return n;
  }

  private learnTitle(raw: string): void {
    const t = raw.trim();
    if (t.length < 3 || this.titles.has(t) || [...this.titles.values()].includes(t)) return;
    const lorem = loremOfLength(`${this.salt}:title:${t}`, t.length);
    this.titleCache = null;
    this.titles.set(t, lorem);
    this.originals.titles.add(t);
    const decoded = decodeEntities(t);
    if (decoded !== t && !this.titles.has(decoded)) this.titles.set(decoded, loremOfLength(`${this.salt}:title:${t}`, decoded.length));
    const collapsed = t.replace(/\s+/g, ' ');
    if (collapsed !== t && !this.titles.has(collapsed)) this.titles.set(collapsed, loremOfLength(`${this.salt}:title:${t}`, collapsed.length));
    const encoded = encodeEntities(t);
    if (encoded !== t && !this.titles.has(encoded)) this.titles.set(encoded, loremOfLength(`${this.salt}:title:${t}`, encoded.length));
  }

  // ---- seller identity ----------------------------------------------------

  private addIdentity(kind: IdentityKind, orig: string, rep: string): void {
    const key = `${kind}:${orig.toLowerCase()}`;
    if (this.identity.has(key) || this.identityTargets.has(orig.toLowerCase())) return;
    const digitsOnly = /^\d{5}(-\d{4})?$/.test(orig);
    const re = kind === 'seller' ? new RegExp(escapeRegExp(orig), 'gi') : kind === 'zip' || digitsOnly ? new RegExp(`(?<!\\d)${escapeRegExp(orig)}(?!\\d)`, 'g') : wordRe(orig, 'gi');
    this.identity.set(key, { kind, orig, rep, re });
    this.identityTargets.add(rep.toLowerCase());
    this.identityRules = null;
  }

  private identityOf(kind: IdentityKind, orig: string): string | undefined {
    return this.identity.get(`${kind}:${orig.toLowerCase()}`)?.rep;
  }

  /** A synthetic value of the given shape that no earlier original or replacement uses. */
  private pickSynthetic(ns: string, orig: string, make: (h: number, attempt: number) => string): string {
    const h = this.hmac(ns, orig.toLowerCase()).readUInt32BE(0);
    for (let attempt = 0; ; attempt++) {
      const candidate = make(h, attempt);
      if (!this.identityTargets.has(candidate.toLowerCase()) && !this.identity.has(`place:${candidate.toLowerCase()}`)) return candidate;
    }
  }

  private learnSeller(raw: string): void {
    const name = raw.trim();
    if (name.length < 2 || this.sellerTargets.has(name) || this.identityOf('seller', name) !== undefined) return;
    const letter = String.fromCharCode(65 + ((this.hmac('seller', name)[0] ?? 0) % 26));
    let candidate = `Goodwill of ${letter}`;
    for (let i = 2; this.sellerTargets.has(candidate); i++) candidate = `Goodwill of ${letter}${String(i)}`;
    const tag = candidate.slice('Goodwill of '.length);
    this.sellerTargets.add(candidate);
    this.originals.sellers.add(name);
    this.addIdentity('seller', name, candidate);
    const decoded = decodeEntities(name);
    if (decoded !== name) this.addIdentity('seller', decoded, candidate);
    const encoded = encodeEntities(name);
    if (encoded !== name) this.addIdentity('seller', encoded, candidate);
    // "Goodwill of Lower Examplia" -> "Goodwill of <tag>", the synthetic name itself.
    const core = sellerCoreName(name);
    if (core !== null) this.addIdentity('core', core, tag);
    const suffix = name.split(/\s+-\s+/)[1];
    if (suffix !== undefined) this.learnPlace(suffix);
  }

  /** A seller's city or landing-page slug (they are the same string on SGW). */
  private learnPlace(raw: string): void {
    const place = raw.trim();
    if (place.length < 3 || this.identityOf('place', place) !== undefined || this.identityTargets.has(place.toLowerCase())) return;
    const rep = this.pickSynthetic('place', place, (h, a) => `Town${String.fromCharCode(65 + (h % 26))}${String.fromCharCode(65 + ((h >>> 8) % 26))}${a === 0 ? '' : String(a)}`);
    this.addIdentity('place', place, rep);
  }

  private learnStreet(raw: string): void {
    const street = raw.trim().replace(/\s+/g, ' ');
    if (street.length < 5 || this.identityOf('street', street) !== undefined || this.identityTargets.has(street.toLowerCase())) return;
    const base = street.replace(STREET_SUFFIX, '');
    // A suffix-less street ("42 N. Fictional") that is the base of a known one keeps that one's number.
    for (const rule of this.identity.values()) {
      if (rule.kind === 'street' && rule.orig.replace(STREET_SUFFIX, '').toLowerCase() === base.toLowerCase()) {
        this.addIdentity('street', street, base === street ? rule.rep.replace(/ St$/, '') : rule.rep);
        return;
      }
    }
    const rep = this.pickSynthetic('street', street, (h, a) => `${String(100 + ((h + a) % 900))} Sample St`);
    this.addIdentity('street', street, rep);
    if (base !== street && base.length >= 5) this.addIdentity('street', base, rep.replace(/ St$/, ''));
  }

  private learnZip(raw: string): void {
    const m = /^(\d{5})(?:-(\d{4}))?$/.exec(raw.trim());
    if (m === null) return;
    const base = m[1] ?? '';
    let rep = this.identityOf('zip', base);
    if (rep === undefined) {
      rep = this.pickSynthetic('zip', base, (h, a) => `000${String((h + a) % 100).padStart(2, '0')}`);
      this.addIdentity('zip', base, rep);
    }
    if (m[2] !== undefined) this.addIdentity('zip', `${base}-${m[2]}`, `${rep}-0000`);
  }

  private learnSellerFields(obj: JsonObject, parentKey: string): void {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string' || v.trim() === '') continue;
      if (SELLER_NAME_KEYS.test(k) || (/^seller$/i.test(parentKey) && /^name$/i.test(k))) this.learnSeller(v);
      else if (SELLER_SLUG_KEYS.test(k)) this.learnPlace(v);
      else if (SELLER_CITY_KEYS.test(k)) this.learnPlace(v.split(/[(,]/)[0] ?? '');
      else if (SELLER_STREET_KEYS.test(k)) this.learnStreet(v);
      else if (SELLER_ZIP_KEYS.test(k)) this.learnZip(v);
      if (SELLER_PHONE_KEYS.test(k)) {
        for (const p of v.matchAll(PHONE)) {
          const ten = phoneDigits(p[0]);
          if (ten !== null) this.learnPhone(ten);
        }
      }
    }
  }

  private rules(): IdentityRule[] {
    this.identityRules ??= [...this.identity.values()].sort((a, b) => b.orig.length - a.orig.length || a.orig.localeCompare(b.orig));
    return this.identityRules;
  }

  private syntheticPhone(phone: string): string {
    if (SYNTHETIC_PHONE.test(phone)) return phone;
    return `555-555-01${String(this.hmac('phone', digitsOf(phone)).readUInt32BE(0) % 100).padStart(2, '0')}`;
  }

  // ---- strings --------------------------------------------------------------

  private learnIdsInString(s: string): void {
    for (const re of ID_PATTERNS) {
      for (const m of s.matchAll(re)) {
        const id = Number(m[1]);
        if (Number.isSafeInteger(id) && !this.itemIdTargets.has(id)) this.remapItemId(id);
      }
    }
  }

  replaceImageUrl(url: string): string {
    if (url.startsWith(IMG_BASE)) return url;
    const known = this.images.get(url);
    if (known !== undefined) return known;
    const out = `${IMG_BASE}${this.hmac('image', url).toString('hex').slice(0, 16)}.jpg`;
    this.images.set(url, out);
    return out;
  }

  /** Applied to every string in JSON and to every text node and attribute value in HTML. `at` names the key or attribute. */
  private scrubString(input: string, at = '(text)'): string {
    if (isJwtLike(input)) return '[redacted-jwt]';
    let s = input.replace(JWT_EMBEDDED, '[redacted-jwt]');
    s = s.replace(EMAIL, 'user@example.test');
    s = s.replace(QUOTE_ADDRESS_LINE, `$1${REDACTED_ADDRESS}$3`);
    s = s.replace(URL_IN_TEXT, (u) => {
      if (u.startsWith(IMG_BASE)) return u;
      if (IMAGE_EXT.test(u)) return this.replaceImageUrl(u);
      let host: string;
      try {
        host = new URL(u).hostname;
      } catch {
        throw new Error(`${this.where}: unparseable URL at ${at}: "${u.slice(0, 40)}"`);
      }
      return IMAGE_HOST_HINT.test(host) ? IMG_BASE : u;
    });
    // Titles, case-insensitively (Angular's uppercase pipe renders them in capitals; the stand-in follows suit).
    let lower = s.toLowerCase();
    for (const t of this.titleRules()) {
      if (t.orig.length < 8) {
        // Short titles ("Lot", "Lamp") are replaced only as a whole value, never inside other text.
        if (s.trim().toLowerCase() === t.lower) {
          s = s.replace(s.trim(), t.rep);
          lower = s.toLowerCase();
        }
      } else if (lower.includes(t.lower)) {
        s = s.replace(t.re, (m) => (m === m.toUpperCase() && m !== m.toLowerCase() ? t.rep.toUpperCase() : t.rep));
        lower = s.toLowerCase();
      }
    }
    for (const rule of this.rules()) s = s.replace(rule.re, rule.rep);
    // redact.txt last: learned identity keeps its synthetic stand-ins, the user's list catches the rest.
    for (const { re } of this.redactions) s = s.replace(re, '[redacted]');
    // Its single words too, except in class/id attributes and the whole-document pass, where they could hit markup;
    // findLeaks still checks every output for them, so a survivor fails the build.
    if (at !== '(document)' && !/ (class|id)>$/.test(at)) for (const { re } of this.redactWords) s = s.replace(re, '[redacted]');
    for (const { ten, re } of this.phoneRules) s = s.replace(re, () => this.syntheticPhone(ten));
    s = s.replace(PHONE, (p) => this.syntheticPhone(p));
    s = s.replace(MASK, BIDDER_MASK);
    s = s.replace(SELLER_ID_IN_URL, (_m, pre: string, d: string) => pre + String(this.remapSellerId(Number(d))));
    this.learnIdsInString(s);
    if (this.itemIds.size > 0 || this.privateTextIds.size > 0) {
      s = s.replace(/(?<!\d)\d{5,}(?!\d)/g, (m) => {
        const n = Number(m);
        if (this.itemIdTargets.has(n) || this.privateTextTargets.has(n)) return m;
        const mapped = this.itemIds.get(n) ?? this.privateTextIds.get(n);
        return mapped === undefined ? m : String(mapped);
      });
    }
    return s;
  }

  sanitizeUrl(url: string): string {
    return this.scrubString(url, 'url');
  }

  sanitizeHeaders<T extends Record<string, string> | Array<{ name: string; value: string }>>(headers: T): T {
    if (Array.isArray(headers)) return headers.filter((h) => !SECRET_HEADER.test(h.name)) as T;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!SECRET_HEADER.test(k)) out[k] = v;
    return out as T;
  }

  // ---- JSON ----------------------------------------------------------------

  /** The signed-in buyer's own street, city, name, ZIP or login: scrubbed wherever it appears. */
  private learnPersonal(raw: string): void {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (v.length < 3) return;
    const zip = /^(\d{5})(?:-\d{4})?$/.exec(v);
    if (zip !== null) {
      this.addIdentity('personal', zip[1] ?? v, '00000');
      if (v !== zip[1]) this.addIdentity('personal', v, '00000-0000');
      return;
    }
    this.addIdentity('personal', v, '[redacted]');
  }

  private learnJson(value: Json, key: string, inPersonal = false): void {
    if (typeof value === 'string') {
      if (TITLE_KEYS.test(key)) this.learnTitle(value);
      else if (ITEM_ID_KEYS.test(key) && /^\d{5,}$/.test(value)) this.remapItemId(Number(value));
      else if (PRIVATE_ID_KEYS.test(key) && /^\d+$/.test(value)) this.remapPrivateId(key.toLowerCase(), Number(value));
      this.learnIdsInString(value);
      return;
    }
    if (typeof value === 'number') {
      if ((ITEM_ID_KEYS.test(key) || ITEM_ID_LIST_KEYS.test(key)) && Number.isSafeInteger(value) && value > 0) this.remapItemId(value);
      else if (PRIVATE_ID_KEYS.test(key) && Number.isSafeInteger(value)) this.remapPrivateId(key.toLowerCase(), value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) this.learnJson(v, key, inPersonal);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const seller = isSellerObject(value, key);
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string') continue;
      // The buyer's own address records, buyer* fields outside a seller object, and the login.
      if ((inPersonal && PERSONAL_RECORD_KEYS.test(k)) || LOGIN_KEYS.test(k)) this.learnPersonal(v);
      else if (!seller && (PII_KEYS.test(k) || BUYER_NAME_KEYS.test(k) || ZIP_KEYS.test(k))) this.learnPersonal(v);
    }
    if (seller) {
      this.learnSellerFields(value, key);
      const id = Number(value.itemId);
      const hasLocation = ['sellerLandingPageName', 'pickupCity', 'pickupStreet'].some((k) => typeof value[k] === 'string');
      if (Number.isSafeInteger(id) && id > 0 && typeof value.sellerCompanyName === 'string' && hasLocation) this.itemsWithDetail.add(id);
    }
    // The buyer's or seller's own phone number under any phone-like key.
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && PHONE_KEYS.test(k)) {
        for (const p of v.matchAll(PHONE)) {
          const ten = phoneDigits(p[0]);
          if (ten !== null) this.learnPhone(ten);
        }
      }
    }
    const problem = isProblemDetails(value);
    for (const [k, v] of Object.entries(value)) this.learnJson(v, problem && /^title$/i.test(k) ? '' : k, inPersonal || PII_CONTAINER_KEYS.test(k));
  }

  /** Learns titles, seller identity and ids from a JSON value without producing output (build pre-pass). */
  learn(value: unknown): void {
    this.learnJson(value as Json, '');
  }

  private redactDeep(value: Json): Json {
    if (typeof value === 'string') return value === '' ? value : '[redacted]';
    if (typeof value === 'number') return 0;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v));
    if (value !== null && typeof value === 'object') {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v);
      return out;
    }
    return value;
  }

  private transformJson(value: Json, key: string, at: string, sellerCtx: boolean): Json | undefined {
    if (SECRET_HEADER.test(key)) return undefined;
    if (PII_CONTAINER_KEYS.test(key)) return this.redactDeep(value);
    if (typeof value === 'string') {
      if (TOKEN_KEYS.test(key)) return value === '' ? value : '[redacted]';
      if (sellerCtx && (SELLER_STREET_KEYS.test(key) || SELLER_CITY_KEYS.test(key) || SELLER_ZIP_KEYS.test(key))) {
        // Learned seller location -> its synthetic stand-in; anything not learned is dropped.
        const out = this.scrubString(value, at);
        return value.trim() === '' || out !== value ? out : '[redacted]';
      }
      if (PII_KEYS.test(key) || BUYER_NAME_KEYS.test(key) || BUYER_LOCATION_KEYS.test(key)) return value === '' ? value : '[redacted]';
      if (NOTE_KEYS.test(key)) return loremOfLength(`${this.salt}:note:${value}`, value.length);
      if (ZIP_KEYS.test(key)) return value === '' ? value : '00000';
      if (BIDDER_KEYS.test(key)) return value === '' ? value : BIDDER_MASK;
      if (/^sellerid$/i.test(key) && /^\d+$/.test(value)) return String(this.remapSellerId(Number(value)));
      if (/^selectedsellerids$/i.test(key)) return value.split(',').map((x) => (/^\s*\d+\s*$/.test(x) ? String(this.remapSellerId(Number(x))) : x)).join(',');
      if (PRIVATE_ID_KEYS.test(key) && /^\d+$/.test(value)) return String(this.remapPrivateId(key.toLowerCase(), Number(value)));
      if (IMAGE_KEYS.test(key)) {
        if (/^https?:\/\//i.test(value) && !IMAGE_EXT.test(value) && !value.includes(';')) return IMG_BASE;
        if (!/^https?:\/\//i.test(value) && IMAGE_EXT.test(value)) return `${this.hmac('image', value).toString('hex').slice(0, 16)}.jpg`;
      }
      return this.scrubString(value, at);
    }
    if (typeof value === 'number') {
      if (/^sellerid$/i.test(key) && Number.isSafeInteger(value)) return this.remapSellerId(value);
      if (PRIVATE_ID_KEYS.test(key) && Number.isSafeInteger(value)) return this.remapPrivateId(key.toLowerCase(), value);
      if (ZIP_KEYS.test(key)) return 0;
      if (Number.isSafeInteger(value) && this.itemIds.has(value) && !this.itemIdTargets.has(value)) return this.itemIds.get(value) ?? value;
      return value;
    }
    if (Array.isArray(value)) {
      const out: Json[] = [];
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && SECRET_HEADER.test(v.name)) return;
        const t = this.transformJson(v, key, `${at}[${String(i)}]`, sellerCtx);
        if (t !== undefined) out.push(t);
      });
      return out;
    }
    if (value !== null && typeof value === 'object') {
      const seller = isSellerObject(value, key);
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) {
        const t = this.transformJson(v, k, at === '' ? k : `${at}.${k}`, seller);
        if (t !== undefined) out[k] = t;
      }
      return out;
    }
    return value;
  }

  /** Sanitizes a parsed JSON value. Titles, sellers and ids it sees are remembered for later HTML. `where` names the file in errors. */
  sanitizeJson<T>(value: T, where = '(input)'): T {
    this.where = where;
    const json = value as unknown as Json;
    this.learnJson(json, '');
    return this.transformJson(json, '', '', false) as unknown as T;
  }

  // ---- HTML ----------------------------------------------------------------

  /** Learns titles and item ids that only the DOM knows about. */
  private learnFromDoc(doc: HtmlDoc): void {
    for (const sel of HTML_TITLE_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        const t = el.getAttribute('title');
        if (t !== null) this.learnTitle(t);
        this.learnTitle(el.textContent);
      }
    }
    for (const el of doc.querySelectorAll('[href]')) this.learnIdsInString(el.getAttribute('href') ?? '');
    // data-scarabitem and any other data-*item* attribute carries an item id.
    for (const el of doc.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        const v = a.value ?? '';
        if (/^data-[\w-]*item/i.test(a.name) && /^\d{5,}$/.test(v) && !this.itemIdTargets.has(Number(v))) this.remapItemId(Number(v));
      }
    }
    for (const sel of HTML_ITEM_ID_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        const id = el.getAttribute('id') ?? '';
        if (/^\d{5,}$/.test(id) && !this.itemIdTargets.has(Number(id))) this.remapItemId(Number(id));
      }
    }
  }

  /** Learns from a rendered page without producing output (build pre-pass). */
  learnHtml(html: string): void {
    const { doc, close } = parseHtmlDocument(html);
    try {
      this.learnFromDoc(doc);
    } finally {
      close();
    }
  }

  sanitizeHtml(html: string, where = '(input)'): string {
    this.where = where;
    const { doc, close } = parseHtmlDocument(html);
    try {
      for (const el of doc.querySelectorAll('script, noscript, iframe, object, embed, style, template[id*="ad" i]')) el.remove();
      for (const el of doc.querySelectorAll('link')) if ((el.getAttribute('rel') ?? '').toLowerCase() !== 'canonical') el.remove();
      for (const el of doc.querySelectorAll('meta[http-equiv]')) el.remove();
      for (const el of doc.querySelectorAll(HTML_DROP)) el.remove();
      // Every image alt of 8+ characters that is not site chrome: none may survive verbatim (checked at the end).
      const rawAlts = new Set<string>();
      for (const img of doc.querySelectorAll('img[alt]')) {
        const alt = (img.getAttribute('alt') ?? '').trim();
        if (alt.length >= 8 && !UI_ALTS.has(alt.toLowerCase())) rawAlts.add(alt);
      }
      // The buyer's saved shipping addresses (logged-in item page): never kept.
      for (const opt of doc.querySelectorAll(HTML_ADDRESS_OPTIONS)) {
        if (opt.closest(HTML_COUNTRY_SELECT) !== null) continue;
        const label = opt.textContent.trim();
        if (opt.closest(HTML_SAVED_ADDRESS_SELECT) !== null) {
          // The saved-address select: only an empty-valued, digit-free placeholder stays (a label like "Home" does not).
          if ((opt.getAttribute('value') ?? '') === '' && !/\d/.test(label)) continue;
        } else if (/^\d{1,4}$/.test(label) || !/\d/.test(label)) {
          // Other shipping-tab selects: quantities ("1", "10") and digit-free labels stay; an address always has a digit.
          continue;
        }
        opt.textContent = REDACTED_ADDRESS;
        for (const attr of ['value', 'label', 'title']) if (opt.hasAttribute(attr)) opt.setAttribute(attr, '');
      }

      // The signed-in header greeting ("Hello, <first name>") next to the user icon: always redacted.
      for (const icon of doc.querySelectorAll(HTML_GREETING_ICON)) {
        const box = icon.parentElement;
        if (box === null) continue;
        const label = box.textContent.replace(/\s+/g, ' ').trim();
        if (label === '' || /^sign\s*in$/i.test(label)) continue;
        const g = GREETING_START.exec(label);
        const replacement = g === null ? '[redacted]' : `${(g[2] ?? '').replace(/\s+/g, ' ')}, [redacted]`;
        const walkerG = doc.createTreeWalker(box, 0x4); // SHOW_TEXT
        const nodes: Array<NonNullable<ReturnType<typeof walkerG.nextNode>>> = [];
        for (let n = walkerG.nextNode(); n !== null; n = walkerG.nextNode()) nodes.push(n);
        let first = true;
        for (const n of nodes) {
          const v = n.nodeValue ?? '';
          if (v.trim() === '') continue;
          n.nodeValue = first ? (/^\s/.test(v) ? ' ' : '') + replacement : '';
          first = false;
        }
      }

      // Any header text that opens with a greeting ("Hello Zelda", "Welcome back, Zelda!") keeps only the greeting.
      for (const header of doc.querySelectorAll(HTML_HEADER)) {
        const walkerH = doc.createTreeWalker(header, 0x4); // SHOW_TEXT
        for (let n = walkerH.nextNode(); n !== null; n = walkerH.nextNode()) {
          const g = GREETING_START.exec(n.nodeValue ?? '');
          if (g !== null && (g[3] ?? '').trim() !== '' && (g[3] ?? '').trim() !== '[redacted]') n.nodeValue = `${g[1] ?? ''}${(g[2] ?? '').replace(/\s+/g, ' ')}, [redacted]`;
        }
      }

      this.learnFromDoc(doc);

      // Scrub every attribute, text node and comment.
      for (const el of doc.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }
          let v = attr.value ?? '';
          if (/^\s*javascript:/i.test(v)) v = '#';
          if (name === 'src' || name === 'srcset' || name === 'poster' || name === 'data-src') {
            v = v.replace(/https?:\/\/[^\s,]+/g, (u) => this.replaceImageUrl(u));
          }
          if (name === 'style') v = this.scrubCssUrls(v);
          if ((name === 'alt' || name === 'title' || name === 'aria-label') && v.length >= 8) v = this.replaceTitleLike(v);
          const scrubbed = this.scrubString(v, `<${tag} ${name}>`);
          if (scrubbed !== attr.value) el.setAttribute(attr.name, scrubbed);
        }
      }
      const walker = doc.createTreeWalker(doc, 0x4 | 0x80); // SHOW_TEXT | SHOW_COMMENT
      const commentedMarkup: Array<NonNullable<ReturnType<typeof walker.nextNode>>> = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.nodeValue ?? '';
        // Commented-out markup (e.g. disabled <script> tags in index.html) is dropped;
        // Angular's empty `<!---->` anchors are kept.
        if (node.nodeType === 8 && text.includes('<')) {
          commentedMarkup.push(node);
          continue;
        }
        const scrubbed = this.scrubString(text, `<${node.parentElement?.tagName.toLowerCase() ?? '#document'}> text`);
        if (scrubbed !== text) node.nodeValue = scrubbed;
      }
      for (const node of commentedMarkup) node.parentNode?.removeChild(node);
      // Every non-UI img alt in a card or the item gallery becomes that card's (or the item's) synthetic title.
      const itemTitle = doc.querySelector('app-detail h1[id]')?.textContent.trim() ?? '';
      for (const img of doc.querySelectorAll('img[alt]')) {
        const alt = img.getAttribute('alt') ?? '';
        if (alt.trim() === '' || UI_ALTS.has(alt.trim().toLowerCase())) continue;
        const card = img.closest(HTML_CARD_ROOTS);
        if (card === null && img.closest(HTML_GALLERY) === null) continue;
        const title = card === null ? itemTitle : (card.querySelector('a.feat-item_name')?.textContent.trim() ?? '');
        const upper = alt === alt.toUpperCase() && alt !== alt.toLowerCase();
        img.setAttribute('alt', upper ? title.toUpperCase() : title);
      }
      // Fail closed: every header greeting is reduced to "<greeting>, [redacted]".
      for (const header of doc.querySelectorAll(HTML_HEADER)) {
        const walkerH = doc.createTreeWalker(header, 0x4); // SHOW_TEXT
        for (let n = walkerH.nextNode(); n !== null; n = walkerH.nextNode()) {
          const text = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
          if (GREETING_START.test(text) && !GREETING_OK.test(text)) throw new Error(`${where}: a header greeting was not redacted`);
        }
      }
      // Fail closed: a greeting next to the user icon must read "Sign In" or be redacted.
      for (const icon of doc.querySelectorAll(HTML_GREETING_ICON)) {
        const label = (icon.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (label !== '' && !GREETING_OK.test(label)) throw new Error(`${where}: the header greeting next to ${HTML_GREETING_ICON} was not redacted`);
      }
      // A full page keeps (or, when copied as documentElement.outerHTML, regains) the doctype it was served with.
      const doctype = /^\s*(<!doctype|<html[\s>])/i.test(html) ? '<!DOCTYPE html>\n' : '';
      // LF only: a page pasted from the Windows clipboard has CRLF, and git stores LF (.gitattributes eol=lf).
      const out = this.scrubString(doctype + doc.documentElement.outerHTML, '(document)').replace(/\r\n?/g, '\n');
      // Fail closed: no raw (non-chrome) image alt survives anywhere in the output.
      for (const alt of rawAlts) {
        if (out.includes(alt) || out.includes(encodeEntities(alt))) throw new Error(`${where}: an img alt from the input survived (${String(alt.length)} characters)`);
      }
      return out;
    } finally {
      close();
    }
  }

  private scrubCssUrls(css: string): string {
    return css.replace(/url\(\s*(['"]?)((?:https?:)?\/\/[^'")]+)\1\s*\)/gi, (_m, _q, u: string) => `url(${this.replaceImageUrl(u)})`);
  }

  /** Lists any original sensitive value that still appears in `text` (build-time leak check). */
  findLeaks(text: string): string[] {
    const leaks: string[] = [];
    for (const { value, re } of this.redactions) if (text.search(re) >= 0) leaks.push(`personal: ${value}`);
    for (const { value, re } of this.redactWords) if (new RegExp(re.source, 'i').test(text)) leaks.push(`personal word: ${value}`);
    if (GREETING_LEAK.test(text)) leaks.push('greeting');
    // Titles in any case, entity-encoded, or with punctuation dropped (the uppercase pipe in img alt).
    const lowerText = text.toLowerCase();
    const normText = ` ${normTitle(text)} `;
    const delText = ` ${normTitleDel(text)} `;
    for (const t of this.originals.titles) {
      if (t.length < 8) continue;
      const nt = normTitle(t);
      const nd = normTitleDel(t);
      const spaced = nt.length >= 8 && (normText.includes(` ${nt} `) || delText.includes(` ${nt} `));
      const deleted = nd.length >= 8 && (delText.includes(` ${nd} `) || normText.includes(` ${nd} `));
      if (lowerText.includes(t.toLowerCase()) || lowerText.includes(encodeEntities(t).toLowerCase()) || spaced || deleted) {
        leaks.push(`title: ${t}`);
      }
    }
    for (const rule of this.identity.values()) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('i') ? 'i' : '');
      if (re.test(text)) leaks.push(`${rule.kind}: ${rule.orig}`);
    }
    for (const id of this.originals.itemIds) if (new RegExp(`(?<!\\d)${escapeRegExp(String(id))}(?!\\d)`).test(text)) leaks.push(`itemId: ${String(id)}`);
    for (const id of this.originals.privateIds) if (new RegExp(`(?<!\\d)${escapeRegExp(String(id))}(?!\\d)`).test(text)) leaks.push(`privateId: ${String(id)}`);
    for (const { re } of this.phoneRules) {
      if (new RegExp(re.source).test(text)) {
        leaks.push('learned phone');
        break;
      }
    }
    for (const p of text.matchAll(PHONE)) {
      if (!SYNTHETIC_PHONE.test(p[0])) {
        leaks.push(this.originals.phones.has(digitsOf(p[0])) ? `seller phone: ${p[0]}` : `phone number: ${p[0]}`);
        break;
      }
    }
    if (ADDRESS_OPTION.test(text)) leaks.push('address option');
    if (JWT_EMBEDDED.test(text)) leaks.push('jwt');
    JWT_EMBEDDED.lastIndex = 0;
    if (/(^|["\s])(authorization|set-cookie|cookie)["']?\s*[:=]/im.test(text)) leaks.push('secret header');
    // Image URLs, not bare host names: the request log keeps per-host counts of blocked requests.
    if (/https?:\/\/[^\s"'<>]*(shopgoodwillimages|azureedge\.net|blob\.core\.windows\.net)/i.test(text)) leaks.push('image URL');
    return leaks;
  }
}

// ---------------------------------------------------------------------------
// Build CLI
// ---------------------------------------------------------------------------

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SGW_DIR = path.join(ROOT, 'test', 'fixtures', 'sgw');

function loadSalt(rawDir: string): string {
  const env = process.env.SBW_FIXTURE_SALT;
  if (env !== undefined && env !== '') return env;
  const file = path.join(rawDir, '.salt');
  if (!existsSync(file)) {
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('hex'));
  }
  return readFileSync(file, 'utf8').trim();
}

/** Reads a local text file without a UTF-8 BOM (Notepad and PowerShell 5.1 add one; JSON.parse rejects it). */
function readText(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** raw/user/redact.txt (git-ignored, written by the user): one personal string per line, `#` comments. */
function loadRedactions(rawDir: string): string[] {
  const file = path.join(rawDir, 'user', 'redact.txt');
  if (!existsSync(file)) return [];
  return readText(file)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * One committed fixture and where its raw capture lives (test/fixtures/sgw/sources.json).
 * Raw files are referenced by capture step directory and endpoint, never by a
 * real item id, so sources.json itself leaks nothing; the build leak-checks it.
 */
export interface FixtureSource {
  fixture: string;
  kind: 'json' | 'html';
  from:
    | { type: 'api'; file: string } // raw/api/<out>.json written by capture-fixtures (api step)
    | { type: 'page-xhr'; dir: string; endpoint: string } // a buyerapi reply the page itself made during a render
    | { type: 'render'; dir: string } // raw/pages/<out>/page.html
    // USER STEP export. Write ids in urlPattern as `{itemId}`: a real id fails the build.
    | { type: 'user'; file: string; capturedAt: string; urlPattern: string; status?: number };
  endpoint?: string;
  page?: 'home' | 'item' | 'search' | 'favorites' | 'help';
  layout?: 'grid' | 'list';
  loggedIn?: boolean;
  notes?: string;
  /** User JSON only: extra privacy transforms applied after sanitizing (FixtureSanitizer.applyPrivacy). */
  privacy?: PrivacyOption[];
}

interface RawExchange {
  request: { method: string; url: string; body?: unknown; postData?: string | null };
  response: { status: number; bodyText: string } | null;
}

/** Endpoint key -> buyerapi path, for locating a page's own XHR in a render directory. */
const PAGE_XHR_PATHS: Record<string, RegExp> = {
  itemDetail: /\/api\/ItemDetail\/GetItemDetailModelByItemId\//i,
  currentTime: /\/api\/Dashboard\/GetCurrentTime$/i,
  helpCenter: /\/api\/HelpCenter\//i,
  sellerInfo: /\/api\/Seller\/GetSellerInfo\//i,
  sellerItems: /\/api\/Home\/GetSellerItems/i,
  galleryItems: /\/api\/Dashboard\/GetGalleryItems$/i,
};

function readJsonFile(file: string): unknown {
  return JSON.parse(readText(file)) as unknown;
}

function findPageXhr(rawDir: string, dir: string, endpoint: string): RawExchange {
  const re = PAGE_XHR_PATHS[endpoint];
  if (re === undefined) throw new Error(`no page-xhr path rule for endpoint ${endpoint}`);
  const xhrDir = path.join(rawDir, dir, 'buyerapi');
  const hit = readdirSync(xhrDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJsonFile(path.join(xhrDir, f)) as RawExchange)
    .find((x) => re.test(new URL(x.request.url).pathname));
  if (hit === undefined) throw new Error(`no ${endpoint} reply recorded in ${dir}`);
  return hit;
}

interface RawLogEntry {
  seq: number;
  method: string;
  url: string;
  sentAtMs: number;
  endedAtMs: number;
  status: number | null;
  outFiles: string[];
  pageInitiated?: { buyerapi: Array<{ method: string; path: string; status: number | null }> } & Record<string, unknown>;
  observations?: Record<string, unknown>;
  [k: string]: unknown;
}

const slash = (p: string): string => p.split('\\').join('/');

function logEntryFor(log: RawLogEntry[], rawRef: string): RawLogEntry {
  const hit = log.find((e) => e.outFiles.some((f) => slash(f) === slash(rawRef)));
  if (hit === undefined) throw new Error(`no request-log entry produced ${rawRef}`);
  return hit;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text; // non-JSON reply (e.g. an HTML error page): kept as a JSON string
  }
}

function requestBodyOf(x: RawExchange): unknown {
  return x.request.body ?? (typeof x.request.postData === 'string' ? parseMaybeJson(x.request.postData) : null);
}

/**
 * Builds committed fixtures, manifest.json and request-log.json from raw
 * captures under `sgwDir/raw`; throws, writing nothing, on any leak in the
 * outputs or in sources.json.
 */
export function buildFixtures(sanitizer: FixtureSanitizer, sgwDir: string = SGW_DIR): void {
  const rawDir = path.join(sgwDir, 'raw');
  const sourcesText = readText(path.join(sgwDir, 'sources.json'));
  const sources = (JSON.parse(sourcesText) as { fixtures: FixtureSource[] }).fixtures;
  const log = readRequestLog(path.join(rawDir, 'request-log.jsonl')) as unknown as RawLogEntry[];

  // Pass 1: learn every title, seller identity and id from every raw input
  // first, so a value learned from one capture is scrubbed from all of them.
  // Page dirs include replies that are not fixtures (cards on the item page).
  // Every standalone 6+-digit number SGW sent us, for the fail-closed raw-number check.
  const rawNumbers = new Set<string>();
  const harvest = (text: string): void => {
    for (const m of text.matchAll(RAW_NUMBER)) rawNumbers.add(m[0]);
  };
  const pageDirs = new Set<string>();
  for (const src of sources) {
    const f = src.from;
    if (f.type === 'render' || f.type === 'page-xhr') {
      pageDirs.add(f.dir);
      if (f.type === 'render') {
        const pageHtml = readText(path.join(rawDir, f.dir, 'page.html'));
        harvest(pageHtml);
        sanitizer.learnHtml(pageHtml);
      }
    } else if (f.type === 'api') {
      const x = readJsonFile(path.join(rawDir, f.file)) as RawExchange;
      harvest(x.response?.bodyText ?? '');
      harvest(x.request.url);
      sanitizer.learn(parseMaybeJson(x.response?.bodyText ?? 'null'));
      sanitizer.learn(requestBodyOf(x));
      sanitizer.sanitizeUrl(x.request.url);
    } else if (src.kind === 'json') {
      const userJson = readText(path.join(rawDir, f.file));
      harvest(userJson);
      sanitizer.learn(parseMaybeJson(userJson));
    } else {
      const userHtml = readText(path.join(rawDir, f.file));
      harvest(userHtml);
      sanitizer.learnHtml(userHtml);
    }
  }
  for (const dir of [...pageDirs].sort()) {
    const xhrDir = path.join(rawDir, dir, 'buyerapi');
    if (!existsSync(xhrDir)) continue;
    for (const f of readdirSync(xhrDir).sort()) {
      const x = readJsonFile(path.join(xhrDir, f)) as RawExchange;
      harvest(x.response?.bodyText ?? '');
      harvest(x.request.url);
      sanitizer.learn(parseMaybeJson(x.response?.bodyText ?? 'null'));
      sanitizer.learn(requestBodyOf(x));
    }
  }

  // Preflight, fail closed before anything is written:
  //  - an item page's seller appears only in its DOM, so the same item's
  //    ItemDetail JSON must be among the inputs to learn (and scrub) it (N1);
  //  - user JSON must not carry an id key nobody has classified (N5).
  const problems: string[] = [];
  for (const src of sources) {
    const f = src.from;
    const rel = `${src.kind}/${src.fixture}.${src.kind}`;
    if (src.kind === 'html' && (f.type === 'render' || f.type === 'user')) {
      const page = sanitizer.itemPage(readText(f.type === 'render' ? path.join(rawDir, f.dir, 'page.html') : path.join(rawDir, f.file)));
      if (page.isItemPage && (page.itemId === null || !sanitizer.hasItemDetailFor(page.itemId))) {
        problems.push(
          `${rel}: item page has no ItemDetail JSON for its item among the inputs (add that item's GetItemDetailModelByItemId response to sources.json; USER-STEPS S-1 step 6)`,
        );
      }
    }
    if (src.kind === 'json' && f.type === 'user') {
      const keys = unclassifiedIdKeys(parseMaybeJson(readText(path.join(rawDir, f.file))));
      if (keys.length > 0) {
        problems.push(`${rel}: unclassified id key(s) in user JSON: ${keys.join(', ')} (add each to PRIVATE_ID_KEYS or PUBLIC_ID_KEYS in scripts/sanitize-fixtures.ts)`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`refusing to build fixtures:\n${problems.join('\n')}`);

  const entries: Array<Record<string, unknown>> = [];
  const outputs = new Map<string, string>();
  const jsonFirst = [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'json' ? -1 : 1));
  for (const src of jsonFirst) {
    const f = src.from;
    const rel = `${src.kind}/${src.fixture}.${src.kind}`;
    let text: string;
    let status: number;
    let capturedAt: string;
    let urlPattern: string;
    let requestLogSeq: number | null = null;
    let requestBody: unknown;
    let method: string;
    if (f.type === 'user') {
      const rawText = readText(path.join(rawDir, f.file));
      if (src.kind === 'json') {
        const clean = sanitizer.sanitizeJson(parseMaybeJson(rawText), rel);
        text = `${JSON.stringify(src.privacy === undefined ? clean : sanitizer.applyPrivacy(clean, src.privacy), null, 2)}\n`;
      } else {
        text = sanitizer.sanitizeHtml(rawText, rel);
      }
      status = f.status ?? 200;
      capturedAt = f.capturedAt;
      urlPattern = sanitizer.sanitizeUrl(f.urlPattern);
      method = 'user-devtools';
    } else if (f.type === 'render') {
      const entry = logEntryFor(log, f.dir);
      text = sanitizer.sanitizeHtml(readText(path.join(rawDir, f.dir, 'page.html')), rel);
      status = entry.status ?? 0;
      capturedAt = new Date(entry.sentAtMs).toISOString();
      urlPattern = `GET ${sanitizer.sanitizeUrl(entry.url)}`;
      requestLogSeq = entry.seq;
      method = 'capture-fixtures:render';
    } else {
      const x = f.type === 'api' ? (readJsonFile(path.join(rawDir, f.file)) as RawExchange) : findPageXhr(rawDir, f.dir, f.endpoint);
      const entry = logEntryFor(log, f.type === 'api' ? f.file : f.dir);
      if (x.response === null) throw new Error(`${src.fixture}: raw capture has no response`);
      text = `${JSON.stringify(sanitizer.sanitizeJson(parseMaybeJson(x.response.bodyText), rel), null, 2)}\n`;
      status = x.response.status;
      capturedAt = new Date(entry.sentAtMs).toISOString();
      urlPattern = `${x.request.method} ${sanitizer.sanitizeUrl(x.request.url)}`;
      requestLogSeq = entry.seq;
      const rawBody = requestBodyOf(x);
      if (rawBody !== undefined && rawBody !== null) requestBody = sanitizer.sanitizeJson(rawBody, `${rel} (request body)`);
      method = f.type === 'api' ? 'capture-fixtures:api' : 'capture-fixtures:page-xhr';
    }
    outputs.set(rel, text);
    entries.push({
      file: rel,
      fixture: src.fixture,
      kind: src.kind,
      ...(src.endpoint === undefined ? {} : { endpoint: src.endpoint }),
      ...(src.page === undefined ? {} : { page: src.page }),
      ...(src.layout === undefined ? {} : { layout: src.layout }),
      loggedIn: src.loggedIn ?? false,
      source: f.type === 'user' ? 'user' : 'anonymous',
      method,
      urlPattern,
      ...(requestBody === undefined ? {} : { requestBody }),
      status,
      capturedAt,
      requestLogSeq,
      sanitizerVersion: SANITIZER_VERSION,
      ...(src.notes === undefined ? {} : { notes: src.notes }),
    });
  }

  const requestLog = log.map((e) => {
    const { observations, pageInitiated, ...rest } = e;
    const obs: Record<string, unknown> = { ...(observations ?? {}) };
    delete obs.thirdPartyUrlsSample; // third-party URLs carry tracking parameters; per-host counts are kept
    return {
      ...rest,
      url: sanitizer.sanitizeUrl(e.url),
      ...(pageInitiated === undefined
        ? {}
        : { pageInitiated: { ...pageInitiated, buyerapi: pageInitiated.buyerapi.map((c) => ({ ...c, path: sanitizer.sanitizeUrl(c.path) })) } }),
      observations: JSON.parse(sanitizer.sanitizeUrl(JSON.stringify(obs))) as unknown,
    };
  });

  entries.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  outputs.set('manifest.json', `${JSON.stringify({ schemaVersion: 1, sanitizerVersion: SANITIZER_VERSION, salt: 'local-secret', fixtures: entries }, null, 2)}\n`);
  outputs.set('request-log.json', `${JSON.stringify(requestLog, null, 2)}\n`);

  const leaks: string[] = [];
  for (const [rel, text] of outputs) for (const l of sanitizer.findLeaks(text)) leaks.push(`${rel}: ${l}`);
  // sources.json is committed too: hand-written notes and urlPatterns must not carry real ids or names.
  for (const l of sanitizer.findLeaks(sourcesText)) leaks.push(`sources.json: ${l}`);
  // Fail closed: no raw 6+-digit number survives unless it is a known public constant or a stand-in we made.
  for (const [rel, text] of [...outputs, ['sources.json', sourcesText] as const]) {
    const lengths = new Set<number>();
    for (const m of text.matchAll(RAW_NUMBER)) {
      if (rawNumbers.has(m[0]) && !KNOWN_PUBLIC_NUMBERS.has(m[0]) && !sanitizer.isSyntheticNumber(Number(m[0]))) lengths.add(m[0].length);
    }
    for (const n of lengths) leaks.push(`${rel}: raw 6+-digit number (${String(n)} digits)`);
  }
  if (leaks.length > 0) throw new Error(`refusing to write fixtures, leaks found:\n${leaks.join('\n')}`);

  for (const dir of ['json', 'html']) {
    const abs = path.join(sgwDir, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of readdirSync(abs)) if (!outputs.has(`${dir}/${f}`)) throw new Error(`stale fixture ${dir}/${f} is not in sources.json`);
  }
  for (const [rel, text] of outputs) writeFileSync(path.join(sgwDir, rel), text);
  console.log(`wrote ${String(entries.length)} fixtures, manifest.json and request-log.json (${String(log.length)} requests)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawDir = path.join(SGW_DIR, 'raw');
  buildFixtures(new FixtureSanitizer({ salt: loadSalt(rawDir), redact: loadRedactions(rawDir) }));
}

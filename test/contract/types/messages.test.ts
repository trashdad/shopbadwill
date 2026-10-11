// §3.12 message protocol (v1.1: I-08, I-21, I-33) and the §2.4 envelope.
// Each `Msg` type has examples/Msg/<type>.valid.json (a full §2.4 envelope)
// and examples/Msg/<type>.invalid.json ({ invalidBecause, path, value }).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { AuditEntry } from '../../../src/domain/audit/types';
import type { AuthStatus } from '../../../src/domain/calendar/types';
import type { MatchResult, Rule } from '../../../src/domain/rules/schema';
import type { Settings } from '../../../src/domain/settings/schema';
import type { CapsResult, Snipe } from '../../../src/domain/snipe/types';
import type {
  Cents,
  EpochMs,
  HealthReport,
  ItemDetail,
  ItemId,
  Listing,
  SgwSessionRecord,
  TrackedItem,
} from '../../../src/domain/types';
import type { JobRun, Watch } from '../../../src/domain/watches/schema';
import {
  MSG_SENDER,
  MSG_TYPES,
  MSG_VERSION,
  MsgEnvelopeSchema,
  MsgReplySchemas,
  MsgSchema,
  PORT_NAMES,
  PortTickSchemas,
  type Msg,
  type MsgEnvelope,
  type MsgPayload,
  type MsgReply,
  type MsgType,
} from '../../../src/messaging/protocol';
import type { RequestScheduler } from '../../../src/ports/request-scheduler';

const MSG_DIR = path.join(import.meta.dirname, 'examples', 'Msg');

// §3.12, grouped by its comments. §2.4 rule 3: content scripts may send only
// the `content` group (page.*, ui.openSnipe, rules.evaluate, rules.disable,
// landedCost.get, quick.*). `rules.disable` is the T-32 contract change
// (docs/CONTRACT-DECISIONS.md); extension pages may send content types too.
const EXPECTED = {
  content: [
    'page.listings',
    'page.detail',
    'page.token',
    'page.domHealth',
    'ui.openSnipe',
    'rules.evaluate',
    'rules.disable',
    'landedCost.get',
    'quick.hideSeller',
    'quick.hideKeyword',
    'quick.favorite',
    'quick.track',
  ],
  ui: [
    'settings.get',
    'settings.set',
    'rules.list',
    'rules.save',
    'rules.delete',
    'rules.preview',
    'watches.list',
    'watches.save',
    'watches.delete',
    'watches.importSaved',
    'job.runNow',
    'job.status',
    'tracked.list',
    'tracked.remove',
    'favorites.sync',
    'calendar.connect',
    'calendar.disconnect',
    'calendar.status',
    'calendar.syncNow',
    'calendar.ics',
    'snipe.prepare',
    'snipe.arm',
    'snipe.disarm',
    'snipe.list',
    'kill.set',
    'health.get',
    'audit.list',
    'audit.undo',
  ],
  background: ['rules.changed', 'switches.changed'],
} as const;

// Types that declare a `reply` in §3.12.
const WITH_REPLY = [
  'rules.evaluate',
  'landedCost.get',
  'settings.get',
  'rules.list',
  'rules.preview',
  'watches.list',
  'watches.importSaved',
  'job.status',
  'tracked.list',
  'calendar.connect',
  'calendar.status',
  'calendar.ics',
  'snipe.prepare',
  'snipe.arm',
  'snipe.list',
  'health.get',
  'audit.list',
];

const ALL_EXPECTED_TUPLE = [...EXPECTED.content, ...EXPECTED.ui, ...EXPECTED.background] as const;
const ALL_EXPECTED: string[] = [...ALL_EXPECTED_TUPLE];

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(MSG_DIR, file), 'utf8'));
}

describe('Msg union', () => {
  it('has exactly the §3.12 types', () => {
    expect([...MSG_TYPES].sort()).toEqual([...ALL_EXPECTED].sort());
    expect(new Set(MSG_TYPES).size).toBe(MSG_TYPES.length);
  });

  it('assigns every type to its §3.12 sender group', () => {
    for (const [sender, types] of Object.entries(EXPECTED)) {
      for (const type of types) expect(MSG_SENDER[type], type).toBe(sender);
    }
  });

  it('has a discriminated-union option for every type and no others', () => {
    const optionTypes = MsgSchema.options.map((option) => option.shape.type.value);
    expect([...optionTypes].sort()).toEqual([...ALL_EXPECTED].sort());
  });

  it("has no 'permissions.request' (I-21: UI pages request permissions themselves)", () => {
    expect(MSG_TYPES).not.toContain('permissions.request');
    const result = MsgSchema.safeParse({ type: 'permissions.request', payload: { permissions: ['notifications'] } });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown type at ["type"]', () => {
    const result = MsgEnvelopeSchema.safeParse({ v: 1, reqId: 'r-1', type: 'nope', payload: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(['type']);
  });

  it('uses envelope version 1 (§2.4)', () => {
    expect(MSG_VERSION).toBe(1);
  });

  it('has an example pair for every type and no orphans', () => {
    const files = readdirSync(MSG_DIR).sort();
    const expected = ALL_EXPECTED.flatMap((type) => [`${type}.invalid.json`, `${type}.valid.json`]).sort();
    expect(files).toEqual(expected);
  });
});

describe.each(ALL_EXPECTED)('%s', (type) => {
  it('valid example parses as this type, unchanged', () => {
    const envelope = readJson(`${type}.valid.json`);
    const result = MsgEnvelopeSchema.safeParse(envelope);
    if (!result.success) expect.fail(`${type}.valid.json:\n${z.prettifyError(result.error)}`);
    expect(result.data.type).toBe(type);
    expect(result.data).toEqual(envelope);

    // The bare message (no envelope) discriminates the same way.
    const bare: Record<string, unknown> = { ...result.data };
    delete bare.v;
    delete bare.reqId;
    expect(MsgSchema.parse(bare).type).toBe(type);
  });

  it('invalid example is rejected at the documented path', () => {
    const raw = readJson(`${type}.invalid.json`);
    const example = z
      .object({ invalidBecause: z.string().min(1), path: z.array(z.union([z.string(), z.number()])), value: z.unknown() })
      .parse(raw);
    const result = MsgEnvelopeSchema.safeParse(example.value);
    expect(result.success, example.invalidBecause).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path), example.invalidBecause).toContainEqual(example.path);
    expect((example.value as { type?: unknown }).type, 'the invalid example keeps its own type').toBe(type);
  });
});

describe('replies', () => {
  it('has a reply schema exactly for the §3.12 types that declare `reply`', () => {
    expect(Object.keys(MsgReplySchemas).sort()).toEqual([...WITH_REPLY].sort());
  });

  it('types replies as §3.12 declares them', () => {
    expectTypeOf<MsgReply<'rules.evaluate'>>().toEqualTypeOf<MatchResult[]>();
    expectTypeOf<MsgReply<'landedCost.get'>>().toEqualTypeOf<Record<ItemId, Cents | null>>();
    expectTypeOf<MsgReply<'settings.get'>>().toEqualTypeOf<Settings>();
    expectTypeOf<MsgReply<'rules.list'>>().toEqualTypeOf<Rule[]>();
    expectTypeOf<MsgReply<'rules.preview'>>().toEqualTypeOf<{ matched: number; total: number; ids: ItemId[] }>();
    expectTypeOf<MsgReply<'watches.list'>>().toEqualTypeOf<Watch[]>();
    expectTypeOf<MsgReply<'watches.importSaved'>>().toEqualTypeOf<{ imported: number; skipped: number }>();
    expectTypeOf<MsgReply<'job.status'>>().toEqualTypeOf<JobRun | null>();
    expectTypeOf<MsgReply<'tracked.list'>>().toEqualTypeOf<TrackedItem[]>();
    expectTypeOf<MsgReply<'calendar.connect'>>().toEqualTypeOf<AuthStatus>();
    expectTypeOf<MsgReply<'calendar.status'>>().toEqualTypeOf<AuthStatus>();
    expectTypeOf<MsgReply<'calendar.ics'>>().toEqualTypeOf<{ ics: string }>();
    expectTypeOf<MsgReply<'snipe.prepare'>>().toEqualTypeOf<{
      detail: ItemDetail;
      estAllIn: Cents | null;
      caps: CapsResult;
    }>();
    expectTypeOf<MsgReply<'snipe.arm'>>().toEqualTypeOf<Snipe>();
    expectTypeOf<MsgReply<'snipe.list'>>().toEqualTypeOf<Snipe[]>();
    expectTypeOf<MsgReply<'health.get'>>().toEqualTypeOf<{
      sgw: HealthReport | null;
      session: SgwSessionRecord['expiresAt'] | null;
      sessionState: 'ok' | 'expiring' | 'expired' | 'logged-out';
      google: AuthStatus;
      budget: ReturnType<RequestScheduler['stats']>;
    }>();
    expectTypeOf<MsgReply<'audit.list'>>().toEqualTypeOf<AuditEntry[]>();
    // No `reply` in §3.12: the response carries nothing.
    expectTypeOf<MsgReply<'settings.set'>>().toEqualTypeOf<undefined>();
    expectTypeOf<MsgReply<'rules.changed'>>().toEqualTypeOf<undefined>();
  });

  it('validates a reply against its schema', () => {
    expect(MsgReplySchemas['landedCost.get'].safeParse({ '279250057': 1299, '279250058': null }).success).toBe(true);
    expect(MsgReplySchemas['landedCost.get'].safeParse({ '279250057': 12.99 }).success).toBe(false);
    expect(MsgReplySchemas['job.status'].safeParse(null).success).toBe(true);
  });
});

// §3.12 verbatim, minus `reply` (see MsgReply above).
type SpecMsg =
  | { type: 'page.listings'; payload: { url: string; listings: Listing[]; capturedAt: EpochMs } }
  | { type: 'page.detail'; payload: { detail: ItemDetail } }
  | { type: 'page.token'; payload: { bearer: string; capturedAt: EpochMs } }
  | {
      type: 'page.domHealth';
      payload: { url: string; configVersion: string; pageKind: string; cardsFound: number; fallbackUsed: boolean };
    }
  | { type: 'ui.openSnipe'; payload: { itemId: ItemId } }
  | { type: 'rules.evaluate'; payload: { listings: Listing[] } }
  | { type: 'rules.disable'; payload: { ruleId: string } }
  | { type: 'landedCost.get'; payload: { itemIds: ItemId[] } }
  | { type: 'quick.hideSeller'; payload: { sellerId: number; sellerName: string } }
  | { type: 'quick.hideKeyword'; payload: { term: string } }
  | { type: 'quick.favorite'; payload: { itemId: ItemId } }
  | { type: 'quick.track'; payload: { itemId: ItemId } }
  | { type: 'settings.get' }
  | { type: 'settings.set'; payload: Partial<Settings> }
  | { type: 'rules.list' }
  | { type: 'rules.save'; payload: Rule }
  | { type: 'rules.delete'; payload: { id: string } }
  | { type: 'rules.preview'; payload: { rule: Rule; tabId?: number } }
  | { type: 'watches.list' }
  | { type: 'watches.save'; payload: Watch }
  | { type: 'watches.delete'; payload: { id: string } }
  | { type: 'watches.importSaved' }
  | { type: 'job.runNow'; payload: { watchIds?: string[] } }
  | { type: 'job.status' }
  | { type: 'tracked.list' }
  | { type: 'tracked.remove'; payload: { itemId: ItemId } }
  | { type: 'favorites.sync' }
  | { type: 'calendar.connect' }
  | { type: 'calendar.disconnect' }
  | { type: 'calendar.status' }
  | { type: 'calendar.syncNow' }
  | { type: 'calendar.ics'; payload: { itemIds: ItemId[] } }
  | { type: 'snipe.prepare'; payload: { itemId: ItemId } }
  | { type: 'snipe.arm'; payload: { snipe: Omit<Snipe, 'state' | 'history' | 'armedAt'>; typedConfirmation?: string } }
  | { type: 'snipe.disarm'; payload: { id: string } }
  | { type: 'snipe.list' }
  | { type: 'kill.set'; payload: { on: boolean } }
  | { type: 'health.get' }
  | { type: 'audit.list'; payload: { limit: number; before?: number } }
  | { type: 'audit.undo'; payload: { seq: number } }
  | { type: 'rules.changed' }
  | { type: 'switches.changed'; payload: { killSwitch: boolean; writesAllowed: Record<string, boolean> } };

describe('payload types', () => {
  it('Msg is exactly the §3.12 union (minus reply)', () => {
    expectTypeOf<Msg>().toEqualTypeOf<SpecMsg>();
    expectTypeOf<MsgEnvelope>().toExtend<{ v: 1; reqId: string; type: MsgType }>();
  });

  it('types payloads as §3.12 declares them', () => {
    expectTypeOf<MsgType>().toEqualTypeOf<(typeof ALL_EXPECTED_TUPLE)[number]>();
    expectTypeOf<MsgPayload<'page.listings'>>().toEqualTypeOf<{
      url: string;
      listings: Listing[];
      capturedAt: EpochMs;
    }>();
    expectTypeOf<MsgPayload<'settings.set'>>().toEqualTypeOf<Partial<Settings>>();
    expectTypeOf<MsgPayload<'rules.preview'>>().toEqualTypeOf<{ rule: Rule; tabId?: number }>();
    expectTypeOf<MsgPayload<'watches.save'>>().toEqualTypeOf<Watch>();
    expectTypeOf<MsgPayload<'snipe.arm'>>().toEqualTypeOf<{
      snipe: Omit<Snipe, 'state' | 'history' | 'armedAt'>;
      typedConfirmation?: string;
    }>();
    expectTypeOf<MsgPayload<'switches.changed'>>().toEqualTypeOf<{
      killSwitch: boolean;
      writesAllowed: Record<string, boolean>;
    }>();
    expectTypeOf<MsgPayload<'settings.get'>>().toEqualTypeOf<undefined>();
    expectTypeOf<Extract<Msg, { type: 'favorites.sync' }>>().toEqualTypeOf<{ type: 'favorites.sync' }>();
  });
});

describe('ports (streams)', () => {
  it('names the two §3.12 ports', () => {
    expect(PORT_NAMES).toEqual({ snipeCountdown: 'sbw:snipe-countdown', jobProgress: 'sbw:job-progress' });
    expect(Object.keys(PortTickSchemas).sort()).toEqual(['sbw:job-progress', 'sbw:snipe-countdown']);
  });

  it('streams { snipeId, serverNow, fireAt, state } on the countdown port', () => {
    const tick = { snipeId: 'snp-1', serverNow: 1791428000000, fireAt: 1791428302000, state: 'verified' };
    expect(PortTickSchemas['sbw:snipe-countdown'].parse(tick)).toEqual(tick);
  });
});

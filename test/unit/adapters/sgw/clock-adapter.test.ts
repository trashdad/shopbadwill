// T-29: SgwClockAdapter. Time is injected through FakeClock; no real timers.
import { describe, expect, it } from 'vitest';

import { SAMPLE_TTL_MS, SgwClockAdapter } from '../../../../src/adapters/sgw/clock-adapter';
import { parsePacific, parsePacificDetailed } from '../../../../src/domain/time/pacific';
import type { ClockSample } from '../../../../src/domain/types';
import { FakeClock } from '../../../fakes/ports/fake-clock';

const T0 = 1_800_000_000_000;

function sample(p: Partial<ClockSample> & { rttMs: number }): ClockSample {
  const sentAt = p.sentAt ?? T0;
  return {
    serverMs: T0 + 5000,
    sentAt,
    receivedAt: sentAt + p.rttMs,
    source: 'itemDetail',
    ...p,
  };
}

function off(a: SgwClockAdapter) {
  const o = a.offset();
  if (!o) throw new Error('expected an offset');
  return o;
}

function make() {
  const clock = new FakeClock(T0 + 1000);
  return { clock, adapter: new SgwClockAdapter({ parsePacific, parsePacificDetailed }, clock) };
}

describe('SgwClockAdapter', () => {
  it('returns null with no samples', () => {
    const { adapter } = make();
    expect(adapter.offset()).toBeNull();
    expect(adapter.serverNow()).toBeNull();
  });

  it('offset equals the lowest-RTT sample: server - (sent + rtt/2)', () => {
    const { adapter } = make();
    adapter.addSample(sample({ rttMs: 300, serverMs: T0 + 5150 }));
    adapter.addSample(sample({ rttMs: 100, serverMs: T0 + 5050 }));
    adapter.addSample(sample({ rttMs: 200, serverMs: T0 + 9999 }));
    const o = off(adapter);
    expect(o.rttMs).toBe(100);
    expect(o.offsetMs).toBe(T0 + 5050 - (T0 + 50));
    expect(o.samples).toBe(3);
  });

  it('a seconds-only sample never outranks an ms sample at equal RTT', () => {
    for (const order of [0, 1]) {
      const { adapter } = make();
      const secs = sample({ rttMs: 100, source: 'getCurrentTime', serverMs: T0 + 1000 });
      const ms = sample({ rttMs: 100, source: 'itemDetail', serverMs: T0 + 5000 });
      for (const s of order ? [ms, secs] : [secs, ms]) adapter.addSample(s);
      expect(off(adapter).offsetMs).toBe(T0 + 5000 - (T0 + 50));
    }
  });

  it('a lower-RTT seconds-only sample still wins over a slower ms sample', () => {
    const { adapter } = make();
    adapter.addSample(sample({ rttMs: 50, source: 'dateHeader', serverMs: T0 + 2000 }));
    adapter.addSample(sample({ rttMs: 100, serverMs: T0 + 5000 }));
    expect(off(adapter).rttMs).toBe(50);
  });

  it('samples older than 30 min expire, including from the count', () => {
    const { adapter, clock } = make();
    adapter.addSample(sample({ rttMs: 100 }));
    clock.advance(SAMPLE_TTL_MS - 1000);
    adapter.addSample(sample({ rttMs: 200, sentAt: clock.now() }));
    expect(off(adapter).samples).toBe(2);
    clock.advance(2000);
    const o = off(adapter);
    expect(o.samples).toBe(1);
    expect(o.rttMs).toBe(200);
    clock.advance(SAMPLE_TTL_MS);
    expect(adapter.offset()).toBeNull();
    expect(adapter.serverNow()).toBeNull();
  });

  it('confidence: high needs >=3 live samples and winning rtt <= 400', () => {
    const { adapter } = make();
    adapter.addSample(sample({ rttMs: 400 }));
    expect(off(adapter).confidence).toBe('low');
    adapter.addSample(sample({ rttMs: 500 }));
    expect(off(adapter).confidence).toBe('low');
    adapter.addSample(sample({ rttMs: 600 }));
    expect(off(adapter).confidence).toBe('high');

    const slow = make().adapter;
    for (const r of [401, 500, 600]) slow.addSample(sample({ rttMs: r }));
    expect(off(slow).confidence).toBe('low');
  });

  it('serverNow = clock.now() + offset', () => {
    const { adapter, clock } = make();
    adapter.addSample(sample({ rttMs: 100, serverMs: T0 + 5050 }));
    expect(adapter.serverNow()).toBe(T0 + 1000 + 5000);
    clock.advance(250);
    expect(adapter.serverNow()).toBe(T0 + 1250 + 5000);
  });

  it('delegates Pacific parsing', () => {
    const { adapter } = make();
    expect(adapter.parsePacific('2026-10-07T20:09:15.967')).toBe(Date.UTC(2026, 9, 8, 3, 9, 15, 967));
    expect(adapter.parsePacificDetailed('2026-11-01T01:30:00').ambiguous).toBe(true);
    expect(adapter.parsePacificDetailed('2026-03-08T02:30:00').nonexistent).toBe(true);
  });

  it('keeps the sample set bounded', () => {
    const { adapter } = make();
    for (let i = 0; i < 500; i++) adapter.addSample(sample({ rttMs: 100 + i }));
    expect(off(adapter).samples).toBeLessThanOrEqual(64);
    expect(off(adapter).rttMs).toBe(100);
  });
});

describe('serverTime helpers (S-1 verdict)', () => {
  it('itemDetail serverTime: naive Pacific with ms', () => {
    const s = make().adapter.sampleFromServerTime('2026-10-07T20:09:15.967', T0, T0 + 120);
    expect(s).toEqual({
      serverMs: Date.UTC(2026, 9, 8, 3, 9, 15, 967),
      sentAt: T0,
      receivedAt: T0 + 120,
      rttMs: 120,
      source: 'itemDetail',
    });
  });

  it('GetCurrentTime data: MM/dd/yyyy HH:mm:ss Pacific, seconds-only', () => {
    const s = make().adapter.sampleFromGetCurrentTime('10/07/2026 20:09:15', T0, T0 + 80);
    expect(s?.serverMs).toBe(Date.UTC(2026, 9, 8, 3, 9, 15));
    expect(s?.source).toBe('getCurrentTime');
    expect(s?.rttMs).toBe(80);
  });

  it('rejects malformed input', () => {
    expect(make().adapter.sampleFromServerTime('garbage', T0, T0 + 1)).toBeNull();
    expect(make().adapter.sampleFromGetCurrentTime('2026-10-07', T0, T0 + 1)).toBeNull();
  });
});

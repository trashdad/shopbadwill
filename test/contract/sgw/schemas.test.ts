import { describe, expect, it } from 'vitest';
import { SGW_ENDPOINTS, type SgwEndpointKey } from '../../../src/adapters/sgw/config';
import { SGW_ENDPOINT_SCHEMAS, SgwProblemDetailsSchema, parseEndpoint } from '../../../src/adapters/sgw/schemas';
import { SgwApiError } from '../../../src/ports/errors';
import { fixtureExists, loadFixture, manifestEntries } from './fixtures';

/** Endpoints SGW serves that the extension does not call, so they have no schema. */
const UNSCHEMATIZED = new Set(['helpCenter']);

function schemaError(fn: () => unknown): SgwApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SgwApiError);
    expect((e as SgwApiError).kind).toBe('schema');
    return e as SgwApiError;
  }
  throw new Error('expected a schema error, nothing was thrown');
}

describe('one schema per config.ts endpoint', () => {
  it('covers every endpoint key', () => {
    expect(Object.keys(SGW_ENDPOINT_SCHEMAS).sort()).toEqual(Object.keys(SGW_ENDPOINTS).sort());
  });
});

describe('every manifest fixture validates', () => {
  const entries = manifestEntries().filter((e) => e.kind === 'json');
  it('has json fixtures to check', () => {
    expect(entries.length).toBeGreaterThan(0);
  });
  for (const e of entries) {
    // Stage-2 entries may be listed before their file lands: skip those.
    const present = fixtureExists(e.file);
    (present ? it : it.skip)(`${e.file} (${e.endpoint ?? '?'}, HTTP ${String(e.status)})`, () => {
      const raw = loadFixture(e.file.replace(/^json\//, '').replace(/\.json$/, ''));
      if (e.endpoint !== undefined && UNSCHEMATIZED.has(e.endpoint)) return;
      expect(e.endpoint, 'manifest endpoint must be a config.ts key').toBeDefined();
      if (e.status >= 400) {
        expect(SgwProblemDetailsSchema.parse(raw).status).toBe(e.status);
        return;
      }
      parseEndpoint(e.endpoint as SgwEndpointKey, raw);
    });
  }
});

describe('schema errors name the path', () => {
  it('a renamed consumed search field fails with a schema error naming it', () => {
    const raw = loadFixture<{ searchResults: { items: Array<Record<string, unknown>> } }>('search-grid-p1');
    const row = raw.searchResults.items[2] ?? {};
    expect(Object.keys(row).length).toBeGreaterThan(0);
    row.numberOfBids = row.numBids;
    delete row.numBids;
    expect(schemaError(() => parseEndpoint('search', raw)).message).toContain('searchResults.items[2].numBids');
  });

  it('a renamed consumed detail field fails with a schema error naming it', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.numberOfBidders = raw.numberOfBids;
    delete raw.numberOfBids;
    expect(schemaError(() => parseEndpoint('itemDetail', raw)).message).toContain('itemDetail: numberOfBids');
    const raw2 = loadFixture<{ bidHistory: Record<string, unknown> }>('item-detail-open');
    delete raw2.bidHistory.bidComplete;
    expect(schemaError(() => parseEndpoint('itemDetail', raw2)).message).toContain('bidHistory.bidComplete');
  });

  it('unknown extra keys are tolerated', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.brandNewField = { anything: 1 };
    expect(() => parseEndpoint('itemDetail', raw)).not.toThrow();
  });

  it('a retyped time fails', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.serverTime = '2026-10-07T20:09:15Z';
    expect(schemaError(() => parseEndpoint('itemDetail', raw)).message).toContain('serverTime');
  });
});

describe('provisional schemas (no fixture yet)', () => {
  it('accept the shapes the config evidence describes', () => {
    parseEndpoint('favorites', {
      status: true,
      message: 'Ok',
      data: [{ itemId: 1, watchlistId: 2, notes: null, endTime: '2026-10-07T20:00:00', sellerId: 3 }],
    });
    parseEndpoint('savedSearches', { status: true, data: [{ saveSearchId: 1, searchName: 'x' }] });
    parseEndpoint('showBidModal', { sellerId: 1, minimumBid: 5 });
    parseEndpoint('showBidModal', { status: true, data: { sellerId: 1, minimumBid: 5 } });
    parseEndpoint('shippingQuote', { shippingPrice: 4.5, handlingPrice: 1 });
    parseEndpoint('placeBid', { status: false, result: -3, message: '<p>closed</p>' });
    parseEndpoint('addFavorite', { status: true, message: '' });
  });
  it('reject a showBidModal without the consumed fields', () => {
    expect(schemaError(() => parseEndpoint('showBidModal', { status: true, data: { seller: 1 } })).message).toContain('sellerId');
  });
});

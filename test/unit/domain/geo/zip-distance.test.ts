// T-115: the coarse offline ZIP3 -> state -> centroid table and the distance math.
import { describe, expect, it } from 'vitest';

import {
  STATE_CENTROIDS,
  approxPickupMiles,
  haversineMiles,
  stateCentroid,
  zipToState,
} from '../../../../src/domain/geo/zip-distance';

describe('zipToState', () => {
  it('maps sample ZIPs from several states', () => {
    expect(zipToState('02139')).toBe('MA');
    expect(zipToState('10001')).toBe('NY');
    expect(zipToState('19103')).toBe('PA');
    expect(zipToState('20500')).toBe('DC');
    expect(zipToState('30301')).toBe('GA');
    expect(zipToState('33101')).toBe('FL');
    expect(zipToState('60601')).toBe('IL');
    expect(zipToState('73301')).toBe('TX');
    expect(zipToState('73102')).toBe('OK');
    expect(zipToState('75201')).toBe('TX');
    expect(zipToState('80202')).toBe('CO');
    expect(zipToState('85001')).toBe('AZ');
    expect(zipToState('89101')).toBe('NV');
    expect(zipToState('90210')).toBe('CA');
    expect(zipToState('96813')).toBe('HI');
    expect(zipToState('97201')).toBe('OR');
    expect(zipToState('98101')).toBe('WA');
    expect(zipToState('99501')).toBe('AK');
    expect(zipToState('05401')).toBe('VT');
    expect(zipToState('03101')).toBe('NH');
    expect(zipToState('04101')).toBe('ME');
    expect(zipToState('06103')).toBe('CT');
    expect(zipToState('07102')).toBe('NJ');
  });

  it('accepts ZIP+4 and surrounding spaces', () => {
    expect(zipToState(' 60601-1234 ')).toBe('IL');
  });

  it('returns null for unknown or malformed input', () => {
    expect(zipToState('')).toBeNull();
    expect(zipToState('1234')).toBeNull();
    expect(zipToState('abcde')).toBeNull();
    expect(zipToState('000000')).toBeNull();
    expect(zipToState('00001')).toBeNull(); // unassigned prefix
    expect(zipToState('09001')).toBeNull(); // military (AE)
    expect(zipToState('96201')).toBeNull(); // military (AP)
  });
});

describe('stateCentroid', () => {
  it('knows every state and DC, and nothing else', () => {
    expect(Object.keys(STATE_CENTROIDS).length).toBeGreaterThanOrEqual(51);
    expect(stateCentroid('IL')).not.toBeNull();
    expect(stateCentroid('ZZ')).toBeNull();
    expect(stateCentroid(undefined)).toBeNull();
  });
});

describe('haversineMiles', () => {
  it('is 0 for the same point and symmetric', () => {
    const a = { lat: 40, lon: -90 };
    const b = { lat: 35, lon: -80 };
    expect(haversineMiles(a, a)).toBe(0);
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 9);
  });

  it('gives about 69 miles per degree of latitude', () => {
    expect(haversineMiles({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(69.1, 0);
  });

  it('gives about 2,450 miles from New York City to Los Angeles', () => {
    const d = haversineMiles({ lat: 40.71, lon: -74.01 }, { lat: 34.05, lon: -118.24 });
    expect(d).toBeGreaterThan(2400);
    expect(d).toBeLessThan(2500);
  });
});

describe('approxPickupMiles', () => {
  it('is the rounded state-centroid distance', () => {
    const miles = approxPickupMiles('60601', 'IN');
    expect(miles).not.toBeNull();
    expect((miles ?? 0) % 10).toBe(0);
    expect(miles).toBeGreaterThan(100);
    expect(miles).toBeLessThan(250);
  });

  it('is 0 within the same state', () => {
    expect(approxPickupMiles('60601', 'IL')).toBe(0);
  });

  it('returns null when either side is unknown', () => {
    expect(approxPickupMiles(undefined, 'IL')).toBeNull();
    expect(approxPickupMiles('', 'IL')).toBeNull();
    expect(approxPickupMiles('nope', 'IL')).toBeNull();
    expect(approxPickupMiles('60601', undefined)).toBeNull();
    expect(approxPickupMiles('60601', 'ZZ')).toBeNull();
  });
});

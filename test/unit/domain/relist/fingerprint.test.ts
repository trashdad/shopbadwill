// T-113: the relist fingerprint (normalized title + sellerId + image basename).
import { describe, expect, it } from 'vitest';

import { imageBasename, normalizeTitle, relistFingerprint } from '../../../../src/domain/relist/fingerprint';

describe('normalizeTitle', () => {
  it('lowercases, strips accents and punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('  Vintage PYREX  Bowl -- "Butterprint" #403!! ')).toBe('vintage pyrex bowl butterprint 403');
    expect(normalizeTitle('Crème Brûlée Dish')).toBe('creme brulee dish');
    expect(normalizeTitle('Lot\tof\n3')).toBe('lot of 3');
  });

  it('is empty for a title with no letters or digits', () => {
    expect(normalizeTitle(' -- !! ')).toBe('');
  });

  it('caps the length so the stored fingerprint stays bounded', () => {
    expect(normalizeTitle('a'.repeat(500)).length).toBe(120);
  });
});

describe('imageBasename', () => {
  it('is the last path segment, lowercased, without query or fragment', () => {
    expect(imageBasename('https://img.test/a/b/3D5B02B4A1CF9C64.jpg?w=200#x')).toBe('3d5b02b4a1cf9c64.jpg');
    expect(imageBasename('https://img.test/3d5b02b4a1cf9c64.jpg')).toBe('3d5b02b4a1cf9c64.jpg');
  });

  it('accepts backslash separators and relative paths', () => {
    expect(imageBasename(String.raw`Images\2026\abc.JPG`)).toBe('abc.jpg');
  });

  it('is empty when there is no image', () => {
    expect(imageBasename(undefined)).toBe('');
    expect(imageBasename('')).toBe('');
    expect(imageBasename('https://img.test/')).toBe('');
  });
});

describe('relistFingerprint', () => {
  const base = { title: 'Pyrex Bowl', sellerId: 42, imageUrl: 'https://img.test/x/abc.jpg' };

  it('combines the seller, the normalized title and the image basename', () => {
    expect(relistFingerprint(base)).toBe('42|pyrex bowl|abc.jpg');
  });

  it('matches across cosmetic title changes and image hosts', () => {
    expect(relistFingerprint({ ...base, title: 'PYREX  bowl!', imageUrl: 'https://other.test/y/ABC.jpg?v=2' })).toBe(
      relistFingerprint(base),
    );
  });

  it('differs by seller, title or image', () => {
    const fp = relistFingerprint(base);
    expect(relistFingerprint({ ...base, sellerId: 43 })).not.toBe(fp);
    expect(relistFingerprint({ ...base, title: 'Pyrex Dish' })).not.toBe(fp);
    expect(relistFingerprint({ ...base, imageUrl: 'https://img.test/x/def.jpg' })).not.toBe(fp);
  });

  it('works without an image', () => {
    expect(relistFingerprint({ title: 'Pyrex Bowl', sellerId: 42 })).toBe('42|pyrex bowl|');
  });

  it('is null when the title has nothing to match on', () => {
    expect(relistFingerprint({ ...base, title: '!!' })).toBeNull();
  });
});

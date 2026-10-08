import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Contract-suite smoke test: zod schemas parse valid data and fail closed.
describe('contract suite smoke', () => {
  const Listing = z.object({ itemId: z.number().int().positive(), title: z.string().min(1) });

  it('parses a valid record', () => {
    expect(Listing.parse({ itemId: 1, title: 'Brass lamp' })).toEqual({ itemId: 1, title: 'Brass lamp' });
  });

  it('rejects an invalid record', () => {
    expect(Listing.safeParse({ itemId: '1', title: '' }).success).toBe(false);
  });
});

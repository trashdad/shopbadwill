// Calendar event ids are base32hex (a-v, 0-9; 5-1024 chars). "sbv" is the
// ShopBadwill prefix ("sgw" is invalid: 'w' is outside a-v). Item ids and
// generations are non-negative integers, so the result is always valid.
import type { ItemId } from '../types';
import type { EventIdFor } from './types';

export const EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;

export const eventIdFor: EventIdFor = (itemId: ItemId, generation: number): string => {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new RangeError(`itemId must be a positive safe integer, got ${String(itemId)}`);
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError(`generation must be a non-negative safe integer, got ${String(generation)}`);
  }
  return `sbv${String(itemId)}g${String(generation)}`;
};

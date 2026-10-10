// Receiver-side schema for api-tap messages (T-31). Imported by the isolated
// overlay script (T-32), never by the MAIN-world tap (keeps zod out of it).
import { z } from 'zod';

import { isBuyerApiUrl, TAP_SOURCE } from './api-tap.main';
import { JWT_RE } from './jwt';

export const MAX_URL_CHARS = 2048;
export const MAX_NONCE_CHARS = 128;
export const MAX_BEARER_CHARS = 8192;

/** Response body: parsed JSON, raw text, or `{ tooLarge: true }` over 2 MB. */
export const TapMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    source: z.literal(TAP_SOURCE),
    nonce: z.string().min(1).max(MAX_NONCE_CHARS),
    kind: z.literal('response'),
    url: z.string().max(MAX_URL_CHARS),
    status: z.number().int(),
    body: z.unknown(),
  }),
  z.object({
    source: z.literal(TAP_SOURCE),
    nonce: z.string().min(1).max(MAX_NONCE_CHARS),
    kind: z.literal('token'),
    /** Bare JWT, no "Bearer " prefix. */
    bearer: z.string().max(MAX_BEARER_CHARS).regex(JWT_RE),
  }),
]);
export type TapMessage = z.infer<typeof TapMessageSchema>;

/**
 * Untrusted-input validation: returns null for anything malformed, carrying
 * the wrong nonce, a non-buyerapi response URL or a non-JWT-shaped token.
 */
export function parseTapMessage(data: unknown, nonce: string): TapMessage | null {
  try {
    const r = TapMessageSchema.safeParse(data);
    if (!r.success || r.data.nonce !== nonce) return null;
    if (r.data.kind === 'response' && !isBuyerApiUrl(r.data.url)) return null;
    return r.data;
  } catch {
    return null;
  }
}

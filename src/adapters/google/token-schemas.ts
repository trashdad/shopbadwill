// T-62: zod schemas for Google's OAuth token-endpoint responses (RFC 6749
// §5.1/§5.2 as Google sends them). Calendar v3 schemas are T-64's (./schemas.ts).
import { z } from 'zod';

/** A successful authorization_code or refresh_token grant. Unknown fields are ignored. */
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  /** Seconds. */
  expires_in: z.number().positive(),
  token_type: z.string().regex(/^bearer$/i),
  /** Space-separated granted scopes. Google sends it; absent means "unchanged". */
  scope: z.string().optional(),
  /** authorization_code with access_type=offline; a refresh_token grant may rotate it. */
  refresh_token: z.string().min(1).optional(),
  /** Seconds; sent for time-limited grants. */
  refresh_token_expires_in: z.number().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** RFC 6749 §5.2 error body, e.g. `{"error":"invalid_grant","error_description":"Bad Request"}`. */
export const OAuthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof OAuthErrorSchema>;

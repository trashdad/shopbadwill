// Single definition of the JWT shape check, shared by the MAIN-world tap and
// the zod receiver schema. No imports: it is bundled into the tap.
export const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

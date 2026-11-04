// Build-target flags shared by the browser adapters. `import.meta.env.FIREFOX`
// is replaced by WXT at build time (literal true/false) and is a live value
// under Vitest, where it may be the string 'true'.
export function isFirefox(): boolean {
  const v: unknown = import.meta.env.FIREFOX;
  return v === true || v === 'true';
}

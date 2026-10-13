// Build-time flags defined in wxt.config.ts (`vite.define`).
interface ImportMetaEnv {
  /** True only in a test build (`SBW_TEST=1 pnpm build`); `false` in production. */
  readonly SBW_TEST: boolean;
}

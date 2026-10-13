// The glob lives here, not in the shell: a folder added under sections/ is picked up with no edit to Dashboard.tsx.
export const builtinModules: Record<string, unknown> = import.meta.glob('./sections/*/index.tsx', { eager: true });

// T-36: the handler registry (I-01). Every other `./*.ts` file in this folder
// is a module exporting `register(ctx: BackgroundContext)`; main.ts calls
// registerHandlers() once, after startup, so a new handler module needs no
// edit anywhere else. A module that does not export register(ctx), or whose
// register throws, is reported in ctx.startup.registered.failed.
import { registerModules, type BackgroundContext, type BackgroundModule, type ModuleMap } from '../context';

export const HANDLER_MODULES: ModuleMap = import.meta.glob<BackgroundModule>(['./*.ts', '!./index.ts'], { eager: true });

export function registerHandlers(ctx: BackgroundContext, modules: ModuleMap = HANDLER_MODULES): void {
  registerModules('handlers', modules, ctx, ctx.startup.registered);
}

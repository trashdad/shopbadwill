// T-36: the job registry (I-01). Every other `./*.ts` file in this folder (not
// `steps/`, which T-52's step registry loads) is a module exporting
// `register(ctx: BackgroundContext)`; main.ts calls registerJobs() once, after
// the handlers, so a new job module needs no edit anywhere else. Jobs subscribe
// to wake events through the context (ctx.alarms.onAlarm, ctx.lifecycle,
// ctx.ticks), never with browser listeners of their own (see context.ts).
import { registerModules, type BackgroundContext, type BackgroundModule, type ModuleMap } from '../context';

export const JOB_MODULES: ModuleMap = import.meta.glob<BackgroundModule>(['./*.ts', '!./index.ts'], { eager: true });

export function registerJobs(ctx: BackgroundContext, modules: ModuleMap = JOB_MODULES): void {
  registerModules('jobs', modules, ctx, ctx.startup.registered);
}

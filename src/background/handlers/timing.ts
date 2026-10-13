// T-90: `timing.awake`. The Timing page's awake chart reads the persisted
// `sbw:awake` heartbeat history through this message. A missing record, and an
// invalid one, both answer the empty array.
//
// Read only: it never writes. It reads the raw bytes and validates them with
// the record's own schema, so an invalid record is left in place for the
// heartbeat job, which quarantines it under its own lock. A Repo `get` here
// would quarantine outside that lock, and its remove could delete a history
// the heartbeat had just written.
//
// T-111: the chart is the awake-history advice, so it leaves out the runs a T2
// companion wake caused (`withoutCompanionWakes` over `sbw:companionWakes`,
// read raw the same way; an invalid record counts as no wakes). The stored
// history itself is never changed.
import { parseCompanionWakes, STORAGE_KEYS, STORAGE_RECORDS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { companionWakeTimes, withoutCompanionWakes } from '../jobs/companion-sync';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('timing.awake', async () => {
    const parsed = STORAGE_RECORDS[STORAGE_KEYS.awake].schema.safeParse(await ctx.repo.getRaw(STORAGE_KEYS.awake));
    if (!parsed.success) return [];
    const wakes = companionWakeTimes(parseCompanionWakes(await ctx.repo.getRaw(STORAGE_KEYS.companionWakes)));
    return withoutCompanionWakes(parsed.data, wakes, ctx.repo.now());
  });
}

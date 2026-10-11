// T-90: `timing.awake`. The Timing page's awake chart reads the persisted
// `sbw:awake` heartbeat history through this message. A missing record, and an
// invalid one, both answer the empty array.
//
// Read only: it never writes. It reads the raw bytes and validates them with
// the record's own schema, so an invalid record is left in place for the
// heartbeat job, which quarantines it under its own lock. A Repo `get` here
// would quarantine outside that lock, and its remove could delete a history
// the heartbeat had just written.
import { STORAGE_KEYS, STORAGE_RECORDS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('timing.awake', async () => {
    const parsed = STORAGE_RECORDS[STORAGE_KEYS.awake].schema.safeParse(await ctx.repo.getRaw(STORAGE_KEYS.awake));
    return parsed.success ? parsed.data : [];
  });
}

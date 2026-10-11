// T-90: `timing.awake`. The Timing page's awake chart reads the persisted
// `sbw:awake` heartbeat history through this message. A missing record, and an
// invalid one (quarantined by the repo), both answer the empty array.
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('timing.awake', () => ctx.repo.get(STORAGE_KEYS.awake));
}

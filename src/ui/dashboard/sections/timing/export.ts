// T-90: the JSON export of the Timing page. A Blob download only — no network
// (R4). Timing data plus snipe ids only: bid amounts are never included.
import type { Settings } from '../../../../domain/settings/schema';
import { soakSummary, timingMeasurements, type SoakSummary, type TimingMeasurements } from '../../../../domain/snipe/soak';
import type { Snipe } from '../../../../domain/snipe/types';

export interface TimingExport {
  /** When the export was built (UTC ISO). */
  exportedAt: string;
  /** The soak summary over the dry-run snipes. */
  summary: SoakSummary;
  /** The live gate's counters and the current default lead. */
  gate: { completedDryRuns: number; requiredDryRuns: number; defaultLeadMs: number };
  /** One row per snipe (newest armed first): timing measurements and the snipe id only. */
  rows: TimingMeasurements[];
}

/**
 * The export document. `timingMeasurements` already carries only timing data
 * plus the snipe id, so no bid amount (maxBid, allInMax, estShipping,
 * estHandling) can appear here (R4).
 */
export function buildTimingExport(snipes: readonly Snipe[], settings: Settings): TimingExport {
  const rows = [...snipes]
    .sort((a, b) => b.armedAt - a.armedAt)
    .map((s) => timingMeasurements(s));
  return {
    exportedAt: new Date().toISOString(),
    summary: soakSummary(snipes),
    gate: {
      completedDryRuns: settings.snipe.completedDryRuns,
      requiredDryRuns: settings.snipe.requiredDryRuns,
      defaultLeadMs: settings.snipe.defaultLeadMs,
    },
    rows,
  };
}

/** A UTC `YYYY-MM-DD` stamp for the file name. */
function dayStamp(d: Date): string {
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Downloads the export as a JSON file through a Blob URL. No network. */
export function downloadTimingExport(data: TimingExport, now: Date = new Date()): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shopbadwill-timing-${dayStamp(now)}.json`;
  // The anchor has to be in the document or the browser drops the download.
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

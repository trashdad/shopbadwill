// T-115: a COARSE, offline pickup distance. Pure; no network, no data files.
//
// The extension may not download a ZIP-centroid table, so this maps a ZIP's
// 3-digit prefix to its US state (the public USPS ZIP3 allocation ranges),
// then measures the great-circle distance between two approximate state
// centroids. Within one state the result is 0; across states it can be off by
// a few hundred miles. Callers must label it as approximate.
//
// `homeZip` is personal (R4): nothing here logs or returns it.
import type { UsState } from '../types';

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * ZIP3 ranges as "start:ST", sorted by start; each range runs to the next
 * start. "--" marks unassigned, military (AA/AE/AP) and territories without a
 * centroid.
 */
const ZIP3_RANGES =
  '0:--,5:NY,6:PR,8:--,9:PR,10:MA,28:RI,30:NH,39:ME,50:VT,55:MA,56:VT,60:CT,70:NJ,90:--,' +
  '100:NY,150:PA,197:DE,200:DC,201:VA,202:DC,206:MD,220:VA,247:WV,270:NC,290:SC,300:GA,320:FL,' +
  '340:--,341:FL,350:AL,370:TN,386:MS,398:GA,400:KY,428:--,430:OH,460:IN,480:MI,500:IA,529:--,' +
  '530:WI,550:MN,568:--,569:DC,570:SD,578:--,580:ND,589:--,590:MT,600:IL,630:MO,659:--,660:KS,' +
  '680:NE,694:--,700:LA,715:--,716:AR,730:OK,733:TX,734:OK,750:TX,800:CO,817:--,820:WY,832:ID,' +
  '839:--,840:UT,848:--,850:AZ,866:--,870:NM,885:TX,886:--,889:NV,899:--,900:CA,962:--,967:HI,' +
  '969:--,970:OR,980:WA,995:AK';

const RANGES: ReadonlyArray<readonly [number, string]> = ZIP3_RANGES.split(',').map((part) => {
  const [start = '', state = ''] = part.split(':');
  return [Number(start), state] as const;
});

/** Approximate geographic centroid of each state (and DC, PR), in degrees. */
export const STATE_CENTROIDS: Readonly<Record<string, LatLon>> = Object.freeze(
  Object.fromEntries(
    (
      'AL:32.8:-86.8,AK:64.0:-152.0,AZ:34.2:-111.6,AR:34.9:-92.4,CA:37.2:-119.5,CO:39.0:-105.5,' +
      'CT:41.6:-72.7,DE:39.0:-75.5,DC:38.9:-77.0,FL:28.6:-82.4,GA:32.7:-83.4,HI:20.8:-156.3,' +
      'ID:44.4:-114.6,IL:40.0:-89.2,IN:39.9:-86.3,IA:42.1:-93.5,KS:38.5:-98.4,KY:37.5:-85.3,' +
      'LA:31.1:-92.0,ME:45.4:-69.2,MD:39.0:-76.8,MA:42.3:-71.8,MI:44.3:-85.4,MN:46.3:-94.3,' +
      'MS:32.7:-89.7,MO:38.4:-92.5,MT:47.0:-109.6,NE:41.5:-99.8,NV:39.3:-116.6,NH:43.7:-71.6,' +
      'NJ:40.2:-74.7,NM:34.4:-106.1,NY:42.9:-75.5,NC:35.6:-79.4,ND:47.5:-100.5,OH:40.3:-82.8,' +
      'OK:35.6:-97.5,OR:43.9:-120.6,PA:40.9:-77.8,RI:41.7:-71.5,SC:33.9:-80.9,SD:44.4:-100.2,' +
      'TN:35.9:-86.4,TX:31.5:-99.3,UT:39.3:-111.7,VT:44.1:-72.7,VA:37.5:-78.9,WA:47.4:-120.5,' +
      'WV:38.6:-80.6,WI:44.6:-89.9,WY:43.0:-107.6,PR:18.2:-66.5'
    )
      .split(',')
      .map((part) => {
        const [st = '', lat = '', lon = ''] = part.split(':');
        return [st, { lat: Number(lat), lon: Number(lon) }];
      }),
  ),
);

const ZIP_RE = /^(\d{3})\d{2}(?:-\d{4})?$/;

/** The state of a 5-digit (or ZIP+4) US ZIP, or null when malformed, unassigned or military. */
export function zipToState(zip: string | undefined): UsState | null {
  const m = ZIP_RE.exec((zip ?? '').trim());
  if (m === null) return null;
  const prefix = Number(m[1]);
  let state = '--';
  for (const [start, st] of RANGES) {
    if (start > prefix) break;
    state = st;
  }
  return state === '--' ? null : state;
}

/** The approximate centroid of a 2-letter state code, or null when unknown. */
export function stateCentroid(state: string | undefined): LatLon | null {
  if (state === undefined || !Object.hasOwn(STATE_CENTROIDS, state)) return null;
  return STATE_CENTROIDS[state] ?? null;
}

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles. */
export function haversineMiles(a: LatLon, b: LatLon): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Approximate miles (rounded to 10) from the home ZIP's state to the pickup
 * state: 0 within one state, null when either side is unknown.
 */
export function approxPickupMiles(homeZip: string | undefined, pickupState: string | undefined): number | null {
  const home = stateCentroid(zipToState(homeZip) ?? undefined);
  const pickup = stateCentroid(pickupState);
  if (home === null || pickup === null) return null;
  return Math.round(haversineMiles(home, pickup) / 10) * 10;
}

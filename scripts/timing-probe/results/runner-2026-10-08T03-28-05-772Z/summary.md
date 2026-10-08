### firefox — main lanes (6 fires)

| metric (ms) | n | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|
| alarm wake latency (onAlarm − scheduledTime) | 6 | 4672 | 6935 | 9382 | 9382 | 9382 | 6794 |
| worker start − scheduledTime (timeOrigin) | 6 | 4656.0 | 6922.0 | 9372.0 | 9372.0 | 9372.0 | 6780.0 |
| timer A single setTimeout: fire error, signed | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| timer A single setTimeout: fire error, absolute | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| timer A single setTimeout: performance.now based | 6 | -0.50 | 1.00 | 6859.50 | 6859.50 | 6859.50 | 2255.50 |
| timer B staged hops: fire error, signed | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| timer B staged hops: fire error, absolute | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| timer B staged hops: performance.now based | 6 | 0.00 | 1.00 | 6859.50 | 6859.50 | 6859.50 | 2255.83 |
| timer C worker setTimeout: fire error, signed | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.2 |
| timer C worker setTimeout: fire error, absolute | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.2 |
| fire → fetch() call (persist attempt) | 6 | 5.0 | 14.0 | 18.0 | 18.0 | 18.0 | 12.5 |
| PlaceBid server arrival − (end − lead) | 6 | -145.0 | -135.5 | 6726.0 | 6726.0 | 6726.0 | 2116.7 |
| clock offset estimate − true skew | 6 | 75.0 | 75.0 | 76.0 | 76.0 | 76.0 | 75.3 |
| best-sample RTT | 6 | 153.0 | 155.0 | 156.0 | 156.0 | 156.0 | 154.7 |
| KeepAlive heartbeat interval | 30 | 20002 | 21707 | 22172 | 23693 | 26361 | 21272 |
| hold duration (wake → release) | 6 | 129176 | 132951 | 135268 | 135268 | 135268 | 132916 |
| max gap between 5 s ticks during hold | 6 | 6873 | 8251 | 10586 | 10586 | 10586 | 8580 |
| gap control: last tick after release | 5 | 25492 | 27241 | 28362 | 28362 | 28362 | 27239 |

- fires 6/6; cold wakes 6/6; alive wake→release 6/6; alive ≥ 6 min 0/6
- worker/event-page deaths during the hold: 0; during the 20 s stalled PlaceBid: 0/6; stalled PlaceBid aborted at 20 s: 6/6
- timer A (single setTimeout, as designed): |err| p95 6860.5 ms, max 6860.5 ms over 6 fires → target (p95 ≤ 50, max ≤ 250) NOT MET
- timer B (staged hops): |err| p95 6860.5 ms, max 6860.5 ms over 6 fires → target NOT MET
- timer C (dedicated Worker, measure-only): |err| p95 6860.5 ms, max 6860.5 ms over 6 fires → target NOT MET
- positive control (no heartbeat after release): the next wake was a cold start in 5/5 gaps

### firefox — runner-page study

| timer (ms) | n | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|
| runner lanes: runner page timer A (single) | 12 | 0.0 | 1.0 | 2.0 | 2.0 | 2.0 | 1.0 |
| runner lanes: runner page timer B (staged) | 12 | 0.0 | 1.0 | 2.0 | 3.5 | 3.5 | 1.3 |
| runner lanes: event page timer A (single) | 12 | 0.5 | 1.0 | 2.0 | 3.0 | 3.0 | 1.3 |
| runner lanes: event page timer B (staged) | 12 | -1.0 | 1.5 | 4.5 | 4.5 | 4.5 | 1.7 |
| runner lanes: event page timer C (worker) | 12 | 0.0 | 1.0 | 2.0 | 2.0 | 2.0 | 1.1 |
| baseline lane: event page timer A (single) | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| baseline lane: event page timer B (staged) | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.5 |
| baseline lane: event page timer C (worker) | 6 | 0.5 | 2.0 | 6860.5 | 6860.5 | 6860.5 | 2256.2 |

- runner page state at fire: visible/focus=true

### Per-cycle raw

| lane | c | wake lat | cold | alive | hold ms | hb n | hb max | A err | B err | C err | B perf err | send lag | arrival | off err | rtt | PlaceBid | died | last seen after wake | gap last tick |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| firefox-runner1 | 1 | 39 | true | y | 138535 | 6 | 21867 | 2.0 | 1.0 | 1.0 | 0.00 | 5 | -145 | 74.5 | 155.0 | aborted 22046 | n | 138522 | 27450 |
| firefox-runner1 | 2 | 6878 | true | y | 133075 | 6 | 23165 | 1.0 | 1.0 | 1.0 | 0.00 | 4 | -147 | 75.5 | 154.0 | aborted 20000 | n | 133063 | 26068 |
| firefox-runner1 | 3 | 6884 | true | y | 133075 | 6 | 21877 | 0.5 | 0.5 | 0.5 | 0.50 | 14 | -139 | 75.5 | 155.0 | aborted 20007 | n | 133051 | 26101 |
| firefox-runner1 | 4 | 6892 | true | y | 133057 | 6 | 23629 | 2.0 | 2.0 | 2.0 | 1.00 | 14 | -135 | 74.5 | 154.0 | aborted 20011 | n | 133033 | 30507 |
| firefox-runner1 | 5 | 450 | true | y | 142744 | 6 | 21852 | 1.0 | 0.0 | 0.0 | 0.00 | 7 | -147 | 75.5 | 156.0 | aborted 20000 | n | 142722 | 25010 |
| firefox-runner1 | 6 | 6954 | true | y | 132991 | 6 | 21853 | 1.0 | -1.0 | 1.0 | 0.00 | 16 | -138 | 75.5 | 154.0 | aborted 20002 | n | 132977 | 26594 |
| firefox-base1 | 1 | 9382 | true | y | 129176 | 6 | 22172 | 6671.5 | 6670.5 | 6670.5 | 6669.50 | 5 | 6524 | 75.0 | 153.0 | aborted 20004 | n | 129162 | 27163 |
| firefox-base1 | 2 | 5789 | true | y | 134151 | 6 | 21858 | 6860.5 | 6860.5 | 6860.5 | 6859.50 | 18 | 6726 | 75.0 | 155.0 | aborted 20010 | n | 134137 | 27935 |
| firefox-base1 | 3 | 6935 | true | y | 133010 | 6 | 21935 | 3.0 | 2.0 | 2.0 | 0.00 | 6 | -145 | 75.5 | 155.0 | aborted 20012 | n | 132997 | 25492 |
| firefox-base1 | 4 | 6991 | true | y | 132951 | 6 | 21869 | 0.5 | 4.5 | 0.5 | 4.50 | 14 | -133 | 75.0 | 154.0 | aborted 20012 | n | 132929 | 28362 |
| firefox-base1 | 5 | 4672 | true | y | 135268 | 6 | 26361 | 2.0 | 1.0 | 2.0 | 1.00 | 15 | -137 | 75.5 | 155.0 | aborted 20010 | n | 135246 | 27241 |
| firefox-base1 | 6 | 6994 | true | y | 132942 | 6 | 23693 | 1.5 | 0.5 | 1.5 | 0.50 | 17 | -136 | 76.0 | 156.0 | aborted 20003 | n | 132926 | 26762 |
| firefox-runner2 | 1 | 14 | true | y | 138553 | 6 | 21200 | 3.0 | 2.0 | 2.0 | 1.00 | 7 | -145 | 77.0 | 158.0 | aborted 20002 | n | 138540 | 26196 |
| firefox-runner2 | 2 | 6896 | true | y | 133063 | 6 | 21856 | 2.0 | 2.0 | 2.0 | 0.00 | 16 | -137 | 76.5 | 157.0 | aborted 20008 | n | 133037 | 26561 |
| firefox-runner2 | 3 | 6916 | true | y | 133022 | 6 | 22683 | 0.5 | 4.5 | 0.5 | 4.50 | 17 | -134 | 77.0 | 156.0 | aborted 20012 | n | 133007 | 26099 |
| firefox-runner2 | 4 | 5148 | true | y | 138885 | 6 | 24153 | 0.5 | 1.5 | 0.5 | 0.50 | 15 | -135 | 75.0 | 155.0 | aborted 20005 | n | 138873 | 25001 |
| firefox-runner2 | 5 | 6877 | true | y | 133059 | 6 | 22474 | 2.0 | 2.0 | 2.0 | 1.00 | 7 | -144 | 76.0 | 156.0 | aborted 20014 | n | 133034 | 26572 |
| firefox-runner2 | 6 | 2148 | true | y | 137814 | 6 | 25039 | 0.5 | 4.5 | 0.5 | 4.50 | 5 | -143 | 75.5 | 156.0 | aborted 20000 | n | 137791 | 0 |

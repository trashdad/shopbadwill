### firefox — main lanes (9 fires)

| metric (ms) | n | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|
| alarm wake latency (onAlarm − scheduledTime) | 9 | 9 | 9 | 12 | 12 | 12 | 10 |
| worker start − scheduledTime (timeOrigin) | 9 | -9.0 | -2.0 | 4.0 | 4.0 | 4.0 | -2.4 |
| timer A single setTimeout: fire error, signed | 9 | 0.5 | 0.5 | 2.0 | 2.0 | 2.0 | 0.8 |
| timer A single setTimeout: fire error, absolute | 9 | 0.5 | 0.5 | 2.0 | 2.0 | 2.0 | 0.8 |
| timer A single setTimeout: performance.now based | 9 | -1.50 | -0.50 | 2.00 | 2.00 | 2.00 | 0.00 |
| timer B staged hops: fire error, signed | 9 | 0.0 | 3.5 | 5.5 | 5.5 | 5.5 | 3.1 |
| timer B staged hops: fire error, absolute | 9 | 0.0 | 3.5 | 5.5 | 5.5 | 5.5 | 3.1 |
| timer B staged hops: performance.now based | 9 | 0.00 | 2.50 | 4.50 | 4.50 | 4.50 | 2.22 |
| timer C worker setTimeout: fire error, signed | 9 | 0.5 | 1.0 | 1.5 | 1.5 | 1.5 | 1.0 |
| timer C worker setTimeout: fire error, absolute | 9 | 0.5 | 1.0 | 1.5 | 1.5 | 1.5 | 1.0 |
| fire → fetch() call (persist attempt) | 9 | 4.0 | 5.0 | 15.0 | 15.0 | 15.0 | 7.8 |
| PlaceBid server arrival − (end − lead) | 9 | -153.5 | -143.5 | -129.0 | -129.0 | -129.0 | -142.6 |
| clock offset estimate − true skew | 9 | 75.0 | 75.5 | 79.5 | 79.5 | 79.5 | 76.4 |
| best-sample RTT | 9 | 154.0 | 157.0 | 162.0 | 162.0 | 162.0 | 156.8 |
| KeepAlive heartbeat interval | 162 | 19999 | 20001 | 20001 | 20001 | 20002 | 20001 |
| hold duration (wake → release) | 9 | 388539 | 389917 | 389930 | 389930 | 389930 | 389461 |
| max gap between 5 s ticks during hold | 9 | 5001 | 5002 | 5002 | 5002 | 5002 | 5002 |
| gap control: last tick after release | 6 | 25997 | 26011 | 26026 | 26026 | 26026 | 26014 |

- fires 9/9; cold wakes 9/9; alive wake→release 9/9; alive ≥ 6 min 9/9
- worker/event-page deaths during the hold: 0; during the 20 s stalled PlaceBid: 0/9; stalled PlaceBid aborted at 20 s: 9/9
- timer A (single setTimeout, as designed): |err| p95 2.0 ms, max 2.0 ms over 9 fires → target (p95 ≤ 50, max ≤ 250) MET
- timer B (staged hops): |err| p95 5.5 ms, max 5.5 ms over 9 fires → target MET
- timer C (dedicated Worker, measure-only): |err| p95 1.5 ms, max 1.5 ms over 9 fires → target MET
- positive control (no heartbeat after release): the next wake was a cold start in 6/6 gaps

### Per-cycle raw

| lane | c | wake lat | cold | alive | hold ms | hb n | hb max | A err | B err | C err | B perf err | send lag | arrival | off err | rtt | PlaceBid | died | last seen after wake | gap last tick |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| firefox-main1 | 1 | 12 | true | y | 388539 | 19 | 20001 | 0.5 | 5.5 | 1.5 | 3.50 | 15 | -129 | 75.5 | 154.0 | aborted 20001 | n | 388517 | 26026 |
| firefox-main1 | 2 | 9 | true | y | 389917 | 19 | 20002 | 0.5 | 1.5 | 0.5 | 0.50 | 4 | -147 | 75.5 | 157.0 | aborted 20001 | n | 389901 | 26009 |
| firefox-main1 | 3 | 9 | true | y | 389922 | 19 | 20001 | 1.0 | 1.0 | 1.0 | 1.00 | 5 | -154 | 79.5 | 162.0 | aborted 20001 | n | 389907 | 26000 |
| firefox-main2 | 1 | 9 | true | y | 388539 | 19 | 20002 | 1.0 | 0.0 | 1.0 | 1.00 | 5 | -149 | 77.5 | 159.0 | aborted 20000 | n | 388526 | 26011 |
| firefox-main2 | 2 | 11 | true | y | 389930 | 19 | 20001 | 2.0 | 1.0 | 1.0 | 0.00 | 4 | -148 | 75.5 | 154.0 | aborted 20000 | n | 389913 | 25997 |
| firefox-main2 | 3 | 9 | true | y | 389929 | 19 | 20001 | 0.5 | 5.5 | 1.5 | 3.50 | 4 | -144 | 75.5 | 157.0 | aborted 19999 | n | 389902 | 26002 |
| firefox-main3 | 1 | 10 | true | y | 388541 | 19 | 20001 | 0.5 | 5.5 | 0.5 | 4.50 | 6 | -143 | 76.5 | 156.0 | aborted 20000 | n | 388528 | 26014 |
| firefox-main3 | 2 | 10 | true | y | 389919 | 19 | 20002 | 0.5 | 3.5 | 1.5 | 2.50 | 15 | -133 | 75.0 | 154.0 | aborted 20000 | n | 389902 | 26024 |
| firefox-main3 | 3 | 9 | true | y | 389916 | 19 | 20001 | 0.5 | 4.5 | 0.5 | 3.50 | 12 | -139 | 77.5 | 158.0 | aborted 20000 | n | 389900 | 0 |

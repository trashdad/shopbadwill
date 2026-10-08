### chrome — main lanes (21 fires)

| metric (ms) | n | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|
| alarm wake latency (onAlarm − scheduledTime) | 21 | 42 | 52 | 61 | 62 | 63 | 53 |
| worker start − scheduledTime (timeOrigin) | 21 | 31.9 | 40.2 | 49.4 | 49.5 | 50.1 | 41.4 |
| timer A single setTimeout: fire error, signed | 21 | 0.1 | 1.5 | 4.4 | 4.4 | 4.6 | 2.0 |
| timer A single setTimeout: fire error, absolute | 21 | 0.1 | 1.5 | 4.4 | 4.4 | 4.6 | 2.0 |
| timer A single setTimeout: performance.now based | 21 | -0.35 | 1.35 | 3.70 | 3.85 | 4.25 | 1.60 |
| timer B staged hops: fire error, signed | 21 | -0.9 | 2.0 | 4.4 | 4.6 | 4.6 | 2.2 |
| timer B staged hops: fire error, absolute | 21 | 0.3 | 2.0 | 4.4 | 4.6 | 4.6 | 2.3 |
| timer B staged hops: performance.now based | 21 | 0.00 | 1.50 | 3.75 | 4.15 | 4.15 | 1.88 |
| fire → fetch() call (persist attempt) | 21 | 0.0 | 1.0 | 1.0 | 11.0 | 12.0 | 1.8 |
| PlaceBid server arrival − (end − lead) | 21 | -151.5 | -148.5 | -143.5 | -139.0 | -138.0 | -147.4 |
| clock offset estimate − true skew | 21 | 74.5 | 76.0 | 76.5 | 77.0 | 77.5 | 75.9 |
| best-sample RTT | 21 | 152.7 | 154.9 | 155.7 | 155.8 | 156.0 | 154.7 |
| KeepAlive heartbeat interval | 378 | 19986 | 20000 | 20009 | 20011 | 20014 | 20000 |
| hold duration (wake → release) | 21 | 388493 | 389881 | 389889 | 389892 | 389894 | 389685 |
| max gap between 5 s ticks during hold | 21 | 5010 | 5014 | 5015 | 5015 | 5015 | 5013 |
| gap control: last tick after release | 18 | 25999 | 26009 | 26029 | 26029 | 26029 | 26012 |

- fires 21/21; cold wakes 21/21; alive wake→release 21/21; alive ≥ 6 min 21/21
- worker/event-page deaths during the hold: 0; during the 20 s stalled PlaceBid: 0/21; stalled PlaceBid aborted at 20 s: 21/21
- timer A (single setTimeout, as designed): |err| p95 4.4 ms, max 4.6 ms over 21 fires → target (p95 ≤ 50, max ≤ 250) MET
- timer B (staged hops): |err| p95 4.6 ms, max 4.6 ms over 21 fires → target MET
- positive control (no heartbeat after release): the next wake was a cold start in 18/18 gaps

### chrome — control lanes

| lane | cycle | hb | died | last seen after fire (ms) | PlaceBid | recovery path |
|---|---|---|---|---|---|---|
| chrome-longfetch | 1 | 19 | no | 90013 | response 45010 ms | - |
| chrome-longfetch | 2 | 19 | no | 90014 | response 45010 ms | - |
| chrome-longfetch | 3 | 19 | no | 90004 | response 45010 ms | - |
| chrome-hbstop | 1 | 14 | yes | 26010 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |
| chrome-hbstop | 2 | 14 | yes | 26025 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |
| chrome-hbstop | 3 | 14 | yes | 26013 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |

### firefox — main lanes (21 fires)

| metric (ms) | n | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|
| alarm wake latency (onAlarm − scheduledTime) | 21 | 12 | 9377 | 9390 | 9390 | 9393 | 8092 |
| worker start − scheduledTime (timeOrigin) | 21 | -9.0 | 9340.0 | 9367.0 | 9368.0 | 9369.0 | 8065.6 |
| timer A single setTimeout: fire error, signed | 21 | 1.0 | 6843.5 | 6855.0 | 6855.5 | 6858.0 | 6192.6 |
| timer A single setTimeout: fire error, absolute | 21 | 1.0 | 6843.5 | 6855.0 | 6855.5 | 6858.0 | 6192.6 |
| timer A single setTimeout: performance.now based | 21 | 1.00 | 6844.00 | 6854.00 | 6856.50 | 6857.00 | 6192.10 |
| timer B staged hops: fire error, signed | 21 | 1.0 | 6843.5 | 6854.5 | 6855.0 | 6857.0 | 6192.4 |
| timer B staged hops: fire error, absolute | 21 | 1.0 | 6843.5 | 6854.5 | 6855.0 | 6857.0 | 6192.4 |
| timer B staged hops: performance.now based | 21 | 1.00 | 6843.00 | 6854.00 | 6855.50 | 6856.00 | 6191.76 |
| timer C worker setTimeout: fire error, signed | 21 | 1.0 | 6843.5 | 6854.5 | 6856.0 | 6858.0 | 6192.6 |
| timer C worker setTimeout: fire error, absolute | 21 | 1.0 | 6843.5 | 6854.5 | 6856.0 | 6858.0 | 6192.6 |
| fire → fetch() call (persist attempt) | 21 | 3.0 | 6.0 | 16.0 | 17.0 | 17.0 | 9.2 |
| PlaceBid server arrival − (end − lead) | 21 | -145.5 | 6696.0 | 6719.0 | 6720.5 | 6722.0 | 6049.6 |
| clock offset estimate − true skew | 21 | 73.5 | 75.5 | 76.0 | 76.5 | 76.5 | 75.3 |
| best-sample RTT | 21 | 152.0 | 155.0 | 157.0 | 157.0 | 157.0 | 155.0 |
| KeepAlive heartbeat interval | 355 | 19999 | 20012 | 24530 | 25543 | 26931 | 20886 |
| hold duration (wake → release) | 21 | 379191 | 380564 | 386941 | 389940 | 391740 | 382636 |
| max gap between 5 s ticks during hold | 21 | 8555 | 10551 | 11401 | 11465 | 12447 | 10705 |
| gap control: last tick after release | 18 | 25021 | 27596 | 30032 | 30518 | 30518 | 27719 |

- fires 21/21; cold wakes 21/21; alive wake→release 21/21; alive ≥ 6 min 21/21
- worker/event-page deaths during the hold: 0; during the 20 s stalled PlaceBid: 0/21; stalled PlaceBid aborted at 20 s: 21/21
- timer A (single setTimeout, as designed): |err| p95 6855.5 ms, max 6858.0 ms over 21 fires → target (p95 ≤ 50, max ≤ 250) NOT MET
- timer B (staged hops): |err| p95 6855.0 ms, max 6857.0 ms over 21 fires → target NOT MET
- timer C (dedicated Worker, measure-only): |err| p95 6856.0 ms, max 6858.0 ms over 21 fires → target NOT MET
- positive control (no heartbeat after release): the next wake was a cold start in 18/18 gaps

### firefox — control lanes

| lane | cycle | hb | died | last seen after fire (ms) | PlaceBid | recovery path |
|---|---|---|---|---|---|---|
| firefox-longfetch | 1 | 18 | no | 83181 | response 45003 ms | - |
| firefox-longfetch | 2 | 18 | no | 83179 | response 45012 ms | - |
| firefox-longfetch | 3 | 18 | no | 86568 | response 45008 ms | - |
| firefox-hbstop | 1 | 14 | yes | 21040 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |
| firefox-hbstop | 2 | 13 | yes | 6029 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |
| firefox-hbstop | 3 | 14 | yes | 16054 | (none recorded) | phaseAtDeath=sent ambiguous=true postReadOk=true |

### Per-cycle raw

| lane | c | wake lat | cold | alive | hold ms | hb n | hb max | A err | B err | C err | B perf err | send lag | arrival | off err | rtt | PlaceBid | died | last seen after wake | gap last tick |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chrome-main3 | 1 | 62 | true | y | 388493 | 19 | 20014 | 0.8 | 0.8 | - | 0.30 | 12 | -138 | 75.5 | 154.6 | aborted 20001 | n | 388489 | 26011 |
| chrome-main3 | 2 | 43 | true | y | 389889 | 19 | 20011 | 1.3 | 1.3 | - | 1.50 | 1 | -150 | 75.5 | 154.6 | aborted 20016 | n | 389886 | 26009 |
| chrome-main3 | 3 | 42 | true | y | 389889 | 19 | 20008 | 0.6 | 0.6 | - | 0.05 | 1 | -151 | 75.5 | 155.1 | aborted 20006 | n | 389886 | 26022 |
| chrome-main3 | 4 | 54 | true | y | 389889 | 19 | 20014 | 2.9 | 1.9 | - | 1.15 | 1 | -150 | 76.5 | 155.7 | aborted 20006 | n | 389885 | 25999 |
| chrome-main3 | 5 | 60 | true | y | 389877 | 19 | 20012 | 2.9 | 2.9 | - | 2.60 | 1 | -150 | 76.5 | 155.8 | aborted 20010 | n | 389873 | 26016 |
| chrome-main3 | 6 | 49 | true | y | 389881 | 19 | 20010 | 1.3 | 1.3 | - | 1.35 | 1 | -150 | 76.5 | 154.5 | aborted 20004 | n | 389878 | 26011 |
| chrome-main3 | 7 | 59 | true | y | 389872 | 19 | 20014 | 4.4 | 4.4 | - | 4.15 | 1 | -144 | 74.5 | 152.7 | aborted 20001 | n | 389868 | 26014 |
| chrome-main2 | 1 | 49 | true | y | 388508 | 19 | 20010 | 2.9 | 2.9 | - | 2.00 | 11 | -139 | 76.5 | 154.8 | aborted 20014 | n | 388504 | 26029 |
| chrome-main2 | 2 | 50 | true | y | 389876 | 19 | 20012 | 3.6 | 2.6 | - | 3.25 | 1 | -147 | 76.5 | 155.1 | aborted 20006 | n | 389873 | 26029 |
| chrome-main2 | 3 | 47 | true | y | 389894 | 19 | 20011 | 0.6 | 4.6 | - | 4.15 | 1 | -146 | 75.5 | 155.1 | aborted 20008 | n | 389891 | 26001 |
| chrome-main2 | 4 | 57 | true | y | 389869 | 19 | 20012 | 0.3 | 0.3 | - | 0.70 | 1 | -149 | 75.0 | 153.6 | aborted 20009 | n | 389866 | 26015 |
| chrome-main2 | 5 | 49 | true | y | 389881 | 19 | 20009 | 2.4 | 2.4 | - | 1.45 | 0 | -149 | 76.5 | 155.7 | aborted 20008 | n | 389879 | 26027 |
| chrome-main2 | 6 | 48 | true | y | 389883 | 19 | 20013 | 4.6 | 4.6 | - | 3.50 | 1 | -146 | 75.5 | 155.2 | aborted 20012 | n | 389880 | 26023 |
| chrome-main2 | 7 | 57 | true | y | 389882 | 19 | 20011 | 4.4 | 4.4 | - | 3.75 | 0 | -144 | 74.5 | 152.7 | aborted 20004 | n | 389879 | 26011 |
| chrome-main1 | 1 | 63 | true | y | 388502 | 19 | 20011 | 1.0 | 1.0 | - | 0.20 | 1 | -150 | 76.0 | 154.0 | aborted 20008 | n | 388498 | 26002 |
| chrome-main1 | 2 | 52 | true | y | 389882 | 19 | 20014 | 1.5 | 1.5 | - | 0.20 | 0 | -151 | 77.5 | 156.0 | aborted 20009 | n | 389879 | 26009 |
| chrome-main1 | 3 | 61 | true | y | 389877 | 19 | 20013 | 3.5 | 2.5 | - | 2.30 | 1 | -148 | 76.5 | 155.0 | aborted 20013 | n | 389874 | 26002 |
| chrome-main1 | 4 | 50 | true | y | 389885 | 19 | 20011 | 0.4 | 4.4 | - | 3.65 | 0 | -149 | 77.0 | 155.7 | aborted 20004 | n | 389882 | 26005 |
| chrome-main1 | 5 | 45 | true | y | 389892 | 19 | 20009 | 2.0 | 2.0 | - | 2.10 | 0 | -148 | 76.0 | 154.0 | aborted 20007 | n | 389889 | 26003 |
| chrome-main1 | 6 | 53 | true | y | 389886 | 19 | 20013 | 0.9 | 0.9 | - | 1.05 | 1 | -151 | 75.5 | 154.9 | aborted 20002 | n | 389882 | 26003 |
| chrome-main1 | 7 | 53 | true | y | 389873 | 19 | 20013 | 0.1 | -0.9 | - | 0.00 | 1 | -152 | 75.5 | 154.2 | aborted 20008 | n | 389869 | 26020 |
| chrome-longfetch | 1 | 112 | true | y | 388451 | 19 | 20013 | 2.9 | 2.9 | - | 1.75 | 12 | -136 | 75.5 | 154.7 | response 45010 | n | 388448 | 26029 |
| chrome-longfetch | 2 | 47 | true | y | 389892 | 19 | 20013 | 3.5 | 2.5 | - | 2.60 | 1 | -148 | 75.5 | 155.0 | response 45010 | n | 389889 | 26010 |
| chrome-longfetch | 3 | 42 | true | y | 389887 | 19 | 20013 | 3.4 | 3.4 | - | 2.75 | 0 | -147 | 76.5 | 154.9 | response 45010 | n | 389884 | 26028 |
| chrome-hbstop | 1 | 47 | true | n | - | 14 | 20012 | 0.3 | 0.3 | - | 0.15 | 2 | -146 | 74.5 | 153.5 | - | y | 324509 | - |
| chrome-hbstop | 2 | 57 | true | n | - | 14 | 20012 | 4.3 | 4.3 | - | 3.75 | 1 | -147 | 75.5 | 156.5 | - | y | 325890 | - |
| chrome-hbstop | 3 | 69 | true | n | - | 14 | 20007 | -0.5 | -0.5 | - | 0.10 | 1 | -150 | 75.5 | 153.0 | - | y | 325864 | - |
| firefox-main1 | 1 | 9376 | true | y | 379191 | 18 | 25164 | 6855.0 | 6855.0 | 6856.0 | 6854.00 | 6 | 6709 | 75.0 | 154.0 | aborted 20016 | n | 379176 | 29044 |
| firefox-main1 | 2 | 9390 | true | y | 380559 | 18 | 24807 | 6844.5 | 6844.5 | 6844.5 | 6844.50 | 14 | 6706 | 75.5 | 156.0 | aborted 20002 | n | 380546 | 27378 |
| firefox-main1 | 3 | 9389 | true | y | 380542 | 18 | 24269 | 6837.5 | 6838.5 | 6838.5 | 6837.50 | 8 | 6693 | 76.5 | 157.0 | aborted 20001 | n | 380520 | 27070 |
| firefox-main1 | 4 | 9363 | true | y | 380588 | 17 | 25600 | 1.0 | 1.0 | 1.0 | 2.00 | 6 | -142 | 73.5 | 152.0 | aborted 20013 | n | 380564 | 25519 |
| firefox-main1 | 5 | 9366 | true | y | 380564 | 18 | 24131 | 6842.0 | 6842.0 | 6842.0 | 6841.00 | 3 | 6694 | 75.5 | 154.0 | aborted 20012 | n | 380541 | 27596 |
| firefox-main1 | 6 | 9386 | true | y | 380560 | 17 | 25612 | 1.0 | 1.0 | 1.0 | 1.00 | 6 | -146 | 76.0 | 157.0 | aborted 20000 | n | 380547 | 30518 |
| firefox-main1 | 7 | 9379 | true | y | 380554 | 18 | 24132 | 6855.5 | 6854.5 | 6854.5 | 6855.50 | 17 | 6719 | 76.0 | 157.0 | aborted 20016 | n | 380530 | 27613 |
| firefox-main2 | 1 | 8769 | true | y | 379796 | 18 | 21879 | 6842.0 | 6842.0 | 6842.0 | 6840.00 | 6 | 6696 | 75.5 | 153.0 | aborted 20001 | n | 379783 | 28039 |
| firefox-main2 | 2 | 9390 | true | y | 380563 | 18 | 25456 | 6851.5 | 6850.5 | 6851.5 | 6850.50 | 15 | 6716 | 74.0 | 154.0 | aborted 20008 | n | 380550 | 26206 |
| firefox-main2 | 3 | 9387 | true | y | 383901 | 18 | 25603 | 6828.0 | 6828.0 | 6828.0 | 6826.00 | 4 | 6680 | 74.5 | 155.0 | aborted 20918 | n | 383889 | 25021 |
| firefox-main2 | 4 | 9388 | true | y | 380555 | 18 | 25044 | 6834.0 | 6834.0 | 6835.0 | 6834.00 | 8 | 6692 | 74.5 | 154.0 | aborted 20012 | n | 380532 | 28524 |
| firefox-main2 | 5 | 9364 | true | y | 383820 | 18 | 25591 | 6843.5 | 6843.5 | 6843.5 | 6843.50 | 16 | 6709 | 75.5 | 153.0 | aborted 20008 | n | 383798 | 30032 |
| firefox-main2 | 6 | 3007 | true | y | 386941 | 18 | 26914 | 6849.5 | 6849.5 | 6849.5 | 6847.50 | 13 | 6709 | 76.0 | 156.0 | aborted 20004 | n | 386928 | 27854 |
| firefox-main2 | 7 | 9368 | true | y | 381955 | 18 | 25590 | 6834.0 | 6834.0 | 6834.0 | 6833.00 | 4 | 6683 | 76.5 | 157.0 | aborted 20000 | n | 381931 | 25035 |
| firefox-main3 | 1 | 15 | true | y | 391740 | 19 | 25591 | 6846.0 | 6846.0 | 6846.0 | 6845.00 | 14 | 6707 | 76.0 | 156.0 | aborted 20724 | n | 391721 | 30018 |
| firefox-main3 | 2 | 8058 | true | y | 381893 | 18 | 25388 | 6854.5 | 6854.5 | 6854.5 | 6853.50 | 17 | 6722 | 74.0 | 153.0 | aborted 20013 | n | 381881 | 25638 |
| firefox-main3 | 3 | 12 | true | y | 389940 | 18 | 26931 | 6834.0 | 6834.0 | 6834.0 | 6834.00 | 5 | 6687 | 75.5 | 155.0 | aborted 20003 | n | 389918 | 29836 |
| firefox-main3 | 4 | 9393 | true | y | 380546 | 18 | 25510 | 6835.5 | 6835.5 | 6835.5 | 6834.50 | 6 | 6689 | 76.0 | 156.0 | aborted 20006 | n | 380523 | 26742 |
| firefox-main3 | 5 | 9381 | true | y | 386676 | 17 | 25594 | 6852.0 | 6852.0 | 6852.0 | 6851.00 | 5 | 6705 | 75.0 | 156.0 | aborted 23647 | n | 386653 | 25023 |
| firefox-main3 | 6 | 9377 | true | y | 380560 | 18 | 25074 | 6845.0 | 6844.0 | 6844.0 | 6843.00 | 6 | 6695 | 75.5 | 157.0 | aborted 20007 | n | 380537 | 28881 |
| firefox-main3 | 7 | 9380 | true | y | 383914 | 18 | 25610 | 6858.0 | 6857.0 | 6858.0 | 6856.00 | 14 | 6721 | 74.5 | 154.0 | aborted 20003 | n | 383890 | 0 |
| firefox-longfetch | 1 | 9375 | true | y | 379186 | 18 | 25862 | 6832.5 | 6832.5 | 6832.5 | 6832.50 | 5 | 6686 | 75.0 | 155.0 | response 45003 | n | 379172 | 28863 |
| firefox-longfetch | 2 | 9372 | true | y | 380581 | 18 | 25447 | 6851.0 | 6851.0 | 6851.0 | 6851.00 | 15 | 6714 | 75.0 | 154.0 | response 45012 | n | 380559 | 26085 |
| firefox-longfetch | 3 | 9378 | true | y | 383962 | 18 | 25593 | 6850.0 | 6850.0 | 6850.0 | 6850.00 | 8 | 6705 | 75.5 | 155.0 | response 45008 | n | 383951 | 25035 |
| firefox-hbstop | 1 | 5430 | true | n | - | 14 | 23805 | 6837.5 | 6837.5 | 6837.5 | 6838.50 | 5 | 6689 | 76.0 | 155.0 | - | y | 320977 | - |
| firefox-hbstop | 2 | 9380 | true | n | - | 13 | 25607 | 6848.5 | 6848.5 | 6848.5 | 6849.50 | 13 | 6710 | 75.0 | 155.0 | - | y | 303399 | - |
| firefox-hbstop | 3 | 9392 | true | n | - | 14 | 21863 | 6836.5 | 6836.5 | 6836.5 | 6837.50 | 16 | 6703 | 75.0 | 153.0 | - | y | 313409 | - |

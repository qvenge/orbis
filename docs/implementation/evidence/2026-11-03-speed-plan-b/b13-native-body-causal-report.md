# Б13 — функциональный trace сохранения при открытом detail и боковом чате

Exact a0 normal dist, local Chrome156, real Hono on loopback and PostgreSQL54339, actual LISTEN. Test ran once and returned exit0, 10 assertions. Actual saved record and live side chat ready via rendered thread tail and composer. No external auth, service worker blocked to isolate live request path. This one trace counts reads, not latency or hardware performance.

| Window | Body POST | entity.get | Chat reads | Watch opens | SSE ping | reconcile |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 seconds of actual body input, 43 strokes | 6 | 0 | 0 | 0 | 0 | 0 |
| Strict normal ACK, before GET release | 1 | 0 | 0 | 0 | 0 | 0 |
| 6 seconds after ACK, no new input | 0 | 0 | 0 | 0 | 0 | 0 |

Startup watch was verified separately. All target credentialed GETs were gated during the strict phase, with pre-window ungated GETs drained and the same prior revision verified in server and disk. An actual update committed and returned HTTP200 tx55042, record ID, bodyRevision8 and full bodyDoc. While that reply was held, the exact input token basis revision7 was checkpointed and durable cache stayed at rev7. After releasing only the ACK, the same complete bodyDoc/rev8 became durable and the exact token was absent from the native slot. Only then was the target GET gate released. No target GET was attempted in that window. Side chat tail and editor text remained visible afterwards.

Source SHA 15ad35dd4e070a3bb5d583adc47b62642e953c08be7e77994912960f792a2e37. Raw test and command files in `/private/tmp/orbis-b13-final-ci.07CROy/reports/native-body-read-causality.*`, index `b13-native-body-causal-evidence.sha256`. This supplies missing causal normal ACK proof and one functional read-count check. Performance gates remain measured RED/deferred, per owner decision.

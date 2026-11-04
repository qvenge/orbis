# Б13 — причинный контроль двух nav таймаутов

Exact a0bff516be98680685b790908ef76cc4f949f49c. Full и 4/4 unchanged named reds на a0/b5 сохранены в primary packet. В полном a0 и обоих новых cold probes выбрана верная запись, красная первая проверка exact heading ещё до жеста.

| Sibling control, ms relative to fixture start | Heading wait | Loader start → resolve | Heading outcome | Mock GET |
| --- | ---: | ---: | ---: | --- |
| Back/site cold | 125,6 | 297,8→1701,8 | timeout1132,6 | ни одного до timeout |
| Settings cold | 85,8 | 31,0→1623,3 | timeout1095,9 | ни одного до timeout |
| Back/site preloaded | 1312,8 | pre-load0,6→1204,5; route1494,6→1539,4 | visible1731,9, дальнейшие Back assertions PASS | E2 entered1560,9, reply1561,2 |
| Settings preloaded | 1257,9 | pre-load0,7→1170,8; route1201,5→1452,9 | visible1727,7, Settings→Back assertions PASS | E1 entered1551,2, reply1551,6 |

Both warm controls await actual loadDetailScreen before render. The probe logs address/loader/GET/heading to NDJSON and keeps original 1s wait and semantic assertions. In these observed failures the startup test import remains pending after the heading timeout, before the query handler runs. The tests mount ungated App, separate from product auth bootstrap and from native cold performance evidence.

Minimal test-only beforeAll setup now freezes two original test paths, apps/web/src/app/{back-nav,settings-nav}.test.tsx, in /private/tmp/orbis-b13-nav-fixture.4P1hQ0. No fixtures, waits or test-body assertions changed. On exact a0 + those two files, targeted **4 PASS**, scoped Biome0 and diff check0. Exact run /private/tmp/orbis-b13-final-ci.07CROy/nav-fixture. Original full workspace exit1 remains. Product files remain byte-identical a0; no shared changes applied by author.

- Source manifest c8935d2a57bcc49481d80071878cf3aa67880e07ad3be3722e3913cd61d09046, diff f9387373348b1b13785e0139f55462d1539210f7b3ecc83f56271210e3a2fc25.
- Raw diagnostics and validation commands/exits in /private/tmp/orbis-b13-final-ci.07CROy/reports, indexed in b13-final-nav-fixture-evidence.sha256.

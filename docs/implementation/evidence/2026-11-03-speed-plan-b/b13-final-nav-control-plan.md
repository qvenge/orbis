# Б13 — два web-отказа навигации в полном a0

Source-only during existing CI. `/private/tmp/orbis-b13-final-ci.07CROy/reports/b13-ci-test.log` first two web failures, web summary 3059 passed, 2 failed, 2 skipped. Controls below are prepared, no extra run yet.

| Exact name | First failing expectation | Evidence from DOM |
| --- | --- | --- |
| `src/app/back-nav.test.tsx` — «‹» снимает верх стопки (site) — на уровень, не до корня | Line 48 exact E2 heading, before any click Back. 1249ms. | Main `data-place=/r/22222222-2222-4222-8222-222222222222` reached, host frame rendered. Dump truncates before screen content, cannot identify lazy-vs-data on this failure. Preceding logs show direct `useNav.openRecord` outside act. Same 882 failure passed exact isolated 1-worker name. |
| `src/app/settings-nav.test.tsx` — «⋯ → Настройки» открывает настройки поверх раздела; «‹» — обратно в раздел | Line 47 exact E1 heading, before any click menu or Back. 1289ms. | Correct `data-place=/r/11111111-1111-4111-8111-111111111111`, header ellipsis and exact three `h-9` `gap-2` skeletons from `ScreenFallback`, twice in error. The loaded `DetailScreen` data loader uses different four skeletons `gap-4`; this dump localizes to pending screen boundary. Second Settings case passed. |

Both test bodies byte-identical 882→a0. b5 test differences are wire fixtures (`entity.query` shape and chat route), navigation assertions unchanged. Test harness mounts ungated `App`, unlike actual auth startup. Ungated `App` does not include `StartupReads`; this semantic navigation test reaches the production lazy route but has default Testing Library 1s wait. Observations show record selection in both cases and pending screen chunk in Settings. They do not prove navigation is wrong or determine the Back root cause. Actual Chrome cold/after-B remain separate gates.

After quiet suite/perf/build/guards release, run these unchanged names with exact archived dependencies, default individual waits, one Vitest worker, native output per base.

```sh
cd /private/tmp/orbis-b13-final-ci.07CROy/candidate/apps/web
bun x --no-install vitest run --maxWorkers=1 src/app/back-nav.test.tsx -t 'снимает верх стопки \(site\)'
bun x --no-install vitest run --maxWorkers=1 src/app/settings-nav.test.tsx -t 'открывает настройки поверх раздела'
cd /private/tmp/orbis-b13-ci.F6FMiU/before-b-control/apps/web
# Same unchanged names, using the original b5 test files/aliases.
bun x --no-install vitest run --maxWorkers=1 src/app/back-nav.test.tsx -t 'снимает верх стопки \(site\)'
bun x --no-install vitest run --maxWorkers=1 src/app/settings-nav.test.tsx -t 'открывает настройки поверх раздела'
```

Keep both full-run reds even if named runs pass. If either persists, use a focused diagnostic sibling to track loader start/resolve, model address, tRPC handler call/response and visible heading in order with unchanged wait. A separately warmed exact loader before render can distinguish a cold test-transform issue from normal routing and GET if the source evidence warrants. Do not rewrite navigation assertions, inflate waits or infer a product defect from a timeout alone.

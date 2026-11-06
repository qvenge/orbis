# One static SW admission control: ready boundary observed

Approved source01e2906c ran once14:32:16–14:32:34 UTC, private raw `/private/tmp/orbis-cutover-sw-admission.ohlsh3nd`. Real Node23.11/fixed public pipe/PW1.63/Chrome156; actual frozen old/current SW/registration/workbox/assets7b/2ec; identical empty HTML replaces App/index fallback. No Auth, DB, Docker, Hono, business UI, old P profile, retry or product/source change.

**Exit1 at the bounded8s current-bypass:navigator.ready await.** Not reg.update/reset: neither was started in the suspect branch. Actual window.load resolved14:32:25.728; page-side ready-before14:32:25.741 observed documentState=complete, loaded=true, controller=null. No ready-resolved marker appeared; the bound rejected14:32:33.726. First failure remains ready timeout; cleanup did not mask it.

Before that failure, current SW + the SAME empty probe WITHOUT bypass passed load, navigator.ready, reg.update and public protocol1 observation in a separate NEW blank profile. Worker reported ready=false, as expected for a probe that does not fake app challenge participation; this was never called business-page readiness. The second fresh profile then passed actual old-worker load/ready/active/controller baseline and whole browser close before old→current+bypass.

This controls current-worker/nonparticipating-probe capability. It does not isolate bypass alone: the suspect case also has old→current registration/cache history. Original P3 had no internal markers, so this control does not retroactively prove its exact await/cause. It establishes the precise independent control boundary and shows real window.load occurred; an ordinary-new-context proof was not reached. No P/business/privacy PASS.

Cleanup used public browser-level close and actual PID/start reconciliation. All three launched Chrome instances closed, Normal/Singleton checks completed, supervisor exit1/runnerExit1 with watchdog=false, monitorError=null, cleanupErrors=[], forcedRunner=false, forcedBrowser=false, remaining=[]. Global90s watchdog was not needed. CPU/browser resources are free; Docker/DB remain stopped. No further runtime or source fix followed.

Public copies redact hostname if present; raw/control profiles remain private and preserved. Profile manifests refer only to the two fresh control profiles, never user/P input. Code5-file packet01e2906c is unchanged. Evidence is `evidence/SHA256SUMS`; `evidence/summary.json` contains exact labels/timestamps and the unstarted update/reset/ordinary stages. Root owns any next source/control decision.

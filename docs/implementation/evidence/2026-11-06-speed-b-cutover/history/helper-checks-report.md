# Bounded light helper checks

Final covering result: **25 controls PASS**, Node syntax PASS, isolated Node and Bun harness types PASS. Real runtime probe verified Node23.11.0 (not Bun); readonly helper children verified Bun1.2.7. No Docker/Desktop/container, DB, Chrome, App, application build or full CI was started. Machine load stayed around2.12→2.03 during the initial7.63s series,2.37→2.42 in targeted4.94s repeat, then1.72 during types; no load fence triggered. All supervised runs ended remaining=[] without watchdog intervention. Deliberate UNKNOWN inside a supervisor test remained nonzero/remaining=null, then the test's separately verified owned PID/start cleanup removed its synthetic child.

## Covering checks and preserved REDs

| Scope | Final evidence |
|---|---|
| HTTP6/6 | normal held GET; UTF-8 POST/application headers; independent Set-Cookie; absolute-form proxy403 without external DNS; SSE first chunk+abort/cancel; held disconnect and force-stop listener closed; CONNECT403 to a local proxy (no external socket) |
| IPC/platform13/13 | older retained sequence0; exact later token; foreign/expired/invalid-lineage/acknowledged/finished native rejected; public legacy codec live/expired/finished/invalid; readonly Bun child registration/close; post-spawn EISDIR cleanup/evidence; fast-exit stdout/stderr after exit |
| Supervisor6/6 | canonical four regressions unchanged plus actual owned Bun deadline cleanup and persistent-census UNKNOWN/nonzero, with separate test cleanup |
| Syntax/types | Node23 --check rehearsal; minimal NodeNext/ES2024 Node files and Bundler/bun-types Bun files, no full web/server compilation |

Initial fe191 bytes are preserved in `before-helper-checks-fe191/`. Initial raw `/private/tmp/orbis-cutover-light.i5upjdtq` contains HTTP/supervisor PASS but IPC/type RED; it was not rewritten as PASS. Targeted raw `/private/tmp/orbis-cutover-light-repeat.m52i0iy1` contains13/13 IPC/platform PASS and the intermediate type-declaration failures. Types raw `/private/tmp/orbis-cutover-types.ae8cuyh1` retains the final intermediate Node ES2023-lib error and Bun PASS; final Node ES2024 command completed exit0 with empty stdout/stderr, explicitly recorded as a tool-completion observation rather than backfilling old results.

The remaining explicit CONNECT contract was run alone with a7s deadline and passed; the already-passing HTTP5 were not repeated. The initial serial execution used85s+5s supervisor, targeted repeat35s+5s, isolated types15s+5s; each finished in seconds. The final Node-only type retry was a direct completed command, not falsely attributed to the preceding supervisor. These were small serial checks, not performance benchmarks.

## Only proven source fix

`node-platform.ts` now converts stdout/stderr to web streams immediately after spawn, before registration awaits. Actual fast-exit failures had produced disturbed/locked Response bodies when Node flushStdio resumed an already-exited child before capture. The new fast-exit regression reads both outputs after child.exited and passes. True fix-only diff `helper-output-fix.diff` SHA29c718bcaca8c4deacb570fa3f8bb49a9084a0ccb674156fe44b7fe75ef54580; tested packet **3d1f58fa96323e92321af807e4bf349aa839734d3d18b5578388006ec7804012** in `helper-checked-3d1/`.

The IPC env RED was a test fixture omission: it lacked the runtime's existing cwd:verified-current-tree. Bun loaded worktree dotenv despite PATH-only env, and the strict credential-absence guard rejected before validators/DB/network. A boolean-only counterfactual confirmed worktree credentials-present vs clean c7 credentials-absent. Correcting test cwd passes; no guard was weakened, no .env edited or credential printed. Types setup used the already-installed bun-types and separate runtime-specific module/type declarations; no dependencies installed, unchanged Bun launcher imports retained.

P710 positive phase body/all its assertions remain byte-equal after the existing Bun.write→writeFile platform rename. No P waits/payload/UUID/DB/action/auth/recovery semantics changed. All new checks are test-only; no old signer/profile resume.

## Separate future allocation leaf

`allocation-p-node-proposal/` derives from the tested3d1 snapshot and changes only Node identity, Bun identity and preflight physical bindings: exact name `orbis-speed-b-cutover-p-node`, loopback54346, label `orbis.cutover.lane=p-node`, LaneP. Actual DB identity SQL, roles/admin isolation and current JSON2ec1888a remain unchanged. Leaf packet681f2474885bbc42f260d1e52da72851ff6e2a996f975626f6c035cd09d0e4f5; diffbc311beb7267997439f66af185295aee3747b2b5aef2f46345962d490db4a630. It is SOURCE ONLY, not allocated/runtime-tested. Container ID/system ID/handoff SHA remain pending and fail closed. Old stopped54345/df2/0027 is retained, never renamed/deleted/reset.

Next gate: scoped SAME review of the output-capture fix and separate physical-binding delta; root issues actual allocation IDs/handoff and runtime permission later. Helper PASS does not qualify the full Node P procedure or native/field cutover. All owned helpers are gone; Docker remains off.

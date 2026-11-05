# Root-only Safari continuation — source prepared

Run once only after source review, against the same root-owned session and descriptor as the completed Mac strict ACK check:

    python3 recovery-client.py ROOT_OWNED_SESSION_ID /private/tmp/orbis-safari-functional.DBIeYK/fixture.json

The client reuses the reviewed transport/descriptor/origin guards and pinned prepare-editor, storage-snapshot and real full-document read scripts from strict-ack-client0bb57187. It sends API requests only to session55371 and the exact fixture control/state endpoints. It creates no session, process, browser window, setting, fixture or storage state. All HTTP request/response records and snapshots go into a new recovery-client subdirectory beside fixture.json. Python AST syntax was checked without executing the client.

The continuation requires the existing successful strict phase, an unchanged matching server body/revision, released read gate and no live local input. This rejects an attempted rerun after partial recovery work. It checks the remaining original JWT lifetime before each bounded phase and never extends it.

The client performs these actual actions:

1. Refresh the same automation session, open the editor through the actual preview when necessary, and compare visible text and full durable document with the real saved server body. It rejects a body POST during this saved-body reload.
2. Mark only the stand's tRPC backend unavailable503 and type a unique B with real WebDriver sendKeys. Capture actual pending full document and exact owner/graph/entity/writer/sequence/generation/nonce/basis token. State confirms the real server remained at saved A.
3. Refresh in the same session while the backend still returns503. Observe actual cached A and exactly preserved B token/document.
4. Use the reviewed control to make a real foreign CAS C while the API is still503. Restore that backend, refresh, and read current C through the real own-origin entity.get before any recovery gesture. The UI must show C and the recovery banner, while B's full document/token remain. Observe the period through normal debounce and reject any entity.update POST or automatic B overwrite before the gesture.
5. Find the actual banner button with XPath under data-testid=draft-banner and text Оставить моё, as defined by EntityBody.tsx DraftBanner. Click using WebDriver. Observe the real own-record B body ACK, matching full bodyDoc/revision/server text, durable matching response, retirement of precisely B's nonce and removal of that offer. No direct full-document fetch is issued after the recovery click.

The outage is confined to this own backend. It does not establish global Safari offline behavior. Refresh retains the same WebDriver session. It does not establish normal browser-profile restart or installed PWA behavior. This continuation records normal recovery ACK and durability. The prior strict client supplied the separate causal ACK-before-GET proof.

A mismatch or unexpected runtime returns nonzero and preserves actual state. The script does not restore backend controls on failure. Root inspects evidence and directs cleanup or a bounded diagnosis. The source contains no product timeout changes, injected editor state or fabricated feed events.

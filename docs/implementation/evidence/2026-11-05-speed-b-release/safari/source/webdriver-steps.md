# Root-executed WebDriver steps

This is a prepared sequence. Use the session root explicitly owns on http://127.0.0.1:55371. The stand does not create/delete driver sessions or change Safari settings. All evidence is synthetic and scoped to the new descriptor origin. Current launcher and browser probes have not run.

Request payload templates are capabilities.request.json, prepare-editor.request.json and storage-snapshot.request.json. Before sending, use jq to replace args from fixture.json. The JS includes an exact-origin check.

    jq --arg origin "$fixture_origin" '.args=[$origin]' capabilities.request.json
    jq --arg origin "$fixture_origin" '.args=[$origin]' prepare-editor.request.json
    jq --arg origin "$fixture_origin" --arg owner "$fixture_owner" --arg record "$fixture_record"       '.args=[$origin,$owner,$record]' storage-snapshot.request.json

Send JSON with curl to root-owned /session/$SESSION/execute/async for capabilities and storage snapshot, and execute/sync for prepare-editor. Preserve each request, response, HTTP code and timestamp. Safari-specific commands outside this session remain root's responsibility.

| Stage | HTTP action | Evidence expected |
| --- | --- | --- |
| Bootstrap | POST /session/$SESSION/url with descriptor bootstrapURL | Current URL becomes the exact recordURL. Only that origin receives the synthetic credential. |
| Capabilities | POST execute/async with capabilities payload | Actual Safari userAgent, secureContext, IndexedDB/CacheStorage/SW/locks availability, actual registration/controller and cache names. Missing capability is a finding, not an assumed substitute. |
| Ready | POST elements with CSS [data-testid="editor-preview"]; click only this element if present | Then find CSS [data-testid="body-editor"] [contenteditable="true"]. Initial text equals descriptor initialBody. Do not use only the page heading as readiness. |
| Baseline | GET own descriptor stateURL through root curl; execute storage snapshot | Actual server record/revision and persisted detail. Snapshot reads only known synthetic owner/record stores. A missing-store open aborts before creation. |
| Arm causal ACK phase | POST own controlURL body {"holdNextSave":true} | Atomically close the gate for all new authenticated entity.get reads of this record. Poll stateURL until ackPhase.drained=true and preexistingRecordGetsRemaining=0 before typing. The counter records reads already in flight at arm. No other body edit occurs during draining. |
| Type | Execute prepare-editor, then POST /session/$SESSION/element/$ELEMENT/value body {"text":"Safari saved <unique marker>"} | Actual editable DOM contains exact text. Input snapshot identifies exact nonce/writer/generation. The WebDriver element ID is the standard element-6066-11e4-a52e-4f735466cecf field from the find-element response. |
| Commit observed | Poll own stateURL until ackPhase.receipt | The observer identifies an own-record BODY entity.update from its actual wire request, requiring full bodyDoc and positive expectedBodyRevision. It records full sent input, canonical request/bodyDoc hashes, actual response bodyDoc/revision/txId and response hash. A title-only update does not qualify even if its response contains bodyDoc. Client ACK and all new target reads remain held. Stored response should retain the prior revision. |
| Bind observed token | POST controlURL {"bindInput":<actual input snapshot from Safari>} | Use the exact native snapshot {token,doc} or emergency {inputToken,doc}, without creating/editing a token. Server verifies owner/graph/record, writer/nonce/sequence/generation, token basis revision and exact canonical sent doc. Preserve before-ACK snapshot as independent evidence. A mismatch returns409. |
| Release ACK only | POST controlURL {"releaseSave":true}; poll storage snapshots | Actual ACK is released while target reads remain blocked. Matching full bodyDoc/revision must become durable and the exact bound nonce must retire. If storage fails, preserve its fallback observation and end the strict proof as unavailable. |
| Prove durable before GET | POST controlURL {"confirmDurable":<actual storage-snapshot result>} | Server checks own origin, a persisted matching body/revision, available input-store snapshot and absence of that nonce from live native/emergency copies. Physical tombstoned head may remain. The snapshot hash and exact token are logged while all new target reads remain gated. A missing/mismatching snapshot returns409. |
| Release target reads | POST controlURL {"releaseReads":true} | Accepted only after confirmDurable. Server logs held-read count. Keep the evidence order ACK release → durable/token retirement → GET release. |
| Reload | POST /session/$SESSION/refresh | Same session/own origin renders the saved body. State and HTTP event log show no unexpected new save. Snapshot follows actual recovery/cache behavior. |
| Backend unavailable | POST controlURL {"unavailable":true}; prepare editor and send a second unique local body | Only this own backend returns503 for tRPC, static shell and fixture control remain available. Capture exact local input token in IDB/emergency storage and the actual status UI. This is an own-backend outage, not Safari-wide offline mode. |
| Same-session reload | POST /session/$SESSION/refresh | Actual cached/fallback screen and input remain accessible, or record the precise failure. Do not rely on live GET success. |
| Conflict recovery | While unavailable, POST controlURL {"foreignBody":"Safari foreign confirmed <marker>"}; then {"unavailable":false}; refresh | The control performs a real production CAS on the one fixture record. Browser displays current foreign body and offers preserved local text. Snapshot proves original local token and body. Server state proves foreign content was not overwritten automatically. |
| Explicit recovery | Find CSS [data-testid="draft-banner"], inspect button text and choose Оставить моё only when this synthetic fixture is the current page | Actual save ACK after the supported choice, matching server text/revision. Capture token retirement or retained fallback as observed. Keep an untouched snapshot before selecting recovery. |
| SW result | Execute capabilities again | Actual app-created registration/controller/cache. Do not manually register a worker to make this stage pass. This does not prove an installed PWA or ordinary browser-profile restart. |
| Close | Root deletes only its Safari WebDriver session and stops only this launcher after saving evidence | Safari automation storage may be cleared when its session ends. No claim of normal browser restart durability. The synthetic graph stays for inspection. |

Find-element request example:

    {"using":"css selector","value":"[data-testid=\"body-editor\"] [contenteditable=\"true\"]"}

The token-before-ACK and durable snapshots are actual fixture observations. The fixture counter drains preexisting matching reads and captures only the armed BODY request. The control API observes captured snapshots and never writes browser storage. If its native checkpoint never appears while the request is held, use emergency records and report the branch, or stop for a bounded diagnosis. Never insert a token or response record into IDB to satisfy the result.

Auth port54321 is occupied. No fake auth listener or requests to it are part of this stand. The probe-only response CSP blocks cross-origin connects; the seeded JWT lifetime is one hour. Login, refresh and expiry are untested by design. Exceeding the lifetime ends the fixture window and requires a new bounded plan rather than access to the existing Supabase listener.

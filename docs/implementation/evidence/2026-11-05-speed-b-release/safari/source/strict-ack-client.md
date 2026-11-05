# Root-only batch client — prepared, not executed

The launcher is already separate and root retains Safari ownership. This client only sends bounded HTTP requests to an existing root-supplied session on 127.0.0.1:55371 and the exact descriptor origin. It creates no sessions, processes, windows, settings, tokens, fixtures or browser storage. It does not navigate. Root must first finish bootstrap, open the actual body editor and observe the initial persisted body.

Invocation after source approval:

    python3 strict-ack-client.py ROOT_OWNED_SESSION_ID /private/tmp/orbis-safari-functional.DBIeYK/fixture.json

The two positional arguments are the entire interface. Fixed source356 and normal manifest15144519 are verified. The descriptor path, loopback origins, routes and lifetime are checked. Environment HTTP proxies are disabled. The ready-editor and storage scripts are pinned by SHA256, and both verify the browser origin. Every browser HTTP operation is scoped to the supplied session; the script never calls new-session, delete-session, timeout, window or Safari-specific configuration endpoints.

Before arming, the script reads the full bodyDoc with one actual own-origin entity.get requesting body and bodyDoc. The hashed script uses only the exact synthetic account credential on its own origin and never returns the credential. It requires that response to match the fixture state revision and the prior persisted full document. The read is completed before arming and is covered by the server old-read drain counter. A 24-second deadline starts at arming. It drains old target reads, sends the unique body using actual WebDriver element.value, observes the matching BODY request and HTTP ACK, captures and binds the exact pending token, releases ACK alone, waits for the matching durable full body/revision and exact-token retirement, confirms that snapshot with the fixture, then releases target GETs. The typed marker must appear in the actual request, ACK bodyDoc and live editor. This deadline leaves room under the existing product give-up window. Product timeouts are not changed.

All requests and responses, before-ACK token snapshot and durable-before-GET snapshot are saved to a new private subdirectory next to fixture.json. The script outputs ok:true only after the fixture confirms the receipt hash, exact token, durable snapshot hash and read-gate release. A failure leaves gates for root inspection and returns nonzero. Root then inspects actual server/browser state and chooses cleanup or bounded diagnosis. A failed client must not be rerun against the same active ACK phase as though it were a fresh fixture.

Only Python AST syntax was checked here. The client has made no HTTP request and has not been used against the Safari driver.

The first client2524966f failed before arming with KeyError bodyDoc because the fixture state endpoint requests only body. Its raw directory strict-ack-36ac1dd4 is retained. This delta corrects only that initial-read contract. It does not change the running server, timeouts, input expectations, ACK gate ordering, or durable/retirement checks. The new full-document fetch runs only in the initial stage, never after ACK release.

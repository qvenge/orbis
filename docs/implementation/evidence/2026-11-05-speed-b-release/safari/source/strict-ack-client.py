"""Root-executed HTTP client for an existing Safari session. Never run on import."""
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from uuid import UUID, uuid4

DRIVER = "http://127.0.0.1:55371"
SOURCE = "356a610f5ae92efe429bdb6891c5bde6f9c09e9f"
MANIFEST = "15144519575777a82e0e75728de0a1bd4f3c02eb0c1ca41fdce746635b03b4ea"
SCRIPTS = {
    "prepare-editor.js": "8b65b02a103ce7538cea4a1ca8d9b74996bfee809d5534445ba74de0d121a39c",
    "storage-snapshot.js": "1e06c5ed18b98e43bf5d13e534c385e5a636eecae84810d552f5e493ec0c71cd",
    "read-server-body.js": "862d330e9148a44256955716baf656ac95664dc773677dd9ec4b5e34bf653613",
}
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", sys.argv[1]):
        raise ValueError("Supply only the root-owned session ID and fixture.json path")
    session_id = sys.argv[1]
    descriptor_path = Path(sys.argv[2]).resolve(strict=True)
    if not str(descriptor_path).startswith("/private/tmp/orbis-safari-functional.") or descriptor_path.name != "fixture.json":
        raise ValueError("Unexpected fixture descriptor")
    descriptor = json.loads(descriptor_path.read_text())
    if descriptor["source"] != SOURCE or descriptor["artifactManifest"] != MANIFEST:
        raise ValueError("Unexpected source or artifact")
    origin = descriptor["origin"]
    parsed = urlsplit(origin)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or
            not parsed.port or parsed.port in (54321, 54339, 55371) or
            parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError("Unexpected fixture origin")
    owner, record = descriptor["owner"], descriptor["recordId"]
    UUID(owner)
    UUID(record)
    for name in ("stateURL", "controlURL", "recordURL"):
        url = urlsplit(descriptor[name])
        if (url.scheme + "://" + url.netloc != origin or url.query or url.fragment):
            raise ValueError("Unexpected fixture route")
    if urlsplit(descriptor["recordURL"]).path != "/r/" + record:
        raise ValueError("Wrong fixture record route")
    if descriptor["expiresAt"] - time.time() < 120:
        raise ValueError("Fixture credential window is ending")
    root = Path(__file__).resolve().parent
    scripts = {}
    for name, expected in SCRIPTS.items():
        raw = (root / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("Reviewed script bytes differ")
        scripts[name] = raw.decode()
    out = descriptor_path.parent / ("strict-ack-" + uuid4().hex[:8])
    out.mkdir(mode=0o700)
    opener = build_opener(ProxyHandler({}))
    deadline = None
    sequence = 0
    stage = "initial"

    def save(name, value):
        (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def call(url, method="GET", payload=None):
        nonlocal sequence
        allowed = url.startswith(DRIVER + "/session/" + session_id + "/")
        allowed = allowed or url in (descriptor["stateURL"], descriptor["controlURL"])
        if not allowed:
            raise ValueError("Unapproved HTTP target")
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise TimeoutError("Bounded ACK window ended; inspect the retained server gates")
        sequence += 1
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(url, data=body, method=method,
                          headers={"Content-Type": "application/json"} if body is not None else {})
        save(f"{sequence:03d}-request.json", {"url": url, "method": method, "body": payload})
        try:
            with opener.open(request, timeout=min(8, remaining) if remaining is not None else 8) as response:
                code, raw = response.status, response.read()
        except HTTPError as error:
            code, raw = error.code, error.read()
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            value = {"raw": raw.decode(errors="replace")}
        save(f"{sequence:03d}-response.json", {"status": code, "value": value})
        if not 200 <= code < 300:
            raise RuntimeError(f"HTTP {code} at {stage}")
        return value

    def driver(path, payload=None, method="POST"):
        result = call(DRIVER + "/session/" + session_id + "/" + path, method, payload)
        value = result.get("value")
        if isinstance(value, dict) and "error" in value:
            raise RuntimeError("WebDriver error " + str(value["error"]))
        return value

    def own_page():
        current = driver("url", method="GET")
        if current != descriptor["recordURL"]:
            raise ValueError("Safari is not on the exact fixture record")

    def snapshot():
        own_page()
        result = driver("execute/async", {
            "script": scripts["storage-snapshot.js"], "args": [origin, owner, record],
        })
        if result.get("origin") != origin or "error" in result:
            raise RuntimeError("Own-origin storage observation failed")
        return result

    def state():
        value = call(descriptor["stateURL"])
        if value.get("owner") != owner or value.get("recordId") != record:
            raise ValueError("Fixture identity differs")
        return value

    def control(value):
        return call(descriptor["controlURL"], "POST", value)

    def poll(read, accepts, label):
        while True:
            value = read()
            if accepts(value):
                return value
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(label)
            time.sleep(0.1)

    try:
        own_page()
        initial = state()
        if initial.get("unavailable") or initial.get("ackPhase"):
            raise ValueError("Use a ready fixture with no earlier ACK phase")
        stage = "initial-server-document"
        own_page()
        server_body = driver("execute/async", {
            "script": scripts["read-server-body.js"], "args": [origin, owner, record],
        })
        if (server_body.get("origin") != origin or server_body.get("recordId") != record or
                server_body.get("status") != 200 or not isinstance(server_body.get("bodyDoc"), dict) or
                server_body.get("bodyRevision") != initial["bodyRevision"]):
            raise ValueError("Initial real server document is missing or changed")
        save("initial-server-body.json", server_body)
        before = snapshot()
        ready_rows = before.get("responses", {}).get("rows", [])
        if not before.get("responses", {}).get("available") or not any(
                row.get("data", {}).get("entity", {}).get("bodyRevision") == server_body["bodyRevision"] and
                row["data"]["entity"].get("bodyDoc") == server_body["bodyDoc"] for row in ready_rows):
            raise ValueError("Initial durable body differs from the real server document")
        save("before.json", before)
        prepared = driver("execute/sync", {"script": scripts["prepare-editor.js"], "args": [origin]})
        if not prepared.get("ready"):
            raise ValueError("Editor is not ready")
        field = driver("element", {"using": "css selector",
                                  "value": '[data-testid="body-editor"] [contenteditable="true"]'})
        element_id = field[ELEMENT]
        stage = "arm-and-drain"
        deadline = time.monotonic() + 24
        control({"holdNextSave": True})
        poll(state, lambda value: value["ackPhase"]["drained"], "Old reads did not drain")
        stage = "native-sendkeys"
        text = "Safari strict ACK " + uuid4().hex[:12]
        own_page()
        driver("element/" + quote(element_id, safe="") + "/value", {"text": text})
        stage = "held-body-receipt"
        held = poll(state, lambda value: bool(value["ackPhase"]["receipt"]), "No real body ACK")
        phase = held["ackPhase"]
        sent, receipt = phase["sent"], phase["receipt"]
        if (sent["id"] != record or sent["expectedBodyRevision"] != initial["bodyRevision"] or
                receipt["id"] != record or receipt["status"] != 200 or
                receipt["bodyRevision"] <= sent["expectedBodyRevision"] or
                text not in json.dumps(sent["bodyDoc"], ensure_ascii=False) or
                text not in json.dumps(receipt["bodyDoc"], ensure_ascii=False)):
            raise ValueError("Held response is not the expected typed body mutation")

        def matching_input(value):
            candidates = []
            for row in value.get("inputs", {}).get("rows", []):
                candidates.extend([row.get("snapshot"), row.get("acknowledgedFallback")])
            candidates.extend(copy.get("draft") for copy in value.get("emergency", []) if not copy.get("finished"))
            for candidate in candidates:
                if not candidate or candidate.get("acknowledged"):
                    continue
                token = candidate.get("token") or candidate.get("inputToken")
                if (token and token.get("accountId") == owner and token.get("entityId") == record and
                        token.get("basis", {}).get("revision") == sent["expectedBodyRevision"] and
                        candidate.get("doc") == sent["bodyDoc"]):
                    return candidate
            return None

        stage = "bind-exact-input"
        observed = poll(snapshot, lambda value: matching_input(value) is not None, "Matching input was not observed")
        exact = matching_input(observed)
        token = exact.get("token") or exact["inputToken"]
        save("input-before-ack.json", observed)
        control({"bindInput": exact})
        stage = "release-only-ack"
        control({"releaseSave": True})

        def durable_and_retired(value):
            if (not value.get("responses", {}).get("available") or
                    not value.get("inputs", {}).get("available") or value.get("emergencyError")):
                return False
            durable = any(
                row.get("data", {}).get("entity", {}).get("bodyRevision") == receipt["bodyRevision"] and
                row["data"]["entity"].get("bodyDoc") == receipt["bodyDoc"]
                for row in value["responses"].get("rows", []))
            live = [copy for row in value["inputs"].get("rows", [])
                    for copy in (row.get("snapshot"), row.get("acknowledgedFallback")) if copy]
            live.extend(copy.get("draft") for copy in value.get("emergency", []) if not copy.get("finished"))
            remains = any(((copy.get("token") or copy.get("inputToken") or {}).get("nonce") or copy.get("slot"))
                          == token["nonce"] for copy in live if copy)
            return durable and not remains and text in (value.get("visibleBody") or "")

        stage = "observe-durable-before-get"
        durable = poll(snapshot, durable_and_retired, "Exact durable body and retirement not observed")
        save("durable-before-get.json", durable)
        control({"confirmDurable": durable})
        stage = "release-target-reads"
        control({"releaseReads": True})
        final = state()["ackPhase"]
        if (not final["readsReleased"] or not final["durableSnapshotSha256"] or
                final["observedInput"]["token"] != token or final["receipt"]["sha256"] != receipt["sha256"]):
            raise ValueError("Final gate evidence does not match the held ACK")
        result = {"ok": True, "source": SOURCE, "session": session_id, "recordId": record,
                  "phase": final["id"], "token": token, "receiptSha256": receipt["sha256"],
                  "durableSnapshotSha256": final["durableSnapshotSha256"],
                  "heldTargetReads": final["readsHeld"], "evidence": str(out)}
        save("result.json", result)
        print(json.dumps(result))
    except Exception as error:
        result = {"ok": False, "stage": stage, "error": str(error), "evidence": str(out),
                  "instruction": "Inspect server state. Client does not release gates on failure."}
        save("result.json", result)
        print(json.dumps(result))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

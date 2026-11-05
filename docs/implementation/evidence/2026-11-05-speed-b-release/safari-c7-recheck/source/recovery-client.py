"""Root-executed Safari recovery continuation. No HTTP calls occur on import."""
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
SCRIPTS = {
    "recovery-observation.js": "e97ea7c0bb36f04b86ea8ef65845218e1691467becc709a688ff255a89dccfd6",
    "prepare-editor.js": "8b65b02a103ce7538cea4a1ca8d9b74996bfee809d5534445ba74de0d121a39c",
    "storage-snapshot.js": "1e06c5ed18b98e43bf5d13e534c385e5a636eecae84810d552f5e493ec0c71cd",
    "read-server-body.js": "862d330e9148a44256955716baf656ac95664dc773677dd9ec4b5e34bf653613",
}
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", sys.argv[1]):
        raise ValueError("Supply only the root-owned session ID and fixture.json path")
    pins = json.loads((Path(__file__).resolve().parent / "reviewed-pins.json").read_text())
    SOURCE, MANIFEST = pins["sourceSha"], pins["artifactManifestSha256"]
    if (not re.fullmatch(r"[0-9a-f]{40}", SOURCE) or not re.fullmatch(r"[0-9a-f]{64}", MANIFEST) or
            not isinstance(pins.get("artifactFileCount"), int) or pins["artifactFileCount"] < 1):
        raise ValueError("Reviewed source, artifact and file-count pins are required")
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
    out = descriptor_path.parent / ("recovery-client-" + uuid4().hex[:8])
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

    def capture_outcome_observations():
        # One read per endpoint, with a separate short observation timeout.
        # This cannot resume or prolong the failed action/polling deadline.
        errors = []
        def read_once(name, path, payload=None, method="POST", fixture=False):
            target = descriptor["stateURL"] if fixture else DRIVER + "/session/" + session_id + "/" + path
            request_body = None if payload is None else json.dumps(payload).encode()
            request = Request(target, data=request_body, method=method,
                              headers={"Content-Type": "application/json"} if request_body else {})
            try:
                with opener.open(request, timeout=2) as response:
                    value = json.loads(response.read())
                save("outcome-" + name + ".json", value)
                if isinstance(value.get("value"), dict) and value["value"].get("error"):
                    errors.append({"read": name, "error": value["value"]["error"]})
                return value
            except Exception as error:
                errors.append({"read": name, "error": str(error)})
                return None
        current = read_once("url", "url", method="GET")
        if current and current.get("value") == descriptor["recordURL"]:
            read_once("input-events", "execute/sync", {
                "script": scripts["recovery-observation.js"], "args": [origin, record, "read-stop"],
            })
            read_once("storage", "execute/async", {
                "script": scripts["storage-snapshot.js"], "args": [origin, owner, record],
            })
        else:
            errors.append({"read": "browser", "error": "Exact record URL could not be verified"})
        read_once("server", "", method="GET", fixture=True)
        save("outcome-observation-status.json", {"errors": errors})

    def begin(label):
        nonlocal stage, deadline
        if descriptor["expiresAt"] - time.time() < 120:
            raise ValueError("Fixture credential window is ending")
        stage = label
        deadline = time.monotonic() + 18

    def server_document():
        own_page()
        value = driver("execute/async", {
            "script": scripts["read-server-body.js"], "args": [origin, owner, record],
        })
        if (value.get("origin") != origin or value.get("recordId") != record or
                value.get("status") != 200 or not isinstance(value.get("bodyDoc"), dict)):
            raise ValueError("Real server full-document read failed")
        return value

    def cache_matches(value, server):
        return value.get("responses", {}).get("available") and any(
            row.get("data", {}).get("entity", {}).get("id") == record and
            row["data"]["entity"].get("bodyRevision") == server["bodyRevision"] and
            row["data"]["entity"].get("bodyDoc") == server["bodyDoc"]
            for row in value["responses"].get("rows", []))

    def inputs(value):
        copies = []
        for row in value.get("inputs", {}).get("rows", []):
            copies.extend([row.get("snapshot"), row.get("acknowledgedFallback")])
        copies.extend(item.get("draft") for item in value.get("emergency", []) if not item.get("finished"))
        return [item for item in copies if item]

    def token_of(value):
        return value.get("token") or value.get("inputToken") or {}

    def same_input(value, token, doc):
        return any(token_of(item) == token and item.get("doc") == doc for item in inputs(value))

    def retired(value, token):
        if not value.get("inputs", {}).get("available") or value.get("emergencyError"):
            return False
        return not any((token_of(item).get("nonce") or item.get("slot")) == token["nonce"]
                       for item in inputs(value))

    def body_posts(events):
        return [event for event in events if event.get("kind") == "request" and
                event.get("method") == "POST" and "entity.update" in event.get("paths", [])]

    def ensure_editor():
        own_page()
        previews = driver("elements", {"using": "css selector", "value": '[data-testid="editor-preview"]'})
        if previews:
            element = quote(previews[0][ELEMENT], safe="")
            if driver("element/" + element + "/displayed", method="GET"):
                driver("element/" + element + "/click", {})
        def ready():
            value = driver("execute/sync", {"script": scripts["prepare-editor.js"], "args": [origin]})
            return value if value.get("ready") else None
        prepared = poll(ready, lambda value: value is not None, "Actual editor not ready")
        field = driver("element", {"using": "css selector",
                                  "value": '[data-testid="body-editor"] [contenteditable="true"]'})
        return field[ELEMENT], prepared

    try:
        begin("verify-prior-ack")
        own_page()
        initial = state()
        phase = initial.get("ackPhase") or {}
        if (initial.get("unavailable") or not phase.get("saveReleased") or
                not phase.get("readsReleased") or not phase.get("durableSnapshotSha256") or
                phase.get("receipt", {}).get("bodyRevision") != initial["bodyRevision"]):
            raise ValueError("Prior strict ACK phase is not the untouched continuation baseline")
        untouched = snapshot()
        if inputs(untouched):
            raise ValueError("Unexpected live local input before continuation")
        saved_a = server_document()
        if (saved_a["bodyRevision"] != initial["bodyRevision"] or
                saved_a["bodyDoc"] != phase["receipt"]["bodyDoc"]):
            raise ValueError("Fixture changed before continuation")
        before_reload = len(initial["events"])

        begin("reload-saved-body")
        driver("refresh", {})
        ensure_editor()
        reloaded = poll(snapshot, lambda value: cache_matches(value, saved_a) and
                        (value.get("visibleBody") or "").strip() == saved_a["body"].strip(),
                        "Saved body did not survive same-session reload")
        if body_posts(state()["events"][before_reload:]):
            raise ValueError("Unexpected body POST during saved-body reload")
        save("saved-body-reload.json", reloaded)

        begin("backend-503-native-input")
        control({"unavailable": True})
        element, _prepared = ensure_editor()
        marker = "Safari recovery B " + uuid4().hex[:12]
        driver("element/" + quote(element, safe="") + "/value", {"text": marker})

        def pending_b(value):
            if marker not in (value.get("visibleBody") or ""):
                return None
            for item in inputs(value):
                token = token_of(item)
                if (not item.get("acknowledged") and token.get("accountId") == owner and
                        token.get("graphId") == owner and token.get("entityId") == record and
                        token.get("basis", {}).get("revision") == saved_a["bodyRevision"] and
                        isinstance(token.get("nonce"), str) and token.get("nonce") and
                        isinstance(token.get("writerId"), str) and token.get("writerId") and
                        isinstance(token.get("sequence"), int) and token["sequence"] > 0 and
                        isinstance(token.get("generation"), (str, int)) and
                        marker in json.dumps(item.get("doc"), ensure_ascii=False)):
                    return item
            return None

        typed = poll(snapshot, lambda value: pending_b(value) is not None,
                     "No exact pending input after native typing")
        exact = pending_b(typed)
        token_b, doc_b = token_of(exact), exact["doc"]
        text_b = typed["visibleBody"].strip()
        unchanged = state()
        if (not unchanged["unavailable"] or unchanged["bodyRevision"] != saved_a["bodyRevision"] or
                unchanged["body"].strip() != saved_a["body"].strip()):
            raise ValueError("Server changed while its API was unavailable")
        save("pending-b-before-reload.json", typed)

        begin("reload-under-own-backend-503")
        driver("refresh", {})
        ensure_editor()
        cached = poll(snapshot, lambda value: cache_matches(value, saved_a) and same_input(value, token_b, doc_b),
                      "Cached body and exact B did not survive same-session reload")
        unchanged = state()
        if (unchanged["bodyRevision"] != saved_a["bodyRevision"] or
                unchanged["body"].strip() != saved_a["body"].strip()):
            raise ValueError("Server changed during unavailable reload")
        save("backend-503-reload.json", cached)

        begin("real-foreign-cas")
        text_c = "Safari confirmed server C " + uuid4().hex[:12]
        control({"foreignBody": text_c})
        foreign = state()
        if (not foreign["unavailable"] or foreign["bodyRevision"] <= saved_a["bodyRevision"] or
                foreign["body"].strip() != text_c):
            raise ValueError("Real foreign CAS was not observed")
        save("foreign-server-c.json", foreign)
        reconnect_boundary = len(foreign["events"])

        begin("reconnect-without-automatic-b-write")
        control({"unavailable": False})
        driver("refresh", {})
        ensure_editor()
        server_c = server_document()
        if server_c["bodyRevision"] != foreign["bodyRevision"] or server_c["body"].strip() != text_c:
            raise ValueError("Server C changed on reconnect")
        offered = poll(snapshot, lambda value: cache_matches(value, server_c) and
                       same_input(value, token_b, doc_b) and value.get("recovery") and
                       (value.get("visibleBody") or "").strip() == text_c,
                       "Confirmed C and the exact B recovery offer were not observed")
        time.sleep(1.1)
        before_choice = state()
        if (body_posts(before_choice["events"][reconnect_boundary:]) or
                before_choice["bodyRevision"] != foreign["bodyRevision"] or
                before_choice["body"].strip() != text_c):
            raise ValueError("Automatic body POST or overwrite occurred before recovery choice")
        save("recovery-before-choice.json", offered)

        begin("explicit-supported-recovery")
        own_page()
        observation = driver("execute/sync", {
            "script": scripts["recovery-observation.js"], "args": [origin, record, "install"],
        })
        if not observation.get("installed") or observation.get("origin") != origin:
            raise ValueError("Passive recovery observer was not installed")
        save("before-recovery-click.json", observation)
        button = driver("element", {"using": "xpath",
            "value": "//*[@data-testid='draft-banner']//button[normalize-space(.)='Оставить моё']"})
        recovery_boundary = len(before_choice["events"])
        driver("element/" + quote(button[ELEMENT], safe="") + "/click", {})

        def accepted(value):
            acks = [event["receipt"] for event in value["events"][recovery_boundary:]
                    if event.get("kind") == "body-ack" and event.get("receipt", {}).get("id") == record]
            if len(acks) > 1:
                raise ValueError("Unexpected multiple body ACKs after one recovery choice")
            return acks[0] if acks else None

        saved_b_state = poll(state, lambda value: accepted(value) is not None,
                             "Explicit recovery has no actual body ACK")
        receipt = accepted(saved_b_state)
        if (receipt["status"] != 200 or receipt["bodyRevision"] <= foreign["bodyRevision"] or
                receipt["bodyDoc"] != doc_b or saved_b_state["body"].strip() != text_b):
            raise ValueError("Recovery ACK does not match the observed B document")
        final = poll(snapshot, lambda value: cache_matches(value, receipt) and retired(value, token_b) and
                     not value.get("recovery") and (value.get("visibleBody") or "").strip() == text_b,
                     "Recovered B did not become durable with exact token retirement")
        save("recovered-b-durable.json", final)
        outcome = {
            "ok": True, "source": SOURCE, "session": session_id, "recordId": record,
            "sameSessionReload": True, "outage": "own tRPC backend returned503",
            "tokenB": token_b, "foreignRevision": foreign["bodyRevision"],
            "recoveryRevision": receipt["bodyRevision"], "receiptSha256": receipt["sha256"],
            "noAutomaticPostBeforeChoice": True, "evidence": str(out),
        }
        capture_outcome_observations()
        save("result.json", outcome)
        print(json.dumps(outcome))
    except Exception as error:
        outcome = {"ok": False, "stage": stage, "error": str(error), "evidence": str(out),
                   "instruction": "Inspect actual server/browser state. Client does not revert controls on failure."}
        capture_outcome_observations()
        save("result.json", outcome)
        print(json.dumps(outcome))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

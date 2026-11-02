#!/usr/bin/env bash
# Trim Fork-2 Chrome tabs (CDP :9224) to a single Lovart page.
# Usage:
#   lovart-canvas-tabs-trim.sh                 # keep first lovart/canvas tab (or first page)
#   lovart-canvas-tabs-trim.sh <projectId>     # prefer that projectId; close the rest
# Exit 0 always when CDP reachable; prints remaining count.
set -euo pipefail
PORT="${LOVART_FORK2_CDP:-9224}"
KEEP_PID="${1:-}"
if ! curl -sS --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "CDP :${PORT} unreachable"
  exit 1
fi
python3 - "$PORT" "$KEEP_PID" <<'PY'
import json, sys, urllib.request, time
port, keep_pid = sys.argv[1], sys.argv[2]
tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
pages = [t for t in tabs if t.get("type") == "page"]
if not pages:
    print("pages=0")
    sys.exit(0)
keep = None
if keep_pid:
    for t in pages:
        if keep_pid in (t.get("url") or ""):
            keep = t
            break
if keep is None:
    for t in pages:
        u = t.get("url") or ""
        if "lovart.ai/canvas" in u:
            keep = t
            break
if keep is None:
    keep = pages[0]
close = [t for t in pages if t["id"] != keep["id"]]
print(f"keep={keep.get('url','')[:120]}")
print(f"closing={len(close)}")
# Prefer HTTP /json/close then verify; fall back to websocket Target.closeTarget
closed = 0
for t in close:
    tid = t["id"]
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{tid}", timeout=3).read()
        closed += 1
    except Exception as e:
        print(f"close_http_fail {tid[:8]} {e}")
time.sleep(0.6)
tabs2 = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
pages2 = [t for t in tabs2 if t.get("type") == "page"]
# If still many, use websocket
if len(pages2) > 1:
    try:
        import websocket  # optional
    except ImportError:
        websocket = None
    if websocket is None:
        # try venv we may have created
        import importlib.util, os
        cand = "/tmp/wsvenv/lib/python3.13/site-packages/websocket/__init__.py"
        if os.path.exists(cand):
            sys.path.insert(0, "/tmp/wsvenv/lib/python3.13/site-packages")
            import websocket  # type: ignore
    if websocket is not None:
        ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version"))
        ws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=10)
        mid = 1
        still = [t for t in pages2 if t["id"] != keep["id"]]
        # re-resolve keep by url
        keep_url = keep.get("url")
        keep_now = None
        for t in pages2:
            if t.get("url") == keep_url:
                keep_now = t
                break
        if keep_now is None and keep_pid:
            for t in pages2:
                if keep_pid in (t.get("url") or ""):
                    keep_now = t
                    break
        if keep_now is None:
            keep_now = pages2[0]
        for t in pages2:
            if t["id"] == keep_now["id"]:
                continue
            payload = {"id": mid, "method": "Target.closeTarget", "params": {"targetId": t["id"]}}
            mid += 1
            ws.send(json.dumps(payload))
            deadline = time.time() + 5
            while time.time() < deadline:
                resp = json.loads(ws.recv())
                if resp.get("id") == payload["id"]:
                    break
        ws.close()
        time.sleep(0.5)
        tabs2 = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
        pages2 = [t for t in tabs2 if t.get("type") == "page"]
print(f"remaining={len(pages2)}")
for t in pages2:
    print("-", (t.get("url") or "")[:110])
if len(pages2) > 3:
    sys.exit(2)
PY

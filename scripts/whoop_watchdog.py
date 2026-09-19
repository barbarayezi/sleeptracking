#!/usr/bin/env python3
"""Watchdog: waits for Whoop OAuth auth, then auto-syncs and verifies."""
import time, json, urllib.request, urllib.error, sys

BASE = "http://127.0.0.1:61023"
MAX_WAIT = 18 * 60  # seconds
POLL = 15
RESULT_FILE = "/Users/barbara/Documents/vscode/developing/sleeptracking/scripts/whoop_watchdog_result.txt"


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=10).read().decode())


def post(path):
    req = urllib.request.Request(BASE + path, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())


def log(msg):
    print(msg, flush=True)


# 1) wait for authentication
log("== watchdog: waiting for Whoop auth ==")
deadline = time.time() + MAX_WAIT
authed = False
while time.time() < deadline:
    try:
        st = get("/api/whoop/status")
        if st.get("authenticated"):
            authed = True
            log("== authenticated detected ==")
            break
    except Exception as e:
        log(f"(status probe err: {e})")
    time.sleep(POLL)

if not authed:
    open(RESULT_FILE, "w").write("TIMEOUT: Whoop not authorized within window.\n")
    log("TIMEOUT: not authorized")
    sys.exit(0)

# 2) trigger sync (cover the gap)
log("== triggering sync days=12 ==")
try:
    post("/api/whoop/sync?days=12")
except Exception as e:
    log(f"sync trigger err: {e}")

# 3) wait for sync to finish
sync_deadline = time.time() + 10 * 60
result = None
error = None
while time.time() < sync_deadline:
    try:
        s = get("/api/whoop/sync/status")
        if not s.get("running"):
            result = s.get("result")
            error = s.get("error")
            break
    except Exception as e:
        log(f"(sync status err: {e})")
    time.sleep(5)

log(f"sync result={result} error={error}")

# 4) verify DB
summary = []
try:
    import os
    from dotenv import load_dotenv
    load_dotenv("/Users/barbara/Documents/vscode/developing/sleeptracking/.env")
    import database
    conn = database.get_connection()
    rows = conn.execute(
        "SELECT record_date, COUNT(*) c FROM sleep_records "
        "WHERE record_date >= '2026-08-25' GROUP BY record_date ORDER BY record_date"
    ).fetchall()
    summary.append("sleep_records 2026-08-25..: " + str([dict(r) for r in rows]))
    mx = conn.execute("SELECT MAX(record_date) FROM whoop_daily_metrics").fetchone()
    summary.append("whoop_daily_metrics max date: " + str(mx[0]))
    conn.close()
except Exception as e:
    summary.append(f"verify err: {e}")

out = f"authed={authed}\nresult={result}\nerror={error}\n" + "\n".join(summary) + "\n"
open(RESULT_FILE, "w").write(out)
log("== done ==\n" + out)

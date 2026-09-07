"""
One-off backfill: re-analyse historical meals that lack an AI health_score.

Why these rows have no score: the "AI 营养分析" feature was only enabled on
2026-09-02; everything logged before that was a manual record carrying only
meal_content text and a default health_rating='average', so the per-day
meal_health_score in /api/health-overview shows a big empty gap.

This script re-runs the SAME text-estimation path (nutrition.analyze_meal)
that the frontend uses today, so the backfilled scores are on the same scale.
It is idempotent: it only touches rows where health_score IS NULL, and it
commits each row immediately, so it can be re-run to pick up any failures.

Run (managed venv has flask + libsql):
    C:/Users/wucai/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/backfill_meal_ai_scores.py

Connects to Turso directly (does NOT import database.py, to avoid load_dotenv
side effects). LLM gateway creds come from ~/.claude/settings.json via
nutrition._load_config (same fallback as production code).
"""

import json
import os
import socket
import sys
import time
from datetime import datetime, timezone

import argparse

# ── 1. Safety timeout: Turso with no socket timeout can hang forever and
#      wedge every thread (the exact failure this project hit before). ──
socket.setdefaulttimeout(20)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nutrition  # noqa: E402  (imports only stdlib, safe)


def _load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def main():
    parser = argparse.ArgumentParser(description="Backfill AI scores for meals lacking them.")
    parser.add_argument("--limit", type=int, default=0,
                        help="Only process the first N NULL-score rows (0 = all).")
    args = parser.parse_args()

    env = _load_env(".env")
    turso_url = env.get("TURSO_URL")
    turso_token = env.get("TURSO_AUTH_TOKEN")
    if not (turso_url and turso_token):
        print("ERROR: .env missing TURSO_URL / TURSO_AUTH_TOKEN")
        sys.exit(1)

    if not nutrition.is_configured():
        print("ERROR: LLM not configured (no LLM_* env, no ~/.claude/settings.json)")
        sys.exit(1)

    try:
        import libsql as lib
    except ImportError:
        import libsql_experimental as lib

    # Turso's Hrana connection flakes intermittently (observed: tcp connect
    # error 10060 on one attempt, fine seconds later). Retry the initial
    # connect + first query before declaring failure.
    conn = None
    last_err = None
    for attempt in range(1, 6):
        try:
            conn = lib.connect(turso_url, auth_token=turso_token)
            conn.execute("SELECT 1").fetchone()
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"连接失败(第{attempt}次): {str(e)[:90]}")
            time.sleep(2)
    if conn is None:
        print(f"ERROR: 无法连接 Turso：{last_err}")
        sys.exit(1)

    cursor = conn.execute(
        """
        SELECT id, meal_name, meal_content, meal_quantity, meal_type
        FROM meal_records
        WHERE health_score IS NULL
        ORDER BY id
        """
    )
    # libsql's raw cursor returns plain tuples; build a name->index map from
    # the cursor description so field access below is readable and robust.
    cols = [c[0] for c in cursor.description] if cursor.description else []
    idx = {name: i for i, name in enumerate(cols)}
    rows = cursor.fetchall()

    if args.limit and args.limit > 0:
        rows = rows[: args.limit]

    total = len(rows)
    print(f"待回填餐食: {total} 条")
    if total == 0:
        print("没有需要回填的记录了。")
        return

    ok = 0
    fail = 0
    skipped = 0

    for i, r in enumerate(rows, 1):
        rid = r[idx["id"]]
        name = r[idx["meal_name"]] or ""
        content = r[idx["meal_content"]] or ""
        qty = r[idx["meal_quantity"]] or "normal"
        mtype = r[idx["meal_type"]] or ""

        if not content.strip():
            skipped += 1
            print(f"[{i}/{total}] id={rid} 跳过：无 meal_content 文本")
            continue

        try:
            res = nutrition.analyze_meal(
                meal_name=name,
                meal_content=content,
                meal_quantity=qty,
                meal_type=mtype,
            )
            if not res.get("ok"):
                fail += 1
                print(f"[{i}/{total}] id={rid} 失败：{res.get('error')}")
                continue

            d = res["data"]
            now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            conn.execute(
                """
                UPDATE meal_records SET
                    health_score = ?,
                    calorie_kcal = ?,
                    protein_g = ?,
                    fat_g = ?,
                    carbs_g = ?,
                    items_json = ?,
                    ai_pros = ?,
                    ai_cons = ?,
                    ai_suggestion = ?,
                    ai_analyzed_at = ?
                WHERE id = ?
                """,
                (
                    d["score"],
                    d["kcal"],
                    d["protein_g"],
                    d["fat_g"],
                    d["carbs_g"],
                    json.dumps(d["items"], ensure_ascii=False) if d["items"] else None,
                    d["pros"],
                    d["cons"],
                    d["suggestion"],
                    now,
                    rid,
                ),
            )
            conn.commit()
            ok += 1
            print(f"[{i}/{total}] id={rid} ok  score={d['score']}  kcal={d['kcal']:.0f}  "
                  f"{content[:24]}")
        except Exception as e:  # noqa: BLE001
            fail += 1
            print(f"[{i}/{total}] id={rid} 异常：{e}")
            # Keep going; the row stays NULL and a re-run will pick it up.

        time.sleep(0.2)  # gentle pace; avoid hammering the gateway

    conn.close()
    print("\n========== 汇总 ==========")
    print(f"成功: {ok}")
    print(f"失败: {fail}")
    print(f"跳过(无文本): {skipped}")
    print(f"总计: {total}")
    if fail:
        print("\n提示：直接重跑本脚本即可补齐失败的记录（幂等，只处理仍为 NULL 的行）。")


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
# تصدير بيانات صياد الروابط القديم (data.db) لملف JSON عشان ينتقل للنظام الجديد
# الاستعمال:  python3 export-hunter.py ~/tg-wa-hunter/data.db
import json
import sqlite3
import sys
import os

src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/tg-wa-hunter/data.db")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "hunter-export.json")

if not os.path.exists(src):
    sys.exit(f"❌ ما لقيت {src}")

con = sqlite3.connect(src)
con.row_factory = sqlite3.Row


def rows(sql):
    try:
        return [dict(r) for r in con.execute(sql).fetchall()]
    except sqlite3.OperationalError:
        return []


data = {
    "settings": {r["key"]: r["value"] for r in rows("SELECT key, value FROM settings")},
    "accounts": rows("SELECT id, phone, name, username, session, enabled, status, daily_limit, joins_today, joins_date FROM accounts"),
    "sources": rows("SELECT * FROM sources"),
    "links": rows("SELECT * FROM links"),
}
# ما بننقل كلمة مرور اللوحة القديمة ولا جلسات الدخول ولا توكن الجسر
for k in ("pw_hash", "pw_salt", "bridge_token"):
    data["settings"].pop(k, None)

with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
os.chmod(out, 0o600)
print(f"✅ تم التصدير: {len(data['accounts'])} حساب، {len(data['sources'])} مصدر، {len(data['links'])} رابط")
print(f"   الملف: {out}")

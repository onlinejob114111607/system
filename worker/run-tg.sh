#!/usr/bin/env bash
# تشغيل عامل تيليجرام مع إعادة تشغيل تلقائية لو وقع
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null
while true; do
  node tg.js
  code=$?
  if [ $code -eq 0 ]; then
    echo "🛑 عامل تيليجرام اتوقف."
    break
  fi
  echo "⚠️ عامل تيليجرام وقع (كود $code) — إعادة تشغيل بعد 10 ثواني... (CTRL+C للإيقاف)"
  sleep 10
done

#!/usr/bin/env bash
# تشغيل عامل الواتساب مع إعادة تشغيل تلقائية لو وقع
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null
while true; do
  node wa.js
  code=$?
  if [ $code -eq 0 ]; then
    echo "🛑 عامل الواتساب اتوقف."
    break
  fi
  echo "⚠️ عامل الواتساب وقع (كود $code) — إعادة تشغيل بعد 10 ثواني... (CTRL+C للإيقاف)"
  sleep 10
done

#!/usr/bin/env bash
# تثبيت العاملين على Termux (مرة وحدة)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
pkg update -y
pkg install -y nodejs-lts tmux python
cd "$DIR/worker"
npm install --no-audit --no-fund
chmod +x run-wa.sh run-tg.sh "$DIR/startall.sh" "$DIR/stopall.sh" "$DIR/update.sh" 2>/dev/null || true
echo ""
echo "✅ تم التثبيت"
echo "الخطوة الجاية: حط serviceAccount.json بمجلد worker، وبعدين ./startall.sh"

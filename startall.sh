#!/usr/bin/env bash
# تشغيل العاملين بالخلفية، كل واحد بنافذة tmux لحاله
DIR="$(cd "$(dirname "$0")" && pwd)"
termux-wake-lock 2>/dev/null
if [ ! -f "$DIR/worker/serviceAccount.json" ]; then
  echo "❌ حط ملف serviceAccount.json بمجلد worker أول"
  exit 1
fi
tmux kill-session -t wa 2>/dev/null
tmux kill-session -t tg 2>/dev/null
tmux new-session -d -s wa "bash $DIR/worker/run-wa.sh"
tmux new-session -d -s tg "bash $DIR/worker/run-tg.sh"
echo "✅ العاملين شغالين بالخلفية"
echo "لمشاهدة عامل الواتساب:   tmux attach -t wa"
echo "لمشاهدة عامل تيليجرام:   tmux attach -t tg"
echo "للرجوع بدون ما توقفه:    CTRL ثم b ثم d"
echo "لإيقاف الكل:              ./stopall.sh"

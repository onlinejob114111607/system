#!/usr/bin/env bash
# إيقاف العاملين بشكل نظيف (بيكتبوا حالتهم "موقوف" باللوحة)
for s in wa tg; do
  tmux send-keys -t $s C-c 2>/dev/null
done
sleep 4
tmux kill-session -t wa 2>/dev/null
tmux kill-session -t tg 2>/dev/null
echo "🛑 تم إيقاف العاملين"

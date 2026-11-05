#!/usr/bin/env bash
# ============================================================
#  تحديث العمّال من GitHub — بدون ملفات zip
#  من اللوحة: الإعدادات ← النظام ← «حدّث العمّال هلأ»
#  أو يدوي:   ./update.sh حسابك/system main
#  رجوع للنسخة اللي قبل:  ./update.sh rollback
#  لو الريبو خاص: حط توكن قراءة فقط بملف ~/system/.update-token
#  (الملفات السرية serviceAccount.json و data/ ما بتنلمس أبداً)
# ============================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/update.log"
exec >>"$LOG" 2>&1
echo ""
echo "==== $(date '+%Y-%m-%d %H:%M:%S') ===="

BK="$DIR/.backup"
if [ "${1:-}" = "rollback" ]; then
  [ -d "$BK" ] || { echo "❌ ما في نسخة قديمة"; exit 1; }
  cp "$BK"/*.js "$DIR/worker/" && cp "$BK/package.json" "$DIR/worker/" 2>/dev/null
  echo "↩️ رجعت النسخة القديمة"
  "$DIR/stopall.sh"; "$DIR/startall.sh"
  exit 0
fi

REPO="${1:-$(cat "$DIR/.update-repo" 2>/dev/null)}"
BRANCH="${2:-main}"
[ -n "$REPO" ] || { echo "❌ ما في ريبو (مثال: ./update.sh حسابك/system)"; exit 1; }
echo "⬇️ تحديث من $REPO ($BRANCH)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TOKEN=""; [ -f "$DIR/.update-token" ] && TOKEN="$(tr -d ' \n\r' < "$DIR/.update-token")"
if [ -n "$TOKEN" ]; then
  curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/zipball/$BRANCH" -o "$TMP/u.zip"
else
  curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH" -o "$TMP/u.zip"
fi
[ -s "$TMP/u.zip" ] || { echo "❌ التحميل فشل (تأكد من اسم الريبو، ولو خاص حط التوكن)"; exit 1; }
unzip -q "$TMP/u.zip" -d "$TMP/x" || { echo "❌ الملف خربان"; exit 1; }
SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -d "$SRC/worker" ] || { echo "❌ ما لقيت مجلد worker جوا الريبو"; exit 1; }

# فحص كل الملفات قبل ما نبدّل — لو في خطأ ما منلمس إشي
for f in "$SRC"/worker/*.js; do
  node --check "$f" || { echo "❌ ملف فيه خطأ: $(basename "$f") — ما حدّثت إشي"; exit 1; }
done

OLDPKG="$(md5sum "$DIR/worker/package.json" 2>/dev/null | cut -d' ' -f1)"
rm -rf "$BK"; mkdir -p "$BK"
cp "$DIR"/worker/*.js "$BK/" 2>/dev/null; cp "$DIR/worker/package.json" "$BK/" 2>/dev/null

cp "$SRC"/worker/*.js "$DIR/worker/"
[ -f "$SRC/worker/package.json" ] && cp "$SRC/worker/package.json" "$DIR/worker/"
[ -d "$SRC/worker/tools" ] && cp -r "$SRC/worker/tools" "$DIR/worker/"
for f in run-wa.sh run-tg.sh; do [ -f "$SRC/worker/$f" ] && cp "$SRC/worker/$f" "$DIR/worker/"; done
for f in startall.sh stopall.sh install.sh; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DIR/"; done
# السكربت نفسه آخر إشي (بملف جديد، عشان ما يخرب وهو شغال)
[ -f "$SRC/update.sh" ] && cp "$SRC/update.sh" "$DIR/update.sh.new" && mv -f "$DIR/update.sh.new" "$DIR/update.sh"
chmod +x "$DIR"/*.sh "$DIR"/worker/*.sh 2>/dev/null

NEWPKG="$(md5sum "$DIR/worker/package.json" 2>/dev/null | cut -d' ' -f1)"
if [ "$OLDPKG" != "$NEWPKG" ]; then
  echo "📦 مكتبات جديدة — npm install"
  (cd "$DIR/worker" && npm install --no-audit --no-fund) || { echo "❌ npm install فشل — برجع النسخة القديمة"; cp "$BK"/*.js "$DIR/worker/"; cp "$BK/package.json" "$DIR/worker/"; }
fi

"$DIR/stopall.sh"
"$DIR/startall.sh"
echo "✅ خلص التحديث — الإصدار: $(grep -o "'[0-9.]*'" "$DIR/worker/version.js" | tr -d "'")"

// نقل حسابات ومجموعات ومنشورات ناشر الواتساب القديم (مشروع wa-poster-a6bb4) للمشروع الموحد
// الاستعمال (من مجلد worker):
//   1) حط مفتاح المشروع القديم باسم  tools/old-serviceAccount.json
//   2) node tools/migrate-wa.js
//   3) انسخ مجلد auth من العامل القديم لهون:  cp -r ~/worker/auth ~/system/worker/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { db, randomKey } from '../common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OLD_SA = process.argv[2] || path.join(HERE, 'old-serviceAccount.json')
if (!fs.existsSync(OLD_SA)) {
  console.error(`❌ ما لقيت ${OLD_SA}\nنزّل مفتاح مشروع wa-poster القديم من Firebase Console ← Project settings ← Service accounts، وسمّيه old-serviceAccount.json بمجلد tools`)
  process.exit(1)
}
const oldApp = initializeApp({ credential: cert(JSON.parse(fs.readFileSync(OLD_SA, 'utf8'))) }, 'old')
const old = getFirestore(oldApp)

const parseInviteCode = (link) => {
  const s = String(link || '').trim()
  const m = s.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/)
  if (m) return m[1]
  return /^[A-Za-z0-9]{10,}$/.test(s) ? s : null
}

async function copy(from, to, map) {
  const snap = await old.collection(from).get()
  let n = 0
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch()
    for (const d of snap.docs.slice(i, i + 400)) {
      const data = map(d.data(), d.id)
      if (!data) continue
      b.set(db.collection(to).doc(d.id), data, { merge: true })
      n++
    }
    await b.commit()
    process.stdout.write(`\r   ${to}: ${n}`)
  }
  process.stdout.write('\n')
  return n
}

console.log('📦 نقل بيانات ناشر الواتساب...')
const accounts = await copy('accounts', 'wa_accounts', (x) => {
  const { qr, pairingCode, ...rest } = x
  return { ...rest, state: 'starting', settings: { quietStart: 1, quietEnd: 8, warmup: false, joinDailyLimit: 0, ...(x.settings || {}) } }
})
const groups = await copy('groups', 'wa_groups', (x) => ({
  ...x,
  linkCode: x.linkCode || parseInviteCode(x.inviteCode),
  k: x.k || randomKey(),
  failCount: x.failCount || 0,
}))
const posts = await copy('posts', 'wa_posts', (x) => ({ ...x, status: x.status === 'sending' ? 'queued' : x.status }))

console.log(`\n✅ ${accounts} حساب، ${groups} مجموعة، ${posts} منشور`)
console.log('الخطوة الجاية: انسخ مجلد auth من العامل القديم لمجلد worker الجديد عشان ما تحتاج تربط الأرقام من جديد،')
console.log('ووقّف العامل القديم نهائياً قبل ما تشغّل الجديد.')
process.exit(0)

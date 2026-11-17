// ============================================================
//  نقل كل البيانات من Firebase لـ Supabase (مرة وحدة)
//  بيشتغل على الجوال من مجلد worker:
//     node tools/migrate-to-supabase.js            ← نقل كامل (بيكمّل من وين وقف)
//     node tools/migrate-to-supabase.js --check    ← مقارنة الأعداد بس
//     node tools/migrate-to-supabase.js --skip=logs,wa_replies
//     node tools/migrate-to-supabase.js --again    ← نسخ كل شي من جديد (يوم التبديل، والعمّال واقفين)
//  بيحتاج الملفين: serviceAccount.json (Firebase) و supabase.json (Supabase)
//  ما بيحذف إشي من Firebase. لو خلصت حصة Firebase اليومية، بيوقف
//  وبيكمّل من نفس المكان لما تشغّله تاني يوم.
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldPath } from 'firebase-admin/firestore'
import { createClient } from '@supabase/supabase-js'
import { encode } from '../supadocs.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SA = path.join(ROOT, 'serviceAccount.json')
const SUPA = path.join(ROOT, 'supabase.json')
const STATE = path.join(ROOT, 'data', 'migrate-state.json')
for (const f of [SA, SUPA]) if (!fs.existsSync(f)) {
  console.log(`❌ الملف ${path.basename(f)} مش موجود بمجلد worker`)
  process.exit(1)
}
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const SKIP = new Set(String(args.skip || '').split(',').filter(Boolean))
const CHECK = 'check' in args
const PAGE = 300
// المجموعات الفرعية المعروفة (عشان ما نصرف قراءات بالبحث تحت كل مستند)
const SUBS = { wa_posts: ['results'] }

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA, 'utf8'))) })
const fdb = getFirestore()
const cfg = JSON.parse(fs.readFileSync(SUPA, 'utf8'))
const sb = createClient(cfg.url, cfg.serviceKey, { auth: { persistSession: false } })

fs.mkdirSync(path.dirname(STATE), { recursive: true })
if ('again' in args && fs.existsSync(STATE)) fs.unlinkSync(STATE)
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, cursor: {}, counts: {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1))

const quota = (e) => /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e?.message || e))

async function supaCount(col) {
  const { count, error } = await sb.from('docs').select('id', { count: 'exact', head: true }).eq('col', col)
  if (error) throw new Error(error.message)
  return count || 0
}

async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('docs').upsert(rows.slice(i, i + 500), { onConflict: 'col,id' })
    if (error) throw new Error('Supabase: ' + error.message)
  }
}

// نسخ مجموعة وحدة (وكل المجموعات الفرعية تحت مستنداتها)
async function copyCollection(colRef) {
  const col = colRef.path
  if (state.done[col]) return
  let n = state.counts[col] || 0
  let last = state.cursor[col] || null
  for (;;) {
    let q = colRef.orderBy(FieldPath.documentId()).limit(PAGE)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    const rows = snap.docs.map((d) => ({ col, id: d.id, data: encode(d.data()) }))
    await upsert(rows)
    // مجموعات فرعية (مثلاً wa_posts/X/results)
    for (const d of snap.docs) for (const sub of SUBS[colRef.id] || []) if (!SKIP.has(sub)) await copyCollection(d.ref.collection(sub))
    n += snap.size
    last = snap.docs.at(-1).id
    state.cursor[col] = last
    state.counts[col] = n
    save()
    process.stdout.write(`\r  ${col}: ${n}`)
    if (snap.size < PAGE) break
  }
  state.done[col] = true
  save()
  if (n) process.stdout.write(`\r  ✓ ${col}: ${n}\n`)
}

async function main() {
  const roots = (await fdb.listCollections()).filter((c) => !SKIP.has(c.id))
  console.log(`📦 ${roots.length} مجموعة بـ Firebase: ${roots.map((c) => c.id).join('، ')}`)
  if (CHECK) {
    let bad = 0
    for (const c of roots) {
      const [f, s] = await Promise.all([fdb.collection(c.id).count().get().then((x) => x.data().count), supaCount(c.id)])
      console.log(`${f === s ? '✓' : '⚠️'} ${c.id}: Firebase ${f} · Supabase ${s}`)
      if (f !== s) bad++
    }
    console.log(bad ? `\n⚠️ ${bad} مجموعة مش متطابقة — شغّل النقل مرة تانية` : '\n✅ كل الأعداد متطابقة')
    return
  }
  console.log('⬆️ بلّش النقل...')
  for (const c of roots) await copyCollection(c)
  console.log('\n✅ خلص النقل. هلأ شغّل: node tools/migrate-to-supabase.js --check')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log('\n' + (quota(e) ? '⏸️ حصة Firebase اليومية خلصت — شغّل نفس الأمر بكرة بعد الساعة 10 الصبح وبيكمّل من مكانه.' : '❌ ' + e.message))
    process.exit(1)
  })

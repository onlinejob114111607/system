// استيراد بيانات صياد الروابط القديم (من export-hunter.py) لقاعدة البيانات الجديدة
// الاستعمال (من مجلد worker):  node tools/import-hunter.js tools/hunter-export.json
import fs from 'node:fs'
import path from 'node:path'
import { db, Timestamp, FieldValue, DATA_DIR, readJson, writeJson } from '../common.js'

const file = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'hunter-export.json')
if (!fs.existsSync(file)) {
  console.error(`❌ ما لقيت ${file}`)
  process.exit(1)
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const s = data.settings || {}
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d)
const ts = (sec) => (sec ? Timestamp.fromMillis(Number(sec) * 1000) : null)

async function commitAll(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch()
    ops.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d, { merge: true }))
    await b.commit()
    process.stdout.write(`\r   ${Math.min(i + 400, ops.length)} / ${ops.length}`)
  }
  if (ops.length) process.stdout.write('\n')
}

// 1) الإعدادات
await db.doc('settings/app').set(
  {
    tg: {
      apiId: s.api_id || '',
      apiHash: s.api_hash || '',
      dailyLimit: int(s.daily_limit, 15),
      delay: int(s.delay, 60),
      scanLimit: int(s.scan_limit, 3000),
      joinPublic: s.join_public !== '0',
      autoCheck: s.auto_check !== '0',
    },
    wa: {
      autoJoin: s.wa_auto_join === '1',
      includeUnchecked: s.wa_include_unchecked === '1',
      dailyJoinLimit: int(s.wa_daily_limit, 10),
      allAccounts: s.wa_all_accounts !== '0',
      postUnlimited: s.wa_post_unlimited === '1',
    },
  },
  { merge: true },
)
console.log('✅ الإعدادات')

// 2) حسابات تيليجرام + الجلسات (على الجوال بس)
const sessFile = path.join(DATA_DIR, 'tg-sessions.json')
const sessions = readJson(sessFile, {})
const accOps = []
const idByOldPhone = {}
for (const a of data.accounts || []) {
  const id = String(a.phone || '').replace(/\D/g, '')
  if (!id) continue
  idByOldPhone[a.phone] = id
  if (a.session) sessions[id] = a.session
  accOps.push([
    db.doc(`tg_accounts/${id}`),
    {
      phone: '+' + id,
      name: a.name || '+' + id,
      username: a.username || null,
      enabled: !!a.enabled,
      status: ['banned', 'unauthorized', 'full'].includes(a.status) ? a.status : 'ok',
      error: null,
      dailyLimit: a.daily_limit || null,
      joinsToday: a.joins_today || 0,
      joinsDate: a.joins_date || null,
      floodUntil: 0,
      created: FieldValue.serverTimestamp(),
    },
  ])
}
writeJson(sessFile, sessions)
await commitAll(accOps)
console.log(`✅ ${accOps.length} حساب تيليجرام (الجلسات انحفظت بـ data/tg-sessions.json)`)

// 3) المصادر
const oldAccPhone = Object.fromEntries((data.accounts || []).map((a, i) => [a.id ?? i, a.phone]))
const srcOps = []
const srcIdByOld = {}
for (const x of data.sources || []) {
  const [kind, val] = String(x.key || '').split(/:(.*)/s)
  if (!kind || !val) continue
  const id = `${kind}_${kind === 'public' ? val.toLowerCase() : val}`.replace(/\//g, '_')
  srcIdByOld[x.id] = id
  const status = ['working', 'scanning'].includes(x.status) ? 'pending' : x.status || 'pending'
  srcOps.push([
    db.doc(`tg_sources/${id}`),
    {
      input: x.input,
      key: x.key,
      title: x.title || null,
      chatId: x.chat_id != null ? String(x.chat_id) : null,
      status,
      accountId: null,
      accountPref: x.account_pref ? idByOldPhone[oldAccPhone[x.account_pref]] || null : null,
      monitor: x.monitor !== 0,
      scanned: x.scanned || 0,
      linksFound: x.links_found || 0,
      attempts: x.attempts || 0,
      error: x.error || null,
      created: ts(x.created) || FieldValue.serverTimestamp(),
      updated: ts(x.updated) || FieldValue.serverTimestamp(),
    },
  ])
}
await commitAll(srcOps)
console.log(`✅ ${srcOps.length} مصدر`)

// 4) الروابط
const WA = { joined: 'joined', requested: 'requested', error: 'error', duplicate: 'duplicate', sent: 'none', queued: 'queued' }
const linkOps = []
for (const l of data.links || []) {
  if (!l.code) continue
  linkOps.push([
    db.doc(`tg_links/${l.code}`),
    {
      url: l.url || `https://chat.whatsapp.com/${l.code}`,
      sourceId: srcIdByOld[l.source_id] || null,
      sourceTitle: l.source_title || null,
      msgDate: ts(l.msg_date),
      firstSeen: ts(l.first_seen) || FieldValue.serverTimestamp(),
      status: l.status || 'unchecked',
      groupName: l.group_name || null,
      category: null,
      checkedAt: ts(l.checked_at),
      waStatus: WA[l.wa_status] || 'none',
      waError: l.wa_error || null,
    },
  ])
}
await commitAll(linkOps)
console.log(`✅ ${linkOps.length} رابط`)
console.log('\nخلص الاستيراد. وقّف الصياد القديم نهائياً قبل ما تشغّل العامل الجديد (نفس جلسات تيليجرام).')
process.exit(0)

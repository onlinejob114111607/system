// ============================================================
//  التقرير اليومي على تيليجرام (الساعة 11 بالليل بتوقيت مصر)
//  + التحديث التلقائي للعمّال من GitHub (أمر من اللوحة)
// ============================================================
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { db, Timestamp, dayKey, ms, ROOT } from './common.js'
import { VERSION } from './version.js'

const TZ = 'Africa/Cairo'
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
const hmNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
const money = (n) => String(Math.round((Number(n) || 0) * 100) / 100)
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

// بداية اليوم بتوقيت مصر (بيراعي التوقيت الصيفي)
export function cairoMidnight(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const offset = asUtc - Math.floor(d.getTime() / 1000) * 1000
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset)
}

const count = async (q) => {
  try {
    return (await q.count().get()).data().count
  } catch {
    return null
  }
}
const n = (v) => (v == null ? '—' : v)

export async function buildDailyReport() {
  const day = dayKey()
  const start = Timestamp.fromDate(cairoMidnight())
  const [y, m, d] = day.split('-').map(Number)
  const wd = DAYS_AR[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]

  const [regs, links, ordersToday] = await Promise.all([
    count(db.collection('registrations').where('createdAt', '>=', start)),
    count(db.collection('tg_links').where('firstSeen', '>=', start)),
    count(db.collection('orders').where('createdAt', '>=', start)),
  ])
  const run = (await db.doc(`funnel_runs/${day}`).get().catch(() => null))?.data() || null
  const s = run?.stats || null
  // المستلمة اليوم + ربحها
  let delivered = 0
  let profit = 0
  try {
    const ds = await db.collection('orders').where('deliveredAt', '>=', start).get()
    for (const o of ds.docs.map((x) => x.data())) {
      if (o.status !== 'delivered') continue
      delivered++
      profit += Number(o.profit) || 0
    }
  } catch {}
  // الناشر والانضمام (من عدادات الحسابات)
  let sent = 0
  let joined = 0
  let paused = 0
  let waOpen = 0
  let waTotal = 0
  try {
    const as = await db.collection('wa_accounts').get()
    for (const a of as.docs.map((x) => x.data())) {
      waTotal++
      if (a.state === 'open') waOpen++
      if (a.dayKey === day) sent += Number(a.sentToday) || 0
      if (a.joinDayKey === day) joined += Number(a.joinedToday) || 0
      if (ms(a.postPausedUntil) > Date.now()) paused++
    }
  } catch {}
  // العمّال
  const ws = {}
  for (const w of ['wa', 'tg']) {
    const x = (await db.doc(`workers/${w}`).get().catch(() => null))?.data() || {}
    const alive = x.state === 'running' && Date.now() - ms(x.lastSeen) < 5 * 60_000
    ws[w] = { alive, quota: ms(x.quotaAt) > cairoMidnight().getTime() }
  }

  const lines = [
    `📊 تقرير ${wd} ${d}/${m}`,
    '',
    `👥 تسجيلات جديدة: ${n(regs)}`,
    s
      ? `🎯 المتابعة: ${s.welcomed} رسالة · ${s.replied || 0} ردّوا · ${s.booked} بوك (${pct(s.booked - (s.invBooked || 0), s.welcomed)}٪) · ${s.attended} حضور`
      : '🎯 المتابعة: ما في لقاء اليوم',
    `🛒 المتجر: ${n(ordersToday)} طلب جديد · ${delivered} مستلم · ربح ${money(profit)} ₪`,
    `📤 الناشر: ${sent} رسالة · ${joined} انضمام${paused ? ` · ⏸ ${paused} رقم واقف لحمايته` : ''}`,
    `🔎 الصياد: ${n(links)} رابط جديد`,
    `⚙️ النظام: واتساب ${ws.wa.alive ? '✅' : '🔴'} (${waOpen}/${waTotal} رقم متصل) · تيليجرام ${ws.tg.alive ? '✅' : '🔴'}`,
  ]
  if (ws.wa.quota || ws.tg.quota) lines.push('⚠️ حصة Firebase اليومية خلصت اليوم مرة على الأقل (بترجع الساعة 10 الصبح) — فكّر بخطة Blaze')
  return lines.join('\n')
}

export function startDailyReport({ settings, notifier, log }) {
  const ref = db.doc('system/daily_report')
  let sending = false
  const tick = async () => {
    const nset = settings.app.notify || {}
    if (sending || !nset.enabled || nset.daily === false) return
    const at = /^\d{2}:\d{2}$/.test(nset.dailyAt || '') ? nset.dailyAt : '23:00'
    if (hmNow() < at) return
    const day = dayKey()
    sending = true
    try {
      const last = (await ref.get()).data()?.day
      if (last === day) return
      await ref.set({ day, at: Timestamp.now() }) // قبل الإرسال عشان ما ينبعت مرتين
      const text = await buildDailyReport()
      await notifier.notify('daily', text)
      log('📊 انبعت التقرير اليومي')
    } catch (e) {
      log('⚠️ التقرير اليومي:', e.message)
    } finally {
      sending = false
    }
  }
  setInterval(tick, 60_000)
  setTimeout(tick, 20_000)
}

// ---------- التحديث من GitHub ----------
// بيشغّل update.sh بالخلفية (منفصل عن العامل) — السكربت بيوقّف العمّال ويرجع يشغّلهم
export function selfUpdate({ repo, branch, log }) {
  const script = path.join(ROOT, '..', 'update.sh')
  if (!fs.existsSync(script)) throw new Error('ملف update.sh مش موجود بمجلد system — نزّله مرة وحدة من التحديث')
  const r = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('حط اسم ريبو التحديث بالإعدادات ← النظام (مثال: حسابك/system)')
  const child = spawn('bash', [script, r, String(branch || 'main')], { detached: true, stdio: 'ignore', cwd: path.join(ROOT, '..') })
  child.unref()
  log(`⬇️ بلّش التحديث من ${r} (الإصدار الحالي ${VERSION})`)
  return { started: true, from: VERSION }
}

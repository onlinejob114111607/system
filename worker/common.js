// ============================================================
//  أدوات مشتركة بين عامل الواتساب وعامل تيليجرام
// ============================================================
import { VERSION } from './version.js'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export { FieldValue, Timestamp }

export const ROOT = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.join(ROOT, 'data')
export const TZ = 'Africa/Cairo'
fs.mkdirSync(DATA_DIR, { recursive: true })

// ---------------- Firebase ----------------
const SA_PATH = path.join(ROOT, 'serviceAccount.json')
if (!fs.existsSync(SA_PATH)) {
  process.stdout.write('❌ ملف serviceAccount.json مش موجود بمجلد worker\n')
  process.exit(1)
}
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))) })
export const db = getFirestore()
db.settings({ ignoreUndefinedProperties: true })

// ---------------- أدوات عامة ----------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
export const ms = (ts) => ts?.toMillis?.() || (typeof ts === 'number' ? ts : 0)
export const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
export const cairoHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
const clock = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ })

// التنويع: {مرحبا|أهلاً} ← وحدة عشوائية
export function spin(text) {
  let out = String(text || '')
  const re = /\{([^{}]*)\}/
  let guard = 0
  while (re.test(out) && guard++ < 500) {
    out = out.replace(re, (_, inner) => {
      const opts = inner.split('|')
      return opts[Math.floor(Math.random() * opts.length)]
    })
  }
  return out
}

// تعبئة المتغيرات قبل التنويع ({name} و {رابط}) عشان التنويع ما يبلعها
export function fill(text, vars = {}) {
  let out = String(text || '')
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v ?? '')
  return out
}

export function randomKey(n = 6) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]
  return s
}

// ---------------- مستمع بيرجع يشترك لحاله ----------------
// مستمعات Firestore بتوقف نهائياً لو صار خطأ (مثلاً النت فصل فترة طويلة).
// هاد المستمع بيرجع يشترك تلقائياً بعد الخطأ، بفاصل بيزيد لحد دقيقتين.
// صحة العامل: آخر مرة خلصت فيها حصة Firebase + عدد الأخطاء
export const HEALTH = { quotaAt: 0, errors: 0, lastError: '' }
export function noteError(e) {
  HEALTH.errors++
  HEALTH.lastError = String(e?.message || e).slice(0, 200)
  if (e?.code === 8 || /RESOURCE_EXHAUSTED|quota/i.test(String(e?.message || ''))) HEALTH.quotaAt = Date.now()
}

export function listen(target, onNext, onError = null) {
  let unsub = null
  let stopped = false
  let delay = 5000
  const start = () => {
    if (stopped) return
    try {
      unsub = target.onSnapshot(
        (s) => {
          delay = 5000
          onNext(s)
        },
        (e) => {
          noteError(e)
          try {
            onError?.(e)
          } catch {}
          try {
            unsub?.()
          } catch {}
          setTimeout(start, delay)
          delay = Math.min(delay * 2, 120_000)
        },
      )
    } catch (e) {
      onError?.(e)
      setTimeout(start, delay)
    }
  }
  start()
  return () => {
    stopped = true
    try {
      unsub?.()
    } catch {}
  }
}

// ---------------- الإعدادات العامة (settings/app) ----------------
export const APP_DEFAULTS = {
  siteUrl: '',
  trackRef: 'wa',
  welcomeAccountId: '',
  notify: { enabled: false, botToken: '', chatId: '', registrations: true, workerDown: true, accountIssues: true, funnel: true, daily: true, dailyAt: '23:00' },
  system: { repo: '', branch: 'main' },
  wa: { autoJoin: false, includeUnchecked: false, dailyJoinLimit: 10, allAccounts: true, postUnlimited: false, warmupDays: 14, muteGroups: false, autoClean: false, hourLimit: 40, groupGapHours: 0, autoStop: true, stopAfterFails: 6, pauseHours: 3, minMembers: 20, spamFilter: true, smartSpread: true },
  tg: {
    apiId: '',
    apiHash: '',
    dailyLimit: 15,
    delay: 60,
    scanLimit: 3000,
    joinPublic: true,
    autoCheck: true,
    muteAll: false,
    keywords: [],
    blacklist: [],
    categories: [],
  },
}

export function mergeApp(data) {
  const d = data || {}
  const out = { ...APP_DEFAULTS, ...d }
  for (const k of ['notify', 'wa', 'tg', 'system']) out[k] = { ...APP_DEFAULTS[k], ...(d[k] || {}) }
  return out
}

export class Settings {
  constructor() {
    this.app = mergeApp(null)
    this.site = {}
    this.listeners = []
    let readyApp
    let readySite
    const a = new Promise((r) => (readyApp = r))
    const s = new Promise((r) => (readySite = r))
    this.ready = Promise.race([Promise.all([a, s]), sleep(15000)])
    listen(
      db.doc('settings/app'),
      (d) => {
        this.app = mergeApp(d.data())
        readyApp()
        this.listeners.forEach((f) => f(this.app))
      },
      (e) => process.stdout.write(`⚠️ settings/app: ${e.message}\n`),
    )
    listen(
      db.doc('settings/site'),
      (d) => {
        this.site = d.data() || {}
        readySite()
      },
      () => readySite(),
    )
  }
  onChange(f) {
    this.listeners.push(f)
  }
}

// ---------------- السجل ----------------
// log: على الشاشة بس — event: على الشاشة + بسجل اللوحة (للأحداث المهمة فقط عشان ما نستهلك كتابات)
export function makeLogger(worker) {
  const logs = db.collection('logs')
  const print = (...a) =>
    process.stdout.write([clock(), ...a.map((x) => (typeof x === 'string' ? x : x?.message || JSON.stringify(x)))].join(' ') + '\n')
  const event = (level, msg, account = null) => {
    print(msg)
    logs.add({ worker, level, msg: String(msg).slice(0, 500), account, ts: FieldValue.serverTimestamp() }).catch(() => {})
  }
  return { log: print, event }
}

// تنظيف السجل: بيمسح أحداث العامل الأقدم من 3 أيام (مرة باليوم)
export function startLogPruning(worker) {
  const run = async () => {
    try {
      const cutoff = Timestamp.fromMillis(Date.now() - 3 * 86_400_000)
      for (;;) {
        const snap = await db.collection('logs').where('worker', '==', worker).where('ts', '<', cutoff).limit(400).get()
        if (snap.empty) break
        const b = db.batch()
        snap.docs.forEach((d) => b.delete(d.ref))
        await b.commit()
        if (snap.size < 400) break
      }
    } catch {}
  }
  setTimeout(run, 60_000)
  setInterval(run, 24 * 3600_000)
}

// ---------------- نبض العامل ----------------
export function startHeartbeat(worker, extra = () => ({})) {
  const ref = db.doc(`workers/${worker}`)
  const startedAt = Date.now()
  const beat = () =>
    ref
      .set(
        {
          state: 'running',
          lastSeen: FieldValue.serverTimestamp(),
          startedAt: Timestamp.fromMillis(startedAt),
          host: os.hostname(),
          node: process.version,
          version: VERSION,
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          quotaAt: HEALTH.quotaAt ? Timestamp.fromMillis(HEALTH.quotaAt) : null,
          errors: HEALTH.errors,
          lastError: HEALTH.lastError || null,
          ...extra(),
        },
        { merge: true },
      )
      .catch(() => {})
  beat()
  const t = setInterval(beat, 60_000)
  const stop = async () => {
    clearInterval(t)
    await ref.set({ state: 'stopped', lastSeen: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
  }
  return { beat, stop, ref }
}

// ---------------- الأوامر من اللوحة ----------------
// handler(cmd) بيرجع نتيجة (اختياري). الحقول السرية (كود، كلمة سر) بتنمسح بعد التنفيذ.
export function listenCommands(worker, handler, log) {
  const col = db.collection('commands')
  const run = async (doc) => {
    const claimed = await db
      .runTransaction(async (t) => {
        const s = await t.get(doc.ref)
        if (s.data()?.status !== 'new') return false
        t.update(doc.ref, { status: 'running' })
        return true
      })
      .catch(() => false)
    if (!claimed) return
    const c = doc.data()
    const wipe = { code: FieldValue.delete(), password: FieldValue.delete() }
    try {
      const result = (await handler(c)) ?? null
      await doc.ref.update({ status: 'done', result, doneAt: FieldValue.serverTimestamp(), ...wipe })
    } catch (e) {
      await doc.ref.update({ status: 'error', error: e.message || String(e), doneAt: FieldValue.serverTimestamp(), ...wipe }).catch(() => {})
      log?.(`⚠️ فشل الأمر ${c.type} — ${e.message}`)
    }
  }
  listen(
    col.where('worker', '==', worker).where('status', '==', 'new'),
      (s) => s.docChanges().forEach((ch) => ch.type !== 'removed' && run(ch.doc)),
      (e) => log?.(`⚠️ الأوامر: ${e.message} — رح يرجع يشترك`),
  )

  // تنظيف الأوامر القديمة المنتهية (مرة كل 6 ساعات)
  const clean = async () => {
    try {
      const old = Timestamp.fromMillis(Date.now() - 2 * 86_400_000)
      const snap = await col.where('worker', '==', worker).where('status', 'in', ['done', 'error']).limit(400).get()
      const b = db.batch()
      let n = 0
      snap.docs.forEach((d) => {
        if (ms(d.data().doneAt) && ms(d.data().doneAt) < ms(old)) {
          b.delete(d.ref)
          n++
        }
      })
      if (n) await b.commit()
    } catch {}
  }
  setTimeout(clean, 120_000)
  setInterval(clean, 6 * 3600_000)
}

// ---------------- تنبيهات تيليجرام ----------------
export class Notifier {
  constructor(settings, log) {
    this.settings = settings
    this.log = log
    this.last = new Map()
  }
  static async send(token, chatId, text) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`)
    return j.result?.message_id ?? true
  }
  // kind: registrations | workerDown | accountIssues | test
  async notify(kind, text, { key = null, cooldownMs = 0 } = {}) {
    const n = this.settings.app.notify
    if (kind !== 'test' && (!n.enabled || n[kind] === false)) return false
    if (!n.botToken || !n.chatId) return false
    if (key && cooldownMs) {
      const t = this.last.get(key) || 0
      if (Date.now() - t < cooldownMs) return false
      this.last.set(key, Date.now())
    }
    try {
      return await Notifier.send(n.botToken, n.chatId, text) // رقم الرسالة (للرد عليها)
    } catch (e) {
      this.log?.(`⚠️ تنبيه تيليجرام فشل: ${e.message}`)
      if (kind === 'test') throw e
      return false
    }
  }
}

// مراقبة العامل التاني: لو وقف فجأة (من غير إيقاف يدوي) بيوصلك تنبيه
export function watchOtherWorker(other, notifier) {
  const names = { wa: 'عامل الواتساب', tg: 'عامل تيليجرام' }
  let data = null
  let down = false
  listen(db.doc(`workers/${other}`), (d) => (data = d.data() || null))
  setInterval(() => {
    if (!data) return
    const stale = Date.now() - ms(data.lastSeen) > 4 * 60_000
    if (data.state === 'running' && stale && !down) {
      down = true
      notifier.notify('workerDown', `🔴 ${names[other]} وقف وما عاد بيرد (آخر نبض قبل ${Math.round((Date.now() - ms(data.lastSeen)) / 60000)} دقيقة)`)
    } else if (down && !stale) {
      down = false
      notifier.notify('workerDown', `🟢 ${names[other]} رجع اشتغل`)
    }
  }, 60_000)
}

// ---------------- ملفات محلية (جلسات) ----------------
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export async function deleteQuery(q) {
  let total = 0
  for (;;) {
    const snap = await q.limit(400).get()
    if (snap.empty) break
    const b = db.batch()
    snap.docs.forEach((d) => b.delete(d.ref))
    await b.commit()
    total += snap.size
    if (snap.size < 400) break
  }
  return total
}

// فلتر جودة روابط الصياد: أسماء سبام/إباحية/قمار/نصب (أو مليانة إيموجي)
const SPAM_RE = /(casino|\bbet(s|ting)?\b|1xbet|melbet|\bporn|xxx|\bsex(y)?\b|onlyfans|\bnudes?\b|escort|crypto\s*pump|forex\s*signals?|binary\s*options?|free\s*followers|قمار|مراهنات|كازينو|سكس|اباحي|إباحي|سحب\s*(على\s*)?(فلوس|جوائز|ايفون|آيفون)|اربح\s*\d+\s*\$|توصيات\s*(فوركس|كريبتو)|متابعين\s*مجان)/i
export const isSpamName = (...texts) => texts.some((t) => SPAM_RE.test(String(t || ''))) || (String(texts[0] || '').match(/\p{Extended_Pictographic}/gu) || []).length >= 8

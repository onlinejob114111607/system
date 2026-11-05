// ============================================================
//  عامل الواتساب — متعدد الحسابات
//  نشر على المجموعات، انضمام تلقائي لروابط الصياد، رسائل ترحيب يدوية،
//  ومتابعة المسجلين التلقائية يوم اللقاء (funnel.js)
// ============================================================
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import {
  db,
  FieldValue,
  Timestamp,
  ROOT,
  sleep,
  rand,
  ms,
  dayKey,
  cairoHour,
  spin,
  fill,
  randomKey,
  Settings,
  Notifier,
  listen,
  makeLogger,
  startHeartbeat,
  startLogPruning,
  listenCommands,
  watchOtherWorker,
  deleteQuery,
  isSpamName,
} from './common.js'
import { createFunnel } from './funnel.js'
import { createStore } from './store.js'
import { buildDailyReport, selfUpdate, startDailyReport } from './report.js'

// مكتبة التشفير بتطبع تفاصيل الجلسات على الشاشة — بنسكتها (سجلنا بيكتب مباشرة على stdout)
console.log = console.info = console.debug = console.warn = console.error = () => {}

const { log, event } = makeLogger('wa')
const settings = new Settings()
const notifier = new Notifier(settings, log)
const AUTH_ROOT = path.join(ROOT, 'auth')
const logger = pino({ level: 'silent' })

const accountsCol = db.collection('wa_accounts')
const groupsCol = db.collection('wa_groups')
const postsCol = db.collection('wa_posts')
const dmsCol = db.collection('wa_dms')
const linksCol = db.collection('tg_links')
const regsCol = db.collection('registrations')

const HUNTER_CATEGORY = 'صياد الروابط'
const MUTE_FOREVER_MS = 20 * 365 * 86_400_000
const MUTE_VER = 2 // نسخة طريقة الكتم — لو تغيّرت، بيرجع يكتم كل المجموعات من جديد
const DEFAULT_SETTINGS = {
  minDelay: 40,
  maxDelay: 100,
  dailyLimit: 150,
  joinMinDelay: 90,
  joinMaxDelay: 180,
  joinDailyLimit: 0, // 0 = الحد العام من الإعدادات
  quietStart: 1, // ساعات الهدوء (بتوقيت القاهرة) — نفس الرقمين = بدون هدوء
  quietEnd: 8,
  warmup: false,
}

// ---------------- أدوات ----------------
function parseInviteCode(link) {
  const s = String(link || '').trim()
  const m = s.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/)
  if (m) return m[1]
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s
  return null
}

function errText(e) {
  const msg = e?.output?.payload?.message || e?.message || String(e)
  if (/not-authorized|forbidden|403/i.test(msg)) return 'ممنوع الإرسال (المجموعة للمشرفين فقط أو تم طردك)'
  if (/item-not-found|404|gone|410/i.test(msg)) return 'الرابط منتهي أو المجموعة مش موجودة'
  if (/conflict|409/i.test(msg)) return 'إنت عضو فيها مسبقاً'
  if (/rate-overlimit|429/i.test(msg)) return 'واتساب طالب تهدئة (rate limit)'
  if (/not-acceptable|406/i.test(msg)) return 'الانضمام مرفوض أو المجموعة ممتلئة'
  return msg
}

const isForbidden = (msg) => msg.startsWith('ممنوع الإرسال')



function cleanSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) }
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k !== 'warmup') out[k] = Number(out[k]) || 0
  out.minDelay = Math.max(5, out.minDelay)
  if (out.maxDelay < out.minDelay) out.maxDelay = out.minDelay
  out.joinMinDelay = Math.max(10, out.joinMinDelay)
  if (out.joinMaxDelay < out.joinMinDelay) out.joinMaxDelay = out.joinMinDelay
  out.warmup = !!out.warmup
  return out
}

function inQuietHours(s) {
  const a = s.quietStart % 24
  const b = s.quietEnd % 24
  if (a === b) return false
  const h = cairoHour()
  return a < b ? h >= a && h < b : h >= a || h < b
}

// الرابط: مكان {رابط} بالنص، أو بدل رابط الموقع اللي كاتبه إنت بالنص (عشان يضل متتبّع).
// ما بنضيف رابط من عندنا آخر المنشور — بيضل زي ما كتبته (ما بيطلع الرابط مرتين)
export function placeLink(text, base, url) {
  if (/\{(?:الرابط|رابط)\}/.test(text)) return fill(text, { رابط: url, الرابط: url })
  const b = String(base || '').replace(/\/+$/, '')
  if (!b) return text
  const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${esc}\\/?(?=$|[\\s)\\]،,.!؟?])`)
  return re.test(text) ? text.replace(re, url) : text
}

function trackUrl(base, ref, postKey, groupKey) {
  try {
    const u = new URL(base)
    u.searchParams.set('ref', ref || 'wa')
    u.searchParams.set('src', `${postKey}-${groupKey}`)
    return u.toString()
  } catch {
    return ''
  }
}

// ---------------- الطوابير المحلية (من المستمعين، بدون قراءات متكررة) ----------------
const pendingGroups = new Map() // accountId -> [docSnapshot]
const queuedPosts = new Map() // accountId -> [docSnapshot]
const queuedDms = new Map() // accountId -> [docSnapshot]
const scheduled = new Map() // postId -> scheduledAt ms

function groupBy(docs) {
  const m = new Map()
  for (const d of docs) {
    const id = d.data().accountId
    if (!m.has(id)) m.set(id, [])
    m.get(id).push(d)
  }
  for (const list of m.values()) list.sort((a, b) => ms(a.data().createdAt) - ms(b.data().createdAt))
  return m
}

// ---------------- ربط النتائج مع روابط الصياد ----------------
const AGG = ['queued', 'joined', 'requested', 'error', 'duplicate']
async function reportLink(code, accountId, s, e = null) {
  if (!code) return
  try {
    await db.runTransaction(async (t) => {
      const ref = linksCol.doc(code)
      const snap = await t.get(ref)
      if (!snap.exists) return
      const detail = { ...(snap.data().waDetail || {}) }
      detail[accountId] = { s, e: e || null }
      const states = Object.values(detail).map((x) => x.s)
      const agg = AGG.find((x) => states.includes(x)) || 'duplicate'
      const firstErr = Object.values(detail).find((x) => x.s === 'error' && x.e)?.e || null
      const patch = { waDetail: detail, waStatus: agg, waError: firstErr, waAt: FieldValue.serverTimestamp() }
      if (s === 'error' && e && /منتهي|مش موجودة/.test(e)) patch.status = 'inactive'
      t.update(ref, patch)
    })
  } catch (err) {
    log('⚠️ تحديث رابط الصياد:', err.message)
  }
}

// ============================================================
//  حساب واتساب واحد
// ============================================================
class Account {
  constructor(id, data) {
    this.id = id
    this.ref = accountsCol.doc(id)
    this.authDir = path.join(AUTH_ROOT, id)
    this.sock = null
    this.connected = false
    this.stopped = false
    this.participating = new Map()
    this.joining = false
    this.posting = false
    this.dming = false
    this.muting = false
    this.muteRetryAt = 0
    this.muteScanned = false // فحص الكتم الكامل بيصير مرة وحدة بس لكل تشغيل
    this.rateUntil = 0
    this.limitLoggedDay = null
    this.tried = new Set()
    this.myIds = new Set()
    // تنظيف المجموعات (مغلقة / انطردت منها)
    this.lastMsg = new Map() // jid -> آخر رسالة بالمجموعة (لازمة لحذف المحادثة)
    this.cleanQ = []
    this.cleanSet = new Set()
    this.cleaning = false
    this.cleanScanned = false
    this.recentlyLeft = new Set()
    this.cleanStats = { left: data.clean?.left || 0, deleted: data.clean?.deleted || 0, chats: data.clean?.chats || 0 }
    this.apply(data)
    const today = dayKey()
    this.counter = data.dayKey === today ? { dayKey: today, sentToday: data.sentToday || 0 } : { dayKey: today, sentToday: 0 }
    this.joinCounter = data.joinDayKey === today ? { dayKey: today, joined: data.joinedToday || 0 } : { dayKey: today, joined: 0 }
    this.unsaved = 0
  }

  apply(data) {
    this.data = data
    this.label = data.name || this.id
    this.settings = cleanSettings(data.settings)
  }

  log(...a) {
    log(`[${this.label}]`, ...a)
  }

  event(level, msg) {
    event(level, `[${this.label}] ${msg}`, this.id)
  }

  async set(patch) {
    try {
      await this.ref.update(patch)
    } catch (e) {
      if (e.code !== 5) this.log('⚠️ تعذر تحديث الحالة:', e.message) // 5 = NOT_FOUND
    }
  }

  // ---------- التسخين والحدود ----------
  warmFactor() {
    if (!this.settings.warmup) return 1
    const days = Math.max(1, Number(settings.app.wa.warmupDays) || 14)
    const start = ms(this.data.warmupStartedAt) || Date.now()
    const passed = (Date.now() - start) / 86_400_000
    return Math.min(1, 0.2 + (0.8 * passed) / days)
  }

  joinLimit() {
    const base = this.settings.joinDailyLimit > 0 ? this.settings.joinDailyLimit : Number(settings.app.wa.dailyJoinLimit) || 10
    return Math.max(1, Math.round(base * this.warmFactor()))
  }

  postLimit() {
    const lim = this.settings.dailyLimit
    if (this.settings.warmup) return Math.max(1, Math.round((lim > 0 ? lim : 150) * this.warmFactor()))
    if (settings.app.wa.postUnlimited || lim <= 0) return Infinity
    return lim
  }

  rollDays() {
    const k = dayKey()
    if (this.counter.dayKey !== k) {
      this.counter = { dayKey: k, sentToday: 0 }
      this.set({ dayKey: k, sentToday: 0 })
    }
    if (this.joinCounter.dayKey !== k) {
      this.joinCounter = { dayKey: k, joined: 0 }
      this.set({ joinDayKey: k, joinedToday: 0 })
    }
  }

  joinsLeft() {
    this.rollDays()
    return Math.max(0, this.joinLimit() - this.joinCounter.joined)
  }

  countJoin() {
    this.rollDays()
    this.joinCounter.joined++
    this.set({ joinDayKey: this.joinCounter.dayKey, joinedToday: this.joinCounter.joined })
  }

  countSent(force = false) {
    this.rollDays()
    if (!force) {
      ;(this.sentTimes ||= []).push(Date.now())
      this.counter.sentToday++
      this.unsaved++
    }
    if (force || this.unsaved >= 5) {
      this.unsaved = 0
      this.set({ sentToday: this.counter.sentToday, dayKey: this.counter.dayKey })
    }
  }

  postLimitReached() {
    this.rollDays()
    return this.counter.sentToday >= this.postLimit() || this.hourLimitReached() || this.paused()
  }

  // حماية من الحظر: حد بالساعة + إيقاف مؤقت لو الفشل كتر
  hourLimitReached() {
    const lim = Number(settings.app.wa.hourLimit) || 0
    if (lim <= 0) return false
    const since = Date.now() - 3_600_000
    this.sentTimes = (this.sentTimes || []).filter((t) => t > since)
    return this.sentTimes.length >= Math.max(1, Math.round(lim * this.warmFactor()))
  }

  paused() {
    return (ms(this.data.postPausedUntil) || 0) > Date.now()
  }

  async autoPause(why) {
    const hours = Math.max(0.5, Number(settings.app.wa.pauseHours) || 3)
    const until = Date.now() + hours * 3_600_000
    this.data = { ...this.data, postPausedUntil: Timestamp.fromMillis(until), postPauseWhy: why }
    await this.set({ postPausedUntil: Timestamp.fromMillis(until), postPauseWhy: why })
    this.event('warn', `🛑 النشر وقف ${hours} ساعة لحماية الرقم: ${why}`)
    notifier.notify('accountIssues', `🛑 [${this.label}] وقّفت النشر ${hours} ساعة لحماية الرقم من الحظر\nالسبب: ${why}\nبيرجع يكمّل لحاله بعدها.`)
  }

  quiet() {
    return inQuietHours(this.settings)
  }

  async waitConnected() {
    while (!this.connected) {
      if (this.stopped) throw new Error('stopped')
      await sleep(3000)
    }
  }

  // ---------- الاتصال ----------
  async connect() {
    if (this.stopped) return
    fs.mkdirSync(this.authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    let version
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch {}

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async (u) => {
      if (this.sock !== sock) return
      const { connection, lastDisconnect, qr } = u
      if (qr) {
        this.log('📷 QR جديد')
        await this.set({ state: 'qr', qr, pairingCode: null })
      }
      if (connection === 'connecting') await this.set({ state: 'connecting' })
      if (connection === 'open') {
        this.connected = true
        const phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null
        this.myIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((x) => x.split(':')[0].split('@')[0]))
        this.event('ok', `✅ متصل ${phone ? `+${phone}` : ''}`)
        await this.set({ state: 'open', qr: null, pairingCode: null, phone, waName: sock.user?.name || null, error: null })
        await this.refreshParticipating()
        this.pumpAll()
        if (!this.muteScanned && settings.app.wa.muteGroups) this.pumpMutes()
        if (!this.cleanScanned && settings.app.wa.autoClean) setTimeout(() => this.connected && this.cleanScan(), 90_000)
      }
      if (connection === 'close') {
        this.connected = false
        if (this.stopped) return
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          this.event('error', '🚪 الرقم انفصل من واتساب — محتاج ربط جديد')
          notifier.notify('accountIssues', `🚪 حساب الواتساب "${this.label}" انفصل — افتح اللوحة واربطه من جديد`)
          fs.rmSync(this.authDir, { recursive: true, force: true })
          await this.set({ state: 'logged_out', qr: null, pairingCode: null, phone: null })
          setTimeout(() => this.connect(), 3000)
        } else {
          this.log('🔌 انقطع، إعادة المحاولة...', code ?? '')
          await this.set({ state: 'reconnecting' })
          setTimeout(() => this.connect(), code === DisconnectReason.restartRequired ? 500 : 5000)
        }
      }
    })

    // الرسائل الواردة ← متابعة المسجلين
    sock.ev.on('messages.upsert', (u) => {
      if (this.sock !== sock) return
      for (const m of u.messages || []) {
        const j = m.key?.remoteJid
        if (j?.endsWith('@g.us') && m.key.id && m.messageTimestamp) this.lastMsg.set(j, { key: { ...m.key }, messageTimestamp: m.messageTimestamp })
      }
      funnel.onUpsert(this, u).catch((e) => this.log('⚠️ متابعة:', e.message))
      shop.onUpsert(this, u).catch((e) => this.log('⚠️ المتجر:', e.message))
    })

    // حالة رسائلنا (وصلت / انقرت) ← متابعة: مين شاف التذكير
    sock.ev.on('messages.update', (u) => {
      if (this.sock !== sock) return
      funnel.onUpdate(this, u).catch(() => {})
    })

    // مجموعة صارت مغلقة (للمشرفين بس)
    sock.ev.on('groups.update', (list) => {
      if (this.sock !== sock) return
      for (const g of list || []) {
        const meta = this.participating.get(g.id)
        if (!meta || g.announce === undefined) continue
        meta.announce = !!g.announce
        if (g.announce && settings.app.wa.autoClean && !this.amAdmin(meta)) this.queueClean(g.id, 'المجموعة صارت مغلقة (للمشرفين بس)', true, meta.subject)
      }
      this.pumpClean()
    })

    // لو انطردنا من مجموعة
    sock.ev.on('group-participants.update', async (u) => {
      if (u.action !== 'remove') return
      const ids = (u.participants || []).flatMap((p) => [typeof p === 'string' ? p : p?.id, p?.lid, p?.phoneNumber])
      const me = ids.filter(Boolean).some((x) => this.myIds.has(String(x).split(':')[0].split('@')[0]))
      if (!me) return
      const name = this.participating.get(u.id)?.subject
      this.participating.delete(u.id)
      if (this.recentlyLeft.has(u.id)) return // إحنا اللي طلعنا (تنظيف)
      if (settings.app.wa.autoClean) {
        this.queueClean(u.id, 'انطردت من المجموعة', false, name)
        this.pumpClean()
        return
      }
      const snap = await groupsCol.where('accountId', '==', this.id).where('jid', '==', u.id).get().catch(() => null)
      for (const d of snap?.docs || []) await d.ref.update({ status: 'left', error: 'انطردت من المجموعة' }).catch(() => {})
      this.log('👋 انطردت من مجموعة', u.id)
    })
  }

  stop() {
    this.stopped = true
    this.connected = false
    try {
      this.sock?.end(undefined)
    } catch {}
    this.sock = null
  }

  pumpAll() {
    this.pumpJoins()
    this.pumpPosts()
    this.pumpDms()
  }

  // ---------- كتم المجموعات للأبد ----------
  // يرجع: true (انكتمت) / false (فشل عادي) / 'wait' (مزامنة واتساب لسا ما خلصت) / 'rate'
  async muteJid(jid) {
    try {
      // واتساب بيتعامل مع القيمة كتاريخ انتهاء الكتم (بالملي ثانية) — منحط تاريخ بعد 20 سنة = للأبد عملياً
      await this.sock.chatModify({ mute: Date.now() + MUTE_FOREVER_MS }, jid)
      return true
    } catch (e) {
      const msg = e?.message || String(e)
      if (/app ?state|key.*not (present|found)|no.*key/i.test(msg)) return 'wait'
      if (/rate|429/i.test(msg)) return 'rate'
      this.log('⚠️ كتم:', msg)
      return false
    }
  }

  async pumpMutes(force = false) {
    if (this.muting || !this.connected) return
    if (!force && !settings.app.wa.muteGroups) return
    if (!force && Date.now() < this.muteRetryAt) return
    this.muting = true
    let done = 0
    let total = 0
    let error = null
    try {
      const snap = await groupsCol.where('accountId', '==', this.id).where('status', '==', 'joined').get()
      const all = snap.docs.filter((d) => d.data().jid)
      // الأحدث أول (بيبيّنوا فوق بقائمة المحادثات، فبتشوف النتيجة بسرعة)
      const todo = all
        .filter((d) => d.data().muted !== true || d.data().muteVer !== MUTE_VER)
        .sort((a, b) => ms(b.data().joinedAt || b.data().createdAt) - ms(a.data().joinedAt || a.data().createdAt))
      total = all.length
      done = total - todo.length
      if (!todo.length) {
        this.muteScanned = true
        return
      }
      this.log(`🔕 كتم ${todo.length} مجموعة...`)
      await this.set({ mute: { running: true, done, total, error: null } })
      for (const d of todo) {
        if (this.stopped || !this.connected) break
        if (!force && !settings.app.wa.muteGroups) break
        const r = await this.muteJid(d.data().jid)
        if (r === true) {
          await d.ref.update({ muted: true, muteVer: MUTE_VER }).catch(() => {})
          done++
          if (done % 20 === 0) await this.set({ 'mute.done': done })
        } else if (r === 'wait') {
          error = 'بانتظار ما واتساب يخلص المزامنة — رح يكمل لحاله بعد 10 دقائق'
          this.muteRetryAt = Date.now() + 10 * 60_000
          setTimeout(() => this.pumpMutes(), 10 * 60_000 + 5000)
          break
        } else if (r === 'rate') {
          await sleep(5 * 60_000)
        }
        await sleep(rand(2, 4) * 1000)
      }
      if (done >= total) {
        this.muteScanned = true
        this.event('ok', `🔕 انكتمت كل المجموعات (${total})`)
      }
    } catch (e) {
      error = e.message
      this.log('⚠️ طابور الكتم:', e.message)
    } finally {
      this.muting = false
      if (total) await this.set({ mute: { running: false, done, total, error, at: FieldValue.serverTimestamp() } })
    }
  }

  // ---------- تنظيف المجموعات ----------
  amAdmin(meta) {
    return (meta?.participants || []).some(
      (p) => p.admin && [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => this.myIds.has(String(x).split(':')[0].split('@')[0])),
    )
  }

  queueClean(jid, reason, leave, name = null, ref = null) {
    if (jid && this.cleanSet.has(jid)) return
    if (jid) this.cleanSet.add(jid)
    this.cleanQ.push({ jid, reason, leave, name, ref })
  }

  // حذف المحادثة من قائمة الواتساب (أفضل محاولة — بتحتاج آخر رسالة لو موجودة)
  async removeChat(jid) {
    const lm = this.lastMsg.get(jid)
    try {
      await this.sock.chatModify({ delete: true, lastMessages: lm ? [lm] : [] }, jid)
      this.lastMsg.delete(jid)
      return true
    } catch {
      return false
    }
  }

  // فحص كامل: المغلقة (من بيانات الواتساب بدون قراءات) + اللي انطردنا منها (من القاعدة)
  async cleanScan() {
    if (!this.connected) return { queued: 0 }
    this.cleanScanned = true
    const before = this.cleanQ.length
    for (const [jid, meta] of this.participating) {
      if (meta.announce && !this.amAdmin(meta)) this.queueClean(jid, 'مجموعة مغلقة (للمشرفين بس)', true, meta.subject)
    }
    try {
      const snap = await groupsCol.where('accountId', '==', this.id).where('status', '==', 'left').get()
      for (const d of snap.docs) {
        const g = d.data()
        if (g.jid && this.participating.has(g.jid)) continue
        if (g.jid) this.queueClean(g.jid, g.error || 'مش عضو فيها', false, g.name)
        else this.queueClean(null, g.error || 'مش عضو فيها', false, g.name, d.ref)
      }
    } catch (e) {
      this.log('⚠️ فحص التنظيف:', e.message)
    }
    const queued = this.cleanQ.length - before
    if (queued) this.log(`🧹 ${queued} مجموعة للتنظيف`)
    this.pumpClean()
    return { queued }
  }

  async pumpClean() {
    if (this.cleaning || !this.connected || !this.cleanQ.length) return
    this.cleaning = true
    let done = 0
    const save = (running) =>
      this.set({ clean: { running, ...this.cleanStats, pending: this.cleanQ.length, at: FieldValue.serverTimestamp() } })
    try {
      await save(true)
      while (this.cleanQ.length && !this.stopped && this.connected) {
        const it = this.cleanQ[0]
        const name = it.name || this.participating.get(it.jid)?.subject || it.jid || 'مجموعة'
        if (it.leave && it.jid && this.participating.has(it.jid)) {
          try {
            this.recentlyLeft.add(it.jid)
            await this.sock.groupLeave(it.jid)
            this.participating.delete(it.jid)
            this.cleanStats.left++
          } catch (e) {
            const msg = errText(e)
            if (/rate/i.test(msg)) {
              this.log('🧊 واتساب طلب تهدئة — التنظيف بيكمل بعد 10 دقائق')
              await sleep(10 * 60_000)
              continue
            }
            this.log(`⚠️ خروج من ${name}:`, msg)
          }
          await sleep(rand(3, 6) * 1000)
        }
        this.cleanQ.shift()
        if (it.jid && (await this.removeChat(it.jid))) this.cleanStats.chats++
        const refs = it.ref
          ? [it.ref]
          : it.jid
            ? ((await groupsCol.where('accountId', '==', this.id).where('jid', '==', it.jid).get().catch(() => null))?.docs || []).map((d) => d.ref)
            : []
        for (const r of refs) await r.delete().catch(() => {})
        this.cleanStats.deleted += refs.length
        if (it.jid) this.cleanSet.delete(it.jid)
        done++
        this.log(`🧹 ${it.leave ? 'طلعت من وحذفت' : 'حذفت'}: ${name} — ${it.reason}`)
        if (done % 10 === 0) await save(true)
        await sleep(rand(5, 10) * 1000)
      }
    } catch (e) {
      this.log('⚠️ طابور التنظيف:', e.message)
    } finally {
      this.cleaning = false
      await save(false)
      if (done) this.event('ok', `🧹 تنظيف: ${done} مجموعة (طلعت من ${this.cleanStats.left} ومحذوف ${this.cleanStats.deleted} للحين)`)
    }
  }

  async refreshParticipating() {
    try {
      this.participating = new Map(Object.entries(await this.sock.groupFetchAllParticipating()))
      this.log(`👥 عضو في ${this.participating.size} مجموعة`)
    } catch (e) {
      this.log('⚠️ تعذر جلب المجموعات:', errText(e))
    }
  }

  // ---------- مزامنة المجموعات ----------
  async syncGroups() {
    await this.waitConnected()
    await this.refreshParticipating()
    const snap = await groupsCol.where('accountId', '==', this.id).get()
    const byJid = new Map()
    snap.docs.forEach((d) => d.data().jid && byJid.set(d.data().jid, d))

    let batch = db.batch()
    let n = 0
    const tick = async () => {
      if (++n >= 400) {
        await batch.commit()
        batch = db.batch()
        n = 0
      }
    }
    let added = 0
    for (const [jid, meta] of this.participating) {
      const data = {
        jid,
        name: meta.subject || jid,
        participants: meta.participants?.length ?? meta.size ?? null,
        announce: !!meta.announce,
        status: 'joined',
        error: null,
      }
      const existing = byJid.get(jid)
      if (existing) batch.update(existing.ref, data)
      else {
        added++
        batch.set(groupsCol.doc(`${this.id}_${jid.replace(/[^\w-]/g, '_')}`), {
          ...data,
          accountId: this.id,
          inviteCode: null,
          linkCode: null,
          k: randomKey(),
          category: 'عام',
          enabled: true,
          failCount: 0,
          source: 'sync',
          createdAt: FieldValue.serverTimestamp(),
        })
      }
      await tick()
    }
    for (const [jid, d] of byJid) {
      if (!this.participating.has(jid) && d.data().status === 'joined') {
        if (settings.app.wa.autoClean) this.queueClean(jid, 'مش عضو فيها حالياً', false, d.data().name)
        else {
          batch.update(d.ref, { status: 'left', error: 'مش عضو فيها حالياً' })
          await tick()
        }
      }
    }
    if (n) await batch.commit()
    this.event('info', `🔄 مزامنة: ${this.participating.size} مجموعة (${added} جديدة)`)
    if (added && settings.app.wa.muteGroups) this.pumpMutes()
    if (settings.app.wa.autoClean) this.cleanScan()
    return { total: this.participating.size, added }
  }

  // ---------- الانضمام ----------
  async pumpJoins() {
    if (this.joining || !this.connected) return
    this.joining = true
    try {
      while (!this.stopped) {
        const list = (pendingGroups.get(this.id) || []).filter((d) => !this.tried.has(d.id))
        if (!list.length) break
        await this.waitConnected()
        if (Date.now() < this.rateUntil || this.quiet()) return
        if (this.joinsLeft() <= 0) {
          if (this.limitLoggedDay !== dayKey()) {
            this.log(`📛 وصل حد الانضمام اليومي (${this.joinLimit()}) — الباقي بيكمل بكرة`)
            this.limitLoggedDay = dayKey()
          }
          return
        }
        const d = list[0]
        this.tried.add(d.id)
        const r = await this.joinOne(d)
        if (r === 'rate') {
          this.tried.delete(d.id)
          this.rateUntil = Date.now() + 30 * 60_000
          this.event('warn', '🧊 واتساب طلب تهدئة — وقف الانضمام 30 دقيقة')
          return
        }
        const wait = r === 'joined' ? rand(this.settings.joinMinDelay, this.settings.joinMaxDelay) : rand(3, 8)
        if (r === 'joined') this.log(`⏳ ${wait} ث قبل الانضمام التالي`)
        await sleep(wait * 1000)
      }
    } catch (e) {
      if (e.message !== 'stopped') this.log('⚠️ طابور الانضمام:', e.message)
    } finally {
      this.joining = false
    }
  }

  // يرجع: 'joined' (صار طلب فعلي) / 'skip' / 'rate'
  async joinOne(doc) {
    const g = doc.data()
    const code = parseInviteCode(g.inviteCode)
    const fromHunter = g.source === 'hunter'
    const report = (s, e = null) => fromHunter && reportLink(g.linkCode || code, this.id, s, e)

    if (!code) {
      await doc.ref.update({ status: 'error', error: 'رابط غير صالح' })
      return 'skip'
    }
    try {
      const info = await this.sock.groupGetInviteInfo(code)
      const jid = info.id
      if (info.announce && settings.app.wa.autoClean && !this.participating.has(jid)) {
        await doc.ref.delete().catch(() => {})
        report('error', 'مجموعة مغلقة (للمشرفين بس) — ما انضمينا')
        this.log(`⏭️ ما انضميت لـ ${info.subject || jid}: مجموعة مغلقة`)
        return 'skip'
      }
      // فلتر الجودة (لروابط الصياد بس): مجموعات صغيرة / سبام / ممتلئة
      if (fromHunter && !this.participating.has(jid)) {
        const w = settings.app.wa
        const size = info.size ?? info.participants?.length ?? null
        const min = Number(w.minMembers) || 0
        let why = ''
        if (w.spamFilter !== false && isSpamName(info.subject, info.desc)) why = 'اسمها سبام/مشبوه'
        else if (min > 0 && size != null && size < min) why = `صغيرة (${size} عضو بس)`
        else if (size != null && size >= 1024) why = 'ممتلئة (1024 عضو)'
        if (why) {
          await doc.ref.delete().catch(() => {})
          report('error', `فلتر الجودة: ${why} — ما انضمينا`)
          this.log(`⏭️ ما انضميت لـ ${info.subject || jid}: ${why}`)
          return 'skip'
        }
      }
      const dup = await groupsCol.where('accountId', '==', this.id).where('jid', '==', jid).limit(3).get()
      if (dup.docs.some((x) => x.id !== doc.id && x.data().status === 'joined')) {
        await doc.ref.update({ status: 'error', error: 'المجموعة مضافة مسبقاً', name: info.subject || null })
        report('duplicate', 'هاد الرقم عضو فيها مسبقاً')
        return 'skip'
      }
      const base = {
        jid,
        name: info.subject || jid,
        participants: info.size ?? info.participants?.length ?? null,
        announce: !!info.announce,
        error: null,
      }
      if (this.participating.has(jid)) {
        await doc.ref.update({ ...base, status: 'joined' })
        this.log(`✔️ عضو مسبقاً: ${base.name}`)
        report('joined')
        return 'skip'
      }
      this.countJoin()
      const res = await this.sock.groupAcceptInvite(code)
      if (res) {
        this.participating.set(jid, info)
        const muted = settings.app.wa.muteGroups ? (await this.muteJid(jid)) === true : false
        await doc.ref.update({ ...base, status: 'joined', joinedAt: FieldValue.serverTimestamp(), ...(muted ? { muted: true, muteVer: MUTE_VER } : {}) })
        this.log(`➕ انضممت: ${base.name} (${this.joinCounter.joined}/${this.joinLimit()} اليوم)`)
        report('joined')
      } else {
        await doc.ref.update({ ...base, status: 'requested', error: 'بانتظار موافقة المشرف' })
        this.log(`🕓 طلب انضمام: ${base.name}`)
        report('requested', 'بانتظار موافقة المشرف')
      }
      return 'joined'
    } catch (e) {
      const msg = errText(e)
      if (/rate/i.test(msg)) {
        await doc.ref.update({ error: 'تأجّل: واتساب طالب تهدئة' }).catch(() => {})
        return 'rate'
      }
      await doc.ref.update({ status: 'error', error: msg }).catch(() => {})
      this.log(`❌ انضمام: ${msg}`)
      report('error', msg)
      return 'skip'
    }
  }

  // ---------- النشر ----------
  async pumpPosts() {
    if (this.posting || !this.connected) return
    this.posting = true
    try {
      while (!this.stopped) {
        const next = (queuedPosts.get(this.id) || [])[0]
        if (!next) break
        const handled = await this.processPost(next.ref)
        if (!handled) {
          // ما قدرنا ناخده (انلغى أو أخده غيرنا) — شيله من الطابور المحلي
          const list = queuedPosts.get(this.id) || []
          queuedPosts.set(this.id, list.filter((d) => d.id !== next.id))
        }
      }
    } catch (e) {
      if (e.message !== 'stopped') this.log('⚠️ طابور النشر:', e.message)
    } finally {
      this.posting = false
    }
  }

  async resolveTargets(post) {
    const snap = await groupsCol.where('accountId', '==', this.id).where('status', '==', 'joined').get()
    let groups = snap.docs.filter((d) => d.data().enabled !== false && d.data().jid)
    if (post.target === 'category') groups = groups.filter((d) => (d.data().category || 'عام') === post.category)
    if (post.target === 'selected') {
      const set = new Set(post.groupIds || [])
      groups = groups.filter((d) => set.has(d.id))
    }
    return groups.sort(() => Math.random() - 0.5)
  }

  async isCancelled(ref) {
    const d = (await ref.get()).data()
    return !d || d.status === 'cancelled'
  }

  async buildText(post, gref, gd) {
    // تدوير النص: كل مجموعة بتاخد نسخة عشوائية (النص الأساسي + النسخ البديلة)
    const variants = [post.text, ...(Array.isArray(post.variants) ? post.variants : [])].map((x) => String(x || '')).filter((x) => x.trim())
    let text = variants.length ? variants[Math.floor(Math.random() * variants.length)] : ''
    const base = settings.app.siteUrl
    if (post.track && post.trackKey && base) {
      let k = gd.k
      if (!k) {
        k = randomKey()
        await gref.update({ k }).catch(() => {})
      }
      const url = trackUrl(base, post.trackRef || settings.app.trackRef, post.trackKey, k)
      if (url) text = placeLink(text, base, url)
    } else {
      text = fill(text, { رابط: base || '', الرابط: base || '' })
    }
    return spin(text)
  }

  // يرجع true إذا المنشور اتعالج
  async processPost(ref) {
    const claimed = await db.runTransaction(async (t) => {
      const s = await t.get(ref)
      if (!s.exists || s.data().status !== 'queued') return false
      t.update(ref, { status: 'sending', startedAt: s.data().startedAt || FieldValue.serverTimestamp(), note: null })
      return true
    })
    if (!claimed) return false

    const post = (await ref.get()).data()
    const targets = await this.resolveTargets(post)
    const done = new Set((await ref.collection('results').get()).docs.map((d) => d.id))
    await ref.update({ total: targets.length })
    this.log(`📝 منشور على ${targets.length} مجموعة`)
    let i = 0
    let failStreak = 0
    let rateHits = 0

    for (const g of targets) {
      if (done.has(g.id)) continue
      if (i++ % 5 === 0 && (await this.isCancelled(ref))) {
        this.log('🛑 المنشور اتلغى')
        return true
      }

      try {
        await this.waitConnected()
      } catch {
        await ref.update({ status: 'queued' }).catch(() => {})
        return true
      }

      // ساعات الهدوء + الحد اليومي
      if (this.quiet() || this.postLimitReached()) {
        const why = this.quiet()
          ? `ساعات الهدوء (${this.settings.quietStart}:00–${this.settings.quietEnd}:00) — رح يكمل بعدها`
          : this.paused()
            ? `النشر واقف مؤقتاً لحماية الرقم${this.data.postPauseWhy ? ` (${this.data.postPauseWhy})` : ''} — بيكمل لحاله`
            : this.hourLimitReached()
              ? `وصلت حد الساعة (${settings.app.wa.hourLimit} رسالة) — بيكمل بعد شوي`
              : 'وصلت الحد اليومي — رح يكمل تلقائياً بكرة'
        this.log('⏸️', why)
        this.countSent(true)
        await ref.update({ note: why })
        while (this.quiet() || this.postLimitReached()) {
          await sleep(60_000)
          if (await this.isCancelled(ref)) return true
          if (this.stopped) {
            await ref.update({ status: 'queued' }).catch(() => {})
            return true
          }
        }
        await ref.update({ note: null })
      }

      const gd = g.data()
      // ما بننشر بنفس المجموعة أكتر من مرة خلال فترة قصيرة
      const gapH = Number(settings.app.wa.groupGapHours) || 0
      if (gapH > 0 && ms(gd.lastPostAt) > Date.now() - gapH * 3_600_000) {
        await ref.collection('results').doc(g.id).set({ groupName: gd.name, status: 'skipped', error: `انتشر فيها من أقل من ${gapH} ساعة`, at: FieldValue.serverTimestamp() })
        await ref.update({ skipped: FieldValue.increment(1) }).catch(() => {})
        continue
      }
      try {
        const text = await this.buildText(post, g.ref, gd)
        try {
          await this.sock.sendPresenceUpdate('composing', gd.jid)
          await sleep(rand(2, 5) * 1000)
          await this.sock.sendPresenceUpdate('paused', gd.jid)
        } catch {}
        const sentMsg = await this.sock.sendMessage(gd.jid, { text })
        if (sentMsg?.key?.id) this.lastMsg.set(gd.jid, { key: { ...sentMsg.key }, messageTimestamp: sentMsg.messageTimestamp || Math.floor(Date.now() / 1000) })
        this.countSent()
        await ref.collection('results').doc(g.id).set({ groupName: gd.name, status: 'sent', at: FieldValue.serverTimestamp() })
        await ref.update({ sent: FieldValue.increment(1) })
        failStreak = 0
        await g.ref.update({ lastPostAt: FieldValue.serverTimestamp(), postCount: FieldValue.increment(1), ...(gd.failCount ? { failCount: 0, health: null } : {}) }).catch(() => {})
        this.log(`📤 ${gd.name}`)
      } catch (e) {
        const msg = errText(e)
        await ref.collection('results').doc(g.id).set({ groupName: gd.name, status: 'failed', error: msg, at: FieldValue.serverTimestamp() })
        await ref.update({ failed: FieldValue.increment(1) })
        this.log(`❌ ${gd.name} —`, msg)
        // صحة المجموعة: للمشرفين فقط ← توقف فوراً، 3 فشل متتالي ← توقف
        const fails = (gd.failCount || 0) + 1
        if (isForbidden(msg)) {
          await g.ref.update({ enabled: false, health: 'blocked', error: msg, failCount: fails }).catch(() => {})
          if (settings.app.wa.autoClean) {
            this.queueClean(gd.jid, msg, true, gd.name)
            this.pumpClean()
          }
        } else if (!/rate/i.test(msg)) {
          const patch = { failCount: fails, error: msg }
          if (fails >= 3) Object.assign(patch, { enabled: false, health: 'failing' })
          await g.ref.update(patch).catch(() => {})
        }
        if (/rate/i.test(msg)) rateHits++
        if (!isForbidden(msg)) failStreak++
        // إيقاف تلقائي: فشل ورا بعض أو واتساب طلب تهدئة مرتين
        if (settings.app.wa.autoStop !== false && (failStreak >= Math.max(3, Number(settings.app.wa.stopAfterFails) || 6) || rateHits >= 2)) {
          await this.autoPause(rateHits >= 2 ? 'واتساب طلب تهدئة (rate limit) أكتر من مرة' : `${failStreak} رسائل فشلت ورا بعض`)
          failStreak = 0
          rateHits = 0
        } else if (/rate/i.test(msg)) await sleep(10 * 60_000)
      }

      await sleep(rand(this.settings.minDelay, this.settings.maxDelay) * 1000)
    }

    this.countSent(true)
    await ref.update({ status: 'done', finishedAt: FieldValue.serverTimestamp(), note: null })
    this.event('ok', `🏁 خلص منشور (${targets.length} مجموعة)`)

    if (post.repeat === 'daily') {
      let next = (ms(post.scheduledAt) || Date.now()) + 86_400_000
      while (next < Date.now()) next += 86_400_000
      await postsCol.add({
        accountId: this.id,
        text: post.text,
        variants: Array.isArray(post.variants) ? post.variants : [],
        target: post.target,
        category: post.category || null,
        groupIds: post.groupIds || [],
        repeat: 'daily',
        track: !!post.track,
        trackKey: post.trackKey || null,
        trackRef: post.trackRef || null,
        status: 'scheduled',
        scheduledAt: Timestamp.fromMillis(next),
        sent: 0,
        failed: 0,
        total: 0,
        parentId: ref.id,
        createdAt: FieldValue.serverTimestamp(),
      })
      this.log('🔁 انجدول التكرار الجاي')
    }
    return true
  }

  // ---------- رسائل الترحيب (يدوية من اللوحة) ----------
  async pumpDms() {
    if (this.dming || !this.connected) return
    this.dming = true
    try {
      while (!this.stopped) {
        const list = (queuedDms.get(this.id) || []).filter((d) => !this.tried.has(`dm_${d.id}`))
        if (!list.length) break
        const d = list[0]
        this.tried.add(`dm_${d.id}`)
        await this.waitConnected()
        await this.sendDm(d)
        await sleep(rand(20, 45) * 1000)
      }
    } catch (e) {
      if (e.message !== 'stopped') this.log('⚠️ طابور الترحيب:', e.message)
    } finally {
      this.dming = false
    }
  }

  async sendDm(doc) {
    const m = doc.data()
    const phone = String(m.phone || '').replace(/\D/g, '')
    const regRef = m.regId ? regsCol.doc(m.regId) : null
    const fail = async (error) => {
      await doc.ref.update({ status: 'failed', error }).catch(() => {})
      if (regRef) await regRef.update({ welcome: { status: 'failed', error, at: FieldValue.serverTimestamp(), by: this.label } }).catch(() => {})
      this.log(`❌ ترحيب +${phone}: ${error}`)
    }
    try {
      const [r] = (await this.sock.onWhatsApp(phone)) || []
      if (!r?.exists) return fail('الرقم مش موجود على واتساب')
      const first = String(m.name || '').trim().split(/\s+/)[0] || ''
      const text = spin(fill(m.text || settings.site.waGreeting || 'أهلاً {name} 👋', { name: first }))
      try {
        await this.sock.sendPresenceUpdate('composing', r.jid)
        await sleep(rand(2, 4) * 1000)
      } catch {}
      await this.sock.sendMessage(r.jid, { text })
      this.countSent()
      await doc.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), error: null })
      if (regRef) {
        const reg = await regRef.get()
        if (reg.exists) {
          const patch = { welcome: { status: 'sent', at: FieldValue.serverTimestamp(), by: this.label, error: null } }
          if (reg.data().status === 'new') patch.status = 'contacted'
          await regRef.update(patch)
        }
      }
      this.log(`👋 ترحيب انبعت لـ ${m.name || ''} +${phone}`)
    } catch (e) {
      await fail(errText(e))
    }
  }
}

// ============================================================
//  إدارة الحسابات
// ============================================================
const accounts = new Map()
const funnel = createFunnel({ accounts, settings, log, event, notifier })
const shop = createStore({ accounts, settings, log, event, notifier })

function startAccount(id, data) {
  const acc = new Account(id, data)
  accounts.set(id, acc)
  acc.log('▶️ تشغيل')
  acc.set({ state: 'starting' })
  acc.connect().catch((e) => acc.log('⚠️ فشل الاتصال:', e.message))
  return acc
}

function stopAccount(id, state = 'paused') {
  const acc = accounts.get(id)
  if (!acc) return
  acc.stop()
  accounts.delete(id)
  acc.log('⏸️ إيقاف')
  if (state) acc.set({ state, qr: null, pairingCode: null })
}

async function deleteAccount(id) {
  const acc = accounts.get(id)
  if (acc) {
    acc.stopped = true
    try {
      await acc.sock?.logout()
    } catch {}
    acc.stop()
    accounts.delete(id)
  }
  fs.rmSync(path.join(AUTH_ROOT, id), { recursive: true, force: true })
  const n = await deleteQuery(groupsCol.where('accountId', '==', id))
  const posts = await postsCol.where('accountId', '==', id).get()
  for (const p of posts.docs) {
    await deleteQuery(p.ref.collection('results'))
    await p.ref.delete()
  }
  await deleteQuery(dmsCol.where('accountId', '==', id))
  await accountsCol.doc(id).delete()
  event('info', `🗑️ انحذف حساب واتساب مع ${n} مجموعة و${posts.size} منشور`)
}

// ---------------- الأوامر ----------------
async function handleCommand(c) {
  if (c.type === 'notify_test') {
    await notifier.notify('test', '✅ تجربة تنبيه من النظام — التنبيهات شغالة')
    return { ok: true }
  }
  if (c.type === 'delete_account') return deleteAccount(c.accountId)
  if (c.type === 'daily_report_now') {
    const text = await buildDailyReport()
    await notifier.notify('test', text)
    return { text }
  }
  if (c.type === 'self_update') return selfUpdate({ repo: settings.app.system?.repo, branch: settings.app.system?.branch, log })
  if (String(c.type).startsWith('funnel_')) return funnel.command(c)
  if (String(c.type).startsWith('store_')) return shop.command(c)
  if (c.type === 'clean_groups') {
    const list = c.accountId ? [accounts.get(c.accountId)].filter(Boolean) : [...accounts.values()]
    const live = list.filter((a) => a.connected)
    let queued = 0
    for (const a of live) {
      await a.refreshParticipating()
      queued += (await a.cleanScan()).queued
    }
    return { accounts: live.length, queued }
  }
  if (c.type === 'mute_all') {
    const list = c.accountId ? [accounts.get(c.accountId)].filter(Boolean) : [...accounts.values()]
    const live = list.filter((a) => a.connected)
    live.forEach((a) => {
      a.muteRetryAt = 0
      a.pumpMutes(true)
    })
    return { started: live.length }
  }
  const acc = accounts.get(c.accountId)
  if (!acc) throw new Error('الحساب موقوف أو مش موجود')
  if (c.type === 'pairing') {
    if (!acc.sock) throw new Error('الحساب لسا ما جهز')
    if (acc.sock.authState?.creds?.registered) throw new Error('الحساب مربوط أصلاً')
    const phone = String(c.phone || '').replace(/\D/g, '')
    if (phone.length < 8) throw new Error('رقم غير صالح')
    const code = await acc.sock.requestPairingCode(phone)
    await acc.set({ state: 'pairing', pairingCode: code, qr: null })
    acc.log('🔑 كود الربط:', code)
    return { code }
  }
  if (c.type === 'leave_groups') {
    // تنظيف المجموعات الميتة (من اللوحة): خروج + حذف المحادثة + حذف من القائمة
    if (!acc.connected) throw new Error('الحساب مش متصل هلأ')
    const ids = (c.groupIds || []).slice(0, 300)
    let queued = 0
    for (const id of ids) {
      const d = await groupsCol.doc(id).get()
      if (!d.exists || d.data().accountId !== acc.id) continue
      const g = d.data()
      acc.queueClean(g.jid || null, c.reason || 'تنظيف: مجموعة ميتة', !!g.jid, g.name, d.ref)
      queued++
    }
    acc.pumpClean()
    return { queued }
  }
  if (c.type === 'logout') return void (await acc.sock?.logout().catch(() => {}))
  if (c.type === 'sync_groups') return acc.syncGroups()
  if (c.type === 'restart') {
    try {
      acc.sock?.end(undefined)
    } catch {}
    return null
  }
  throw new Error('أمر غير معروف')
}

// ---------------- روابط الصياد ← مجموعات واتساب ----------------
async function hunterTick() {
  const w = settings.app.wa
  if (!w.autoJoin) return
  try {
    const live = [...accounts.values()].filter((a) => !a.stopped)
    if (!live.length) return
    const slots = live.map((a) => ({
      a,
      cap: a.joinsLeft() - (pendingGroups.get(a.id) || []).length,
      ready: a.connected && Date.now() >= a.rateUntil,
    }))
    const ready = slots.filter((x) => x.ready && x.cap > 0)
    const want = Math.min(50, w.allAccounts ? Math.max(0, ...ready.map((x) => x.cap)) : ready.reduce((s, x) => s + x.cap, 0))
    if (!want) return

    const states = w.includeUnchecked ? ['active', 'unchecked'] : ['active']
    const snap = await linksCol.where('waStatus', '==', 'none').where('status', 'in', states).orderBy('firstSeen', 'desc').limit(want).get()
    if (snap.empty) return

    for (const ld of snap.docs) {
      const l = ld.data()
      const code = ld.id
      const targets = w.allAccounts ? slots.map((s) => s.a) : (() => {
        // توزيع ذكي: اللي عنده مساحة أكتر + مجموعات أقل + نفس التصنيف أقل عنده (تنويع)
        const cat = l.category || HUNTER_CATEGORY
        const score = (x) =>
          w.smartSpread === false
            ? x.cap
            : x.cap * 3 - (x.a.participating?.size || 0) / 40 - (x.cats?.[cat] || 0) * 2 - (x.a.paused?.() ? 2 : 0)
        ready.sort((x, y) => score(y) - score(x))
        const s = ready[0]
        if (!s || s.cap <= 0) return []
        s.cap--
        s.cats = { ...(s.cats || {}), [cat]: (s.cats?.[cat] || 0) + 1 }
        return [s.a]
      })()
      if (!targets.length) continue

      const existing = await groupsCol.where('linkCode', '==', code).get()
      const have = new Set(existing.docs.map((d) => d.data().accountId))
      const detail = {}
      const batch = db.batch()
      for (const a of targets) {
        if (have.has(a.id)) {
          detail[a.id] = { s: 'duplicate', e: 'مضاف مسبقاً لهاد الرقم' }
          continue
        }
        batch.set(groupsCol.doc(), {
          accountId: a.id,
          inviteCode: l.url || `https://chat.whatsapp.com/${code}`,
          linkCode: code,
          name: l.groupName || null,
          jid: null,
          k: randomKey(),
          status: 'pending',
          category: l.category || HUNTER_CATEGORY,
          enabled: true,
          failCount: 0,
          source: 'hunter',
          createdAt: FieldValue.serverTimestamp(),
        })
        detail[a.id] = { s: 'queued', e: null }
      }
      const states2 = Object.values(detail).map((x) => x.s)
      batch.update(ld.ref, {
        waStatus: states2.includes('queued') ? 'queued' : 'duplicate',
        waDetail: detail,
        waAt: FieldValue.serverTimestamp(),
      })
      await batch.commit()
    }
    log(`📥 استلمت ${snap.size} رابط من الصياد`)
  } catch (e) {
    log('⚠️ روابط الصياد:', e.message)
  }
}

// ---------------- تنبيه التسجيلات الجديدة ----------------
function watchRegistrations() {
  const since = Timestamp.now()
  const seen = new Set()
  listen(
    regsCol.where('createdAt', '>', since),
      (s) => {
        for (const ch of s.docChanges()) {
          if (ch.type !== 'added' || seen.has(ch.doc.id)) continue
          seen.add(ch.doc.id)
          funnel.onNewRegistration(ch.doc)
          const r = ch.doc.data()
          const where = [r.city, r.country].filter(Boolean).join('، ')
          const src = [r.ref && r.ref !== 'direct' ? `المسوّق: ${r.ref}` : '', r.utm ? `المصدر: ${r.utm}` : ''].filter(Boolean).join(' · ')
          notifier.notify('registrations', `🆕 تسجيل جديد\n${r.name} — +${r.phone}\n${where}${src ? `\n${src}` : ''}`)
        }
      },
      (e) => log('⚠️ مراقبة التسجيلات:', e.message),
  )
}

// ---------------- التشغيل ----------------
async function main() {
  log('🚀 تشغيل عامل الواتساب...')
  fs.mkdirSync(AUTH_ROOT, { recursive: true })
  await settings.ready

  const hb = startHeartbeat('wa', () => ({
    accounts: accounts.size,
    connected: [...accounts.values()].filter((a) => a.connected).length,
    funnel: funnel.stats(),
    store: shop.stats(),
  }))
  startLogPruning('wa')

  // المنشورات اللي كانت شغالة قبل الإطفاء ترجع للطابور
  // (لو Firebase رافض القراءة — مثلاً الحصة اليومية خلصت — منكمل عادي بدل ما العامل يوقع)
  try {
    for (const d of (await postsCol.where('status', '==', 'sending').get()).docs) await d.ref.update({ status: 'queued' })
    for (const d of (await dmsCol.where('status', '==', 'sending').get()).docs) await d.ref.update({ status: 'queued' })
  } catch (e) {
    log('⚠️ تعذّر ترتيب الطوابير عند التشغيل:', e.message)
  }

  listen(accountsCol, (snap) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id
      const data = ch.doc.data()
      if (ch.type === 'removed') {
        stopAccount(id, null)
        continue
      }
      const acc = accounts.get(id)
      if (data.enabled === false) {
        if (acc) stopAccount(id, 'paused')
        continue
      }
      if (!acc) startAccount(id, data)
      else acc.apply(data)
    }
  }, (e) => log('⚠️ مستمع الحسابات:', e.message))

  listen(
    groupsCol.where('status', '==', 'pending'),
    (s) => {
      const m = groupBy(s.docs)
      pendingGroups.clear()
      m.forEach((v, k) => pendingGroups.set(k, v))
      for (const a of accounts.values()) {
        const ids = new Set((m.get(a.id) || []).map((d) => d.id))
        for (const t of a.tried) if (!t.startsWith('dm_') && !ids.has(t)) a.tried.delete(t)
        if (ids.size) a.pumpJoins()
      }
    },
    (e) => log('⚠️ مستمع المجموعات:', e.message),
  )

  listen(
    postsCol.where('status', '==', 'queued'),
    (s) => {
      const m = groupBy(s.docs)
      queuedPosts.clear()
      m.forEach((v, k) => queuedPosts.set(k, v))
      m.forEach((_, id) => accounts.get(id)?.pumpPosts())
    },
    (e) => log('⚠️ مستمع المنشورات:', e.message),
  )

  listen(
    postsCol.where('status', '==', 'scheduled'),
    (s) => {
      scheduled.clear()
      s.docs.forEach((d) => scheduled.set(d.id, ms(d.data().scheduledAt)))
    },
    (e) => log('⚠️ مستمع الجدولة:', e.message),
  )

  listen(
    dmsCol.where('status', '==', 'queued'),
    (s) => {
      const m = groupBy(s.docs)
      queuedDms.clear()
      m.forEach((v, k) => queuedDms.set(k, v))
      for (const a of accounts.values()) {
        const ids = new Set((m.get(a.id) || []).map((d) => `dm_${d.id}`))
        for (const t of a.tried) if (t.startsWith('dm_') && !ids.has(t)) a.tried.delete(t)
        if (ids.size) a.pumpDms()
      }
    },
    (e) => log('⚠️ مستمع الترحيب:', e.message),
  )

  listenCommands('wa', handleCommand, log)
  startDailyReport({ settings, notifier, log })
  watchRegistrations()
  funnel.start()
  shop.start()
  watchOtherWorker('tg', notifier)

  // الجدولة: محلياً من المستمع (بدون قراءات كل 15 ثانية)
  setInterval(async () => {
    const now = Date.now()
    for (const [id, at] of scheduled) {
      if (at && at <= now) {
        scheduled.delete(id)
        await postsCol.doc(id).update({ status: 'queued' }).catch(() => {})
      }
    }
  }, 15_000)

  setTimeout(hunterTick, 20_000)
  setInterval(hunterTick, 90_000)
  // إعادة تشغيل الطوابير (بعد انتهاء التهدئة أو ساعات الهدوء أو بداية يوم جديد)
  setInterval(() => accounts.forEach((a) => a.pumpAll()), 5 * 60_000)

  // لما يتفعّل الكتم من الإعدادات يبلّش فوراً
  let muteOn = settings.app.wa.muteGroups
  let cleanOn = settings.app.wa.autoClean
  settings.onChange((app) => {
    if (app.wa.muteGroups && !muteOn) accounts.forEach((a) => a.pumpMutes())
    muteOn = app.wa.muteGroups
    if (app.wa.autoClean && !cleanOn) accounts.forEach((a) => a.connected && a.cleanScan())
    cleanOn = app.wa.autoClean
  })

  const shutdown = async () => {
    log('🛑 إيقاف...')
    accounts.forEach((a) => a.countSent(true))
    await hb.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

process.on('unhandledRejection', (e) => log('⚠️', e?.message || String(e)))
main()

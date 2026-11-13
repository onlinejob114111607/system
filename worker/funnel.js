// ============================================================
//  متابعة المسجلين يوم اللقاء (حسب نص الرسائل المعتمد)
//
//  - لكل يوم لقاء وقته (دبي). أيام الاثنين والأربعاء البوك ممكن يبدأ من الليلة اللي قبل
//  - الصبح الساعة 8: مسج تعريفي تلقائي لأقدم 50 مسجّل (الباقي للقاء الجاي)
//  - كل رد بيحرّك العميل للخطوة الجاية حسب شرطها (أي رد / قبول / صورة)
//  - قبل رابط التسجيل: رسالة وضوح إلزامية (الشركة، تسويق شبكي، التكلفة الكاملة)
//  - أسئلة معروفة (موعد اللقاء، الراتب، التكلفة، الشركة) ← رد تلقائي وبيكمل من مكانه
//  - سؤال ما بيعرف جوابه ← تنبيه تيليجرام، بترد إنت (من تيليجرام أو اللوحة) والبوت بيكمل
//  - أي رفض ← بيوقف كل الرسائل والتذكيرات فوراً
//  - اللي خلّص (البوك): تذكير العصر (للبوك البكير) + قبل ساعة + فويس للي ما تفاعل
//    + "ادخل وابعت لقطة" + قائمة تيليجرام باللي ما بعتوا لقطة
//  - اللي ما حضر: دعوة وحدة للقاء الجاي، وبعدها البوت بيوقف معه
//  - بدون اتصالات تلقائية، ورسالة "لم يتم الرد" مرة وحدة بس
// ============================================================
import { generateMessageIDV2 } from 'baileys'
import { spawn } from 'node:child_process'
import { db, FieldValue, sleep, ms, dayKey, spin, fill, listen, TZ } from './common.js'
import { mergeFunnel, meetingTimeOf, scheduleOf, daySummary, SOFT_REJECT, dropEmptyCost, srcOf } from './funnelDefaults.js'

const convCol = db.collection('funnel')
const runsCol = db.collection('funnel_runs')
const regsCol = db.collection('registrations')
const voicesCol = db.collection('funnel_voices')
const cfgRef = db.doc('settings/funnel')

const HISTORY_MAX = 80
const LIVE = ['queued', 'active', 'invite'] // البوت بالمحادثة
const TRACKED = ['queued', 'active', 'invite', 'completed'] // منتابع ردودهم
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
export const TIME_ZONES = {
  دبي: 'Asia/Dubai',
  مصر: 'Africa/Cairo',
  فلسطين: 'Asia/Gaza',
  الأردن: 'Asia/Amman',
  سوريا: 'Asia/Damascus',
  لبنان: 'Asia/Beirut',
  العراق: 'Asia/Baghdad',
  السعودية: 'Asia/Riyadh',
  الكويت: 'Asia/Kuwait',
  قطر: 'Asia/Qatar',
  عمان: 'Asia/Muscat',
  ليبيا: 'Africa/Tripoli',
  تونس: 'Africa/Tunis',
  الجزائر: 'Africa/Algiers',
  المغرب: 'Africa/Casablanca',
  السودان: 'Africa/Khartoum',
  اليمن: 'Asia/Aden',
}

// مفتاح الدولة من الرقم ← التوقيت المحلي
const DIAL = [
  ['971', 'الإمارات', 'Asia/Dubai'],
  ['970', 'فلسطين', 'Asia/Hebron'],
  ['972', 'فلسطين', 'Asia/Jerusalem'],
  ['962', 'الأردن', 'Asia/Amman'],
  ['963', 'سوريا', 'Asia/Damascus'],
  ['961', 'لبنان', 'Asia/Beirut'],
  ['964', 'العراق', 'Asia/Baghdad'],
  ['966', 'السعودية', 'Asia/Riyadh'],
  ['965', 'الكويت', 'Asia/Kuwait'],
  ['974', 'قطر', 'Asia/Qatar'],
  ['973', 'البحرين', 'Asia/Bahrain'],
  ['968', 'عُمان', 'Asia/Muscat'],
  ['967', 'اليمن', 'Asia/Aden'],
  ['218', 'ليبيا', 'Africa/Tripoli'],
  ['216', 'تونس', 'Africa/Tunis'],
  ['213', 'الجزائر', 'Africa/Algiers'],
  ['212', 'المغرب', 'Africa/Casablanca'],
  ['249', 'السودان', 'Africa/Khartoum'],
  ['222', 'موريتانيا', 'Africa/Nouakchott'],
  ['20', 'مصر', 'Africa/Cairo'],
  ['90', 'تركيا', 'Europe/Istanbul'],
  ['49', 'ألمانيا', 'Europe/Berlin'],
  ['44', 'بريطانيا', 'Europe/London'],
  ['33', 'فرنسا', 'Europe/Paris'],
  ['31', 'هولندا', 'Europe/Amsterdam'],
  ['32', 'بلجيكا', 'Europe/Brussels'],
  ['46', 'السويد', 'Europe/Stockholm'],
  ['45', 'الدنمارك', 'Europe/Copenhagen'],
  ['47', 'النرويج', 'Europe/Oslo'],
  ['43', 'النمسا', 'Europe/Vienna'],
  ['39', 'إيطاليا', 'Europe/Rome'],
  ['34', 'إسبانيا', 'Europe/Madrid'],
  ['1', 'أمريكا/كندا', 'America/New_York'],
]
export function zoneOfPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '')
  for (const [code, label, tz] of DIAL) if (p.startsWith(code)) return { label, tz }
  return { label: 'دبي', tz: 'Asia/Dubai' }
}

// ---------------- الوقت ----------------
export const cairoHM = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
export const cairoWeekday = (d = new Date()) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d))
export const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const weekdayOf = (day) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// وقت اللقاء (بتوقيت دبي، UTC+4 ثابت بدون صيفي) بيوم معيّن ← لحظة زمنية
export function meetingInstant(day, meetingTime) {
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm] = meetingTime.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh - 4, mm))
}

// ساعة بتوقيت مصر بيوم معيّن ← لحظة زمنية (مع مراعاة التوقيت الصيفي)
export function cairoInstant(day, hm) {
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm] = hm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  )
  const asCairo = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
  return new Date(guess - (asCairo - guess))
}

export function timeIn(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(/\s*[AP]M$/i, '')
}

export function varsFor(conv, cfg) {
  const day = conv.day || dayKey()
  const [y, m, d] = day.split('-')
  const at = meetingInstant(day, meetingTimeOf(cfg, day))
  const first = String(conv.name || '').trim().split(/\s+/)[0] || ''
  const zone = zoneOfPhone(conv.phone)
  const vars = {
    name: first,
    الاسم: first,
    تاريخ: `${d}/${m}/${y}`,
    يوم: DAYS_AR[weekdayOf(day)],
    المدة: String(cfg.duration),
    رابط: cfg.regLink,
    رقم: cfg.refNo,
    اسمي: cfg.senderName,
    التيم_ليدر: cfg.teamLeader,
    رابط_الإعادة: cfg.replayLink,
    التكلفة: cfg.costText,
    بلدك: zone.label,
    ساعة_محلي: timeIn(at, zone.tz),
    تحية: Number(cairoHM().slice(0, 2)) < 12 ? 'صباح الخير' : 'مساء الخير',
  }
  for (const [label, tz] of Object.entries(TIME_ZONES)) vars[`ساعة_${label}`] = timeIn(at, tz)
  return vars
}

// ---------------- فهم الرد ----------------
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ️‍]/g, '') // تشكيل + تطويل + محددات الإيموجي
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/(.)\1+/gu, '$1') // تمااااام ← تمام
}

const EMOJI = /\p{Extended_Pictographic}/u
function matcher(text) {
  const n = norm(text)
  const t = ` ${n.replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, ' ').trim()} `
  return (k) => {
    const w = norm(k).replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, ' ').trim()
    if (!w) return false
    return EMOJI.test(w) ? n.includes(w) : t.includes(` ${w} `)
  }
}

export const matchAny = (text, words) => words.some(matcher(text))

export function classify(text, acceptWords, rejectWords) {
  const has = matcher(text)
  if (acceptWords.some((k) => /\s/.test(k.trim()) && has(k))) return 'accept' // عبارات زي "لا مانع" قبل كلمة "لا"
  if (rejectWords.some(has)) return 'reject'
  if (acceptWords.some(has)) return 'accept'
  return 'unclear'
}

function unwrap(m) {
  let x = m || {}
  for (let i = 0; i < 6; i++) {
    const inner =
      x.ephemeralMessage?.message ||
      x.viewOnceMessage?.message ||
      x.viewOnceMessageV2?.message ||
      x.viewOnceMessageV2Extension?.message ||
      x.documentWithCaptionMessage?.message ||
      x.editedMessage?.message
    if (!inner) break
    x = inner
  }
  return x
}

export function readMessage(msg) {
  const x = unwrap(msg.message)
  const text =
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    x.documentMessage?.caption ||
    x.reactionMessage?.text ||
    x.buttonsResponseMessage?.selectedDisplayText ||
    x.listResponseMessage?.title ||
    ''
  const image = !!x.imageMessage || /^image\//.test(x.documentMessage?.mimetype || '')
  const audio = !!x.audioMessage
  const other = !text && !image && !audio && !!(x.videoMessage || x.stickerMessage || x.documentMessage || x.contactMessage || x.locationMessage)
  return { text: String(text).trim(), image, audio, other, empty: !text && !image && !audio && !other }
}

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const isUserJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''))
const tsOf = (msg) => Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000
const labelOf = (x) => x.text || (x.image ? '[صورة]' : x.audio ? '[رسالة صوتية]' : '[وسائط]')

const SOFT = new Set(SOFT_REJECT.map((w) => norm(w).trim()))
// رفض "خفيف" = الرد كله كلمة زي "لا" (مش "مش مهتم" أو "احذفني")
export const softOnly = (text) => SOFT.has(norm(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim())

// هل الرسالة سؤال معروف؟ بيرجع الرد التلقائي المناسب
export function matchAuto(text, list) {
  const t = String(text || '').trim()
  if (!t) return null
  const has = matcher(t)
  for (const a of list) {
    if (!a.enabled) continue
    if (a.words.some(has)) return a
    if (a.key === 'time' && /^\s*(متى|امتى|ايمتى|إمتى|وقتيش|قديش|when)(?!\p{L})/iu.test(t) && t.split(/\s+/).length <= 3) return a
  }
  return null
}

// تحويل الفويس لصيغة رسائل واتساب الصوتية (ogg/opus) — لو ffmpeg موجود
function toOpus(buf) {
  return new Promise((resolve) => {
    let p
    try {
      p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'])
    } catch {
      return resolve(null)
    }
    const out = []
    p.on('error', () => resolve(null))
    p.stdout.on('data', (d) => out.push(d))
    p.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null))
    p.stdin.on('error', () => {})
    p.stdin.end(buf)
  })
}

// ============================================================
export function createFunnel({ accounts, settings, log, event, notifier }) {
  let cfg = mergeFunnel(null)
  const convs = new Map() // phone -> conv (TRACKED لليوم وبكرة)
  const dayRows = new Map() // day -> Map(phone -> data) — كل الحالات (للنسب)
  const lastSummary = new Map()
  const lidToPhone = new Map()
  const queue = [] // [{ phone, prio }]
  const inQueue = new Set()
  const buffers = new Map() // phone -> { items, timer }
  const sentIds = new Set()
  const runDone = new Set()
  const voices = new Map() // slot -> { buf, mime, opus }
  const tgMap = new Map() // telegram message_id -> phone
  const flags = new Set() // تنبيهات انبعتت (قوائم، هدف) — بالذاكرة + بوثيقة اليوم
  let pumping = false
  let busyPhone = null
  let batchRunning = false
  let listenKey = null
  let unsubDays = null
  let costWarned = 0

  // ---------- الحساب ----------
  function account() {
    const id = cfg.accountId || settings.app.welcomeAccountId
    const a = id ? accounts.get(id) : [...accounts.values()].find((x) => x.connected)
    return a && a.connected && a.sock ? a : null
  }
  const accountId = () => cfg.accountId || settings.app.welcomeAccountId || [...accounts.values()].find((x) => x.connected)?.id || null

  // ---------- الوقت ----------
  const today = () => dayKey()
  const tomorrow = () => addDays(dayKey(), 1)
  const meetingAt = (day = today()) => meetingInstant(day, meetingTimeOf(cfg, day)).getTime()
  const isMeetingDay = (day) => !!scheduleOf(cfg, day)
  const eveDay = (day) => !!scheduleOf(cfg, day)?.eve
  // مسموح نبعت هلأ لهالمحادثة؟ (يوم اللقاء من بداية المتابعة للتسكير، أو ليلة قبل للأيام المفعّل فيها)
  function canSend(conv) {
    const hm = cairoHM()
    if (conv.day === today()) return hm >= cfg.startTime && hm < cfg.closeTime
    if (conv.day === tomorrow()) return eveDay(conv.day) && hm >= cfg.eveStart && hm < cfg.eveEnd
    return false
  }
  const dayOver = (conv) => conv.day < today() || (conv.day === today() && cairoHM() >= cfg.closeTime)

  // ---------- الطابور ----------
  function enqueue(phone, prio = false) {
    if (inQueue.has(phone) || busyPhone === phone) return
    inQueue.add(phone)
    const item = { phone, prio }
    if (prio) {
      const i = queue.findIndex((q) => !q.prio)
      if (i < 0) queue.push(item)
      else queue.splice(i, 0, item)
    } else queue.push(item)
    pump()
  }

  const hasWork = (c) =>
    (c.outbox?.length && TRACKED.includes(c.status)) || (c.due != null && LIVE.includes(c.status)) || (c.remDue && TRACKED.includes(c.status))

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length) {
        const acc = account()
        if (!acc) return // بيرجع يحاول من المؤقت
        const { phone } = queue.shift()
        inQueue.delete(phone)
        const conv = convs.get(phone)
        if (!conv || !hasWork(conv)) continue
        if (!canSend(conv) && !(conv.remDue && conv.day === today())) continue // بيرجع من المؤقت بوقته
        busyPhone = phone
        try {
          if (conv.outbox?.length) await processOutbox(acc, conv)
          else if (conv.due != null && conv.status === 'invite') await processInvite(acc, conv)
          else if (conv.due != null && LIVE.includes(conv.status)) await processConv(acc, conv)
          else await processReminder(acc, conv)
        } catch (e) {
          log('⚠️ متابعة:', e.message)
        } finally {
          busyPhone = null
        }
        const after = convs.get(phone)
        if (after && hasWork(after) && canSend(after)) enqueue(phone, true) // باقي إله شغل (مثلاً رد تلقائي وبعده الخطوة الجاية)
        await sleep(cfg.clientGap * 1000)
      }
    } finally {
      pumping = false
    }
  }

  async function updateConv(phone, patch) {
    const cur = convs.get(phone)
    if (cur) convs.set(phone, { ...cur, ...patch })
    await convCol
      .doc(phone)
      .update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
      .catch((e) => log('⚠️ تحديث محادثة:', e.message))
  }

  async function updateReg(conv, patch) {
    await regsCol
      .doc(conv.regId || conv.phone)
      .update(patch)
      .catch(() => {})
  }

  async function send(acc, jid, text) {
    const id = generateMessageIDV2(acc.sock.user?.id)
    sentIds.add(id)
    if (sentIds.size > 5000) sentIds.delete(sentIds.values().next().value)
    await acc.sock.sendMessage(jid, { text }, { messageId: id })
    acc.countSent?.()
  }

  async function voiceOf(slot) {
    if (!cfg.voiceOn || !slot) return null
    const v = voices.get(slot)
    if (!v) return null
    if (v.opus === undefined) {
      v.opus = /ogg/.test(v.mime) ? v.buf : await toOpus(v.buf)
      if (!v.opus) log(`ℹ️ الفويس "${slot}" بينبعت كملف صوتي (ثبّت ffmpeg عشان يوصل كرسالة صوتية: pkg install ffmpeg)`)
    }
    return v
  }

  async function sendVoice(acc, jid, slot) {
    const v = await voiceOf(slot)
    if (!v) return false
    try {
      await acc.sock.sendPresenceUpdate('recording', jid)
      await sleep(Math.min(6000, cfg.msgGap * 1000))
      await acc.sock.sendPresenceUpdate('paused', jid)
    } catch {}
    const id = generateMessageIDV2(acc.sock.user?.id)
    sentIds.add(id)
    const content = v.opus ? { audio: v.opus, mimetype: 'audio/ogg; codecs=opus', ptt: true } : { audio: v.buf, mimetype: v.mime || 'audio/mpeg', ptt: false }
    await acc.sock.sendMessage(jid, content, { messageId: id })
    acc.countSent?.()
    return true
  }

  async function typing(acc, jid, sec) {
    const end = Date.now() + sec * 1000
    try {
      await acc.sock.sendPresenceUpdate('composing', jid)
    } catch {}
    await sleep(Math.max(0, end - Date.now()))
    try {
      await acc.sock.sendPresenceUpdate('paused', jid)
    } catch {}
  }

  async function resolveJid(acc, conv) {
    if (conv.jid) return conv.jid
    const [r] = (await acc.sock.onWhatsApp(conv.phone)) || []
    return r?.exists ? r.jid : null
  }

  // بيبعت مجموعة رسائل ورا بعض (بينها msgGap) — عنصر {voice} = فويس
  async function sendSeries(acc, conv, jid, items, history, keepGoing) {
    const vars = varsFor(conv, cfg)
    let sent = 0
    for (const raw of items) {
      if (!keepGoing()) return sent
      if (raw && typeof raw === 'object' && raw.voice) {
        if (await voiceOf(raw.voice)) {
          if (sent) await sleep(Math.max(0, cfg.msgGap * 1000 - 6000))
          await sendVoice(acc, jid, raw.voice)
          sent++
          history.push({ d: 'out', t: '[🎤 فويس]', at: Date.now() })
        }
        continue
      }
      const text = spin(fill(String(raw), vars)).trim()
      if (!text) continue
      await typing(acc, jid, sent ? cfg.msgGap : Math.min(4, cfg.msgGap))
      try {
        await send(acc, jid, text)
      } catch (e) {
        acc.log(`❌ متابعة +${conv.phone}:`, e.message)
        throw e
      }
      sent++
      history.push({ d: 'out', t: text.slice(0, 1500), at: Date.now() })
    }
    return sent
  }

  async function needYou(conv, why, extra = {}, label = '') {
    const phone = conv.phone
    await updateConv(phone, { ...extra, attention: true, attentionWhy: why })
    const st = cfg.steps[conv.step] || {}
    const where = conv.status === 'completed' ? 'بعد البوك' : conv.status === 'invite' ? 'دعوة للقاء الجاي' : `بخطوة: ${st.label || ''}`
    const id = await notifier.notify(
      'funnel',
      `🙋 محتاج جوابك: ${conv.name || ''} +${phone}\n${where}\n${label ? `كتب: ${label.slice(0, 400)}` : why}\n\n↩️ اعمل Reply على هالرسالة واكتب الجواب — ببعته إله وبكمّل المحادثة من مكانها.\n(أو رد بـ /وقف لإيقاف البوت معه)`,
      { key: `att_${phone}`, cooldownMs: 2 * 60_000 },
    )
    if (typeof id === 'number') {
      tgMap.set(id, phone)
      if (tgMap.size > 500) tgMap.delete(tgMap.keys().next().value)
      updateConv(phone, { tgMsgId: id })
    }
  }

  // رسائل جاهزة بالطابور (رد تلقائي، تأكيد حضور، استكمال)
  async function processOutbox(acc, conv) {
    const phone = conv.phone
    let jid
    try {
      jid = await resolveJid(acc, conv)
    } catch {
      return
    }
    if (!jid) return updateConv(phone, { outbox: [] })
    const items = conv.outbox || []
    const history = [...(conv.history || [])]
    const alive = () => TRACKED.includes(convs.get(phone)?.status)
    try {
      await sendSeries(acc, conv, jid, items, history, alive)
    } catch (e) {
      return updateConv(phone, { outbox: [], history: history.slice(-HISTORY_MAX), attention: true, attentionWhy: `فشل الإرسال: ${e.message}` })
    }
    await updateConv(phone, { outbox: [], jid, lastOutAt: Date.now(), history: history.slice(-HISTORY_MAX) })
  }

  function stepItems(st, conv = null, idx = -1) {
    const items = []
    if (st.disclose && cfg.discloseOn) items.push(cfg.disclosure)
    // أول رسالة حسب مصدر التسجيل (لو في قالب للمصدر)
    const tpl = idx === 0 && conv ? cfg.srcTemplates?.[srcOf(conv)] : ''
    if (tpl && String(tpl).trim()) items.push(String(tpl), ...st.messages.slice(1))
    else items.push(...st.messages)
    if (st.voice) items.push({ voice: st.voice })
    return items
  }

  async function processConv(acc, conv) {
    const phone = conv.phone
    if (dayOver(conv)) return expire(conv)
    const steps = cfg.steps
    let idx = conv.due
    if (idx >= steps.length) return complete(conv, conv.history || [])

    let jid
    try {
      jid = await resolveJid(acc, conv)
    } catch (e) {
      acc.log(`⚠️ فحص +${phone}:`, e.message)
      enqueue(phone)
      return
    }
    if (!jid) {
      await updateConv(phone, { status: 'failed', due: null, error: 'الرقم مش موجود على واتساب' })
      await updateReg(conv, { status: 'no_answer', funnel: { status: 'failed', day: conv.day } })
      convs.delete(phone)
      acc.log(`❌ متابعة +${phone}: الرقم مش على واتساب`)
      return
    }

    const history = [...(conv.history || [])]
    const alive = () => LIVE.includes(convs.get(phone)?.status)
    for (;;) {
      if (steps[idx].disclose && cfg.discloseOn && !cfg.costText.trim()) {
        await updateConv(phone, { due: null, attention: true, attentionWhy: 'لازم تكتب "التكلفة الكاملة" بالإعدادات قبل ما يوصله رابط التسجيل', history: history.slice(-HISTORY_MAX) })
        return
      }
      try {
        await sendSeries(acc, conv, jid, stepItems(steps[idx], conv, idx), history, alive)
      } catch (e) {
        await updateConv(phone, { due: null, attention: true, attentionWhy: `فشل الإرسال: ${e.message}`, history: history.slice(-HISTORY_MAX) })
        return
      }
      if (!alive()) {
        await updateConv(phone, { history: history.slice(-HISTORY_MAX) })
        return // اتحول يدوي أو انسكّر من اللوحة
      }
      if (steps[idx].waitFor === 'none' && idx + 1 < steps.length) {
        idx++
        continue
      }
      break
    }

    const patch = {
      jid,
      step: idx,
      due: null,
      waitFor: steps[idx].waitFor,
      attention: false,
      attentionWhy: null,
      error: null,
      lastOutAt: Date.now(),
      history: history.slice(-HISTORY_MAX),
    }
    const wasQueued = conv.status === 'queued'
    if (wasQueued) {
      patch.status = 'active'
      patch.welcomedAt = Date.now()
    }
    if (idx >= steps.length - 1 && steps[idx].waitFor === 'none') {
      await updateConv(phone, patch)
      return complete({ ...conv, ...patch }, history)
    }
    await updateConv(phone, patch)
    if (wasQueued) {
      await updateReg(conv, { status: 'contacted', funnel: { status: 'active', day: conv.day }, welcome: { status: 'sent', at: FieldValue.serverTimestamp(), by: acc.label, error: null } })
      acc.log(`👋 متابعة: مسج تعريفي لـ ${conv.name || ''} +${phone}`)
    } else acc.log(`➡️ متابعة: ${conv.name || phone} ← ${steps[idx].label}`)
  }

  // دعوة اللي ما حضر للقاء الجاي (مرة وحدة)
  async function processInvite(acc, conv) {
    const phone = conv.phone
    if (dayOver(conv)) return expire(conv)
    let jid
    try {
      jid = await resolveJid(acc, conv)
    } catch {
      enqueue(phone)
      return
    }
    if (!jid) return updateConv(phone, { status: 'failed', due: null })
    const history = [...(conv.history || [])]
    try {
      await sendSeries(acc, conv, jid, [cfg.noShowText], history, () => convs.get(phone)?.status === 'invite')
    } catch (e) {
      return updateConv(phone, { due: null, attention: true, attentionWhy: `فشل الإرسال: ${e.message}`, history: history.slice(-HISTORY_MAX) })
    }
    await updateConv(phone, { due: null, jid, lastOutAt: Date.now(), invitedAt: Date.now(), history: history.slice(-HISTORY_MAX) })
    acc.log(`📨 متابعة: دعوة للقاء الجاي لـ ${conv.name || phone} (ما حضر الماضي)`)
  }

  // رسالة "في حال لم يتم الرد" أو تذكيرات قبل اللقاء
  async function processReminder(acc, conv) {
    const phone = conv.phone
    const key = conv.remDue
    const done = async (extra = {}) => updateConv(phone, { remDue: null, rems: { ...(conv.rems || {}), [key]: extra.skip ? 'skip' : Date.now() }, ...extra.patch })
    if (key === 'nudge' ? !canSend(conv) || dayOver(conv) : conv.day !== today()) return done({ skip: true })
    const r = cfg.reminders.find((x) => x.key === key)
    const items = key === 'nudge' ? [cfg.nudgeText] : r ? [...r.messages, ...(r.voice ? [{ voice: r.voice }] : [])] : []
    const tooLate = Date.now() >= meetingAt(conv.day)
    if (!items.length || tooLate) return done({ skip: true })
    let jid
    try {
      jid = await resolveJid(acc, conv)
    } catch {
      enqueue(phone, true)
      return
    }
    if (!jid) return done({ skip: true })
    const history = [...(conv.history || [])]
    const alive = () => TRACKED.includes(convs.get(phone)?.status)
    try {
      await sendSeries(acc, conv, jid, items, history, alive)
    } catch (e) {
      return done({ skip: true, patch: { history: history.slice(-HISTORY_MAX), attention: true, attentionWhy: `فشل الإرسال: ${e.message}` } })
    }
    await done({ patch: { history: history.slice(-HISTORY_MAX), lastOutAt: Date.now(), jid } })
    acc.log(`⏰ متابعة: "${key === 'nudge' ? 'في حال لم يتم الرد' : r?.label}" لـ ${conv.name || phone}`)
  }

  const bookTypeNow = (day) => (Date.now() < cairoInstant(day, cfg.earlyUntil).getTime() ? 'early' : 'late')

  async function complete(conv, history) {
    const bookType = bookTypeNow(conv.day)
    await updateConv(conv.phone, { status: 'completed', due: null, attention: false, attentionWhy: null, completedAt: Date.now(), bookType, history: history.slice(-HISTORY_MAX) })
    await updateReg(conv, { status: 'interested', funnel: { status: 'completed', day: conv.day } })
    event('ok', `✅ ${conv.name || conv.phone} خلّص كل خطوات التسجيل (${bookType === 'early' ? 'بوك بكير' : 'بوك متأخر'})`)
    notifier.notify('funnel', `✅ خلّص التسجيل: ${conv.name || ''} +${conv.phone}`)
  }

  // رفض ← بيوقف كل إشي فوراً
  async function stop(conv, base) {
    const phone = conv.phone
    clearTimeout(buffers.get(phone)?.timer)
    buffers.delete(phone)
    await updateConv(phone, { ...base, status: 'rejected', due: null, remDue: null, outbox: [], attention: false, attentionWhy: null })
    convs.delete(phone)
    await updateReg(conv, { status: 'rejected', funnel: { status: 'rejected', day: conv.day, step: conv.step ?? 0 } })
    event('info', `🚫 ${conv.name || phone} رفض — وقفت كل الرسائل معه`)
  }

  async function expire(conv) {
    const phone = conv.phone
    convs.delete(phone)
    if (conv.status === 'completed') return
    if (conv.status === 'queued' && (conv.step ?? -1) < 0) {
      // ما لحق ينبعتله مسج تعريفي ← بيرجع للانتظار للقاء الجاي
      await convCol.doc(phone).delete().catch(() => {})
      await updateReg(conv, { status: 'new', funnel: FieldValue.delete(), welcome: FieldValue.delete() })
      return
    }
    const replied = (conv.history || []).some((h) => h.d === 'in')
    await convCol.doc(phone).update({ status: 'expired', due: null, remDue: null, outbox: [], updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
    if (conv.status !== 'invite') await updateReg(conv, { ...(replied ? {} : { status: 'no_answer' }), funnel: { status: 'expired', day: conv.day, step: conv.step ?? 0 } })
  }

  // ---------- الرسائل الواردة ----------
  async function phoneOf(acc, key) {
    const jid = key.remoteJid
    if (jid.endsWith('@s.whatsapp.net')) return digits(jid)
    if (key.remoteJidAlt && key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
      const p = digits(key.remoteJidAlt)
      lidToPhone.set(digits(jid), p)
      return p
    }
    const known = lidToPhone.get(digits(jid))
    if (known) return known
    try {
      const pn = await acc.sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
      if (pn) {
        const p = digits(pn)
        lidToPhone.set(digits(jid), p)
        return p
      }
    } catch {}
    return null
  }

  async function onUpsert(acc, { messages }) {
    if (!cfg.enabled || acc.id !== accountId()) return
    for (const msg of messages || []) {
      try {
        const key = msg.key || {}
        if (!isUserJid(key.remoteJid)) continue
        if (tsOf(msg) && Date.now() - tsOf(msg) > 10 * 60_000) continue // رسائل قديمة (مزامنة)
        const phone = await phoneOf(acc, key)
        const conv = phone && convs.get(phone)
        if (!conv) continue
        const r = readMessage(msg)
        if (r.empty) continue
        if (key.fromMe) {
          if (sentIds.has(key.id)) continue
          if (tsOf(msg) && tsOf(msg) < (conv.welcomedAt || conv.invitedAt || 0) - 5000) continue
          await manualReply(acc, conv, labelOf(r))
          continue
        }
        if (key.remoteJid.endsWith('@lid') && !conv.lid) updateConv(phone, { lid: digits(key.remoteJid) })
        let b = buffers.get(phone)
        if (!b) buffers.set(phone, (b = { items: [], timer: null }))
        b.items.push(r)
        clearTimeout(b.timer)
        b.timer = setTimeout(() => {
          buffers.delete(phone)
          evaluate(phone, b.items).catch((e) => log('⚠️ تقييم رد:', e.message))
        }, cfg.debounce * 1000)
      } catch (e) {
        log('⚠️ رسالة واردة:', e.message)
      }
    }
  }

  // إنت رديت بإيدك من الجوال
  async function manualReply(acc, conv, label) {
    const phone = conv.phone
    const history = [...(conv.history || []), { d: 'me', t: label.slice(0, 1500), at: Date.now() }]
    if (cfg.manualStops && LIVE.includes(conv.status)) {
      await updateConv(phone, { status: 'manual', due: null, remDue: null, outbox: [], attention: false, history: history.slice(-HISTORY_MAX) })
      convs.delete(phone)
      acc.log(`✋ رديت بإيدك على ${conv.name || phone} — البوت وقف معه`)
      return
    }
    // الافتراضي: ردك = جواب، والبوت بيضل مستني نفس الخطوة ويكمل
    await updateConv(phone, { history: history.slice(-HISTORY_MAX), attention: false, attentionWhy: null, lastAuto: null })
    if (conv.attention) acc.log(`✍️ جاوبت ${conv.name || phone} من الجوال — البوت بيكمل من مكانه`)
  }

  // قراءة الرسائل (الصحين الزرق) ← "شاف"
  async function onUpdate(acc, updates) {
    if (!cfg.enabled || acc.id !== accountId()) return
    for (const u of updates || []) {
      try {
        const key = u.key || {}
        if (!key.fromMe || !isUserJid(key.remoteJid) || !(Number(u.update?.status) >= 4)) continue
        const phone = await phoneOf(acc, key)
        const conv = phone && convs.get(phone)
        if (!conv || Date.now() - (conv.readAt || 0) < 60_000) continue
        await updateConv(phone, { readAt: Date.now() })
      } catch {}
    }
  }

  const queueOut = async (conv, items, patch = {}) => {
    await updateConv(conv.phone, { ...patch, outbox: [...(conv.outbox || []), ...items] })
    enqueue(conv.phone, true)
  }

  const inJoinWindow = (conv) => {
    const at = meetingAt(conv.day)
    const join = cfg.reminders.find((r) => r.key === 'join')
    const before = (join?.before ?? 18) + 5
    return Date.now() >= at - before * 60_000 && Date.now() <= at + (cfg.duration + 30) * 60_000
  }

  async function evaluate(phone, items) {
    const conv = convs.get(phone)
    if (!conv) return
    const text = items.map((x) => x.text).filter(Boolean).join('\n')
    const image = items.some((x) => x.image)
    const audio = items.some((x) => x.audio)
    const label = text || labelOf(items[0])
    const history = [...(conv.history || []), ...items.map((x) => ({ d: 'in', t: labelOf(x).slice(0, 1500), at: Date.now() }))]
    const base = { history: history.slice(-HISTORY_MAX), lastIn: label.slice(0, 300), lastInAt: Date.now() }
    const st = cfg.steps[conv.step] || {}
    const attention = (why) => needYou(conv, why, base, label)

    // 1) أي رفض واضح ← بيوقف كل إشي فوراً (بأي مرحلة)
    let intent = classify(text, cfg.acceptWords, cfg.rejectWords)
    const soft = intent === 'reject' && softOnly(text)
    if (intent === 'reject' && !image) {
      const stops = !soft || conv.status === 'invite' || (conv.status === 'active' && st.rejectStops !== false)
      if (stops) return stop(conv, base)
      intent = 'unclear'
    }

    // 2) لقطة شاشة وقت دخول اللقاء ← حضور مبدئي
    if (conv.status === 'completed' && image && conv.day === today() && inJoinWindow(conv)) {
      const patch = { ...base, attended: conv.attended || 'prelim', attendedAt: conv.attendedAt || Date.now(), attention: false, attentionWhy: null }
      if (!conv.joinAcked && cfg.joinAck.trim()) return queueOut(conv, [cfg.joinAck], { ...patch, joinAcked: true })
      return updateConv(phone, patch)
    }

    // 3) سؤال معروف ← رد تلقائي والبوت بيكمل من مكانه
    const auto = ['active', 'completed', 'invite'].includes(conv.status) ? matchAuto(text, cfg.autoAnswers) : null
    if (auto) {
      const autoText = dropEmptyCost(auto.text, cfg)
      if (!autoText.trim()) return attention(`سأل عن "${auto.label}"`)
      // "جاهز، بس الساعة كم؟" بخطوة مستنية قبول ← بنجاوب وبنكمل للخطوة الجاية
      const go = conv.status === 'active' && intent === 'accept' && st.waitFor === 'accept' && conv.due == null
      if (go) {
        const t = autoText.split('\n').filter((l) => !/[؟?]\s*$/.test(l)).join('\n')
        await updateConv(phone, { ...base, outbox: [...(conv.outbox || []), t], due: conv.step + 1, attention: false, attentionWhy: null, lastAuto: null })
        return enqueue(phone, true)
      }
      const out = [autoText]
      if (auto.resume && conv.status === 'active' && st.resume) out.push(st.resume)
      return queueOut(conv, out, { ...base, lastAuto: auto.key, attention: false, attentionWhy: null })
    }

    // 4) اللي خلّصوا: بنسجل الرد، ولو فيه مشكلة أو سؤال بيطلعلك
    if (conv.status === 'completed') {
      if (soft) return attention('رد بـ "لا" بعد البوك')
      if (text && (matchAny(text, cfg.problemWords) || /[?؟]/.test(text))) return attention('رد بعد البوك: ' + label.slice(0, 80))
      if (audio && !text) return attention('رسالة صوتية بعد البوك')
      return updateConv(phone, { ...base, lastAuto: null })
    }

    // 5) دعوة اللي ما حضر: قبول ← بوك للقاء الجاي
    if (conv.status === 'invite') {
      if (intent === 'accept') {
        await updateConv(phone, { ...base, attention: false, attentionWhy: null })
        return complete({ ...conv, ...base }, history)
      }
      return attention(audio && !text ? 'بعت رسالة صوتية' : 'رد على الدعوة مش واضح')
    }

    // لسا بنبعتله أو بالطابور ← بنسجل الرد بس (الدور بيوصله)
    if (conv.status !== 'active' || conv.due != null || conv.remDue || conv.outbox?.length || inQueue.has(phone) || busyPhone === phone) {
      await updateConv(phone, base)
      return
    }

    const w = st.waitFor || 'any'
    const advance = async () => {
      await updateConv(phone, { ...base, due: conv.step + 1, attention: false, attentionWhy: null, lastAuto: null })
      if (canSend(conv)) enqueue(phone, true)
    }
    // رد "جاهز/تمام" على سؤال "بتكون جاهز؟" (بعد رد الموعد) بخطوة مش مستنية قبول ← بنذكّره شو المطلوب
    if (conv.lastAuto && intent === 'accept' && w !== 'accept' && !(w === 'image' && image)) {
      if (st.resume) return queueOut(conv, [st.resume], { ...base, lastAuto: null })
      return updateConv(phone, { ...base, lastAuto: null })
    }
    if (w === 'image') return image ? advance() : attention('مستني لقطة الشاشة، وكتب إشي تاني')
    if (w === 'accept') {
      if (intent === 'accept') return advance()
      return attention(audio && !text ? 'بعت رسالة صوتية' : 'رد مش واضح')
    }
    if (audio && !text && !image) return attention('بعت رسالة صوتية')
    return advance()
  }

  // ---------- جوابك على سؤال (من اللوحة أو من تيليجرام) ----------
  async function answer({ phone, text, resume = true, save = false, question = '' }) {
    phone = String(phone || '').replace(/\D/g, '')
    if (!String(text || '').trim()) throw new Error('الجواب فاضي')
    const acc = account()
    if (!acc) throw new Error('حساب المتابعة مش متصل')
    const snap = await convCol.doc(phone).get()
    if (!snap.exists) throw new Error('المحادثة مش موجودة')
    const conv = { ...snap.data(), phone, ...(convs.get(phone) || {}) }
    const jid = await resolveJid(acc, conv)
    if (!jid) throw new Error('الرقم مش على واتساب')
    const vars = varsFor(conv, cfg)
    const history = [...(conv.history || [])]
    const t = fill(dropEmptyCost(String(text), cfg), vars).trim()
    await typing(acc, jid, 2)
    await send(acc, jid, t)
    history.push({ d: 'out', t: t.slice(0, 1500), at: Date.now(), by: 'panel' })
    const st = cfg.steps[conv.step] || {}
    let resumed = false
    if (resume && conv.status === 'active' && st.resume && conv.due == null) {
      const r = fill(st.resume, vars).trim()
      await typing(acc, jid, cfg.msgGap)
      await send(acc, jid, r)
      history.push({ d: 'out', t: r.slice(0, 1500), at: Date.now() })
      resumed = true
    }
    await updateConv(phone, { jid, attention: false, attentionWhy: null, lastAuto: null, lastOutAt: Date.now(), history: history.slice(-HISTORY_MAX) })
    if (save && question.trim()) {
      const cur = mergeFunnel((await cfgRef.get()).data())
      const q = question.trim().slice(0, 80)
      await cfgRef.set({ autoAnswers: [...cur.autoAnswers, { key: `u${Date.now()}`, label: q.slice(0, 40), enabled: true, resume: true, words: [q], text: String(text) }] }, { merge: true })
    }
    return { ok: true, resumed }
  }

  // ---------- ردودك من تيليجرام (Reply على تنبيه "محتاج جوابك") ----------
  let tgOffset = 0
  let tgRunning = false
  async function pollTelegram() {
    if (tgRunning) return
    tgRunning = true
    try {
      for (;;) {
        const n = settings.app.notify || {}
        if (!n.enabled || !n.botToken || !n.chatId || n.funnel === false || !cfg.enabled) {
          await sleep(60_000)
          continue
        }
        let j
        try {
          const r = await fetch(`https://api.telegram.org/bot${n.botToken}/getUpdates?timeout=25&offset=${tgOffset}&allowed_updates=["message"]`, { signal: AbortSignal.timeout(40_000) })
          j = await r.json()
        } catch {
          await sleep(15_000)
          continue
        }
        if (!j?.ok) {
          await sleep(60_000)
          continue
        }
        if (!j.result?.length) await sleep(1000)
        for (const u of j.result || []) {
          tgOffset = u.update_id + 1
          const m = u.message
          if (!m || String(m.chat?.id) !== String(n.chatId) || !m.text) continue
          if (m.date * 1000 < Date.now() - 3 * 3600_000) continue
          const rid = m.reply_to_message?.message_id
          if (!rid) continue
          const phone = tgMap.get(rid) || [...convs.values()].find((c) => c.tgMsgId === rid)?.phone
          if (!phone) {
            notifier.notify('funnel', '⚠️ ما عرفت هالرد لمين — رد من اللوحة.')
            continue
          }
          const c = convs.get(phone)
          try {
            if (/^\/(وقف|stop)(?!\p{L})/iu.test(m.text.trim())) {
              await updateConv(phone, { status: 'manual', due: null, remDue: null, outbox: [], attention: false })
              convs.delete(phone)
              notifier.notify('funnel', `✋ وقفت البوت مع ${c?.name || phone} — صار عندك`)
            } else {
              const r = await answer({ phone, text: m.text })
              notifier.notify('funnel', `✅ انبعت لـ ${c?.name || phone}${r.resumed ? ' — وكمّلت المحادثة من مكانها' : ''}`)
            }
          } catch (e) {
            notifier.notify('funnel', `❌ ما انبعت لـ ${c?.name || phone}: ${e.message}`)
          }
        }
      }
    } finally {
      tgRunning = false
    }
  }

  // ---------- دفعة يوم اللقاء ----------
  async function pickNew(limit) {
    const snap = await regsCol.where('status', '==', 'new').get()
    return snap.docs
      .filter((d) => {
        const r = d.data()
        return !r.funnel && !['sent', 'queued'].includes(r.welcome?.status) && /^\d{8,16}$/.test(String(r.phone || ''))
      })
      .sort((a, b) => ms(a.data().createdAt) - ms(b.data().createdAt))
      .slice(0, limit)
  }

  async function addConvs(docs, day) {
    for (let i = 0; i < docs.length; i += 200) {
      const b = db.batch()
      for (const d of docs.slice(i, i + 200)) {
        const r = d.data()
        const phone = String(r.phone)
        b.set(convCol.doc(phone), {
          phone,
          regId: d.id,
          name: r.name || '',
          country: r.country || '',
          src: String(r.utm || r.source || '').slice(0, 40),
          day,
          status: 'queued',
          step: -1,
          due: 0,
          remDue: null,
          rems: {},
          waitFor: null,
          attention: false,
          history: [],
          regAt: r.createdAt || null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        b.update(d.ref, { status: 'contacted', funnel: { status: 'queued', day } })
      }
      await b.commit()
    }
  }

  // اللي حجزوا وما حضروا (آخر أسبوع) ← دعوة وحدة للقاء هاليوم
  async function inviteNoShows(day) {
    if (!cfg.noShowOn || !cfg.noShowText.trim()) return 0
    const prev = Array.from({ length: 8 }, (_, i) => addDays(day, -(i + 1)))
    const snap = await convCol.where('day', 'in', prev).get()
    const list = snap.docs.filter((d) => {
      const c = d.data()
      return c.status === 'completed' && !c.attended && !c.noShowDone && !c.reinvite && meetingAt(c.day) < Date.now()
    })
    for (const d of list) {
      const c = d.data()
      await d.ref.set({
        phone: d.id,
        regId: c.regId || d.id,
        name: c.name || '',
        country: c.country || '',
        src: c.src || '',
        jid: c.jid || null,
        lid: c.lid || null,
        day,
        status: 'invite',
        reinvite: true,
        noShowDone: true,
        prevDay: c.day,
        step: -1,
        due: 0,
        remDue: null,
        rems: {},
        attention: false,
        history: [...(c.history || []), { d: 'note', t: `— ما حضر لقاء ${c.day} —`, at: Date.now() }].slice(-HISTORY_MAX),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }
    if (list.length) event('info', `📨 ${list.length} ما حضروا اللقاء الماضي — رح توصلهم دعوة وحدة للقاء ${day}`)
    return list.length
  }

  async function runBatch({ day = today(), force = false } = {}) {
    if (batchRunning) return { added: 0, note: 'شغال' }
    if (cfg.discloseOn && !cfg.costText.trim()) {
      if (Date.now() - costWarned > 3600_000) {
        costWarned = Date.now()
        event('error', '⛔ المتابعة ما بدأت: لازم تكتب "التكلفة الكاملة" بإعدادات المتابعة (رسالة الوضوح إلزامية)')
        notifier.notify('funnel', '⛔ المتابعة ما بدأت: اكتب "التكلفة الكاملة" بإعدادات المتابعة باللوحة')
      }
      return { added: 0, note: 'لازم تكتب التكلفة الكاملة بالإعدادات أول' }
    }
    batchRunning = true
    try {
      const runRef = runsCol.doc(day)
      const snap = await runRef.get()
      if (snap.data()?.at && !force) {
        runDone.add(day)
        return { added: 0 }
      }
      const done = snap.data()?.count || 0
      const room = cfg.batchSize - done
      let invited = 0
      if (!snap.data()?.invited) {
        invited = await inviteNoShows(day).catch((e) => (log('⚠️ دعوة اللي ما حضروا:', e.message), 0))
      }
      if (room <= 0) {
        await runRef.set({ day, at: FieldValue.serverTimestamp(), invited: true }, { merge: true })
        runDone.add(day)
        return { added: 0, invited, note: 'دفعة اليوم مكتملة' }
      }
      const list = await pickNew(room)
      await addConvs(list, day)
      await runRef.set({ day, count: done + list.length, batchSize: cfg.batchSize, at: FieldValue.serverTimestamp(), invited: true }, { merge: true })
      runDone.add(day)
      event('ok', `📅 متابعة لقاء ${day}: ${list.length} شخص دخلوا الدفعة${invited ? ` + ${invited} دعوة للي ما حضر` : ''}`)
      return { added: list.length, invited }
    } finally {
      batchRunning = false
    }
  }

  // اليوم اللي بندخّل عليه المسجلين الجداد هلأ (اليوم أو ليلة قبل)
  function openBatchDay() {
    const hm = cairoHM()
    const t = today()
    if (isMeetingDay(t) && hm >= cfg.startTime && hm < cfg.closeTime) return { day: t, late: hm < cfg.lateUntil }
    const tm = tomorrow()
    if (eveDay(tm) && hm >= cfg.eveStart && hm < cfg.eveEnd) return { day: tm, late: true }
    return null
  }

  // تسجيل جديد (يوم اللقاء لحد ساعة معينة، أو ليلة قبل) بيدخل الدفعة لو في مكان
  async function onNewRegistration(doc) {
    try {
      if (!cfg.enabled || cfg.manualOnly || (cfg.discloseOn && !cfg.costText.trim())) return
      const open = openBatchDay()
      if (!open || !open.late) return
      const day = open.day
      if (!runDone.has(day)) return // الدفعة لسا ما اشتغلت، بتلقطه هي
      const r = doc.data()
      if (r.status !== 'new' || r.funnel || !/^\d{8,16}$/.test(String(r.phone || ''))) return
      const runRef = runsCol.doc(day)
      const ok = await db.runTransaction(async (t) => {
        const s = await t.get(runRef)
        const count = s.exists ? s.data().count || 0 : 0
        if (count >= cfg.batchSize) return false
        t.set(runRef, { day, count: count + 1 }, { merge: true })
        return true
      })
      if (!ok) return
      await addConvs([doc], day)
      log(`➕ متابعة: ${r.name} سجّل وانضاف لدفعة لقاء ${day}`)
    } catch (e) {
      log('⚠️ تسجيل جديد للمتابعة:', e.message)
    }
  }

  // ---------- المؤقت: التذكيرات ومراسم آخر ساعة ----------
  const interactedSince = (c, since) => (c.lastInAt || 0) > since || (c.readAt || 0) > since

  async function scheduleTimed() {
    const now = Date.now()
    const t = today()
    const at = meetingAt(t)
    const rems = cfg.reminders.filter((r) => r.enabled && r.kind === 'msg' && (r.messages.length || r.voice)).sort((a, b) => b.before - a.before)
    for (const c of convs.values()) {
      if (c.remDue || c.due != null || c.outbox?.length || busyPhone === c.phone || inQueue.has(c.phone)) continue
      if (c.status === 'completed' && c.day === t && rems.length && now < at) {
        const sent = c.rems || {}
        const dueList = rems.filter((r) => now >= at - r.before * 60_000 && !sent[r.key])
        if (!dueList.length) continue
        const since = Math.max(c.completedAt || 0, ...Object.values(sent).filter((v) => typeof v === 'number'))
        const ok = (r) => (r.who === 'early' ? c.bookType === 'early' : r.who === 'silent' ? !interactedSince(c, since) && !c.attended : !(c.attended && r.key !== 'hour'))
        const last = dueList[dueList.length - 1] // الأقرب للقاء — اللي فاتوا بيتخطوا
        const rmap = { ...sent }
        dueList.slice(0, -1).forEach((r) => (rmap[r.key] = 'skip'))
        if (!ok(last)) {
          rmap[last.key] = 'skip'
          await updateConv(c.phone, { rems: rmap })
          continue
        }
        await updateConv(c.phone, { remDue: last.key, rems: rmap })
        enqueue(c.phone, true)
      } else if (
        c.status === 'active' &&
        cfg.nudgeAfter > 0 &&
        cfg.nudgeText.trim() &&
        !c.nudged &&
        c.lastOutAt &&
        now - c.lastOutAt >= cfg.nudgeAfter * 60_000 &&
        (c.lastInAt || 0) < c.lastOutAt &&
        canSend(c) &&
        now < meetingAt(c.day)
      ) {
        await updateConv(c.phone, { remDue: 'nudge', nudged: true })
        enqueue(c.phone, true)
      }
    }
  }

  async function once(day, key, fn) {
    const k = `${day}:${key}`
    if (flags.has(k)) return
    flags.add(k)
    const ref = runsCol.doc(day)
    const s = await ref.get().catch(() => null)
    if (s?.data()?.flags?.[key]) return
    await fn()
    await ref.set({ day, flags: { [key]: Date.now() } }, { merge: true }).catch(() => {})
  }

  // قبل اللقاء بدقائق: قائمة تيليجرام باللي ما بعتوا لقطة (المتفاعلين أولاً) — للاتصال اليدوي
  async function callLists() {
    const t = today()
    if (!isMeetingDay(t) && !(dayRows.get(t)?.size)) return
    const at = meetingAt(t)
    const now = Date.now()
    for (const r of cfg.reminders.filter((x) => x.enabled && x.kind === 'list')) {
      if (now < at - r.before * 60_000 || now > at + 30 * 60_000) continue
      await once(t, `list_${r.key}`, async () => {
        const booked = [...(dayRows.get(t)?.values() || [])].filter((c) => c.status === 'completed')
        if (!booked.length) return
        const hourAt = (c) => (typeof c.rems?.hour === 'number' ? c.rems.hour : c.completedAt || 0)
        const missing = booked.filter((c) => !c.attended)
        const hot = missing.filter((c) => interactedSince(c, hourAt(c)))
        const cold = missing.filter((c) => !interactedSince(c, hourAt(c)))
        const line = (c, i) => `${i + 1}. ${c.name || ''} +${c.phone}\nwa.me/${c.phone}`
        const parts = [`📋 قبل اللقاء بـ ${r.before} دقائق: ${booked.length - missing.length}/${booked.length} بعتوا لقطة دخول`]
        if (!missing.length) parts.push('\nكلهم بعتوا 👏')
        if (hot.length) parts.push(`\n🟢 تفاعلوا وما بعتوا لقطة (ابدأ فيهم):\n${hot.map(line).join('\n')}`)
        if (cold.length) parts.push(`\n⚪ ما تفاعلوا:\n${cold.map(line).join('\n')}`)
        if (missing.length) parts.push('\n📞 الاتصال يدوي منك — افتح الرابط واتصل من الواتساب.')
        await notifier.notify('funnel', parts.join('\n'))
        await runsCol
          .doc(t)
          .set({ day: t, calls: missing.map((c) => ({ phone: c.phone, name: c.name || '', hot: interactedSince(c, hourAt(c)) })) }, { merge: true })
          .catch(() => {})
      })
    }
  }

  // الهدف اليومي: تنبيه لو البوك متأخر عن الهدف
  async function goalChecks() {
    const t = today()
    const g = cfg.goal
    if (!g.daily || !isMeetingDay(t)) return
    const hm = cairoHM()
    for (const c of g.checks) {
      if (hm < c.at || hm >= cfg.closeTime) continue
      await once(t, `goal_${c.at}`, async () => {
        const booked = daySummary([...(dayRows.get(t)?.values() || [])]).booked
        const target = Math.ceil((g.daily * c.pct) / 100)
        if (booked < target) notifier.notify('funnel', `⚠️ متأخر عن هدف اليوم: ${booked} بوك من ${g.daily} (المفروض ${target} لحد الساعة ${c.at})`)
      })
    }
  }

  // ملخص كل يوم ← funnel_runs/{day}.stats (للنسب)
  async function writeSummaries() {
    for (const [day, rows] of dayRows) {
      if (!rows.size) continue
      const s = daySummary([...rows.values()])
      const j = JSON.stringify(s)
      if (lastSummary.get(day) === j) continue
      lastSummary.set(day, j)
      await runsCol.doc(day).set({ day, stats: s }, { merge: true }).catch(() => lastSummary.delete(day))
    }
  }

  async function tick() {
    try {
      const t = today()
      const hm = cairoHM()
      for (const c of [...convs.values()]) {
        if (busyPhone === c.phone) continue
        if (c.day < t || (c.day === t && hm >= cfg.closeTime && c.status !== 'completed')) await expire(c)
      }
      if (listenKey !== `${t}|${tomorrow()}`) subscribeDays()
      if (cfg.enabled) {
        const open = openBatchDay()
        // وضع «يدوي بس»: الدفعة ما بتبدأ لحالها — بس من زر «ابدأ دفعة اليوم هلأ» باللوحة
        if (open && !runDone.has(open.day) && !cfg.manualOnly) await runBatch({ day: open.day })
        await scheduleTimed()
        await callLists()
        await goalChecks()
        for (const c of convs.values()) if (hasWork(c) && canSend(c)) enqueue(c.phone, (c.due ?? 0) > 0 || !!c.outbox?.length)
      }
      await writeSummaries()
      if (queue.length) pump()
    } catch (e) {
      log('⚠️ مؤقت المتابعة:', e.message)
    }
  }

  function subscribeDays() {
    unsubDays?.()
    const days = [today(), tomorrow()]
    listenKey = days.join('|')
    for (const d of [...dayRows.keys()]) if (!days.includes(d)) dayRows.delete(d)
    unsubDays = listen(
      convCol.where('day', 'in', days),
      (s) => {
        const seen = new Set()
        const rows = new Map(days.map((d) => [d, new Map()]))
        for (const d of s.docs) {
          const c = { ...d.data(), phone: d.id }
          rows.get(c.day)?.set(d.id, c)
          if (!TRACKED.includes(c.status)) continue
          seen.add(d.id)
          const mine = convs.get(d.id)
          if (mine && (mine.history || []).length > (c.history || []).length) c.history = mine.history
          convs.set(d.id, c)
          if (c.lid) lidToPhone.set(String(c.lid), d.id)
          if (hasWork(c) && canSend(c)) enqueue(d.id, (c.due ?? 0) > 0 || !!c.outbox?.length || !!c.remDue)
        }
        for (const [d, m] of rows) dayRows.set(d, m)
        for (const id of [...convs.keys()]) if (!seen.has(id) && busyPhone !== id) convs.delete(id)
      },
      (e) => log('⚠️ مستمع المتابعة:', e.message),
    )
  }

  // ---------- أوامر اللوحة ----------
  async function command(c) {
    if (c.type === 'funnel_run_now') {
      // بوضع «يدوي بس» الدفعة بتنبعت بس بأيام اللقاء
      if (cfg.manualOnly && !isMeetingDay(today())) return { added: 0, note: 'اليوم مش يوم لقاء — بوضع «يدوي بس» الدفعة بتنبعت بس بأيام اللقاء' }
      return runBatch({ day: today(), force: true })
    }
    if (c.type === 'funnel_answer') return answer(c)
    if (c.type === 'funnel_send') {
      const phone = String(c.phone || '').replace(/\D/g, '')
      if (!String(c.text || '').trim()) throw new Error('الرسالة فاضية')
      const acc = account()
      if (!acc) throw new Error('حساب المتابعة مش متصل')
      const snap = await convCol.doc(phone).get()
      if (!snap.exists) throw new Error('المحادثة مش موجودة')
      const conv = { ...snap.data(), phone, ...(convs.get(phone) || {}) }
      const text = fill(dropEmptyCost(String(c.text), cfg), varsFor(conv, cfg)).trim()
      const jid = await resolveJid(acc, conv)
      if (!jid) throw new Error('الرقم مش على واتساب')
      await typing(acc, jid, 2)
      await send(acc, jid, text)
      const history = [...(conv.history || []), { d: 'out', t: text.slice(0, 1500), at: Date.now(), by: 'panel' }]
      await updateConv(phone, { jid, attention: false, attentionWhy: null, history: history.slice(-HISTORY_MAX) })
      return { ok: true }
    }
    throw new Error('أمر غير معروف')
  }

  // ---------- التشغيل ----------
  async function start() {
    listen(
      cfgRef,
      (d) => {
        const was = cfg.enabled
        cfg = mergeFunnel(d.data())
        if (cfg.enabled && !was) log('🗓️ متابعة يوم اللقاء مفعّلة')
      },
      (e) => log('⚠️ إعدادات المتابعة:', e.message),
    )
    listen(
      voicesCol,
      (s) => {
        voices.clear()
        for (const d of s.docs) {
          const v = d.data()
          if (v.data) voices.set(d.id, { buf: Buffer.from(v.data, 'base64'), mime: v.mime || 'audio/ogg' })
        }
      },
      (e) => log('⚠️ الفويسات:', e.message),
    )
    subscribeDays()
    // محادثات أيام سابقة ضلت مفتوحة (العامل كان طافي آخر الليل) ← تتسكّر
    try {
      const old = await convCol.where('status', 'in', LIVE).get()
      for (const d of old.docs) if (d.data().day < today()) await expire({ ...d.data(), phone: d.id })
    } catch (e) {
      log('⚠️ تسكير محادثات قديمة:', e.message)
    }
    setTimeout(tick, 15_000)
    setInterval(tick, 30_000)
    pollTelegram().catch(() => {})
  }

  return {
    start,
    onUpsert,
    onUpdate,
    onNewRegistration,
    command,
    stats: () => ({ live: convs.size, queue: queue.length + (busyPhone ? 1 : 0) }),
  }
}

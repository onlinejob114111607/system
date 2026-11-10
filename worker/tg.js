// ============================================================
//  عامل تيليجرام — صياد روابط جروبات الواتساب
//  حسابات متعددة، دخول الجروبات والقنوات، سحب الروابط، مراقبة حية، فحص صلاحية
// ============================================================
import tg from 'telegram'
import { NewMessage } from 'telegram/events/index.js'
import { EditedMessage } from 'telegram/events/EditedMessage.js'
import { Logger } from 'telegram/extensions/Logger.js'
import path from 'node:path'
import { createShopImport } from './shopImport.js'
import {
  db,
  FieldValue,
  Timestamp,
  DATA_DIR,
  sleep,
  ms,
  dayKey,
  Settings,
  Notifier,
  listen,
  makeLogger,
  startHeartbeat,
  startLogPruning,
  listenCommands,
  watchOtherWorker,
  readJson,
  writeJson,
  isSpamName,
} from './common.js'

const { TelegramClient, Api, utils, errors } = tg
const { StringSession } = tg.sessions
const computeCheck = tg.password.computeCheck

const { log, event } = makeLogger('tg')
const settings = new Settings()
const notifier = new Notifier(settings, log)
const SESS_FILE = path.join(DATA_DIR, 'tg-sessions.json')

const accountsCol = db.collection('tg_accounts')
const sourcesCol = db.collection('tg_sources')
const linksCol = db.collection('tg_links')
const workerRef = db.doc('workers/tg')

const WA_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{15,32})/gi
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GENERIC_TITLES = new Set(['', 'whatsapp', 'whatsapp group invite', 'share on whatsapp', 'whatsapp web'])
const DEAD = new Set(['AUTH_KEY_UNREGISTERED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'SESSION_REVOKED', 'AUTH_KEY_DUPLICATED', 'SESSION_EXPIRED'])
const BAD_STATES = new Set(['banned', 'unauthorized', 'full', 'error'])

class UserError extends Error {}

const T = () => settings.app.tg
const now = () => Date.now()
const rawId = (id) => String(id ?? '').replace(/^-100/, '').replace(/^-/, '')
const lower = (s) => String(s || '').toLowerCase()
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,،]+/)).map((x) => lower(x).trim()).filter(Boolean)

// ---------------- تحليل المصادر ----------------
export function parseSource(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\//i, '')
  s = s.split('?')[0]
  if (s.startsWith('@')) s = s.slice(1)
  let h = null
  if (s.startsWith('+')) h = s.slice(1).split('/')[0]
  else if (/^joinchat\//i.test(s)) h = s.split('/')[1]
  if (h !== null) {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(h)) throw new UserError(`رابط دعوة غير صالح: ${raw}`)
    return ['invite', h]
  }
  if (/^s\//i.test(s)) s = s.slice(2)
  const name = s.split('/')[0]
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new UserError(`مصدر غير صالح: ${raw}`)
  return ['public', name]
}

// ---------------- استخراج الروابط ----------------
function messageText(msg) {
  const texts = []
  if (msg?.message) texts.push(msg.message)
  for (const e of msg?.entities || []) if (e.url) texts.push(e.url)
  for (const row of msg?.replyMarkup?.rows || []) for (const b of row.buttons || []) if (b.url) texts.push(b.url)
  const media = msg?.media
  if (media instanceof Api.MessageMediaWebPage && media.webpage instanceof Api.WebPage) {
    if (media.webpage.url) texts.push(media.webpage.url)
    if (media.webpage.title) texts.push(media.webpage.title)
  }
  return texts.join('\n')
}

// فلتر الكلمات + القائمة السوداء
function extractCodes(msg) {
  const text = messageText(msg)
  if (!text || !/chat\.whatsapp\.com/i.test(text)) return []
  const lt = lower(text)
  const black = listOf(T().blacklist)
  if (black.some((w) => lt.includes(w))) return []
  const keys = listOf(T().keywords)
  if (keys.length && !keys.some((w) => lt.includes(w))) return []
  return [...new Set([...text.matchAll(WA_RE)].map((m) => m[1]))]
}

function categorize(text) {
  const t = lower(text)
  for (const c of T().categories || []) {
    const words = listOf(c.words)
    if (c.name && words.some((w) => t.includes(w))) return String(c.name).trim()
  }
  return null
}

// ---------------- فحص الرابط ----------------
async function checkLink(code) {
  const r = await fetch(`https://chat.whatsapp.com/${code}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (r.status === 404) return ['inactive', null]
  if (r.status >= 400) return ['error', null]
  const page = await r.text()
  const m =
    page.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || page.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:title"/i)
  const title = m ? decodeEntities(m[1]).trim() : ''
  if (GENERIC_TITLES.has(title.toLowerCase())) return ['inactive', null]
  return ['active', title]
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// ============================================================
//  المدير
// ============================================================
const sessions = readJson(SESS_FILE, {})
const saveSessions = () => writeJson(SESS_FILE, sessions)

const clients = new Map() // id -> TelegramClient
const connecting = new Set()
const accData = new Map() // id -> بيانات الحساب من Firestore
const busy = new Set()
const lastAction = new Map()
const cooldown = new Map()
const joins = new Map() // id -> {day, n}
const pendingLogins = new Map() // phone -> {client, hash, needPw}
const monitored = new Map() // rawChatId -> {sid, title}
let pendingSources = []
const inFlight = new Set()
const knownCodes = new Set()
let checkState = { running: false, done: 0, total: 0, active: 0, inactive: 0 }
let stopCheck = false

function makeClient(sess = '') {
  const t = T()
  if (!t.apiId || !t.apiHash) throw new UserError('أدخل api_id و api_hash من صفحة الإعدادات ← تيليجرام أولاً')
  const c = new TelegramClient(new StringSession(sess), Number(t.apiId), String(t.apiHash), {
    connectionRetries: 5,
    autoReconnect: true,
    floodSleepThreshold: 60,
    deviceModel: 'Termux',
    systemVersion: 'Android',
    appVersion: '2.0',
    langCode: 'ar',
    systemLangCode: 'ar',
    baseLogger: new Logger('none'),
  })
  return c
}

const updAcc = (id, patch) => accountsCol.doc(id).update(patch).catch(() => {})

function joinsOf(id) {
  const d = dayKey()
  let j = joins.get(id)
  if (!j) {
    const a = accData.get(id) || {}
    j = { day: d, n: a.joinsDate === d ? a.joinsToday || 0 : 0 }
    joins.set(id, j)
  }
  if (j.day !== d) Object.assign(j, { day: d, n: 0 })
  return j.n
}

function countJoin(id) {
  joinsOf(id)
  const j = joins.get(id)
  j.n++
  updAcc(id, { joinsToday: j.n, joinsDate: j.day })
}

const limitOf = (id) => Number(accData.get(id)?.dailyLimit) || Number(T().dailyLimit) || 15

function attach(client, id) {
  const handler = (ev) => onMessage(ev, id).catch(() => {})
  client.addEventHandler(handler, new NewMessage({}))
  client.addEventHandler(handler, new EditedMessage({}))
}

async function connectAccount(id) {
  if (clients.has(id) || connecting.has(id)) return
  const sess = sessions[id]
  if (!sess) {
    await updAcc(id, { status: 'unauthorized', error: 'ما في جلسة على الجوال — سجّل دخول الحساب من جديد', connected: false })
    return
  }
  connecting.add(id)
  try {
    const c = makeClient(sess)
    await c.connect()
    if (!(await c.checkAuthorization())) {
      await c.disconnect().catch(() => {})
      await updAcc(id, { status: 'unauthorized', error: 'الجلسة انتهت، سجّل دخول الحساب من جديد', connected: false })
      notifier.notify('accountIssues', `⚠️ جلسة حساب تيليجرام ${accData.get(id)?.name || id} انتهت`)
      return
    }
    attach(c, id)
    clients.set(id, c)
    await updAcc(id, { status: 'ok', error: null, connected: true })
    log(`✅ تيليجرام متصل: ${accData.get(id)?.name || id}`)
    if (T().muteAll && accData.get(id)?.muted !== true) applyMute(id, true)
  } catch (e) {
    await updAcc(id, { status: 'error', error: e.message, connected: false })
    event('error', `فشل اتصال حساب تيليجرام: ${e.message}`, id)
  } finally {
    connecting.delete(id)
  }
}

async function disconnect(id) {
  const c = clients.get(id)
  clients.delete(id)
  if (c) await c.disconnect().catch(() => {})
  await releaseSources(id)
}

async function releaseSources(id) {
  const snap = await sourcesCol.where('accountId', '==', id).get().catch(() => null)
  for (const d of snap?.docs || [])
    if (['working', 'scanning'].includes(d.data().status)) await d.ref.update({ status: 'pending', accountId: null }).catch(() => {})
}

async function kill(id, status, err) {
  await disconnect(id)
  await updAcc(id, { status, error: err, connected: false })
  event('error', err, id)
  notifier.notify('accountIssues', `⛔ حساب تيليجرام ${accData.get(id)?.name || id}: ${err}`)
}

// ---------------- كتم الإشعارات ----------------
// إعداد عام بتيليجرام: كل الجروبات وكل القنوات (الحالية والجديدة) مكتومة للأبد
async function applyMute(id, on) {
  const c = clients.get(id)
  if (!c) return false
  try {
    const muteUntil = on ? 2147483647 : 0
    for (const peer of [new Api.InputNotifyChats(), new Api.InputNotifyBroadcasts()])
      await c.invoke(new Api.account.UpdateNotifySettings({ peer, settings: new Api.InputPeerNotifySettings({ muteUntil }) }))
    await updAcc(id, { muted: on, mutedAt: FieldValue.serverTimestamp() })
    log(`${on ? '🔕 انكتم' : '🔔 انلغى كتم'} حساب تيليجرام ${accData.get(id)?.name || id}`)
    return true
  } catch (e) {
    log('⚠️ كتم تيليجرام:', e.message || e.errorMessage)
    return false
  }
}

async function applyMuteAll(on) {
  let n = 0
  for (const id of clients.keys()) if (await applyMute(id, on)) n++
  return n
}

// ---------------- تسجيل الدخول ----------------
async function sendCode(phoneRaw) {
  const phone = '+' + String(phoneRaw || '').replace(/\D/g, '')
  if (phone.length < 8) throw new UserError('رقم الهاتف غير صالح، اكتبه مع مفتاح الدولة')
  const old = pendingLogins.get(phone)
  if (old) await old.client.disconnect().catch(() => {})
  pendingLogins.delete(phone)
  const c = makeClient('')
  await c.connect()
  try {
    const t = T()
    const r = await c.sendCode({ apiId: Number(t.apiId), apiHash: String(t.apiHash) }, phone)
    pendingLogins.set(phone, { client: c, hash: r.phoneCodeHash, needPw: false })
    return { ok: true, phone, viaApp: !!r.isCodeViaApp }
  } catch (e) {
    await c.disconnect().catch(() => {})
    if (e instanceof errors.FloodWaitError) throw new UserError(`طلبات كثيرة، استنى ${e.seconds} ثانية`)
    if (e.errorMessage === 'PHONE_NUMBER_INVALID') throw new UserError('رقم الهاتف غير صالح')
    if (e.errorMessage === 'PHONE_NUMBER_BANNED') throw new UserError('الرقم محظور من تيليجرام')
    throw e
  }
}

async function checkPassword(client, password) {
  try {
    const p = await client.invoke(new Api.account.GetPassword())
    await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(p, password) }))
  } catch (e) {
    if (e.errorMessage === 'PASSWORD_HASH_INVALID') throw new UserError('كلمة سر التحقق بخطوتين غلط')
    throw e
  }
}

async function verify(phoneRaw, code, password) {
  const phone = '+' + String(phoneRaw || '').replace(/\D/g, '')
  const p = pendingLogins.get(phone)
  if (!p) throw new UserError('اطلب الكود من جديد')
  const c = p.client
  try {
    if (!p.needPw) {
      try {
        const r = await c.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: p.hash, phoneCode: String(code || '').trim() }))
        if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new UserError('هاد الرقم مش مسجّل بتيليجرام')
      } catch (e) {
        if (e.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw e
        p.needPw = true
        if (!password) return { needPassword: true }
        await checkPassword(c, password)
      }
    } else {
      if (!password) return { needPassword: true }
      await checkPassword(c, password)
    }
  } catch (e) {
    if (e instanceof UserError) throw e
    if (e.errorMessage === 'PHONE_CODE_INVALID') throw new UserError('الكود غلط')
    if (e.errorMessage === 'PHONE_CODE_EXPIRED') {
      pendingLogins.delete(phone)
      await c.disconnect().catch(() => {})
      throw new UserError('الكود انتهى، اطلبه من جديد')
    }
    if (e instanceof errors.FloodWaitError) throw new UserError(`طلبات كثيرة، استنى ${e.seconds} ثانية`)
    throw e
  }

  const me = await c.getMe()
  const id = phone.slice(1)
  sessions[id] = c.session.save()
  saveSessions()
  pendingLogins.delete(phone)
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || phone
  const old = clients.get(id)
  if (old && old !== c) await old.disconnect().catch(() => {})
  attach(c, id)
  clients.set(id, c)
  await accountsCol.doc(id).set(
    {
      phone,
      name,
      username: me.username || null,
      enabled: true,
      status: 'ok',
      error: null,
      connected: true,
      floodUntil: 0,
      created: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  event('ok', `تمت إضافة حساب تيليجرام ${name}`, id)
  if (T().muteAll) applyMute(id, true)
  return { ok: true, name }
}

async function deleteAccount(id) {
  await disconnect(id)
  delete sessions[id]
  saveSessions()
  await accountsCol.doc(id).delete().catch(() => {})
  event('info', `🗑️ انحذف حساب تيليجرام ${id}`)
}

// ---------------- مصادر مقترحة: روابط قنوات تيليجرام بتنذكر بالمصادر ----------------
const suggestCol = db.collection('tg_suggest')
const TG_RE = /(?:https?:\/\/)?(?:t|telegram)\.me\/(\+[\w-]{10,}|joinchat\/[\w-]{10,}|[A-Za-z][\w]{3,31})(?:\/\d+)?/gi
const TG_SKIP = /^(share|addstickers|addemoji|proxy|socks|iv|s|c|setlanguage|joinchat|login|contact|boost|addlist|.*bot)$/i
const suggestBuf = new Map() // id -> {ref, n, sources:Set}
function noteSuggestions(msg, sid) {
  const text = messageText(msg)
  if (!text || !/(t|telegram)\.me\//i.test(text)) return
  for (const m of text.matchAll(TG_RE)) {
    const raw = m[1]
    let id
    let ref
    if (raw.startsWith('+') || /^joinchat\//i.test(raw)) {
      const h = raw.replace(/^\+|^joinchat\//i, '')
      id = `invite_${h}`
      ref = `https://t.me/+${h}`
    } else {
      if (TG_SKIP.test(raw)) continue
      id = `public_${raw.toLowerCase()}`
      ref = `https://t.me/${raw}`
    }
    const e = suggestBuf.get(id) || { ref, n: 0, sources: new Set() }
    e.n++
    e.sources.add(sid)
    suggestBuf.set(id, e)
  }
}
async function flushSuggestions() {
  if (!suggestBuf.size) return
  const entries = [...suggestBuf.entries()]
  suggestBuf.clear()
  // المصادر الموجودة أصلاً ما بنقترحها
  const existing = new Set((await sourcesCol.select().get()).docs.map((d) => d.id))
  let batch = db.batch()
  let n = 0
  for (const [id, e] of entries) {
    if (existing.has(id)) continue
    batch.set(suggestCol.doc(id), { ref: e.ref, mentions: FieldValue.increment(e.n), sources: FieldValue.arrayUnion(...[...e.sources].slice(0, 20)), lastSeen: FieldValue.serverTimestamp(), status: 'new' }, { merge: true })
    if (++n >= 400) {
      await batch.commit()
      batch = db.batch()
      n = 0
    }
  }
  if (n) await batch.commit()
}

// بحث عن قنوات/جروبات عامة بكلمة
async function searchTelegram(q) {
  q = String(q || '').trim()
  if (q.length < 3) throw new Error('اكتب كلمة من 3 حروف على الأقل')
  const c = [...clients.entries()].find(([id]) => {
    const a = accData.get(id)
    return a && a.enabled !== false && !BAD_STATES.has(a.status) && !((Number(a.floodUntil) || 0) > Date.now())
  })?.[1]
  if (!c) throw new Error('ما في حساب تيليجرام جاهز للبحث')
  const r = await c.invoke(new Api.contacts.Search({ q, limit: 50 }))
  const existing = new Set((await sourcesCol.select().get()).docs.map((d) => d.id))
  return (r.chats || [])
    .filter((ch) => ch.username && (ch.className === 'Channel' || ch.className === 'Chat'))
    .map((ch) => ({
      id: `public_${String(ch.username).toLowerCase()}`,
      username: ch.username,
      title: ch.title || ch.username,
      members: ch.participantsCount ?? null,
      kind: ch.megagroup ? 'group' : ch.broadcast ? 'channel' : 'group',
      added: existing.has(`public_${String(ch.username).toLowerCase()}`),
    }))
    .slice(0, 50)
}

// ---------------- المراقبة الحية ----------------
// قنوات منتجات المتجر ← مسودات منتجات
const shop = createShopImport({ clients, accData, log, event, notifier, Api })

async function onMessage(ev, id) {
  try {
    if (shop.onMessage(ev)) return
  } catch (e) {
    log('⚠️ استيراد منتج:', e.message)
  }
  const msg = ev.message
  const info = monitored.get(rawId(msg?.chatId ?? ev.chatId))
  if (!info) return
  noteSuggestions(msg, info.sid)
  const codes = extractCodes(msg)
  if (!codes.length) return
  let n = 0
  for (const c of codes) if (await saveLink(c, info.sid, info.title, msg.date)) n++
  if (n) {
    await sourcesCol.doc(info.sid).update({ linksFound: FieldValue.increment(n) }).catch(() => {})
    log(`🔴 مباشر: ${n} رابط جديد من ${info.title}`)
  }
}

async function saveLink(code, sid, title, msgDate) {
  if (knownCodes.has(code)) return false
  knownCodes.add(code)
  try {
    await linksCol.doc(code).create({
      url: `https://chat.whatsapp.com/${code}`,
      sourceId: sid,
      sourceTitle: title || null,
      msgDate: msgDate ? Timestamp.fromMillis(Number(msgDate) * 1000) : null,
      firstSeen: FieldValue.serverTimestamp(),
      status: 'unchecked',
      groupName: null,
      category: null,
      checkedAt: null,
      waStatus: 'none',
    })
    return true
  } catch (e) {
    if (e.code === 6) return false // موجود مسبقاً
    knownCodes.delete(code)
    throw e
  }
}

// ---------------- توزيع المهام ----------------
function prefUsable(pref) {
  const a = accData.get(pref)
  return !!(a && a.enabled !== false && !BAD_STATES.has(a.status))
}

function pick(pref) {
  const t = now()
  const delay = Number(T().delay) || 60
  const ids = pref && prefUsable(pref) ? [pref] : [...accData.keys()]
  let best = null
  for (const id of ids) {
    const a = accData.get(id)
    if (!a || a.enabled === false || !clients.has(id) || busy.has(id)) continue
    if (BAD_STATES.has(a.status)) continue
    if ((Number(a.floodUntil) || 0) > t) continue
    if ((lastAction.get(id) || 0) + (cooldown.get(id) ?? delay) * 1000 > t) continue
    const j = joinsOf(id)
    if (j >= limitOf(id)) continue
    if (!best || j < best[1]) best = [id, j]
  }
  return best?.[0] || null
}

async function dispatch() {
  const list = pendingSources
    .filter((d) => !inFlight.has(d.id))
    .sort((a, b) => (a.data().attempts || 0) - (b.data().attempts || 0) || ms(a.data().created) - ms(b.data().created))
    .slice(0, 50)
  for (const d of list) {
    const id = pick(d.data().accountPref)
    if (!id) continue
    busy.add(id)
    inFlight.add(d.id)
    await d.ref.update({ status: 'working', accountId: id, updated: FieldValue.serverTimestamp() }).catch(() => {})
    processSource(d.id, d.data(), id).finally(() => inFlight.delete(d.id))
  }
}

async function joinSource(client, id, kind, val) {
  if (kind === 'invite') {
    let info
    try {
      info = await client.invoke(new Api.messages.CheckChatInvite({ hash: val }))
    } catch (e) {
      if (['INVITE_HASH_EXPIRED', 'INVITE_HASH_INVALID'].includes(e.errorMessage)) throw new UserError('رابط الدعوة منتهي أو غير صالح')
      throw e
    }
    if (info instanceof Api.ChatInviteAlready || info instanceof Api.ChatInvitePeek) return info.chat
    countJoin(id)
    try {
      const upd = await client.invoke(new Api.messages.ImportChatInvite({ hash: val }))
      if (!upd?.chats?.length) throw new UserError('ما قدرت أحدد الجروب بعد الانضمام')
      return upd.chats[0]
    } catch (e) {
      if (e.errorMessage === 'USER_ALREADY_PARTICIPANT') {
        const i2 = await client.invoke(new Api.messages.CheckChatInvite({ hash: val }))
        return i2.chat
      }
      if (e.errorMessage === 'INVITE_REQUEST_SENT') throw new UserError('الجروب يحتاج موافقة الأدمن — انبعت طلب انضمام، أعد المحاولة بعد القبول')
      throw e
    }
  }
  let ent
  try {
    ent = await client.getEntity(val)
  } catch (e) {
    if (['USERNAME_NOT_OCCUPIED', 'USERNAME_INVALID'].includes(e.errorMessage) || /cannot find any entity|no user has/i.test(e.message || ''))
      throw new UserError('اليوزر غير موجود')
    throw e
  }
  if (ent instanceof Api.User) throw new UserError('هذا حساب شخصي مش جروب أو قناة')
  if (ent instanceof Api.Channel && ent.left && T().joinPublic !== false) {
    countJoin(id)
    await client.invoke(new Api.channels.JoinChannel({ channel: ent }))
  }
  return ent
}

async function processSource(sid, src, id) {
  const ref = sourcesCol.doc(sid)
  const client = clients.get(id)
  try {
    if (!client) throw new Error('الحساب غير متصل')
    const [kind, val] = parseSource(src.input)
    const ent = await joinSource(client, id, kind, val)
    const chatId = String(utils.getPeerId(ent))
    const title = ent.title || val
    const dup = await sourcesCol.where('chatId', '==', chatId).limit(3).get()
    if (dup.docs.some((d) => d.id !== sid && ['done', 'scanning'].includes(d.data().status))) {
      await ref.update({ status: 'duplicate', chatId, title, error: null, updated: FieldValue.serverTimestamp() })
      return
    }
    await ref.update({ status: 'scanning', chatId, title, error: null, updated: FieldValue.serverTimestamp() })
    const limit = Number(T().scanLimit) || undefined
    let count = 0
    let found = 0
    for await (const msg of client.iterMessages(ent, { limit })) {
      count++
      noteSuggestions(msg, sid)
      for (const code of extractCodes(msg)) if (await saveLink(code, sid, title, msg.date)) found++
      if (count % 500 === 0) await ref.update({ scanned: count, linksFound: found }).catch(() => {})
    }
    await ref.update({ status: 'done', scanned: count, linksFound: found, updated: FieldValue.serverTimestamp() })
    await flushSuggestions().catch((e) => log('⚠️ مصادر مقترحة:', e.message))
    if (src.monitor !== false) monitored.set(rawId(chatId), { sid, title })
    event('ok', `${title}: ${count} رسالة — ${found} رابط جديد`, id)
  } catch (e) {
    if (e instanceof errors.FloodWaitError) {
      await updAcc(id, { floodUntil: now() + e.seconds * 1000 })
      await ref.update({ status: 'pending', accountId: null, error: `FloodWait ${e.seconds} ث — رح ينتقل لحساب تاني` }).catch(() => {})
      event('warn', `FloodWait لمدة ${e.seconds} ثانية`, id)
    } else if (DEAD.has(e.errorMessage)) {
      await ref.update({ status: 'pending', accountId: null, error: null }).catch(() => {})
      await kill(id, /BAN/.test(e.errorMessage) ? 'banned' : 'unauthorized', `الحساب خرج من الخدمة: ${e.errorMessage}`)
    } else if (e.errorMessage === 'CHANNELS_TOO_MUCH') {
      await updAcc(id, { status: 'full', error: 'الحساب وصل الحد الأقصى للجروبات، اطلع من بعضها ثم فعّله' })
      await ref.update({ status: 'pending', accountId: null, error: null }).catch(() => {})
    } else {
      const att = (src.attempts || 0) + 1
      const final = e instanceof UserError || att >= 3
      await ref
        .update({
          status: final ? 'failed' : 'pending',
          attempts: att,
          accountId: final ? id : null,
          error: e.message || e.errorMessage || String(e),
          updated: FieldValue.serverTimestamp(),
        })
        .catch(() => {})
      log(`❌ ${src.input}: ${e.message || e.errorMessage}`)
    }
  } finally {
    busy.delete(id)
    const d = Number(T().delay) || 60
    cooldown.set(id, d * (0.7 + Math.random() * 0.6))
    lastAction.set(id, now())
  }
}

// ---------------- فحص الروابط ----------------
async function publishCheck() {
  await workerRef.set({ check: checkState }, { merge: true }).catch(() => {})
}

async function runCheck(docs) {
  if (checkState.running) throw new UserError('الفحص شغال حالياً')
  checkState = { running: true, done: 0, total: docs.length, active: 0, inactive: 0 }
  stopCheck = false
  await publishCheck()
  ;(async () => {
    const black = listOf(T().blacklist)
    try {
      for (const d of docs) {
        if (stopCheck) break
        const data = d.data()
        let st = 'error'
        let name = null
        try {
          ;[st, name] = await checkLink(d.id)
        } catch {}
        const patch = { status: st, checkedAt: FieldValue.serverTimestamp() }
        if (name) patch.groupName = name
        const gname = name || data.groupName || ''
        if (st === 'active') {
          if (black.length && black.some((w) => lower(gname).includes(w))) patch.status = 'blocked'
          else if (settings.app.wa?.spamFilter !== false && isSpamName(gname)) Object.assign(patch, { status: 'blocked', blockReason: 'spam' })
          const cat = categorize(`${gname} ${data.sourceTitle || ''}`)
          if (cat) patch.category = cat
        }
        await d.ref.update(patch).catch(() => {})
        checkState.done++
        if (patch.status === 'active') checkState.active++
        if (patch.status === 'inactive') checkState.inactive++
        if (checkState.done % 10 === 0) await publishCheck()
        await sleep(1200)
      }
    } finally {
      checkState.running = false
      await publishCheck()
      event('info', `انتهى الفحص: ${checkState.active} شغال، ${checkState.inactive} منتهي`)
    }
  })()
  return { total: docs.length }
}

async function startCheck(all) {
  const q = all ? linksCol.where('status', 'in', ['unchecked', 'active', 'error']) : linksCol.where('status', '==', 'unchecked')
  const snap = await q.limit(all ? 5000 : 1000).get()
  if (snap.empty) return { total: 0 }
  return runCheck(snap.docs)
}

// إعادة التصنيف بعد تعديل قواعد التصنيف (بدون فحص من جديد)
async function recategorize() {
  const snap = await linksCol.where('status', '==', 'active').get()
  let n = 0
  let batch = db.batch()
  let c = 0
  for (const d of snap.docs) {
    const x = d.data()
    const cat = categorize(`${x.groupName || ''} ${x.sourceTitle || ''}`)
    if ((cat || null) !== (x.category || null)) {
      batch.update(d.ref, { category: cat || null })
      n++
      if (++c >= 400) {
        await batch.commit()
        batch = db.batch()
        c = 0
      }
    }
  }
  if (c) await batch.commit()
  return { updated: n }
}

// ---------------- الأوامر ----------------
async function handleCommand(c) {
  if (String(c.type).startsWith('shop_')) return shop.command(c)
  switch (c.type) {
    case 'tg_send_code':
      return sendCode(c.phone)
    case 'tg_verify':
      return verify(c.phone, c.code, c.password)
    case 'tg_delete':
      return deleteAccount(c.accountId)
    case 'tg_reconnect':
      await disconnect(c.accountId)
      await updAcc(c.accountId, { status: 'ok', error: null })
      await connectAccount(c.accountId)
      return null
    case 'tg_check':
      return startCheck(!!c.all)
    case 'tg_check_stop':
      stopCheck = true
      return null
    case 'tg_recategorize':
      return recategorize()
    case 'tg_mute_all':
      return { muted: await applyMuteAll(c.on !== false) }
    case 'tg_search':
      return { results: await searchTelegram(c.q) }
    default:
      throw new Error('أمر غير معروف')
  }
}

// ---------------- التشغيل ----------------
async function main() {
  log('🚀 تشغيل عامل تيليجرام...')
  await settings.ready

  // المصادر اللي كانت شغالة قبل الإطفاء ترجع للطابور
  // (لو Firebase رافض القراءة — مثلاً الحصة اليومية خلصت — منكمل عادي بدل ما العامل يوقع)
  try {
    for (const d of (await sourcesCol.where('status', 'in', ['working', 'scanning']).get()).docs)
      await d.ref.update({ status: 'pending', accountId: null }).catch(() => {})

    // الروابط المعروفة (عشان ما نكتب نفس الرابط مرتين)
    const ids = await linksCol.select().get()
    ids.docs.forEach((d) => knownCodes.add(d.id))
    log(`🔗 ${knownCodes.size} رابط محفوظ`)
  } catch (e) {
    log('⚠️ تعذّر التحميل عند التشغيل:', e.message)
  }

  const hb = startHeartbeat('tg', () => ({
    connected: clients.size,
    monitored: monitored.size,
    pending: pendingSources.length,
    check: checkState,
  }))
  startLogPruning('tg')

  listen(
    accountsCol,
    (snap) => {
      for (const ch of snap.docChanges()) {
        const id = ch.doc.id
        if (ch.type === 'removed') {
          accData.delete(id)
          disconnect(id)
          continue
        }
        const a = ch.doc.data()
        accData.set(id, a)
        if (a.enabled === false) {
          if (clients.has(id)) {
            disconnect(id)
            updAcc(id, { connected: false })
          }
        } else if (!clients.has(id) && !connecting.has(id) && !BAD_STATES.has(a.status) && !pendingLogins.has(a.phone)) {
          connectAccount(id)
        }
      }
    },
    (e) => log('⚠️ مستمع الحسابات:', e.message),
  )

  listen(
    sourcesCol.where('status', '==', 'pending'),
    (s) => (pendingSources = s.docs),
    (e) => log('⚠️ مستمع المصادر:', e.message),
  )

  listen(
    sourcesCol.where('status', '==', 'done'),
    (s) => {
      monitored.clear()
      s.docs.forEach((d) => {
        const x = d.data()
        if (x.monitor !== false && x.chatId) monitored.set(rawId(x.chatId), { sid: d.id, title: x.title })
      })
    },
    (e) => log('⚠️ مستمع المراقبة:', e.message),
  )

  listenCommands('tg', handleCommand, log)
  shop.start()

  // تفعيل/إلغاء الكتم من الإعدادات بيتطبّق فوراً على كل الحسابات
  let muteOn = !!T().muteAll
  settings.onChange((app) => {
    const on = !!app.tg.muteAll
    if (on !== muteOn) applyMuteAll(on)
    muteOn = on
  })
  watchOtherWorker('wa', notifier)

  // المجدول
  ;(async () => {
    for (;;) {
      try {
        await dispatch()
      } catch (e) {
        log('⚠️ المجدول:', e.message)
      }
      await sleep(3000)
    }
  })()

  // فحص الروابط الجديدة تلقائياً كل 5 دقائق
  setInterval(() => flushSuggestions().catch(() => {}), 10 * 60_000)
  setInterval(async () => {
    try {
      if (T().autoCheck !== false && !checkState.running) {
        const snap = await linksCol.where('status', '==', 'unchecked').limit(300).get()
        if (!snap.empty) await runCheck(snap.docs)
      }
    } catch (e) {
      log('⚠️ الفحص التلقائي:', e.message)
    }
  }, 5 * 60_000)

  const shutdown = async () => {
    log('🛑 إيقاف...')
    for (const c of clients.values()) await c.disconnect().catch(() => {})
    await hb.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

process.on('unhandledRejection', (e) => log('⚠️', e?.message || String(e)))
main()

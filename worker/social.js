// ============================================================
//  منشورات اليوم لفيسبوك/إنستغرام
//  كل يوم (الساعة 8 الصبح افتراضياً) بيختار 3 منتجات، بياخد صورهم الأصلية،
//  بيكتب الوصف (عربي وتحته إنجليزي، بدون سعر — السعر عالموقع أو عالخاص)،
//  وبيبعتهم على تيليجرام. اللوحة بتعرضهم بصفحة «منشورات اليوم».
//  ولو «النشر المباشر» مفعّل: بينشرهم لحاله على صفحة فيسبوك (منشور + قصة)
//  وعلى إنستغرام (منشور + قصة)، كل منتج بوقته — عن طريق Meta (meta.js)
//  الإعدادات: store/social · المنشورات: store_social/{يوم}
// ============================================================
import { db, FieldValue, Timestamp, dayKey } from './common.js'
import { translateTexts } from './translate.js'
import { storeBase } from './catalog.js'
import { captions, mergeSocial, cleanText } from './socialDesign.js'
import { createMeta } from './meta.js'

const TZ = 'Africa/Cairo'
const cfgRef = db.doc('store/social')
const dayCol = db.collection('store_social')
const prodCol = db.collection('store_products')
const hmNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
const isArabic = (s) => /[؀-ۿ]/.test(String(s || ''))
const ms = (v) => (v?.toMillis ? v.toMillis() : Number(v) || 0)
const shuffle = (a) => {
  const x = [...a]
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[x[i], x[j]] = [x[j], x[i]]
  }
  return x
}
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

// ---------- تيليجرام: صور + نص ----------
async function tg(method, token, body, isForm = false) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`)
  return j.result
}
async function sendAlbum(token, chatId, photos, caption) {
  // photos: [{ buf } | { url }]
  const form = new FormData()
  form.append('chat_id', String(chatId))
  const media = photos.map((ph, i) => {
    if (ph.buf) form.append(`f${i}`, new Blob([ph.buf], { type: 'image/png' }), `f${i}.png`)
    return { type: 'photo', media: ph.buf ? `attach://f${i}` : ph.url, ...(i === 0 && caption ? { caption: caption.slice(0, 1000) } : {}) }
  })
  form.append('media', JSON.stringify(media))
  return tg('sendMediaGroup', token, form, true)
}

// ============================================================
export function createSocial({ settings, log, event }) {
  let cfg = mergeSocial()
  let busy = false

  const loadCfg = async () => (cfg = mergeSocial((await cfgRef.get()).data() || {}))
  const loadPriv = async () => (await db.doc('store/settings').get()).data() || {}
  const loadPub = async () => (await db.doc('store/public').get()).data() || {}

  // ---------- اختيار المنتجات ----------
  async function pickProducts(day, count, exclude = []) {
    const all = (await prodCol.get()).docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.name && p.visible !== false && p.status !== 'draft' && p.available !== false && (p.images || []).length && Number(p.price) > 0)
    if (!all.length) return []
    // اللي انتشر بآخر X يوم
    const since = addDays(day, -cfg.cooldownDays)
    const hist = await dayCol.where('day', '>=', since).get()
    const lastPosted = new Map()
    for (const d of hist.docs) for (const it of d.data().items || []) if (d.id !== day) lastPosted.set(it.pid, d.id)
    const ex = new Set(exclude)
    let pool = all.filter((p) => !lastPosted.has(p.id) && !ex.has(p.id))
    if (pool.length < count) pool = all.filter((p) => !ex.has(p.id)).sort((a, b) => String(lastPosted.get(a.id) || '').localeCompare(String(lastPosted.get(b.id) || '')))
    const now = Date.now()
    const fresh = shuffle([...pool].sort((a, b) => ms(b.createdAt) - ms(a.createdAt)).slice(0, 25))
    const offers = shuffle(pool.filter((p) => Number(p.oldPrice) > Number(p.price) || (Number(p.flashUntil) > now && Number(p.flashPrice) > 0)))
    const stars = shuffle(pool.filter((p) => p.featured || p.badge))
    const rest = shuffle(pool)
    const picked = []
    const cats = new Set()
    const take = (list, strictCat) => {
      for (const p of list) {
        if (picked.some((x) => x.id === p.id)) continue
        if (strictCat && p.category && cats.has(p.category)) continue
        picked.push(p)
        if (p.category) cats.add(p.category)
        return true
      }
      return false
    }
    const order = [fresh, offers, stars, rest]
    for (let i = 0; picked.length < count && i < order.length * 2; i++) take(order[i % order.length], true)
    while (picked.length < count && take(rest, false)) {}
    return picked.slice(0, count)
  }

  // ترجمة الاسم والمميزات للإنجليزي لو ناقصين (وبنحفظهم بالمنتج)
  async function ensureEnglish(p) {
    const feats = (p.features || []).slice(0, 5)
    const desc = cleanText(p.desc || '').slice(0, 600)
    const needName = !p.nameEn || isArabic(p.nameEn)
    const needFeats = feats.length > 0 && (!(p.featuresEn || []).length || (p.featuresEn || []).some(isArabic))
    const needDesc = !!desc && (!p.descEn || isArabic(p.descEn))
    if (!needName && !needFeats && !needDesc) return p
    try {
      const src = [needName ? cleanText(p.name) : '-', needDesc ? desc : '-', ...(needFeats ? feats.map(cleanText) : [])]
      const out = await translateTexts(src, 'en', 'ar')
      const patch = {}
      if (needName && out[0] && !isArabic(out[0])) patch.nameEn = out[0]
      if (needDesc && out[1] && !isArabic(out[1])) patch.descEn = out[1]
      if (needFeats) {
        const fe = out.slice(2).filter((x) => x && !isArabic(x))
        if (fe.length) patch.featuresEn = fe
      }
      if (Object.keys(patch).length) {
        await prodCol.doc(p.id).update(patch).catch(() => {})
        return { ...p, ...patch }
      }
    } catch (e) {
      log('⚠️ ترجمة المنشور:', e.message)
    }
    return p
  }

  // ---------- تجهيز منشور واحد: صور المنتج الأصلية + وصف بدون سعر ----------
  async function buildItem(p, { day, priv, pub, seed }) {
    p = await ensureEnglish(p)
    const now = Date.now()
    const kind = now - ms(p.createdAt) < 14 * 86_400_000 ? 'new' : ''
    const link = `${storeBase(priv)}#/p/${encodeURIComponent(p.id)}`
    const { fb, ig } = captions({ p, link, settings: pub, seed })
    const photos = (p.images || []).filter(Boolean).slice(0, 10)
    const item = { pid: p.id, name: p.name, nameEn: p.nameEn || '', price: Number(p.price) || 0, oldPrice: Number(p.oldPrice) || 0, category: p.category || '', kind, link, fb, ig, posted: false, photos, photo: photos[0] || '' }
    return { item, files: null }
  }

  async function sendTelegram(day, items, files = []) {
    const n = settings.app.notify || {}
    if (!n.enabled || !n.botToken || !n.chatId) return false
    const [, m, d] = day.split('-').map(Number)
    await tg('sendMessage', n.botToken, { chat_id: n.chatId, text: `📣 منشورات اليوم ${d}/${m} جاهزة (${items.length})\nلكل منتج: صوره، وتحتها نص فيسبوك ونص إنستغرام — احفظ الصور وانسخ النص وانشر 👇` })
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const photos = (it.photos?.length ? it.photos : [it.photo]).filter(Boolean).slice(0, 10).map((url) => ({ url }))
      try {
        if (photos.length > 1) await sendAlbum(n.botToken, n.chatId, photos, `${i + 1}/${items.length} · ${it.name}`)
        else if (photos.length) await tg('sendPhoto', n.botToken, { chat_id: n.chatId, photo: photos[0].url, caption: `${i + 1}/${items.length} · ${it.name}` })
      } catch (e) {
        log('⚠️ صور المنشور على تيليجرام:', e.message)
      }
      await tg('sendMessage', n.botToken, { chat_id: n.chatId, text: it.fb, disable_web_page_preview: true }).catch(() => {})
      await tg('sendMessage', n.botToken, { chat_id: n.chatId, text: it.ig, disable_web_page_preview: true }).catch(() => {})
    }
    return true
  }

  // ---------- تجهيز اليوم كامل ----------
  async function generate(day = dayKey(), { send = true, keep = [] } = {}) {
    if (busy) throw new Error('التجهيز شغال — استنى شوي')
    busy = true
    try {
      await loadCfg()
      const [priv, pub] = await Promise.all([loadPriv(), loadPub()])
      const picks = await pickProducts(day, cfg.count)
      if (!picks.length) throw new Error('ما في منتجات منشورة بالمتجر (متوفرة وإلها صور)')
      const items = []
      const files = []
      for (let i = 0; i < picks.length; i++) {
        const r = await buildItem(picks[i], { day, priv, pub, seed: Number(day.replace(/\D/g, '')) + i })
        items.push(r.item)
        files.push(r.files)
      }
      await dayCol.doc(day).set({ day, items, createdAt: FieldValue.serverTimestamp(), sentAt: null })
      log(`📣 منشورات ${day} جاهزة: ${items.map((x) => x.name).join(' · ')}`)
      await queueWaPosts(day, items).catch((e) => log('⚠️ منشورات المتجر للمجموعات:', e.message))
      if (send) {
        const ok = await sendTelegram(day, items, files).catch((e) => (log('⚠️ إرسال المنشورات:', e.message), false))
        if (ok) await dayCol.doc(day).update({ sentAt: FieldValue.serverTimestamp() })
      }
      return { items: items.length }
    } finally {
      busy = false
    }
  }

  // ---------- نشر منتجات اليوم بمجموعات الواتساب (موزعة على اليوم) ----------
  const cairoAt = (day, hm) => {
    // وقت hh:mm بتوقيت مصر بهاليوم ← ملي ثانية
    const [y, m, d] = day.split('-').map(Number)
    const [h, mi] = hm.split(':').map(Number)
    const guess = Date.UTC(y, m - 1, d, h, mi)
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]))
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute)
    return guess - (shown - guess)
  }
  async function queueWaPosts(day, items) {
    if (!cfg.waOn || !cfg.waCategory || !items.length) return 0
    const posts = db.collection('wa_posts')
    // لو انجهزوا من جديد: بنلغي المجدول القديم لهاليوم
    const old = await posts.where('socialDay', '==', day).get()
    const started = new Set() // منتجات انتشرت أو عم تنتشر ← ما منكررها
    for (const d of old.docs) {
      if (['scheduled', 'queued'].includes(d.data().status)) await d.ref.delete().catch(() => {})
      else started.add(d.data().socialPid)
    }
    const accs = (await db.collection('wa_accounts').get()).docs.filter((d) => d.data().enabled !== false && (!cfg.waAccounts.length || cfg.waAccounts.includes(d.id)))
    if (!accs.length) return 0
    const times = cfg.waTimes.length ? cfg.waTimes : ['10:00', '15:00', '20:00']
    // الأوقات: لو وقت فات بنحطه بعد شوي، وبنضمن ساعة على الأقل بين كل منشور والتاني
    const slots = items.map((_, i) => Math.max(cairoAt(day, times[i % times.length]), Date.now() + 15 * 60_000))
    const order = slots.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0])
    for (let k = 1; k < order.length; k++) order[k][0] = Math.max(order[k][0], order[k - 1][0] + 60 * 60_000)
    order.forEach(([t, i]) => (slots[i] = t))
    let n = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (started.has(it.pid)) continue
      const at = slots[i]
      for (const a of accs) {
        await posts.add({
          accountId: a.id,
          text: it.fb,
          variants: [],
          target: 'category',
          category: cfg.waCategory,
          regions: cfg.waRegions,
          includeUnknown: false,
          mentionAll: !!cfg.waMention,
          images: (it.photos || [it.photo]).filter(Boolean).slice(0, 1),
          track: false,
          status: 'scheduled',
          scheduledAt: Timestamp.fromMillis(at + Math.floor(Math.random() * 10) * 60_000),
          socialDay: day,
          socialPid: it.pid,
          sent: 0,
          failed: 0,
          total: 0,
          createdAt: FieldValue.serverTimestamp(),
        })
        n++
      }
    }
    log(`📣 انجدول ${n} منشور للمتجر بمجموعات «${cfg.waCategory}»`)
    return n
  }

  // تبديل منتج واحد
  async function replace(day, index) {
    if (busy) throw new Error('التجهيز شغال — استنى شوي')
    busy = true
    try {
      await loadCfg()
      const ref = dayCol.doc(day)
      const doc = (await ref.get()).data()
      if (!doc?.items?.[index]) throw new Error('المنشور مش موجود')
      const [priv, pub] = await Promise.all([loadPriv(), loadPub()])
      const [p] = await pickProducts(day, 1, doc.items.map((x) => x.pid))
      if (!p) throw new Error('ما في منتج تاني مناسب')
      const { item } = await buildItem(p, { day, priv, pub, seed: Date.now() % 97 })
      const items = [...doc.items]
      items[index] = item
      await ref.update({ items })
      await queueWaPosts(day, items).catch((e) => log('⚠️ منشورات المتجر للمجموعات:', e.message))
      return { name: item.name }
    } finally {
      busy = false
    }
  }

  async function resend(day) {
    const doc = (await dayCol.doc(day).get()).data()
    if (!doc?.items?.length) throw new Error('ما في منشورات لهاليوم')
    await sendTelegram(day, doc.items)
    await dayCol.doc(day).update({ sentAt: FieldValue.serverTimestamp() })
    return { sent: doc.items.length }
  }

  // ---------- النشر المباشر على فيسبوك وإنستغرام (Meta) ----------
  const TARGETS = [
    ['fbPost', 'metaFbPost', 'منشور فيسبوك'],
    ['fbStory', 'metaFbStory', 'قصة فيسبوك'],
    ['igPost', 'metaIgPost', 'منشور إنستغرام'],
    ['igStory', 'metaIgStory', 'قصة إنستغرام'],
  ]
  const MAX_TRIES = 3
  const RETRY_MS = 15 * 60_000
  let metaBusy = false
  let metaWarned = 0

  async function metaClient() {
    const priv = await loadPriv()
    return createMeta({ token: String(priv.metaToken || '').trim(), pageId: cfg.metaPageId, igId: cfg.metaIgId, version: cfg.metaVersion })
  }
  const metaSlot = (day, i) => cairoAt(day, cfg.metaTimes[i % cfg.metaTimes.length] || '10:00')
  // الهدف لسا بدو نشر؟ (مفعّل، ما انتشر، وما خلّص محاولاته — إلا لو «انشر هلأ»)
  const pending = (it, force) =>
    TARGETS.filter(([k, flag]) => {
      if (!cfg[flag]) return false
      const m = it.meta?.[k]
      if (m?.id) return false
      if (force || !m) return true
      return (m.tries || 0) < MAX_TRIES && Date.now() - (m.at || 0) > RETRY_MS
    })

  async function publishItem(day, index, { force = false } = {}) {
    const ref = dayCol.doc(day)
    let it = (await ref.get()).data()?.items?.[index]
    if (!it) throw new Error('المنشور مش موجود')
    const todo = pending(it, force)
    if (!todo.length) return { done: 0 }
    const meta = await metaClient()
    const photos = (it.photos?.length ? it.photos : [it.photo]).filter(Boolean)
    const results = {}
    for (const [k, , label] of todo) {
      const prev = it.meta?.[k] || {}
      try {
        let id
        if (k === 'fbPost') id = await meta.fbPost(photos, it.fb)
        else if (k === 'fbStory') id = await meta.fbStory(photos[0])
        else if (k === 'igPost') id = await meta.igPost(photos, it.ig)
        else id = await meta.igStory(photos.find((u) => !/\.(png|webp|gif)(\?|$)/i.test(u)) || photos[0])
        results[k] = { id: String(id), at: Date.now() }
        log(`📣 ${label}: ${it.name} ✓`)
      } catch (e) {
        results[k] = { error: e.message.slice(0, 300), at: Date.now(), tries: (prev.tries || 0) + 1 }
        log(`⚠️ ${label} (${it.name}):`, e.message)
      }
    }
    // نقرأ من جديد قبل الكتابة (عشان ما نمسح تعديلات اللوحة بالنص)
    const doc = (await ref.get()).data()
    const items = [...(doc?.items || [])]
    if (!items[index] || items[index].pid !== it.pid) return { done: 0 }
    const merged = { ...(items[index].meta || {}), ...results }
    const ok = Object.values(results).filter((r) => r.id).length
    items[index] = { ...items[index], meta: merged, ...(merged.fbPost?.id || merged.igPost?.id ? { posted: true, postedAt: items[index].postedAt || Date.now() } : {}) }
    await ref.update({ items })
    const bad = Object.entries(results).filter(([, r]) => r.error)
    if (bad.length) event?.('error', `⚠️ النشر على Meta (${it.name}): ${bad.map(([k, r]) => `${TARGETS.find((t) => t[0] === k)[2]}: ${r.error}`).join(' · ')}`)
    else if (ok) event?.('ok', `📣 انتشر «${it.name}» على فيسبوك وإنستغرام`)
    return { done: ok, failed: bad.length }
  }

  // كل دقيقة: أي منتج إجى وقته وفي إشي لسا ما انتشر ← بننشره
  async function metaTick() {
    if (!cfg.metaOn || metaBusy) return
    const day = dayKey()
    const doc = (await dayCol.doc(day).get()).data()
    if (!doc?.items?.length) return
    metaBusy = true
    try {
      for (let i = 0; i < doc.items.length; i++) {
        if (Date.now() < metaSlot(day, i) || !pending(doc.items[i], false).length) continue
        await publishItem(day, i).catch((e) => {
          // إعدادات ناقصة (توكن/صفحة) ← تنبيه مرة بالساعة بس
          if (Date.now() - metaWarned > 3600_000) {
            metaWarned = Date.now()
            log('⚠️ النشر على Meta:', e.message)
            event?.('error', `⚠️ النشر على فيسبوك وإنستغرام واقف: ${e.message}`)
          }
        })
      }
    } finally {
      metaBusy = false
    }
  }

  async function metaTest() {
    await loadCfg()
    const info = await (await metaClient()).info()
    await cfgRef.set({ metaIgId: info.igId || '', metaCheck: { ...info, at: Date.now() } }, { merge: true })
    return info
  }

  // الجدولة: كل دقيقة بنشيّك
  async function tick() {
    try {
      await loadCfg()
      if (cfg.enabled && hmNow() >= cfg.at) {
        const day = dayKey()
        if (!(await dayCol.doc(day).get()).exists) {
          await generate(day)
          event?.('ok', cfg.metaOn ? '📣 منشورات اليوم جاهزة — بتنزل لحالها على فيسبوك وإنستغرام بأوقاتها' : '📣 منشورات اليوم لفيسبوك وإنستغرام جاهزة')
        }
      }
    } catch (e) {
      if (!/التجهيز شغال/.test(e.message)) log('⚠️ منشورات اليوم:', e.message)
    }
    try {
      await metaTick()
    } catch (e) {
      log('⚠️ النشر على Meta:', e.message)
    }
  }

  return {
    start() {
      setInterval(tick, 60_000)
      setTimeout(tick, 30_000)
    },
    tick,
    generate,
    async command(c) {
      const day = c.day || dayKey()
      if (c.type === 'social_meta_test') return metaTest()
      if (c.type === 'social_meta_publish') {
        if (metaBusy) throw new Error('النشر شغال — استنى شوي')
        await loadCfg()
        metaBusy = true
        publishItem(day, Number(c.index) || 0, { force: true })
          .catch((e) => (log('⚠️ النشر على Meta:', e.message), event?.('error', `⚠️ النشر على Meta: ${e.message}`)))
          .finally(() => (metaBusy = false))
        return { started: true }
      }
      const job = c.type === 'social_generate' ? () => generate(day, { send: c.send !== false }) : c.type === 'social_replace' ? () => replace(day, Number(c.index) || 0) : c.type === 'social_send' ? () => resend(day) : null
      if (!job) throw new Error('أمر غير معروف')
      if (busy) throw new Error('التجهيز شغال — استنى شوي')
      // الشغل بياخد دقايق على الجوال (تصميم + رفع + تيليجرام) ← بنرد فوراً وبنكمّل بالخلفية
      const state = (x) => cfgRef.set({ run: { type: c.type, day, index: c.index ?? null, at: Date.now(), ...x } }, { merge: true }).catch(() => {})
      await state({ state: 'working', error: null })
      job()
        .then(() => state({ state: 'done' }))
        .catch((e) => (log('⚠️ منشورات اليوم:', e.message), state({ state: 'error', error: e.message })))
      return { started: true }
    },
  }
}

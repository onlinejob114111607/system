// ============================================================
//  منشورات اليوم لفيسبوك/إنستغرام
//  كل يوم (الساعة 8 الصبح افتراضياً) بيختار 3 منتجات، بيصمم صورة منشور
//  وستوري لكل واحد، بيكتب النص (عربي وتحته إنجليزي)، بيرفع الصور
//  وبيبعتهم على تيليجرام. اللوحة بتعرضهم بصفحة «منشورات اليوم».
//  الإعدادات: store/social · المنشورات: store_social/{يوم}
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { db, FieldValue, ROOT, dayKey } from './common.js'
import { translateTexts } from './translate.js'
import { uploadGithub } from './shopImport.js'
import { storeBase } from './catalog.js'
import { postSvg, storySvg, captions, mergeSocial, cleanText } from './socialDesign.js'

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

// ---------- الرسم (resvg) — لو مش مثبّت بنبعت صورة المنتج الأصلية ----------
let resvg = null
let resvgTried = false
async function getResvg(log) {
  if (resvgTried) return resvg
  resvgTried = true
  try {
    resvg = (await import('@resvg/resvg-js')).Resvg
  } catch (e) {
    log('ℹ️ مكتبة التصميم (resvg) مش مثبتة — المنشورات بتطلع بصورة المنتج الأصلية لحد ما تتثبت:', e.message)
  }
  return resvg
}
const FONT_DIR = path.join(ROOT, 'tools', 'fonts')
const fontFiles = () => (fs.existsSync(FONT_DIR) ? fs.readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(FONT_DIR, f)) : [])
function render(svg) {
  return Buffer.from(new resvg(svg, { font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: 'Cairo' }, fitTo: { mode: 'original' } }).render().asPng())
}

async function fetchBuf(url, timeout = 30_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' }
}
const dataUri = ({ buf, type }) => `data:${type.split(';')[0]};base64,${buf.toString('base64')}`

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
  let logoCache = null

  const loadCfg = async () => (cfg = mergeSocial((await cfgRef.get()).data() || {}))
  const loadPriv = async () => (await db.doc('store/settings').get()).data() || {}
  const loadPub = async () => (await db.doc('store/public').get()).data() || {}

  async function logo(priv) {
    if (logoCache !== null) return logoCache
    try {
      logoCache = dataUri(await fetchBuf(storeBase(priv) + 'logo-192.png', 20_000))
    } catch {
      logoCache = ''
    }
    return logoCache
  }

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
    const feats = (p.features || []).slice(0, 4)
    const needName = !p.nameEn || isArabic(p.nameEn)
    const needFeats = feats.length && (!(p.featuresEn || []).length || (p.featuresEn || []).some(isArabic))
    if (!needName && !needFeats) return p
    try {
      const src = [needName ? p.name : null, ...(needFeats ? feats : [])].filter((x) => x != null)
      const out = await translateTexts(src.map(cleanText), 'en', 'ar')
      const patch = {}
      let k = 0
      if (needName && out[k] && !isArabic(out[k])) patch.nameEn = out[k]
      if (needName) k++
      if (needFeats) {
        const fe = out.slice(k).filter((x) => x && !isArabic(x))
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

  // ---------- تجهيز منشور واحد ----------
  async function buildItem(p, { day, priv, pub, seed }) {
    p = await ensureEnglish(p)
    const now = Date.now()
    const flash = Number(p.flashUntil) > now && Number(p.flashPrice) > 0 && Number(p.flashPrice) < Number(p.price)
    const view = { ...p, price: flash ? Number(p.flashPrice) : Number(p.price), oldPrice: flash ? Number(p.price) : Number(p.oldPrice) || 0 }
    const kind = now - ms(p.createdAt) < 14 * 86_400_000 ? 'new' : ''
    const link = `${storeBase(priv)}#/p/${encodeURIComponent(p.id)}`
    const { fb, ig } = captions({ p: view, link, settings: pub, seed })
    const item = { pid: p.id, name: p.name, nameEn: p.nameEn || '', price: view.price, oldPrice: view.oldPrice, category: p.category || '', kind, link, fb, ig, posted: false, photo: p.images[0], post: '', story: '' }
    const R = await getResvg(log)
    if (!R || !fontFiles().length) return { item, files: null }
    // صورة المنتج (لو الأولى ما فتحت منجرب اللي بعدها)
    let photo = null
    for (const u of (p.images || []).slice(0, 3)) {
      try {
        photo = await fetchBuf(u)
        break
      } catch {}
    }
    if (!photo) return { item, files: null }
    const img = dataUri(photo)
    const lg = await logo(priv)
    const storeName = pub.nameEn || 'Joudi Store'
    const delivery = 'توصيل لكل الضفة والقدس والداخل · الدفع عند الاستلام'
    const postPng = render(postSvg({ p: view, img, logo: lg, storeName, kind }))
    const storyPng = render(storySvg({ p: view, img, logo: lg, storeName, kind, features: p.features || [], delivery }))
    const stamp = Date.now().toString(36)
    const safe = p.id.replace(/[^\w-]/g, '_')
    try {
      item.post = await uploadGithub(priv, `img/social/${day}/${safe}-${stamp}-post.png`, postPng, log)
      item.story = await uploadGithub(priv, `img/social/${day}/${safe}-${stamp}-story.png`, storyPng, log)
    } catch (e) {
      log('⚠️ رفع صور المنشور:', e.message)
    }
    return { item, files: { post: postPng, story: storyPng } }
  }

  async function sendTelegram(day, items, files = []) {
    const n = settings.app.notify || {}
    if (!n.enabled || !n.botToken || !n.chatId) return false
    const [, m, d] = day.split('-').map(Number)
    await tg('sendMessage', n.botToken, { chat_id: n.chatId, text: `📣 منشورات اليوم ${d}/${m} جاهزة (${items.length})\nلكل منتج: صورة المنشور + الستوري، وتحتهم نص فيسبوك ونص إنستغرام — احفظ الصورة وانسخ النص وانشر 👇` })
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const f = files[i]
      const photos = f ? [{ buf: f.post }, { buf: f.story }] : it.post ? [{ url: it.post }, { url: it.story }] : [{ url: it.photo }]
      try {
        if (photos.length > 1) await sendAlbum(n.botToken, n.chatId, photos, `${i + 1}/${items.length} · ${it.name}`)
        else await tg('sendPhoto', n.botToken, { chat_id: n.chatId, photo: photos[0].url, caption: `${i + 1}/${items.length} · ${it.name}` })
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
      const designed = items.every((x) => x.post)
      await dayCol.doc(day).set({ day, items, designed, createdAt: FieldValue.serverTimestamp(), sentAt: null })
      log(`📣 منشورات ${day} جاهزة: ${items.map((x) => x.name).join(' · ')}`)
      if (send) {
        const ok = await sendTelegram(day, items, files).catch((e) => (log('⚠️ إرسال المنشورات:', e.message), false))
        if (ok) await dayCol.doc(day).update({ sentAt: FieldValue.serverTimestamp() })
      }
      return { items: items.length, designed }
    } finally {
      busy = false
    }
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
      await ref.update({ items, designed: items.every((x) => x.post) })
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

  // الجدولة: كل دقيقة بنشيّك
  async function tick() {
    try {
      await loadCfg()
      if (!cfg.enabled || hmNow() < cfg.at) return
      const day = dayKey()
      if ((await dayCol.doc(day).get()).exists) return
      await generate(day)
      event?.('ok', '📣 منشورات اليوم لفيسبوك وإنستغرام جاهزة')
    } catch (e) {
      if (!/التجهيز شغال/.test(e.message)) log('⚠️ منشورات اليوم:', e.message)
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

// ============================================================
//  استيراد المنتجات من قنوات تيليجرام للمتجر (كمسودات للمراجعة)
//
//  شكل المنشور بقنوات الشركة:
//    ألبوم صور ← رسالة الوصف ← رسالة "السعر / 350 شيكل · الربح / 50"
//  رسالة السعر بتسكّر المنتج: كل اللي قبلها بنفس القناة (صور + نص) = منتج واحد
//  السعر بالمتجر = السعر + الربح (+ ربح إضافي لو حاطط للقناة)
//  الإعدادات: store/tg_import  ·  المنتجات: store_products (status: draft)
// ============================================================
import { db, FieldValue, sleep, listen } from './common.js'
import { translateTexts } from './translate.js'
import { patchCatalog, publicProduct } from './catalog.js'

const cfgRef = db.doc('store/tg_import')
const privRef = db.doc('store/settings')
const prodCol = db.collection('store_products')
const fbCol = db.collection('store_feedback')

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const toEn = (s) => String(s || '').replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
const num = (s) => {
  const n = Number(toEn(s).replace(/[,،]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const rawId = (id) => String(id ?? '').replace(/^-100/, '').replace(/^-/, '')

// ---------------- قراءة المنشور ----------------
const PRICE_RE = /(?:^|\n|\s)\*?\s*(?:السعر|سعر|السعر النهائي)\s*\*?\s*[/:：\-–=]*\s*([\d٠-٩][\d٠-٩.,]*)/
const PROFIT_RE = /(?:الربح|ربح|العمولة|عمولة)\s*\*?\s*[/:：\-–=]*\s*([\d٠-٩][\d٠-٩.,]*)/

// رسالة السعر: فيها "السعر / رقم" (وبالعادة "الربح / رقم")
export function readPrice(text) {
  const t = toEn(text)
  const m = t.match(PRICE_RE)
  if (!m) return null
  const p = t.match(PROFIT_RE)
  return { cost: num(m[1]), profit: p ? num(p[1]) : 0 }
}

const COLORS = ['أبيض', 'ابيض', 'أسود', 'اسود', 'بيج', 'أحمر', 'احمر', 'أزرق', 'ازرق', 'أخضر', 'اخضر', 'رمادي', 'سكني', 'بني', 'وردي', 'زهري', 'كحلي', 'نبيتي', 'خمري', 'عنابي', 'موف', 'بنفسجي', 'أصفر', 'اصفر', 'برتقالي', 'ذهبي', 'فضي', 'زيتي', 'كريمي', 'عسلي', 'تركواز', 'سماوي', 'جملي', 'أوف وايت', 'اوف وايت']
const COLOR_NORM = { ابيض: 'أبيض', اسود: 'أسود', احمر: 'أحمر', ازرق: 'أزرق', اخضر: 'أخضر', اصفر: 'أصفر', سكني: 'رمادي', زهري: 'وردي', 'اوف وايت': 'أوف وايت' }
const SIZE_WORDS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL']
const NOISE = /(للطلب|راسل|راسلنا|احجز|احجزي|اطلب|الطلب الآن|متوفر للطلب|خدمة توصيل|التوصيل متاح|التسليم فوري|الكمية محدودة|الكمية ممتازة|لا تتنفس|#)/
const BULLET = /^\s*(?:[-•▪▫◽◾●○✓✔☑✅✨⭐🔹🔸💎🌟👌✳️❇️➖➡️👈🔻▶️]|[0-9٠-٩]+[.)\-]|[\u{1F51F}\u{0030}-\u{0039}]\u{FE0F}?\u{20E3})/u

const stripDeco = (s) =>
  String(s || '')
    .replace(/\*+/g, '')
    .replace(/[_~`]/g, '')
    .replace(/^[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}#️⃣0-9️⃣]+/u, '')
    .replace(/[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()

function evenRange(a, b) {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (hi - lo > 40) return []
  const step = lo % 2 === 0 && hi % 2 === 0 ? 2 : 1
  const out = []
  for (let x = lo; x <= hi; x += step) out.push(String(x))
  return out
}

// المقاسات والألوان من النص
export function readOptions(text) {
  const t = toEn(text)
  const lines = t.split('\n')
  let sizes = [] // من قائمة 36/38/40 (الأدق: المتوفر فعلاً)
  let range = [] // من "المقاس: 36 - 48"
  const colors = []
  for (const raw of lines) {
    const line = raw.replace(/\*/g, '')
    // 36/38/40/42 أو S/M/L
    const slash = line.match(/(?:^|[^\d])((?:\d{2}\s*\/\s*){2,}\d{2})(?!\d)/)
    if (slash) {
      const vals = slash[1].split('/').map((x) => x.trim())
      if (vals.every((v) => Number(v) >= 20 && Number(v) <= 60) && vals.length > sizes.length) sizes = vals
    }
    const letters = line.match(/\b((?:XS|S|M|L|XL|XXL|[2-5]XL)(?:\s*[/,،-]\s*(?:XS|S|M|L|XL|XXL|[2-5]XL)){1,})\b/i)
    if (letters && !sizes.length) sizes = letters[1].split(/\s*[/,،-]\s*/).map((x) => x.toUpperCase())
    // المقاس: 36 - 48  (مش أبعاد سم)
    if (/المقاس|المقاسات|مقاس|size/i.test(line) && !/سم|cm|×|x\s*\d/i.test(line) && !range.length) {
      const r = line.match(/(\d{2})\s*(?:-|–|إلى|الى|لـ|ل)\s*(\d{2})/)
      if (r && Number(r[1]) >= 20 && Number(r[2]) <= 60) range = evenRange(Number(r[1]), Number(r[2]))
      else if (/فري\s*سايز|free\s*size|مقاس واحد/i.test(line)) range = ['فري سايز']
    }
    for (const c of COLORS) {
      if (new RegExp(`(^|[^\\p{L}])${c}($|[^\\p{L}])`, 'u').test(line)) {
        const n = COLOR_NORM[c] || c
        if (!colors.includes(n) && /(لون|الوان|ألوان|اللون|الألوان|متوفر|قطعة|قطع|:|🤍|🖤|❤|💙|💚|🤎|💛|🧡|💜|🩶|🩷)/.test(line)) colors.push(n)
      }
    }
  }
  if (!sizes.length) sizes = range
  const options = []
  if (sizes.length) options.push({ label: 'المقاس', values: [...new Set(sizes)], off: [] })
  if (colors.length >= 1) options.push({ label: 'اللون', values: colors, off: [] })
  return options
}

// الاسم + المميزات + الوصف
export function readText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !readPrice(l) && !/^#/.test(l))
  let name = ''
  let nameIdx = -1
  // العنوان: سطر عريض *...* من أول 4 أسطر (الأفضل اللي فيه رقم أو اسم ماركة)، وإلا أول سطر
  const bold = lines
    .slice(0, 4)
    .map((l, i) => ({ l, i, s: stripDeco(l) }))
    .filter((x) => /^\s*\*[^*]{3,}\*\s*$/.test(x.l) && x.s.length >= 6 && !NOISE.test(x.s))
  const pick = bold.find((x) => /[0-9A-Za-z]/.test(x.s)) || null
  if (pick) {
    name = pick.s
    nameIdx = pick.i
  }
  // جمل الدعاية ("لون بيحكي فخامة!" / "بتعاني من...؟") مش اسم — منتخطاها لو بعدها سطر أنسب
  const hook = (x) => /[!؟?]\s*$/.test(x) || /^(وصل|رجع|بتعاني|عندك|خلي|حابة|حابب|جديد|اخيرا|أخيراً|اخيراً|لا تفوت)/.test(x)
  for (let i = 0; i < Math.min(lines.length, 4) && nameIdx < 0; i++) {
    const s = stripDeco(lines[i])
    if (s.length >= 3 && s.length <= 70 && !NOISE.test(s) && !hook(s)) {
      name = s
      nameIdx = i
      break
    }
  }
  for (let i = 0; i < lines.length && nameIdx < 0; i++) {
    const s = stripDeco(lines[i])
    if (s.length >= 3 && !NOISE.test(s)) {
      name = s
      nameIdx = i
      break
    }
  }
  const features = []
  const desc = []
  lines.forEach((l, i) => {
    if (i === nameIdx) return
    const s = stripDeco(l)
    if (!s || NOISE.test(l) || /\[.*\]/.test(s)) return
    if (/^(المقاس|المقاسات|الألوان|الالوان|الألوان والكمية)\s*:?$/.test(s)) return
    const short = s.length <= 90
    if ((BULLET.test(l) || /^\s*\p{Extended_Pictographic}/u.test(l) || /:/.test(s)) && short) features.push(s.replace(/\s*:\s*$/, ''))
    else if (desc.join(' ').length < 350) desc.push(s)
  })
  return { name: name.slice(0, 120), features: [...new Set(features)].slice(0, 10), desc: desc.join('\n').slice(0, 400) }
}

// فرز تلقائي للملابس حسب كلمات الوصف ← القسم المناسب
const SORT_RULES = [
  ['shoes', /(حذاء|احذي[هة]|أحذي[هة]|شوز|بوت|بوط|جزم[هة]|صندل|شبشب|كوتشي|سنيكرز|سبور شوز|shoes?|sneakers?)/i],
  ['kids', /(اطفال|أطفال|ولادي|بناتي|بيبي|مواليد|رضيع|طفل|طفلة|kids?|baby|\d+\s*-\s*\d+\s*(سن[هة]|سنوات|شهر|اشهر|أشهر))/i],
  ['men', /(رجالي|للرجال|رجال|شبابي|للشباب|men'?s?\b)/i],
  ['women', /(حريمي|نسائي|للنساء|ستاتي|بناتي كبير|عبا[يئ][هة]|جلابي[هة]|فستان|فساتين|بلوز[هة]|تنور[هة]|women)/i],
]
export function sortCategory(text, chan) {
  const sort = chan?.sort
  if (!chan?.autoSort || !sort) return chan?.category || ''
  const t = String(text || '')
  for (const [k, re] of SORT_RULES) if (sort[k] && re.test(t)) return sort[k]
  return chan.category || sort.women || ''
}

// بيبني منتج من مجموعة رسائل (صور + نص + رسالة السعر)
export function buildProduct(msgs) {
  const priceMsg = [...msgs].reverse().find((m) => m.text && readPrice(m.text))
  if (!priceMsg) return null
  const price = readPrice(priceMsg.text)
  if (!price.cost) return null
  const texts = msgs.filter((m) => m !== priceMsg && m.text && m.text.trim()).map((m) => m.text)
  // الوصف = أطول نص (اللي قبل رسالة السعر)
  const main = texts.sort((a, b) => b.length - a.length)[0] || ''
  const info = readText(main)
  return {
    ...info,
    options: readOptions(main),
    cost: price.cost,
    profitTg: price.profit,
    photos: msgs.filter((m) => m.photo).map((m) => m.id),
    hasVideo: msgs.some((m) => m.video),
    msgIds: msgs.map((m) => m.id),
    priceMsgId: priceMsg.id,
    date: priceMsg.date,
    raw: main.slice(0, 3000),
  }
}

// بيقسّم رسائل القناة (قديم ← جديد) لمنتجات: كل رسالة سعر بتسكّر منتج
export function groupMessages(list, maxGapSec = 3600) {
  const out = []
  let cur = []
  for (const m of list) {
    if (cur.length && m.date - cur[cur.length - 1].date > maxGapSec) cur = []
    cur.push(m)
    if (m.text && readPrice(m.text) && readPrice(m.text).cost) {
      out.push(cur)
      cur = []
    }
  }
  return { groups: out, rest: cur }
}

// ---------------- GitHub ----------------
function ghRepoOf(priv) {
  const r = String(priv.ghRepo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const [owner, name] = r.split('/')
  return owner && name ? { owner, name } : null
}
const pagesUrl = (owner, name, path) => {
  const host = `${owner.toLowerCase()}.github.io`
  return name.toLowerCase() === host ? `https://${host}/${path}` : `https://${host}/${name}/${path}`
}
// رابط الصورة عن طريق jsDelivr: بيشتغل فوراً (بدون ما نستنى GitHub Pages يبني الموقع)
export const cdnUrl = (owner, name, branch, path) => `https://cdn.jsdelivr.net/gh/${owner}/${name}@${branch || 'main'}/${path}`
// رابط Pages قديم ← رابط CDN
export function toCdn(url, priv) {
  const repo = ghRepoOf(priv)
  if (!repo) return url
  const base = pagesUrl(repo.owner, repo.name, '')
  return String(url).startsWith(base + 'img/tg/') ? cdnUrl(repo.owner, repo.name, priv.ghBranch, String(url).slice(base.length)) : url
}
// الصور بتنرفع على فرع منفصل اسمه img — هيك ما بتعيد بناء موقع المتجر (GitHub Pages) مع كل صورة
const IMG_BRANCH = 'img'
let imgBranchReady = false
async function ensureImgBranch(repo, headers, base) {
  if (imgBranchReady) return
  const api = `https://api.github.com/repos/${repo.owner}/${repo.name}/git`
  const has = await fetch(`${api}/ref/heads/${IMG_BRANCH}`, { headers, signal: AbortSignal.timeout(30_000) })
  if (!has.ok) {
    const main = await fetch(`${api}/ref/heads/${base}`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!main.ok) throw new Error(`GitHub ${main.status}: ما لقيت فرع ${base}`)
    const sha = (await main.json()).object.sha
    const r = await fetch(`${api}/refs`, { method: 'POST', headers, body: JSON.stringify({ ref: `refs/heads/${IMG_BRANCH}`, sha }), signal: AbortSignal.timeout(30_000) })
    if (!r.ok && r.status !== 422) throw new Error(`GitHub ${r.status}: ما قدرت أعمل فرع الصور`)
  }
  imgBranchReady = true
}

async function uploadGithub(priv, path, buf, log = () => {}) {
  const repo = ghRepoOf(priv)
  if (!repo || !priv.ghToken) throw new Error('جهّز رفع الصور (ريبو + توكن GitHub) من إعدادات المتجر')
  const headers = { Authorization: `Bearer ${String(priv.ghToken).trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  await ensureImgBranch(repo, headers, priv.ghBranch || 'main')
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ message: `صورة من تيليجرام ${path}`, content: buf.toString('base64'), branch: IMG_BRANCH }),
      signal: AbortSignal.timeout(60_000),
    })
    if (r.ok || r.status === 422) return cdnUrl(repo.owner, repo.name, IMG_BRANCH, path) // 422 = الملف موجود
    const j = await r.json().catch(() => ({}))
    // GitHub طلب نهدّي (حد الرفع بالساعة) ← بنستنى وبنرجع نحاول
    const limited = r.status === 429 || (r.status === 403 && /rate limit|abuse|secondary/i.test(j.message || ''))
    if ((limited || r.status === 409) && attempt < 8) {
      const wait = r.status === 409 ? 3 : Math.max(60, Number(r.headers.get('retry-after')) || 0)
      if (limited) log(`⏳ GitHub طلب نهدّي — بكمّل بعد ${Math.round(wait / 60)} دقيقة`)
      await sleep(Math.min(wait, 3600) * 1000)
      continue
    }
    throw new Error(`GitHub ${r.status}${j.message ? `: ${j.message}` : ''}`)
  }
}

// ============================================================
export function createShopImport({ clients, accData, log, event, notifier, Api }) {
  let cfg = { enabled: false, accountId: '', channels: [] }
  let priv = {}
  const chans = new Map() // rawId -> channel cfg
  const buffers = new Map() // rawId -> [msg]
  const timers = new Map()
  const working = new Set()

  // الحساب المختار (من الأمر أو الإعدادات) — لو مش متصل منقول بدل ما ناخد حساب تاني
  const client = (want = '') => {
    const id = want || cfg.accountId
    if (id) {
      if (!clients.has(id)) throw new Error(`حساب تيليجرام "${accData.get(id)?.name || id}" مش متصل هلأ`)
      return { id, c: clients.get(id) }
    }
    const first = [...clients.keys()][0]
    return first ? { id: first, c: clients.get(first) } : null
  }


  // رسالة GramJS ← شكل بسيط
  const simple = (msg) => ({
    id: msg.id,
    date: Number(msg.date) || 0,
    text: msg.message || '',
    photo: msg.media instanceof Api.MessageMediaPhoto,
    video: !!(msg.media instanceof Api.MessageMediaDocument && /video/.test(msg.media.document?.mimeType || '')),
    group: msg.groupedId ? String(msg.groupedId) : null,
    _msg: msg,
  })

  async function save(chan, group, c) {
    const p = buildProduct(group)
    if (!p || !p.name) return null
    const docId = `tg_${chan.id}_${p.priceMsgId}`
    const ref = prodCol.doc(docId)
    if ((await ref.get()).exists) return null
    // الصور
    const images = []
    for (const m of group.filter((x) => x.photo).slice(0, 20)) {
      try {
        const buf = await c.downloadMedia(m._msg, {})
        if (!buf?.length) continue
        images.push(await uploadGithub(priv, `img/tg/${chan.id}/${m.id}.jpg`, Buffer.from(buf), log))
        await sleep(1500) // تهدئة: GitHub بيسمح بعدد محدود بالساعة
      } catch (e) {
        log(`⚠️ صورة من ${chan.title}: ${e.message}`)
        if (/جهّز رفع الصور|GitHub 40[134]/.test(e.message)) throw e
      }
    }
    // ترجمة للإنجليزي (لغة المتجر الأساسية)
    let en = {}
    try {
      const [nameEn, descEn, ...featuresEn] = await translateTexts([p.name, p.desc, ...p.features])
      en = { nameEn, descEn, featuresEn: featuresEn.filter(Boolean) }
    } catch (e) {
      log('⚠️ ترجمة منتج تيليجرام:', e.message)
    }
    const extra = Number(chan.extraProfit) || 0
    const profit = (p.profitTg || 0) + extra
    const link = chan.username ? `https://t.me/${chan.username}/${p.priceMsgId}` : `https://t.me/c/${chan.id}/${p.priceMsgId}`
    const auto = !!chan.autoPublish && images.length > 0
    const category = sortCategory(`${p.name}\n${p.raw}`, chan)
    const doc = {
      name: p.name,
      category,
      cost: p.cost,
      profit,
      price: p.cost + profit,
      oldPrice: 0,
      images,
      feedback: [],
      features: p.features,
      desc: p.desc,
      options: p.options,
      ...en,
      nameHe: '',
      featuresHe: [],
      descHe: '',
      featured: false,
      sizeGuide: '',
      delivery: chan.delivery || 'normal',
      deliveryPrice: 0,
      related: [],
      available: true,
      visible: auto,
      status: auto ? 'live' : 'draft',
      badge: '',
      order: 0,
      tgLink: link,
      privateNote: `الربح من القناة: ${p.profitTg || 0}${extra ? ` + إضافي ${extra}` : ''}${p.hasVideo ? ' · المنشور فيه فيديو' : ''}`,
      source: { channel: chan.id, title: chan.title || '', msgIds: p.msgIds, date: p.date * 1000, raw: p.raw },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    await ref.set(doc)
    if (auto) queueCatalog((cat) => {
      cat.products = [publicProduct({ ...doc, id: docId, createdAt: Date.now() }), ...cat.products.filter((x) => x.id !== docId)]
    })
    return { id: docId, name: p.name, price: p.cost + profit, images: images.length, auto, category }
  }

  async function flush(chanId) {
    const chan = chans.get(chanId)
    const list = buffers.get(chanId) || []
    if (!chan || !list.length) return
    const { groups, rest } = groupMessages(list)
    buffers.set(chanId, rest)
    const cl = client()
    if (!cl) return
    for (const g of groups) {
      try {
        const r = await save(chan, g, cl.c)
        if (r) {
          event('ok', r.auto ? `🛍️ منتج جديد من "${chan.title}" انتشر بالمتجر: ${r.name}` : `🛍️ منتج جديد من "${chan.title}" بانتظار المراجعة: ${r.name}`)
          notifier.notify(
            'orders',
            r.auto
              ? `🛍️ منتج جديد انتشر بالمتجر لحاله:\n${r.name} — ${r.price} ₪ (${r.images} صور)${r.category ? `\nالقسم: ${r.category}` : ''}`
              : `🛍️ منتج جديد من تيليجرام بانتظار مراجعتك:\n${r.name} — ${r.price} ₪ (${r.images} صور)${r.category ? `\nالقسم: ${r.category}` : ''}\nافتح اللوحة ← المتجر ← بانتظار المراجعة`,
          )
        }
      } catch (e) {
        log(`⚠️ استيراد من ${chan.title}: ${e.message}`)
      }
    }
  }

  // رسالة جديدة بقناة منتجات
  function onMessage(ev) {
    if (!cfg.enabled) return false
    const msg = ev.message
    const id = rawId(msg?.chatId ?? ev.chatId)
    const chan = chans.get(id)
    if (!chan || chan.enabled === false) return false
    if (chan.kind === 'soldout') {
      onSoldout(chan, simple(msg)).catch((e) => log('⚠️ منتج نافد:', e.message))
      return true
    }
    if (chan.kind === 'feedback') {
      let cl = null
      try {
        cl = client()
      } catch {
        cl = ev._client ? { c: ev._client } : null
      }
      if (cl) saveFeedback(chan, simple(msg), cl.c).catch((e) => log('⚠️ فيدباك:', e.message))
      return true
    }
    const list = buffers.get(id) || []
    if (list.some((m) => m.id === msg.id)) return true
    list.push(simple(msg))
    list.sort((a, b) => a.id - b.id)
    buffers.set(id, list.slice(-60))
    // بنستنى شوي (الألبوم بيوصل رسالة رسالة)
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => flush(id).catch((e) => log('⚠️ استيراد:', e.message)), 8000),
    )
    return true
  }

  // ---------- تحديثات ملف المتجر بالدفعة (كل 20 ثانية تعديل واحد بدل كتير) ----------
  const catOps = []
  let catTimer = null
  function queueCatalog(fn) {
    catOps.push(fn)
    clearTimeout(catTimer)
    catTimer = setTimeout(() => flushCatalog().catch(() => {}), 20_000)
  }
  async function flushCatalog() {
    clearTimeout(catTimer)
    if (!catOps.length) return
    const ops = catOps.splice(0)
    const ok = await patchCatalog(priv, (cat) => ops.forEach((f) => f(cat)), log)
    if (!ok) log('⚠️ ملف المتجر ما تحدّث — اكبس «إعادة نشر» باللوحة')
  }

  // ---------- قناة المنتجات النافدة ----------
  const normName = (t) =>
    String(t || '')
      .replace(/[\u064B-\u0652\u0640]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase()
  let nameCache = { at: 0, list: [] }
  async function productNames() {
    if (Date.now() - nameCache.at < 30 * 60_000) return nameCache.list
    const snap = await prodCol.where('available', '==', true).get()
    nameCache = { at: Date.now(), list: snap.docs.map((d) => ({ id: d.id, name: d.data().name, n: normName(d.data().name), src: d.data().source || null })) }
    return nameCache.list
  }
  async function markSoldout(ids, label) {
    for (const id of ids) await prodCol.doc(id).update({ available: false, soldoutAt: Date.now() }).catch(() => {})
    nameCache.at = 0
    queueCatalog((cat) => {
      for (const p of cat.products) if (ids.includes(p.id)) p.available = false
    })
    event('info', `🚫 نفد من المتجر: ${label}`)
  }
  // منشور بقناة النافدة ← بنلاقي المنتج (لو المنشور محوّل من قناة المنتجات، أو من اسمه)
  async function onSoldout(chan, m, notify = true) {
    const f = m._msg?.fwdFrom
    const fwdChan = f?.fromId?.channelId != null ? rawId(f.fromId.channelId) : ''
    const fwdPost = Number(f?.channelPost) || 0
    let hits = []
    const list = await productNames()
    if (fwdChan && fwdPost) {
      hits = list.filter((p) => p.src && String(p.src.channel) === fwdChan && (p.src.msgIds || []).includes(fwdPost)).map((p) => p.id)
      if (!hits.length) hits = list.filter((p) => p.src && String(p.src.channel) === fwdChan && Math.abs(Number(p.id.split('_').pop()) - fwdPost) <= 12).map((p) => p.id).slice(0, 1)
    }
    if (!hits.length && m.text) {
      const t = normName(m.text)
      const cands = list.filter((p) => p.n.length >= 8 && t.includes(p.n))
      if (cands.length === 1) hits = [cands[0].id]
      else if (cands.length > 1 && notify) notifier.notify('orders', `🤔 منشور بقناة "${chan.title}" بيشبه أكتر من منتج — علّم النافد بإيدك:\n${cands.slice(0, 5).map((c) => `▫️ ${c.name}`).join('\n')}`)
    }
    if (!hits.length) {
      if (notify && (m.text || m.photo)) notifier.notify('orders', `📭 منتج نافد بقناة "${chan.title}" وما عرفت أي منتج بالمتجر — شوفه وعلّمه بإيدك:\n${(m.text || '[صورة]').slice(0, 200)}`)
      return false
    }
    const names = list.filter((p) => hits.includes(p.id)).map((p) => p.name)
    await markSoldout(hits, names.join('، '))
    if (notify) notifier.notify('orders', `🚫 تعلّم نافد بالمتجر لحاله:\n${names.map((n) => `▫️ ${n}`).join('\n')}`)
    return true
  }

  // ---------- قناة الفيدباك: صور الزباين ← صفحة "آراء زبائننا" ----------
  async function saveFeedback(chan, m, c, publish = true) {
    if (!m.photo) return false
    const id = `${chan.id}_${m.id}`
    const ref = fbCol.doc(id)
    if ((await ref.get()).exists) return false
    const buf = await c.downloadMedia(m._msg, {})
    if (!buf?.length) return false
    const img = await uploadGithub(priv, `img/fb/${chan.id}/${m.id}.jpg`, Buffer.from(buf), log)
    const item = { img, text: String(m.text || '').slice(0, 300), at: (m.date || Date.now() / 1000) * 1000 }
    await ref.set({ ...item, channel: chan.id, createdAt: FieldValue.serverTimestamp() })
    queueCatalog((cat) => {
      const list = Array.isArray(cat.feedbackFeed) ? cat.feedbackFeed : []
      cat.feedbackFeed = [item, ...list.filter((x) => x.img !== img)].sort((a, b) => b.at - a.at).slice(0, 120)
    })
    if (!publish) await sleep(1200)
    return true
  }

  // سحب منشورات قديمة من قناة
  const progress = (id, p) => cfgRef.set({ progress: { [id]: { ...p, at: Date.now() } } }, { merge: true }).catch(() => {})

  // سحب منشورات قديمة من قناة — بيقرأ لحد ما يلاقي العدد المطلوب من المنتجات
  async function backfill(chanId, limit = 40, accountId = '', wait = true) {
    const chan = chans.get(rawId(chanId))
    if (!chan) throw new Error('القناة مش محفوظة — اكبس حفظ أول')
    if (working.has(chan.id)) throw new Error('السحب شغال لهالقناة')
    const cl = client(accountId)
    if (!cl) throw new Error('ما في حساب تيليجرام متصل')
    working.add(chan.id)
    const run = async () => {
      try {
        await progress(chan.id, { state: 'reading', added: 0, total: 0 })
        const ent = await cl.c.getEntity(chan.username || Number(`-100${chan.id}`))
        // قنوات الفيدباك والنافدة: آخر N منشور
        if (chan.kind === 'feedback' || chan.kind === 'soldout') {
          let added = 0
          let done = 0
          for await (const m of cl.c.iterMessages(ent, { limit })) {
            const sm = simple(m)
            if (chan.kind === 'feedback' ? await saveFeedback(chan, sm, cl.c, false) : await onSoldout(chan, sm, false)) added++
            if (++done % 5 === 0) await progress(chan.id, { state: 'saving', added, done, total: limit })
          }
          await flushCatalog()
          await progress(chan.id, { state: 'done', added, done, total: done })
          notifier.notify('orders', chan.kind === 'feedback' ? `💬 خلص سحب الفيدباك من "${chan.title}": ${added} صورة` : `🚫 خلص فحص "${chan.title}": ${added} منتج تعلّم نافد`)
          return { added }
        }
        const msgs = []
        let found = 0
        // بنكمّل قراءة لحد ما نلاقي العدد المطلوب من المنتجات (أو آخر القناة)
        for await (const m of cl.c.iterMessages(ent, { limit: Math.min(60000, limit * 40) })) {
          msgs.push(simple(m))
          if (m.message && readPrice(m.message)?.cost && ++found >= limit + 1) break
        }
        msgs.sort((a, b) => a.id - b.id)
        const { groups } = groupMessages(msgs)
        const todo = groups.slice(-limit)
        let added = 0
        let done = 0
        for (const g of todo) {
          try {
            if (await save(chan, g, cl.c)) added++
          } catch (e) {
            log(`⚠️ سحب من ${chan.title}: ${e.message}`)
            if (/جهّز رفع الصور|GitHub 40[14]/.test(e.message)) throw e
          }
          done++
          if (done % 3 === 0) await progress(chan.id, { state: 'saving', added, done, total: todo.length })
        }
        await flushCatalog()
        await progress(chan.id, { state: 'done', added, done, total: todo.length })
        event('ok', `🛍️ سحب من "${chan.title}": ${added} منتج جديد`)
        notifier.notify('orders', `🛍️ خلص السحب من "${chan.title}": ${added} منتج جديد ${chan.autoPublish ? 'انضافوا للمتجر مباشرة' : 'بانتظار مراجعتك'}`)
        return { added, found: groups.length }
      } catch (e) {
        await progress(chan.id, { state: 'error', error: e.message })
        throw e
      } finally {
        working.delete(chan.id)
      }
    }
    if (wait) return run()
    run().catch((e) => log(`⚠️ سحب من ${chan.title}: ${e.message}`))
    return { started: true }
  }

  // قنوات الحساب (لاختيارها باللوحة)
  async function listChannels(accountId = '') {
    const cl = client(accountId)
    if (!cl) throw new Error('ما في حساب تيليجرام متصل')
    const out = []
    for await (const d of cl.c.iterDialogs({ limit: 300 })) {
      const e = d.entity
      if (e instanceof Api.Channel && e.broadcast) out.push({ id: rawId(e.id), title: e.title || '', username: e.username || '' })
    }
    const a = accData.get(cl.id) || {}
    return { account: `${a.name || cl.id}${a.phone ? ` (+${String(a.phone).replace(/\D/g, '')})` : ''}`, channels: out }
  }

  async function command(c) {
    if (c.type === 'shop_tg_channels') return listChannels(c.accountId || '')
    if (c.type === 'shop_tg_backfill') return backfill(c.channelId, Math.min(3000, Number(c.limit) || 40), c.accountId || '', false)
    throw new Error('أمر غير معروف')
  }

  // صور المنتجات المسحوبة قبل (روابط GitHub Pages) ← روابط CDN اللي بتشتغل فوراً
  async function migrateImages() {
    const snap = await prodCol.where('status', 'in', ['draft', 'live']).get()
    let n = 0
    for (const d of snap.docs) {
      const imgs = d.data().images || []
      const next = imgs.map((u) => toCdn(u, priv))
      if (next.some((u, i) => u !== imgs[i])) {
        await d.ref.update({ images: next })
        n++
      }
    }
    if (n) log(`🖼️ تحدّثت روابط صور ${n} منتج (صارت بتفتح فوراً)`)
  }

  function start() {
    listen(
      cfgRef,
      (d) => {
        cfg = { enabled: false, accountId: '', channels: [], ...(d.data() || {}) }
        chans.clear()
        for (const ch of cfg.channels || []) if (ch?.id) chans.set(rawId(ch.id), { ...ch, id: rawId(ch.id) })
      },
      (e) => log('⚠️ إعدادات استيراد المنتجات:', e.message),
    )
    let migrated = false
    listen(
      privRef,
      (d) => {
        priv = d.data() || {}
        if (!migrated && ghRepoOf(priv)) {
          migrated = true
          migrateImages().catch((e) => log('⚠️ تحديث روابط الصور:', e.message))
        }
      },
      (e) => log('⚠️ إعدادات المتجر:', e.message),
    )
  }

  return { start, onMessage, command, backfill }
}

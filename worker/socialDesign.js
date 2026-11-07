// ============================================================
//  تصميم منشورات فيسبوك/إنستغرام (SVG) + نصوص المنشور
//  ملف مشترك: العامل بيرسمه PNG (resvg) واللوحة بترسمه بالمتصفح
//  (نفس الملف منسوخ بـ web/src/socialDesign.js)
// ============================================================

export const SOCIAL_DEFAULTS = { enabled: true, at: '08:00', count: 3, cooldownDays: 30 }
export const mergeSocial = (s = {}) => ({
  ...SOCIAL_DEFAULTS,
  ...s,
  count: Math.min(5, Math.max(1, Number(s.count) || SOCIAL_DEFAULTS.count)),
  cooldownDays: Math.min(120, Math.max(3, Number(s.cooldownDays) || SOCIAL_DEFAULTS.cooldownDays)),
  at: /^\d{2}:\d{2}$/.test(s.at || '') ? s.at : SOCIAL_DEFAULTS.at,
})

// ألوان المتجر
const C = { bg: '#e9eef5', bg2: '#dfe6ef', card: '#ffffff', ink: '#0f172a', ink2: '#334155', muted: '#64748b', blue: '#1d4ed8', blueD: '#1e3a8a', orange: '#f97316', red: '#dc2626', line: '#e7ebf0' }

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// شيل الإيموجي والرموز اللي الخط ما فيه (عشان ما تطلع مربعات)
export const cleanText = (s) =>
  String(s ?? '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[★☆✓✔✅❌•●◆■□▪️➖➕➡️⬅️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
const isArabic = (s) => /[؀-ۿ]/.test(s)

// عرض تقريبي للنص بخط Cairo
function textWidth(s, size) {
  let w = 0
  for (const ch of s) w += /[؀-ۿ]/.test(ch) ? 0.5 : /[A-Z0-9]/.test(ch) ? 0.62 : /\s/.test(ch) ? 0.28 : 0.5
  return w * size
}
// تقسيم النص لأسطر بحد أقصى (وآخر سطر بـ …)
export function wrap(text, size, maxW, maxLines = 2) {
  const words = cleanText(text).split(' ').filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w
    if (textWidth(t, size) <= maxW || !cur) cur = t
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines)
    let last = keep[maxLines - 1]
    while (last.length > 3 && textWidth(last + '…', size) > maxW) last = last.slice(0, -1)
    keep[maxLines - 1] = last.replace(/\s+\S*$/, '').trim() + '…'
    return keep
  }
  return lines
}

const fmtPrice = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return String(v)
}

function textLines(lines, { x, y, size, lh = 1.35, weight = 400, fill = C.ink, anchor = 'end' }) {
  return lines
    .map((l, i) => {
      return `<text x="${x}" y="${y + i * size * lh}" font-family="Cairo" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(l)}</text>`
    })
    .join('')
}

// السعر: الرقم والعملة بعنصرين منفصلين (عشان ترتيب العربي/الأرقام يضل صح)
function priceBlock({ xRight, y, price, oldPrice, size, cur = 'شيكل' }) {
  const num = fmtPrice(price)
  const numW = num.length * size * 0.56
  const curSize = Math.round(size * 0.42)
  // الرقم يمين، والعملة يساره، والسعر القديم يسارهم
  let out = `<text x="${xRight}" y="${y}" font-family="Cairo" font-weight="800" font-size="${size}" fill="${C.blue}" text-anchor="end">${esc(num)}</text>`
  const curX = xRight - numW - size * 0.1
  out += `<text x="${curX}" y="${y}" font-family="Cairo" font-weight="700" font-size="${curSize}" fill="${C.blue}" text-anchor="end">${esc(cur)}</text>`
  if (Number(oldPrice) > Number(price)) {
    const o = fmtPrice(oldPrice)
    const os = Math.round(size * 0.46)
    const ox = curX - cur.length * curSize * 0.7 - size * 0.3
    const ow = o.length * os * 0.6
    out += `<text x="${ox}" y="${y}" font-family="Cairo" font-weight="600" font-size="${os}" fill="${C.muted}" text-anchor="end">${esc(o)}</text>`
    out += `<line x1="${ox - ow - 4}" y1="${y - os * 0.32}" x2="${ox + 4}" y2="${y - os * 0.32}" stroke="${C.red}" stroke-width="4" stroke-linecap="round"/>`
  }
  return out
}

function badges({ p, x, y, kind }) {
  const out = []
  const off = Number(p.oldPrice) > Number(p.price) ? Math.round((1 - Number(p.price) / Number(p.oldPrice)) * 100) : 0
  if (off >= 5) {
    out.push(`<g><rect x="${x}" y="${y}" width="190" height="78" rx="39" fill="${C.red}"/><text x="${x + 95}" y="${y + 53}" font-family="Cairo" font-weight="800" font-size="40" fill="#fff" text-anchor="middle">-${off}%</text></g>`)
  } else if (kind === 'new') {
    out.push(`<g><rect x="${x}" y="${y}" width="230" height="78" rx="39" fill="${C.orange}"/><text x="${x + 115}" y="${y + 52}" font-family="Cairo" font-weight="800" font-size="34" fill="#fff" text-anchor="middle">جديد · NEW</text></g>`)
  }
  return out.join('')
}

function logoPill({ xRight, y, logo, storeName }) {
  const w = 300
  const x = xRight - w
  return `<g><rect x="${x}" y="${y}" width="${w}" height="84" rx="42" fill="#ffffff" fill-opacity="0.94"/>
${logo ? `<image href="${logo}" x="${xRight - 74}" y="${y + 10}" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>` : ''}
<text x="${xRight - (logo ? 88 : 24)}" y="${y + 55}" font-family="Cairo" font-weight="800" font-size="32" fill="${C.blueD}" text-anchor="end">${esc(storeName || 'Joudi Store')}</text></g>`
}

function ctaButton({ x, y, w, h, size }) {
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.orange}"/>
<text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" font-family="Cairo" font-weight="800" font-size="${size}" fill="#fff" text-anchor="middle">اطلب الآن · Order now</text></g>`
}

// ---------- منشور مربع 1080×1080 ----------
export function postSvg({ p, img, logo, storeName, kind }) {
  const W = 1080
  const nameAr = wrap(p.name, 54, 960, 2)
  const nameEn = p.nameEn && !isArabic(p.nameEn) ? wrap(p.nameEn, 30, 960, 1) : []
  const photoH = nameAr.length > 1 ? 640 : 690
  const ty = 40 + photoH + 78
  const enY = ty + (nameAr.length - 1) * 54 * 1.3 + 50
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<defs><clipPath id="ph"><rect x="40" y="40" width="1000" height="${photoH}" rx="44"/></clipPath>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
<rect width="${W}" height="${W}" fill="url(#g)"/>
<rect x="40" y="40" width="1000" height="${photoH}" rx="44" fill="#fff"/>
${img ? `<image href="${img}" x="40" y="40" width="1000" height="${photoH}" preserveAspectRatio="xMidYMid meet" clip-path="url(#ph)"/>` : ''}
${logoPill({ xRight: 1010, y: 70, logo, storeName })}
${badges({ p, x: 70, y: 73, kind })}
${textLines(nameAr, { x: 1040, y: ty, size: 54, lh: 1.3, weight: 800 })}
${nameEn.length ? textLines(nameEn, { x: 1040, y: enY, size: 30, weight: 600, fill: C.muted }) : ''}
${priceBlock({ xRight: 1040, y: 1022, price: p.price, oldPrice: p.oldPrice, size: 74 })}
${ctaButton({ x: 40, y: 950, w: 430, h: 92, size: 34 })}
</svg>`
}

// ---------- ستوري 1080×1920 ----------
export function storySvg({ p, img, logo, storeName, kind, features = [], delivery = '' }) {
  const W = 1080
  const H = 1920
  const nameAr = wrap(p.name, 66, 960, 2)
  const nameEn = p.nameEn && !isArabic(p.nameEn) ? wrap(p.nameEn, 36, 960, 1) : []
  const feats = features.map((f) => wrap(f, 38, 880, 1)[0]).filter(Boolean).slice(0, 3)
  let y = 1200
  let out = textLines(nameAr, { x: 1020, y, size: 66, lh: 1.3, weight: 800 })
  y += (nameAr.length - 1) * 66 * 1.3 + 62
  if (nameEn.length) {
    out += textLines(nameEn, { x: 1020, y, size: 36, weight: 600, fill: C.muted })
    y += 70
  } else y += 14
  for (const f of feats) {
    out += `<circle cx="1004" cy="${y - 13}" r="15" fill="${C.blue}"/><path d="M996 ${y - 13} l6 6 l11 -12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    out += textLines([f], { x: 972, y, size: 38, weight: 600, fill: C.ink2 })
    y += 64
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="ph"><rect x="60" y="200" width="960" height="900" rx="52"/></clipPath>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
${logoPill({ xRight: 1020, y: 90, logo, storeName })}
<rect x="60" y="200" width="960" height="900" rx="52" fill="#fff"/>
${img ? `<image href="${img}" x="60" y="200" width="960" height="900" preserveAspectRatio="xMidYMid meet" clip-path="url(#ph)"/>` : ''}
${badges({ p, x: 90, y: 230, kind })}
${out}
${priceBlock({ xRight: 1020, y: Math.max(1700, y + 70), price: p.price, oldPrice: p.oldPrice, size: 96 })}
${ctaButton({ x: 60, y: 1745, w: 960, h: 112, size: 44 })}
${delivery ? textLines([cleanText(delivery)], { x: 540, y: 1895, size: 28, weight: 600, fill: C.muted, anchor: 'middle' }) : ''}
</svg>`
}

// ---------- نصوص المنشور (عربي وتحته إنجليزي) ----------
const HOOKS_AR = [
  'الشي اللي رح يسهّل عليك كتير 👌',
  'وصل جديد وبسعر حلو 🔥',
  'الكل عم يسأل عنه 😍',
  'فكرة هدية مميزة 🎁',
  'جودة ممتازة وسعر بيناسبك 💯',
  'اختيار مميز لبيتك 🏡',
  'رتّب بيتك بلمسة حلوة ✨',
]
const HOOKS_EN = ['Make life easier 👌', 'Just arrived at a great price 🔥', 'Everyone is asking about it 😍', 'A perfect gift idea 🎁', 'Great quality, fair price 💯', 'A special pick for your home 🏡', 'Add a lovely touch to your home ✨']
const tagify = (s) => '#' + cleanText(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '')

const shortDesc = (t, max = 320) => {
  const s = cleanText(t)
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('،'), cut.lastIndexOf('!'))
  return (end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…').trim()
}

// بدون سعر: السعر عالموقع أو عالخاص
export function captions({ p, link, settings = {}, seed = 0 }) {
  const i = Math.abs(seed) % HOOKS_AR.length
  const feats = (p.features || []).map(cleanText).filter(Boolean).slice(0, 5)
  const featsEn = (p.featuresEn || []).map(cleanText).filter((x) => x && !isArabic(x)).slice(0, 5)
  const desc = p.desc ? shortDesc(p.desc) : ''
  const descEn = p.descEn && !isArabic(p.descEn) ? shortDesc(p.descEn) : ''
  const ar = [
    `✨ ${cleanText(p.name)}`,
    HOOKS_AR[i],
    ...(desc ? ['', desc] : []),
    ...(feats.length ? ['', ...feats.map((f) => `✅ ${f}`)] : []),
    '',
    '🚚 توصيل لكل الضفة والقدس والداخل · الدفع عند الاستلام',
  ]
  const en = [
    `✨ ${cleanText(p.nameEn && !isArabic(p.nameEn) ? p.nameEn : p.name)}`,
    HOOKS_EN[i],
    ...(descEn ? ['', descEn] : []),
    ...(featsEn.length ? ['', ...featsEn.map((f) => `✅ ${f}`)] : []),
    '',
    '🚚 Delivery to the West Bank, Jerusalem & 48 · Cash on delivery',
  ]
  const storeTag = tagify(settings.name || 'جودي ستور')
  const tags = [storeTag, '#JoudiStore', p.category ? tagify(p.category) : '', '#تسوق_اونلاين', '#الدفع_عند_الاستلام', '#فلسطين', '#الضفة', '#القدس', '#الداخل'].filter(Boolean)
  const fb = [...ar, `💬 السعر عالموقع أو راسلنا عالخاص`, `🛒 ${link}`, '', '—', '', ...en, '💬 Price on our website or DM us', `🛒 ${link}`, '', tags.slice(0, 6).join(' ')].join('\n')
  const ig = [...ar, '💬 السعر عالخاص أو من الرابط بالبايو', '', '—', '', ...en, '💬 Price via DM or the link in bio', '', [...tags, '#instashop', '#onlineshopping', '#palestine', '#shopping'].join(' ')].join('\n')
  return { fb, ig }
}

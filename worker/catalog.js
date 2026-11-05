// ============================================================
//  تعديل ملف المتجر (catalog.json على GitHub) من العامل مباشرة
//  للأشياء اللي بتصير لحالها: نشر تلقائي، منتج نفد، صور فيدباك
//  (اللوحة بتعيد بناء الملف كامل لما تكبس "إعادة نشر")
// ============================================================
import { sleep } from './common.js'

export function ghRepoOf(priv) {
  const r = String(priv?.ghRepo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const [owner, name] = r.split('/')
  return owner && name ? { owner, name } : null
}

const normOptions = (o) =>
  (Array.isArray(o) ? o : [])
    .map((g) => ({
      label: String(g.label || 'اختر').trim(),
      values: (g.values || []).map((v) => String(v).trim()).filter(Boolean).slice(0, 40),
      off: (g.off || []).map((v) => String(v).trim()).filter(Boolean),
    }))
    .filter((g) => g.values.length)
    .slice(0, 3)

// نفس حقول publicProduct باللوحة (بدون سعر الجملة والربح)
export function publicProduct(p, extra = {}) {
  const ms = (v) => (v?.toMillis ? v.toMillis() : v?._seconds ? v._seconds * 1000 : Number(v) || 0)
  return {
    id: p.id,
    name: p.name,
    nameHe: p.nameHe || '',
    featuresHe: (p.featuresHe || []).slice(0, 15),
    descHe: p.descHe || '',
    nameEn: p.nameEn || '',
    featuresEn: (p.featuresEn || []).slice(0, 15),
    descEn: p.descEn || '',
    category: p.category || '',
    price: Number(p.price) || 0,
    oldPrice: Number(p.oldPrice) || 0,
    images: (p.images || []).slice(0, 20),
    feedback: (p.feedback || []).slice(0, 12),
    features: (p.features || []).slice(0, 15),
    desc: p.desc || '',
    sizeGuide: p.sizeGuide || '',
    options: normOptions(p.options),
    delivery: p.delivery || 'normal',
    deliveryPrice: Number(p.deliveryPrice) || 0,
    related: (p.related || []).slice(0, 8),
    available: p.available !== false,
    featured: !!p.featured,
    flashPrice: Number(p.flashPrice) || 0,
    flashUntil: Number(p.flashUntil) || 0,
    badge: p.badge || '',
    order: Number(p.order) || 0,
    createdAt: ms(p.createdAt) || Date.now(),
    sold: extra.sold || 0,
    rating: extra.rating || null,
    reviews: extra.reviews || [],
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

// بيقرأ catalog.json، بيطبّق التعديل، وبيكتبه — مع إعادة المحاولة لو صار تعارض
export async function patchCatalog(priv, mutate, log = () => {}) {
  const repo = ghRepoOf(priv)
  if (!repo || !priv.ghToken) return false
  const branch = priv.ghBranch || 'main'
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/catalog.json`
  const headers = { Authorization: `Bearer ${String(priv.ghToken).trim()}`, 'X-GitHub-Api-Version': '2022-11-28' }
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await sleep(1500 + Math.random() * 2000)
    try {
      const meta = await fetch(`${url}?ref=${branch}&t=${Date.now()}`, { headers: { ...headers, Accept: 'application/vnd.github.object' }, signal: AbortSignal.timeout(30_000) })
      if (!meta.ok) throw new Error(`GitHub ${meta.status}`)
      const { sha } = await meta.json()
      const raw = await fetch(`${url}?ref=${branch}&t=${Date.now()}`, { headers: { ...headers, Accept: 'application/vnd.github.raw' }, signal: AbortSignal.timeout(60_000) })
      if (!raw.ok) throw new Error(`GitHub ${raw.status}`)
      const cat = await raw.json()
      cat.products = Array.isArray(cat.products) ? cat.products : []
      const changed = mutate(cat)
      if (changed === false) return true
      cat.at = Date.now()
      const r = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ message: 'تحديث الكتالوج (تلقائي)', content: b64(JSON.stringify(cat)), sha, branch }),
        signal: AbortSignal.timeout(60_000),
      })
      if (r.ok) {
        await writeFbFeed(priv, cat, headers).catch((e) => log('⚠️ كتالوج فيسبوك:', e.message))
        return true
      }
      if (![409, 422, 500, 502, 503].includes(r.status)) throw new Error(`GitHub ${r.status}`)
    } catch (e) {
      if (attempt === 7) {
        log('⚠️ تحديث ملف المتجر:', e.message)
        return false
      }
    }
  }
  return false
}

// ---------- كتالوج فيسبوك/إنستغرام (نفس اللي باللوحة) — على فرع الصور ----------
export const FEED_PATH = 'feeds/facebook.csv'
const CUR_ISO = { '₪': 'ILS', 'شيكل': 'ILS', ILS: 'ILS', $: 'USD', USD: 'USD', 'ج.م': 'EGP', EGP: 'EGP', 'د.أ': 'JOD', JOD: 'JOD' }
export function storeBase(priv) {
  if (priv.storeUrl) return String(priv.storeUrl).replace(/#.*$/, '').replace(/\/?$/, '/')
  const r = ghRepoOf(priv)
  if (!r) return ''
  const host = `${r.owner.toLowerCase()}.github.io`
  return r.name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${r.name}/`
}
const csvCell = (v) => {
  const s = String(v ?? '').replace(/\r?\n+/g, ' ').trim()
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function fbCatalogCsv(products, settings, base, currency = 'ILS') {
  const head = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type']
  const rows = products
    .filter((p) => p && p.id && p.name && p.images?.[0] && Number(p.price) > 0)
    .map((p) => {
      const title = (p.nameEn || p.name).slice(0, 150)
      const desc = [p.descEn || p.desc, ...((p.featuresEn?.length ? p.featuresEn : p.features) || [])].filter(Boolean).join(' · ').slice(0, 4900) || title
      const old = Number(p.oldPrice) > Number(p.price) ? Number(p.oldPrice) : 0
      return [
        p.id,
        title,
        desc,
        p.available === false ? 'out of stock' : 'in stock',
        'new',
        `${old || Number(p.price)} ${currency}`,
        old ? `${Number(p.price)} ${currency}` : '',
        `${String(base).replace(/\/+$/, '')}/#/p/${encodeURIComponent(p.id)}`,
        p.images[0],
        p.images.slice(1, 10).join(','),
        settings?.nameEn || settings?.name || '',
        p.category || '',
      ]
        .map(csvCell)
        .join(',')
    })
  return [head.join(','), ...rows].join('\n') + '\n'
}
async function writeFbFeed(priv, cat, headers) {
  const repo = ghRepoOf(priv)
  if (!repo) return
  const csv = fbCatalogCsv(cat.products || [], cat.settings || {}, storeBase(priv), CUR_ISO[String(cat.settings?.currency || '').trim()] || 'ILS')
  const content = b64(csv)
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${FEED_PATH}`
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1500 + Math.random() * 1500)
    const cur = await fetch(`${url}?ref=img&t=${Date.now()}`, { headers: { ...headers, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
    const j = cur.ok ? await cur.json() : null
    if (j && String(j.content || '').replace(/\n/g, '') === content) return
    const r = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ message: 'كتالوج فيسبوك', content, branch: 'img', ...(j?.sha ? { sha: j.sha } : {}) }),
      signal: AbortSignal.timeout(60_000),
    })
    if (r.ok || ![409, 422, 500, 502, 503].includes(r.status)) return
  }
}

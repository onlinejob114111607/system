// ============================================================
//  النشر على فيسبوك وإنستغرام عن طريق Meta Graph API
//  - منشور صفحة فيسبوك (صورة أو ألبوم) + قصة صفحة فيسبوك
//  - منشور إنستغرام (صورة أو كاروسيل) + قصة إنستغرام
//  التوكن: «توكن الصفحة» (Page access token) محفوظ باللوحة ← store/settings.metaToken
// ============================================================

const BASE = 'https://graph.facebook.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isJpg = (u) => /\.jpe?g(\?|#|$)/i.test(String(u || '')) || !/\.(png|webp|gif)(\?|#|$)/i.test(String(u || ''))

export function createMeta({ token, pageId, igId = '', version = '' }) {
  if (!token) throw new Error('ما في توكن Meta — حطه باللوحة ← المتجر ← منشورات اليوم')
  if (!pageId) throw new Error('ما في رقم صفحة الفيسبوك (Page ID)')
  const root = version ? `${BASE}/${version}` : BASE

  async function call(path, params = {}, method = 'POST') {
    const body = new URLSearchParams({ ...params, access_token: token })
    const url = method === 'GET' ? `${root}/${path}?${body}` : `${root}/${path}`
    const r = await fetch(url, { method, ...(method === 'GET' ? {} : { body }), signal: AbortSignal.timeout(90_000) })
    const j = await r.json().catch(() => ({}))
    if (j.error) throw new Error(explain(j.error))
    if (!r.ok) throw new Error(`Meta HTTP ${r.status}`)
    return j
  }

  // ---------- معلومات الصفحة وحساب الإنستغرام المربوط ----------
  async function info() {
    const p = await call(pageId, { fields: 'name,instagram_business_account{id,username}' }, 'GET')
    return { pageName: p.name, igId: p.instagram_business_account?.id || '', igUsername: p.instagram_business_account?.username || '' }
  }
  let ig = igId
  async function igUser() {
    if (ig) return ig
    const i = await info()
    if (!i.igId) throw new Error('صفحة الفيسبوك مش مربوطة بحساب إنستغرام بزنس/كريتور')
    ig = i.igId
    return ig
  }

  // ---------- فيسبوك ----------
  const uploadFbPhoto = async (url) => (await call(`${pageId}/photos`, { url, published: 'false' })).id

  async function fbPost(photos, message) {
    const list = photos.slice(0, 10)
    if (!list.length) throw new Error('ما في صور')
    const ids = []
    for (const u of list) ids.push(await uploadFbPhoto(u))
    const params = { message }
    ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })))
    const r = await call(`${pageId}/feed`, params)
    return r.id
  }

  async function fbStory(photo) {
    const id = await uploadFbPhoto(photo)
    const r = await call(`${pageId}/photo_stories`, { photo_id: id })
    return r.post_id || r.id || id
  }

  // ---------- إنستغرام ----------
  async function waitReady(containerId) {
    for (let i = 0; i < 20; i++) {
      const s = await call(containerId, { fields: 'status_code,status' }, 'GET')
      if (s.status_code === 'FINISHED') return
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`إنستغرام رفض الصورة (${s.status || s.status_code})`)
      await sleep(3000)
    }
    throw new Error('إنستغرام طوّل بتجهيز المنشور')
  }
  async function publishIg(user, creationId) {
    await waitReady(creationId)
    return (await call(`${user}/media_publish`, { creation_id: creationId })).id
  }

  async function igPost(photos, caption) {
    const user = await igUser()
    const list = photos.filter(isJpg).slice(0, 10)
    if (!list.length) throw new Error('إنستغرام بيقبل صور JPG بس')
    let creation
    if (list.length === 1) {
      creation = (await call(`${user}/media`, { image_url: list[0], caption })).id
    } else {
      const children = []
      for (const u of list) children.push((await call(`${user}/media`, { image_url: u, is_carousel_item: 'true' })).id)
      for (const c of children) await waitReady(c)
      creation = (await call(`${user}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })).id
    }
    return publishIg(user, creation)
  }

  async function igStory(photo) {
    const user = await igUser()
    if (!isJpg(photo)) throw new Error('إنستغرام بيقبل صور JPG بس')
    const creation = (await call(`${user}/media`, { image_url: photo, media_type: 'STORIES' })).id
    return publishIg(user, creation)
  }

  return { info, fbPost, fbStory, igPost, igStory }
}

// رسائل أخطاء Meta بالعربي (الأشيع)
function explain(e) {
  const code = Number(e.code)
  const msg = String(e.error_user_msg || e.message || 'خطأ من Meta')
  if (code === 190) return `التوكن منتهي أو غلط — اعمل توكن جديد وحطه باللوحة (${msg})`
  if (code === 10 || code === 200 || code === 3) return `ناقص صلاحيات بالتوكن (pages_manage_posts / instagram_content_publish) — ${msg}`
  if (code === 4 || code === 17 || code === 32 || code === 613) return `Meta موقّف الطلبات مؤقتاً (حد الاستخدام) — بيرجع يحاول لحاله (${msg})`
  if (code === 9004 || code === 36003) return `الصورة ما انقرت من الرابط أو مقاسها مش مقبول — ${msg}`
  return msg
}

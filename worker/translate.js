// ترجمة تلقائية مجانية (Google Translate) — بيستعملها المتجر واستيراد تيليجرام
// بتترجم مجموعة نصوص مع بعض وبترجعهم بنفس الترتيب
export async function translateTexts(texts, to = 'en', from = 'ar') {
  const SEP = '\n⁂\n'
  const out = []
  // دفعات صغيرة عشان ما نتعدى طول الرابط
  let batch = []
  let len = 0
  const flush = async () => {
    if (!batch.length) return
    const q = batch.map((t) => String(t || '').replace(/⁂/g, '')).join(SEP)
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(q)}`
    const one = async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`الترجمة رجعت ${r.status}`)
      const j = await r.json()
      return (j?.[0] || []).map((x) => x?.[0] || '').join('')
    }
    let parts = (await one(url)).split(/\s*⁂\s*/)
    if (parts.length !== batch.length) {
      // الفاصل ضاع ← بنترجم كل نص لحاله
      parts = []
      for (const t of batch) parts.push(String(t || '').trim() ? await one(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(t)}`) : '')
    }
    out.push(...parts.map((x, i) => (String(batch[i] || '').trim() ? x.trim() : '')))
    batch = []
    len = 0
  }
  for (const t of texts) {
    const n = encodeURIComponent(String(t || '')).length
    if (len + n > 4500) await flush()
    batch.push(t)
    len += n + 20
  }
  await flush()
  return out
}


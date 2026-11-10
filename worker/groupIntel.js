// ============================================================
//  ذكاء المجموعات: بلد الأعضاء + تصنيف تلقائي من الاسم
//  (نفس الملف منسوخ باللوحة: web/src/groupIntel.js)
// ============================================================

export const REGIONS = {
  ps: '🇵🇸 فلسطين والداخل',
  eg: '🇪🇬 مصر',
  jo: '🇯🇴 الأردن',
  gulf: 'الخليج',
  other: 'دول تانية',
  mixed: 'مختلطة',
}
const PREFIX = [
  ['970', 'ps'],
  ['972', 'ps'],
  ['962', 'jo'],
  ['966', 'gulf'],
  ['971', 'gulf'],
  ['974', 'gulf'],
  ['965', 'gulf'],
  ['973', 'gulf'],
  ['968', 'gulf'],
  ['20', 'eg'],
]

// رقم العضو (لو واتساب مخبيه بـ lid بنتجاهله)
export function phoneOf(p) {
  const list = typeof p === 'string' ? [p] : [p?.phoneNumber, p?.jid, p?.id, p?.pn]
  for (const x of list) {
    const s = String(x || '')
    if (s.endsWith('@s.whatsapp.net')) return s.split('@')[0].split(':')[0]
  }
  return ''
}
const regionOfPhone = (num) => {
  for (const [pre, r] of PREFIX) if (num.startsWith(pre)) return r
  return num ? 'other' : ''
}

// بلد المجموعة من أرقام أعضائها: أكتر من 50% من بلد واحد ← هي، غير هيك مختلطة
export function regionOf(participants = []) {
  const counts = {}
  let known = 0
  for (const p of participants || []) {
    const r = regionOfPhone(phoneOf(p))
    if (!r) continue
    counts[r] = (counts[r] || 0) + 1
    known++
  }
  if (known < 5) return { region: null, regionPct: null, regionKnown: known }
  const pct = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / known) * 100)]))
  const [top, topPct] = Object.entries(pct).sort((a, b) => b[1] - a[1])[0]
  return { region: topPct >= 50 ? top : 'mixed', regionPct: pct, regionKnown: known }
}

// ---------- تصنيف من اسم المجموعة ----------
const norm = (s) =>
  String(s || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
export const AUTO_CATS = [
  ['عمل أونلاين', /(اونلاين|اون لاين|online|من البيت|من المنزل|عمل حر|فريلانس|freelanc|ربح من|الربح|تسويق الكتروني|تسويق شبكي|دخل اضافي|عمل عن بعد)/],
  ['وظائف', /(وظائف|وظيفه|توظيف|فرص عمل|فرصه عمل|شواغر|عمال|شغل|jobs?\b|مطلوب موظف)/],
  ['بيع وشراء', /(بيع|شراء|سوق|حراج|عروض|تسوق|بضاعه|مستعمل|بازار|اغراض|تخفيضات|ملابس|عطور|اكسسوار|متجر|shop|market|sale)/],
  ['طلاب', /(طلاب|طالبات|جامعه|جامعي|توجيهي|تخصص|كليه|دراسه|محاضرات|students?|university)/],
  ['نسائي', /(بنات|صبايا|نساء|سيدات|ستات|امهات|نسائي|ladies|women)/],
]
export function autoCategory(name) {
  const t = norm(name)
  if (!t) return null
  for (const [cat, re] of AUTO_CATS) if (re.test(t)) return cat
  return null
}
// أسماء بتدل إنها مجموعة فلسطينية (أولوية الانضمام)
export const PS_NAME_RE = /(فلسطين|الضفه|الضفة|القدس|رام الله|نابلس|الخليل|جنين|طولكرم|قلقيليه|قلقيلية|بيت لحم|اريحا|أريحا|سلفيت|طوباس|الداخل|ام الفحم|أم الفحم|الناصره|الناصرة|عكا|حيفا|يافا|اللد|الرمله|الرملة|رهط|النقب|الطيبه|الطيبة|سخنين|palestin)/i

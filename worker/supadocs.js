// ============================================================
//  مخزن المستندات فوق Supabase (بديل Firestore) — ملف مشترك
//  نفس الملف بالعامل (worker/supadocs.js) وباللوحة (src/supa/docstore.js)
//  الجدول: docs(col, id, data jsonb, updated_at) — والكتابة عن طريق الدالة doc_write
// ============================================================

// ---------- الوقت ----------
export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = seconds
    this.nanoseconds = nanoseconds
  }
  static fromMillis(ms) {
    const s = Math.floor(ms / 1000)
    return new Timestamp(s, Math.round((ms - s * 1000) * 1e6))
  }
  static fromDate(d) {
    return Timestamp.fromMillis(d.getTime())
  }
  static now() {
    return Timestamp.fromMillis(Date.now())
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)
  }
  toDate() {
    return new Date(this.toMillis())
  }
  isEqual(o) {
    return o instanceof Timestamp && o.toMillis() === this.toMillis()
  }
  valueOf() {
    return String(this.toMillis()).padStart(15, '0')
  }
  toJSON() {
    return { __ts: this.toMillis() }
  }
}

// ---------- عمليات خاصة (بتتنفذ بالسيرفر) ----------
export class Sentinel {
  constructor(op) {
    this.op = op
  }
  toJSON() {
    return this.op
  }
}
export const OPS = {
  now: () => new Sentinel({ __op: 'now' }),
  inc: (n) => new Sentinel({ __op: 'inc', n: Number(n) || 0 }),
  union: (...v) => new Sentinel({ __op: 'union', v: v.map(encode) }),
  remove: (...v) => new Sentinel({ __op: 'remove', v: v.map(encode) }),
  del: () => new Sentinel({ __op: 'del' }),
}

// قيمة JS ← JSON للتخزين
export function encode(v) {
  if (v === undefined) return undefined
  if (v === null) return null
  if (v instanceof Sentinel) return v.op
  if (v instanceof Timestamp) return { __ts: v.toMillis() }
  if (v instanceof Date) return { __ts: v.getTime() }
  if (typeof v?.toMillis === 'function' && typeof v?.seconds === 'number') return { __ts: v.toMillis() } // Timestamp من مكتبة تانية
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x)))
  if (typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      const e = encode(x)
      if (e !== undefined) out[k] = e
    }
    return out
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v
}

// JSON المخزّن ← قيمة JS (الأوقات بترجع Timestamp)
export function decode(v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(decode)
  const keys = Object.keys(v)
  if (keys.length === 1 && keys[0] === '__ts' && typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts)
  const out = {}
  for (const k of keys) out[k] = decode(v[k])
  return out
}

export function getField(data, field) {
  let cur = data
  for (const p of String(field).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export function autoId() {
  let s = ''
  const r = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(20)) : null
  for (let i = 0; i < 20; i++) s += AUTO[(r ? r[i] : Math.floor(Math.random() * 256)) % AUTO.length]
  return s
}

// ---------- أخطاء ----------
const CODES = ['permission-denied', 'not-found', 'already-exists', 'aborted', 'invalid-argument']
export class StoreError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}
function toStoreError(e) {
  const msg = String(e?.message || e || '')
  const code = CODES.find((c) => msg.includes(c))
  if (code) return new StoreError(code, msg)
  if (/JWT|permission|not allowed|row-level/i.test(msg)) return new StoreError('permission-denied', msg)
  return new StoreError('unavailable', msg)
}

// ---------- ترجمة الفلاتر ----------
const jsonPath = (field) => {
  const parts = String(field).split('.').map((p) => p.replace(/[^\w\u0600-\u06FF-]/g, ''))
  return { json: 'data->' + parts.join('->'), text: parts.length > 1 ? 'data->' + parts.slice(0, -1).join('->') + '->>' + parts.at(-1) : 'data->>' + parts[0] }
}
const isTs = (v) => v instanceof Timestamp || v instanceof Date || (typeof v?.toMillis === 'function' && typeof v?.seconds === 'number')
const tsMs = (v) => (v instanceof Date ? v.getTime() : v.toMillis())
const OPMAP = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' }
const pgList = (arr) => `(${arr.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')})`

function applyFilter(q, [field, op, value]) {
  const p = jsonPath(field)
  if (op === 'in' || op === 'not-in') {
    const list = (value || []).map((x) => (isTs(x) ? tsMs(x) : x))
    if (!list.length) return op === 'in' ? q.eq('col', '__never__') : q
    return op === 'in' ? q.filter(p.text, 'in', pgList(list)) : q.not(p.text, 'in', pgList(list))
  }
  if (op === 'array-contains') return q.filter(p.json, 'cs', JSON.stringify([encode(value)]))
  if (op === 'array-contains-any') {
    const ors = (value || []).map((x) => `${p.json}.cs.${JSON.stringify([encode(x)])}`)
    return ors.length ? q.or(ors.join(',')) : q.eq('col', '__never__')
  }
  const pg = OPMAP[op]
  if (!pg) throw new StoreError('invalid-argument', `فلتر غير مدعوم: ${op}`)
  if (value === null) return op === '==' ? q.filter(p.text, 'is', null) : q.not(p.text, 'is', null)
  if (isTs(value)) return q.filter(`${p.json}->__ts`, pg, tsMs(value))
  if (typeof value === 'string') return q.filter(p.text, pg, value)
  return q.filter(p.json, pg, JSON.stringify(value))
}

// ---------- المخزن ----------
export function createStore(supabase, { pageSize = 1000, debounceMs = 250, resyncMs = 120_000 } = {}) {
  const rowOut = (r) => ({ id: r.id, data: decode(r.data), updatedAt: r.updated_at })

  async function getDoc(col, id) {
    const { data, error } = await supabase.from('docs').select('id,data,updated_at').eq('col', col).eq('id', id).maybeSingle()
    if (error) throw toStoreError(error)
    return data ? rowOut(data) : null
  }

  function build(col, spec, head = false) {
    let q = supabase.from('docs').select('id,data,updated_at', head ? { count: 'exact', head: true } : undefined).eq('col', col)
    for (const f of spec.filters || []) q = applyFilter(q, f)
    if (head) return q
    for (const [field, dir] of spec.orders || []) q = q.order(field === '__name__' ? 'id' : jsonPath(field).json, { ascending: dir !== 'desc', nullsFirst: false })
    return q.order('id', { ascending: true })
  }

  async function query(col, spec = {}) {
    const lim = spec.limit ?? Infinity
    const out = []
    for (let from = 0; out.length < lim; from += pageSize) {
      const size = Math.min(pageSize, lim - out.length)
      const { data, error } = await build(col, spec).range(from, from + size - 1)
      if (error) throw toStoreError(error)
      out.push(...data.map(rowOut))
      if (data.length < size) break
    }
    return out
  }

  async function count(col, spec = {}) {
    const { count: n, error } = await build(col, spec, true)
    if (error) throw toStoreError(error)
    return n || 0
  }

  // ops: [{t, col, id, data, expect}]
  async function write(ops) {
    if (!ops.length) return []
    const body = { ops: ops.map((o) => ({ ...o, data: o.data === undefined ? undefined : encode(o.data) })) }
    const { data, error } = await supabase.rpc('doc_write', { p: body })
    if (error) throw toStoreError(error)
    return (data || []).map((d) => (d ? decode(d) : d))
  }

  // ---------- التحديث المباشر: قناة وحدة لكل مجموعة ----------
  const channels = new Map() // col -> { ch, listeners:Set }
  function subscribe(col, onEvent) {
    let c = channels.get(col)
    if (!c) {
      const listeners = new Set()
      const ch = supabase
        .channel(`docs:${col}:${autoId().slice(0, 6)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: `col=eq.${col}` }, (p) => {
          const id = p.new?.id ?? p.old?.id
          for (const l of listeners) l({ type: p.eventType, id })
        })
        .subscribe((status) => {
          // رجع الاتصال ← بنعيد القراءة عشان ما يفوتنا إشي
          if (status === 'SUBSCRIBED') for (const l of listeners) l({ type: 'RESYNC' })
        })
      c = { ch, listeners }
      channels.set(col, c)
    }
    c.listeners.add(onEvent)
    return () => {
      c.listeners.delete(onEvent)
      if (!c.listeners.size) {
        supabase.removeChannel(c.ch)
        channels.delete(col)
      }
    }
  }

  // مستمع على استعلام: بيرجع اللقطة كاملة + التغييرات (added/modified/removed)
  function watchQuery(col, spec, onNext, onError) {
    let prev = new Map()
    let initial = true
    let timer = null
    let alive = true
    let running = false
    let again = false
    const run = async () => {
      if (!alive) return
      if (running) {
        again = true
        return
      }
      running = true
      try {
        const rows = await query(col, spec)
        if (!alive) return
        const next = new Map(rows.map((r) => [r.id, r]))
        const changes = []
        rows.forEach((r, i) => {
          const old = prev.get(r.id)
          if (!old) changes.push({ type: 'added', row: r, newIndex: i, oldIndex: -1 })
          else if (old.updatedAt !== r.updatedAt) changes.push({ type: 'modified', row: r, newIndex: i, oldIndex: -1 })
        })
        for (const [id, r] of prev) if (!next.has(id)) changes.push({ type: 'removed', row: r, newIndex: -1, oldIndex: 0 })
        prev = next
        if (changes.length || initial) onNext({ rows, changes })
        initial = false
      } catch (e) {
        onError?.(e)
      } finally {
        running = false
        if (again) {
          again = false
          run()
        }
      }
    }
    const kick = () => {
      clearTimeout(timer)
      timer = setTimeout(run, debounceMs)
    }
    const unsub = subscribe(col, kick)
    const resync = resyncMs ? setInterval(run, resyncMs) : null
    run()
    return () => {
      alive = false
      clearTimeout(timer)
      if (resync) clearInterval(resync)
      unsub()
    }
  }

  function watchDoc(col, id, onNext, onError) {
    let alive = true
    let last
    const run = async () => {
      try {
        const r = await getDoc(col, id)
        if (!alive) return
        const sig = r ? r.updatedAt : null
        if (last === undefined || sig !== last) {
          last = sig
          onNext(r)
        }
      } catch (e) {
        onError?.(e)
      }
    }
    const unsub = subscribe(col, (ev) => (ev.type === 'RESYNC' || ev.id === id) && run())
    const resync = resyncMs ? setInterval(run, resyncMs) : null
    run()
    return () => {
      alive = false
      if (resync) clearInterval(resync)
      unsub()
    }
  }

  return { getDoc, query, count, write, subscribe, watchQuery, watchDoc }
}

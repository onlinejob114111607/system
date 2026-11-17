// ============================================================
//  واجهة شبيهة بـ firebase-admin/firestore فوق Supabase (للعمّال)
//  db.collection('x').where(...).orderBy(...).limit(n).get() / onSnapshot
//  db.doc('a/b').get() / set / update / delete / create
//  db.batch()، db.runTransaction()، FieldValue، Timestamp
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { createStore, OPS, Timestamp, autoId, getField, StoreError } from './supadocs.js'

export { Timestamp }

// أكواد أخطاء firebase-admin (الكود القديم بيفحص e.code === 5 مثلاً)
const NUM = { 'not-found': 5, 'already-exists': 6, 'permission-denied': 7, aborted: 10, 'invalid-argument': 3, unavailable: 14 }
const adminErr = (e) => {
  if (e instanceof StoreError) {
    const x = new Error(e.message)
    x.code = NUM[e.code] ?? 2
    x.details = e.code
    return x
  }
  return e
}
const wrap = async (fn) => {
  try {
    return await fn()
  } catch (e) {
    throw adminErr(e)
  }
}

export const FieldValue = {
  serverTimestamp: OPS.now,
  increment: OPS.inc,
  arrayUnion: OPS.union,
  arrayRemove: OPS.remove,
  delete: OPS.del,
}

const splitPath = (p) => String(p).split('/').filter(Boolean)

export function createAdminDb({ url, serviceKey, transport } = {}) {
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: transport ? { transport } : undefined,
  })
  const store = createStore(supabase)

  // ---------- اللقطات ----------
  class DocumentSnapshot {
    constructor(ref, row) {
      this.ref = ref
      this.id = ref.id
      this._data = row ? row.data : undefined
      this.exists = !!row
      this._updatedAt = row?.updatedAt ?? null
      this.updateTime = row ? Timestamp.fromDate(new Date(row.updatedAt)) : undefined
    }
    data() {
      return this._data === undefined ? undefined : { ...this._data }
    }
    get(field) {
      return this._data === undefined ? undefined : getField(this._data, field)
    }
  }
  class QuerySnapshot {
    constructor(colRef, rows, changes = null) {
      this._colRef = colRef
      this.docs = rows.map((r) => new DocumentSnapshot(colRef.doc(r.id), r))
      this.size = this.docs.length
      this.empty = this.size === 0
      this._changes = changes
    }
    forEach(fn) {
      this.docs.forEach(fn)
    }
    docChanges() {
      if (!this._changes) return this.docs.map((d, i) => ({ type: 'added', doc: d, newIndex: i, oldIndex: -1 }))
      return this._changes.map((c) => ({ type: c.type, doc: new DocumentSnapshot(this._colRef.doc(c.row.id), c.row), newIndex: c.newIndex, oldIndex: c.oldIndex }))
    }
  }

  // ---------- الاستعلام ----------
  class Query {
    constructor(colPath, spec = {}) {
      this._col = colPath
      this._spec = { filters: [], orders: [], ...spec }
    }
    get _colRef() {
      return new CollectionReference(this._col)
    }
    where(field, op, value) {
      return new Query(this._col, { ...this._spec, filters: [...this._spec.filters, [String(field), op, value]] })
    }
    orderBy(field, dir = 'asc') {
      return new Query(this._col, { ...this._spec, orders: [...this._spec.orders, [String(field), dir]] })
    }
    limit(n) {
      return new Query(this._col, { ...this._spec, limit: n })
    }
    select() {
      return this // بنرجع المستند كامل (القراءات مش محدودة)
    }
    async get() {
      const rows = await wrap(() => store.query(this._col, this._spec))
      return new QuerySnapshot(this._colRef, rows)
    }
    count() {
      return {
        get: () =>
          wrap(async () => {
            const n = await store.count(this._col, this._spec)
            return { data: () => ({ count: n }) }
          }),
      }
    }
    onSnapshot(onNext, onError) {
      const colRef = this._colRef
      return store.watchQuery(
        this._col,
        this._spec,
        ({ rows, changes }) => {
          onNext(new QuerySnapshot(colRef, rows, changes))
        },
        (e) => onError?.(adminErr(e)),
      )
    }
  }

  class CollectionReference extends Query {
    constructor(path) {
      super(path)
      this.path = path
      this.id = splitPath(path).at(-1)
    }
    get parent() {
      const seg = splitPath(this.path)
      return seg.length > 1 ? new DocumentReference(seg.slice(0, -1).join('/')) : null
    }
    doc(id) {
      return new DocumentReference(`${this.path}/${id || autoId()}`)
    }
    async add(data) {
      const ref = this.doc()
      await ref.set(data)
      return ref
    }
  }

  class DocumentReference {
    constructor(path) {
      const seg = splitPath(path)
      this.path = seg.join('/')
      this.id = seg.at(-1)
      this._col = seg.slice(0, -1).join('/')
    }
    get parent() {
      return new CollectionReference(this._col)
    }
    collection(sub) {
      return new CollectionReference(`${this.path}/${sub}`)
    }
    async get() {
      const row = await wrap(() => store.getDoc(this._col, this.id))
      return new DocumentSnapshot(this, row)
    }
    set(data, opts = {}) {
      return wrap(() => store.write([{ t: opts.merge || opts.mergeFields ? 'merge' : 'set', col: this._col, id: this.id, data }]))
    }
    update(data, ...rest) {
      if (typeof data === 'string') {
        const obj = { [data]: rest[0] }
        for (let i = 1; i + 1 < rest.length; i += 2) obj[rest[i]] = rest[i + 1]
        data = obj
      }
      return wrap(() => store.write([{ t: 'update', col: this._col, id: this.id, data }]))
    }
    create(data) {
      return wrap(() => store.write([{ t: 'create', col: this._col, id: this.id, data }]))
    }
    delete() {
      return wrap(() => store.write([{ t: 'delete', col: this._col, id: this.id }]))
    }
    onSnapshot(onNext, onError) {
      return store.watchDoc(this._col, this.id, (row) => onNext(new DocumentSnapshot(this, row)), (e) => onError?.(adminErr(e)))
    }
  }

  // ---------- دفعات ومعاملات ----------
  const opOf = (t, ref, data) => ({ t, col: ref._col, id: ref.id, data })
  class WriteBatch {
    constructor() {
      this.ops = []
    }
    set(ref, data, opts = {}) {
      this.ops.push(opOf(opts.merge ? 'merge' : 'set', ref, data))
      return this
    }
    update(ref, data) {
      this.ops.push(opOf('update', ref, data))
      return this
    }
    create(ref, data) {
      this.ops.push(opOf('create', ref, data))
      return this
    }
    delete(ref) {
      this.ops.push({ t: 'delete', col: ref._col, id: ref.id })
      return this
    }
    async commit() {
      // الدفعات الكبيرة بتنقسم (حد الطلب)
      for (let i = 0; i < this.ops.length; i += 400) await wrap(() => store.write(this.ops.slice(i, i + 400)))
    }
  }

  async function runTransaction(fn, { maxAttempts = 6 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const reads = new Map() // path -> {exists, updatedAt}
      const b = new WriteBatch()
      const t = {
        async get(refOrQuery) {
          if (refOrQuery instanceof DocumentReference) {
            const s = await refOrQuery.get()
            reads.set(refOrQuery.path, { exists: s.exists, updated_at: s._updatedAt })
            return s
          }
          return refOrQuery.get()
        },
        set: (r, d, o) => (b.set(r, d, o), t),
        update: (r, d) => (b.update(r, d), t),
        create: (r, d) => (b.create(r, d), t),
        delete: (r) => (b.delete(r), t),
      }
      const result = await fn(t)
      // شرط: المستندات اللي قريناها ما تغيّرت لحد الكتابة
      const ops = b.ops.map((o) => {
        const r = reads.get(`${o.col}/${o.id}`)
        return r ? { ...o, expect: r.exists ? { exists: true, updated_at: r.updated_at } : { exists: false } } : o
      })
      try {
        if (ops.length) await store.write(ops)
        return result
      } catch (e) {
        if (e?.code === 'aborted' && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 100 * attempt + Math.random() * 200))
          continue
        }
        throw adminErr(e)
      }
    }
  }

  const db = {
    collection: (p) => new CollectionReference(splitPath(p).join('/')),
    doc: (p) => new DocumentReference(p),
    batch: () => new WriteBatch(),
    runTransaction,
    supabase,
    store,
  }
  return db
}

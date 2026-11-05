// ============================================================
//  المتجر: تنبيه الطلبات الجديدة + رسالة تأكيد الطلب على الواتساب
//  اللوحة بتحط الطلب "confirm_queued" مع نص الرسالة ← العامل بيبعتها
//  ← الزبون بيرد "تم" ← الطلب بيصير "مؤكد" لحاله
// ============================================================
import { db, FieldValue, Timestamp, sleep, listen } from './common.js'
import { classify, readMessage } from './funnel.js'
import { mergeFunnel } from './funnelDefaults.js'
import { translateTexts } from './translate.js'
export { translateTexts }

const ordersCol = db.collection('orders')
const settingsRef = db.doc('store/settings')
const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const isUserJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''))
const tsOf = (msg) => Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000
const money = (n) => String(Math.round((Number(n) || 0) * 100) / 100)
const trackCol = db.collection('order_track')
// نسخة تتبع الطلب للزبون (بدون اسم أو عنوان)
export function trackData(id, o, status = o.status) {
  return {
    orderId: id,
    status,
    p4: String(o.phone1 || '').replace(/\D/g, '').slice(-4),
    items: (o.items || []).slice(0, 30).map((it) => ({ name: String(it.name || '').slice(0, 120), qty: Number(it.qty) || 1, option: String(it.option || '').slice(0, 80) })),
    total: Number(o.total) || 0,
    regionName: o.regionName || '',
  }
}
const syncTrack = (id, o, status) => (o?.code ? trackCol.doc(o.code).set({ ...trackData(id, o, status), updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {}) : null)

export function createStore({ accounts, settings, log, event, notifier }) {
  let cfg = {}
  const base = mergeFunnel(null) // كلمات القبول والرفض
  const words = {
    acceptWords: [...base.acceptWords, 'מאשר', 'מאשרת', 'כן', 'בסדר', 'אוקי', 'אוקיי', 'סגור', 'מעולה', 'בטח', 'yes', 'ok'],
    rejectWords: [...base.rejectWords, 'לא', 'בטל', 'ביטול', 'לא מעוניין', 'לא מעוניינת', 'לבטל'],
  }
  const orders = new Map() // id -> order (confirm_queued / awaiting)
  const byPhone = new Map() // phone -> id (awaiting)
  const lidToPhone = new Map()
  const queue = []
  const inQueue = new Set()
  const buffers = new Map()
  let pumping = false

  function account(o) {
    const id = o?.confirm?.accountId || cfg.confirmAccountId || settings.app.welcomeAccountId
    const a = id ? accounts.get(id) : [...accounts.values()].find((x) => x.connected)
    return a && a.connected && a.sock ? a : null
  }

  function enqueue(id) {
    if (inQueue.has(id)) return
    inQueue.add(id)
    queue.push(id)
    pump()
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length) {
        const id = queue[0]
        const o = orders.get(id)
        if (!o || o.status !== 'confirm_queued') {
          queue.shift()
          inQueue.delete(id)
          continue
        }
        const acc = account(o)
        if (!acc) return // بيرجع يحاول من المؤقت
        queue.shift()
        inQueue.delete(id)
        await sendConfirm(acc, id, o)
        await sleep(20_000)
      }
    } finally {
      pumping = false
    }
  }

  async function sendConfirm(acc, id, o) {
    const ref = ordersCol.doc(id)
    const text = String(o.confirm?.text || '').trim()
    if (!text) {
      await ref.update({ status: 'new', 'confirm.error': 'نص الرسالة فاضي' }).catch(() => {})
      return
    }
    try {
      let jid = null
      let used = null
      for (const p of [o.phone1, o.phone2].filter(Boolean)) {
        const [r] = (await acc.sock.onWhatsApp(p)) || []
        if (r?.exists) {
          jid = r.jid
          used = p
          break
        }
      }
      if (!jid) {
        await ref.update({ status: 'new', 'confirm.error': 'الرقم مش موجود على واتساب' })
        acc.log(`❌ تأكيد طلب #${o.code}: الرقم مش على واتساب`)
        return
      }
      try {
        await acc.sock.sendPresenceUpdate('composing', jid)
        await sleep(3000)
        await acc.sock.sendPresenceUpdate('paused', jid)
      } catch {}
      await acc.sock.sendMessage(jid, { text })
      acc.countSent?.()
      await ref.update({
        status: 'awaiting',
        'confirm.sentAt': Timestamp.now(),
        'confirm.phone': used,
        'confirm.by': acc.label,
        'confirm.error': null,
        attention: false,
      })
      syncTrack(id, o, 'awaiting')
      acc.log(`📦 رسالة تأكيد للطلب #${o.code} (${o.name})`)
    } catch (e) {
      await ref.update({ status: 'new', 'confirm.error': e.message }).catch(() => {})
      acc.log(`❌ تأكيد طلب #${o.code}:`, e.message)
    }
  }

  // ---------- ردود الزبائن ----------
  async function phoneOf(acc, key) {
    const jid = key.remoteJid
    if (jid.endsWith('@s.whatsapp.net')) return digits(jid)
    if (key.remoteJidAlt?.endsWith('@s.whatsapp.net')) {
      const p = digits(key.remoteJidAlt)
      lidToPhone.set(digits(jid), p)
      return p
    }
    const known = lidToPhone.get(digits(jid))
    if (known) return known
    try {
      const pn = await acc.sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
      if (pn) {
        const p = digits(pn)
        lidToPhone.set(digits(jid), p)
        return p
      }
    } catch {}
    return null
  }

  async function onUpsert(acc, { messages }) {
    if (!byPhone.size) return
    for (const msg of messages || []) {
      try {
        const key = msg.key || {}
        if (key.fromMe || !isUserJid(key.remoteJid)) continue
        if (tsOf(msg) && Date.now() - tsOf(msg) > 10 * 60_000) continue
        const phone = await phoneOf(acc, key)
        const id = phone && byPhone.get(phone)
        if (!id) continue
        const r = readMessage(msg)
        if (r.empty) continue
        let b = buffers.get(id)
        if (!b) buffers.set(id, (b = { items: [], timer: null }))
        b.items.push(r)
        clearTimeout(b.timer)
        b.timer = setTimeout(() => {
          buffers.delete(id)
          evaluate(id, b.items).catch((e) => log('⚠️ رد على تأكيد طلب:', e.message))
        }, 6000)
      } catch (e) {
        log('⚠️ رسالة واردة (المتجر):', e.message)
      }
    }
  }

  async function evaluate(id, items) {
    const o = orders.get(id)
    if (!o || o.status !== 'awaiting') return
    const text = items.map((x) => x.text).filter(Boolean).join('\n')
    const label = text || (items.some((x) => x.image) ? '[صورة]' : items.some((x) => x.audio) ? '[رسالة صوتية]' : '[وسائط]')
    const replies = [...(o.replies || []), { t: label.slice(0, 500), at: Date.now() }].slice(-20)
    const intent = classify(text, words.acceptWords, words.rejectWords)
    const ref = ordersCol.doc(id)
    if (intent === 'accept') {
      await ref.update({ status: 'confirmed', confirmedAt: Timestamp.now(), replies, attention: false })
      syncTrack(id, o, 'confirmed')
      event('ok', `✅ الزبون أكّد الطلب #${o.code} (${o.name})`)
      notifier.notify('orders', `✅ الزبون أكّد الطلب #${o.code}\n${o.name} — ${money(o.total)} ₪`)
      return
    }
    await ref.update({ replies, attention: true, lastReply: label.slice(0, 300) })
    notifier.notify('orders', `🙋 رد على تأكيد الطلب #${o.code} محتاج ردك\n${o.name}: ${label.slice(0, 300)}`, { key: `ord_${id}`, cooldownMs: 10 * 60_000 })
  }

  // ---------- التشغيل ----------
  function start() {
    listen(settingsRef, (d) => (cfg = d.data() || {}), (e) => log('⚠️ إعدادات المتجر:', e.message))

    listen(
      ordersCol.where('status', 'in', ['confirm_queued', 'awaiting']),
      (s) => {
        orders.clear()
        byPhone.clear()
        for (const d of s.docs) {
          const o = d.data()
          orders.set(d.id, o)
          if (o.status === 'awaiting') for (const p of [o.phone1, o.phone2, o.confirm?.phone].filter(Boolean)) byPhone.set(String(p), d.id)
          if (o.status === 'confirm_queued') enqueue(d.id)
        }
      },
      (e) => log('⚠️ مستمع الطلبات:', e.message),
    )

    // تنبيه تيليجرام بكل طلب جديد
    const since = Timestamp.now()
    const seen = new Set()
    listen(
      ordersCol.where('createdAt', '>', since),
      (s) => {
        for (const ch of s.docChanges()) {
          if (ch.type !== 'added' || seen.has(ch.doc.id)) continue
          seen.add(ch.doc.id)
          const o = ch.doc.data()
          syncTrack(ch.doc.id, o, o.status || 'new')
          const items = (o.items || []).map((it) => `▫️ ${it.name}${it.option ? ` (${it.option})` : ''}${it.qty > 1 ? ` × ${it.qty}` : ''}`).join('\n')
          notifier.notify('orders', `🛒 طلب جديد #${o.code}\n${o.name} — ${o.city} (${o.regionName})\n${items}\nالمجموع: ${money(o.total)} ₪`)
        }
      },
      (e) => log('⚠️ مراقبة الطلبات الجديدة:', e.message),
    )

    setInterval(() => queue.length && pump(), 30_000)
  }

  // ---------- أوامر اللوحة: الترجمة ----------
  async function command(c) {
    if (c.type === 'store_translate') {
      const texts = (c.texts || []).map((x) => String(x || '')).slice(0, 60)
      return { texts: await translateTexts(texts, c.to === 'he' ? 'iw' : 'en') }
    }
    if (c.type === 'store_translate_all') {
      const snap = await db.collection('store_products').get()
      let done = 0
      for (const d of snap.docs) {
        const p = d.data()
        if (p.nameEn || !p.name || p.status === 'draft') continue
        try {
          const [nameEn, descEn, ...featuresEn] = await translateTexts([p.name, p.desc || '', ...(p.features || [])])
          await d.ref.update({ nameEn, descEn, featuresEn: featuresEn.filter(Boolean) })
          done++
          await sleep(800)
        } catch (e) {
          log('⚠️ ترجمة منتج:', e.message)
        }
      }
      return { done }
    }
    throw new Error('أمر غير معروف')
  }

  return { start, onUpsert, command, stats: () => ({ awaiting: byPhone.size, queue: queue.length }) }
}

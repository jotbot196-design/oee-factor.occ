/**
 * oee-notify — ตัวเฝ้าดูงานแจ้งซ่อม แล้วส่งแจ้งเตือนเข้าแอป OEE (Android) ผ่าน Firebase
 *
 * - ทุก 1 นาที (Cron) อ่านรายการแจ้งซ่อมจากเว็บ OEE แบบอ่านอย่างเดียว (GET /api/kv?path=maintenance-alerts)
 *   ไม่แก้ / ไม่เขียนข้อมูลของระบบ OEE เลย
 * - เจองานแจ้งซ่อมใหม่ (ที่ยังไม่ปิด) → ส่งแจ้งเตือนเสียงปกติ ถึงทุกเครื่องที่ลงทะเบียน
 * - แอปลงทะเบียนเครื่องเองผ่าน POST /register
 *
 * Binding / ค่าที่ต้องมี:
 *   STORE                (KV)     เก็บรายชื่อเครื่อง + งานที่เคยแจ้งแล้ว
 *   OEE_API              (var)    https://oee.sasatornua.workers.dev
 *   FCM_SERVICE_ACCOUNT  (secret) JSON กุญแจ Service account ของ Firebase
 */

const ALERT_PATH = 'maintenance-alerts';
const POLL_SECONDS = 10;          // เช็คเว็บทุก 10 วินาที (6 ครั้ง/นาที ≈ 8,640 ครั้ง/วัน)
let lastKick = 0;
let seenCache = null;             // จำในหน่วยความจำ ลดการอ่าน KV

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/register' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const token = String(body.token || '');
        if (!/^[\w:-]{100,300}$/.test(token)) return json({ error: 'token ไม่ถูกต้อง' }, 400);
        const key = 'tok:' + token;
        // เขียนเฉพาะเครื่องใหม่ (KV แพ็กเกจฟรีเขียนได้จำกัดต่อวัน)
        if (!(await env.STORE.get(key))) {
          await env.STORE.put(key, JSON.stringify({ ts: Date.now(), platform: String(body.platform || '').slice(0, 20) }));
        }
        return json({ ok: true });
      }
      // แอปสะกิดทันทีหลังช่างกดส่งแจ้งซ่อม → เช็คเว็บเดี๋ยวนี้ (ไม่รับข้อความจากแอป อ่านจากเว็บจริงเสมอ)
      if (url.pathname === '/kick' && (request.method === 'POST' || request.method === 'GET')) {
        if (Date.now() - lastKick < 2000) return json({ ok: true, skipped: true });
        lastKick = Date.now();
        const st = await checkAll(env);
        return json({ ok: !!st.ok, newAlerts: st.newAlerts || 0 });
      }
      // ทดสอบส่งถึงทุกเครื่องที่ลงทะเบียน (ใช้จาก GitHub Actions เท่านั้น — ต้องมีรหัสทดสอบ)
      if (url.pathname === '/test' && request.method === 'POST') {
        if (request.headers.get('X-Test-Key') !== await testKey(env)) return json({ error: 'ไม่มีสิทธิ์' }, 401);
        const t = new Date(Date.now() + 7 * 3600000).toISOString().slice(11, 19);
        const r = await sendToAll(env, { type: 'normal', title: '🔧 แจ้งซ่อม: MP37 (ทดสอบ ' + t + ')',
          body: 'ไฟฟ้า · ทดสอบระบบแจ้งเตือน', page: 'maintenance', tag: 'test-' + Date.now() });
        return json(r);
      }
      // แจ้งทุกเครื่องว่ามีแอปเวอร์ชันใหม่ (ใช้จาก GitHub Actions เท่านั้น — ต้องมีรหัสทดสอบ)
      if (url.pathname === '/announce-update' && request.method === 'POST') {
        if (request.headers.get('X-Test-Key') !== await testKey(env)) return json({ error: 'ไม่มีสิทธิ์' }, 401);
        const v = String(url.searchParams.get('v') || '').replace(/[^0-9.]/g, '').slice(0, 12);
        if (!v) return json({ error: 'ต้องระบุเวอร์ชัน' }, 400);
        return json(await sendToAll(env, { type: 'normal', title: '📲 มีแอป OEE เวอร์ชันใหม่ v' + v,
          body: 'แตะเพื่ออัปเดต — ข้อมูลและการแจ้งเตือนเดิมไม่หาย', page: 'update', tag: 'update-' + v }));
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        const [status, devices] = await Promise.all([env.STORE.get('status', 'json'), listTokens(env)]);
        return json({ devices: devices.length, ...(status || {}) });
      }
      if (url.pathname === '/' ) return json({ service: 'oee-notify', ok: true });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Cron ทำงานทุก 1 นาที → ข้างในวนเช็คทุก 10 วินาที
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const start = Date.now();
      for (let i = 0; i < 60 / POLL_SECONDS; i++) {
        const wait = start + i * POLL_SECONDS * 1000 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        await checkAll(env);
      }
    })());
  }
};

// ---------------------------------------------------------------------------
// เช็คงานแจ้งซ่อมใหม่
// ---------------------------------------------------------------------------
export async function checkAlerts(env) {
  const now = Date.now();
  let status = { lastCheck: now };
  try {
    const res = await fetch(env.OEE_API + '/api/kv?path=' + encodeURIComponent(ALERT_PATH), {
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('อ่านข้อมูลเว็บไม่ได้ HTTP ' + res.status);
    const data = await res.json();
    const list = toList(data && data.value);
    const open = list.filter(a => a && a.id && a.status !== 'closed');
    // จำ "id@เวลาแจ้ง" — เว็บแจ้งซ้ำเครื่องเดิมจะอัปเดตเวลา (ts) จึงแจ้งเตือนอีกครั้งเหมือนที่เว็บแสดง
    const keyOf = a => String(a.id) + '@' + (a.ts || '');
    const keys = open.map(keyOf).sort();

    const prevRaw = seenCache !== null ? seenCache : await env.STORE.get('seen:mtn');
    const prev = prevRaw === null ? null : new Set(JSON.parse(prevRaw));
    const fresh = prev === null ? [] : open.filter(a => !prev.has(keyOf(a)));
    // เขียน KV เฉพาะตอนรายการเปลี่ยน
    const nowRaw = JSON.stringify(keys);
    if (prevRaw === null || prevRaw !== nowRaw) await env.STORE.put('seen:mtn', nowRaw);
    seenCache = nowRaw;

    let sent = 0;
    for (const a of fresh) {
      const r = await sendToAll(env, formatAlert(a));
      sent += r.sent;
    }
    status = { lastCheck: now, ok: true, openAlerts: open.length, newAlerts: fresh.length, sent, seeded: prevRaw === null };
  } catch (e) {
    status = { lastCheck: now, ok: false, error: String(e && e.message || e) };
  }
  // บันทึกสถานะเฉพาะตอนมีเรื่อง (ลดการเขียน KV): error, มีงานใหม่, หรือทุก ~1 ชม.
  const prev = await env.STORE.get('status', 'json');
  if (!status.ok || status.newAlerts || !prev || prev.ok !== status.ok || now - (prev.lastCheck || 0) > 3600000) {
    await env.STORE.put('status', JSON.stringify(status));
  }
  return status;
}

// ---------------------------------------------------------------------------
// แจ้งซ่อมแม่พิมพ์ (หน้า die-maintenance) — อ่านรายการ "รอรับ" จาก /api/push/pending
// ซึ่งเป็นข้อมูลเดียวกับที่ Web Push ของเว็บใช้ (iPhone ได้ข้อความแบบนี้)
// ---------------------------------------------------------------------------
let dieSeenCache = null;
export async function checkDie(env) {
  try {
    const res = await fetch(env.OEE_API + '/api/push/pending', { cache: 'no-store' });
    if (!res.ok) throw new Error('อ่านงานแจ้งซ่อมแม่พิมพ์ไม่ได้ HTTP ' + res.status);
    const jobs = ((await res.json()) || {}).jobs || [];
    const ids = jobs.filter(j => j && j.id).map(j => String(j.id));
    const prevRaw = dieSeenCache !== null ? dieSeenCache : await env.STORE.get('seen:die');
    const prev = prevRaw === null ? null : new Set(JSON.parse(prevRaw));
    // จำงานที่เคยแจ้งไว้ (รวมงานที่หลุดจาก "รอรับ" ไปไม่เกิน 200 รายการล่าสุด) กันแจ้งซ้ำ
    const fresh = prev === null ? [] : jobs.filter(j => j && j.id && !prev.has(String(j.id)));
    const keep = [...new Set([...(prev ? [...prev] : []), ...ids])].slice(-200);
    const nowRaw = JSON.stringify(keep);
    if (prevRaw === null || prevRaw !== nowRaw) await env.STORE.put('seen:die', nowRaw);
    dieSeenCache = nowRaw;
    let sent = 0;
    for (const j of fresh) sent += (await sendToAll(env, formatDieJob(j, jobs.length))).sent;
    return { ok: true, newAlerts: fresh.length, sent };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** ข้อความเดียวกับ Web Push ของเว็บ (sw.js ของ oee-web) */
export function formatDieJob(j, waiting) {
  const more = waiting > 1 ? ' (รอรับ ' + waiting + ' งาน)' : '';
  return {
    type: 'normal',
    title: '🛠️ แจ้งซ่อมแม่พิมพ์ใหม่' + more,
    body: [j.model, j.partName, j.process].filter(Boolean).join(' · ') + '\n' + (j.problem || '') + (j.reporter ? '\nผู้แจ้ง: ' + j.reporter : ''),
    page: 'die-maintenance',
    tag: 'die-' + j.id
  };
}

export async function checkAll(env) {
  const [a, d] = await Promise.all([checkAlerts(env), checkDie(env)]);
  return { ok: a.ok && d.ok, newAlerts: (a.newAlerts || 0) + (d.newAlerts || 0), die: d };
}

/**
 * ข้อความแจ้งเตือน ให้ตรงกับที่เว็บ OEE แสดงในรายการแจ้งซ่อม:
 *   เบอร์เครื่อง · สาเหตุ · อาการ (ถ้าไม่ได้กรอก เว็บแสดง "ไม่ระบุอาการ") · เวลาแจ้ง
 */
export function formatAlert(a) {
  const t = a.ts ? new Date(Number(a.ts) + 7 * 3600000).toISOString().slice(11, 16) + ' น.' : '';
  const reRaised = a.startTs && a.ts && Number(a.ts) !== Number(a.startTs);
  return {
    type: 'normal',
    title: '🔧 แจ้งซ่อม' + (reRaised ? 'ซ้ำ' : '') + ': ' + (a.machine || '-'),
    body: [a.cause, a.note || 'ไม่ระบุอาการ', t].filter(Boolean).join(' · '),
    page: 'maintenance',
    tag: 'mtn-' + a.id + '-' + (a.ts || '')
  };
}

// ---------------------------------------------------------------------------
// ส่ง FCM ถึงทุกเครื่อง
// ---------------------------------------------------------------------------
export async function sendToAll(env, msg) {
  const tokens = await listTokens(env);
  if (!tokens.length) return { total: 0, sent: 0, removed: 0 };
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const access = await googleAccessToken(sa);
  let sent = 0, removed = 0;
  await Promise.all(tokens.map(async token => {
    const res = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          data: { type: msg.type, title: msg.title, body: msg.body, page: msg.page, tag: msg.tag },
          android: { priority: 'HIGH', ttl: '3600s' }
        }
      })
    });
    if (res.ok) { sent++; return; }
    const err = await res.text();
    if (res.status === 404 || /UNREGISTERED/.test(err)) {
      await env.STORE.delete('tok:' + token); removed++;   // เครื่องถอนแอปไปแล้ว
    }
  }));
  return { total: tokens.length, sent, removed };
}

async function listTokens(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.STORE.list({ prefix: 'tok:', cursor });
    for (const k of r.keys) out.push(k.name.slice(4));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Google OAuth: เซ็น JWT (RS256) ด้วย Web Crypto แลกเป็น access token
// ---------------------------------------------------------------------------
let cachedToken = null;
export async function googleAccessToken(sa, fetchImpl = fetch) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.value;
  const jwt = await signServiceAccountJwt(sa);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  if (!res.ok) throw new Error('ขอสิทธิ์ Google ไม่ได้ HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const d = await res.json();
  cachedToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

export async function signServiceAccountJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  return unsigned + '.' + b64u(sig);
}

/** รหัสทดสอบ = SHA-256(private_key_id ของ Firebase + "oee-test") — GitHub Actions คำนวณได้จาก Secret เดียวกัน */
export async function testKey(env) {
  const id = JSON.parse(env.FCM_SERVICE_ACCOUNT).private_key_id + 'oee-test';
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
function toList(v) { return !v ? [] : Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean); }
function b64u(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
}

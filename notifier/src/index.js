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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
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
    const ids = open.map(a => String(a.id)).sort();

    const prevRaw = await env.STORE.get('seen:mtn');
    const fresh = prevRaw === null ? [] : open.filter(a => !JSON.parse(prevRaw).includes(String(a.id)));
    // เขียน KV เฉพาะตอนรายการเปลี่ยน
    if (prevRaw === null || prevRaw !== JSON.stringify(ids)) await env.STORE.put('seen:mtn', JSON.stringify(ids));

    let sent = 0;
    for (const a of fresh) {
      const r = await sendToAll(env, {
        type: 'normal',
        title: '🔧 งานแจ้งซ่อมใหม่: เครื่อง ' + (a.machine || '-'),
        body: [a.cause, a.note].filter(Boolean).join(' · ') || 'กดเพื่อดูรายละเอียด',
        page: 'maintenance',
        tag: 'mtn-' + a.id
      });
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

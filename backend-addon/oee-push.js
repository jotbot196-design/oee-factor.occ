/**
 * ============================================================================
 *  oee-push.js — ส่วนเสริม "ระบบแจ้งเตือนมือถือ" สำหรับ Worker ของเว็บ OEE
 * ============================================================================
 *  ⚠️ ไฟล์นี้เป็นส่วนแจ้งเตือน ห้ามลบ  — ถ้าแก้ worker.js รอบหลัง ให้ import ไฟล์นี้ไว้เหมือนเดิม
 *
 *  ทำอะไร:
 *   1) เก็บ "ที่อยู่รับแจ้งเตือน" ของมือถือที่กดอนุญาต (ตาราง push_subs ใน D1 สร้างเอง)
 *   2) เมื่อมีการบันทึกข้อมูลผ่าน /api/kv จะเช็คว่ามีเรื่องใหม่ไหม แล้วส่งแจ้งเตือน
 *        - maintenance-alerts : มีเครื่องแจ้งเสียใหม่
 *        - spare-parts        : อะไหล่เพิ่งต่ำกว่า Min
 *        - mold-stock-parts   : อะไหล่แม่พิมพ์เพิ่งต่ำกว่า Min
 *   3) ทุกเช้า (Cron) เช็คแผน PPM ที่ใกล้ถึง/เกินกำหนด แล้วส่งแจ้งเตือน
 *
 *  ไม่แก้ข้อมูลเดิมของระบบ OEE เลย อ่านอย่างเดียว + ใช้ตารางของตัวเอง 2 ตาราง
 *  ใช้ Web Crypto ล้วน ไม่ต้องติดตั้ง npm package เพิ่ม
 *
 *  ต้องตั้งค่า (Cloudflare → Worker → Settings → Variables and Secrets):
 *   VAPID_PUBLIC_KEY   (Secret) กุญแจสาธารณะ
 *   VAPID_PRIVATE_KEY  (Secret) กุญแจลับ
 *   VAPID_SUBJECT      (Text)   เช่น mailto:admin@example.com
 *   PUSH_ADMIN_KEY     (Secret) รหัสสำหรับสั่งส่งแจ้งเตือนเอง (ตั้งเองยาวๆ)
 *   PUSH_ALLOWED_ORIGIN(Text)   https://jotbot196-design.github.io
 *  ฐานข้อมูล: ใช้ D1 ตัวเดิมของระบบ (binding ชื่อ DB) — ถ้าชื่ออื่น ตั้ง PUSH_DB_BINDING เป็นชื่อนั้น
 * ============================================================================
 */

const PREFIX = '/api/push/';
const PATH_MTN = 'maintenance-alerts';
const PATH_SPARE = 'spare-parts';
const PATH_MOLD = 'mold-stock-parts';
const PATH_PPM = 'ppm-plans';

// ---------------------------------------------------------------------------
// 1) จุดเชื่อมกับ worker.js
// ---------------------------------------------------------------------------

/** เรียกตอนต้นของ fetch(): ถ้าเป็น /api/push/... จะตอบให้เอง ถ้าไม่ใช่คืน null */
export async function handlePush(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const route = url.pathname.slice(PREFIX.length);

  if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
  try {
    await ensureTables(env);

    if (route === 'public-key' && request.method === 'GET') {
      return json(env, { publicKey: env.VAPID_PUBLIC_KEY || '' });
    }

    if (route === 'subscribe' && request.method === 'POST') {
      const body = await request.json();
      const sub = body && body.subscription;
      if (!sub || !validEndpoint(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json(env, { error: 'ข้อมูลไม่ถูกต้อง' }, 400);
      }
      await db(env).prepare(
        `INSERT INTO push_subs (endpoint, p256dh, auth, platform, dept, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh=?2, auth=?3, platform=?4, dept=?5`
      ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth,
             String(body.platform || '').slice(0, 20), String(body.dept || '').slice(0, 50), Date.now()).run();
      return json(env, { ok: true });
    }

    if (route === 'unsubscribe' && request.method === 'POST') {
      const body = await request.json();
      if (body && body.endpoint) await db(env).prepare('DELETE FROM push_subs WHERE endpoint=?1').bind(body.endpoint).run();
      return json(env, { ok: true });
    }

    // สั่งส่งแจ้งเตือนเอง (ทดสอบ / ประกาศ) — ต้องมีรหัส PUSH_ADMIN_KEY
    if (route === 'send' && request.method === 'POST') {
      if (!env.PUSH_ADMIN_KEY || request.headers.get('Authorization') !== 'Bearer ' + env.PUSH_ADMIN_KEY) {
        return json(env, { error: 'ไม่มีสิทธิ์' }, 401);
      }
      const body = await request.json();
      const r = await sendToAll(env, {
        title: String(body.title || 'OEE'), body: String(body.body || ''),
        page: String(body.page || ''), tag: body.tag ? String(body.tag) : undefined
      }, body.dept ? String(body.dept) : null);
      return json(env, r);
    }

    if (route === 'stats' && request.method === 'GET') {
      const row = await db(env).prepare('SELECT COUNT(*) AS n FROM push_subs').first();
      return json(env, { subscribers: row ? row.n : 0 });
    }

    return json(env, { error: 'not found' }, 404);
  } catch (e) {
    return json(env, { error: 'push error: ' + (e && e.message ? e.message : e) }, 500);
  }
}

/**
 * เรียกหลังบันทึก /api/kv สำเร็จ (PUT) — ส่ง path และค่าที่เพิ่งบันทึก
 * แนะนำ: ctx.waitUntil(onKvWrite(env, path, value)) เพื่อไม่ให้หน้าเว็บรอ
 */
export async function onKvWrite(env, path, value) {
  try {
    if (![PATH_MTN, PATH_SPARE, PATH_MOLD].includes(path)) return;
    await ensureTables(env);
    const list = toList(value);

    if (path === PATH_MTN) {
      const open = list.filter(a => a && a.id && a.status !== 'closed');
      const fresh = await diffNew(env, 'mtn-open', open.map(a => a.id));
      for (const a of open.filter(x => fresh.has(x.id))) {
        await sendToAll(env, {
          title: '🔴 เครื่อง ' + a.machine + ' แจ้งเสีย',
          body: [a.cause, a.note].filter(Boolean).join(' · ') || 'กดเพื่อดูรายละเอียด',
          page: 'maintenance', tag: 'mtn-' + a.id
        }, 'maintenance');
      }
    }

    if (path === PATH_SPARE) {
      const low = list.filter(p => p && num(p.minQty) > 0 && num(p.qty) <= num(p.minQty));
      const key = p => String(p.id || p.name);
      const fresh = await diffNew(env, 'spare-low', low.map(key));
      const items = low.filter(p => fresh.has(key(p)));
      if (items.length) {
        await sendToAll(env, {
          title: '📦 อะไหล่ต่ำกว่า Min (' + items.length + ' รายการ)',
          body: items.slice(0, 4).map(p => p.name + ' เหลือ ' + num(p.qty) + '/' + num(p.minQty)).join(', '),
          page: 'sparepart', tag: 'spare-low'
        }, 'store');
      }
    }

    if (path === PATH_MOLD) {
      const effMin = m => (num(m) > 0 ? num(m) : 1);
      const low = list.filter(x => x && num(x.qty) <= effMin(x.min));
      const key = x => String(x.id || (x.model + '|' + x.item));
      const fresh = await diffNew(env, 'mold-low', low.map(key));
      const items = low.filter(x => fresh.has(key(x)));
      if (items.length) {
        await sendToAll(env, {
          title: '🛠 อะไหล่แม่พิมพ์ต่ำกว่า Min (' + items.length + ' รายการ)',
          body: items.slice(0, 4).map(x => (x.item || x.part) + ' (' + x.model + ') เหลือ ' + num(x.qty)).join(', '),
          page: 'sparepart', tag: 'mold-low'
        }, 'mold');
      }
    }
  } catch (e) {
    console.log('onKvWrite push error', e && e.message);
  }
}

/**
 * เรียกจาก scheduled() วันละครั้ง (แนะนำ 07:30 น. เวลาไทย = cron "30 0 * * *")
 * readKv = ฟังก์ชันของ worker.js เดิมที่อ่านค่าจาก path (คืนค่าเดียวกับที่ GET /api/kv ส่งใน .value)
 */
export async function pushCron(env, readKv) {
  try {
    await ensureTables(env);
    const today = bangkokDate(0);
    const row = await db(env).prepare('SELECT val FROM push_state WHERE key=?1').bind('ppm-day').first();
    if (row && row.val === today) return; // วันนี้ส่งไปแล้ว

    if (typeof readKv !== 'function') throw new Error('pushCron ต้องส่งฟังก์ชันอ่านข้อมูล (readKv) มาด้วย');
    const plans = toList(await readKv(PATH_PPM));
    const due = plans.map(p => ({ p, left: daysLeft(p.nextDue, today) }))
      .filter(x => x.left !== null && x.left <= (num(x.p.remindDays) || 0))
      .sort((a, b) => a.left - b.left);
    if (due.length) {
      const over = due.filter(x => x.left < 0).length;
      await sendToAll(env, {
        title: '🗓 PPM ' + (over ? 'เกินกำหนด ' + over + ' · ' : '') + 'ใกล้ถึงกำหนด ' + (due.length - over) + ' รายการ',
        body: due.slice(0, 4).map(x => x.p.machine + ' ' + (x.p.task || '') + ' (' + (x.left < 0 ? 'เกิน ' + -x.left + ' วัน' : x.left === 0 ? 'วันนี้' : 'อีก ' + x.left + ' วัน') + ')').join(', '),
        page: 'maintenance', tag: 'ppm-daily'
      }, 'maintenance');
    }
    await setState(env, 'ppm-day', today);
  } catch (e) {
    console.log('pushCron error', e && e.message);
  }
}

/** ส่งแจ้งเตือนถึงทุกเครื่อง (หรือเฉพาะแผนก dept — เครื่องที่ไม่ได้ระบุแผนกจะได้รับทุกเรื่อง) */
export async function sendToAll(env, message, dept) {
  await ensureTables(env);
  const q = dept
    ? db(env).prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE dept='' OR dept IS NULL OR dept=?1").bind(dept)
    : db(env).prepare('SELECT endpoint, p256dh, auth FROM push_subs');
  const rows = (await q.all()).results || [];
  const payload = JSON.stringify(message);
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(rows.map(async r => {
    try {
      const res = await sendWebPush(env, { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
      if (res.status === 404 || res.status === 410) {
        await db(env).prepare('DELETE FROM push_subs WHERE endpoint=?1').bind(r.endpoint).run(); removed++;
      } else if (res.ok) sent++;
      else failed++;
    } catch (e) { failed++; }
  }));
  return { total: rows.length, sent, removed, failed };
}

// ---------------------------------------------------------------------------
// 2) Web Push: VAPID (RFC 8292) + เข้ารหัส aes128gcm (RFC 8291) ด้วย Web Crypto
// ---------------------------------------------------------------------------

export async function sendWebPush(env, sub, payload, ttl = 86400) {
  const endpoint = new URL(sub.endpoint);
  const jwt = await vapidJwt(env, endpoint.origin);
  const body = await encryptPayload(sub, new TextEncoder().encode(payload));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(ttl),
      'Urgency': 'high'
    },
    body
  });
}

export async function vapidJwt(env, audience) {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = o => b64uEncode(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com'
  });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64uEncode(new Uint8Array(sig));
}

export async function encryptPayload(sub, plaintext) {
  const uaPublic = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = record สุดท้าย
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concat(info, new Uint8Array([1]))));
  return okm.slice(0, length);
}

// ---------------------------------------------------------------------------
// 3) ตัวช่วย
// ---------------------------------------------------------------------------

function db(env) {
  const d = env[env.PUSH_DB_BINDING || 'DB'];
  if (!d) throw new Error('ไม่พบ D1 binding "' + (env.PUSH_DB_BINDING || 'DB') + '"');
  return d;
}

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await db(env).batch([
    db(env).prepare(`CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      platform TEXT, dept TEXT, created_at INTEGER)`),
    db(env).prepare('CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, val TEXT)')
  ]);
  tablesReady = true;
}

async function setState(env, key, val) {
  await db(env).prepare('INSERT INTO push_state (key, val) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET val=?2')
    .bind(key, val).run();
}

/** คืน Set ของ id ที่ "เพิ่งมีใหม่" เทียบกับครั้งก่อน (ครั้งแรกจำไว้เฉยๆ ไม่แจ้ง เพื่อไม่ให้แจ้งของเก่าทั้งหมด) */
async function diffNew(env, stateKey, ids) {
  const row = await db(env).prepare('SELECT val FROM push_state WHERE key=?1').bind(stateKey).first();
  await setState(env, stateKey, JSON.stringify(ids));
  if (!row) return new Set();
  let prev = [];
  try { prev = JSON.parse(row.val) || []; } catch (e) { prev = []; }
  const p = new Set(prev);
  return new Set(ids.filter(id => !p.has(id)));
}

function toList(v) { return !v ? [] : Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean); }
function num(v) { return parseFloat(v) || 0; }
function validEndpoint(e) { try { return new URL(e).protocol === 'https:'; } catch (x) { return false; } }

function bangkokDate(offsetDays) {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
function daysLeft(due, today) {
  const a = String(due || '').split('-').map(Number), b = today.split('-').map(Number);
  if (a.length < 3 || a.some(isNaN)) return null;
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function b64uEncode(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.PUSH_ALLOWED_ORIGIN || '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}
function json(env, obj, status = 200) {
  return cors(env, new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
}

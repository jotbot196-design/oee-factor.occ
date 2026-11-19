import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';
import ece from 'http_ece';
import * as wpm from 'web-push'; const webpush = wpm.default || wpm;
import * as P from '../oee-push.js';

let pass = 0; const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } pass++; console.log('  ✓', m); };

// ---- mock D1 on sqlite ----
const sql = new DatabaseSync(':memory:');
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  run: async () => { sql.prepare(q).run(...args); return { success: true }; },
  all: async () => ({ results: sql.prepare(q).all(...args) }),
  first: async () => sql.prepare(q).get(...args) || null,
});
const D1 = { prepare: q => stmt(q), batch: async (list) => { for (const s of list) await s.run(); } };

const vapid = webpush.generateVAPIDKeys();
const env = { DB: D1, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:t@example.com', PUSH_ADMIN_KEY: 'adminkey', PUSH_ALLOWED_ORIGIN: 'https://jotbot196-design.github.io' };

// ---- fake phone ----
const phone = nodeCrypto.createECDH('prime256v1'); phone.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const b64u = b => Buffer.from(b).toString('base64url');
const sub = { endpoint: 'https://web.push.apple.com/FAKE123', keys: { p256dh: b64u(phone.getPublicKey()), auth: b64u(auth) } };

// ---- mock fetch: decrypt & verify every push ----
const received = [];
globalThis.fetch = async (url, init) => {
  const h = init.headers;
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
  const [hd, pl, sg] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(pl, 'base64url'));
  const pubJwk = { kty:'EC', crv:'P-256', x: b64u(Buffer.from(m[2],'base64url').subarray(1,33)), y: b64u(Buffer.from(m[2],'base64url').subarray(33,65)) };
  const vOK = nodeCrypto.verify('sha256', Buffer.from(hd+'.'+pl), { key: nodeCrypto.createPublicKey({ key: pubJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sg,'base64url'));
  const plain = ece.decrypt(Buffer.from(init.body), { version: 'aes128gcm', privateKey: phone, authSecret: auth });
  received.push({ url, claims, vOK, msg: JSON.parse(plain.toString()), enc: h['Content-Encoding'] });
  return new Response(null, { status: url.includes('GONE') ? 410 : 201 });
};

console.log('1) encryption + VAPID');
const r0 = await P.sendWebPush(env, sub, JSON.stringify({ title: 'สวัสดี', body: 'ทดสอบ' }));
ok(r0.status === 201, 'push accepted by mock');
ok(received[0].vOK, 'VAPID JWT signature valid (ES256)');
ok(received[0].claims.aud === 'https://web.push.apple.com', 'JWT aud = push service origin');
ok(received[0].msg.title === 'สวัสดี', 'payload decrypts correctly (Thai text)');
ok(received[0].enc === 'aes128gcm', 'content-encoding aes128gcm');

console.log('2) subscribe API + CORS');
const req = (path, method, body, hdr = {}) => new Request('https://oee.example' + path, { method, headers: { 'Content-Type': 'application/json', ...hdr }, body: body ? JSON.stringify(body) : undefined });
let res = await P.handlePush(req('/api/push/subscribe', 'POST', { subscription: sub, platform: 'ios' }), env);
ok(res.status === 200, 'subscribe 200');
ok(res.headers.get('Access-Control-Allow-Origin') === env.PUSH_ALLOWED_ORIGIN, 'CORS header');
res = await P.handlePush(req('/api/push/subscribe', 'POST', { subscription: { endpoint: 'x' } }), env);
ok(res.status === 400, 'bad subscription rejected');
ok((await P.handlePush(req('/api/kv?path=x', 'GET'), env)) === null, 'non-push route returns null (passes through)');
res = await P.handlePush(req('/api/push/subscribe', 'OPTIONS'), env);
ok(res.status === 204, 'preflight 204');

console.log('3) maintenance alerts');
received.length = 0;
await P.onKvWrite(env, 'maintenance-alerts', [{ id: 'a1', machine: 'MP37', status: 'open', cause: 'ไฟฟ้า' }]);
ok(received.length === 0, 'first write only seeds state (no spam of old alerts)');
await P.onKvWrite(env, 'maintenance-alerts', [{ id: 'a1', machine: 'MP37', status: 'open' }, { id: 'a2', machine: 'MP25', status: 'open', cause: 'ไฮดรอลิก/ลม', note: 'น้ำมันรั่ว' }]);
ok(received.length === 1 && received[0].msg.title.includes('MP25'), 'new breakdown -> 1 notification: ' + received[0].msg.title);
ok(received[0].msg.body === 'ไฮดรอลิก/ลม · น้ำมันรั่ว' && received[0].msg.page === 'maintenance', 'body + page correct');
received.length = 0;
await P.onKvWrite(env, 'maintenance-alerts', [{ id: 'a1', machine: 'MP37', status: 'open' }, { id: 'a2', machine: 'MP25', status: 'open' }]);
ok(received.length === 0, 'same alerts saved again -> no duplicate');
await P.onKvWrite(env, 'oee-entries', [{ id: 'x' }]);
ok(received.length === 0, 'unrelated path ignored');

console.log('4) spare parts low stock');
await P.onKvWrite(env, 'spare-parts', [{ id: 's1', name: 'Bearing', qty: 5, minQty: 2 }]);
await P.onKvWrite(env, 'spare-parts', [{ id: 's1', name: 'Bearing', qty: 2, minQty: 2 }, { id: 's2', name: 'Fuse', qty: 1, minQty: 0 }]);
ok(received.length === 1 && received[0].msg.body.includes('Bearing เหลือ 2/2'), 'becomes low -> notify; minQty 0 ignored');
received.length = 0;
await P.onKvWrite(env, 'spare-parts', [{ id: 's1', name: 'Bearing', qty: 1, minQty: 2 }]);
ok(received.length === 0, 'still low -> no repeat');

console.log('5) mold stock');
await P.onKvWrite(env, 'mold-stock-parts', [{ id: 'm1', item: 'Punch', model: 'KWWA', qty: 3, min: 2 }]);
await P.onKvWrite(env, 'mold-stock-parts', [{ id: 'm1', item: 'Punch', model: 'KWWA', qty: 2, min: 2 }]);
ok(received.length === 1 && received[0].msg.title.includes('แม่พิมพ์'), 'mold low -> notify');

console.log('6) PPM daily cron');
received.length = 0;
const today = new Date(Date.now() + 7*3600e3).toISOString().slice(0,10);
const plus = d => new Date(Date.now() + 7*3600e3 + d*864e5).toISOString().slice(0,10);
const plans = [{ machine: 'MP37', task: 'เปลี่ยนน้ำมัน', nextDue: plus(-2), remindDays: 7 }, { machine: 'MP25', task: 'ตรวจเบรก', nextDue: plus(3), remindDays: 7 }, { machine: 'MP26', task: 'ทำความสะอาด', nextDue: plus(30), remindDays: 7 }];
await P.pushCron(env, async path => path === 'ppm-plans' ? plans : null);
ok(received.length === 1 && received[0].msg.title.includes('เกินกำหนด 1') && received[0].msg.title.includes('ใกล้ถึงกำหนด 1'), 'PPM summary: ' + received[0].msg.title);
await P.pushCron(env, async () => plans);
ok(received.length === 1, 'cron twice same day -> sent once');

console.log('7) admin send + dept filter + dead subscriptions');
res = await P.handlePush(req('/api/push/send', 'POST', { title: 'x' }), env);
ok(res.status === 401, 'send without admin key -> 401');
const sub2 = { endpoint: 'https://fcm.googleapis.com/GONE', keys: sub.keys };
await P.handlePush(req('/api/push/subscribe', 'POST', { subscription: sub2, platform: 'android', dept: 'qc' }), env);
received.length = 0;
res = await P.handlePush(req('/api/push/send', 'POST', { title: 'ประกาศ', body: 'ทดสอบ' }, { Authorization: 'Bearer adminkey' }), env);
const r = await res.json();
ok(r.total === 2 && r.sent === 1 && r.removed === 1, 'admin send: ' + JSON.stringify(r) + ' (410 endpoint removed)');
res = await P.handlePush(req('/api/push/stats', 'GET'), env);
ok((await res.json()).subscribers === 1, 'dead subscription deleted from DB');

console.log('\nALL PASSED:', pass);

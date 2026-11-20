import crypto from 'node:crypto';
import worker, { checkAlerts, checkDie, checkAll, formatDieJob, signServiceAccountJwt, testKey } from '../src/index.js';
const ctx = { waitUntil: p => p };
let pass = 0; const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } pass++; console.log('  ✓', m); };

// fake KV
const kv = new Map();
const STORE = {
  get: async (k, t) => kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null,
  put: async (k, v) => { writes++; kv.set(k, v); },
  delete: async k => { kv.delete(k); },
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true })
};
let writes = 0;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { project_id: 'oee-factory-f5d9e', private_key_id: 'kid1', client_email: 'x@oee.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const env = { STORE, OEE_API: 'https://oee.example', FCM_SERVICE_ACCOUNT: JSON.stringify(sa) };

let alerts = [], fcm = [], dieJobs = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://oee.example/api/push/pending') return new Response(JSON.stringify({ jobs: dieJobs }), { status: 200 });
  if (url.startsWith('https://oee.example/api/kv')) return new Response(JSON.stringify({ value: alerts }), { status: 200 });
  if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }));
  if (url.includes('fcm.googleapis.com')) {
    const b = JSON.parse(init.body); fcm.push(b.message);
    if (b.message.token.startsWith('dead')) return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    return new Response('{"name":"ok"}');
  }
  throw new Error('unexpected ' + url);
};
const tok = p => p + ':' + 'A'.repeat(140);

console.log('1) JWT');
const jwt = await signServiceAccountJwt(sa);
const [h, p, s] = jwt.split('.');
ok(crypto.verify('sha256', Buffer.from(h + '.' + p), publicKey, Buffer.from(s, 'base64url')), 'RS256 signature verifies');
const claims = JSON.parse(Buffer.from(p, 'base64url'));
ok(claims.scope.includes('firebase.messaging') && claims.aud.includes('oauth2'), 'claims correct');

console.log('2) register');
const req = (path, method, body) => new Request('https://n.example' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' } });
let r = await worker.fetch(req('/register', 'POST', { token: tok('good1'), platform: 'android' }), env);
ok(r.status === 200, 'register ok');
await worker.fetch(req('/register', 'POST', { token: tok('dead1') }), env);
r = await worker.fetch(req('/register', 'POST', { token: 'short' }), env);
ok(r.status === 400, 'bad token rejected');
writes = 0; await worker.fetch(req('/register', 'POST', { token: tok('good1') }), env);
ok(writes === 0, 'same device again → no KV write');

console.log('3) alerts');
alerts = [{ id: 'a1', machine: 'MP37', status: 'open', cause: 'ไฟฟ้า', ts: 1, startTs: 1 }];
let st = await checkAlerts(env);
ok(st.ok && st.seeded && fcm.length === 0, 'first run seeds silently (no spam for existing jobs)');
writes = 0; st = await checkAlerts(env);
ok(fcm.length === 0 && writes === 0, 'no change → no notification, no KV write');
alerts.push({ id: 'a2', machine: 'MP25', status: 'open', cause: 'ไฮดรอลิก/ลม', note: 'น้ำมันรั่ว', ts: 1795140000000, startTs: 1795140000000 });
st = await checkAlerts(env);
ok(st.newAlerts === 1 && fcm.length === 2, 'new job → sent to both devices');
const m = fcm.find(x => x.token.startsWith('good'));
ok(m.data.type === 'normal' && m.data.title === '🔧 แจ้งซ่อม: MP25' && m.data.body === 'ไฮดรอลิก/ลม · น้ำมันรั่ว · 09:00 น.' && m.android.priority === 'HIGH', 'payload: ' + m.data.title + ' | ' + m.data.body);
ok(!kv.has('tok:' + tok('dead1')), 'uninstalled device removed');
fcm = []; alerts[0].ts = 5; await checkAlerts(env);
ok(fcm.length === 1 && fcm[0].data.title === '🔧 แจ้งซ่อมซ้ำ: MP37' && fcm[0].data.body.startsWith('ไฟฟ้า · ไม่ระบุอาการ'), 're-reported on website → notify again: ' + fcm[0].data.title + ' | ' + fcm[0].data.body);
fcm = []; alerts[1].status = 'closed'; await checkAlerts(env);
ok(fcm.length === 0, 'closing a job → no notification');

console.log('4) status');
r = await worker.fetch(req('/status', 'GET'), env);
const sj = await r.json();
ok(sj.devices === 1 && sj.ok === true, 'status: ' + JSON.stringify(sj));

console.log('4b) kick');
fcm = []; alerts.push({ id: 'a3', machine: 'MP10', status: 'open', cause: 'แม่พิมพ์', note: 'ติด', ts: 9, startTs: 9 });
r = await worker.fetch(req('/kick', 'POST'), env);
let kj = await r.json();
ok(kj.ok && kj.newAlerts === 1 && fcm.length === 1 && fcm[0].data.tag === 'mtn-a3-9', 'kick → immediate notification, tag ' + fcm[0].data.tag);
r = await worker.fetch(req('/kick', 'POST'), env); kj = await r.json();
ok(kj.skipped === true, 'kick rate-limited (2s)');

console.log('4c) test endpoint');
r = await worker.fetch(new Request('https://n.example/test', { method: 'POST' }), env);
ok(r.status === 401, 'test without key → 401');
const k = crypto.createHash('sha256').update('kid1oee-test').digest('hex');
ok(k === await testKey(env), 'test key matches node sha256');
fcm = []; r = await worker.fetch(new Request('https://n.example/test', { method: 'POST', headers: { 'X-Test-Key': k } }), env);
const tj = await r.json();
ok(tj.sent === 1 && fcm[0].data.title.includes('ทดสอบ'), 'test sends to registered devices: ' + JSON.stringify(tj));

console.log('5) API error');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('x', { status: 500 });
st = await checkAlerts(env);
ok(!st.ok && /500/.test(st.error), 'error recorded: ' + st.error);
globalThis.fetch = realFetch;
console.log('9) die maintenance');
ok(kv.has('seen:die'), 'die list seeded earlier (silent, via kick/cron)');
fcm = []; dieJobs = [{ id: 'd1', model: 'X1', partName: 'BRKT', process: 'OP10', problem: 'แตก', reporter: 'สมชาย', status: 'wait' }];
let ds = await checkDie(env);
ok(ds.ok && ds.newAlerts === 1 && fcm[0].data.body === 'X1 · BRKT · OP10\nแตก\nผู้แจ้ง: สมชาย', 'first die job notified with reporter');
fcm = []; dieJobs.push({ id: 'd2', model: 'Y2', partName: 'PLATE', problem: 'สึก' });
ds = await checkDie(env);
ok(ds.newAlerts === 1 && fcm.length > 0 && fcm.every(m => m.data.tag === 'die-d2'), 'new die job → notify once per device');
ok(fcm[0].data.title === '🛠️ แจ้งซ่อมแม่พิมพ์ใหม่ (รอรับ 2 งาน)' && fcm[0].data.body === 'Y2 · PLATE\nสึก' && fcm[0].data.page === 'die-maintenance', 'text same as website push');
fcm = []; ds = await checkDie(env);
ok(ds.newAlerts === 0 && fcm.length === 0, 'no repeat');
fcm = []; dieJobs = []; await checkDie(env); dieJobs = [{ id: 'd2', model: 'Y2' }]; ds = await checkDie(env);
ok(ds.newAlerts === 0, 'job leaving and returning to wait → no repeat');
const f1 = formatDieJob({ id: 'z', model: 'M', problem: 'p', reporter: 'r' }, 1);
ok(f1.title === '🛠️ แจ้งซ่อมแม่พิมพ์ใหม่' && f1.body === 'M\np\nผู้แจ้ง: r', 'single job format');
const all = await checkAll(env);
ok(all.ok, 'checkAll ok');

console.log('\nALL PASSED:', pass);

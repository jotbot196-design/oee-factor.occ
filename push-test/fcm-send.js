// ส่งแจ้งเตือนทดสอบเข้าแอป Android (APK) ผ่าน Firebase — รันโดย GitHub Actions
// กุญแจ Service Account อ่านจาก GitHub Secret ชื่อ FCM_SERVICE_ACCOUNT (ไม่เก็บไว้ในไฟล์)
const admin = require('firebase-admin');
const fs = require('fs');
const raw = process.env.FCM_SERVICE_ACCOUNT;
if (!raw) { console.log('ยังไม่ได้ตั้ง Secret FCM_SERVICE_ACCOUNT'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const file = fs.readFileSync(__dirname + '/fcm-codes.txt', 'utf8');
const tokens = file.split(/\s+/).filter(l => l.startsWith('OEEAPP:')).map(l => l.slice(7));
// บรรทัด "TYPE:breakdown" = ทดสอบเสียงเครื่องเสีย (ดังวนจนกดรับทราบ) / ไม่มี = เสียงปกติ
const type = (file.match(/^TYPE:(\w+)/m) || [])[1] || 'normal';
(async () => {
  let ok = 0;
  for (const token of tokens) {
    const hhmmss = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
    try {
      const msg = type === 'breakdown'
        ? { title: '🔴 เครื่อง MP37 แจ้งเสีย (ทดสอบ ' + hhmmss + ')', body: 'ไฟฟ้า · ทดสอบเสียงเตือน กด "รับทราบ" เพื่อหยุดเสียง', page: 'maintenance' }
        : { title: '📦 OEE ทดสอบเสียงปกติ ' + hhmmss, body: 'อะไหล่ Bearing เหลือ 2/2 (ทดสอบ)', page: 'sparepart' };
      // ส่งแบบ data เพื่อให้แอปเลือกเสียง/ช่องแจ้งเตือนเอง
      const id = await admin.messaging().send({
        token,
        data: { type, title: msg.title, body: msg.body, page: msg.page, tag: 'test-' + Date.now() },
        android: { priority: 'high', ttl: 3600 * 1000 }
      });
      console.log('sent', token.slice(0, 12) + '…', id); ok++;
    } catch (e) {
      console.log('FAILED', token.slice(0, 12) + '…', e.code, e.message);
    }
  }
  console.log('done', ok, '/', tokens.length);
  if (tokens.length && !ok) process.exit(1);
})();

// ส่งแจ้งเตือนทดสอบเข้าแอป Android (APK) ผ่าน Firebase — รันโดย GitHub Actions
// กุญแจ Service Account อ่านจาก GitHub Secret ชื่อ FCM_SERVICE_ACCOUNT (ไม่เก็บไว้ในไฟล์)
const admin = require('firebase-admin');
const fs = require('fs');
const raw = process.env.FCM_SERVICE_ACCOUNT;
if (!raw) { console.log('ยังไม่ได้ตั้ง Secret FCM_SERVICE_ACCOUNT'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const tokens = fs.readFileSync(__dirname + '/fcm-codes.txt', 'utf8').split(/\s+/)
  .filter(l => l.startsWith('OEEAPP:')).map(l => l.slice(7));
(async () => {
  let ok = 0;
  for (const token of tokens) {
    const hhmmss = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
    try {
      const id = await admin.messaging().send({
        token,
        notification: { title: 'OEE (แอป) 🔔 ส่งเวลา ' + hhmmss, body: 'แจ้งเตือนตรงเข้าแอป ไม่ผ่าน Chrome ✅ เทียบเวลาที่เห็นกับเวลาส่ง' },
        data: { page: '' },
        android: { priority: 'high', ttl: 3600 * 1000, notification: { channelId: 'oee_alerts', sound: 'default', defaultVibrateTimings: true } }
      });
      console.log('sent', token.slice(0, 12) + '…', id); ok++;
    } catch (e) {
      console.log('FAILED', token.slice(0, 12) + '…', e.code, e.message);
    }
  }
  console.log('done', ok, '/', tokens.length);
  if (tokens.length && !ok) process.exit(1);
})();

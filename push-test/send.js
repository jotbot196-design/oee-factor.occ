// ส่งแจ้งเตือนทดสอบไปยังเครื่องที่อยู่ใน push-test/codes.txt (รันโดย GitHub Actions)
// กุญแจลับอ่านจาก GitHub Secret ชื่อ PUSH_TEST_PRIVATE_KEY (ไม่เก็บไว้ในไฟล์)
const webpush = require('web-push');
const fs = require('fs');
const priv = process.env.PUSH_TEST_PRIVATE_KEY;
if (!priv) { console.log('ยังไม่ได้ตั้ง Secret PUSH_TEST_PRIVATE_KEY'); process.exit(1); }
webpush.setVapidDetails('mailto:oee-test@example.com', 'BK5Mm0hxnF0on6rgPv9_c5PwPOOEbuRpBK3Oeir5O6pAgmHYUKedZLOGmgiOg0xgr91pLYqSuh2a9xfqLdu16W0', priv);
const lines = fs.readFileSync(__dirname + '/codes.txt', 'utf8').split(/\s+/).filter(l => l.startsWith('OEETEST:'));
(async () => {
  let ok = 0;
  for (const line of lines) {
    const sub = JSON.parse(Buffer.from(line.slice(8), 'base64').toString('utf8'));
    try {
      const now = new Date();
      const hhmmss = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
      const r = await webpush.sendNotification(sub, JSON.stringify({
        title: 'OEE ทดสอบ 🔔 ส่งเวลา ' + hhmmss,
        body: 'แจ้งเตือนจากเซิร์ฟเวอร์ใช้ได้ ✅ เทียบเวลาที่เห็นกับเวลาส่ง เพื่อดูว่าช้าแค่ไหน',
        page: '', tag: 'oee-test-' + now.getTime(), ts: now.getTime()
      }), { TTL: 3600, urgency: 'high' });
      console.log('sent', sub.endpoint.split('/')[2], r.statusCode); ok++;
    } catch (e) {
      console.log('FAILED', sub.endpoint.split('/')[2], e.statusCode, e.body);
    }
  }
  console.log('done', ok, '/', lines.length);
  if (lines.length && !ok) process.exit(1);
})();

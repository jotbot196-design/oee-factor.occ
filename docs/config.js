/* ตั้งค่าแอป OEE (หน้าจอโฮม)
 * แก้ไฟล์นี้ได้ผ่านหน้าเว็บ GitHub (กดรูปดินสอ ✏️) ไม่ต้องลงโปรแกรม
 */
window.OEE_CONFIG = {
  // เว็บระบบ OEE ที่แอปเปิด
  appUrl: 'https://oee-web.sasatornua.workers.dev/',

  // ลิงก์ดาวน์โหลดแอป Android (เวอร์ชันล่าสุดเสมอ)
  apkUrl: 'https://github.com/jotbot196-design/oee-factor.occ/releases/latest/download/OEE.apk',

  // ระบบแจ้งเตือน: ยังไม่เปิดใช้ (ว่างไว้ = ไม่แสดงปุ่ม "เปิดการแจ้งเตือน")
  // เมื่อเพิ่มระบบแจ้งเตือนใน worker.js แล้ว จะใส่ค่า 2 ช่องนี้
  pushPublicKey: '',                 // VAPID public key
  pushSubscribeUrl: ''               // เช่น 'https://oee.sasatornua.workers.dev/api/push/subscribe'
};

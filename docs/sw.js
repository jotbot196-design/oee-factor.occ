/* Service Worker ของแอป OEE (หน้าจอโฮม)
 * - จำเป็นสำหรับการแจ้งเตือนบน iPhone / Android
 * - ไม่ได้เก็บข้อมูล OEE ไว้ในเครื่อง ข้อมูลยังมาจากเว็บ OEE จริงทุกครั้ง
 */
const VERSION = 'oee-shell-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// รับการแจ้งเตือนจากเซิร์ฟเวอร์ (ใช้เมื่อเพิ่มระบบแจ้งเตือนใน worker.js แล้ว)
// รูปแบบข้อมูลที่ส่งมา: { "title": "...", "body": "...", "page": "maintenance", "tag": "..." }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'OEE';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,          // ป้ายเดิมก็ต้องเด้ง + มีเสียงทุกครั้ง (ไม่ทับแบบเงียบ)
    timestamp: data.ts || Date.now(),
    data: { page: data.page || '' }
  }));
});

// กดที่การแจ้งเตือน -> เปิดแอป OEE ไปหน้าที่เกี่ยวข้อง
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const page = (event.notification.data && event.notification.data.page) || '';
  const url = new URL('./' + (page ? '?page=' + encodeURIComponent(page) : ''), self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-page', page }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

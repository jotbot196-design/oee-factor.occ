package com.tsgp.oee;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * เว็บสร้างไฟล์ส่งออก (Excel / ZIP) เป็น blob แล้วสั่ง a.click()
 * ซึ่ง WebView ของ Android ดาวน์โหลดเองไม่ได้
 * ตัวนี้ดักไฟล์นั้นแล้วบันทึกลงโฟลเดอร์ Downloads ของเครื่อง จากนั้นเปิดไฟล์ให้
 */
@CapacitorPlugin(name = "OeeDownload")
public class DownloadPlugin extends Plugin {

    private static final String HOOK_JS =
        "(function(){" +
        " if (window.__oeeDlHook || !window.OeeNative) return; window.__oeeDlHook = true;" +
        " var blobs = new Map();" +
        " var origCreate = URL.createObjectURL;" +
        " URL.createObjectURL = function(obj){" +
        "   var u = origCreate.apply(URL, arguments);" +
        "   try { if (obj instanceof Blob) { blobs.set(u, obj); if (blobs.size > 30) blobs.delete(blobs.keys().next().value); } } catch(e) {}" +
        "   return u;" +
        " };" +
        " function send(blob, name){" +
        "   var r = new FileReader();" +
        "   r.onload = function(){ OeeNative.saveFile(String(r.result), name || 'download', blob.type || ''); };" +
        "   r.onerror = function(){ OeeNative.showError('อ่านไฟล์ไม่สำเร็จ'); };" +
        "   r.readAsDataURL(blob);" +
        " }" +
        " function handle(a){" +
        "   var href = a.href || '';" +
        "   if (!(href.indexOf('blob:') === 0 || href.indexOf('data:') === 0)) return false;" +
        "   var name = a.getAttribute('download') || 'download';" +
        "   var b = blobs.get(href);" +
        "   if (b) { send(b, name); return true; }" +
        "   fetch(href).then(function(r){ return r.blob(); }).then(function(bb){ send(bb, name); })" +
        "     .catch(function(){ OeeNative.showError('ดาวน์โหลดไฟล์ไม่สำเร็จ'); });" +
        "   return true;" +
        " }" +
        " var origClick = HTMLAnchorElement.prototype.click;" +
        " HTMLAnchorElement.prototype.click = function(){ if (handle(this)) return; return origClick.apply(this, arguments); };" +
        // ช่างกดส่งแจ้งซ่อม (บันทึก maintenance-alerts สำเร็จ) → สะกิดตัวเฝ้าดูให้ส่งแจ้งเตือนทันที
        " try {" +
        "   var of = window.fetch;" +
        "   window.fetch = function(input, init){" +
        "     var p = of.apply(this, arguments);" +
        "     try {" +
        "       var u = typeof input === 'string' ? input : ((input && input.url) || '');" +
        "       var m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();" +
        "       if (m === 'PUT' && u.indexOf('/api/kv') >= 0 && decodeURIComponent(u).indexOf('maintenance-alerts') >= 0) {" +
        "         p.then(function(r){ if (r && r.ok) OeeNative.kickNotifier(); }).catch(function(){});" +
        "       }" +
        "     } catch(e) {}" +
        "     return p;" +
        "   };" +
        " } catch(e) {}" +
        // แจ้งเตือนที่เว็บสร้างเอง (new Notification) → แสดงเป็นแจ้งเตือนของแอป ข้อความเดียวกับเว็บ เสียงปกติ
        " try {" +
        "   var N = function(title, opts){ opts = opts || {}; this.title = title; this.body = opts.body || ''; this.tag = opts.tag || ''; this.onclick = null;" +
        "     OeeNative.showNotice(String(title || 'OEE'), String(opts.body || ''), String(opts.tag || '')); };" +
        "   N.prototype.close = function(){}; N.prototype.addEventListener = function(){}; N.prototype.removeEventListener = function(){};" +
        "   N.permission = 'granted';" +
        "   N.requestPermission = function(cb){ if (typeof cb === 'function') cb('granted'); return Promise.resolve('granted'); };" +
        "   window.Notification = N;" +
        " } catch(e) {}" +
        " document.addEventListener('click', function(e){" +
        "   var a = e.target && e.target.closest ? e.target.closest('a[href^=\"blob:\"],a[href^=\"data:\"]') : null;" +
        "   if (a && handle(a)) { e.preventDefault(); e.stopPropagation(); }" +
        " }, true);" +
        "})();";

    @Override
    public void load() {
        WebView wv = getBridge().getWebView();
        // ลงทะเบียนก่อนหน้าเว็บโหลด (plugin load() ทำงานก่อน Capacitor สั่งเปิด URL)
        wv.addJavascriptInterface(new NativeBridge(getActivity()), "OeeNative");
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                webView.evaluateJavascript(HOOK_JS, null);
            }
        });
    }

    static class NativeBridge {
        private final Activity activity;

        NativeBridge(Activity activity) { this.activity = activity; }

        @JavascriptInterface
        public void saveFile(String dataUrl, String fileName, String mimeType) {
            try {
                int comma = dataUrl.indexOf(',');
                byte[] bytes = Base64.decode(comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl, Base64.DEFAULT);
                String name = sanitizeName(fileName);
                String mime = (mimeType == null || mimeType.isEmpty()) ? guessMime(name) : mimeType;
                Uri uri = writeToDownloads(bytes, name, mime);
                activity.runOnUiThread(() -> {
                    Toast.makeText(activity, "บันทึกไฟล์แล้ว: Downloads/" + name, Toast.LENGTH_LONG).show();
                    openFile(uri, mime);
                });
            } catch (Exception e) {
                showError("บันทึกไฟล์ไม่สำเร็จ: " + e.getMessage());
            }
        }

        /** ช่างเพิ่งส่งแจ้งซ่อมจากแอป → ให้ตัวเฝ้าดูเช็คทันที */
        @JavascriptInterface
        public void kickNotifier() {
            Registrar.kick(activity);
        }

        /** แจ้งเตือนจากหน้าเว็บ (เสียงปกติ) */
        @JavascriptInterface
        public void showNotice(String title, String body, String tag) {
            int id = tag != null && !tag.isEmpty() ? ("web-" + tag).hashCode() : (int) (System.currentTimeMillis() & 0x7fffffff);
            Alerts.show(activity, "normal", title, body, "", id);
        }

        @JavascriptInterface
        public void showError(String msg) {
            activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
        }

        private static String sanitizeName(String name) {
            String n = (name == null || name.trim().isEmpty()) ? "download" : name.trim();
            return n.replaceAll("[\\\\/:*?\"<>|]", "_");
        }

        private static String guessMime(String name) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0) {
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
                if (m != null) return m;
            }
            return "application/octet-stream";
        }

        private Uri writeToDownloads(byte[] bytes, String name, String mime) throws Exception {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("ไม่สามารถสร้างไฟล์ได้");
                try (OutputStream os = activity.getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new Exception("ไม่สามารถเขียนไฟล์ได้");
                    os.write(bytes);
                }
                return uri;
            }
            // Android 9 ลงไป: เก็บในโฟลเดอร์ Downloads ของแอป (ไม่ต้องขอสิทธิ์เพิ่ม)
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = activity.getFilesDir();
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(bytes);
            }
            return FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", f);
        }

        private void openFile(Uri uri, String mime) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, mime);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(Intent.createChooser(i, "เปิดไฟล์ด้วย"));
            } catch (Exception ignored) {
                // ไม่มีแอปที่เปิดไฟล์ได้ ไฟล์ยังอยู่ใน Downloads
            }
        }
    }
}

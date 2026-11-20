package com.tsgp.oee;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * แจ้งอัปเดตแอป: เช็คเวอร์ชันล่าสุดบน GitHub Releases → ถ้าใหม่กว่า ขึ้นหน้าต่าง "อัปเดต"
 * กดอัปเดต → ดาวน์โหลด APK ในแอป แล้วเปิดหน้าติดตั้งให้ทันที (ข้อมูลเดิมไม่หาย)
 *
 * เวอร์ชันอ่านจากลิงก์ releases/latest (เปลี่ยนเส้นทางไป .../tag/v1.0.N) — ไม่ใช้ API จึงไม่ติดโควตา
 */
final class Updater {
    private static final String REPO = "https://github.com/jotbot196-design/oee-factor.occ";
    private static final long CHECK_EVERY_MS = 3 * 3600_000L;   // เช็คอย่างมากทุก 3 ชม.
    private static boolean dialogShowing = false;

    private Updater() { }

    /** force = true: เช็คทันที (เช่น เปิดจากแจ้งเตือนอัปเดต) */
    static void check(Activity a, boolean force) {
        SharedPreferences p = a.getSharedPreferences(OeeMessagingService.PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (!force && now - p.getLong("upd_checked", 0) < CHECK_EVERY_MS) return;
        p.edit().putLong("upd_checked", now).apply();
        new Thread(() -> {
            try {
                int latest = latestVersion();
                int mine = installedVersion(a);
                if (latest > mine) {
                    new Handler(Looper.getMainLooper()).post(() -> ask(a, latest));
                } else if (force) {
                    new Handler(Looper.getMainLooper()).post(() ->
                        Toast.makeText(a, "แอปเป็นเวอร์ชันล่าสุดแล้ว (v1.0." + mine + ")", Toast.LENGTH_LONG).show());
                }
            } catch (Exception ignored) {
                p.edit().putLong("upd_checked", 0).apply();   // เน็ตไม่มี → ลองใหม่ครั้งหน้า
            }
        }).start();
    }

    static int latestVersion() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(REPO + "/releases/latest").openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        c.setRequestMethod("HEAD");
        String loc = c.getHeaderField("Location");
        c.disconnect();
        if (loc == null) throw new Exception("no redirect");
        Matcher m = Pattern.compile("/tag/v\\d+\\.\\d+\\.(\\d+)").matcher(loc);
        if (!m.find()) throw new Exception("bad tag " + loc);
        return Integer.parseInt(m.group(1));
    }

    static int installedVersion(Context ctx) {
        try {
            return (int) androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(
                ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0));
        } catch (Exception e) {
            return Integer.MAX_VALUE;
        }
    }

    private static void ask(Activity a, int latest) {
        if (a.isFinishing() || dialogShowing) return;
        dialogShowing = true;
        new AlertDialog.Builder(a)
            .setTitle("📲 มีแอป OEE เวอร์ชันใหม่")
            .setMessage("เวอร์ชัน v1.0." + latest + " พร้อมให้อัปเดตแล้ว\n\nกด \"อัปเดต\" แอปจะดาวน์โหลดและเปิดหน้าติดตั้งให้ — ข้อมูลและการแจ้งเตือนเดิมไม่หาย")
            .setPositiveButton("อัปเดต", (d, w) -> download(a, latest))
            .setNegativeButton("ภายหลัง", null)
            .setOnDismissListener(d -> dialogShowing = false)
            .show();
    }

    private static void download(Activity a, int v) {
        String name = "OEE-v1.0." + v + ".apk";
        String url = REPO + "/releases/download/v1.0." + v + "/" + name;
        // Android 8+: ต้องอนุญาต "ติดตั้งแอปที่ไม่รู้จัก" ให้แอปนี้ครั้งแรก
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(a, "อนุญาต \"ติดตั้งแอปที่ไม่รู้จัก\" ให้ OEE แล้วกดย้อนกลับ — ระหว่างนี้กำลังดาวน์โหลด", Toast.LENGTH_LONG).show();
            try {
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            } catch (Exception ignored) { }
        }
        try {
            DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                .setTitle("อัปเดตแอป OEE v1.0." + v)
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            long id = dm.enqueue(r);
            Toast.makeText(a, "กำลังดาวน์โหลดอัปเดต…", Toast.LENGTH_SHORT).show();
            Context app = a.getApplicationContext();
            BroadcastReceiver done = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) {
                    if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                    try { app.unregisterReceiver(this); } catch (Exception ignored) { }
                    Uri apk = dm.getUriForDownloadedFile(id);
                    if (apk == null) { openInBrowser(app, url); return; }
                    Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(apk, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { app.startActivity(install); } catch (Exception e) { openInBrowser(app, url); }
                }
            };
            ContextCompat.registerReceiver(app, done, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED);
        } catch (Exception e) {
            openInBrowser(a, url);   // สำรอง: ให้เบราว์เซอร์ดาวน์โหลดแทน
        }
    }

    private static void openInBrowser(Context c, String url) {
        try {
            c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) { }
    }
}

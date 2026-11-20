package com.tsgp.oee;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * ส่งรหัสเครื่อง (FCM token) ไปลงทะเบียนกับตัวเฝ้าดูงานแจ้งซ่อม (oee-notify) อัตโนมัติ
 * ที่อยู่ของตัวเฝ้าดูอ่านจาก app-config.json บน GitHub Pages → เปลี่ยนที่อยู่ได้โดยไม่ต้องออกแอปใหม่
 */
public final class Registrar {
    private static final String CONFIG_URL = "https://jotbot196-design.github.io/oee-factor.occ/app-config.json";

    private Registrar() { }

    /** อ่านที่อยู่ตัวเฝ้าดูจาก app-config.json แล้วจำไว้ */
    private static String loadNotifyUrl(Context app) throws Exception {
        String cfg = http("GET", CONFIG_URL + "?t=" + System.currentTimeMillis(), null);
        String u = new JSONObject(cfg).optString("notifyUrl", "").trim();
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        app.getSharedPreferences(OeeMessagingService.PREFS, Context.MODE_PRIVATE).edit().putString("notify_url", u).apply();
        return u;
    }

    /** ช่างเพิ่งส่งแจ้งซ่อม → สะกิดตัวเฝ้าดูให้เช็คเว็บทันที (แจ้งเตือนถึงทุกเครื่องใน 1–2 วินาที) */
    public static void kick(Context ctx) {
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                String u = app.getSharedPreferences(OeeMessagingService.PREFS, Context.MODE_PRIVATE).getString("notify_url", "");
                if (u.isEmpty()) u = loadNotifyUrl(app);
                if (!u.isEmpty()) http("POST", u + "/kick", "{}");
            } catch (Exception ignored) { }
        }).start();
    }

    public static void register(Context ctx, String token) {
        if (token == null || token.isEmpty()) return;
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                String notifyUrl = loadNotifyUrl(app);
                if (notifyUrl.isEmpty()) return;
                JSONObject body = new JSONObject().put("token", token).put("platform", "android-app");
                http("POST", notifyUrl + "/register", body.toString());
                app.getSharedPreferences(OeeMessagingService.PREFS, Context.MODE_PRIVATE)
                    .edit().putLong("registered_at", System.currentTimeMillis()).apply();
            } catch (Exception ignored) {
                // ไม่มีเน็ต / ยังไม่ตั้งค่า → ลองใหม่ครั้งหน้าที่เปิดแอป
            }
        }).start();
    }

    private static String http(String method, String url, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        if (json != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(json.getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        try (InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while (is != null && (n = is.read(buf)) > 0) out.write(buf, 0, n);
            if (code >= 400) throw new Exception("HTTP " + code);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }
}

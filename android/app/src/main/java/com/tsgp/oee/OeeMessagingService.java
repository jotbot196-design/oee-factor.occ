package com.tsgp.oee;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * รับแจ้งเตือนจาก Firebase ตรงเข้าแอป (ไม่ผ่าน Chrome)
 *
 * ข้อความแบบ data: { type, title, body, page, tag }
 *   type = "breakdown" → ช่อง "เครื่องเสีย": เสียงบี๊บด่วน ดังวนซ้ำจนกว่าจะกด "รับทราบ" / เปิดดู
 *   type อื่น          → ช่อง "แจ้งเตือนทั่วไป": เสียงติ๊งสองโน้ต ดังครั้งเดียว
 */
public class OeeMessagingService extends FirebaseMessagingService {

    public static final String PREFS = "oee_push";
    public static final String CH_BREAKDOWN = "oee_breakdown_v1";
    public static final String CH_NORMAL = "oee_normal_v1";
    private static final String OLD_CHANNEL = "oee_alerts";

    private static final long[] VIBRATE_BREAKDOWN = {0, 800, 300, 800, 300, 800, 600};
    private static final long[] VIBRATE_NORMAL = {0, 250, 150, 250};

    /** สร้างช่องแจ้งเตือน 2 แบบ (เรียกซ้ำได้) — เสียงของช่องเปลี่ยนภายหลังไม่ได้ จึงตั้งชื่อช่องมีเวอร์ชัน */
    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(OLD_CHANNEL) != null) nm.deleteNotificationChannel(OLD_CHANNEL);
        AudioAttributes alarmAttr = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        AudioAttributes notiAttr = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();

        if (nm.getNotificationChannel(CH_BREAKDOWN) == null) {
            NotificationChannel ch = new NotificationChannel(CH_BREAKDOWN, "🔴 เครื่องเสีย (ด่วน)", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("เสียงเตือนดังวนจนกว่าจะกดรับทราบ");
            ch.setSound(Alerts.sound(ctx, R.raw.alarm_breakdown), alarmAttr);
            ch.enableVibration(true);
            ch.setVibrationPattern(VIBRATE_BREAKDOWN);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_NORMAL) == null) {
            NotificationChannel ch = new NotificationChannel(CH_NORMAL, "📦 สต็อก / PPM / ทั่วไป", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("แจ้งเตือนทั่วไป เสียงสั้นครั้งเดียว");
            ch.setSound(Alerts.sound(ctx, R.raw.chime_normal), notiAttr);
            ch.enableVibration(true);
            ch.setVibrationPattern(VIBRATE_NORMAL);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("token", token).putBoolean("code_shown", false).apply();
        Registrar.register(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        Map<String, String> data = msg.getData();
        String title = msg.getNotification() != null && msg.getNotification().getTitle() != null
            ? msg.getNotification().getTitle() : data.getOrDefault("title", "OEE");
        String body = msg.getNotification() != null && msg.getNotification().getBody() != null
            ? msg.getNotification().getBody() : data.getOrDefault("body", "");
        String tag = data.get("tag");
        if (tag != null && !tag.isEmpty()) {
            android.content.SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            long last = sp.getLong("seen_" + tag, 0);
            if (System.currentTimeMillis() - last < 10 * 60_000L) return;   // แจ้งเรื่องนี้ไปแล้ว ไม่แจ้งซ้ำ
            sp.edit().putLong("seen_" + tag, System.currentTimeMillis()).apply();
        }
        int id = tag != null && !tag.isEmpty() ? tag.hashCode() : (int) (System.currentTimeMillis() & 0x7fffffff);
        Alerts.show(this, data.getOrDefault("type", "normal"), title, body, data.getOrDefault("page", ""), id);
    }
}

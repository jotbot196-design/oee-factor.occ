package com.tsgp.oee;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

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

    private static Uri sound(Context ctx, int res) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + res);
    }

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
            ch.setSound(sound(ctx, R.raw.alarm_breakdown), alarmAttr);
            ch.enableVibration(true);
            ch.setVibrationPattern(VIBRATE_BREAKDOWN);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_NORMAL) == null) {
            NotificationChannel ch = new NotificationChannel(CH_NORMAL, "📦 สต็อก / PPM / ทั่วไป", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("แจ้งเตือนทั่วไป เสียงสั้นครั้งเดียว");
            ch.setSound(sound(ctx, R.raw.chime_normal), notiAttr);
            ch.enableVibration(true);
            ch.setVibrationPattern(VIBRATE_NORMAL);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("token", token).putBoolean("code_shown", false).apply();
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        ensureChannels(this);
        Map<String, String> data = msg.getData();
        String title = msg.getNotification() != null && msg.getNotification().getTitle() != null
            ? msg.getNotification().getTitle() : data.getOrDefault("title", "OEE");
        String body = msg.getNotification() != null && msg.getNotification().getBody() != null
            ? msg.getNotification().getBody() : data.getOrDefault("body", "");
        String page = data.getOrDefault("page", "");
        boolean breakdown = "breakdown".equals(data.get("type"));
        String tag = data.get("tag");
        int id = tag != null && !tag.isEmpty() ? tag.hashCode() : (int) (System.currentTimeMillis() & 0x7fffffff);

        // แตะที่แจ้งเตือน → เปิดแอปหน้าที่เกี่ยวข้อง (และหยุดเสียง)
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("page", page);
        PendingIntent openPi = PendingIntent.getActivity(this, id, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, breakdown ? CH_BREAKDOWN : CH_NORMAL)
            .setSmallIcon(R.drawable.ic_stat_oee)
            .setColor(ContextCompat.getColor(this, breakdown ? R.color.oee_red : R.color.oee_amber))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(breakdown ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(sound(this, breakdown ? R.raw.alarm_breakdown : R.raw.chime_normal))   // Android 7 ลงไป
            .setVibrate(breakdown ? VIBRATE_BREAKDOWN : VIBRATE_NORMAL)
            .setAutoCancel(true)
            .setContentIntent(openPi);

        if (breakdown) {
            // ปุ่ม "รับทราบ" → ปิดแจ้งเตือน = หยุดเสียง
            Intent ack = new Intent(this, AckReceiver.class).putExtra(AckReceiver.EXTRA_ID, id);
            PendingIntent ackPi = PendingIntent.getBroadcast(this, id, ack,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(0, "✅ รับทราบ", ackPi);
            b.setOngoing(true); // ปัดทิ้งไม่ได้ ต้องกดรับทราบหรือเปิดดู
        }

        Notification n = b.build();
        if (breakdown) n.flags |= Notification.FLAG_INSISTENT; // เสียงดังวนซ้ำจนกว่าจะรับทราบ

        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, n);
        } catch (SecurityException ignored) {
            // ยังไม่ได้อนุญาตแจ้งเตือน
        }
    }
}

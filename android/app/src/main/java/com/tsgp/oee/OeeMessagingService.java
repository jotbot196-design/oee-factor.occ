package com.tsgp.oee;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * รับแจ้งเตือนจาก Firebase ตรงเข้าแอป (ไม่ผ่าน Chrome)
 * - แอปอยู่เบื้องหลัง/ปิดอยู่: ระบบ Google แสดงแจ้งเตือนเอง (ช่อง oee_alerts)
 * - แอปเปิดอยู่: มาที่ onMessageReceived แล้วแอปแสดงแจ้งเตือนเอง
 */
public class OeeMessagingService extends FirebaseMessagingService {

    public static final String CHANNEL_ID = "oee_alerts";
    public static final String PREFS = "oee_push";

    /** สร้างช่องแจ้งเตือน "สำคัญ" (มีเสียง + เด้งบนจอ) — เรียกซ้ำได้ไม่เป็นไร */
    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "แจ้งเตือน OEE (เครื่องเสีย / สต็อก / PPM)",
            NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("แจ้งเตือนเรื่องด่วนจากระบบ OEE");
        ch.enableVibration(true);
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        nm.createNotificationChannel(ch);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("token", token).putBoolean("code_shown", false).apply();
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        ensureChannel(this);
        Map<String, String> data = msg.getData();
        String title = msg.getNotification() != null && msg.getNotification().getTitle() != null
            ? msg.getNotification().getTitle() : data.getOrDefault("title", "OEE");
        String body = msg.getNotification() != null && msg.getNotification().getBody() != null
            ? msg.getNotification().getBody() : data.getOrDefault("body", "");
        String page = data.getOrDefault("page", "");

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("page", page);
        int id = (int) (System.currentTimeMillis() & 0x7fffffff);
        PendingIntent pi = PendingIntent.getActivity(this, id, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_oee)
            .setColor(ContextCompat.getColor(this, R.color.oee_amber))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // ยังไม่ได้อนุญาตแจ้งเตือน
        }
    }
}

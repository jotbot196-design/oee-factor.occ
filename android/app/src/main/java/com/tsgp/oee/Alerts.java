package com.tsgp.oee;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * แสดงแจ้งเตือน + ระบบ "ดังซ้ำ" สำหรับเครื่องเสีย
 * - เครื่องเสีย: เสียงวนจนกว่าจะรับทราบ ถ้าผู้ใช้กดปุ่มลดเสียง (เสียงเงียบ) แต่ยังไม่รับทราบ
 *   จะดังขึ้นใหม่ทุก REALERT_MINUTES นาที จนกว่าจะกด "รับทราบ" หรือแตะเปิดดู
 */
public final class Alerts {
    public static final int REALERT_MINUTES = 3;

    static final String EXTRA_ID = "notif_id";
    static final String EXTRA_TYPE = "type";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_PAGE = "page";

    private static final long[] VIBRATE_BREAKDOWN = {0, 800, 300, 800, 300, 800, 600};
    private static final long[] VIBRATE_NORMAL = {0, 250, 150, 250};

    private Alerts() { }

    static Uri sound(Context ctx, int res) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + res);
    }

    public static void show(Context ctx, String type, String title, String body, String page, int id) {
        OeeMessagingService.ensureChannels(ctx);
        boolean breakdown = "breakdown".equals(type);

        // แตะที่แจ้งเตือน → เปิดแอปหน้าที่เกี่ยวข้อง (ถือว่ารับทราบ)
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("page", page);
        open.putExtra(EXTRA_ID, id);
        PendingIntent openPi = PendingIntent.getActivity(ctx, id, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx,
                breakdown ? OeeMessagingService.CH_BREAKDOWN : OeeMessagingService.CH_NORMAL)
            .setSmallIcon(R.drawable.ic_stat_oee)
            .setColor(ContextCompat.getColor(ctx, breakdown ? R.color.oee_red : R.color.oee_amber))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(breakdown ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(sound(ctx, breakdown ? R.raw.alarm_breakdown : R.raw.chime_normal))   // Android 7 ลงไป
            .setVibrate(breakdown ? VIBRATE_BREAKDOWN : VIBRATE_NORMAL)
            .setAutoCancel(true)
            .setContentIntent(openPi);

        if (breakdown) {
            Intent ack = new Intent(ctx, AckReceiver.class).putExtra(EXTRA_ID, id);
            PendingIntent ackPi = PendingIntent.getBroadcast(ctx, id, ack,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(0, "✅ รับทราบ", ackPi);
            b.setOngoing(true); // ปัดทิ้งไม่ได้ ต้องกดรับทราบหรือเปิดดู
        }

        Notification n = b.build();
        if (breakdown) n.flags |= Notification.FLAG_INSISTENT; // เสียงดังวนซ้ำ

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            nm.cancel(id);      // ให้เสียงเริ่มใหม่ทุกครั้งที่ดังซ้ำ
            nm.notify(id, n);
        } catch (SecurityException ignored) {
            return; // ยังไม่ได้อนุญาตแจ้งเตือน
        }
        if (breakdown) scheduleRealert(ctx, type, title, body, page, id);
    }

    private static PendingIntent realertIntent(Context ctx, String type, String title, String body, String page, int id, int flags) {
        Intent i = new Intent(ctx, RealertReceiver.class)
            .putExtra(EXTRA_ID, id).putExtra(EXTRA_TYPE, type)
            .putExtra(EXTRA_TITLE, title).putExtra(EXTRA_BODY, body).putExtra(EXTRA_PAGE, page);
        return PendingIntent.getBroadcast(ctx, id, i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static void scheduleRealert(Context ctx, String type, String title, String body, String page, int id) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = realertIntent(ctx, type, title, body, page, id, PendingIntent.FLAG_UPDATE_CURRENT);
        long at = SystemClock.elapsedRealtime() + REALERT_MINUTES * 60_000L;
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
        try {
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
        }
    }

    /** ยกเลิกการดังซ้ำ (เมื่อรับทราบ / เปิดดู) */
    static void acknowledge(Context ctx, int id) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(id);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = realertIntent(ctx, "", "", "", "", id, PendingIntent.FLAG_NO_CREATE);
        if (am != null && pi != null) { am.cancel(pi); pi.cancel(); }
    }

    /** แจ้งเตือนนี้ยังค้างอยู่บนเครื่องไหม (ยังไม่มีใครรับทราบ/เปิดดู) */
    static boolean isActive(Context ctx, int id) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        for (StatusBarNotification s : nm.getActiveNotifications()) if (s.getId() == id) return true;
        return false;
    }
}

package com.tsgp.oee;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** ปุ่ม "รับทราบ" ในแจ้งเตือนเครื่องเสีย → ปิดแจ้งเตือนและหยุดเสียง */
public class AckReceiver extends BroadcastReceiver {
    public static final String EXTRA_ID = "notif_id";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        int id = intent.getIntExtra(EXTRA_ID, 0);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(id);
        Toast.makeText(ctx, "รับทราบแล้ว", Toast.LENGTH_SHORT).show();
    }
}

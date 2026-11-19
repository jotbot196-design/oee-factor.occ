package com.tsgp.oee;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** ปุ่ม "รับทราบ" ในแจ้งเตือนเครื่องเสีย → ปิดแจ้งเตือน หยุดเสียง และหยุดการดังซ้ำ */
public class AckReceiver extends BroadcastReceiver {
    public static final String EXTRA_ID = Alerts.EXTRA_ID;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        Alerts.acknowledge(ctx, intent.getIntExtra(EXTRA_ID, 0));
        Toast.makeText(ctx, "รับทราบแล้ว", Toast.LENGTH_SHORT).show();
    }
}

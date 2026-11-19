package com.tsgp.oee;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** ครบ 3 นาทีแล้ว แจ้งเตือนเครื่องเสียยังค้าง (ยังไม่รับทราบ) → ดังใหม่ */
public class RealertReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        int id = i.getIntExtra(Alerts.EXTRA_ID, 0);
        if (!Alerts.isActive(ctx, id)) return; // รับทราบ / เปิดดูไปแล้ว
        Alerts.show(ctx, i.getStringExtra(Alerts.EXTRA_TYPE), i.getStringExtra(Alerts.EXTRA_TITLE),
            i.getStringExtra(Alerts.EXTRA_BODY), i.getStringExtra(Alerts.EXTRA_PAGE), id);
    }
}

package com.tsgp.oee;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * แอป OEE: เปิดเว็บ https://oee-web.sasatornua.workers.dev/ แบบเต็มจอ
 * เพิ่มเติมจาก Capacitor ปกติ (ไม่ได้แก้เว็บ):
 *  - ปุ่มแนบรูป -> เลือกได้ทั้ง "ถ่ายรูปด้วยกล้อง" และ "เลือกจากคลังรูป"
 *  - การดาวน์โหลดไฟล์ อยู่ใน DownloadPlugin.java
 *  - แจ้งเตือนผ่าน Firebase (OeeMessagingService.java): ขออนุญาตแจ้งเตือน + ขอยกเว้นการประหยัดแบต
 */
public class MainActivity extends BridgeActivity {

    private static final String APP_URL = "https://oee-web.sasatornua.workers.dev/";
    /** โหมดทดสอบ: แสดงรหัสเครื่องให้คัดลอกส่งผู้ดูแล (ปิดเมื่อมีระบบหลังบ้านเก็บรหัสเอง) */
    private static final boolean TEST_PUSH = true;

    // ---------- 1) แจ้งเตือน ----------
    private final ActivityResultLauncher<String> notifPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> afterNotificationPermission());

    private SharedPreferences prefs() { return getSharedPreferences(OeeMessagingService.PREFS, MODE_PRIVATE); }

    private void setupPush() {
        OeeMessagingService.ensureChannels(this);
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
        } else {
            afterNotificationPermission();
        }
    }

    private void afterNotificationPermission() {
        askBatteryExemptionOnce(() -> FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            SharedPreferences p = prefs();
            boolean changed = !token.equals(p.getString("token", ""));
            p.edit().putString("token", token).apply();
            Registrar.register(this, token); // ลงทะเบียนรับแจ้งเตือนงานแจ้งซ่อมอัตโนมัติ
            if (TEST_PUSH && (changed || !p.getBoolean("code_shown", false))) showPushCode(token);
        }));
    }

    /** ขอให้แอปไม่ถูกจำกัดแบต (ถามครั้งเดียว) — แจ้งเตือนเครื่องเสียจะมาทันทีแม้ปิดจอ */
    private void askBatteryExemptionOnce(Runnable next) {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        if (ignoring || prefs().getBoolean("battery_asked", false)) { next.run(); return; }
        prefs().edit().putBoolean("battery_asked", true).apply();
        new AlertDialog.Builder(this)
            .setTitle("ให้แจ้งเตือนมาทันที")
            .setMessage("เพื่อให้แจ้งเตือนเครื่องเสีย / สต็อกต่ำ เด้งทันทีแม้ปิดจอ\nหน้าถัดไปให้กด \"อนุญาต\"")
            .setCancelable(false)
            .setPositiveButton("ตกลง", (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) { }
                next.run();
            })
            .setNegativeButton("ไว้ทีหลัง", (d, w) -> next.run())
            .show();
    }

    private void showPushCode(String token) {
        String code = "OEEAPP:" + token;
        prefs().edit().putBoolean("code_shown", true).apply();
        new AlertDialog.Builder(this)
            .setTitle("✅ เปิดรับแจ้งเตือนแล้ว")
            .setMessage("สำหรับผู้ทดสอบ: ส่งรหัสนี้ให้ผู้ดูแลระบบ\n(ดูอีกครั้งได้: กดค้างที่ไอคอน OEE → รหัสแจ้งเตือน)")
            .setPositiveButton("📋 คัดลอกรหัส", (d, w) -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("OEE push code", code));
                Toast.makeText(this, "คัดลอกแล้ว", Toast.LENGTH_SHORT).show();
            })
            .setNeutralButton("ส่งต่อ (LINE ฯลฯ)", (d, w) -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, code);
                startActivity(Intent.createChooser(send, "ส่งรหัสแจ้งเตือน"));
            })
            .setNegativeButton("ปิด", null)
            .show();
    }

    /** เปิดจากแจ้งเตือน (page) หรือจากทางลัด "รหัสแจ้งเตือน" */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if ("com.tsgp.oee.SHOW_PUSH_CODE".equals(intent.getAction())) {
            String t = prefs().getString("token", "");
            if (!t.isEmpty()) showPushCode(t);
            else Toast.makeText(this, "ยังไม่มีรหัส ลองเปิดแอปใหม่อีกครั้ง", Toast.LENGTH_LONG).show();
            return;
        }
        if (intent.hasExtra(Alerts.EXTRA_ID)) Alerts.acknowledge(this, intent.getIntExtra(Alerts.EXTRA_ID, 0)); // เปิดดู = รับทราบ
        String page = intent.getStringExtra("page");
        if (page != null && !page.isEmpty() && getBridge() != null) {
            getBridge().getWebView().loadUrl(APP_URL + "?page=" + Uri.encode(page));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    // ---------- 2) ปุ่มแนบรูป: กล้อง + คลังรูป ----------
    private ValueCallback<Uri[]> pendingFileCallback;
    private WebChromeClient.FileChooserParams pendingParams;
    private Uri cameraOutputUri;

    private final ActivityResultLauncher<String> cameraPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> launchChooser(granted));

    private final ActivityResultLauncher<Intent> chooserLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = pendingFileCallback;
            pendingFileCallback = null;
            if (cb == null) return;
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == Activity.RESULT_OK) {
                if (data != null && data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int k = 0; k < n; k++) uris[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data != null && data.getData() != null) {
                    uris = new Uri[] { data.getData() };
                } else if (cameraOutputUri != null) {
                    uris = new Uri[] { cameraOutputUri };
                }
            }
            cameraOutputUri = null;
            cb.onReceiveValue(uris); // ต้องเรียกเสมอ (null = ยกเลิก) ไม่งั้นปุ่มแนบรูปจะกดไม่ได้อีก
        });

    private class OeeChromeClient extends BridgeWebChromeClient {
        OeeChromeClient() { super(MainActivity.this.getBridge()); }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
            if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = filePathCallback;
            pendingParams = fileChooserParams;
            if (wantsImages(fileChooserParams)
                && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
            } else {
                launchChooser(true);
            }
            return true;
        }
    }

    private static boolean wantsImages(WebChromeClient.FileChooserParams p) {
        if (p == null || p.getAcceptTypes() == null) return true;
        for (String t : p.getAcceptTypes()) {
            if (t == null || t.isEmpty() || t.startsWith("image")) return true;
        }
        return false;
    }

    private void launchChooser(boolean cameraAllowed) {
        if (pendingFileCallback == null) return;
        try {
            WebChromeClient.FileChooserParams p = pendingParams;
            String type = "*/*";
            if (p != null && p.getAcceptTypes() != null && p.getAcceptTypes().length > 0
                && p.getAcceptTypes()[0] != null && !p.getAcceptTypes()[0].isEmpty()) {
                type = p.getAcceptTypes()[0];
            }
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType(type);
            if (p != null && p.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }

            List<Intent> extras = new ArrayList<>();
            cameraOutputUri = null;
            if (cameraAllowed && wantsImages(p)) {
                File photo = new File(getCacheDir(), "cam_" + System.currentTimeMillis() + ".jpg");
                cameraOutputUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photo);
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                extras.add(cam);
            }

            Intent chooser = Intent.createChooser(pick, "แนบรูป");
            if (!extras.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toArray(new Intent[0]));
            chooserLauncher.launch(chooser);
        } catch (Exception e) {
            ValueCallback<Uri[]> cb = pendingFileCallback;
            pendingFileCallback = null;
            if (cb != null) cb.onReceiveValue(null);
            Toast.makeText(this, "เปิดตัวเลือกไฟล์ไม่ได้", Toast.LENGTH_LONG).show();
        }
    }

    // ---------- เริ่มต้น ----------
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ต้องลงทะเบียนก่อน super.onCreate เพื่อให้ตัวรับดาวน์โหลดพร้อมก่อนหน้าเว็บโหลด
        registerPlugin(DownloadPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebChromeClient(new OeeChromeClient());
        setupPush();
        // หมายเหตุ: Capacitor เรียก onNewIntent(getIntent()) ให้เองตอนเริ่มแอป จึงไม่ต้องเรียก handleIntent ซ้ำ
    }
}

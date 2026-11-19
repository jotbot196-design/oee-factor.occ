"""สร้างไฟล์สำหรับหน้าติดตั้ง (GitHub Pages) ในโฟลเดอร์ docs/

- docs/OEE.mobileconfig : ไฟล์ติดตั้งไอคอน OEE บน iPhone (Web Clip, เปิดเต็มจอ)
- docs/icon-180.png     : ไอคอนแอป
- docs/qr.png           : QR Code ลิงก์หน้าติดตั้ง

รัน: python3 tools/make_install_site.py
"""
import os
import plistlib
import sys
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from make_icons import glyph, BG  # noqa: E402

import segno  # pip install segno

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
APP_URL = "https://oee-web.sasatornua.workers.dev/"
PAGE_URL = "https://jotbot196-design.github.io/oee-factor.occ/"

# UUID คงที่ เพื่อให้ติดตั้งซ้ำแล้ว "แทนที่" ของเดิม ไม่เกิดไอคอนซ้ำ
PROFILE_UUID = str(uuid.uuid5(uuid.NAMESPACE_URL, "com.tsgp.oee.profile"))
CLIP_UUID = str(uuid.uuid5(uuid.NAMESPACE_URL, "com.tsgp.oee.webclip"))

os.makedirs(DOCS, exist_ok=True)

icon = glyph(180, 1.0, BG).convert("RGB")
icon_path = os.path.join(DOCS, "icon-180.png")
icon.save(icon_path, optimize=True)
with open(icon_path, "rb") as f:
    icon_bytes = f.read()

profile = {
    "PayloadType": "Configuration",
    "PayloadVersion": 1,
    "PayloadIdentifier": "com.tsgp.oee.profile",
    "PayloadUUID": PROFILE_UUID,
    "PayloadDisplayName": "OEE โรงงาน",
    "PayloadDescription": "เพิ่มไอคอน OEE บนหน้าจอโฮม กดแล้วเปิดระบบ OEE แบบเต็มจอ "
                          "(โปรไฟล์นี้สร้างไอคอนอย่างเดียว ไม่ได้อ่านหรือควบคุมข้อมูลในเครื่อง)",
    "PayloadOrganization": "OEE",
    "PayloadRemovalDisallowed": False,
    "PayloadContent": [
        {
            "PayloadType": "com.apple.webClip.managed",
            "PayloadVersion": 1,
            "PayloadIdentifier": "com.tsgp.oee.webclip",
            "PayloadUUID": CLIP_UUID,
            "PayloadDisplayName": "ไอคอน OEE",
            "Label": "OEE",
            "URL": APP_URL,
            "Icon": icon_bytes,
            "FullScreen": True,
            "IsRemovable": True,
            "Precomposed": True,
        }
    ],
}
with open(os.path.join(DOCS, "OEE.mobileconfig"), "wb") as f:
    plistlib.dump(profile, f, fmt=plistlib.FMT_XML)

# ไอคอนสำหรับแอปหน้าจอโฮม (manifest)
for size in (192, 512):
    glyph(size, 1.0, BG).convert("RGB").save(os.path.join(DOCS, f"icon-{size}.png"), optimize=True)

segno.make(PAGE_URL, error="m").save(os.path.join(DOCS, "qr.png"), scale=12, border=2,
                                     dark="#12181D", light="#FFFFFF")
print("ok:", os.listdir(DOCS))

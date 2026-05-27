"""初始化資料：管理者帳號 + 範例問卷（JSON 儲存版）"""
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# .env
env_file = BASE_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

from lib import store
from lib.auth import hash_password


def now():
    return datetime.now(timezone.utc).isoformat()


print("🌱 開始初始化資料...\n")

email = os.environ.get("DEFAULT_ADMIN_EMAIL", "admin@example.com")
password = os.environ.get("DEFAULT_ADMIN_PASSWORD", "Admin@123456")
name = os.environ.get("DEFAULT_ADMIN_NAME", "系統管理員")

# 1. 超管
if store.find_one("admin_users", lambda u: u.get("email") == email):
    print(f"✓ 管理者 {email} 已存在")
else:
    store.insert("admin_users", {
        "name": name, "email": email,
        "password_hash": hash_password(password),
        "role": "super", "is_active": 1,
        "last_login_at": None, "created_at": now(),
    })
    print(f"✓ 已建立超管 {email} / {password}\n  ⚠️ 請上線前修改！")

# 2. 現場工作人員
staff_email = "staff@example.com"
if not store.find_one("admin_users", lambda u: u.get("email") == staff_email):
    store.insert("admin_users", {
        "name": "現場工作人員", "email": staff_email,
        "password_hash": hash_password("Staff@123456"),
        "role": "staff", "is_active": 1,
        "last_login_at": None, "created_at": now(),
    })
    print(f"✓ 已建立現場 {staff_email} / Staff@123456")

# 3. 範例問卷
if store.find_one("surveys", lambda s: s.get("title") == "場域服務滿意度調查"):
    print("✓ 範例問卷已存在")
else:
    s = store.insert("surveys", {
        "title": "場域服務滿意度調查",
        "description": "感謝您撥冗填寫，您的意見是我們持續改進的重要依據。完成可獲得電子贈品兌換券乙張。",
        "location_name": "林口國家檔案館附屬服務設施",
        "start_date": None, "end_date": None,
        "is_active": 1, "generate_coupon": 1,
        "coupon_valid_days": 30, "redemption_interval_days": 30,
        "redemption_location": "服務台（營業時間 09:00-17:00）",
        "coupon_title": "贈品兌換券",
        "coupon_subtitle": "感謝您完成滿意度調查",
        "thank_you_message": "已收到您的意見，感謝您的回饋！",
        "created_at": now(), "updated_at": now(),
    })
    import json
    questions = [
        ("今日來訪目的", "single", 1, ["洽公", "停車", "參觀", "購物", "活動", "其他"], 0, 0),
        ("是否第一次來訪", "single", 1, ["第一次", "曾經來過", "經常使用"], 0, 0),
        ("主要使用服務（可複選）", "multiple", 1, ["停車場", "商店", "餐飲", "展覽", "遊客服務", "其他"], 0, 0),
        ("環境整潔滿意度", "rating", 1, None, 1, 0),
        ("動線與指標清楚度", "rating", 1, None, 1, 0),
        ("服務人員態度", "rating", 1, None, 1, 0),
        ("設備使用便利性", "rating", 1, None, 1, 0),
        ("整體滿意度", "rating", 1, None, 1, 1),
        ("您對本場域還有什麼建議？", "textarea", 0, None, 0, 0),
    ]
    for idx, (txt, typ, req, opts, sat, overall) in enumerate(questions):
        store.insert("survey_questions", {
            "survey_id": s["id"], "question_text": txt, "question_type": typ,
            "is_required": req,
            "options": json.dumps(opts, ensure_ascii=False) if opts else None,
            "sort_order": idx + 1, "is_active": 1,
            "include_in_statistics": 1,
            "is_satisfaction_score": sat, "is_overall_score": overall,
            "created_at": now(), "updated_at": now(),
        })
    print(f"✓ 已建立範例問卷（ID={s['id']}），共 {len(questions)} 題")

print("\n🎉 初始化完成！")
print("▶ 啟動：     python main.py")
print(f"▶ API 健康檢查：http://localhost:3000/api/health")
print(f"▶ 問卷 API：   http://localhost:3000/api/public/surveys/1")

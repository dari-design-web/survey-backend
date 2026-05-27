"""兌換券核心邏輯（JSON 版）"""
from datetime import datetime, timezone, timedelta
from lib import store
from lib.auth import current_admin_id


def _now():
    return datetime.now(timezone.utc)


def _parse(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def generate_coupon_code():
    """產生 GIFT-YYYYMMDD-NNNN"""
    now = datetime.now()
    date_key = now.strftime("%Y%m%d")
    seq = store.coupon_seq(date_key)
    return f"GIFT-{date_key}-{seq:04d}"


def check_eligibility(user_id, survey_id, interval_days=30):
    """規則：
       1) 若有未過期未核銷的券 → 回傳該券
       2) 若最近成功核銷 < interval_days → 拒絕
       3) 否則可發
    """
    now = _now()

    # 1)
    issued = [c for c in store.all_items("coupons")
              if c.get("user_id") == user_id and c.get("status") == "issued"]
    issued.sort(key=lambda c: c.get("issued_at", ""), reverse=True)
    for c in issued:
        exp = _parse(c.get("expires_at"))
        if exp and exp > now:
            return {
                "eligible": False,
                "reason": "existing_coupon",
                "message": "您已有一張尚未使用的有效兌換券。",
                "existing_coupon": c,
            }

    # 2)
    redeemed = [c for c in store.all_items("coupons")
                if c.get("user_id") == user_id and c.get("status") == "redeemed"]
    redeemed.sort(key=lambda c: c.get("redeemed_at", ""), reverse=True)
    if redeemed:
        last = _parse(redeemed[0].get("redeemed_at"))
        if last:
            nxt = last + timedelta(days=interval_days)
            if now < nxt:
                return {
                    "eligible": False,
                    "reason": "interval_not_met",
                    "message": f"您已於 {interval_days} 天內兌換過贈品，下次可兌換日期為 {nxt.strftime('%Y-%m-%d')}。",
                    "next_eligible_date": nxt.isoformat(),
                }

    return {"eligible": True}


def issue_coupon(user_id, survey_id, response_id, valid_days=30):
    code = generate_coupon_code()
    now = _now()
    expires = now + timedelta(days=valid_days)
    coupon = store.insert("coupons", {
        "coupon_code": code,
        "survey_id": survey_id,
        "response_id": response_id,
        "user_id": user_id,
        "qr_code_value": code,
        "status": "issued",
        "issued_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "redeemed_at": None,
        "redeemed_by": None,
        "voided_at": None,
        "voided_by": None,
    })
    store.insert("redemption_logs", {
        "coupon_id": coupon["id"], "user_id": user_id, "action": "issue",
        "status_before": None, "status_after": "issued",
        "admin_user_id": None, "note": "問卷完成發券",
        "created_at": now.isoformat(),
    })
    return coupon


def redeem_coupon(coupon_code, admin_user_id):
    coupon_code = (coupon_code or "").strip()
    c = store.find_one("coupons", lambda x: x.get("coupon_code") == coupon_code)
    if not c:
        return {"ok": False, "status": "invalid", "message": "無效兌換券：查無此編號。"}

    now = _now()
    exp = _parse(c.get("expires_at"))
    if c["status"] == "issued" and exp and now > exp:
        store.update("coupons", c["id"], {"status": "expired"})
        store.insert("redemption_logs", {
            "coupon_id": c["id"], "user_id": c["user_id"], "action": "expire",
            "status_before": "issued", "status_after": "expired",
            "admin_user_id": None, "note": "核銷時偵測為逾期",
            "created_at": now.isoformat(),
        })
        c["status"] = "expired"
        return {"ok": False, "status": "expired", "message": "此券已逾期。", "coupon": c}

    if c["status"] == "redeemed":
        return {
            "ok": False, "status": "already_redeemed",
            "message": f"此券已於 {c.get('redeemed_at')} 使用過。", "coupon": c,
        }
    if c["status"] == "expired":
        return {"ok": False, "status": "expired", "message": "此券已逾期。", "coupon": c}
    if c["status"] == "voided":
        return {"ok": False, "status": "voided", "message": "此券已被作廢。", "coupon": c}
    if c["status"] != "issued":
        return {"ok": False, "status": "invalid", "message": "此券狀態異常。", "coupon": c}

    updated = store.update("coupons", c["id"], {
        "status": "redeemed",
        "redeemed_at": now.isoformat(),
        "redeemed_by": admin_user_id,
    })
    store.insert("redemption_logs", {
        "coupon_id": c["id"], "user_id": c["user_id"], "action": "redeem",
        "status_before": "issued", "status_after": "redeemed",
        "admin_user_id": admin_user_id, "note": "工作人員核銷",
        "created_at": now.isoformat(),
    })
    return {"ok": True, "status": "redeemed", "message": "核銷成功！", "coupon": updated}


def void_coupon(coupon_id, admin_user_id, note=""):
    c = store.get("coupons", coupon_id)
    if not c:
        return {"ok": False, "message": "查無此兌換券。"}
    if c["status"] == "redeemed":
        return {"ok": False, "message": "已核銷之券無法作廢。"}
    if c["status"] == "voided":
        return {"ok": False, "message": "此券已作廢。"}

    before = c["status"]
    store.update("coupons", coupon_id, {
        "status": "voided",
        "voided_at": _now().isoformat(),
        "voided_by": admin_user_id,
    })
    store.insert("redemption_logs", {
        "coupon_id": coupon_id, "user_id": c["user_id"], "action": "void",
        "status_before": before, "status_after": "voided",
        "admin_user_id": admin_user_id, "note": note or "管理者作廢",
        "created_at": _now().isoformat(),
    })
    return {"ok": True, "message": "已作廢。"}


def get_next_eligible_date(user_id, interval_days=30):
    redeemed = [c for c in store.all_items("coupons")
                if c.get("user_id") == user_id and c.get("status") == "redeemed"]
    redeemed.sort(key=lambda c: c.get("redeemed_at", ""), reverse=True)
    if not redeemed:
        return None
    last = _parse(redeemed[0].get("redeemed_at"))
    if not last:
        return None
    return last + timedelta(days=interval_days)

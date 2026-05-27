"""核銷 API"""
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, g
from lib import store
from lib.auth import require_role, audit
from lib.coupon import redeem_coupon, get_next_eligible_date

bp = Blueprint("api_redeem", __name__, url_prefix="/api/redeem")


@bp.route("/lookup", methods=["GET"])
@require_role("super", "admin", "staff")
def lookup():
    code = (request.args.get("code") or "").strip()
    if not code:
        return jsonify(ok=False, message="請提供兌換券編號")
    c = store.find_one("coupons", lambda x: x.get("coupon_code") == code)
    if not c:
        return jsonify(ok=False, message="無效兌換券：查無此編號")
    s = store.get("surveys", c.get("survey_id")) or {}
    u = store.get("users", c.get("user_id")) or {}

    now = datetime.now(timezone.utc)
    try:
        exp = datetime.fromisoformat((c.get("expires_at") or "").replace("Z", "+00:00"))
        display_status = "expired" if c["status"] == "issued" and now > exp else c["status"]
    except Exception:
        display_status = c["status"]

    # 同 user 之前的核銷
    prev = [x for x in store.all_items("coupons")
            if x.get("user_id") == c.get("user_id") and x.get("status") == "redeemed"
            and x.get("id") != c["id"]]
    prev.sort(key=lambda x: x.get("redeemed_at", ""), reverse=True)
    last = prev[0].get("redeemed_at") if prev else None

    nxt = get_next_eligible_date(c["user_id"], s.get("redemption_interval_days", 30))

    return jsonify(ok=True, coupon={
        "id": c["id"], "code": c["coupon_code"], "status": display_status,
        "survey_title": s.get("title"),
        "user": {"name": u.get("name"), "phone": u.get("phone"), "email": u.get("email")},
        "issued_at": c.get("issued_at"), "expires_at": c.get("expires_at"),
        "redeemed_at": c.get("redeemed_at"),
        "lastRedeemedBeforeThis": last,
        "nextEligibleDate": nxt.isoformat() if nxt else None,
    })


@bp.route("", methods=["POST"])
@require_role("super", "admin", "staff")
def do_redeem():
    body = request.get_json(silent=True) or {}
    code = (body.get("code") or "").strip()
    if not code:
        return jsonify(ok=False, message="請提供兌換券編號"), 400
    r = redeem_coupon(code, g.admin_user["id"])
    audit("redeem", "coupon", (r.get("coupon") or {}).get("id"), {"code": code, "status": r.get("status")})
    return jsonify(r)

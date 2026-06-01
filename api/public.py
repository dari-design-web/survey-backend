"""前台公開 API：列出問卷、送出問卷、查詢兌換券（V2.2 加 my-coupons + 清理）"""
import json
import secrets
import threading
from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, jsonify, make_response
from lib import store
from lib.coupon import check_eligibility, issue_coupon

bp = Blueprint("api_public", __name__, url_prefix="/api/public")

DEVICE_COOKIE = "device_id"
DEVICE_COOKIE_MAX_AGE = 365 * 24 * 3600


def _public_survey(s):
    return {
        "id": s["id"], "title": s["title"], "description": s.get("description"),
        "location_name": s.get("location_name"),
        "coupon_title": s.get("coupon_title"), "coupon_subtitle": s.get("coupon_subtitle"),
        "redemption_location": s.get("redemption_location"),
        "thank_you_message": s.get("thank_you_message"),
        "is_active": s.get("is_active"),
        "generate_coupon": s.get("generate_coupon"),
    }


def _public_question(q):
    return {
        "id": q["id"], "question_text": q["question_text"],
        "question_type": q["question_type"], "is_required": q.get("is_required"),
        "options": q.get("options"), "sort_order": q.get("sort_order", 0),
    }


@bp.route("/surveys", methods=["GET"])
def list_surveys():
    today = datetime.now().strftime("%Y-%m-%d")
    items = []
    for s in store.all_items("surveys"):
        if not s.get("is_active"):
            continue
        if s.get("start_date") and s["start_date"] > today:
            continue
        if s.get("end_date") and s["end_date"] < today:
            continue
        items.append(_public_survey(s))
    items.sort(key=lambda x: x["id"], reverse=True)
    return jsonify(surveys=items)


@bp.route("/surveys/<int:sid>", methods=["GET"])
def get_survey(sid):
    s = store.get("surveys", sid)
    if not s:
        return jsonify(error="not_found"), 404
    if not s.get("is_active"):
        return jsonify(error="inactive"), 403
    questions = [
        _public_question(q) for q in store.all_items("survey_questions")
        if q.get("survey_id") == sid and q.get("is_active")
    ]
    questions.sort(key=lambda q: (q.get("sort_order", 0), q["id"]))
    return jsonify(survey=_public_survey(s), questions=questions)


@bp.route("/coupons/<string:code>", methods=["GET"])
def get_coupon(code):
    c = store.find_one("coupons", lambda x: x.get("coupon_code") == code)
    if not c:
        return jsonify(error="not_found"), 404
    s = store.get("surveys", c.get("survey_id"))
    return jsonify(coupon=c, survey=_public_survey(s) if s else None)


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


@bp.route("/my-coupons", methods=["GET"])
def my_coupons():
    """回傳此 device 對應 user 的所有兌換券（含場域資訊）。
    自動清理規則：
      - 已兌換 (redeemed) 且核銷時間 > 30 天 → 從 DB 刪除
      - 已過期 (expired/voided 或 issued 但 expires_at < now-30天) → 從 DB 刪除
      - issued 但已過期但未過 30 天 → 標記為 expired（保留顯示）
    """
    device_id = request.args.get("deviceId") or request.cookies.get(DEVICE_COOKIE)
    if not device_id:
        return jsonify(ok=True, coupons=[], message="no device")

    user = store.find_one("users", lambda x: x.get("external_id") == "device:" + device_id)
    if not user:
        return jsonify(ok=True, coupons=[])

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)

    surveys = {s["id"]: s for s in store.all_items("surveys")}
    user_coupons = [c for c in store.all_items("coupons") if c.get("user_id") == user["id"]]

    keep = []
    to_delete = []
    to_expire = []  # 要從 issued → expired 的 id 清單

    for c in user_coupons:
        status = c.get("status")
        issued_at = _parse_iso(c.get("issued_at"))
        expires_at = _parse_iso(c.get("expires_at"))
        redeemed_at = _parse_iso(c.get("redeemed_at"))
        voided_at = _parse_iso(c.get("voided_at"))

        # 1) 已兌換 → 看核銷時間是否超過 30 天
        if status == "redeemed":
            if redeemed_at and redeemed_at < cutoff:
                to_delete.append(c["id"])
                continue

        # 2) 已作廢 → 看作廢時間是否超過 30 天
        elif status == "voided":
            ref = voided_at or issued_at
            if ref and ref < cutoff:
                to_delete.append(c["id"])
                continue

        # 3) 未兌換 (issued) 但已過期 → 是否要標 expired 或直接刪
        elif status == "issued":
            if expires_at and expires_at < now:
                # 過期 30 天以上 → 刪
                if expires_at < cutoff:
                    to_delete.append(c["id"])
                    continue
                # 過期但未滿 30 天 → 標 expired 仍保留
                to_expire.append(c["id"])
                c["status"] = "expired"  # 立即反映回前端

        # 4) expired → 看過期時間是否超過 30 天
        elif status == "expired":
            if expires_at and expires_at < cutoff:
                to_delete.append(c["id"])
                continue

        # 進入要顯示的清單
        s = surveys.get(c.get("survey_id"), {})
        keep.append({
            "id": c["id"],
            "coupon_code": c.get("coupon_code"),
            "qr_code_value": c.get("qr_code_value"),
            "status": c.get("status"),
            "issued_at": c.get("issued_at"),
            "expires_at": c.get("expires_at"),
            "redeemed_at": c.get("redeemed_at"),
            "survey_id": c.get("survey_id"),
            "survey_title": s.get("title"),
            "location_name": s.get("location_name"),
            "coupon_title": s.get("coupon_title"),
            "redemption_location": s.get("redemption_location"),
        })

    # 排序：未兌換在最前，再依產生時間倒序
    status_order = {"issued": 0, "expired": 1, "redeemed": 2, "voided": 3, "invalid": 4}
    keep.sort(key=lambda c: (status_order.get(c["status"], 9), -1 * (c.get("id") or 0)))

    # 非同步處理刪除/標記，不阻塞回應
    def _cleanup():
        try:
            for cid in to_expire:
                store.update("coupons", cid, {"status": "expired"})
            for cid in to_delete:
                store.delete("coupons", cid)
        except Exception as e:
            print("[my-coupons cleanup]", e)

    if to_delete or to_expire:
        threading.Thread(target=_cleanup, daemon=True).start()

    return jsonify(ok=True, coupons=keep, deleted_count=len(to_delete))


@bp.route("/precheck/<int:sid>", methods=["GET"])
def precheck(sid):
    """前台開頁時呼叫：先檢查此使用者是否能領券，省得填完才發現不能領。
    判斷依據：URL 帶的 deviceId 或 Cookie 裡的 device_id。
    回應：
      { ok: true, eligible: true }                                  # 可填可領
      { ok: true, eligible: false, reason: 'existing_coupon', ...}  # 有未用的券
      { ok: true, eligible: false, reason: 'interval_not_met', ...} # 30 天內已領過
      { ok: true, eligible: 'new' }                                  # 第一次來，當然可領
    """
    s = store.get("surveys", sid)
    if not s or not s.get("is_active"):
        return jsonify(ok=False, message="找不到或已停用的問卷"), 404
    if not s.get("generate_coupon"):
        return jsonify(ok=True, eligible=True, generate_coupon=False)

    device_id = request.args.get("deviceId") or request.cookies.get(DEVICE_COOKIE)
    if not device_id:
        return jsonify(ok=True, eligible="new", generate_coupon=True)

    user = store.find_one("users", lambda x: x.get("external_id") == "device:" + device_id)
    if not user:
        return jsonify(ok=True, eligible="new", generate_coupon=True)

    result = check_eligibility(user["id"], sid, s.get("redemption_interval_days", 30))
    out = {"ok": True, "generate_coupon": True}
    if result.get("eligible"):
        out["eligible"] = True
    else:
        out["eligible"] = False
        out["reason"] = result.get("reason")
        out["message"] = result.get("message")
        if result.get("next_eligible_date"):
            out["nextDate"] = result["next_eligible_date"][:10]
        if result.get("existing_coupon"):
            ec = result["existing_coupon"]
            out["existingCouponCode"] = ec.get("coupon_code")
    return jsonify(out)


def _get_or_create_device_user(device_id):
    external_id = "device:" + device_id
    u = store.find_one("users", lambda x: x.get("external_id") == external_id)
    if u:
        return u
    return store.insert("users", {
        "name": "匿名民眾", "phone": None, "email": None,
        "external_id": external_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


def _build_answer_row(q, v, response_id, now_iso):
    """根據題型，準備一筆 answer 紀錄（不含 id）。回傳 None 代表跳過。"""
    if q["question_type"] == "section":
        return None
    qt = q["question_type"]
    text, value = None, None
    if qt in ("rating", "nps"):
        try:
            value = float(v)
        except Exception:
            value = None
        text = str(v) if v is not None else ""
    elif qt == "multiple":
        arr = v if isinstance(v, list) else ([v] if v else [])
        text = json.dumps(arr, ensure_ascii=False)
    else:
        text = str(v) if v is not None else ""
    return {
        "response_id": response_id,
        "question_id": q["id"],
        "answer_text": text,
        "answer_value": value,
        "created_at": now_iso,
    }


@bp.route("/survey", methods=["POST"])
def submit_survey():
    body = request.get_json(silent=True) or {}
    sid = body.get("surveyId")
    answers = body.get("answers")
    if not sid:
        return jsonify(ok=False, message="缺少 surveyId"), 400
    if not isinstance(answers, list):
        return jsonify(ok=False, message="answers 格式錯誤"), 400

    s = store.get("surveys", int(sid))
    if not s or not s.get("is_active"):
        return jsonify(ok=False, message="找不到或已停用的問卷"), 404

    # 取出所有題目（一次連線）
    questions = {q["id"]: q for q in store.all_items("survey_questions")
                 if q.get("survey_id") == s["id"] and q.get("is_active")}

    # 必填檢查（純記憶體運算，零連線）
    ans_by_q = {int(a.get("questionId")): a for a in answers if a.get("questionId") is not None}
    for q in questions.values():
        if q.get("question_type") == "section":
            continue
        if q.get("is_required"):
            a = ans_by_q.get(q["id"])
            v = a.get("value") if a else None
            empty = (v is None) or (v == "") or (isinstance(v, list) and len(v) == 0)
            if empty:
                title = q['question_text'].split('\n')[0]
                return jsonify(ok=False, message=f"必填題未填：{title}"), 400

    # device_id
    device_id = body.get("deviceId") or request.cookies.get(DEVICE_COOKIE)
    new_cookie = False
    if not device_id:
        device_id = secrets.token_hex(16)
        new_cookie = True

    user = _get_or_create_device_user(device_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    # ============ 批次寫入：response + 所有 answers 各一次 tx ============

    # 1) 寫 survey_responses（單筆，一次連線）
    with store.tx("survey_responses") as data:
        response_id = store.next_id(data)
        response = {
            "id": response_id,
            "survey_id": s["id"],
            "user_id": user["id"],
            "submitted_at": now_iso,
            "ip_address": request.remote_addr,
            "user_agent": request.headers.get("User-Agent"),
        }
        data["items"].append(response)

    # 2) 把所有 answer 在「同一個 tx」內批次寫入（一次連線）
    with store.tx("survey_answers") as data:
        for a in answers:
            qid = a.get("questionId")
            if qid is None:
                continue
            q = questions.get(int(qid))
            if not q:
                continue
            row = _build_answer_row(q, a.get("value"), response_id, now_iso)
            if row is None:
                continue
            row["id"] = store.next_id(data)
            data["items"].append(row)

    # ============ 兌換券 ============
    coupon = None
    coupon_result = {"eligible": False}
    if s.get("generate_coupon"):
        coupon_result = check_eligibility(user["id"], s["id"],
                                           s.get("redemption_interval_days", 30))
        if coupon_result["eligible"]:
            coupon = issue_coupon(user["id"], s["id"], response_id,
                                   s.get("coupon_valid_days", 30),
                                   prefix=s.get("coupon_code_prefix") or "GIFT")

    # ============ 組回應 ============
    # 直接把完整 coupon 物件回傳，前端 success.html 可不必再 GET 一次
    if coupon:
        payload = {"ok": True, "message": "問卷送出成功，兌換券已產生！",
                   "coupon": coupon,
                   "survey": _public_survey(s),
                   "deviceId": device_id}
    elif coupon_result.get("existing_coupon"):
        ec = coupon_result["existing_coupon"]
        payload = {"ok": True, "message": "問卷送出成功，您已有一張未使用的兌換券。",
                   "coupon": ec,
                   "survey": _public_survey(s),
                   "reason": "existing_coupon", "deviceId": device_id}
    elif coupon_result.get("reason") == "interval_not_met":
        payload = {"ok": True, "message": coupon_result["message"],
                   "reason": "interval_not_met",
                   "nextDate": coupon_result.get("next_eligible_date", ""),
                   "deviceId": device_id}
    else:
        payload = {"ok": True, "message": "問卷送出成功，感謝您的回饋！",
                   "deviceId": device_id}

    resp = make_response(jsonify(payload))
    if new_cookie:
        resp.set_cookie(DEVICE_COOKIE, device_id, max_age=DEVICE_COOKIE_MAX_AGE,
                        httponly=False, samesite="None" if request.is_secure else "Lax",
                        secure=request.is_secure)
    return resp

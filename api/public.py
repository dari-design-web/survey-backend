"""前台公開 API：列出問卷、送出問卷、查詢兌換券"""
import json
import secrets
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, make_response
from lib import store
from lib.coupon import check_eligibility, issue_coupon

bp = Blueprint("api_public", __name__, url_prefix="/api/public")

DEVICE_COOKIE = "device_id"
DEVICE_COOKIE_MAX_AGE = 365 * 24 * 3600


def _public_survey(s):
    """過濾敏感欄位"""
    return {
        "id": s["id"], "title": s["title"], "description": s.get("description"),
        "location_name": s.get("location_name"),
        "coupon_title": s.get("coupon_title"), "coupon_subtitle": s.get("coupon_subtitle"),
        "redemption_location": s.get("redemption_location"),
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
    """前台首頁用：列出啟用中問卷"""
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


def _get_or_create_device_user(device_id):
    """以 device_id 為唯一鍵的匿名 user"""
    external_id = "device:" + device_id
    u = store.find_one("users", lambda x: x.get("external_id") == external_id)
    if u:
        return u
    return store.insert("users", {
        "name": "匿名民眾", "phone": None, "email": None,
        "external_id": external_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


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

    questions = {q["id"]: q for q in store.all_items("survey_questions")
                 if q.get("survey_id") == s["id"] and q.get("is_active")}

    # 必填檢查
    ans_by_q = {int(a.get("questionId")): a for a in answers if a.get("questionId") is not None}
    for q in questions.values():
        if q.get("is_required"):
            a = ans_by_q.get(q["id"])
            v = a.get("value") if a else None
            empty = (v is None) or (v == "") or (isinstance(v, list) and len(v) == 0)
            if empty:
                return jsonify(ok=False, message=f"必填題未填：{q['question_text']}"), 400

    # device_id（兩種來源：Cookie 或 body）
    device_id = body.get("deviceId") or request.cookies.get(DEVICE_COOKIE)
    new_cookie = False
    if not device_id:
        device_id = secrets.token_hex(16)
        new_cookie = True

    user = _get_or_create_device_user(device_id)

    response = store.insert("survey_responses", {
        "survey_id": s["id"], "user_id": user["id"],
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "ip_address": request.remote_addr,
        "user_agent": request.headers.get("User-Agent"),
    })

    for a in answers:
        qid = int(a.get("questionId")) if a.get("questionId") else None
        q = questions.get(qid)
        if not q:
            continue
        text, value = None, None
        v = a.get("value")
        if q["question_type"] == "rating":
            try:
                value = float(v)
            except Exception:
                value = None
            text = str(v)
        elif q["question_type"] == "multiple":
            arr = v if isinstance(v, list) else ([v] if v else [])
            text = json.dumps(arr, ensure_ascii=False)
        else:
            text = str(v) if v is not None else ""
        store.insert("survey_answers", {
            "response_id": response["id"], "question_id": q["id"],
            "answer_text": text, "answer_value": value,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    coupon = None
    coupon_result = {"eligible": False}
    if s.get("generate_coupon"):
        coupon_result = check_eligibility(user["id"], s["id"],
                                           s.get("redemption_interval_days", 30))
        if coupon_result["eligible"]:
            coupon = issue_coupon(user["id"], s["id"], response["id"],
                                   s.get("coupon_valid_days", 30))

    # 組回應
    if coupon:
        payload = {"ok": True, "message": "問卷送出成功，兌換券已產生！",
                   "coupon": {"code": coupon["coupon_code"]},
                   "deviceId": device_id}
    elif coupon_result.get("existing_coupon"):
        ec = coupon_result["existing_coupon"]
        payload = {"ok": True, "message": "問卷送出成功，您已有一張未使用的兌換券。",
                   "coupon": {"code": ec["coupon_code"]},
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

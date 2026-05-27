"""統計分析（JSON 版）"""
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from lib import store


def _today():
    return datetime.now().strftime("%Y-%m-%d")


def _month_start():
    return _today()[:7] + "-01"


def _parse(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def dashboard_stats():
    responses = store.all_items("survey_responses")
    questions = store.all_items("survey_questions")
    answers = store.all_items("survey_answers")
    coupons = store.all_items("coupons")

    today = _today()
    mstart = _month_start()

    def submit_date(r):
        d = _parse(r.get("submitted_at"))
        return d.strftime("%Y-%m-%d") if d else ""

    total_responses = len(responses)
    today_responses = sum(1 for r in responses if submit_date(r) == today)
    month_responses = sum(1 for r in responses if submit_date(r) >= mstart)

    # 整體滿意度平均
    overall_q_ids = {q["id"] for q in questions if q.get("is_overall_score")}
    overall_vals = [a["answer_value"] for a in answers
                    if a.get("question_id") in overall_q_ids and a.get("answer_value") is not None]
    overall_avg = round(sum(overall_vals) / len(overall_vals), 2) if overall_vals else None

    # 各滿意度題目平均
    sat_questions = [q for q in questions if q.get("is_satisfaction_score")]
    sat_questions.sort(key=lambda q: q.get("sort_order", 0))
    satisfaction_avg = []
    for q in sat_questions:
        vals = [a["answer_value"] for a in answers
                if a.get("question_id") == q["id"] and a.get("answer_value") is not None]
        if vals:
            satisfaction_avg.append({
                "id": q["id"], "label": q["question_text"],
                "avg": round(sum(vals) / len(vals), 2), "n": len(vals)
            })

    # 兌換券狀態
    coupon_map = {"issued": 0, "redeemed": 0, "expired": 0, "voided": 0, "invalid": 0}
    for c in coupons:
        coupon_map[c.get("status", "invalid")] = coupon_map.get(c.get("status"), 0) + 1
    total_coupons = sum(coupon_map.values())
    redemption_rate = round((coupon_map["redeemed"] / total_coupons * 100), 1) if total_coupons else 0

    # 本月不滿意（整體滿意度 ≤ 2）
    response_dates = {r["id"]: submit_date(r) for r in responses}
    month_negative = len({
        a["response_id"] for a in answers
        if a.get("question_id") in overall_q_ids
        and a.get("answer_value") is not None
        and a["answer_value"] <= 2
        and response_dates.get(a["response_id"], "") >= mstart
    })

    # 每日趨勢（近 30 天）
    today_dt = datetime.now()
    days = [(today_dt - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(29, -1, -1)]
    daily_counter = Counter(submit_date(r) for r in responses)
    daily_trend = [{"d": d, "c": daily_counter.get(d, 0)} for d in days if daily_counter.get(d, 0) > 0]

    # 每月趨勢（近 12 個月）
    monthly_counter = Counter(submit_date(r)[:7] for r in responses if submit_date(r))
    monthly_trend = [{"m": m, "c": c} for m, c in sorted(monthly_counter.items())][-12:]

    # 來訪目的（題目含「來訪目的」）
    purpose_q_ids = {q["id"] for q in questions if "來訪目的" in q.get("question_text", "")}
    purpose_counter = Counter()
    for a in answers:
        if a.get("question_id") in purpose_q_ids and a.get("answer_text"):
            purpose_counter[a["answer_text"]] += 1
    purpose_dist = [{"label": k, "c": v} for k, v in purpose_counter.most_common()]

    # 使用服務（題目含「使用服務」，可能是 multiple → JSON 陣列）
    service_q_ids = {q["id"] for q in questions if "使用服務" in q.get("question_text", "")}
    service_counter = Counter()
    for a in answers:
        if a.get("question_id") not in service_q_ids or not a.get("answer_text"):
            continue
        raw = a["answer_text"]
        try:
            parsed = json.loads(raw)
            items = parsed if isinstance(parsed, list) else [raw]
        except Exception:
            items = [raw]
        for x in items:
            service_counter[x] += 1
    service_dist = [{"label": k, "c": v} for k, v in service_counter.most_common()]

    # 整體滿意度分布
    score_counter = Counter()
    for a in answers:
        if a.get("question_id") in overall_q_ids and a.get("answer_value") is not None:
            score_counter[int(a["answer_value"])] += 1
    overall_dist = [{"score": s, "c": score_counter[s]} for s in sorted(score_counter)]

    # 開放式意見關鍵字
    textarea_q_ids = {q["id"] for q in questions if q.get("question_type") == "textarea"}
    texts = [a["answer_text"] for a in answers
             if a.get("question_id") in textarea_q_ids
             and a.get("answer_text") and len(a["answer_text"]) > 0]
    keywords = count_keywords(texts[-100:])  # 取最近 100 筆

    return {
        "cards": {
            "totalResponses": total_responses,
            "todayResponses": today_responses,
            "monthResponses": month_responses,
            "overallAvg": overall_avg,
            "totalCoupons": total_coupons,
            "issuedCoupons": coupon_map["issued"],
            "redeemedCoupons": coupon_map["redeemed"],
            "expiredCoupons": coupon_map["expired"],
            "voidedCoupons": coupon_map["voided"],
            "redemptionRate": redemption_rate,
            "monthNegative": month_negative,
        },
        "satisfactionAvg": satisfaction_avg,
        "couponStatus": [{"label": k, "c": v} for k, v in coupon_map.items()],
        "dailyTrend": daily_trend,
        "monthlyTrend": monthly_trend,
        "purposeDist": purpose_dist,
        "serviceDist": service_dist,
        "overallDist": overall_dist,
        "keywords": keywords,
    }


def count_keywords(texts):
    categories = {
        "環境整潔": ["整潔", "清潔", "髒", "臭", "亂", "味道"],
        "動線指標": ["動線", "指標", "迷路", "找不到", "指引", "標示"],
        "服務態度": ["態度", "人員", "冷淡", "熱情", "親切", "不耐煩"],
        "設備問題": ["設備", "故障", "壞掉", "當機", "無法使用", "機器"],
        "停車問題": ["停車", "車位", "繳費", "車牌", "充電樁"],
        "價格意見": ["價格", "貴", "便宜", "收費", "費用", "優惠"],
        "排隊等候": ["排隊", "等待", "等候", "人多", "太久"],
        "安全疑慮": ["安全", "危險", "監視", "保全", "昏暗"],
        "其他建議": [],
    }
    counts = {k: 0 for k in categories}
    for text in texts:
        matched = False
        for cat, kws in categories.items():
            if cat == "其他建議":
                continue
            if any(kw in text for kw in kws):
                counts[cat] += 1
                matched = True
        if not matched:
            counts["其他建議"] += 1
    return [{"label": k, "c": v} for k, v in counts.items() if v > 0]

"""JWT 認證與權限"""
import os
import json
from functools import wraps
from datetime import datetime, timedelta, timezone
import bcrypt
import jwt
from flask import request, jsonify, g
from lib import store

ALGO = "HS256"
JWT_TTL_HOURS = 8


def secret():
    return os.environ.get("JWT_SECRET", "dev-secret-change-me")


def hash_password(plain):
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain, hash_):
    if not hash_:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hash_.encode("utf-8"))
    except Exception:
        return False


def sign_token(admin_user):
    payload = {
        "sub": admin_user["id"],
        "name": admin_user["name"],
        "email": admin_user["email"],
        "role": admin_user["role"],
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=JWT_TTL_HOURS)).timestamp()),
    }
    return jwt.encode(payload, secret(), algorithm=ALGO)


def verify_token(token):
    try:
        return jwt.decode(token, secret(), algorithms=[ALGO])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def authenticate(email, password):
    user = store.find_one("admin_users", lambda u: u.get("email") == email)
    if not user or not user.get("is_active", True):
        return None
    if not verify_password(password, user.get("password_hash")):
        return None
    store.update("admin_users", user["id"], {"last_login_at": datetime.now(timezone.utc).isoformat()})
    return {
        "id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]
    }


def _extract_token():
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer "):
        return h[7:].strip()
    # 也支援 query string ?token=（用於檔案下載連結）
    return request.args.get("token")


def require_login(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        tok = _extract_token()
        if not tok:
            return jsonify(error="Unauthorized"), 401
        payload = verify_token(tok)
        if not payload:
            return jsonify(error="Invalid or expired token"), 401
        g.admin_user = {
            "id": payload["sub"],
            "name": payload.get("name"),
            "email": payload.get("email"),
            "role": payload.get("role"),
        }
        return view(*args, **kwargs)
    return wrapper


def require_role(*roles):
    def deco(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            tok = _extract_token()
            if not tok:
                return jsonify(error="Unauthorized"), 401
            payload = verify_token(tok)
            if not payload:
                return jsonify(error="Invalid token"), 401
            if payload.get("role") not in roles:
                return jsonify(error="Forbidden"), 403
            g.admin_user = {
                "id": payload["sub"], "name": payload.get("name"),
                "email": payload.get("email"), "role": payload.get("role"),
            }
            return view(*args, **kwargs)
        return wrapper
    return deco


def current_admin_id():
    return getattr(g, "admin_user", {}).get("id") if hasattr(g, "admin_user") else None


def audit(action, target_type=None, target_id=None, detail=None):
    """寫入 audit_logs"""
    try:
        store.insert("audit_logs", {
            "admin_user_id": current_admin_id(),
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "detail": detail if isinstance(detail, str) else json.dumps(detail or {}, ensure_ascii=False),
            "ip_address": request.remote_addr if request else None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        print("[audit]", e)

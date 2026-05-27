"""認證 API：登入（取 JWT）、me（檢查 token）"""
from flask import Blueprint, request, jsonify, g
from lib.auth import authenticate, sign_token, require_login

bp = Blueprint("api_auth", __name__, url_prefix="/api/auth")


@bp.route("/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    email = body.get("email", "").strip()
    password = body.get("password", "")
    if not email or not password:
        return jsonify(ok=False, error="缺少帳號或密碼"), 400
    user = authenticate(email, password)
    if not user:
        return jsonify(ok=False, error="帳號或密碼錯誤"), 401
    token = sign_token(user)
    return jsonify(ok=True, token=token, user=user)


@bp.route("/me", methods=["GET"])
@require_login
def me():
    return jsonify(user=g.admin_user)

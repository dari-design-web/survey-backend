"""滿意度調查 API 伺服器（純 JSON、CORS 開放、JWT 認證）"""
import os
import sys
from pathlib import Path
from flask import Flask, jsonify
from flask_cors import CORS

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# 載入 .env
env_file = BASE_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

    # CORS：開放給 FRONTEND_ORIGINS（逗號分隔）；若空則開放所有
    origins_env = os.environ.get("FRONTEND_ORIGINS", "*").strip()
    if origins_env == "" or origins_env == "*":
        origins = "*"
    else:
        origins = [o.strip() for o in origins_env.split(",") if o.strip()]
    CORS(app,
         resources={r"/api/*": {"origins": origins}},
         supports_credentials=True,
         allow_headers=["Authorization", "Content-Type"],
         expose_headers=["Content-Disposition"])

    # 反向代理識別
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    # 註冊 Blueprint
    from api.public import bp as public_bp
    from api.auth import bp as auth_bp
    from api.admin import bp as admin_bp
    from api.redeem import bp as redeem_bp
    app.register_blueprint(public_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(redeem_bp)

    # 健康檢查
    @app.route("/")
    def root():
        return jsonify(
            name="Satisfaction Survey API",
            version="1.0",
            status="ok",
            cors_origins=origins,
        )

    @app.route("/api/health")
    def health():
        return jsonify(ok=True)

    @app.errorhandler(404)
    def not_found(e):
        return jsonify(error="not_found"), 404

    @app.errorhandler(500)
    def server_error(e):
        return jsonify(error="internal_error", message=str(e)), 500

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    debug = os.environ.get("FLASK_ENV") != "production"
    origins = os.environ.get("FRONTEND_ORIGINS", "*")
    print("\n📋 滿意度調查 API 伺服器")
    print(f"✅ Listening on port {port}")
    print(f"   CORS 允許網址：{origins}")
    print(f"   健康檢查：     http://localhost:{port}/api/health")
    print("   首次執行請先：  python seed.py\n")
    app.run(host="0.0.0.0", port=port, debug=debug)

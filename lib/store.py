"""PostgreSQL 儲存層（Neon 版）

維持原有介面（load/save/tx/insert/update/find/...），
內部改用 PostgreSQL + JSONB 一張 key-value 表儲存。

連線設定：環境變數 NEON_DATABASE_URL（優先）或 DATABASE_URL（Neon 提供）
"""
import os
import json
from threading import RLock
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import Json

DATABASE_URL = (os.environ.get("NEON_DATABASE_URL") or os.environ.get("DATABASE_URL") or "").strip()

_locks = {}
_LOCK_GUARD = RLock()
_initialized = False


def _get_conn():
    """每次取新連線。Neon serverless 對短查詢友善，不需 connection pool。"""
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL 環境變數未設定。請在 Replit Secrets 設定 Neon 連線字串。"
        )
    return psycopg2.connect(DATABASE_URL, sslmode="require")


def _ensure_init():
    """建立 kv_store 表（idempotent）"""
    global _initialized
    if _initialized:
        return
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kv_store (
                    name TEXT PRIMARY KEY,
                    data JSONB NOT NULL DEFAULT '{}'::jsonb,
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            conn.commit()
    _initialized = True


def _lock_for(name):
    with _LOCK_GUARD:
        if name not in _locks:
            _locks[name] = RLock()
        return _locks[name]


def _default():
    return {"next_id": 1, "items": []}


def load(name):
    """從 DB 讀取單一 entity 的資料（JSONB）"""
    _ensure_init()
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM kv_store WHERE name = %s", (name,))
            row = cur.fetchone()
            if row and isinstance(row[0], dict):
                data = row[0]
                # 確保格式合法
                if "items" in data and isinstance(data["items"], list):
                    data.setdefault("next_id", 1)
                    return data
            return _default()


def save(name, data):
    """寫入單一 entity 的資料"""
    _ensure_init()
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO kv_store (name, data, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (name) DO UPDATE
                SET data = EXCLUDED.data, updated_at = NOW()
            """, (name, Json(data)))
            conn.commit()


@contextmanager
def tx(name):
    """讀-改-寫的原子交易（thread-safe）"""
    lock = _lock_for(name)
    with lock:
        data = load(name)
        yield data
        save(name, data)


def next_id(data):
    nid = data["next_id"]
    data["next_id"] = nid + 1
    return nid


# === 查詢輔助 ===
def find(name, predicate):
    data = load(name)
    return [it for it in data["items"] if predicate(it)]


def find_one(name, predicate):
    for it in load(name)["items"]:
        if predicate(it):
            return it
    return None


def get(name, item_id):
    return find_one(name, lambda x: x.get("id") == item_id)


def all_items(name):
    return load(name)["items"]


def insert(name, item):
    """便利函式：建立並回傳新項目（含 id）"""
    with tx(name) as data:
        item["id"] = next_id(data)
        data["items"].append(item)
        return dict(item)


def update(name, item_id, patch):
    with tx(name) as data:
        for it in data["items"]:
            if it.get("id") == item_id:
                it.update(patch)
                return dict(it)
    return None


def delete(name, item_id):
    with tx(name) as data:
        data["items"] = [it for it in data["items"] if it.get("id") != item_id]


# === 兌換券每日流水 ===
def coupon_seq(date_key):
    """傳回該日下一個流水號"""
    with tx("coupon_sequences") as data:
        seqs = data.get("seqs", {})
        nxt = seqs.get(date_key, 0) + 1
        seqs[date_key] = nxt
        data["seqs"] = seqs
        return nxt

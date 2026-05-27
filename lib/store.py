"""JSON 檔案儲存層

每個 entity 一個 JSON 檔，格式：
{
  "next_id": 1,
  "items": [ { id, ... }, ... ]
}

使用方式：
  from lib.store import store
  with store.tx("users") as users:
      uid = store.next_id(users)
      users["items"].append({"id": uid, "name": "X"})
  # 離開 with 即自動寫回（atomic）

  rows = store.find("users", lambda u: u["phone"] == "0912...")
"""
import os
import json
from pathlib import Path
from threading import RLock
from contextlib import contextmanager

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

_locks = {}
_LOCK_GUARD = RLock()


def _lock_for(name):
    with _LOCK_GUARD:
        if name not in _locks:
            _locks[name] = RLock()
        return _locks[name]


def _path(name):
    return DATA_DIR / f"{name}.json"


def _default():
    return {"next_id": 1, "items": []}


def load(name):
    p = _path(name)
    if not p.exists():
        return _default()
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "items" not in data:
        data = _default()
    data.setdefault("next_id", 1)
    return data


def save(name, data):
    p = _path(name)
    tmp = str(p) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


@contextmanager
def tx(name):
    """讀-改-寫的原子交易"""
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

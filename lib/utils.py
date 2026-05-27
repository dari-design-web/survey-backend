"""共用工具"""
from datetime import datetime, timedelta, timezone


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def now_iso():
    return now_utc().isoformat()


def parse_iso(s):
    if not s:
        return None
    if isinstance(s, datetime):
        return s
    try:
        # 支援 'YYYY-MM-DDTHH:MM:SS+00:00' 與 'YYYY-MM-DD HH:MM:SS'
        return datetime.fromisoformat(str(s).replace(" ", "T"))
    except Exception:
        return None


def add_days(date, days):
    if isinstance(date, str):
        date = parse_iso(date)
    return date + timedelta(days=days)


def format_date(d, with_time=False):
    if not d:
        return ""
    if isinstance(d, str):
        d = parse_iso(d)
    if not d:
        return ""
    return d.strftime("%Y-%m-%d %H:%M:%S" if with_time else "%Y-%m-%d")

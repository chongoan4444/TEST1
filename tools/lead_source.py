#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lead_source.py — Phân loại "tệp khách" Pancake (pancake.vn) theo NGUỒN:

    ads      = từ quảng cáo (Facebook / Instagram Ads)
    post     = từ comment bài viết
    live     = từ livestream
    organic  = khách tự nhắn (inbox thường)
    unknown  = không đủ dữ liệu để kết luận

Kèm điểm ưu tiên 0–100 để biết nên chốt ai trước.

Đầu vào: file .har (Chrome DevTools) hoặc file .json chứa response của
    POST /api/v1/conversations
    GET  /api/v1/conversations/<id>/messages   (tuỳ chọn, để tăng độ chính xác)

Không cần thư viện ngoài. Python 3.8+.

Ví dụ:
    python3 tools/lead_source.py tinnhanmoi.har --out-dir reports
    python3 tools/lead_source.py data.json --explain        # tìm field nguồn mới
    python3 tools/lead_source.py data.json --source ads     # chỉ xem khách từ ads
    python3 tools/lead_source.py data.json --rules tools/rules.example.json
"""

import argparse
import base64
import csv
import gzip
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------
# Từ khoá nhận diện nguồn (có thể ghi đè bằng rules.json)
# --------------------------------------------------------------------------

# Key chứa mã quảng cáo / referral. Gặp ở bất kỳ đâu trong object đều tính.
AD_KEYS = {
    "ad_id", "ad_ids", "adset_id", "adset_name", "campaign_id", "campaign_name",
    "ad_name", "ad_name_id", "ads_context_data", "referral", "ad_referral",
    "is_ad", "from_ad", "adgroup_id", "source_ad_id", "click_from",
}

# Tín hiệu quảng cáo THẬT của Pancake: message.attachments[].type = "ad_click" + ad_id
AD_TYPE_VALUES = {"ad_click", "ad_referral", "ad"}

# Key cho thấy hội thoại sinh ra từ comment bài viết.
POST_KEYS = {"post_id", "post", "comment_id", "post_story", "post_permalink"}
LIVE_KEYS = {"has_livestream_order", "is_livestream_order", "live_video_id"}

# Giá trị "type" được coi là comment (Pancake dùng INBOX cho tin nhắn).
COMMENT_TYPE_HINTS = ("COMMENT", "REPLY", "POST_COMMENT")
LIVE_TYPE_HINTS = ("LIVE", "LIVESTREAM")

# Từ khoá thể hiện ý định mua (đã bỏ dấu, so khớp theo từ nguyên vẹn).
DEFAULT_INTENT = [
    "gia", "bao nhieu", "nhieu tien", "size", "mau", "con hang", "con khong",
    "dat hang", "dat", "mua", "lay", "ship", "giao", "ib", "inbox", "chot",
    "order", "sdt", "so dien thoai", "dia chi", "chuyen khoan", "ck",
    "giam gia", "khuyen mai", "sale", "ai ban", "con size", "ship cod",
]

DEFAULT_RULES = {
    # Map tag id (Pancake trả về dạng số) -> tên + nguồn.
    # Điền theo tag thực tế của shop; xem README mục "Cách tìm tag id".
    "tag_map": {
        "4": {"name": "(chưa rõ)", "source": None},
        "83": {"name": "(chưa rõ)", "source": None},
        "172": {"name": "(chưa rõ)", "source": None},
    },
    "intent_keywords": DEFAULT_INTENT,
    "weights": {
        "unread": 30,
        "recent_24h": 20,
        "recent_3d": 10,
        "has_phone": 15,
        "many_msgs": 10,
        "intent": 20,
        "source_ads": 10,
        "source_post": 5,
    },
    "thresholds": {"hot": 70, "warm": 40},
}

SOURCE_LABEL = {
    "ads": "Quảng cáo",
    "post": "Bài viết",
    "live": "Livestream",
    "organic": "Tự nhắn",
    "unknown": "Chưa rõ",
}

CONF_LABEL = {"high": "cao", "mid": "trung bình", "low": "thấp"}
PRIO_LABEL = {"hot": "CHỐT NGAY", "warm": "Ưu tiên", "cold": "Theo dõi"}

# --------------------------------------------------------------------------
# Tiện ích
# --------------------------------------------------------------------------


def strip_accents(s):
    """Bỏ dấu tiếng Việt để so khớp từ khoá."""
    if not s:
        return ""
    s = str(s).replace("đ", "d").replace("Đ", "D")
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower()


def parse_dt(value):
    """Parse ISO datetime của Pancake (thường là UTC, không kèm timezone)."""
    if not value:
        return None
    s = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def fmt_local(dt, tz_hours=7):
    if not dt:
        return ""
    return dt.astimezone(timezone(timedelta(hours=tz_hours))).strftime("%d/%m/%Y %H:%M")


def clip(s, n):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


# --------------------------------------------------------------------------
# Đọc dữ liệu
# --------------------------------------------------------------------------


def decode_body(entry):
    """Trả về JSON object của response trong 1 entry HAR, hoặc None."""
    content = entry.get("response", {}).get("content") or {}
    text = content.get("text")
    if not text:
        return None
    raw = base64.b64decode(text) if content.get("encoding") == "base64" else text.encode("utf-8", "ignore")
    try:
        return json.loads(raw)
    except Exception:
        pass
    try:
        return json.loads(gzip.decompress(raw))
    except Exception:
        return None


CONV_MSG_URL = re.compile(r"/conversations/([^/?#]+)/messages")


def load_source(path):
    """Đọc HAR hoặc JSON -> (payloads[(url, obj)], har|None)."""
    with open(path, "rb") as fh:
        raw = fh.read()

    looks_like_har = b'"log"' in raw[:20000] and b'"entries"' in raw[:20000]
    if looks_like_har:
        har = json.loads(raw)
        payloads = []
        for entry in har.get("log", {}).get("entries", []):
            obj = decode_body(entry)
            if isinstance(obj, (dict, list)):
                payloads.append((entry.get("request", {}).get("url", ""), obj))
        return payloads, har

    obj = json.loads(raw)
    if isinstance(obj, dict):
        return [("", obj)], None
    return [("", {"conversations": obj})], None


def collect(payloads, har=None):
    """Gom danh sách conversation + message từ mọi payload."""
    conversations, messages = [], {}

    for url, obj in payloads:
        if not isinstance(obj, dict):
            continue
        convs = obj.get("conversations")
        if isinstance(convs, list):
            conversations.extend(c for c in convs if isinstance(c, dict))
        m = CONV_MSG_URL.search(url or "")
        if m:
            msgs = obj.get("messages") or obj.get("data")
            if isinstance(msgs, list):
                messages.setdefault(m.group(1), []).extend(msgs)

    # HAR: bắt thêm mọi entry có URL .../conversations/<id>/messages
    if har:
        for entry in har.get("log", {}).get("entries", []):
            m = CONV_MSG_URL.search(entry.get("request", {}).get("url", ""))
            if not m:
                continue
            obj = decode_body(entry)
            if isinstance(obj, dict):
                msgs = obj.get("messages") or obj.get("data")
                if isinstance(msgs, list):
                    messages.setdefault(m.group(1), []).extend(msgs)

    seen, unique = set(), []
    for c in conversations:
        key = c.get("id") or c.get("thread_key") or json.dumps(c, sort_keys=True)[:120]
        if key in seen:
            continue
        seen.add(key)
        unique.append(c)
    return unique, messages


def deep_find(obj, keys, path="", depth=0, out=None, max_depth=8):
    """Tìm mọi key thuộc `keys` trong object lồng nhau -> [(đường dẫn, giá trị)]."""
    if out is None:
        out = []
    if depth > max_depth or not isinstance(obj, (dict, list)):
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if str(k).lower() in keys:
                out.append((p, v))
            if isinstance(v, (dict, list)):
                deep_find(v, keys, p, depth + 1, out, max_depth)
            elif isinstance(v, str) and v[:1] in "{[[" and len(v) < 5000:
                try:
                    deep_find(json.loads(v), keys, p, depth + 1, out, max_depth)
                except Exception:
                    pass
    else:
        for i, v in enumerate(obj[:60]):
            deep_find(v, keys, f"{path}[{i}]", depth + 1, out, max_depth)
    return out


def all_paths(obj, path="", depth=0, acc=None, max_depth=6):
    """Liệt kê mọi đường dẫn key — dùng cho --explain."""
    if acc is None:
        acc = {}
    if depth > max_depth or not isinstance(obj, (dict, list)):
        return acc
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            acc[p] = type(v).__name__
            all_paths(v, p, depth + 1, acc, max_depth)
    elif isinstance(obj, list):
        for v in obj[:5]:
            all_paths(v, f"{path}[]", depth + 1, acc, max_depth)
    return acc


def jsonify(value, n=90):
    if isinstance(value, (dict, list)):
        return clip(json.dumps(value, ensure_ascii=False), n)
    return clip(value, n)


# --------------------------------------------------------------------------
# Phân loại nguồn
# --------------------------------------------------------------------------


def load_rules(path):
    rules = json.loads(json.dumps(DEFAULT_RULES))
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            user = json.load(fh)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(rules.get(k), dict):
                rules[k].update(v)
            else:
                rules[k] = v
    return rules


def classify(conv, msgs, rules):
    """-> (source, confidence_key, evidence[list[str]])"""
    evidence = []
    source, confidence = None, "low"

    conv_type = str(conv.get("type") or "").upper()
    msg_types = set()
    for msg in msgs:
        if not isinstance(msg, dict):
            continue
        for key in ("type", "message_type", "verb"):
            v = msg.get(key)
            if isinstance(v, str):
                msg_types.add(v.upper())

    # ---- 1. Quảng cáo: có mã ad / referral ở bất kỳ đâu
    ad_hits = []
    for blob_name, blob in (("extra_info", conv.get("extra_info")),
                            ("conv", {"post": conv.get("post"), "type": conv.get("type")}),
                            ("messages", msgs)):
        if not blob:
            continue
        for path, value in deep_find(blob, AD_KEYS):
            if value in (None, "", {}, [], False, 0, "0"):
                continue
            ad_hits.append(f"{blob_name}.{path} = {jsonify(value)}")
    # bỏ dòng cha nếu đã có dòng con chi tiết hơn
    ad_hits = [h for h in ad_hits
               if not any(o != h and o.split(" = ")[0].startswith(h.split(" = ")[0] + ".") for o in ad_hits)]
    for i, m in enumerate(msgs):
        for j, a in enumerate((m.get("attachments") or []) if isinstance(m, dict) else []):
            if isinstance(a, dict) and str(a.get("type") or "").lower() in AD_TYPE_VALUES:
                ad_hits.append(f"messages[{i}].attachments[{j}].type = {a.get('type')}")
    if ad_hits:
        source, confidence = "ads", "high"
        evidence.extend(ad_hits[:4])

    # ---- 2. Comment bài viết
    post_hits = []
    for path, value in deep_find({"extra_info": conv.get("extra_info"),
                                  "conv": {"post_id": conv.get("post_id"), "post": conv.get("post")}},
                                 POST_KEYS, max_depth=4):
        if value in (None, "", {}, []):
            continue
        post_hits.append(f"{path} = {jsonify(value)}")
    is_comment_type = any(h in conv_type for h in COMMENT_TYPE_HINTS) or any(
        any(h in t for h in COMMENT_TYPE_HINTS) for t in msg_types)
    if post_hits or is_comment_type:
        if source is None:
            source, confidence = "post", ("high" if post_hits else "mid")
        elif source == "ads":
            evidence.append("(đồng thời có dấu hiệu comment)")
        evidence.extend(post_hits[:3])
        if is_comment_type:
            evidence.append(f"type = {conv_type or '/'.join(sorted(msg_types))} → comment")

    # ---- 3. Livestream
    live_hits = [(p, v) for p, v in deep_find({"conv": conv, "messages": msgs}, LIVE_KEYS)
                 if v not in (None, "", {}, [], False, 0)]
    live_type = any(h in conv_type for h in LIVE_TYPE_HINTS) or any(
        any(h in t for h in LIVE_TYPE_HINTS) for t in msg_types)
    if live_hits or live_type:
        if source is None:
            source, confidence = "live", "mid"
        if live_hits:
            evidence.append(f"{live_hits[0][0]} = {jsonify(live_hits[0][1])}")

    # ---- 4. Tag (đối chiếu rules.tag_map)
    tag_map = rules.get("tag_map") or {}
    named_tags = []
    for tid in conv.get("tags") or []:
        info = tag_map.get(str(tid))
        if not isinstance(info, dict):
            continue
        name = info.get("name") or ""
        if name and name != "(chưa rõ)":
            named_tags.append(f"{name} #{tid}")
        tsrc = info.get("source")
        if tsrc in SOURCE_LABEL:
            if source is None:
                source, confidence = tsrc, "mid"
            elif tsrc == source:
                confidence = "high"
            evidence.append(f"tag #{tid} = {name or '?'} → nguồn {SOURCE_LABEL[tsrc]}")
    if named_tags:
        evidence.append("tags: " + ", ".join(named_tags))
    elif conv.get("tags"):
        evidence.append("tags chưa map tên: " + ", ".join("#" + str(t) for t in conv["tags"]))

    # ---- 5. Mặc định
    if source is None:
        if conv_type in ("", "INBOX"):
            source, confidence = "organic", "low"
            evidence.append("type = INBOX, không có dấu hiệu ads / post / live")
        else:
            source, confidence = "unknown", "low"
            evidence.append(f"type = {conv_type} (chưa nhận diện được)")

    return source, confidence, evidence


def build_row(conv, msgs, rules, now, tz_hours):
    source, confidence, evidence = classify(conv, msgs, rules)

    customers = conv.get("customers") or []
    cust = customers[0] if customers and isinstance(customers[0], dict) else {}
    name = cust.get("name") or (conv.get("from") or {}).get("name") or "(không tên)"
    psid = conv.get("from_psid") or cust.get("fb_id") or ""
    page_name = (conv.get("last_sent_by") or {}).get("name") or ""
    phones = [p for p in (conv.get("recent_phone_numbers") or []) if isinstance(p, (str, int))]
    updated = parse_dt(conv.get("updated_at"))
    last_cust = parse_dt(conv.get("last_customer_interactive_at"))
    snippet = conv.get("snippet") or ""
    unread = int(conv.get("unread_count") or 0)
    n_msgs = int(conv.get("message_count") or 0)

    # ---- điểm ưu tiên
    w = rules["weights"]
    score, reasons = 0, []
    if unread > 0:
        score += w["unread"]
        reasons.append(f"chưa đọc {unread} tin +{w['unread']}")
    ref = last_cust or updated
    if ref:
        age = now - ref
        if age <= timedelta(hours=24):
            score += w["recent_24h"]
            reasons.append(f"tương tác < 24h +{w['recent_24h']}")
        elif age <= timedelta(days=3):
            score += w["recent_3d"]
            reasons.append(f"tương tác < 3 ngày +{w['recent_3d']}")
    if conv.get("has_phone") or phones:
        score += w["has_phone"]
        reasons.append(f"có SĐT +{w['has_phone']}")
    if n_msgs >= 3:
        score += w["many_msgs"]
        reasons.append(f"{n_msgs} tin nhắn +{w['many_msgs']}")
    norm = strip_accents(snippet)
    hits = [k for k in rules["intent_keywords"]
            if re.search(r"(?<![a-z0-9])" + re.escape(strip_accents(k)) + r"(?![a-z0-9])", norm)]
    if hits:
        score += w["intent"]
        reasons.append(f"ý định mua: {', '.join(hits[:3])} +{w['intent']}")
    if source == "ads":
        score += w["source_ads"]
        reasons.append(f"từ quảng cáo +{w['source_ads']}")
    elif source == "post":
        score += w["source_post"]
        reasons.append(f"từ bài viết +{w['source_post']}")
    score = max(0, min(100, score))

    th = rules["thresholds"]
    prio_key = "hot" if score >= th["hot"] else ("warm" if score >= th["warm"] else "cold")

    return {
        "id": conv.get("id") or "",
        "name": name,
        "psid": psid,
        "phone": str(phones[0]) if phones else "",
        "page_id": conv.get("page_id") or "",
        "page_name": page_name,
        "source": source,
        "source_label": SOURCE_LABEL.get(source, source),
        "confidence_key": confidence,
        "confidence": CONF_LABEL[confidence],
        "evidence": evidence,
        "tags": conv.get("tags") or [],
        "snippet": snippet,
        "message_count": n_msgs,
        "unread": unread,
        "has_phone": bool(conv.get("has_phone") or phones),
        "updated_at": updated.isoformat() if updated else "",
        "updated_disp": fmt_local(updated, tz_hours),
        "last_customer_at": last_cust.isoformat() if last_cust else "",
        "score": score,
        "prio_key": prio_key,
        "prio": PRIO_LABEL[prio_key],
        "reasons": reasons,
        "messages_loaded": len(msgs),
    }


# --------------------------------------------------------------------------
# Xuất báo cáo
# --------------------------------------------------------------------------


def write_csv(rows, path):
    header = ["Điểm", "Ưu tiên", "Nguồn", "Độ tin cậy", "Khách", "PSID", "SĐT",
              "Page ID", "Page", "Chưa đọc", "Số tin", "Cập nhật", "Tin cuối",
              "Bằng chứng"]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(header)
        for r in rows:
            wr.writerow([r["score"], r["prio"], r["source_label"], r["confidence"],
                         r["name"], r["psid"], r["phone"], r["page_id"], r["page_name"],
                         r["unread"], r["message_count"], r["updated_disp"], r["snippet"],
                         " | ".join(r["evidence"])])


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phân loại tệp khách theo nguồn</title>
<style>
  :root{
    --bg:#f6f7fb; --card:#fff; --line:#e6e9f0; --ink:#111827; --muted:#6b7280;
    --ads:#7c3aed; --post:#0ea5e9; --live:#e11d48; --organic:#059669; --unknown:#9ca3af;
    --hot:#dc2626; --warm:#d97706; --cold:#6b7280;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif}
  header{padding:24px 24px 0;max-width:1400px}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:-.2px}
  .sub{color:var(--muted);font-size:13px}
  .banner{margin:16px 24px 0;padding:10px 14px;border-radius:10px;background:#fff7ed;
          border:1px solid #fed7aa;color:#9a3412;font-size:13px;max-width:1350px}
  .wrap{padding:18px 24px 34px;max-width:1400px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .card .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .card .v{font-size:23px;font-weight:650;margin-top:2px;line-height:1.2}
  .toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
  .chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 12px;
        cursor:pointer;font-size:13px;display:inline-flex;gap:6px;align-items:center;user-select:none}
  .chip:hover{border-color:#c7cbd6}
  .chip.active{background:#111827;color:#fff;border-color:#111827}
  .chip .n{opacity:.6;font-size:12px}
  input[type=search]{flex:1;min-width:190px;border:1px solid var(--line);border-radius:10px;
        padding:9px 12px;font-size:14px;background:#fff;outline:none}
  input[type=search]:focus{border-color:#a5b4fc;box-shadow:0 0 0 3px #eef2ff}
  table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);
        border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);
     background:#fafbfd;cursor:pointer;white-space:nowrap}
  th:hover{color:var(--ink)}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#fafbff}
  .badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;
         font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
  .b-ads{background:var(--ads)} .b-post{background:var(--post)} .b-live{background:var(--live)}
  .b-organic{background:var(--organic)} .b-unknown{background:var(--unknown)}
  .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.85)}
  .score{font-weight:700;font-size:17px;line-height:1.2}
  .p-hot{color:var(--hot)} .p-warm{color:var(--warm)} .p-cold{color:var(--cold)}
  .prio{font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase}
  .name{font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--muted)}
  .snip{color:#374151;font-size:13px;max-width:330px}
  .conf{font-size:11.5px;color:var(--muted);display:block;margin-top:3px}
  .conf.high{color:#b91c1c} .conf.mid{color:#b45309}
  details summary{cursor:pointer;color:#2563eb;font-size:12.5px;list-style:none;white-space:nowrap}
  details summary::-webkit-details-marker{display:none}
  details summary:hover{text-decoration:underline}
  details ul{margin:6px 0 0;padding-left:16px;color:#374151;font-size:12.5px}
  details li{margin:2px 0}
  .empty{padding:44px;text-align:center;color:var(--muted)}
  .legend{display:flex;flex-wrap:wrap;gap:16px;margin:16px 0 0;font-size:12.5px;color:var(--muted)}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}
  footer{padding:0 24px 34px;color:var(--muted);font-size:12px;max-width:1400px}
  @media(max-width:900px){.hide-sm{display:none}}
</style>
</head>
<body>
<header>
  <h1>Phân loại tệp khách theo nguồn</h1>
  <div class="sub">__SUBTITLE__</div>
</header>
__BANNER__
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div class="toolbar">
    <div class="chip active" data-f="all">Tất cả <span class="n" id="n-all"></span></div>
    <div class="chip" data-f="ads">Quảng cáo <span class="n" id="n-ads"></span></div>
    <div class="chip" data-f="post">Bài viết <span class="n" id="n-post"></span></div>
    <div class="chip" data-f="live">Livestream <span class="n" id="n-live"></span></div>
    <div class="chip" data-f="organic">Tự nhắn <span class="n" id="n-organic"></span></div>
    <div class="chip" data-f="hot">Chốt ngay <span class="n" id="n-hot"></span></div>
    <input type="search" id="q" placeholder="Tìm theo tên, PSID, SĐT, nội dung tin…">
  </div>
  <table>
    <thead>
      <tr>
        <th data-sort="score">Ưu tiên</th>
        <th data-sort="source">Nguồn</th>
        <th data-sort="name">Khách</th>
        <th class="hide-sm" data-sort="page_name">Page</th>
        <th class="hide-sm" data-sort="updated_at">Cập nhật</th>
        <th class="hide-sm">Tin cuối</th>
        <th data-sort="unread">Chưa đọc</th>
        <th>Bằng chứng</th>
      </tr>
    </thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="legend">
    <span><i style="background:var(--ads)"></i>Quảng cáo — có ad_id / referral / campaign</span>
    <span><i style="background:var(--post)"></i>Bài viết — có post_id hoặc type = comment</span>
    <span><i style="background:var(--live)"></i>Livestream — có live_video / has_livestream_order</span>
    <span><i style="background:var(--organic)"></i>Tự nhắn — INBOX không có dấu hiệu nào</span>
  </div>
</div>
<footer>
  Điểm ưu tiên = chưa đọc + mới tương tác + có SĐT + số tin + ý định mua + nguồn (quảng cáo được cộng nhiều hơn).
  Độ tin cậy: <b>cao</b> = có mã/định danh rõ ràng, <b>trung bình</b> = chỉ dựa vào tag hoặc type, <b>thấp</b> = suy đoán.
</footer>
<script id="data" type="application/json">__DATA__</script>
<script>
const rows = JSON.parse(document.getElementById('data').textContent);
const tb = document.getElementById('tb');
let filter = 'all', query = '', sortKey = 'score', sortDir = -1;

const count = fn => rows.filter(fn).length;
document.getElementById('n-all').textContent = rows.length;
['ads','post','live','organic'].forEach(s => {
  const el = document.getElementById('n-' + s);
  if (el) el.textContent = count(r => r.source === s);
});
document.getElementById('n-hot').textContent = count(r => r.prio_key === 'hot');

const STATS = [
  ['Tổng tệp khách', rows.length],
  ['Từ quảng cáo', count(r => r.source === 'ads')],
  ['Từ bài viết', count(r => r.source === 'post')],
  ['Chốt ngay', count(r => r.prio_key === 'hot')],
  ['Chưa đọc', count(r => r.unread > 0)],
];
document.getElementById('cards').innerHTML = STATS.map(([k, v]) =>
  `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function passes(r){
  if (filter === 'hot' && r.prio_key !== 'hot') return false;
  if (filter !== 'all' && filter !== 'hot' && r.source !== filter) return false;
  if (!query) return true;
  const hay = [r.name, r.psid, r.phone, r.snippet, r.page_name, r.source_label,
               (r.tags||[]).join(' '), (r.evidence||[]).join(' ')].join(' ').toLowerCase();
  return hay.includes(query);
}

function render(){
  const list = rows.filter(passes).sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (typeof x === 'string') return String(x).localeCompare(String(y)) * sortDir;
    return (x - y) * sortDir;
  });
  if (!list.length){ tb.innerHTML = '<tr><td colspan="8" class="empty">Không có tệp khách nào khớp.</td></tr>'; return; }
  tb.innerHTML = list.map(r => {
    const ev = (r.evidence || []).length
      ? `<details><summary>${r.evidence.length} dấu hiệu</summary><ul>${r.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` +
        ((r.reasons || []).length ? `<ul>${r.reasons.map(e => `<li>điểm: ${esc(e)}</li>`).join('')}</ul>` : '') + `</details>`
      : '<span class="mono">không có</span>';
    return `<tr>
      <td><div class="score p-${r.prio_key}">${r.score}</div><div class="prio p-${r.prio_key}">${esc(r.prio)}</div></td>
      <td><span class="badge b-${r.source}"><span class="dot"></span>${esc(r.source_label)}</span>
          <span class="conf ${r.confidence_key}">tin cậy: ${esc(r.confidence)}</span></td>
      <td><div class="name">${esc(r.name)}</div>
          <div class="mono">psid ${esc(r.psid)}${r.phone ? ' · ' + esc(r.phone) : ''}</div></td>
      <td class="hide-sm"><div>${esc(r.page_name || '(không rõ)')}</div><div class="mono">${esc(r.page_id)}</div></td>
      <td class="hide-sm">${esc(r.updated_disp)}</td>
      <td class="hide-sm"><div class="snip">${esc(r.snippet)}</div><div class="mono">${r.message_count} tin</div></td>
      <td>${r.unread > 0 ? `<b class="p-hot">${r.unread}</b>` : '<span class="mono">0</span>'}</td>
      <td>${ev}</td>
    </tr>`;
  }).join('');
}

document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  filter = c.dataset.f;
  render();
}));
document.getElementById('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); });
document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  if (sortKey === k) sortDir *= -1;
  else { sortKey = k; sortDir = (k === 'score' || k === 'unread') ? -1 : 1; }
  render();
}));
render();
</script>
</body>
</html>
"""


def write_html(rows, path, subtitle, banner=""):
    data = json.dumps(rows, ensure_ascii=False).replace("</", "<\\/")
    html = (HTML_TEMPLATE.replace("__DATA__", data)
            .replace("__SUBTITLE__", subtitle)
            .replace("__BANNER__", f'<div class="banner">{banner}</div>' if banner else ""))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)


def print_table(rows):
    if not rows:
        print("Không có dữ liệu.")
        return
    print(f"{'ĐIỂM':>4}  {'ƯU TIÊN':<10} {'NGUỒN':<12} {'TIN CẬY':<10} {'KHÁCH':<20} {'CẬP NHẬT':<17} TIN CUỐI")
    print("-" * 124)
    for r in sorted(rows, key=lambda x: -x["score"]):
        print(f"{r['score']:>4}  {r['prio']:<10} {r['source_label']:<12} {r['confidence']:<10} "
              f"{clip(r['name'], 20):<20} {r['updated_disp']:<17} {clip(r['snippet'], 34)}")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Phân loại tệp khách Pancake theo nguồn (quảng cáo / bài viết / livestream / tự nhắn) + điểm ưu tiên.")
    ap.add_argument("input", help="file .har hoặc .json")
    ap.add_argument("--rules", help="file rules.json (map tag, từ khoá, trọng số)")
    ap.add_argument("--out-dir", default="reports", help="thư mục xuất báo cáo (mặc định: reports)")
    ap.add_argument("--prefix", default=None, help="tiền tố tên file xuất (mặc định: tên file input)")
    ap.add_argument("--source", help="chỉ xuất nguồn này: ads|post|live|organic|unknown")
    ap.add_argument("--min-score", type=int, default=None, help="chỉ xuất tệp khách có điểm >= n")
    ap.add_argument("--json", action="store_true", help="in JSON ra stdout")
    ap.add_argument("--no-html", action="store_true", help="không xuất báo cáo HTML")
    ap.add_argument("--explain", action="store_true",
                    help="liệt kê mọi field có trong dữ liệu (dùng để tìm field nguồn mới)")
    ap.add_argument("--tz", type=int, default=7, help="múi giờ hiển thị (mặc định 7 = VN)")
    ap.add_argument("--now", help="thời điểm ISO dùng làm 'bây giờ' (để test)")
    ap.add_argument("--banner", default="", help="dòng cảnh báo hiển thị trên báo cáo HTML")
    args = ap.parse_args(argv)

    rules = load_rules(args.rules)
    payloads, har = load_source(args.input)
    convs, msgs = collect(payloads, har)

    if not convs:
        print("Không tìm thấy conversation nào trong file.", file=sys.stderr)
        print("Gợi ý: file phải chứa response của POST /api/v1/conversations", file=sys.stderr)
        return 2

    now = parse_dt(args.now) or datetime.now(timezone.utc)
    rows = [build_row(c, msgs.get(c.get("id"), []), rules, now, args.tz) for c in convs]
    rows.sort(key=lambda r: -r["score"])

    if args.source:
        rows = [r for r in rows if r["source"] == args.source]
    if args.min_score is not None:
        rows = [r for r in rows if r["score"] >= args.min_score]

    if args.explain:
        print("== Các field có trong dữ liệu (dùng để tìm field nguồn mới) ==")
        seen = {}
        for c in convs:
            all_paths(c, "conversation", 0, seen)
        for ms in msgs.values():
            for m in ms[:3]:
                all_paths(m, "message", 0, seen)
        for p, t in sorted(seen.items()):
            hot = any(k in p.lower() for k in ("ad", "ref", "source", "post", "campaign",
                                               "click", "utm", "tag", "type"))
            print(("* " if hot else "  ") + f"{p}  <{t}>")
        print("\n(* = có thể liên quan đến nguồn)")
        print(f"conversations={len(convs)}  conversations_có_messages={len(msgs)}")

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)

    os.makedirs(args.out_dir, exist_ok=True)
    prefix = args.prefix or os.path.splitext(os.path.basename(args.input))[0]
    csv_path = os.path.join(args.out_dir, prefix + "_leads.csv")
    write_csv(rows, csv_path)
    print(f"\n[done] {len(rows)} tệp khách → {csv_path}")

    if not args.no_html:
        html_path = os.path.join(args.out_dir, prefix + "_leads.html")
        c = {s: sum(1 for r in rows if r["source"] == s) for s in ("ads", "post", "live", "organic", "unknown")}
        subtitle = (f"{len(rows)} tệp khách · quảng cáo {c['ads']} · bài viết {c['post']} · "
                    f"livestream {c['live']} · tự nhắn {c['organic']} · "
                    f"chốt ngay {sum(1 for r in rows if r['prio_key'] == 'hot')} · "
                    f"nguồn: {os.path.basename(args.input)}")
        write_html(rows, html_path, subtitle, args.banner)
        print(f"[done] báo cáo HTML → {html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

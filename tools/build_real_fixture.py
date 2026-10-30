#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_real_fixture.py — Rút dữ liệu THẬT từ các HAR của Pancake (loaddanhsach.har,
batmesss.har) thành fixture nhỏ để test bộ phân loại, đã ẩn danh khách.

    python3 tools/build_real_fixture.py        # -> demo/real_leads.json
    node tools/test_userscript_real.js         # kiểm tra classifier trên dữ liệu thật

Vì sao cần: trong dữ liệu thật, conversation-list KHÔNG chứa dấu hiệu quảng cáo
(extra_info luôn {}, post_id luôn null). Tín hiệu nằm ở MESSAGE:
    attachments[].type === "ad_click"  /  attachments[].ad_id
Đó là cơ sở để phân loại "khách từ quảng cáo".
"""

import base64
import gzip
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCES = ["loaddanhsach.har", "batmesss.har"]


def body(entry):
    c = (entry.get("response") or {}).get("content") or {}
    t = c.get("text")
    if not t:
        return None
    raw = base64.b64decode(t) if c.get("encoding") == "base64" else t.encode("utf-8", "ignore")
    for fn in (lambda r: json.loads(r), lambda r: json.loads(gzip.decompress(r))):
        try:
            return fn(raw)
        except Exception:
            continue
    return None


def is_ad_message(m):
    for a in (m.get("attachments") or []):
        if not isinstance(a, dict):
            continue
        if a.get("ad_id") or a.get("type") in ("ad_click", "ad_referral"):
            return True
    return False


def expected_source(conv, msgs):
    if any(is_ad_message(m) for m in msgs):
        return "ads"
    if conv.get("type") == "COMMENT" or any(m.get("type") == "COMMENT" for m in msgs):
        return "post"
    if conv.get("has_livestream_order"):
        return "live"
    return "organic"


def mask(text, n=70):
    text = re.sub(r"\b0\d{8,10}\b", "****", str(text or ""))
    return text[:n]


def trim_message(m):
    return {
        "id": m.get("id"),
        "type": m.get("type"),
        "inserted_at": m.get("inserted_at"),
        "parent_id": m.get("parent_id"),
        "comment_count": m.get("comment_count"),
        "like_count": m.get("like_count"),
        "message": mask(m.get("message")),
        "attachments": [
            {
                "type": a.get("type"),
                "ad_id": a.get("ad_id"),
                "click_from": a.get("click_from"),
                "url": a.get("url"),
                "post_title": (((a.get("post_attachments") or [{}])[0] or {}).get("description") or "")[:80],
            }
            for a in (m.get("attachments") or []) if isinstance(a, dict)
        ],
    }


def main():
    convs, msgs = {}, {}
    for name in SOURCES:
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            print("Thiếu", name, "— bỏ qua")
            continue
        with open(path, encoding="utf-8", errors="ignore") as fh:
            har = json.load(fh)
        for entry in har.get("log", {}).get("entries", []):
            url = entry.get("request", {}).get("url", "")
            if "/conversations" not in url:
                continue
            j = body(entry)
            if not isinstance(j, dict):
                continue
            for c in (j.get("conversations") or []):
                if isinstance(c, dict) and c.get("id"):
                    convs[c["id"]] = c
            for m in (j.get("messages") or []):
                if isinstance(m, dict) and m.get("conversation_id"):
                    msgs.setdefault(m["conversation_id"], []).append(m)

    cases, i = [], 0
    for cid, ms in msgs.items():
        conv = convs.get(cid)
        if not conv:
            continue
        i += 1
        anon_conv = {
            "id": conv["id"],
            "type": conv.get("type"),
            "tags": conv.get("tags") or [],
            "extra_info": conv.get("extra_info") or {},
            "post_id": conv.get("post_id"),
            "post": conv.get("post"),
            "has_livestream_order": conv.get("has_livestream_order"),
            "has_phone": conv.get("has_phone"),
            "unread_count": conv.get("unread_count"),
            "message_count": conv.get("message_count"),
            "page_id": conv.get("page_id"),
            "updated_at": conv.get("updated_at"),
            "last_customer_interactive_at": conv.get("last_customer_interactive_at"),
            "snippet": mask(conv.get("snippet")),
            "from": {"id": "psid-anon", "name": "Khách %02d" % i},
            "customers": [{"fb_id": "psid-anon", "id": "cust-%02d" % i, "name": "Khách %02d" % i}],
            "from_psid": "psid-anon",
            "recent_phone_numbers": [],
            "last_sent_by": {"name": "Page"},
        }
        cases.append({
            "expected": expected_source(conv, ms),
            "conv": anon_conv,
            "messages": [trim_message(m) for m in ms],
        })

    out = {"note": "Dữ liệu thật đã ẩn danh, rút từ loaddanhsach.har + batmesss.har",
           "cases": cases}
    path = os.path.join(ROOT, "demo", "real_leads.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)

    stats = {}
    for c in cases:
        stats[c["expected"]] = stats.get(c["expected"], 0) + 1
    print(f"[done] {path} — {len(cases)} ca thật: {stats}")


if __name__ == "__main__":
    main()

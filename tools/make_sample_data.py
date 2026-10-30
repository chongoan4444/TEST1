#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_sample_data.py — Sinh file HAR MẪU (dữ liệu giả) để xem thử báo cáo
khi chưa có HAR thật đầy đủ.

    python3 tools/make_sample_data.py            # -> demo/sample_messages.har
    python3 tools/lead_source.py demo/sample_messages.har \
            --rules demo/rules_demo.json --prefix demo_leads \
            --banner "DỮ LIỆU MẪU — không phải khách thật"

Dữ liệu ở đây được dựng theo đúng cấu trúc Pancake quan sát được trong
tinnhanmoi.har, cộng thêm các field nguồn (referral / post_id / tag) mà
Pancake có thể trả về nhưng HAR hiện tại chưa bắt được.
"""

import base64
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PAGE = {"id": "881264518397934", "name": "Khánh Ly Store"}
PAGES = {
    "881264518397934": "Khánh Ly Store",
    "769625892902516": "Mai Boutique",
    "898735919982398": "Sỉ Áo Thun SG",
}


def conv(cid, page_id, name, psid, snippet, minutes_ago, unread=0, msgs=3,
         tags=None, extra_info=None, post_id=None, ctype="INBOX",
         has_phone=False, phones=None, live=None):
    return {
        "id": f"{page_id}_{psid}",
        "type": ctype,
        "tags": tags or [],
        "seen": unread == 0,
        "extra_info": extra_info or {},
        "from": {"email": f"{psid}@facebook.com", "id": psid, "name": name},
        "post": post_id,
        "snippet": snippet,
        "inserted_at": f"2026-10-30T0{max(1, minutes_ago // 60)}:06:44.544625",
        "updated_at": ts(minutes_ago),
        "message_count": msgs,
        "page_id": page_id,
        "thread_id": str(abs(hash(cid)) % 10**16),
        "assignee_ids": [],
        "assignee_group_id": None,
        "customers": [{"fb_id": psid, "id": f"cust-{psid}", "name": name}],
        "from_psid": psid,
        "has_livestream_order": live,
        "has_phone": has_phone,
        "is_combined": False,
        "is_removed": False,
        "last_customer_interactive_at": ts(minutes_ago + 1),
        "last_sent_by": {"admin_name": "Đinh Lan Mai", "id": page_id,
                         "name": PAGES.get(page_id, ""), "uid": "69c3a77d-e5bd-4202-89ab-da84f79b898a"},
        "post_id": post_id,
        "read_watermarks": [],
        "recent_phone_numbers": phones or [],
        "recent_seen_users": [],
        "task_opened": None,
        "thread_key": f"t_{abs(hash(psid)) % 10**16}",
        "unread_count": unread,
    }


def ts(minutes_ago):
    from datetime import datetime, timedelta, timezone
    dt = datetime(2026, 10, 30, 4, 7, tzinfo=timezone.utc) - timedelta(minutes=minutes_ago)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")


def build():
    conversations = [
        # 1. Quảng cáo — có referral.ad_id trong extra_info
        conv("c1", "881264518397934", "Ngọc Ánh", "28856202704022307",
             "Còn size M không shop, giá bao nhiêu ạ?", 5, unread=2, msgs=4,
             tags=[4, 83],
             extra_info={"referral": {"source": "ADS", "ad_id": "120210987654321",
                                      "ref": "post_engagement", "ads_context_data": {"ad_title": "Áo thu đông SALE 30%"}}}),
        # 2. Quảng cáo — messages có ads_context_data (message-level)
        conv("c2", "881264518397934", "Trần Bảo", "28856011122233",
             "Mẫu trong video còn màu đen không ạ", 12, unread=1, msgs=2, tags=[83],
             extra_info={"ads_context_data": {"ad_id": "120211111111111", "ad_title": "Váy hoa"}}),
        # 3. Comment bài viết
        conv("c3", "881264518397934", "Hồng Nhung", "28856099988877",
             "Ib mình mẫu này với ạ", 40, unread=1, msgs=3, ctype="COMMENT",
             post_id="1140326359158411"),
        # 4. Livestream
        conv("c4", "769625892902516", "Kim Oanh", "28856044455566",
             "Chốt 2 áo như trên live nha shop", 60, unread=0, msgs=5,
             live={"order_id": "LV-99120"}, tags=[172]),
        # 5. Tự nhắn — có SĐT + ý định mua rõ
        conv("c5", "769625892902516", "Đức Huy", "28856077788899",
             "Cho mình đặt 3 cái, ship về Hà Nội, sđt 0987654321 nhé", 90,
             unread=0, msgs=6, has_phone=True, phones=["0987654321"]),
        # 6. Tự nhắn — hỏi giá nhưng đã đọc, cũ
        conv("c6", "898735919982398", "Lan Phương", "28856022233344",
             "Giá sỉ 50 cái bao nhiêu shop", 60 * 40, unread=0, msgs=2),
        # 7. Tự nhắn — khách im lặng
        conv("c7", "898735919982398", "Minh Tuấn", "28856066677788",
             "Ok shop", 60 * 24 * 6, unread=0, msgs=1),
        # 8. Type lạ — chưa nhận diện
        conv("c8", "881264518397934", "Quốc Việt", "28856033344455",
             "Sản phẩm này bảo hành bao lâu", 200, unread=0, msgs=2, ctype="POSTBACK"),
    ]

    messages = {
        "881264518397934_28856011122233": [
            {"id": "m1", "type": "message", "conversation_id": "881264518397934_28856011122233",
             "message": "Mẫu trong video còn màu đen không ạ", "from_id": "28856011122233",
             "inserted_at": ts(12), "ads_context_data": {"ad_id": "120211111111111"}},
        ],
        "881264518397934_28856202704022307": [
            {"id": "m2", "type": "message", "conversation_id": "881264518397934_28856202704022307",
             "message": "Còn size M không shop, giá bao nhiêu ạ?", "from_id": "28856202704022307",
             "inserted_at": ts(5), "referral": {"ad_id": "120210987654321", "source": "ADS"}},
        ],
    }
    return conversations, messages


def har_entry(url, payload, mime="application/json"):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return {
        "_resourceType": "xhr",
        "startedDateTime": "2026-10-30T04:07:08.000Z",
        "time": 40,
        "request": {"method": "POST" if "conversations?" in url else "GET",
                    "url": url, "httpVersion": "http/2", "headers": [], "queryString": [],
                    "cookies": [], "headersSize": -1, "bodySize": 0},
        "response": {"status": 200, "statusText": "", "httpVersion": "http/2",
                     "headers": [{"name": "content-type", "value": mime}],
                     "cookies": [], "content": {"size": len(body), "mimeType": mime,
                                                "encoding": "base64",
                                                "text": base64.b64encode(body).decode("ascii")},
                     "redirectURL": "", "headersSize": -1, "bodySize": len(body)},
        "cache": {},
        "timings": {"send": 1, "wait": 38, "receive": 1},
    }


def main():
    conversations, messages = build()
    entries = [
        har_entry("https://pancake.vn/api/v1/conversations?unread_first=true&mode=OR",
                  {"success": True, "next_cursor": "demo-cursor",
                   "pages_with_current_count": {p: 0 for p in PAGES},
                   "conversations": conversations, "list_page_users": []}),
    ]
    for cid, msgs in messages.items():
        entries.append(har_entry(f"https://pancake.vn/api/v1/conversations/{cid}/messages",
                                 {"success": True, "messages": msgs}))

    har = {"log": {"version": "1.2", "creator": {"name": "lead_source sample generator", "version": "1.0"},
                   "pages": [], "entries": entries}}
    os.makedirs(os.path.join(ROOT, "demo"), exist_ok=True)
    out = os.path.join(ROOT, "demo", "sample_messages.har")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(har, fh, ensure_ascii=False, indent=1)
    print(f"[done] {out} — {len(conversations)} tệp khách giả, {len(messages)} hội thoại có message")


if __name__ == "__main__":
    main()

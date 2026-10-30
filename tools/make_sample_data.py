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


MOCK_TEMPLATE = """<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mô phỏng danh sách hội thoại Pancake — chạy thử userscript</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0f1220;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#111827}
  .app{display:flex;height:100vh}
  .side{width:330px;background:#fff;border-right:1px solid #e6e9f0;display:flex;flex-direction:column}
  .side h2{margin:0;padding:14px 16px 10px;font-size:15px;letter-spacing:-.2px;display:flex;align-items:center;gap:8px}
  .side h2 .tag{font-size:10px;font-weight:700;background:#eef2ff;color:#4338ca;border-radius:6px;padding:2px 6px}
  .list{overflow-y:auto;flex:1}
  .conv{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid #f1f3f8;cursor:pointer}
  .conv:hover{background:#f8f9ff}
  .av{width:38px;height:38px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      color:#fff;font-weight:700;font-size:13px;background:#7c3aed}
  .body{min-width:0;flex:1}
  .l1{display:flex;align-items:center;gap:6px;justify-content:space-between}
  .nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tm{font-size:11px;color:#9ca3af;flex:0 0 auto}
  .sn{font-size:12.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
  .pg{font-size:11px;color:#c3c8d4;margin-top:2px}
  .un{background:#ef4444;color:#fff;font-size:10.5px;font-weight:700;border-radius:999px;padding:0 6px;margin-left:6px}
  .main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#c7cbe0;padding:24px;text-align:center}
  .main h1{color:#fff;font-size:19px;margin:0;font-weight:650}
  .main p{max-width:520px;font-size:13.5px;line-height:1.7;margin:0}
  .main code{background:#1c2136;color:#c4b5fd;padding:1px 6px;border-radius:5px;font-size:12.5px}
  .btns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .btns button{background:#7c3aed;color:#fff;border:none;border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
  .btns button.ghost{background:#1c2136;color:#c7cbe0}
  .btns button:hover{filter:brightness(1.1)}
  .note{font-size:12px;color:#8a90ab}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <h2>Hội thoại <span class="tag">MÔ PHỎNG</span></h2>
    <div class="list" id="list">
__ROWS__
    </div>
  </aside>
  <main class="main">
    <h1>Trang mô phỏng để xem userscript chạy</h1>
    <p>Đây không phải Pancake thật. Trang giả lập đúng dữ liệu <code>/api/v1/conversations</code> để bạn thấy
    userscript tự gắn nhãn <b>QC / BV / LV / TN</b> lên từng dòng và bảng nổi ở góc phải —
    <b>không cần mở đoạn chat nào</b>.</p>
    <div class="btns">
      <button id="add">＋ Khách mới từ quảng cáo</button>
      <button class="ghost" id="refresh">↻ Đồng bộ lại</button>
      <button class="ghost" onclick="location.href='../reports/demo_leads.html'">Mở báo cáo HTML →</button>
    </div>
    <p class="note"><b>Alt+O</b> để ẩn/hiện toàn bộ giao diện · <b>🔥</b> = khách nên chốt ngay (≥70 điểm) ·
    bấm "＋ Khách mới" để thấy dòng chat vừa xuất hiện là có nhãn ngay.</p>
  </main>
</div>
<script>
// ---------- giả lập API Pancake (chạy TRƯỚC userscript) ----------
const DATA = __DATA__;
const jsonRes = o => ({ ok: true, status: 200, json: () => Promise.resolve(o), clone(){ return this; } });
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const m = /\/conversations\/([^/?#]+)\/messages/.exec(url);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return Promise.resolve(jsonRes({ success: true, messages: DATA.msgs[id] || [] }));
  }
  if (/\/api\/v1\/conversations(\?|$)/.test(url)) {
    return Promise.resolve(jsonRes({ success: true, conversations: DATA.convs }));
  }
  return Promise.resolve(jsonRes({ success: true }));
};
</script>
<script src="../userscripts/pancake-lead-badges.user.js"></script>
<script>
// ---------- hành vi "app" ----------
const listEl = document.getElementById('list');
let seq = 0;
const newLeads = __NEW_LEADS__;

function rowHtml(c) {
  const initials = c.customers[0].name.trim().split(/\s+/).map(w => w[0]).slice(-2).join('').toUpperCase();
  const unread = c.unread_count ? `<span class="un">${c.unread_count}</span>` : '';
  return `<div class="conv" data-id="${c.id}">
    <div class="av">${initials}</div>
    <div class="body">
      <div class="l1"><span class="nm">${c.customers[0].name}</span><span class="tm">vừa xong${unread}</span></div>
      <div class="sn">${c.snippet}</div>
      <div class="pg">${c.last_sent_by.name}</div>
    </div>
  </div>`;
}
listEl.innerHTML = DATA.convs.map(rowHtml).join('');

// app gọi API lần đầu
fetch('/api/v1/conversations?unread_first=true&mode=OR&from_platform=web', { method: 'POST' });

document.getElementById('add').addEventListener('click', () => {
  const c = JSON.parse(JSON.stringify(newLeads[seq % newLeads.length]));
  seq++;
  c.id = c.id + '_' + seq;
  c.customers[0].name = c.customers[0].name.replace('{n}', '#' + seq);
  c.snippet = c.snippet.replace('{n}', '');
  c.updated_at = new Date().toISOString();
  c.last_customer_interactive_at = new Date().toISOString();
  DATA.convs.unshift(c);
  listEl.insertAdjacentHTML('afterbegin', rowHtml(c));
  fetch('/api/v1/conversations?unread_first=true&mode=OR&from_platform=web', { method: 'POST' });
});
document.getElementById('refresh').addEventListener('click', () => {
  fetch('/api/v1/conversations?unread_first=true&mode=OR&from_platform=web', { method: 'POST' });
  if (window.__leadSource) window.__leadSource.refresh();
});
</script>
</body>
</html>
"""


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def initials(name):
    parts = [p for p in str(name).split() if p]
    return (parts[-2][0] + parts[-1][0]).upper() if len(parts) > 1 else (parts[0][:2].upper() if parts else "?")


def build_mock(conversations):
    rows = []
    for c in conversations:
        name = c["customers"][0]["name"]
        unread = f'<span class="un">{c["unread_count"]}</span>' if c.get("unread_count") else ""
        rows.append(
            f'      <div class="conv" data-id="{esc(c["id"])}">\n'
            f'        <div class="av">{initials(name)}</div>\n'
            f'        <div class="body">\n'
            f'          <div class="l1"><span class="nm">{esc(name)}</span>'
            f'<span class="tm">vừa xong{unread}</span></div>\n'
            f'          <div class="sn">{esc(c["snippet"])}</div>\n'
            f'          <div class="pg">{esc(c["last_sent_by"]["name"])}</div>\n'
            f'        </div>\n'
            f'      </div>')
    new_leads = [{
        "id": "881264518397934_28856123400001",
        "type": "INBOX",
        "tags": [83],
        "extra_info": {"referral": {"source": "ADS", "ad_id": "120219999999999",
                                    "ads_context_data": {"ad_title": "Váy hoa mùa thu"}}},
        "from": {"name": "Khách mới {n}"},
        "customers": [{"name": "Khách mới {n}"}],
        "snippet": "Giá cái này bao nhiêu shop ơi, còn size L không {n}",
        "last_sent_by": {"name": "Khánh Ly Store"},
        "unread_count": 1,
        "has_phone": False,
        "recent_phone_numbers": [],
        "updated_at": "",
        "last_customer_interactive_at": "",
        "message_count": 1,
    }]
    data = {
        "convs": conversations,
        "msgs": build_messages_for_mock(),
    }
    html = (MOCK_TEMPLATE
            .replace("__ROWS__", "\n".join(rows))
            .replace("__DATA__", json.dumps(data, ensure_ascii=False))
            .replace("__NEW_LEADS__", json.dumps(new_leads, ensure_ascii=False)))
    path = os.path.join(ROOT, "demo", "mock_pancake.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"[done] {path}")


def build_messages_for_mock():
    _, messages = build()
    return messages


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
    build_mock(conversations)


if __name__ == "__main__":
    main()

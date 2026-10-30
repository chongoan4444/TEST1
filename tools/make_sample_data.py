#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_sample_data.py — Sinh dữ liệu MẪU (giả) để xem thử / test:

    demo/sample_messages.har   HAR mẫu cho tools/lead_source.py
    demo/mock_pancake.html     trang mô phỏng danh sách hội thoại Pancake
                               (dùng ĐÚNG cấu trúc DOM thật:
                                .conversation-list > .conversation-list-item#<page>_<psid>__<n>)

    python3 tools/make_sample_data.py
    python3 tools/serve_reports.py demo/mock_pancake.html
"""

import base64
import json
import os
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PAGES = {
    "881264518397934": "Khánh Ly Store",
    "769625892902516": "Mai Boutique",
    "898735919982398": "Sỉ Áo Thun SG",
}
T0 = datetime(2026, 10, 30, 4, 7, tzinfo=timezone.utc)


def ts(minutes_ago):
    return (T0 - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%S.%f")


def conv(page_id, name, psid, snippet, minutes_ago, unread=0, n_msgs=3, tags=None,
         extra_info=None, post_id=None, ctype="INBOX", has_phone=False, phones=None, live=None):
    return {
        "id": f"{page_id}_{psid}",
        "type": ctype,
        "tags": tags or [],
        "seen": unread == 0,
        "extra_info": extra_info or {},
        "from": {"email": f"{psid}@facebook.com", "id": psid, "name": name},
        "post": post_id,
        "snippet": snippet,
        "inserted_at": ts(minutes_ago),
        "updated_at": ts(minutes_ago),
        "message_count": n_msgs,
        "page_id": page_id,
        "thread_id": str(abs(hash(psid)) % 10**16),
        "assignee_ids": [],
        "assignee_group_id": None,
        "customers": [{"fb_id": psid, "id": f"cust-{psid}", "name": name}],
        "from_psid": psid,
        "has_livestream_order": live,
        "has_phone": has_phone,
        "is_combined": False,
        "is_removed": False,
        "last_customer_interactive_at": ts(minutes_ago),
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


def ad_click_message(conv_id, page_id, ad_id, title, minutes_ago):
    """Đúng cấu trúc tin nhắn thật của Pancake khi khách bấm vào quảng cáo."""
    return {
        "id": f"ad-{ad_id}.0",
        "message": "<div></div>",
        "type": "INBOX",
        "seen": False,
        "from": {"id": page_id, "name": PAGES.get(page_id, "")},
        "inserted_at": ts(minutes_ago),
        "page_id": page_id,
        "conversation_id": conv_id,
        "attachments": [{
            "ad_id": ad_id,
            "click_from": "facebook",
            "type": "ad_click",
            "url": "https://www.facebook.com/" + ad_id,
            "post_attachments": [{"type": "video_direct_response", "description": title}],
        }],
        "has_phone": False,
        "is_removed": False,
        "comment_count": None,
        "like_count": None,
        "parent_id": None,
        "rich_message": None,
        "message_tags": [],
    }


def build():
    c = [conv("881264518397934", "Ngọc Ánh", "28856202704022307",
              "Còn size M không shop, giá bao nhiêu ạ?", 5, unread=2, n_msgs=4, tags=[4, 83]),
         conv("881264518397934", "Trần Bảo", "28856011122233",
              "Mẫu trong video còn màu đen không ạ", 12, unread=1, n_msgs=2),
         conv("881264518397934", "Hồng Nhung", "28856099988877",
              "Ib mình mẫu này với ạ", 40, unread=1, n_msgs=3, ctype="COMMENT",
              post_id="1140326359158411"),
         conv("769625892902516", "Kim Oanh", "28856044455566",
              "Chốt 2 áo như trên live nha shop", 60, n_msgs=5, tags=[172],
              live={"order_id": "LV-99120"}),
         conv("769625892902516", "Đức Huy", "28856077788899",
              "Cho mình đặt 3 cái, ship về Hà Nội, sđt 0987654321 nhé", 90,
              n_msgs=6, has_phone=True, phones=["0987654321"]),
         conv("898735919982398", "Lan Phương", "28856022233344",
              "Giá sỉ 50 cái bao nhiêu shop", 60 * 40, n_msgs=2),
         conv("898735919982398", "Minh Tuấn", "28856066677788",
              "Ok shop", 60 * 24 * 6, n_msgs=1),
         conv("881264518397934", "Quốc Việt", "28856033344455",
              "Sản phẩm này bảo hành bao lâu", 200, n_msgs=2, ctype="POSTBACK")]

    messages = {
        # Quảng cáo thật: chỉ phát hiện được khi XEM TIN NHẮN (attachments[].type = ad_click)
        c[1]["id"]: [ad_click_message(c[1]["id"], c[1]["page_id"], "120211111111111", "Váy hoa mùa thu", 12)],
        c[0]["id"]: [{"id": "m-1", "type": "INBOX", "message": "Còn size M không shop?",
                      "conversation_id": c[0]["id"], "page_id": c[0]["page_id"],
                      "inserted_at": ts(5), "attachments": [], "parent_id": None}],
    }
    return c, messages


def har_entry(url, payload, method="POST"):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return {
        "_resourceType": "xhr",
        "startedDateTime": "2026-10-30T04:07:08.000Z",
        "time": 40,
        "request": {"method": method, "url": url, "httpVersion": "http/2", "headers": [],
                    "queryString": [], "cookies": [], "headersSize": -1, "bodySize": 0},
        "response": {"status": 200, "statusText": "", "httpVersion": "http/2",
                     "headers": [{"name": "content-type", "value": "application/json"}],
                     "cookies": [],
                     "content": {"size": len(body), "mimeType": "application/json",
                                 "encoding": "base64", "text": base64.b64encode(body).decode("ascii")},
                     "redirectURL": "", "headersSize": -1, "bodySize": len(body)},
        "cache": {},
        "timings": {"send": 1, "wait": 38, "receive": 1},
    }


def write_har(convs, messages):
    entries = [har_entry("https://pancake.vn/api/v1/conversations?unread_first=true&mode=OR",
                         {"success": True, "next_cursor": "demo",
                          "pages_with_current_count": {p: 0 for p in PAGES},
                          "conversations": convs, "list_page_users": []})]
    for cid, msgs in messages.items():
        page = cid.split("_")[0]
        entries.append(har_entry(
            f"https://pancake.vn/api/v1/pages/{page}/conversations/{cid}/messages?",
            {"success": True, "messages": msgs}, method="GET"))
    har = {"log": {"version": "1.2", "creator": {"name": "sample generator", "version": "1.0"},
                   "pages": [], "entries": entries}}
    out = os.path.join(ROOT, "demo", "sample_messages.har")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(har, fh, ensure_ascii=False, indent=1)
    print(f"[done] {out}")


MOCK = """<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mô phỏng danh sách hội thoại Pancake — chạy thử userscript</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0f1220;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#111827}
  .app{display:flex;height:100vh}
  .side{width:340px;background:#fff;border-right:1px solid #e6e9f0;display:flex;flex-direction:column}
  .side h2{margin:0;padding:12px 14px 10px;font-size:14.5px;display:flex;align-items:center;gap:8px}
  .side h2 .tag{font-size:9.5px;font-weight:700;background:#eef2ff;color:#4338ca;border-radius:6px;padding:2px 6px}
  .conversation-list{overflow-y:auto;flex:1}
  .conversation-list-item{display:flex;gap:10px;padding:9px 12px;border-bottom:1px solid #f1f3f8;cursor:pointer}
  .conversation-list-item:hover{background:#f8f9ff}
  .conversation-list-item.selected{background:#f3eeff}
  .media-left{position:relative;flex:0 0 auto}
  .av{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      color:#fff;font-weight:700;font-size:13px;background:#7c3aed}
  .media-body{min-width:0;flex:1}
  .name-module{display:flex;align-items:center;justify-content:space-between;gap:6px}
  .name-module-text{display:flex;align-items:center;min-width:0}
  .name-text{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .time-modul{font-size:11px;color:#9ca3af;flex:0 0 auto}
  .snippet-wrap{margin-top:1px}
  .snippet-line{display:flex;align-items:center;gap:3px}
  .snippet-text{font-size:12.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tag-wrap{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}
  .conversation_tags_item{font-size:9.5px;font-weight:600;color:#fff;border-radius:4px;padding:1px 5px;background:#94a3b8}
  .unread .name-text{font-weight:800}
  .unread .snippet-text{color:#111827;font-weight:600}
  .main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
        color:#c7cbe0;padding:24px;text-align:center}
  .main h1{color:#fff;font-size:19px;margin:0;font-weight:650}
  .main p{max-width:560px;font-size:13.5px;line-height:1.7;margin:0}
  .main code{background:#1c2136;color:#c4b5fd;padding:1px 6px;border-radius:5px;font-size:12.5px}
  .btns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .btns button{background:#7c3aed;color:#fff;border:none;border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
  .btns button.ghost{background:#1c2136;color:#c7cbe0}
  .btns button:hover{filter:brightness(1.1)}
  .note{font-size:12px;color:#8a90ab;max-width:600px}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <h2>Hội thoại <span class="tag">MÔ PHỎNG</span></h2>
    <div class="conversation-list" id="conversation-list">
__ROWS__
    </div>
  </aside>
  <main class="main">
    <h1>Trang mô phỏng — cấu trúc DOM giống Pancake</h1>
    <p>Script đọc <code>.conversation-list-item</code> và <b>chỉ gắn nhãn cho dòng đang hiển thị</b>.
    Nhãn <b>QC/BV/LV/TN/?</b> + điểm ưu tiên hiện ngay cạnh tên khách; hội thoại có quảng cáo chỉ được
    nhận ra <b>sau khi script tự xem tin nhắn</b> (dấu <code>…</code> = chưa xem xong).</p>
    <div class="btns">
      <button id="add">＋ Khách mới (từ quảng cáo)</button>
      <button class="ghost" id="refresh">↻ Đồng bộ lại</button>
      <button class="ghost" onclick="location.href='../reports/demo_leads.html'">Báo cáo HTML →</button>
    </div>
    <p class="note"><b>Alt+O</b> ẩn/hiện tất cả · <b>▭</b> chỉ ẩn bảng (nhãn vẫn chạy) · <b>✕</b> ẩn tất cả,
    nút <b>🏷️/▤</b> góc phải để mở lại · <b>🔥</b> = nên chốt ngay.</p>
  </main>
</div>
<script>
// cấu hình mẫu (map tag id -> nguồn)
try {
  localStorage.setItem('leadSource.cfg', JSON.stringify({
    tagMap: { "83": { name: "Từ quảng cáo", source: "ads" }, "172": { name: "Khách live", source: "live" } }
  }));
} catch (e) {}
</script>
<script>
// ---------- giả lập API Pancake (chạy TRƯỚC userscript) ----------
const DATA = __DATA__;
const jsonRes = o => ({ ok: true, status: 200, json: () => Promise.resolve(o), clone() { return this; } });
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const m = /\\/conversations\\/([^/?#]+)\\/messages/.exec(url);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return Promise.resolve(jsonRes({ success: true, messages: DATA.msgs[id] || [] }));
  }
  if (/\\/api\\/v1\\/(pages\\/[^/]+\\/)?conversations(\\?|$)/.test(url)) {
    return Promise.resolve(jsonRes({ success: true, conversations: DATA.convs }));
  }
  return Promise.resolve(jsonRes({ success: true }));
};
</script>
<script src="../userscripts/pancake-lead-badges.user.js"></script>
<script>
// ---------- hành vi "app" ----------
const listEl = document.getElementById('conversation-list');
let seq = 0;
const newLeads = __NEW_LEADS__;

function initials(name) {
  const p = String(name).trim().split(/\\s+/).filter(Boolean);
  return (p.length > 1 ? p[p.length - 2][0] + p[p.length - 1][0] : (p[0] || '?').slice(0, 2)).toUpperCase();
}

function rowHtml(c, idx) {
  const name = c.customers[0].name;
  const tags = (c.tags || []).map(t => `<span class="conversation_tags_item">#${t}</span>`).join('');
  const cls = 'media conversation-list-item' + (c.unread_count ? ' unread' : '');
  return `<div id="${c.id}__${idx}" class="${cls}">
    <div class="media-left render-avatar-cus"><div class="av">${initials(name)}</div></div>
    <div class="media-body body-conver-item">
      <div class="name-module platform-facebook">
        <span class="name-module-text"><span class="name-text">${name}</span><span style="clear:left"></span></span>
        <span class="time-modul">22:00</span>
      </div>
      <div class="snippet-wrap"><div class="snippet-line">
        <div class="snippet-text">${c.snippet}</div></div></div>
      <div class="tag-wrap full-tag">${tags}</div>
    </div>
  </div>`;
}

listEl.innerHTML = DATA.convs.map((c, i) => rowHtml(c, i)).join('');

// app gọi API lần đầu (POST danh sách nhiều page)
fetch('/api/v1/conversations?unread_first=true&mode=OR&from_platform=web', { method: 'POST' });

document.getElementById('add').addEventListener('click', () => {
  const c = JSON.parse(JSON.stringify(newLeads[seq % newLeads.length]));
  seq++;
  c.id = c.id + seq;
  c.customers[0].name = c.customers[0].name.replace('{n}', '#' + seq);
  c.snippet = c.snippet.replace('{n}', '');
  c.updated_at = new Date().toISOString();
  c.last_customer_interactive_at = new Date().toISOString();
  DATA.convs.unshift(c);
  const first = listEl.firstElementChild;
  const idx = first ? (parseInt((first.id.split('__')[1] || '0'), 10) + 1) : 0;
  listEl.insertAdjacentHTML('afterbegin', rowHtml(c, idx));
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


def initials(name):
    parts = [p for p in str(name).split() if p]
    if len(parts) > 1:
        return (parts[-2][0] + parts[-1][0]).upper()
    return parts[0][:2].upper() if parts else "?"


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def build_mock(convs):
    rows = []
    for i, c in enumerate(convs):
        name = c["customers"][0]["name"]
        tags = "".join('<span class="conversation_tags_item">#%s</span>' % t for t in (c.get("tags") or []))
        cls = "media conversation-list-item" + (" unread" if c.get("unread_count") else "")
        rows.append(
            f'      <div id="{esc(c["id"])}__{i}" class="{cls}">\n'
            f'        <div class="media-left render-avatar-cus"><div class="av">{initials(name)}</div></div>\n'
            f'        <div class="media-body body-conver-item">\n'
            f'          <div class="name-module platform-facebook">\n'
            f'            <span class="name-module-text"><span class="name-text">{esc(name)}</span>'
            f'<span style="clear:left"></span></span>\n'
            f'            <span class="time-modul">22:00</span>\n'
            f'          </div>\n'
            f'          <div class="snippet-wrap"><div class="snippet-line">'
            f'<div class="snippet-text">{esc(c["snippet"])}</div></div></div>\n'
            f'          <div class="tag-wrap full-tag">{tags}</div>\n'
            f'        </div>\n'
            f'      </div>')

    new_leads = [{
        "id": "881264518397934_28856900000001",
        "type": "INBOX",
        "tags": [],
        "extra_info": {},
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

    data = {"convs": convs, "msgs": build()[1]}
    html = (MOCK.replace("__ROWS__", "\n".join(rows))
                .replace("__DATA__", json.dumps(data, ensure_ascii=False))
                .replace("__NEW_LEADS__", json.dumps(new_leads, ensure_ascii=False)))
    path = os.path.join(ROOT, "demo", "mock_pancake.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"[done] {path}")


def main():
    convs, messages = build()
    write_har(convs, messages)
    build_mock(convs)


if __name__ == "__main__":
    main()

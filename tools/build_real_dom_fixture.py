#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_real_dom_fixture.py — Dựng trang test từ **DOM THẬT** của Pancake
(rút nguyên khối `.conversation-list` trong html.txt/html2.txt/html3.txt),
đã ẩn danh tên khách + nội dung tin, bỏ ảnh/icon.

    python3 tools/build_real_dom_fixture.py       # -> demo/real_dom_fixture.html
    npm i jsdom && node tools/test_userscript_realdom.js

Mục đích: test userscript trên đúng markup Pancake (class, id, cấu trúc lồng nhau),
không dùng mock tự chế — để phát hiện lỗi "không gắn được nhãn".
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCES = ["html3.txt", "html2.txt", "html.txt"]


def extract_div(s, start_idx):
    """Cắt phần tử <div> bắt đầu tại start_idx bằng cách đếm độ sâu."""
    depth = 0
    i = start_idx
    while i < len(s):
        nxt = s.find("<", i)
        if nxt < 0:
            break
        if s.startswith("<!--", nxt):
            end = s.find("-->", nxt)
            i = end + 3 if end > 0 else nxt + 1
            continue
        m = re.match(r"<(/?)([a-zA-Z0-9-]+)", s[nxt:])
        if not m:
            i = nxt + 1
            continue
        closing, tag = m.group(1) == "/", m.group(2).lower()
        gt = s.find(">", nxt)
        if gt < 0:
            break
        if tag in ("script", "style", "svg"):
            if not closing:
                end = s.find("</%s>" % tag, nxt)
                i = end + len(tag) + 3 if end > 0 else gt + 1
            else:
                i = gt + 1
            continue
        if tag in ("img", "br", "input", "path", "meta", "link", "hr"):
            i = gt + 1
            continue
        if closing:
            depth -= 1
            if depth == 0:
                return s[start_idx:gt + 1]
            i = gt + 1
        else:
            depth += 1
            i = gt + 1
    return s[start_idx:]


def anonymize(block):
    """Ẩn danh tên khách + nội dung tin, bỏ ảnh/href, bỏ svg."""
    counter = [0]

    def sub_name(m):
        counter[0] += 1
        return m.group(1) + "Khách %02d" % counter[0] + m.group(3)

    block = re.sub(r'(<span class="name-text"[^>]*>)(.*?)(</span>)', sub_name, block, flags=re.S)

    def sub_snip(m):
        return m.group(1) + "Nội dung tin nhắn đã ẩn danh" + m.group(3)

    block = re.sub(r'(<div class="snippet-text"[^>]*>)(.*?)(</div>)', sub_snip, block, flags=re.S)
    block = re.sub(r"<svg.*?</svg>", "", block, flags=re.S)
    block = re.sub(r'\s(src|href|srcset)="[^"]*"', "", block)
    return block


def wrap_rows(block):
    """Mô phỏng màn hình mới: id nằm ở thẻ bọc, dòng con KHÔNG có id.
    <div offsetx id="page_psid"><div class="media conversation-list-item">…</div></div>"""
    out = block
    for m in list(re.finditer(r'<div id="(\d+)_(\d+)__(\d+)" class="media conversation-list-item', block)):
        row = extract_div(block, m.start())
        if not row:
            continue
        inner = row.replace(m.group(0), '<div class="media conversation-list-item', 1)
        wrapped = '<div offsetx="0" id="%s_%s">%s</div>' % (m.group(1), m.group(2), inner)
        out = out.replace(row, wrapped, 1)
    return out


def build():
    blocks = []
    for name in SOURCES:
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            continue
        s = open(path, encoding="utf-8", errors="ignore").read()
        idx = s.find("<div class=\"conversation-list\"")
        if idx < 0:
            continue
        block = extract_div(s, idx)
        if not re.search(r'class="media conversation-list-item', block):
            continue
        blocks.append((name, anonymize(block)))

    if not blocks:
        raise SystemExit("Không tìm thấy khối .conversation-list trong các file html*.txt")

    # gộp: khối đầu giữ nguyên, các khối sau chỉ lấy phần rows để tăng số dòng
    main_name, main = blocks[0]
    extra_rows = []
    for name, block in blocks[1:]:
        for m in re.finditer(r'<div id="(\d+_\d+__\d+)" class="media conversation-list-item[^"]*"', block):
            start = m.start()
            row = extract_div(block, start)
            if row and row not in extra_rows:
                extra_rows.append(row)

    # chèn thêm rows trước thẻ đóng của .conversation-list
    if extra_rows:
        cut = main.rfind("</div>")
        main = main[:cut] + "\n" + "\n".join(extra_rows) + "\n" + main[cut:]

    n_rows = len(re.findall(r'class="media conversation-list-item', main))

    html = """<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Fixture DOM thật của Pancake (đã ẩn danh)</title>
<style>
  body{{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f7fb}}
  .conversation-list{{width:340px;height:600px;overflow-y:auto;background:#fff;border-right:1px solid #e6e9f0}}
  .media.conversation-list-item{{display:flex;gap:10px;padding:9px 12px;border-bottom:1px solid #f1f3f8;cursor:pointer}}
  .media-left{{flex:0 0 auto}}
  .media-body{{min-width:0;flex:1}}
  .name-module{{display:flex;justify-content:space-between;gap:6px}}
  .name-module-text{{display:flex;align-items:center;min-width:0}}
  .name-text{{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
  .time-modul{{font-size:11px;color:#9ca3af}}
  .snippet-text{{font-size:12.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
  .conversation_tags_item{{font-size:9.5px;color:#fff;border-radius:4px;padding:1px 5px;background:#94a3b8}}
</style>
</head>
<body>
<!-- Dựng từ __SOURCE__ — đã ẩn danh tên khách và nội dung tin -->
<div id="app" style="padding:16px">
__BLOCK__
</div>
<script>
// API giả: danh sách hội thoại suy ra TỪ CHÍNH DOM của fixture (id thật của Pancake)
(function () {
  window.__fixtureRows = function () {
    return [].slice.call(document.querySelectorAll('.conversation-list-item'));
  };
  window.__fixtureConvs = function () {
    return window.__fixtureRows().map(function (r) {
      const host = r.id ? r : (r.closest('[id]') || r);
      const cid = (host.id || '').replace(/__\\d+$/, '');
      const nameEl = r.querySelector('.name-text');
      const snipEl = r.querySelector('.snippet-text');
      const pid = cid.split('_')[0] || '';
      const psid = cid.split('_')[1] || '';
      return {
        id: cid,
        type: 'INBOX',
        tags: [],
        extra_info: {},
        page_id: pid,
        from: { id: psid, name: nameEl ? nameEl.textContent.trim() : '' },
        customers: [{ fb_id: psid, id: 'cust-' + pid, name: nameEl ? nameEl.textContent.trim() : '' }],
        from_psid: psid,
        snippet: snipEl ? snipEl.textContent.trim() : '',
        message_count: 3,
        unread_count: r.classList.contains('unread') ? 1 : 0,
        updated_at: '',
        last_customer_interactive_at: '',
        has_phone: false,
        recent_phone_numbers: [],
        last_sent_by: { name: 'Page' }
      };
    });
  };
  const jsonRes = function (o) { return { ok: true, status: 200, json: function () { return Promise.resolve(o); }, clone: function () { return this; } }; };
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const m = /\\/conversations\\/([^/?#]+)\\/messages/.exec(url);
    if (m) return Promise.resolve(jsonRes({ success: true, messages: [] }));
    return Promise.resolve(jsonRes({ success: true, conversations: window.__fixtureConvs() }));
  };
})();
</script>
<script src="../userscripts/pancake-lead-badges.user.js"></script>
<script>
// gọi SAU khi userscript đã treo hook fetch -> giả lập đúng lúc Pancake tải danh sách
window.fetch('/api/v1/conversations?unread_first=true&mode=OR', { method: 'POST' });
</script>
</body>
</html>
"""
    html = html.replace("__SOURCE__", ", ".join(n for n, _ in blocks)).replace("__BLOCK__", main)

    out = os.path.join(ROOT, "demo", "real_dom_fixture.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"[done] {out} — {n_rows} dòng THẬT (id trên dòng), nguồn: {', '.join(n for n, _ in blocks)}")

    wrapped = wrap_rows(main)
    html2 = html.replace(main, wrapped).replace(
        "id=\"app\"", "id=\"app\" data-variant=\"wrapped\"")
    out2 = os.path.join(ROOT, "demo", "real_dom_fixture_wrapped.html")
    with open(out2, "w", encoding="utf-8") as fh:
        fh.write(html2)
    print(f"[done] {out2} — cùng {n_rows} dòng nhưng id ở THẺ BỌC (như màn hình mới)")


if __name__ == "__main__":
    build()

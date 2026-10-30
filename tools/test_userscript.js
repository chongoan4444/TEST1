#!/usr/bin/env node
/**
 * test_userscript.js — kiểm tra LUẬT PHÂN LOẠI của userscript.
 *
 * Từ v3.3.0: KHÔNG còn điểm ưu tiên. Mỗi hội thoại chỉ được gắn loại tin khi có
 * bằng chứng thật; chưa đọc tin nhắn thì là "?" (không đoán) — đây chính là lỗi
 * "hiện TN, bấm vào lại thành QC".
 *
 * Test còn đối chiếu JS ↔ Python (tools/lead_source.py) để hai bên không lệch luật.
 *
 *   node tools/test_userscript.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { classify, buildLead, CFG } = require(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'));

// map tên tag hiện trên dòng chat do người dùng tự cấu hình
CFG.tagNameSource = { QC: 'ads', 'Từ quảng cáo': 'ads' };

const NOW = new Date('2026-10-30T04:10:00Z').getTime();
const conv = (extra) => Object.assign({
  id: '111111111111111_22222222222222222', page_id: '111111111111111', type: 'INBOX',
  customers: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fb_id: '22222222222222222', name: 'Khách Test' }],
  from: { name: 'Khách Test' }, tags: [], extra_info: {}, snippet: 'hello',
  unread_count: 1, message_count: 3, has_phone: false, recent_phone_numbers: [],
  updated_at: '2026-10-30T03:00:00Z', last_customer_interactive_at: '2026-10-30T02:00:00Z',
}, extra || {});

const AD_MSG = { type: 'INBOX', attachments: [{ type: 'ad_click', ad_id: '1202502696893800', url: 'https://www.facebook.com/1' }] };
const PLAIN_MSG = { type: 'INBOX', attachments: [] };
const COMMENT_ATT = { type: 'INBOX', attachments: [{ comment: { content: 'Chất gì vậy', msg_id: '1' }, post_attachments: [{ url: 'x' }] }] };
const LIVE_MSG = { type: 'INBOX', is_livestream_order: true, attachments: [] };

const CASES = [
  { name: 'tin nhắn có ad_click + ad_id', conv: conv(), msgs: [AD_MSG], checked: true, want: 'ads',
    evidenceHas: 'ad_click' },
  { name: 'hội thoại type = COMMENT', conv: conv({ type: 'COMMENT' }), msgs: [PLAIN_MSG], checked: true, want: 'post',
    evidenceHas: 'COMMENT' },
  { name: 'attachment là bình luận bài viết', conv: conv(), msgs: [COMMENT_ATT], checked: true, want: 'post',
    evidenceHas: 'bình luận bài viết' },
  { name: 'đã đọc tin nhắn, không có dấu hiệu gì', conv: conv(), msgs: [PLAIN_MSG], checked: true, want: 'organic',
    evidenceHas: 'không có ad_click' },
  { name: 'CHƯA đọc tin nhắn -> không đoán', conv: conv(), msgs: [], checked: false, want: 'unknown',
    evidenceHas: 'chưa đọc tin nhắn' },
  { name: 'cờ livestream thật', conv: conv(), msgs: [LIVE_MSG], checked: true, want: 'live', evidenceHas: 'livestream' },
  { name: 'tag trên dòng chat do người dùng cấu hình', conv: conv({ domTags: ['QC'] }), msgs: [], checked: false,
    want: 'ads', evidenceHas: 'do bạn cấu hình', jsOnly: true },
];

function pythonSources() {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
import lead_source as L
cases = json.load(sys.stdin)
rules = {"tag_map": {"4": {"name": "Khách mới", "source": None}, "83": {"name": "Từ quảng cáo", "source": "ads"}}}
out = []
for c in cases:
    conv = c["conv"]
    if c.get("domTags"):
        conv = dict(conv); conv["_domTags"] = c["domTags"]
    src, conf, ev = L.classify(conv, c["msgs"], rules, checked=c["checked"])
    out.append([src, conf])
print(json.dumps(out))
`;
  const input = JSON.stringify(CASES.map(c => ({ conv: c.conv, msgs: c.msgs, checked: c.checked })));
  const res = execFileSync('python3', ['-c', script], { input, encoding: 'utf8' });
  return JSON.parse(res);
}

let fail = 0;
const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

console.log('Luật phân loại (userscript JS)\n' + '-'.repeat(72));
CASES.forEach(c => {
  const r = classify(c.conv, c.msgs, c.checked);
  const ev = (r.evidence || []).join(' | ');
  check(r.source === c.want, `${c.name}: ${r.source} (mong đợi ${c.want})`);
  check(ev.toLowerCase().indexOf(c.evidenceHas.toLowerCase()) >= 0,
    `  ↳ căn cứ có "${c.evidenceHas}"`);
});

console.log('\nKhông còn cơ chế tính điểm\n' + '-'.repeat(72));
const lead = buildLead(CASES[0].conv, CASES[0].msgs, NOW, true);
check(!('score' in lead), 'lead không có trường score');
check(!('prioKey' in lead) && !('prio' in lead) && !('reasons' in lead), 'không có prioKey / prio / reasons');
check(lead.source === 'ads' && lead.sourceLabel === 'Quảng cáo', 'vẫn có loại tin rõ ràng');

console.log('\nĐối chiếu JS ↔ Python (cùng một luật)\n' + '-'.repeat(72));
let py = null;
try {
  py = pythonSources();
} catch (e) {
  console.log('  (bỏ qua: không chạy được python3 — ' + String(e.message).split('\n')[0] + ')');
}
if (py) {
  CASES.forEach((c, i) => {
    if (c.jsOnly) { console.log('  · ' + c.name + ': bỏ qua (chỉ userscript đọc được tag trên DOM)'); return; }
    const js = classify(c.conv, c.msgs, c.checked).source;
    check(py[i][0] === js, `${c.name}: JS=${js} · Python=${py[i][0]}`);
  });
}

console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS — luật phân loại đúng, không chấm điểm'));
process.exit(fail ? 1 : 0);

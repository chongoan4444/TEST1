#!/usr/bin/env node
/**
 * test_userscript_real.js — kiểm tra bộ phân loại của userscript trên DỮ LIỆU THẬT
 * (demo/real_leads.json, rút từ loaddanhsach.har + batmesss.har, đã ẩn danh).
 *
 *   python3 tools/build_real_fixture.py   # tạo fixture (nếu chưa có)
 *   node tools/test_userscript_real.js
 *
 * Điểm quan trọng: trong dữ liệu thật, danh sách hội thoại KHÔNG có dấu hiệu
 * quảng cáo (extra_info rỗng, post_id null). Dấu hiệu nằm ở message:
 * attachments[].type = "ad_click" / attachments[].ad_id.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'demo', 'real_leads.json');
const { buildLead, classify } = require(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'));

if (!fs.existsSync(FIXTURE)) {
  console.log('Chưa có fixture. Chạy: python3 tools/build_real_fixture.py');
  process.exit(0);
}

const { cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const NOW = Date.parse('2026-10-30T04:10:00Z');
const SOURCE_LABEL = { ads: 'Quảng cáo', post: 'Bài viết', live: 'Livestream', organic: 'Tự nhắn', unknown: 'Chưa rõ' };

let fail = 0;
console.log('Ca'.padEnd(4), 'KỲ VỌNG'.padEnd(11), 'KẾT QUẢ'.padEnd(11), 'TIN CẬY'.padEnd(10), 'BẰNG CHỨNG');
console.log('-'.repeat(104));

// 1) phân loại CHỈ từ dữ liệu danh sách (giống lúc mới load, chưa xem tin nhắn)
let listOnly = 0;
cases.forEach((c, i) => {
  const lead = buildLead(c.conv, [], NOW);
  if (lead.source === c.expected) listOnly++;
});
console.log(`Chỉ dùng dữ liệu danh sách: đúng ${listOnly}/${cases.length} ca` +
  (listOnly < cases.length ? '  (đúng như dự kiến: phải xem tin nhắn mới biết quảng cáo)' : ''));

// 2) phân loại SAU KHI xem tin nhắn (enrich) — đây là kỳ vọng chính
cases.forEach((c, i) => {
  const lead = buildLead(c.conv, c.messages, NOW);
  const ok = lead.source === c.expected;
  if (!ok) fail++;
  console.log(
    String(i + 1).padEnd(4),
    c.expected.padEnd(11),
    (lead.source + (ok ? '' : '  ✗')).padEnd(11),
    lead.confidence.padEnd(10),
    (lead.evidence[0] || '').slice(0, 52)
  );
});

const bySource = {};
cases.forEach(c => { bySource[c.expected] = (bySource[c.expected] || 0) + 1; });
console.log('-'.repeat(104));
console.log('Phân bố thật:', Object.entries(bySource).map(([k, v]) => SOURCE_LABEL[k] + '=' + v).join(' · '));
console.log(fail ? `✗ FAIL: ${fail}/${cases.length} ca sai` : `✓ PASS: ${cases.length}/${cases.length} ca thật phân loại đúng`);
process.exit(fail ? 1 : 0);

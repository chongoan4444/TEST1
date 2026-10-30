#!/usr/bin/env node
/**
 * test_userscript.js — kiểm tra phần phân loại của userscript có cho kết quả
 * GIỐNG HỆT tools/lead_source.py hay không.
 *
 *   node tools/test_userscript.js
 *
 * Cách làm: đọc demo/sample_messages.har, chạy classifier JS, rồi so từng dòng
 * với reports/demo_leads.csv (do Python sinh ra).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HAR = path.join(ROOT, 'demo', 'sample_messages.har');
const CSV = path.join(ROOT, 'reports', 'demo_leads.csv');
const NOW = new Date('2026-10-30T04:10:00Z');

const { buildLead, CFG } = require(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'));

// dùng đúng cấu hình như demo/rules_demo.json (map tag -> nguồn)
CFG.tagMap = {
  "4": { name: 'Khách mới', source: null },
  "83": { name: 'Từ quảng cáo', source: 'ads' },
  "172": { name: 'Khách live', source: 'live' },
};

function readHar(file) {
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const convs = [];
  const msgs = {};
  for (const entry of har.log.entries) {
    const url = entry.request.url || '';
    const content = entry.response.content || {};
    let body = content.text || '';
    if (!body) continue;
    if (content.encoding === 'base64') body = Buffer.from(body, 'base64').toString('utf8');
    let json;
    try { json = JSON.parse(body); } catch (e) { continue; }
    const m = /\/conversations\/([^/?#]+)\/messages/.exec(url);
    if (m) {
      const list = json.messages || json.data || [];
      if (Array.isArray(list)) (msgs[decodeURIComponent(m[1])] = msgs[decodeURIComponent(m[1])] || []).push(...list);
    } else if (Array.isArray(json.conversations)) {
      convs.push(...json.conversations);
    }
  }
  return { convs, msgs };
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',');
  const idx = {
    score: header.indexOf('Điểm'),
    source: header.indexOf('Nguồn'),
    name: header.indexOf('Khách'),
  };
  return lines.map(line => {
    // CSV đơn giản: cắt theo dấu phẩy ngoài dấu nháy
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { q = !q; continue; }
      if (c === ',' && !q) { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return { score: Number(cells[idx.score]), source: cells[idx.source], name: cells[idx.name] };
  });
}

const { convs, msgs } = readHar(HAR);
const jsRows = convs.map(c => buildLead(c, msgs[c.id] || [], NOW)).sort((a, b) => a.name.localeCompare(b.name));
const pyRows = readCsv(CSV).sort((a, b) => a.name.localeCompare(b.name));

let fail = 0;
console.log('So sánh JS userscript  ↔  Python lead_source.py');
console.log('-'.repeat(78));
console.log('KHÁCH'.padEnd(16), 'JS: nguồn/điểm'.padEnd(24), 'PY:', '');
if (jsRows.length !== pyRows.length) {
  console.log(`✗ số dòng khác nhau: JS=${jsRows.length} PY=${pyRows.length}`);
  fail++;
}
jsRows.forEach((r, i) => {
  const p = pyRows[i] || {};
  const ok = p.name === r.name && p.source === r.sourceLabel && p.score === r.score;
  if (!ok) fail++;
  console.log(
    (ok ? '✓' : '✗') + ' ' + String(r.name).padEnd(15),
    (r.sourceLabel + ' / ' + r.score).padEnd(24),
    (p.source + ' / ' + p.score) + (ok ? '' : '   ← KHÁC')
  );
});
console.log('-'.repeat(78));
if (fail) {
  console.log(`✗ FAIL: ${fail} dòng lệch giữa JS và Python`);
  process.exit(1);
}
console.log('✓ PASS: userscript phân loại và tính điểm khớp 100% với bản Python');

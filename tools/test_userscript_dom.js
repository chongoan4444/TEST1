#!/usr/bin/env node
/**
 * test_userscript_dom.js — chạy userscript trong DOM giả (jsdom) với cấu trúc DOM
 * THẬT của Pancake (.conversation-list-item#<page>_<psid>__<n>).
 *
 * Kiểm tra:
 *   1. chỉ gắn nhãn cho các dòng ĐANG HIỂN THỊ (dòng ngoài khung nhìn: không nhãn)
 *   2. cuộn danh sách -> nhãn xuất hiện ở các dòng mới
 *   3. tự xem tin nhắn -> hội thoại quảng cáo đổi từ "TN…" sang "QC"
 *   4. Alt+O ẩn/hiện tất cả; nút ▭ ẩn bảng nhưng NHÃN VẪN CHẠY; nút 🏷️/▤ mở lại
 *   5. khách mới load vào -> có nhãn ngay
 *
 *     npm i jsdom && node tools/test_userscript_dom.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('Bỏ qua: chưa có jsdom. Cài bằng: npm i jsdom');
  process.exit(0);
}

let html = fs.readFileSync(path.join(ROOT, 'demo', 'mock_pancake.html'), 'utf8');
const userscript = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');
html = html.replace('<script src="../userscripts/pancake-lead-badges.user.js"></script>',
  () => '<script>\n' + userscript + '\n</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/demo/mock_pancake.html',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

// --- giả lập layout: mỗi dòng cao 72px, khung nhìn 400px
const ROW_H = 72;
const VH = 400;
let scrollTop = 0;
Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; }, configurable: true,
});
window.Element.prototype.getBoundingClientRect = function () {
  const row = this.closest && this.closest('.conversation-list-item');
  if (!row || !row.parentElement) {
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
  }
  const idx = Array.prototype.indexOf.call(row.parentElement.children, row);
  const top = idx * ROW_H - scrollTop;
  return { top: top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 300, width: 300, x: 0, y: top };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = () => [...doc.querySelectorAll('.conversation-list-item')];
const rowName = row => (row.querySelector('.name-text') || {}).textContent;
const chipOf = row => row.querySelector('.__ls_chip');
const labeled = () => rows().filter(r => chipOf(r)).length;
const visibleIdx = () => rows().map((r, i) => ({ r, i }))
  .filter(({ r }) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom > 0 && b.top < VH; })
  .map(({ i }) => i);
const hostDisplay = () => { const h = doc.getElementById('__lead_source_host'); return h ? h.style.display : 'none'; };
const fabDisplay = () => { const f = doc.getElementById('__lead_source_fab'); return f ? f.style.display : 'none'; };
const panelBtn = sel => {
  const h = doc.getElementById('__lead_source_host');
  return h && h.shadowRoot ? h.shadowRoot.querySelector(sel) : null;
};
const pressAltO = () => doc.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'o', code: 'KeyO', altKey: true, bubbles: true }));

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  // --- bắt trạng thái NGAY SAU khi load (chưa kịp xem tin nhắn)
  await sleep(300);
  const early = rows().filter(chipOf).map(r => chipOf(r).textContent);
  check(early.some(c => c.indexOf('…') >= 0), 'trước khi xem tin nhắn: nhãn có dấu … = "chưa chắc" (' + early.slice(0, 3).join(' | ') + ')');
  const earlyAdChip = chipOf(rows().find(r => rowName(r) === 'Trần Bảo'));
  const earlyAd = earlyAdChip ? earlyAdChip.textContent : null;

  await sleep(2400);
  const all = rows().length;
  const vis = visibleIdx();
  console.log(`Tổng số dòng: ${all} · đang hiển thị: ${vis.length} (index ${vis.join(',')})`);
  console.log('Nhãn:', rows().filter(chipOf).map(r => rowName(r) + '=' + chipOf(r).textContent).join(' | '));

  check(labeled() === vis.length, `chỉ dòng đang hiển thị có nhãn (${labeled()}/${vis.length}, tổng ${all} dòng)`);
  check(rows().slice(vis.length).every(r => !chipOf(r)), 'các dòng ngoài khung nhìn KHÔNG bị gắn nhãn');

  // --- 3. enrich: quảng cáo chỉ nhận ra sau khi xem tin nhắn
  const adRow = rows().find(r => rowName(r) === 'Trần Bảo');
  const before = earlyAd || '(không có)';
  const after = chipOf(adRow) ? chipOf(adRow).textContent : '(không có)';
  check(/QC/.test(after) && !/…/.test(after), `tự xem tin nhắn -> nhận ra quảng cáo: "${before}" → "${after}"`);

  // --- 2. cuộn xuống: dòng mới vào khung nhìn phải có nhãn
  scrollTop = 288;
  doc.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  await sleep(900);
  const vis2 = visibleIdx();
  const labeledVis2 = vis2.filter(i => chipOf(rows()[i])).length;
  check(labeledVis2 === vis2.length, `sau khi cuộn: dòng mới vào khung nhìn đều có nhãn (${labeledVis2}/${vis2.length})`);

  // --- 4a. ▭ ẩn bảng, nhãn vẫn chạy
  const hidePanel = panelBtn('[data-act="hidePanel"]');
  check(!!hidePanel, 'có nút ▭ (ẩn bảng) trên panel');
  if (hidePanel) hidePanel.click();
  await sleep(300);
  check(hostDisplay() === 'none', '▭: bảng đã ẩn');
  check(labeled() > 0, '▭: NHÃN trên dòng chat vẫn hiển thị (giao diện tắt nhưng vẫn phân loại)');
  check(fabDisplay() !== 'none', '▭: có nút nổi để mở lại bảng');

  // mở lại bằng FAB
  const fabBtn = doc.getElementById('__lead_source_fab').shadowRoot.querySelector('button');
  fabBtn.click();
  await sleep(400);
  check(hostDisplay() !== 'none', 'bấm nút nổi: bảng hiện lại');

  // --- 4b. Alt+O ẩn tất cả
  pressAltO();
  await sleep(400);
  check(labeled() === 0, 'Alt+O: xoá hết nhãn');
  check(hostDisplay() === 'none', 'Alt+O: ẩn bảng');
  check(fabDisplay() !== 'none', 'Alt+O: vẫn còn nút 🏷️ để bật lại');

  // dữ liệu vẫn chạy khi đang ẩn
  const convsBefore = window.__leadSource.state.convs.size;
  doc.getElementById('refresh').click();
  await sleep(600);
  check(window.__leadSource.state.convs.size >= convsBefore, 'Alt+O: dữ liệu vẫn được cập nhật khi giao diện tắt');

  pressAltO();
  await sleep(800);
  check(labeled() >= vis2.length, 'Alt+O lần 2: nhãn xuất hiện lại ngay (' + labeled() + ')');

  // --- 5. khách mới load vào
  const before2 = labeled();
  doc.getElementById('add').click();
  await sleep(1000);
  check(labeled() > before2, `khách mới load vào -> có nhãn ngay (${before2} → ${labeled()})`);

  check(errors.length === 0, 'không có lỗi runtime' + (errors.length ? ': ' + errors[0] : ''));

  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS toàn bộ'));
  window.close();
  process.exit(fail ? 1 : 0);
})();

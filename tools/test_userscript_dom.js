#!/usr/bin/env node
/**
 * test_userscript_dom.js — chạy userscript trong DOM giả (jsdom), kiểm tra:
 *   1. mỗi dòng hội thoại đều có nhãn, bảng nổi hiện đủ nguồn + kí hiệu
 *   2. hội thoại mới load vào → có nhãn ngay
 *   3. Alt+O ẩn giao diện (mất nhãn, hiện nút 🏷️), Alt+O lần nữa khôi phục
 *   4. dữ liệu đổi (khách tự nhắn -> có ad_id) → nhãn tự cập nhật
 *
 * Cần jsdom (chỉ để test, không ảnh hưởng userscript):
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

// jsdom luôn trả offsetParent = null; coi như phần tử đang hiển thị để test gắn nhãn
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; },
  configurable: true,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const doc = window.document;
const chips = () => [...doc.querySelectorAll('.__ls_chip')].map(c => c.textContent);
const rows = () => [...doc.querySelectorAll('.conv .nm')].map(n => n.textContent);
const hostVisible = () => {
  const h = doc.getElementById('__lead_source_host');
  return !!(h && h.style.display !== 'none');
};
const fabVisible = () => {
  const f = doc.getElementById('__lead_source_fab');
  return !!(f && f.style.display !== 'none');
};
const panel = () => {
  const h = doc.getElementById('__lead_source_host');
  const w = h && h.shadowRoot && h.shadowRoot.querySelector('.wrap');
  return w ? w.textContent.replace(/\s+/g, ' ').trim() : '';
};
const pressAltO = () => doc.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'o', code: 'KeyO', altKey: true, bubbles: true }));

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  await sleep(2600);
  console.log('Dòng trong danh sách :', rows().join(' | '));
  console.log('Nhãn                 :', chips().join(' | '));
  check(chips().length === rows().length, 'mỗi dòng có đúng 1 nhãn (' + chips().length + '/' + rows().length + ')');
  check(chips().every(c => /\S+ \d+/.test(c)), 'nhãn có dạng "<kí hiệu> <điểm>"');

  const p1 = panel();
  ['Tệp khách', 'Quảng cáo', 'Bài viết', 'Live', 'Tự nhắn', 'Chốt ngay'].forEach(k =>
    check(p1.indexOf(k) >= 0, 'panel có mục "' + k + '"'));
  ['QC', 'BV', 'LV', 'TN'].forEach(k => check(p1.indexOf(k) >= 0, 'có kí hiệu ' + k + ' trong bảng kí hiệu'));
  check(hostVisible(), 'panel đang hiện');

  // --- Alt+O tắt
  pressAltO();
  await sleep(400);
  check(chips().length === 0, 'Alt+O: đã xoá hết nhãn khỏi danh sách');
  check(!hostVisible(), 'Alt+O: panel đã ẩn');
  check(fabVisible(), 'Alt+O: hiện nút 🏷️ để bật lại');

  // --- Alt+O bật lại
  pressAltO();
  await sleep(700);
  check(chips().length === rows().length, 'Alt+O lần 2: nhãn xuất hiện lại (' + chips().length + ')');
  check(hostVisible(), 'Alt+O lần 2: panel hiện lại');
  check(!fabVisible(), 'Alt+O lần 2: nút 🏷️ ẩn đi');

  // --- khách mới load vào
  const before = chips().length;
  doc.getElementById('add').click();
  await sleep(1000);
  check(chips().length === before + 1, 'khách mới load vào → có nhãn ngay (' + before + ' → ' + chips().length + ')');

  // --- dữ liệu đổi: khách "Quốc Việt" (Chưa rõ) bỗng có ad_id
  const data = window.eval('DATA');
  const target = data.convs.find(c => c.customers[0].name === 'Quốc Việt');
  const beforeChip = chips().find(c => c.indexOf('?') === 0);
  target.extra_info = { referral: { source: 'ADS', ad_id: '120210000000000' } };
  doc.getElementById('refresh').click();
  await sleep(1500);
  const afterChip = [...doc.querySelectorAll('.__ls_chip')]
    .filter(c => c.dataset.lsId === target.id)
    .map(c => c.textContent)[0];
  check(/QC/.test(afterChip || ''), 'dữ liệu đổi → nhãn tự cập nhật: "' + beforeChip + '" → "' + afterChip + '"');

  check(errors.length === 0, 'không có lỗi runtime' + (errors.length ? ': ' + errors[0] : ''));

  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS toàn bộ'));
  window.close();
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * test_userscript_dom.js — chạy userscript trong DOM giả (jsdom), kiểm tra:
 *   1. bảng nổi hiện đúng số lượng theo từng nguồn
 *   2. mỗi dòng hội thoại đều được gắn nhãn (chip)
 *   3. hội thoại mới xuất hiện → có nhãn ngay, không cần mở đoạn chat
 *
 * Cần jsdom (chỉ để test, không ảnh hưởng userscript):
 *     npm i jsdom            # trong thư mục bất kỳ
 *     NODE_PATH=$(npm root -g) node tools/test_userscript_dom.js
 * hoặc:
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
const chips = () => [...window.document.querySelectorAll('.__ls_chip')].map(c => c.textContent);
const rows = () => [...window.document.querySelectorAll('.conv .nm')].map(n => n.textContent);

function panelText() {
  const host = window.document.getElementById('__lead_source_host');
  const wrap = host && host.shadowRoot && host.shadowRoot.querySelector('.wrap');
  return wrap ? wrap.textContent.replace(/\s+/g, ' ').trim() : '';
}

(async () => {
  await sleep(2600);
  let fail = 0;

  console.log('Dòng trong danh sách :', rows().join(' | '));
  console.log('Nhãn đã gắn          :', chips().join(' | '));

  if (rows().length !== chips().length) { console.log('✗ chưa gắn đủ nhãn'); fail++; }
  else console.log('✓ mỗi dòng có 1 nhãn (' + chips().length + ')');

  const panel = panelText();
  ['Quảng cáo', 'Bài viết', 'Live', 'Tự nhắn', 'Chốt ngay'].forEach(k => {
    if (panel.indexOf(k) < 0) { console.log('✗ bảng nổi thiếu mục: ' + k); fail++; }
  });
  if (!fail) console.log('✓ bảng nổi hiện đủ 4 nguồn + số khách chốt ngay');

  const hadAds = chips().some(c => c.startsWith('QC'));
  console.log(hadAds ? '✓ nhận diện được khách quảng cáo (QC)' : '✗ không thấy khách quảng cáo');
  if (!hadAds) fail++;

  // thêm khách mới -> phải có nhãn ngay
  const before = chips().length;
  window.document.getElementById('add').click();
  await sleep(1000);
  const after = chips().length;
  if (after === before + 1) console.log('✓ khách mới xuất hiện → có nhãn ngay (' + before + ' → ' + after + ')');
  else { console.log('✗ khách mới chưa được gắn nhãn (' + before + ' → ' + after + ')'); fail++; }

  if (errors.length) { console.log('✗ lỗi runtime:', errors); fail++; }
  else console.log('✓ không có lỗi runtime');

  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS toàn bộ'));
  window.close();
  process.exit(fail ? 1 : 0);
})();

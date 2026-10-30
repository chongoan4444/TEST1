#!/usr/bin/env node
/**
 * test_userscript_toggle.js — kiểm tra bật/tắt giao diện trên DOM THẬT.
 *
 * Các kịch bản (đều là ca người dùng báo lỗi):
 *   1. ✕ ẩn tất cả  -> nhãn biến mất
 *   2. bấm 🏷️ (FAB) -> nhãn phải hiện lại NGAY, không chờ timer
 *   3. ▭ chỉ ẩn bảng -> nhãn trên dòng chat vẫn còn
 *   4. Alt+O 3 lần liên tiếp -> luôn quay lại đủ nhãn
 *   5. Pancake/React xoá sạch nhãn -> watchdog tự gắn lại < 4s
 *   6. Ẩn tab rồi quay lại -> gắn lại ngay
 *   7. Nút 🔍 trong bảng không được ném lỗi (trước đây dùng biến SEL_ROW đã xoá)
 *
 *     python3 tools/build_real_dom_fixture.py && node tools/test_userscript_toggle.js
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

const FIXTURE = path.join(ROOT, 'demo', 'real_dom_fixture_wrapped.html');
if (!fs.existsSync(FIXTURE)) {
  console.log('Chưa có fixture. Chạy: python3 tools/build_real_dom_fixture.py');
  process.exit(0);
}

const ROW_H = 72, VH = 400, LIST_H = 600;

let html = fs.readFileSync(FIXTURE, 'utf8');
const userscript = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');
html = html.replace('<script src="../userscripts/pancake-lead-badges.user.js"></script>',
  () => '<script>\n' + userscript + '\n</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const msg = String((e && e.message) || e);
  if (/Could not parse CSS stylesheet/.test(msg)) return;
  errors.push(msg);
});

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/toggle', pretendToBeVisual: true, virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; }, configurable: true,
});
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList && this.classList.contains('conversation-list')) {
    return { top: 0, bottom: LIST_H, height: LIST_H, left: 0, right: 340, width: 340, x: 0, y: 0 };
  }
  const all = [...doc.querySelectorAll('.conversation-list-item')];
  const idx = all.indexOf(this);
  if (idx < 0) return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
  const top = idx * ROW_H;
  return { top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 340, width: 340, x: 0, y: top };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// đếm số request đi ra để chứng minh tắt là không gọi mạng nữa
let _fetchN = 0;
(function () {
  const orig = window.fetch;
  window.fetch = function () { _fetchN++; return orig.apply(this, arguments); };
})();
const fetchCount = () => _fetchN;
const chips = () => doc.querySelectorAll('.__ls_chip').length;
const cfg = () => window.__leadSource.cfg;

function panelHost() {
  return doc.getElementById('__lead_source_host') ||
    [...doc.querySelectorAll('div')].find(el => el.shadowRoot && el.shadowRoot.querySelector('[data-act]'));
}
function clickPanel(act) {
  const h = panelHost();
  const b = h && h.shadowRoot.querySelector('[data-act="' + act + '"]');
  if (!b) return false;
  b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  return true;
}
function clickFab() {
  const f = doc.getElementById('__lead_source_fab');
  if (!f || !f.shadowRoot) return false;
  f.shadowRoot.querySelector('button')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return true;
}
function altO() {
  doc.dispatchEvent(new window.KeyboardEvent('keydown',
    { key: 'o', code: 'KeyO', altKey: true, bubbles: true, cancelable: true }));
}
function setHidden(v) {
  Object.defineProperty(doc, 'hidden', { value: v, configurable: true });
  Object.defineProperty(doc, 'visibilityState', { value: v ? 'hidden' : 'visible', configurable: true });
  doc.dispatchEvent(new window.Event('visibilitychange'));
}

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  await sleep(2600);
  const base = chips();
  check(base > 0, 'ban đầu có nhãn (' + base + ')');

  // 1. ✕ đóng BẢNG — nhãn vẫn phải hiện
  check(clickPanel('off'), 'bấm được nút ✕');
  check(cfg().showPanel === false, '✕ đóng bảng');
  check(chips() > 0, '✕: NHÃN VẪN HIỆN (' + chips() + ')');
  check(window.__leadSource.debug().running === true, '✕: script vẫn chạy');
  const fab = doc.getElementById('__lead_source_fab');
  check(!!fab && fab.style.display !== 'none', '✕: có nút nổi để mở lại bảng');

  // 2. mở lại bảng bằng nút nổi
  clickFab();
  check(cfg().showPanel === true, 'bấm nút nổi: mở lại bảng');
  check(chips() > 0, 'mở lại bảng: nhãn vẫn còn (' + chips() + ')');

  // 3. ▭ chỉ ẩn bảng, nhãn còn
  const before = chips();
  check(clickPanel('hidePanel'), 'bấm được nút ▭');
  check(chips() === before, '▭ chỉ ẩn bảng, nhãn vẫn còn (' + chips() + ')');
  clickFab();
  await sleep(200);
  check(cfg().showPanel !== false, 'mở lại bảng được');

  // 4. Alt+O chỉ đóng/mở bảng — nhãn không đổi
  for (let i = 1; i <= 3; i++) {
    altO();
    const closed = cfg().showPanel === false && chips() > 0;
    altO();
    const opened = cfg().showPanel === true && chips() > 0;
    check(closed && opened, 'Alt+O lần ' + i + ': chỉ đóng/mở bảng, nhãn vẫn hiện (' + chips() + ')');
  }

  // 5. React xoá sạch nhãn -> watchdog tự gắn lại
  doc.querySelectorAll('.__ls_chip').forEach(el => el.remove());
  check(chips() === 0, 'giả lập Pancake xoá sạch nhãn');
  await sleep(3500);
  check(chips() > 0, 'watchdog tự gắn lại nhãn (' + chips() + ')');

  // 6. ẩn tab rồi quay lại
  doc.querySelectorAll('.__ls_chip').forEach(el => el.remove());
  setHidden(true);
  await sleep(300);
  setHidden(false);
  await sleep(400);
  check(chips() > 0, 'quay lại tab là nhãn có lại (' + chips() + ')');

  // 7. nút 🔍 không lỗi
  const hadError = errors.length;
  const items = panelHost() ? panelHost().shadowRoot.querySelectorAll('[data-act="focus"]') : [];
  if (items.length) items[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  await sleep(200);
  check(errors.length === hadError, 'nút 🔍 không ném lỗi' + (errors.length ? ': ' + errors[hadError] : ''));

  // 9. NÚT BẬT/TẮT NHÃN trên bảng (chỉ ẩn/hiện nhãn, script vẫn chạy)
  check(chips() > 0, 'trước khi bấm nút Nhãn: đang có nhãn (' + chips() + ')');
  check(clickPanel('chips'), 'bấm được nút 🏷️ Nhãn trên bảng');
  check(chips() === 0, 'nút Nhãn TẮT: nhãn trên dòng chat biến mất');
  check(window.__leadSource.debug().running === true, 'nút Nhãn TẮT: script vẫn chạy (chỉ ẩn nhãn)');
  check(clickPanel('chips') && chips() > 0, 'nút Nhãn BẬT: nhãn hiện lại ngay (' + chips() + ')');

  // 8. TẮT HẲN bằng API (không phải nút trên giao diện)
  window.__leadSource.set({ enabled: false });
  await sleep(200);
  const fetches = fetchCount();
  await sleep(2000);
  check(fetchCount() === fetches, 'API tắt: không phát sinh request nào (' + fetches + ')');
  check(window.__leadSource.debug().running === false, 'API tắt: không còn vòng quét/poll');
  check(chips() === 0, 'API tắt: không còn nhãn nào');
  window.__leadSource.set({ enabled: true, showPanel: true });
  await sleep(600);
  check(chips() > 0, 'API bật lại: nhãn có lại ngay (' + chips() + ')');

  check(errors.length === 0, 'không lỗi runtime' + (errors.length ? ': ' + errors[0] : ''));
  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS — bật/tắt, tự phục hồi và chuyển tab đều đúng'));
  window.close();
  process.exit(fail ? 1 : 0);
})();

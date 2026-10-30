#!/usr/bin/env node
/**
 * test_userscript_selectors.js — Pancake ĐỔI GIAO DIỆN (đổi tên class) thì script
 * còn gắn nhãn được không?
 *
 * Test lấy trang mô phỏng rồi ĐỔI TÊN toàn bộ class (conversation-list-item ->
 * convx-row, name-text -> nmx ...) , sau đó kiểm tra:
 *   1. vẫn tìm ra các dòng (nhờ id thật <page>_<psid>__<n>)
 *   2. vẫn gắn được nhãn cạnh tên khách
 *   3. __leadSource.debug() báo đúng chế độ dò (domMode)
 *
 *     npm i jsdom && node tools/test_userscript_selectors.js
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

const RENAME = [
  ['conversation-list-item', 'convx-row'],
  ['conversation-list', 'convx-list'],
  ['name-module-text', 'nmwrapx'],
  ['name-text', 'nmx'],
  ['snippet-text', 'snx'],
  ['conversation_tags_item', 'tagx'],
];

function renameClasses(html) {
  let out = html;
  RENAME.forEach(([a, b]) => { out = out.split(a).join(b); });
  return out;
}

function build(html) {
  const userscript = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');
  const withScript = html.replace('<script src="../userscripts/pancake-lead-badges.user.js"></script>',
    () => '<script>\n' + userscript + '\n</script>');

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));

  const dom = new JSDOM(withScript, {
    runScripts: 'dangerously',
    url: 'http://localhost/demo/mock_pancake.html',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.ownerDocument.body; }, configurable: true,
  });
  const ROW_H = 72;
  window.Element.prototype.getBoundingClientRect = function () {
    const list = this.parentElement;
    const isRow = /^\d+_\d+__\d+$/.test(this.id || '');
    if (!isRow || !list) return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
    const idx = Array.prototype.indexOf.call(list.children, this);
    const top = idx * ROW_H;
    return { top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 300, width: 300, x: 0, y: top };
  };
  return { dom, window, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const base = fs.readFileSync(path.join(ROOT, 'demo', 'mock_pancake.html'), 'utf8');
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  console.log('Giao diện CHUẨN:');
  {
    const { window, errors } = build(base);
    await sleep(2200);
    const n = window.document.querySelectorAll('.__ls_chip').length;
    check(n > 0, 'gắn được nhãn (' + n + ')');
    check(errors.length === 0, 'không lỗi runtime');
    window.close();
  }

  console.log('\nGiao diện ĐÃ ĐỔI TÊN CLASS (mô phỏng Pancake đổi UI):');
  {
    const { window, errors } = build(renameClasses(base));
    await sleep(2600);
    const doc = window.document;
    const chips = doc.querySelectorAll('.__ls_chip');
    const rep = window.__leadSource.debug();
    console.log('   domMode:', rep.domMode, '· rowsFound:', rep.rowsFound, '· labeled:', rep.rowsWithChip);
    check(rep.domMode !== 'none', 'vẫn dò ra dòng hội thoại (chế độ: ' + rep.domMode + ')');
    check(chips.length > 0, 'vẫn gắn được nhãn (' + chips.length + ')');
    const chipText = chips.length ? chips[0].textContent : '';
    check(/QC|BV|LV|TN|\?/.test(chipText), 'nhãn có nội dung phân loại ("' + chipText + '")');
    const row = chips.length ? chips[0].closest('[id]') : null;
    check(!!row && /^\d+_\d+__\d+$/.test(row.id), 'nhãn nằm trong đúng dòng có id thật (' + (row && row.id) + ')');
    check(errors.length === 0, 'không lỗi runtime');
    window.close();
  }

  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS: đổi giao diện vẫn hoạt động'));
  process.exit(fail ? 1 : 0);
})();

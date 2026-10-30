#!/usr/bin/env node
/**
 * test_userscript_realdom.js — chạy userscript trên DOM **THẬT** của Pancake.
 *
 * Chạy 2 biến thể, cả hai đều dựng từ html3/html2/html.txt (đã ẩn danh):
 *   1. demo/real_dom_fixture.html          — id nằm ngay trên dòng  (`<div id="p_psid__n" class="media conversation-list-item">`)
 *   2. demo/real_dom_fixture_wrapped.html  — id nằm ở THẺ BỌC, dòng không có id
 *      (đúng kiểu màn hình "comment list": `<div offsetx id="p_psid"><div class="media conversation-list-item">`)
 *
 *     python3 tools/build_real_dom_fixture.py
 *     npm i jsdom && node tools/test_userscript_realdom.js
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

const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');
const ROW_H = 72, VH = 400, LIST_H = 600;

function run(fixtureName) {
  return new Promise(resolve => {
    const file = path.join(ROOT, 'demo', fixtureName);
    if (!fs.existsSync(file)) {
      console.log('Chưa có ' + fixtureName + '. Chạy: python3 tools/build_real_dom_fixture.py');
      return resolve({ fail: 0, skipped: true });
    }
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace('<script src="../userscripts/pancake-lead-badges.user.js"></script>',
      () => '<script>\n' + USERSCRIPT + '\n</script>');

    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => {
      const msg = String(e && e.message || e);
      if (/Could not parse CSS stylesheet/.test(msg)) return;   // giới hạn của jsdom, không phải lỗi code
      errors.push(msg);
    });

    const dom = new JSDOM(html, {
      runScripts: 'dangerously', url: 'http://localhost/' + fixtureName,
      pretendToBeVisual: true, virtualConsole: vc,
    });
    const { window } = dom;
    const doc = window.document;

    Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
      get() { return this.ownerDocument.body; }, configurable: true,
    });
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

    setTimeout(() => {
      let fail = 0;
      const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fail++; };
      const rows = () => [...doc.querySelectorAll('.conversation-list-item')];
      const chips = () => [...doc.querySelectorAll('.__ls_chip')];

      const rep = window.__leadSource.debug();
      const expectVisible = Math.min(rows().length, Math.ceil(VH / ROW_H) + Math.ceil(LIST_H / ROW_H));

      console.log(`\n── ${fixtureName} ──`);
      console.log(`  ${rows().length} dòng thật · mode=${rep.domMode} · thấy=${rep.rowsFound} · hiện=${rep.rowsVisible} · nhãn=${rep.rowsWithChip}` +
        ` · id từ thẻ bọc=${rep.idFromWrapper} · verdict=${rep.verdict}`);
      console.log('  nhãn: ' + chips().slice(0, 6).map(c => c.textContent).join(' | '));

      check(rep.rowsFound === rows().length, 'đếm đúng số dòng (' + rep.rowsFound + '/' + rows().length + ')');
      check(rep.rowsWithChip > 0, 'GẮN ĐƯỢC NHÃN trên DOM thật (' + rep.rowsWithChip + ' nhãn)');
      check(rep.rowsWithChip === rep.rowsVisible,
        'mỗi dòng đang hiển thị đều có nhãn (' + rep.rowsWithChip + '/' + rep.rowsVisible + ')');
      check(rep.rowsVisible <= expectVisible, 'chỉ xử lý dòng trong khung nhìn (' + rep.rowsVisible + ' ≤ ' + expectVisible + ')');
      check(rep.verdict === 'OK', 'verdict = OK (không còn "không gắn được nhãn")');
      check(!!rep.sampleConvId, 'đọc được id hội thoại (mẫu: ' + rep.sampleConvId + ')');

      const row = chips()[0] && chips()[0].closest('.conversation-list-item');
      check(!!row, 'nhãn nằm trong dòng hội thoại');
      const nameEl = row && row.querySelector('.name-text');
      check(!!nameEl && nameEl.nextElementSibling === chips()[0],
        'nhãn nằm NGAY SAU tên khách (.name-text), không phải sau khối bọc');
      check(chips().every(c => !c.closest('.time-modul')), 'không gắn lẫn vào ô thời gian');

      const offscreen = rows().filter(r => r.getBoundingClientRect().top >= VH);
      check(offscreen.every(r => !r.querySelector('.__ls_chip')), 'dòng ngoài khung nhìn không bị gắn (' + offscreen.length + ')');
      check(errors.length === 0, 'không lỗi runtime' + (errors.length ? ': ' + errors[0] : ''));

      window.close();
      resolve({ fail, skipped: false });
    }, 2600);
  });
}

(async () => {
  let total = 0, skipped = false;
  for (const f of ['real_dom_fixture.html', 'real_dom_fixture_wrapped.html']) {
    const r = await run(f);
    total += r.fail;
    skipped = skipped || r.skipped;
  }
  if (skipped) return process.exit(0);
  console.log('\n' + (total ? '✗ FAIL (' + total + ' lỗi)' : '✓ PASS — userscript chạy đúng trên DOM thật của Pancake (2 kiểu đánh dấu id)'));
  process.exit(total ? 1 : 0);
})();

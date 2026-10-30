#!/usr/bin/env node
/**
 * test_userscript_enrich.js — kiểm tra việc ĐỌC TIN NHẮN để phân loại.
 *
 * Dữ liệu thật (batmesss.har / loaddanhsach.har) cho thấy Pancake trả:
 *   ?customer_id=…                              -> hồ sơ khách, KHÔNG có messages
 *   ?customer_id=…&separate_pos=true            -> CÓ messages
 *   ?customer_id=…&user_view=true&is_new_api=true&separate_pos=true -> CÓ messages
 * Test này giả lập trường hợp xấu nhất: biến thể đầu trả rỗng, script phải tự thử
 * biến thể tiếp theo và cuối cùng vẫn ra nhãn QC (thay vì "?" mãi).
 *
 *   node tools/test_userscript_enrich.js
 */

const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('Bỏ qua: chưa có jsdom. Cài bằng: npm i jsdom');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = require('fs').readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');

const PAGE = '881264518397934';
const PSID = '28856202704022307';
const CONV = PAGE + '_' + PSID;
const CUST = 'aaaaaaaa-1111-2222-3333-444444444444';

const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>enrich</title>
<style>
body{margin:0;font:14px sans-serif}
.conversation-list{width:340px;height:600px;overflow-y:auto;background:#fff}
.media.conversation-list-item{display:flex;gap:8px;padding:9px 12px;border-bottom:1px solid #eee;height:72px;box-sizing:border-box}
.media-body{flex:1;min-width:0}
</style></head><body>
<div class="conversation-list">
  <div id="${CONV}__0" class="media conversation-list-item">
    <div class="media-left"><img class="customer-avatar-${PSID}"></div>
    <div class="media-body body-conver-item">
      <div class="name-module platform-facebook">
        <span class="name-module-text"><span class="name-text">Khách Quảng Cáo</span></span>
        <span class="time-modul">10:22</span>
      </div>
      <div class="snippet-wrap"><div class="snippet-line"><div class="snippet-text">Còn size M không shop</div></div></div>
    </div>
  </div>
</div>
<script>
// --- API giả: mô phỏng ĐÚNG hành vi thật của Pancake ---
window.__calls = [];
const conv = {
  id: ${JSON.stringify(CONV)}, page_id: ${JSON.stringify(PAGE)}, type: 'INBOX',
  customers: [{ id: ${JSON.stringify(CUST)}, fb_id: ${JSON.stringify(PSID)}, name: 'Khách Quảng Cáo' }],
  from_psid: ${JSON.stringify(PSID)}, snippet: 'Còn size M không shop', message_count: 3,
  unread_count: 1, tags: [], extra_info: {}, updated_at: '2026-10-30T03:00:00Z'
};
window.fetch = function (input) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  window.__calls.push(url);
  let body;
  if (/\\/messages/.test(url)) {
    if (/separate_pos=true/.test(url) && !/user_view=true/.test(url)) {
      // biến thể THỨ HAI: trả tin nhắn thật (có ad_click)
      body = { success: true, messages: [
        { id: 'm1', type: 'INBOX', conversation_id: ${JSON.stringify(CONV)},
          attachments: [{ type: 'ad_click', ad_id: '1202502696893800', url: 'https://facebook.com/1' }] }
      ] };
    } else {
      // biến thể đầu: Pancake trả hồ sơ khách, KHÔNG có messages (đúng như HAR)
      body = { success: true, customers: {}, available_for_report_phone_numbers: [], reports_by_phone: {} };
    }
  } else {
    body = { success: true, conversations: [conv] };
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; } });
};
// gọi danh sách SAU khi userscript đã treo hook (giống lúc Pancake tải trang)
</script>
<script>
${USERSCRIPT}
</script>
<script>
window.fetch('/api/v1/pages/${PAGE}/conversations?unread_first=true&mode=OR', { method: 'POST' });
</script>
</body></html>`;

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = String((e && e.message) || e);
  if (/Could not parse CSS stylesheet/.test(m)) return;
  errors.push(m);
});

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/enrich', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;

Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return this.ownerDocument.body; }, configurable: true });
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList && this.classList.contains('conversation-list')) {
    return { top: 0, bottom: 600, height: 600, left: 0, right: 340, width: 340, x: 0, y: 0 };
  }
  if (this.id === CONV + '__0') return { top: 0, bottom: 72, height: 72, left: 0, right: 340, width: 340, x: 0, y: 0 };
  return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chip = () => doc.querySelector('.__ls_chip');

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  await sleep(4000);
  const rep = window.__leadSource.debug();
  const c = chip();

  console.log('URL đã gọi:');
  [...new Set(window.__calls)].forEach(u => console.log('   ' + u.replace('http://localhost', '').slice(0, 120)));
  console.log('enrichLast:', JSON.stringify(rep.enrichLast));

  check(!!c, 'có nhãn trên dòng');
  check(c && c.textContent === 'QC', 'nhãn là QC sau khi thử biến thể URL thứ hai (' + (c ? c.textContent : '—') + ')');
  check(window.__calls.some(u => /messages/.test(u) && /user_view=true/.test(u)), 'đã thử biến thể URL đầu tiên');
  check(window.__calls.some(u => /messages/.test(u) && /separate_pos=true/.test(u) && !/user_view=true/.test(u)),
    'đã tự thử biến thể URL thứ hai');
  check(window.__calls.some(u => /messages/.test(u) && /customer_id=/.test(u)), 'URL có customer_id (lấy từ danh sách hội thoại)');

  const t = c ? c.title : '';
  check(/ad_click/.test(t), 'tooltip nêu đúng căn cứ ad_click');
  check(errors.length === 0, 'không lỗi runtime' + (errors.length ? ': ' + errors[0] : ''));

  console.log('\n' + (fail ? '✗ FAIL (' + fail + ' lỗi)' : '✓ PASS — tự tìm được biến thể URL trả tin nhắn'));
  window.close();
  process.exit(fail ? 1 : 0);
})();

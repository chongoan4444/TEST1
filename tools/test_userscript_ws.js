#!/usr/bin/env node
/**
 * test_userscript_ws.js — kiểm tra việc NGHE TRƯỚC từ websocket.
 *
 * Dữ liệu thật: batmesss.har có 1 khung websocket tới wss://edge-chat.facebook.com/chat.
 * Trong khung "deleteThenInsertThread" có sẵn:
 *     entity_id=61594409994701            (psid khách)
 *     "name":"ad_id.120251435064020732"   (nhãn quảng cáo Facebook gắn cho hội thoại)
 * -> tức là biết hội thoại đến từ quảng cáo TRƯỚC khi Pancake gọi lại danh sách.
 *
 * Test nạp CHÍNH các khung thật đó (demo/ws_frames.json) vào một WebSocket giả và kiểm:
 *   1. bắt được psid + ad_id  -> hội thoại có nguồn "quảng cáo" ngay
 *   2. dòng chat hiện QC dù API danh sách KHÔNG có thông tin nguồn (đúng dữ liệu thật)
 *   3. khung không có ad_id thì không gắn gì (không đoán)
 *   4. khung gộp nhiều psid thì bỏ (không đoán)
 *   5. trang vẫn nhận được message của websocket như bình thường (hook không phá app)
 *
 *   NODE_PATH=/tmp/jsdomtest/node_modules node tools/test_userscript_ws.js
 */

const path = require('path');
const fs = require('fs');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('Bỏ qua: chưa có jsdom. Cài bằng: npm i jsdom');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-lead-badges.user.js'), 'utf8');
const FRAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'ws_frames.json'), 'utf8')).frames;

const PAGE = '834072796450267';
const PSID = '61594409994701';
const CONV = PAGE + '_' + PSID;
const CUST = 'ffffffff-1111-2222-3333-444444444444';

const frameWithAd = FRAMES.find(f => f.co_ad_id > 0);
const frameNoAd = FRAMES.find(f => f.co_ad_id === 0);
const frameMulti = FRAMES.filter(f => f.co_ad_id === 0 && f.psid.length > 2)[0] || frameNoAd;

const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>ws</title>
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
        <span class="name-module-text"><span class="name-text">Khách Từ Quảng Cáo</span></span>
        <span class="time-modul">10:22</span>
      </div>
      <div class="snippet-wrap"><div class="snippet-line"><div class="snippet-text">Ib mình mẫu này</div></div></div>
    </div>
  </div>
</div>
<script>
// --- WebSocket GIẢ: ghi lại listener, cho phép bơm khung thật vào ---
window.__pageMsg = 0;
window.WebSocket = class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this._l = []; }
  addEventListener(t, f) { this._l.push([t, f]); }
  removeEventListener(t, f) { this._l = this._l.filter(x => x[1] !== f); }
  dispatch(kind, data) { this._l.slice().forEach(x => { if (x[0] === kind) x[1]({ data: data }); }); }
  send() {}
  close() {}
};
// --- API giả: danh sách hội thoại KHÔNG có thông tin nguồn (đúng như HAR) ---
window.__calls = [];
const conv = {
  id: ${JSON.stringify(CONV)}, page_id: ${JSON.stringify(PAGE)}, type: 'INBOX',
  customers: [{ id: ${JSON.stringify(CUST)}, fb_id: ${JSON.stringify(PSID)}, name: 'Khách Từ Quảng Cáo' }],
  from_psid: ${JSON.stringify(PSID)}, snippet: 'Ib mình mẫu này', message_count: 2,
  unread_count: 1, tags: [], extra_info: {}, post: null, post_id: null, updated_at: '2026-10-31T03:00:00Z'
};
window.fetch = function (input) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  window.__calls.push(url);
  let body;
  if (/\\/messages/.test(url)) {
    // tin nhắn KHÔNG có ad_click, cũng KHÔNG có ad_clicks -> chỉ websocket mới biết nguồn
    body = { success: true, messages: [
      { id: 'm1', type: 'INBOX', conversation_id: ${JSON.stringify(CONV)}, attachments: [] },
      { id: 'm2', type: 'INBOX', conversation_id: ${JSON.stringify(CONV)}, attachments: [] }
    ], conversation_id: ${JSON.stringify(CONV)} };
  } else {
    body = { success: true, conversations: [conv] };
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; } });
};
</script>
<script>
${USERSCRIPT}
</script>
<script>
window.__ws = new WebSocket('wss://edge-chat.facebook.com/chat');
// listener của TRANG (phải vẫn nhận được message sau khi userscript treo hook)
window.__ws.addEventListener('message', function () { window.__pageMsg++; });
window.__frames = ${JSON.stringify(FRAMES.map(f => f.b64))};
window.__multi = null;
</script>
</body></html>`;

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = String((e && e.message) || e);
  if (/Could not parse CSS stylesheet/.test(m)) return;
  errors.push(m);
});

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/pages/' + PAGE + '/conversations',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const { window } = dom;
const doc = window.document;

Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return doc.body; }, configurable: true });
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList && this.classList.contains('conversation-list')) {
    return { top: 0, bottom: 600, height: 600, left: 0, right: 340, width: 340, x: 0, y: 0 };
  }
  if (this.id === CONV + '__0') return { top: 0, bottom: 72, height: 72, left: 0, right: 340, width: 340, x: 0, y: 0 };
  return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, y: 0 };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chip = () => doc.querySelector('.__ls_chip');
const toBuf = b64 => {
  const bin = window.atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
};

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  // tắt đọc tin nhắn để chắc chắn nhãn đến từ websocket, không phải từ API
  window.__leadSource.set({ enrichVisible: false });

  // 1. khung THẬT có ad_id
  window.__ws.dispatch('message', toBuf(frameWithAd.b64));
  await sleep(200);
  const attr = window.__leadSource.state.attr;
  const rec = attr && attr.get ? attr.get(CONV) : null;
  check(!!rec, 'bắt được hội thoại ' + CONV + ' từ khung websocket thật');
  check(rec && rec.src === 'ws', 'đánh dấu nguồn là websocket');
  check(rec && rec.adId === '120251435064020732', 'đúng ad_id 120251435064020732 (' + (rec && rec.adId) + ')');
  check(rec && rec.ad.length === 2, 'giữ cả 2 ad_id trong khung (' + (rec ? rec.ad.length : 0) + ')');

  // 2. dòng chat hiện QC dù API danh sách không có thông tin nguồn
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(1500);
  const c = chip();
  check(!!c, 'có nhãn trên dòng chat');
  check(c && c.textContent === 'QC', 'nhãn là QC nhờ websocket (' + (c ? c.textContent : '—') + ')');
  check(window.__calls.every(u => !/messages/.test(u)), 'KHÔNG cần gọi API tin nhắn (enrich đã tắt)');

  // 3. khung thật KHÔNG có ad_id -> không gắn gì thêm
  const before = attr.size;
  window.__ws.dispatch('message', toBuf(frameNoAd.b64));
  await sleep(120);
  check(attr.size === before, 'khung không có ad_id thì không gắn nhãn bừa');

  // 4. khung gộp NHIỀU psid + ad_id -> bỏ, không đoán
  //    (khung tổng hợp, không phải khung thật: 2 psid + 1 ad_id)
  const fakeMulti = 'deleteThenInsertThread entity_id=777000111222&entity_id=888000222333& "name","ad_id.120259999999999"';
  const size2 = attr.size;
  window.__ws.dispatch('message', fakeMulti);
  await sleep(120);
  check(attr.size === size2, 'khung gộp nhiều hội thoại thì bỏ (không đoán)');

  // 5. trang vẫn nhận message như thường
  check(window.__pageMsg === 3, 'listener của trang vẫn nhận đủ 3 khung (' + window.__pageMsg + ')');
  check(new window.WebSocket('wss://x/') instanceof window.WebSocket, 'new WebSocket() vẫn tạo được đối tượng');

  const rep = window.__leadSource.debug();
  check(rep.wsHits >= 1, 'debug có đếm số lần bắt từ websocket (' + rep.wsHits + ')');
  check(errors.length === 0, 'không có lỗi JS' + (errors.length ? ': ' + errors[0] : ''));

  console.log(fail ? '\n❌ ' + fail + ' mục hỏng' : '\n✅ tất cả đạt');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();

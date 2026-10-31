#!/usr/bin/env node
/**
 * test_radar.js — kiểm tra script "Radar tin nhắn TỚI" (chỉ tin KHÁCH gửi đến).
 *
 * Dùng khung websocket THẬT trong demo/ws_frames.json:
 *   #28 "message-khach": insertMessage, sender = psid khách  -> PHẢI báo
 *   #37 "message-shop" : insertMessage, sender = page id     -> KHÔNG báo
 *   #33 "thread"       : deleteThenInsertThread (không có sender) -> chưa rõ chiều -> mặc định không báo
 *   #88 "gop"          : khung gộp nhiều hội thoại            -> bỏ
 * và API danh sách: last_sent_by là OBJECT {id,…} -> so id với psid / page_id.
 *
 *   NODE_PATH=/tmp/jsdomtest/node_modules node tools/test_radar.js
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
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscripts', 'pancake-new-message-radar.user.js'), 'utf8');
const FRAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'ws_frames.json'), 'utf8')).frames;
const F = kind => FRAMES.find(f => f.kind === kind);
const fKhach = F('message-khach');
const fShop = F('message-shop');
const fThread = F('thread');
const fGop = F('gop');

const PAGE = '834072796450267';
const PSID = '61594409994701';
const CONV = PAGE + '_' + PSID;
const OTHER = PAGE + '_100061610676863';

const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>radar</title>
<style>
body{margin:0;font:14px system-ui,sans-serif}
.conversation-list{width:340px;height:600px;overflow-y:auto}
.conversation-list-item{height:72px;border-bottom:1px solid #eee}
</style></head><body>
<div class="conversation-list">
  <div id="${OTHER}__0" class="conversation-list-item"><div class="name-text">Khách Khác</div><div class="snippet-text">Ok shop</div></div>
  <div id="${CONV}__0" class="conversation-list-item"><div class="name-text">Ngọc Ánh</div><div class="snippet-text">Ib mình mẫu này</div></div>
</div>
<script>
window.__pageMsg = 0;
window.WebSocket = class FakeWS {
  constructor(url) { this.url = url; this._l = []; }
  addEventListener(t, f) { this._l.push([t, f]); }
  removeEventListener(t, f) { this._l = this._l.filter(x => x[1] !== f); }
  dispatch(kind, data) { this._l.slice().forEach(x => { if (x[0] === kind) x[1]({ data: data }); }); }
  send() {} close() {}
};
window.__listCalls = 0;
window.PAGE = ${JSON.stringify(PAGE)};
window.PSID = ${JSON.stringify(PSID)};
// last_sent_by là OBJECT giống dữ liệu thật
window.__convs = [
  { id: ${JSON.stringify(OTHER)}, page_id: ${JSON.stringify(PAGE)}, from_psid: '100061610676863',
    customers: [{ id: 'u1', fb_id: '100061610676863', name: 'Khách Khác' }],
    snippet: 'Ok shop', updated_at: '2026-10-31T02:00:00Z',
    last_sent_by: { id: '100061610676863', name: 'Khách Khác' } },
  { id: ${JSON.stringify(CONV)}, page_id: ${JSON.stringify(PAGE)}, from_psid: ${JSON.stringify(PSID)},
    customers: [{ id: 'u2', fb_id: ${JSON.stringify(PSID)}, name: 'Ngọc Ánh' }],
    snippet: 'Ib mình mẫu này', updated_at: '2026-10-31T02:10:00Z',
    last_sent_by: { id: ${JSON.stringify(PAGE)}, name: 'Huyền Nguyễn Shop' } }
];
window.__listUrls = [];
window.__pageOverride = null;
window.__pageCounts = {};
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const path = url.split('?')[0];
  const isList = url.indexOf('/messages') < 0 && path.indexOf('/api/v1/') >= 0 && path.endsWith('/conversations');
  if (isList) {
    window.__listCalls++;
    window.__listUrls.push(((init && init.method) || 'GET') + ' ' + url);
  }
  const isPageList = path.indexOf('/api/v1/pages/') >= 0;
  const body = isPageList
    ? { success: true, conversations: (window.__pageOverride || window.__convs), pages_with_current_count: {} }
    : { success: true, conversations: window.__convs, pages_with_current_count: window.__pageCounts };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; } });
};
/** khung insertMessage tổng hợp (cùng dạng với khung thật, không phải lắt léo escape)
 *  dạng: [5,\"insertMessage\",\"<nội dung>\",[9],[19,\"80\"],[19,\"<psid>\"],…,\"mid.…\",\"<id>\",[19,\"<sender>\"]
 */
window.__msgSeq = 0;
window.__msgFrame = function (psid, text, fromCustomer, mid) {
  window.__msgSeq++;
  const q = String.fromCharCode(92) + '"';      // \"  (một dấu \ rồi dấu ")
  const sender = fromCustomer ? psid : window.PAGE;
  return '[5,' + q + 'insertMessage' + q + ',' + q + text + q + ',[9],[19,' + q + '80' + q + '],[19,' + q + psid + q +
    '],[19,' + q + '0' + q + '],[19,' + q + '1' + q + '],[19,' + q + '1' + q + '],[9],' +
    q + (mid || ('mid.$demo' + window.__msgSeq)) + q + ',' + q + '75178901770' + q + ',[19,' + q + sender + q + ']';
};
</script>
<script>
${SCRIPT}
</script>
<script>
window.__ws = new WebSocket('wss://edge-chat.facebook.com/chat?region=pnb');
window.__ws.addEventListener('message', function () { window.__pageMsg++; });
window.__b64 = ${JSON.stringify({ khach: fKhach.b64, shop: fShop.b64, thread: fThread.b64, gop: fGop.b64 })};
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toBuf = b64 => {
  const bin = window.atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
};
const items = () => window.__radar.items;
const diag = () => window.__radar.debug().diag;

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  await sleep(400);
  check(!!window.__radar, 'script nạp được');
  check(diag().hook === true, 'hook WebSocket đã treo');

  // nạp danh sách để biết tên
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  check((window.__radar.people.get(PSID) || {}).name === 'Ngọc Ánh', 'ghép psid -> tên "Ngọc Ánh"');

  // ---- 1. KHUNG THẬT của KHÁCH (#28): sender = psid -> phải báo
  window.__ws.dispatch('message', toBuf(fKhach.b64));
  await sleep(250);
  const it = items()[0];
  check(items().length === 1, 'báo tin KHÁCH từ khung thật #28');
  check(!!it && it.snippet === 'đắt cái áo mà 10 ngày chưa có', 'đúng nội dung (' + (it && it.snippet) + ')');
  check(!!it && it.name === 'Ngọc Ánh', 'đúng tên (' + (it && it.name) + ')');
  check(!!it && it.sender === PSID, 'nhận đúng sender = psid khách (' + (it && it.sender) + ')');
  check(!!it && it.dirKnown === true, 'chiều tin xác định được');
  check(!!it && it.posNow === 2, 'đúng vị trí (dòng 2)');

  // ---- 2. KHUNG THẬT của SHOP (#37): sender = page id -> KHÔNG báo
  const out0 = diag().skippedOut;
  window.__ws.dispatch('message', toBuf(fShop.b64));
  await sleep(200);
  check(items().length === 1, 'KHÔNG báo tin shop (#37 có sender = page id)');
  check(diag().skippedOut === out0 + 1, 'đếm đúng 1 tin shop bị bỏ (' + diag().skippedOut + ')');

  // ---- 3. Khung cấp hội thoại (#33): không có sender -> chưa rõ chiều -> mặc định không báo
  const unk0 = diag().skippedUnknown;
  window.__ws.dispatch('message', toBuf(fThread.b64));
  await sleep(200);
  check(items().length === 1, 'khung cấp hội thoại không rõ chiều: chưa báo');
  check(diag().skippedUnknown === unk0 + 1, 'đếm đúng 1 tin chưa rõ chiều bị bỏ');

  // ---- 4. khung gộp nhiều hội thoại -> bỏ
  window.__ws.dispatch('message', toBuf(fGop.b64));
  await sleep(150);
  check(items().length === 1, 'khung gộp nhiều hội thoại thì bỏ');

  // ---- 5. API danh sách: last_sent_by = page -> không báo
  window.__convs[1].snippet = 'Dạ shop gửi bảng size ạ';
  window.__convs[1].updated_at = '2026-10-31T03:00:00Z';
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  check(items().length === 1, 'API danh sách: tin shop (last_sent_by.id = page) không báo');

  // ---- 6. API danh sách: last_sent_by.id = psid khách -> báo
  window.__convs[0].snippet = 'Shop ơi giao hôm nay không';
  window.__convs[0].updated_at = '2026-10-31T03:30:00Z';
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  const viaList = items().find(i => i.via === 'danh sách');
  check(!!viaList, 'API danh sách: tin khách (last_sent_by.id = psid) thì báo');
  check(!!viaList && viaList.name === 'Khách Khác', 'đúng tên (' + (viaList && viaList.name) + ')');
  check(!!viaList && viaList.dirKnown === true, 'chiều tin xác định từ last_sent_by');

  // ---- 7. giao diện: KHÔNG tự báo (không biết chiều) nhưng phải KÍCH HOẠT gọi lại danh sách ngay
  const before = items().length;
  const pollsBefore = window.__radar.debug().diag.polls || 0;
  window.__convs[0].snippet = 'Còn size L không shop';
  window.__convs[0].updated_at = '2026-10-31T03:55:00Z';
  doc.getElementById(OTHER + '__0').querySelector('.snippet-text').textContent = 'Còn size L không shop';
  await sleep(900);   // mutation -> tự gọi lại danh sách (~150ms) -> nhận tin (~300ms)
  const lagItem = items()[0];
  check(items().length === before + 1, 'dòng vừa đổi -> tự gọi danh sách ngay và báo trong ~1 giây');
  check(!!lagItem && lagItem.lag > 0, 'ghi lại độ trễ so với lúc dòng đổi (' + (lagItem && lagItem.lag) + 'ms)');
  check((window.__radar.debug().diag.polls || 0) > pollsBefore, 'có thêm lần tự gọi lại danh sách');

  // ---- 8. khung tin nhắn tổng hợp: khách -> báo, shop -> không
  const base2 = items().length;
  window.__ws.dispatch('message', window.__msgFrame(PSID, 'Cho mình xin địa chỉ shop', true));
  await sleep(250);
  check(items().length === base2 + 1, 'khung tổng hợp: tin khách được báo');
  window.__ws.dispatch('message', window.__msgFrame(PSID, 'Dạ shop ở Hà Nội ạ', false));
  await sleep(250);
  check(items().length === base2 + 1, 'khung tổng hợp: tin shop không báo');

  // ---- 9. nút 🧪 + 🔍
  Array.from(doc.querySelectorAll('[data-a="test"]'))[0].click();
  await sleep(120);
  check(items().some(i => i.via === 'thử'), 'nút 🧪 bắn được tin thử');
  Array.from(doc.querySelectorAll('[data-a="diag"]'))[0].click();
  await sleep(100);
  const box = doc.querySelector('.__rd_diag');
  check(box && box.classList.contains('open'), 'nút 🔍 mở bảng chẩn đoán');
  check(box && /bỏ vì là tin shop/.test(box.textContent), 'chẩn đoán ghi số tin shop đã bỏ');
  check(box && /cấp tin nhắn/.test(box.textContent), 'chẩn đoán phân loại khung cấp tin nhắn');

  // ---- 11. endpoint THẬT của app: POST /api/v1/conversations (tinnhanmoi.har)
  const fd = new window.FormData();
  fd.append('type', 'ALL,UNREAD');
  window.fetch('/api/v1/conversations?pages[' + PAGE + ']=0&unread_first=true&mode=OR', { method: 'POST', body: fd });
  await sleep(300);
  const lastUrl = window.__listUrls[window.__listUrls.length - 1] || '';
  check(/^POST \/api\/v1\/conversations/.test(lastUrl), 'bắt được endpoint thật POST /api/v1/conversations (' + lastUrl.slice(0, 42) + '…)');
  const cap = window.__radar.poll();
  check(!!cap && cap.method === 'POST' && cap.hasBody === true, 'ghi nhớ request để tự gọi lại (POST + body)');
  await sleep(300);
  check(window.__radar.debug().diag.listReq >= 1, 'chẩn đoán đếm được request danh sách');

  // đổi nội dung -> tự gọi lại -> phải báo
  const beforePoll = items().length;
  window.__convs[0].snippet = 'Shop ơi còn màu đen không';
  window.__convs[0].updated_at = '2026-10-31T04:00:00Z';
  window.__convs[0].last_sent_by = { id: '100061610676863', name: 'Khách Khác' };
  window.__radar.poll();
  await sleep(400);
  check(items().length === beforePoll + 1, 'tự gọi lại danh sách và báo tin khách mới');

  // ---- 12. trang báo có tin chưa đọc -> gọi riêng trang đó (vì danh sách nhiều trang chỉ trả 1 phần)
  window.__pageCounts = {}; window.__pageCounts[PAGE] = 0;
  window.fetch('/api/v1/conversations?pages[' + PAGE + ']=0&unread_first=true&mode=OR', { method: 'POST' });
  await sleep(250);
  const base3 = items().length;
  window.__pageOverride = [{
    id: PAGE + '_999888777', page_id: PAGE, from_psid: '999888777', type: 'INBOX',
    customers: [{ id: 'u9', fb_id: '999888777', name: 'Khách Mới' }],
    snippet: 'Shop ơi còn hàng không', updated_at: new Date().toISOString(),
    last_sent_by: { id: '999888777', name: 'Khách Mới' }
  }];
  const counts = {}; counts[PAGE] = 1; window.__pageCounts = counts;
  window.fetch('/api/v1/conversations?pages[' + PAGE + ']=0&unread_first=true&mode=OR', { method: 'POST' });
  await sleep(700);
  check(items().length === base3 + 1, 'trang báo có tin chưa đọc -> báo được tin của hội thoại ngoài trang đầu');
  check(items()[0].name === 'Khách Mới', 'đúng khách của trang đó (' + items()[0].name + ')');
  check(window.__listUrls.some(u => u.indexOf('/api/v1/pages/' + PAGE + '/conversations') >= 0),
    'có gọi endpoint danh sách riêng của trang');
  check(window.__radar.debug().diag.pageTriggers >= 1, 'chẩn đoán đếm được lần trang có tin mới');

  // ---- 13. hai tin trùng nội dung nhưng khác mã tin -> phải báo cả hai
  const base4 = items().length;
  window.__ws.dispatch('message', window.__msgFrame(PSID, 'Shop ơi', true));
  await sleep(150);
  window.__ws.dispatch('message', window.__msgFrame(PSID, 'Shop ơi', true));
  await sleep(200);
  check(items().length === base4 + 2, 'hai tin trùng nội dung vẫn báo đủ 2 lần');
  const ids = new Set(items().slice(0, 2).map(i => i.msgId));
  check(ids.size === 2, 'phân biệt bằng mã tin (mid), không gộp nhầm');

  // ---- 10. tổng hợp
  check(diag().msgFrames >= 3, 'đếm được khung cấp tin nhắn (' + diag().msgFrames + ')');
  check(window.__pageMsg >= 6, 'listener của trang vẫn nhận đủ khung (' + window.__pageMsg + ')');
  check(errors.length === 0, 'không có lỗi JS' + (errors.length ? ': ' + errors[0] : ''));

  console.log(fail ? '\n❌ ' + fail + ' mục hỏng' : '\n✅ tất cả đạt');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();

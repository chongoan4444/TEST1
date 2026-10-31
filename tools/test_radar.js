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
window.__untagged = null;
window.__untaggedUrls = [];
window.__pageCounts = {};
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const path = url.split('?')[0];
  const isList = url.indexOf('/messages') < 0 && path.indexOf('/api/v1/') >= 0 && path.endsWith('/conversations');
  if (isList) {
    window.__listCalls++;
    window.__listUrls.push(((init && init.method) || 'GET') + ' ' + url);
    (window.__fetchLog = window.__fetchLog || []).push({
      m: ((init && init.method) || 'GET').toUpperCase(), u: url,
      hasBody: !!(init && init.body), body: (init && init.body) || null
    });
  }
  const isUntagged = url.indexOf('NO_TAG') >= 0;
  if (isUntagged && url.indexOf('/messages') < 0) window.__untaggedUrls.push(url);
  const isPageList = path.indexOf('/api/v1/pages/') >= 0;
  if (isUntagged && !isPageList) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      success: true, conversations: (window.__untagged || []), pages_with_current_count: {}
    }), clone() { return this; } });
  }
  const body = isPageList
    ? { success: true, conversations: (window.__pageOverride || window.__convs), pages_with_current_count: {} }
    : { success: true, conversations: window.__convs, pages_with_current_count: window.__pageCounts };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; } });
};
// ---- XMLHttpRequest giả: ứng dụng thật dùng axios (_resourceType "xhr" trong HAR) ----
window.__xhrs = [];
window.XMLHttpRequest = function () { this.__l = {}; this.readyState = 0; this.responseText = ''; };
window.XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; };
window.XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.__h = this.__h || {}; this.__h[k] = v; };
window.XMLHttpRequest.prototype.addEventListener = function (t, f) { this.__l[t] = f; };
window.XMLHttpRequest.prototype.send = function (b) { window.__xhrs.push({ m: this.__m, u: this.__u, body: b, h: this.__h, xhr: this }); };
window.__xhrReply = function (i, json) {
  const x = window.__xhrs[i].xhr;
  x.responseText = JSON.stringify(json); x.readyState = 4;
  if (x.__l.readystatechange) x.__l.readystatechange.call(x);
  if (x.__l.load) x.__l.load.call(x);
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
const st = () => window.__radar.state;
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

  // ---- 14. ứng dụng gửi request bằng XMLHttpRequest (axios) -> phải học đúng POST + body
  window.__radar.clear();
  const nx = window.__xhrs.length;
  const mx = new window.XMLHttpRequest();
  mx.open('POST', '/api/v1/conversations?pages[' + PAGE + ']=0&unread_first=true&mode=OR');
  mx.setRequestHeader('content-type', 'multipart/form-data; boundary=----WebKitFormBoundaryTEST');
  const fdx = new window.FormData(); fdx.append('type', 'ALL,UNREAD');
  mx.send(fdx);
  await sleep(120);
  check(window.__xhrs.length === nx + 1, 'XHR: thấy request danh sách của ứng dụng (axios)');
  check(st().listReq && st().listReq.method === 'POST', 'XHR: học được method POST (không rơi về GET)');
  check(st().listReq && st().listReq.body != null, 'XHR: học được body');

  window.__fetchLog = [];
  window.__radar.poll();
  await sleep(300);
  const replay = (window.__fetchLog || [])[0];
  check(!!replay && replay.m === 'POST', 'gọi lại danh sách bằng đúng method POST (' + (replay && replay.m) + ')');
  check(!!replay && replay.hasBody, 'gọi lại danh sách có body (không gửi rỗng)');

  // response của ứng dụng (đi qua XHR) cũng được đọc -> báo tin
  const baseX = items().length;
  const convX = {
    id: PAGE + '_777666555', page_id: PAGE, from_psid: '777666555',
    customers: [{ id: 'u9', fb_id: '777666555', name: 'Khách Qua XHR' }],
    snippet: 'Còn hàng không shop', updated_at: new Date().toISOString(),
    last_sent_by: { id: '777666555', name: 'Khách Qua XHR' }
  };
  window.__xhrReply(nx, { conversations: [convX], pages_with_current_count: {} });
  await sleep(300);
  check(items().length === baseX + 1, 'đọc được response của chính ứng dụng (XHR) -> báo tin khách');
  check(items().some(i => i.name === 'Khách Qua XHR'), 'đúng tên khách từ response XHR');
  check(st().diag.xhrHits >= 1, 'chẩn đoán đếm được request XHR');

  // ---- 15. chưa học được request nào -> tự dựng request danh sách (trang lấy từ DOM)
  const savedReq = st().listReq;
  st().listReq = null;
  window.__fetchLog = [];
  window.__radar.poll();
  await sleep(300);
  const own = (window.__fetchLog || [])[0];
  check(!!own && own.m === 'POST' && own.u.indexOf('/api/v1/conversations?pages[') === 0,
    'chưa có request mẫu -> tự dựng POST /api/v1/conversations?pages[…]');
  check(!!own && own.hasBody, 'request tự dựng có body type=ALL,UNREAD');
  st().listReq = savedReq;

  // ---- 16. socket RIÊNG của Pancake (Phoenix vsn=2.0.0) — 1.7.0 không nghe vì chỉ lọc facebook.com
  const ws2 = new window.WebSocket('wss://pancake.vn/socket/websocket?vsn=2.0.0');
  await sleep(120);
  const fBefore = diag().frames;
  const convPhx = {
    id: PAGE + '_555444333', page_id: PAGE, from_psid: '555444333',
    customers: [{ id: 'u5', fb_id: '555444333', name: 'Khách Phoenix' }],
    snippet: 'Chốt đơn nhé shop', updated_at: new Date().toISOString(),
    last_sent_by: { id: '555444333', name: 'Khách Phoenix' }
  };
  ws2.dispatch('message', JSON.stringify([null, '2', 'conversation:' + PAGE, 'conversation_updated', { conversation: convPhx }]));
  await sleep(200);
  check(diag().frames === fBefore + 1, 'nghe được socket riêng của Pancake (không phải facebook.com)');
  check(items().some(i => i.name === 'Khách Phoenix'), 'khung Phoenix có hội thoại -> báo đúng khách');
  check((diag().phxEvents.conversation_updated || 0) >= 1, 'chẩn đoán ghi lại tên event của socket Pancake');

  ws2.dispatch('message', JSON.stringify([null, '3', 'conversation:' + PAGE, 'new_message',
    { message: { id: 'm1', conversation_id: PAGE + '_555444333', sender_id: '555444333', content: 'Giao chiều nay giúp em' } }]));
  await sleep(200);
  check(items().some(i => i.snippet === 'Giao chiều nay giúp em'), 'khung tin nhắn trong socket Pancake -> báo tin khách');

  ws2.dispatch('message', JSON.stringify([null, '4', 'conversation:' + PAGE, 'new_message',
    { message: { id: 'm2', conversation_id: PAGE + '_555444333', sender_id: PAGE, content: 'Dạ shop gửi ngay' } }]));
  await sleep(200);
  check(!items().some(i => i.snippet === 'Dạ shop gửi ngay'), 'tin shop trong socket Pancake -> KHÔNG báo');

  // ---- 17. dạng tin nhắn THẬT của Pancake (from.id + original_message + inserted_at)
  ws2.dispatch('message', JSON.stringify([null, '5', 'conversation:' + PAGE, 'new_message', {
    message: {
      id: 'real1', message: '<div>Chị ơi hôm nay MIỄN SHIP</div>', original_message: 'Chị ơi hôm nay MIỄN SHIP',
      from: { id: '555444333', name: 'Khách Phoenix' }, inserted_at: new Date().toISOString(),
      page_id: PAGE, conversation_id: PAGE + '_555444333'
    }
  }]));
  await sleep(200);
  check(items().some(i => i.snippet === 'Chị ơi hôm nay MIỄN SHIP'), 'dạng tin nhắn thật (from.id + original_message) -> báo');

  ws2.dispatch('message', JSON.stringify([null, '6', 'conversation:' + PAGE, 'new_message', {
    message: {
      id: 'old1', original_message: 'Tin cũ từ hai giờ trước',
      from: { id: '555444333', name: 'Khách Phoenix' },
      inserted_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      page_id: PAGE, conversation_id: PAGE + '_555444333'
    }
  }]));
  await sleep(200);
  check(!items().some(i => i.snippet === 'Tin cũ từ hai giờ trước'), 'tin cũ đẩy lên khi mở hội thoại -> không báo');

  // ---- 18. khung pages:update_conversation (đường "báo trước" của socket Pancake)
  const base5 = items().length;
  const convPatch = {
    id: PAGE + '_888777666', page_id: PAGE,
    customers: [{ id: 'u8', fb_id: '888777666', name: 'Khách Socket' }],
    snippet: 'Em chốt đơn nha', updated_at: new Date().toISOString(),
    last_sent_by: { id: '888777666', name: 'Khách Socket' }
  };
  ws2.dispatch('message', JSON.stringify([null, '9', 'multiple_pages:u1', 'pages:update_conversation',
    { page_id: PAGE, conversation: convPatch }]));
  await sleep(250);
  check(items().length === base5 + 1, 'pages:update_conversation đủ dữ liệu -> báo NGAY (không chờ danh sách)');
  check(diag().convPatches >= 1 && diag().patchWithSender >= 1, 'chẩn đoán đếm được khung cập nhật hội thoại');

  // khung chỉ là bản vá (thiếu last_sent_by) -> không đoán, nhưng phải gọi riêng trang ngay
  await sleep(1700);                       // chờ hết chặn 1,5 giây/trang của lần gọi trước
  const pagePollsBefore = diag().pagePolls;
  window.__pageOverride = [{
    id: PAGE + '_777111222', page_id: PAGE, from_psid: '777111222',
    customers: [{ id: 'u7', fb_id: '777111222', name: 'Khách Vá' }],
    snippet: 'Còn hàng không shop', updated_at: new Date().toISOString(),
    last_sent_by: { id: '777111222', name: 'Khách Vá' }
  }];
  ws2.dispatch('message', JSON.stringify([null, '10', 'multiple_pages:u1', 'pages:update_conversation',
    { page_id: PAGE, conversation: { id: PAGE + '_777111222', type: 'INBOX', tags: [1], seen: false } }]));
  await sleep(700);
  check(String(diag().patchKeys).indexOf('id') === 0, 'ghi lại khoá của khung để chẩn đoán (' + diag().patchKeys + ')');
  check(diag().pagePolls === pagePollsBefore + 1, 'khung thiếu dữ liệu -> gọi riêng trang ngay');
  check(items().some(i => i.name === 'Khách Vá'), 'gọi riêng trang -> báo đúng khách');
  window.__pageOverride = null;

  // ---- 19. hội thoại CHƯA GẮN TAG (danh sách của app lọc theo tag nên không thấy)
  const base6 = items().length;
  window.__untagged = [{
    id: PAGE + '_444333222', page_id: PAGE, from_psid: '444333222',
    customers: [{ id: 'u4', fb_id: '444333222', name: 'Khách Chưa Tag' }],
    snippet: 'Tin chưa gắn tag', updated_at: new Date().toISOString(), tags: [],
    last_sent_by: { id: '444333222', name: 'Khách Chưa Tag' }
  }];
  await sleep(1800);
  check(window.__untaggedUrls.length > 0, 'có hỏi riêng nhóm chưa gắn tag (tags=["NO_TAG"])');
  check(window.__untaggedUrls.some(u => /tags=%5B%22NO_TAG%22%5D|tags=\[%22NO_TAG%22\]/.test(u)),
    'đúng tham số tags=["NO_TAG"] như trong HAR');
  check(window.__untaggedUrls.some(u => u.indexOf('POST ') === 0) === false, '(đánh dấu)');
  check(items().some(i => i.name === 'Khách Chưa Tag'), 'hội thoại chưa gắn tag -> báo được', items().length - base6);
  check(items().some(i => i.via === 'chưa gắn tag'), 'ghi đúng nguồn: chưa gắn tag', JSON.stringify(items().map(i => [i.name, i.via])));
  check((diag().untaggedPolls || 0) >= 1, 'chẩn đoán đếm được lần hỏi chưa gắn tag');
  window.__untagged = null;

  // ---- 10. tổng hợp
  check(diag().msgFrames >= 3, 'đếm được khung cấp tin nhắn (' + diag().msgFrames + ')');
  check(window.__pageMsg >= 6, 'listener của trang vẫn nhận đủ khung (' + window.__pageMsg + ')');
  check(errors.length === 0, 'không có lỗi JS' + (errors.length ? ': ' + errors[0] : ''));

  console.log(fail ? '\n❌ ' + fail + ' mục hỏng' : '\n✅ tất cả đạt');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * test_radar.js — kiểm tra script "Radar tin nhắn tới" (báo TRƯỚC khi dòng chat hiện ra).
 *
 * Dùng CHÍNH các khung websocket thật trong demo/ws_frames.json
 * (rút từ batmesss.har, wss://edge-chat.facebook.com/chat):
 *   - khung 33: psid 61594409994701 + "đắt cái áo mà 10 ngày chưa có" (tin của shop)
 *   - khung 71: không có ad_id, tin của shop
 *   - khung 88: gộp nhiều hội thoại -> phải bỏ
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
const fWithAd = FRAMES.find(f => f.co_ad_id > 0);
const fMulti = FRAMES.filter(f => f.psid.length > 2)[0];

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
  <div id="${OTHER}__0" class="conversation-list-item">Khách khác</div>
  <div id="${CONV}__0" class="conversation-list-item">Ngọc Ánh</div>
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
const convs = [
  { id: ${JSON.stringify(OTHER)}, page_id: ${JSON.stringify(PAGE)}, from_psid: '100061610676863',
    customers: [{ id: 'u1', fb_id: '100061610676863', name: 'Khách Khác' }],
    snippet: 'Ok shop', updated_at: '2026-10-31T02:00:00Z', last_sent_by: 'customer' },
  { id: ${JSON.stringify(CONV)}, page_id: ${JSON.stringify(PAGE)}, from_psid: ${JSON.stringify(PSID)},
    customers: [{ id: 'u2', fb_id: ${JSON.stringify(PSID)}, name: 'Ngọc Ánh' }],
    snippet: 'Ib mình mẫu này', updated_at: '2026-10-31T02:10:00Z', last_sent_by: 'customer' }
];
window.fetch = function (input) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (/\\/conversations(\\?|$)/.test(url) && !/\\/messages/.test(url)) window.__listCalls++;
  const body = { success: true, conversations: convs };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; } });
};
</script>
<script>
${SCRIPT}
</script>
<script>
window.__ws = new WebSocket('wss://edge-chat.facebook.com/chat?region=pnb');
window.__ws.addEventListener('message', function () { window.__pageMsg++; });
window.__b64 = ${JSON.stringify(fWithAd.b64)};
window.__b64multi = ${JSON.stringify(fMulti.b64)};
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

(async () => {
  let fail = 0;
  const check = (ok, msg) => { console.log((ok ? '✓ ' : '✗ ') + msg); if (!ok) fail++; };

  await sleep(300);
  check(!!window.__radar, 'script nạp được, có __radar');
  check(!!doc.querySelector('.__rd_panel'), 'có bảng radar');
  check(!!doc.querySelector('.__rd_fab'), 'có nút 📨');

  // 1. nạp danh sách để lấy TÊN
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  check(window.__listCalls === 1, 'đã đọc phản hồi danh sách');
  check(window.__radar.people.get(PSID) && window.__radar.people.get(PSID).name === 'Ngọc Ánh',
    'ghép được psid -> tên "Ngọc Ánh"');

  // 2. khung THẬT (tin của KHÁCH) -> báo ngay, đúng tên + nội dung + vị trí
  window.__ws.dispatch('message', toBuf(fWithAd.b64));
  await sleep(200);
  const it = items()[0];
  check(items().length === 1, 'báo được tin từ khung websocket thật');
  check(!!it && it.name === 'Ngọc Ánh', 'hiện đúng TÊN khách (' + (it && it.name) + ')');
  check(!!it && it.snippet === 'đắt cái áo mà 10 ngày chưa có', 'hiện đúng NỘI DUNG (' + (it && it.snippet) + ')');
  check(!!it && it.posNow === 2, 'biết VỊ TRÍ hiện tại của dòng (dòng 2)');
  check(!!it && it.via === 'websocket', 'ghi rõ nguồn "websocket (trước khi hiện)"');
  check(!!it && it.ads[0] === '120251435064020732', 'kèm ad_id của khung (' + (it && it.ads[0]) + ')');

  const panelTxt = doc.querySelector('.__rd_panel').textContent;
  check(/dòng 2/.test(panelTxt), 'bảng hiện chữ "dòng 2"');
  check(/đắt cái áo/.test(panelTxt), 'bảng hiện nội dung tin');
  check(/Ngọc Ánh/.test(panelTxt), 'bảng hiện tên khách');
  check(/websocket/.test(panelTxt), 'bảng ghi nguồn websocket');

  // 3. tin do SHOP gửi ("Bạn: …") -> mặc định không báo
  const outgoingFrame = 'deleteThenInsertThread",[19,"1"],[19,"-1"],"Bạn: Em chào chị ạ",[9],"entity_id=' + PSID + '&"';
  window.__ws.dispatch('message', outgoingFrame);
  await sleep(120);
  check(items().length === 1, 'tin của shop bị bỏ qua khi bật "chỉ tin tới"');
  window.__radar.set({ onlyIncoming: false });
  window.__ws.dispatch('message', outgoingFrame);
  await sleep(120);
  check(items().length === 2, 'tắt "chỉ tin tới" thì tin của shop cũng được báo');
  window.__radar.set({ onlyIncoming: true });
  check(items().length === 2, 'giữ nguyên danh sách sau khi đổi tuỳ chọn');

  // 4. cùng khung, bắn lại lần nữa -> không nhân đôi
  window.__ws.dispatch('message', toBuf(fWithAd.b64));
  await sleep(120);
  check(items().length === 2, 'không báo trùng cùng một tin');

  // 5. khung gộp nhiều hội thoại -> bỏ
  window.__ws.dispatch('message', toBuf(fMulti.b64));
  await sleep(120);
  check(items().length === 2, 'khung gộp nhiều hội thoại thì bỏ (không đoán)');

  // 6. tin KHÁCH gửi (khung tổng hợp, giữ psid thật) -> phải báo
  const txt = 'deleteThenInsertThread",[19,"2"],[19,"-1"],"Còn size M không shop",[9],"entity_id=' + PSID + '&"';
  window.__ws.dispatch('message', txt);
  await sleep(150);
  const inc = items()[0];
  check(items().length === 3, 'tin của KHÁCH thì được báo');
  check(!!inc && /size M/.test(inc.snippet), 'nội dung tin khách đọc được (' + (inc && inc.snippet.slice(0, 30)) + ')');

  // 7. tắt radar -> không nhận nữa
  window.__radar.set({ on: false });
  window.__ws.dispatch('message', txt.replace('Còn size M không shop', 'Tin thu 2 cua khach'));
  await sleep(120);
  check(items().length === 3, 'tắt radar thì không báo thêm');

  // 8. hook không phá trang
  check(window.__pageMsg >= 6, 'listener của trang vẫn nhận đủ khung (' + window.__pageMsg + ')');
  const rep = window.__radar.debug();
  check(rep.people === 2 && rep.rows === 2, 'debug đúng: ' + JSON.stringify({ people: rep.people, rows: rep.rows }));
  check(errors.length === 0, 'không có lỗi JS' + (errors.length ? ': ' + errors[0] : ''));

  console.log(fail ? '\n❌ ' + fail + ' mục hỏng' : '\n✅ tất cả đạt');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();

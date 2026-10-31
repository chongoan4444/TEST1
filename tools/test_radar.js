#!/usr/bin/env node
/**
 * test_radar.js — kiểm tra script "Radar tin nhắn tới" (báo tin kèm tên + nội dung + vị trí).
 *
 * Dùng khung websocket THẬT trong demo/ws_frames.json (rút từ batmesss.har).
 * Kiểm cả 3 đường bắt tin:
 *   1. websocket   (báo trước)
 *   2. API danh sách (dự phòng — so snippet/updated_at)
 *   3. giao diện   (MutationObserver — dòng vừa đổi)
 * và kiểm bảng chẩn đoán (nút 🔍 / __radar.debug()).
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
window.__convs = [
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
  const body = { success: true, conversations: window.__convs };
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
window.__frame = (psid, text) => 'deleteThenInsertThread",[19,"3"],[19,"-1"],"' + text + '",[9],"entity_id=' + psid + '&"';
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

  await sleep(400);
  check(!!window.__radar, 'script nạp được, có __radar');
  check(!!doc.querySelector('.__rd_panel'), 'có bảng radar');
  check(!!doc.querySelector('.__rd_fab'), 'có nút 📨');
  check(window.__radar.debug().diag.hook === true, 'hook WebSocket đã treo (chẩn đoán ghi nhận)');

  // ---- nạp danh sách để biết TÊN
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  check(window.__listCalls === 1, 'đã đọc phản hồi danh sách');
  check((window.__radar.people.get(PSID) || {}).name === 'Ngọc Ánh', 'ghép được psid -> tên "Ngọc Ánh"');
  check(window.__radar.debug().diag.sockets.some(u => /edge-chat\.facebook\.com/.test(u)), 'chẩn đoán có ghi URL socket');

  // ---- 1. websocket: khung THẬT (tin của khách)
  window.__ws.dispatch('message', toBuf(fWithAd.b64));
  await sleep(250);
  const it = items()[0];
  check(items().length === 1, 'báo tin từ khung websocket thật');
  check(!!it && it.name === 'Ngọc Ánh', 'đúng TÊN (' + (it && it.name) + ')');
  check(!!it && it.snippet === 'đắt cái áo mà 10 ngày chưa có', 'đúng NỘI DUNG (' + (it && it.snippet) + ')');
  check(!!it && it.posNow === 2, 'đúng VỊ TRÍ (dòng 2)');
  check(!!it && it.via === 'websocket', 'nguồn = websocket');
  check(!!it && it.ads[0] === '120251435064020732', 'kèm ad_id (' + (it && it.ads[0]) + ')');

  // ---- tin của shop: bỏ; tắt "chỉ tin tới" thì báo
  window.__ws.dispatch('message', window.__frame(PSID, 'Bạn: Em gửi bảng size ạ'));
  await sleep(150);
  check(items().length === 1, 'tin của shop bị bỏ khi bật "chỉ tin tới"');
  window.__radar.set({ onlyIncoming: false });
  window.__ws.dispatch('message', window.__frame(PSID, 'Bạn: Đây là tin shop thứ hai'));
  await sleep(150);
  check(items().length === 2, 'tắt "chỉ tin tới" thì báo cả tin shop');
  window.__radar.set({ onlyIncoming: true });

  // ---- khung gộp nhiều hội thoại: bỏ
  window.__ws.dispatch('message', toBuf(fMulti.b64));
  await sleep(150);
  check(items().length === 2, 'khung gộp nhiều hội thoại thì bỏ (không đoán)');

  // ---- 2. dự phòng: API danh sách đổi nội dung
  window.__convs[0].snippet = 'Shop ơi giao hôm nay không';
  window.__convs[0].updated_at = '2026-10-31T03:30:00Z';
  window.fetch('/api/v1/pages/' + PAGE + '/conversations?unread_first=true&mode=OR', { method: 'POST' });
  await sleep(300);
  const viaList = items().find(i => i.via === 'danh sách');
  check(!!viaList, 'dự phòng: báo tin khi API danh sách đổi (' + (viaList && viaList.snippet) + ')');
  check(!!viaList && viaList.name === 'Khách Khác', 'dự phòng: đúng tên (' + (viaList && viaList.name) + ')');

  // ---- 3. dự phòng: giao diện đổi (MutationObserver)
  const row = doc.getElementById(CONV + '__0');
  row.querySelector('.snippet-text').textContent = 'Còn size L không shop';
  await sleep(900);
  const viaDom = items().find(i => i.via === 'giao diện');
  check(!!viaDom, 'dự phòng: báo tin khi dòng trên giao diện đổi');
  check(!!viaDom && /size L/.test(viaDom.snippet), 'dự phòng: đúng nội dung dòng (' + (viaDom && viaDom.snippet) + ')');
  check(!!viaDom && viaDom.name === 'Ngọc Ánh', 'dự phòng: đúng tên từ giao diện (' + (viaDom && viaDom.name) + ')');

  // ---- nút 🧪 tin thử
  const testBtn = Array.from(doc.querySelectorAll('[data-a="test"]'))[0];
  testBtn.click();
  await sleep(150);
  check(items().some(i => i.via === 'thử'), 'nút 🧪 bắn được tin thử (kiểm tra giao diện)');

  // ---- nút 🔍 mở bảng chẩn đoán
  const diagBtn = Array.from(doc.querySelectorAll('[data-a="diag"]'))[0];
  diagBtn.click();
  await sleep(100);
  const diagBox = doc.querySelector('.__rd_diag');
  check(diagBox && diagBox.classList.contains('open'), 'nút 🔍 mở bảng chẩn đoán');
  check(diagBox && /hook websocket: đã treo/.test(diagBox.textContent), 'chẩn đoán ghi "hook websocket: đã treo"');
  check(diagBox && /edge-chat\.facebook\.com/.test(diagBox.textContent), 'chẩn đoán liệt kê URL socket');

  // ---- trạng thái tổng hợp
  const rep = window.__radar.debug();
  check(rep.diag.parsed >= 1, 'chẩn đoán đếm được khung đọc thành công (' + rep.diag.parsed + ')');
  check(rep.diag.frames >= 4, 'chẩn đoán đếm được số khung nhận (' + rep.diag.frames + ')');
  check(window.__pageMsg >= 4, 'listener của trang vẫn nhận đủ khung (' + window.__pageMsg + ')');
  check(errors.length === 0, 'không có lỗi JS' + (errors.length ? ': ' + errors[0] : ''));

  console.log(fail ? '\n❌ ' + fail + ' mục hỏng' : '\n✅ tất cả đạt');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();

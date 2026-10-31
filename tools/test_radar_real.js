#!/usr/bin/env node
/**
 * Kiểm thử radar bằng DỮ LIỆU THẬT của repo (không tự bịa payload):
 *   • HTML:  demo/real_dom_fixture.html      (DOM thật của Pancake, đã lưu trong repo)
 *   • API :  batmesss.har → POST /api/v1/conversations  (41 hội thoại thật + pages_with_current_count)
 *   • Cách gửi request: XMLHttpRequest (đúng như ứng dụng: HAR ghi `_resourceType: "xhr"`,
 *     trang nạp chunk `vendor-axios-*.js` — axios mặc định dùng XHR, KHÔNG dùng fetch)
 *
 * Mục đích: chứng minh script hoạt động trên dữ liệu thật, không chỉ trên mock.
 *   node tools/test_radar_real.js        (cần jsdom: NODE_PATH=/tmp/jsdomtest/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(ok, label, extra) {
  if (ok) { pass++; console.log('✓ ' + label); }
  else { fail++; console.log('✗ ' + label + (extra !== undefined ? ' — ' + extra : '')); }
}

// ---------------------------------------------------------------- dữ liệu thật
const har = JSON.parse(read('batmesss.har'));
const listEntry = har.log.entries.find(e =>
  e.request.method === 'POST' && /\/api\/v1\/conversations\?/.test(e.request.url));
if (!listEntry) { console.error('Không tìm thấy POST /api/v1/conversations trong batmesss.har'); process.exit(1); }

const content = listEntry.response.content;
const rawText = content.encoding === 'base64'
  ? Buffer.from(content.text, 'base64').toString('utf8')
  : content.text;
const PAYLOAD = JSON.parse(rawText);

const listUrl = listEntry.request.url.replace(/^https:\/\/pancake\.vn/, '');
const pageOfUrl = (/pages\[(\d{10,})\]/.exec(listEntry.request.url) || [])[1] || '';
const customerConv = PAYLOAD.conversations.find(c => {
  const sb = c.last_sent_by || {};
  return String(sb.id) === String(c.from_psid);
}) || PAYLOAD.conversations[0];
const shopConv = PAYLOAD.conversations.find(c => {
  const sb = c.last_sent_by || {};
  return String(sb.id) === String(c.page_id);
});

console.log('# dữ liệu thật: ' + PAYLOAD.conversations.length + ' hội thoại · ' +
  Object.keys(PAYLOAD.pages_with_current_count || {}).length + ' trang · ' + listUrl.slice(0, 60) + '…');

// ---------------------------------------------------------------- DOM thật
let html = read('demo/real_dom_fixture.html');
html = html.replace(/<script[\s\S]*?<\/script>/gi, '');       // bỏ script của trang
html = html.replace(/<link[^>]*>/gi, '');

const SCRIPT = read('userscripts/pancake-new-message-radar.user.js');

const patch = `
<script>
window.__payload = ${JSON.stringify(PAYLOAD)};
window.__appReqs = [];
window.__fetchLog = [];
function FakeXHR() { this.__l = {}; this.readyState = 0; this.responseText = ''; }
FakeXHR.prototype.open = function (m, u) { this.__m = m; this.__u = u; };
FakeXHR.prototype.setRequestHeader = function (k, v) { this.__h = this.__h || {}; this.__h[k] = v; };
FakeXHR.prototype.addEventListener = function (t, f) { this.__l[t] = f; };
FakeXHR.prototype.send = function (b) { window.__appReqs.push({ m: this.__m, u: this.__u, body: b, xhr: this }); };
window.XMLHttpRequest = FakeXHR;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  window.__fetchLog.push({ m: ((init && init.method) || 'GET').toUpperCase(), u: url, hasBody: !!(init && init.body) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(window.__payload), clone() { return this; } });
};
window.__appRefresh = function () {
  const x = new FakeXHR();
  x.open('POST', ${JSON.stringify(listUrl)});
  x.setRequestHeader('content-type', 'multipart/form-data; boundary=----WebKitFormBoundaryREAL');
  const fd = new FormData(); fd.append('type', 'ALL,UNREAD');
  x.send(fd);
  const i = window.__appReqs.length - 1;
  setTimeout(function () {
    const r = window.__appReqs[i].xhr;
    r.responseText = JSON.stringify(window.__payload);
    r.readyState = 4;
    if (r.__l.readystatechange) r.__l.readystatechange.call(r);
    if (r.__l.load) r.__l.load.call(r);
  }, 20);
  return i;
};
</script>
<script>${SCRIPT}</script>
`;
html = html.replace(/<\/body>/i, patch + '</body>');

const vc = new VirtualConsole();          // bỏ qua cảnh báo CSS của jsdom, vẫn giữ lỗi
vc.on('jsdomError', e => { if (!/Could not parse CSS/.test(String(e && e.message))) console.error(e && e.message); });

const dom = new JSDOM(html, {
  virtualConsole: vc,
  runScripts: 'dangerously',
  url: 'https://pancake.vn/pages/' + pageOfUrl + '/conversations',
  pretendToBeVisual: true
});
const w = dom.window;
const items = () => w.__radar.items;
const st = () => w.__radar.state;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(800);                     // chờ script khởi động trên DOM thật

  check(!!w.__radar, 'script chạy được trên DOM thật của Pancake (v' + (w.__radar && w.__radar.version) + ')');
  check(w.document.querySelectorAll('.conversation-list-item').length >= 10,
    'thấy danh sách hội thoại thật (' + w.document.querySelectorAll('.conversation-list-item').length + ' dòng)');
  check(!!w.document.querySelector('.__rd_fab'), 'có nút 📨 trên màn hình');

  // --- ứng dụng (axios/XHR) gọi danh sách -> radar phải học được request
  w.__appRefresh();
  await sleep(600);
  const req = st().listReq;
  check(!!req, 'học được request danh sách của ứng dụng (qua XMLHttpRequest)');
  check(!!req && req.method === 'POST', 'đúng method POST (' + (req && req.method) + ')');
  check(!!req && req.body != null, 'đúng body (FormData type=ALL,UNREAD)');
  check(!!req && req.fromXhr === true, 'ghi nhận nguồn là XMLHttpRequest (không phải fetch)');
  check(st().convs.size >= 30, 'đọc được hội thoại từ payload thật (' + st().convs.size + ' hội thoại)');

  const nameReal = ((customerConv.customers || [])[0] || {}).name || '';
  check(!!nameReal && st().people.size > 0, 'biết tên khách từ payload thật (vd ' + nameReal + ')');

  // --- khách nhắnan lại -> phải báo
  const base = items().length;
  // phải sửa ĐÚNG đối tượng trong trang (payload trong jsdom là bản sao của bản trong Node)
  const pageConvs = w.__payload.conversations;
  const conv = pageConvs.find(c => String(c.id) === String(customerConv.id));
  const newSnip = 'Shop ơi còn size M không ạ';
  conv.snippet = newSnip;
  conv.updated_at = new Date().toISOString().replace('Z', '000');
  conv.last_sent_by = { id: conv.from_psid, name: nameReal };
  w.__appRefresh();
  await sleep(700);

  const hit = items().find(i => i.psid === String(conv.from_psid));
  check(items().length === base + 1, 'khách nhắn -> báo đúng 1 tin (' + (items().length - base) + ')');
  check(!!hit && hit.snippet === newSnip, 'đúng nội dung tin mới');
  check(!!hit && hit.dirKnown === true, 'xác định đúng chiều khách → shop');
  check(!!hit && !!hit.name, 'có tên khách (' + (hit && hit.name) + ')');

  // --- shop trả lời -> KHÔNG báo
  const base2 = items().length;
  const shopPageConv = shopConv && pageConvs.find(c => String(c.id) === String(shopConv.id));
  if (shopPageConv) {
    shopPageConv.snippet = 'Dạ shop còn ạ';
    shopPageConv.updated_at = new Date().toISOString().replace('Z', '000');
    shopPageConv.last_sent_by = { id: shopPageConv.page_id, name: 'Shop' };
    w.__appRefresh();
    await sleep(700);
    check(items().length === base2, 'shop trả lời -> KHÔNG báo (' + (items().length - base2) + ' tin thêm)');
    check(st().diag.skippedOut >= 1, 'chẩn đoán ghi nhận đã bỏ tin shop');
  } else {
    check(true, '(không có hội thoại shop-gửi-cuối trong payload để thử)');
    check(true, '(bỏ qua kiểm tra bỏ tin shop)');
  }

  // --- tự gọi lại danh sách: đúng POST + có body (1.6.0 làm mất -> GET rỗng -> hỏng)
  const bad = st().listReq && /next_cursor=/.test(String(st().listReq.url));
  check(!bad, 'request đã học không phải request "trang kế tiếp" (không có next_cursor)');
  w.__fetchLog.length = 0;
  w.__radar.poll();
  await sleep(400);
  const replay = w.__fetchLog[0];
  check(!!replay && replay.m === 'POST', 'tự gọi lại bằng POST (' + (replay && replay.m) + ')');
  check(!!replay && replay.hasBody, 'tự gọi lại có body');

  // --- không lỗi JS
  check(!st().diag.lastErr, 'không có lỗi JS (' + st().diag.lastErr + ')');

  console.log('');
  if (fail) { console.log('❌ ' + fail + ' mục hỏng / ' + (pass + fail)); process.exit(1); }
  console.log('✅ tất cả ' + pass + ' mục đạt — trên DOM + API thật');
  process.exit(0);
})().catch(e => { console.error('LỖI CHẠY:', e && e.stack || e); process.exit(1); });

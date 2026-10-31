// ==UserScript==
// @name         Pancake - Radar tin nhắn TỚI (chỉ tin khách gửi đến)
// @namespace    https://github.com/chongoan4444/TEST1
// @version      2.0.0
// @description  Báo tin KHÁCH GỬI TỚI (không báo tin shop gửi đi): tên khách + nội dung + vị trí dòng. Chiều tin lấy từ sender id trong khung websocket và last_sent_by trong API danh sách — dữ liệu thật, không đoán theo chữ "Bạn:".
// @author       Arena Agent
// @match        https://pancake.vn/*
// @match        https://*.pancake.vn/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/**
 * RADAR TIN NHẮN TỚI — chỉ báo tin KHÁCH gửi đến.
 *
 * CĂN CỨ (kiểm trực tiếp trên batmesss.har, không suy diễn):
 *   A. Khung websocket có lệnh insertMessage — mỗi khung 1 tin:
 *        [5,"insertMessage","<nội dung>",[9],[19,"80"],[19,"<psid khách>"], …, "<mid.…>","<numeric id>",[19,"<SENDER ID>"]
 *      → SENDER ID = psid khách  ⇒ tin TỚI
 *      → SENDER ID = page id     ⇒ tin SHOP gửi đi
 *      (đo trên 8 khung: 1 tin tới của khách, 7 tin shop gửi — khớp đúng)
 *   B. API danh sách có last_sent_by là OBJECT:
 *        last_sent_by = {id: "834072796450267", name: "Huyền Nguyễn Shop"}   → shop
 *        last_sent_by = {id: "<psid>", name: "Nguyễn Thịnh"}                 → khách
 *      → so last_sent_by.id với from_psid / page_id là biết chiều.
 *   C. KHÔNG dùng chữ "Bạn:" làm căn cứ chính: giao diện đổi ngôn ngữ là sai ngay
 *      (đây chính là lỗi bắt nhầm tin gửi đi ở bản 1.1.0). Chỉ dùng khi bắt buộc,
 *      và mặc định KHÔNG báo những tin không xác định được chiều.
 */
(function () {
  'use strict';

  const VERSION = '2.0.0';

  const DEFAULTS = {
    on: true,
    panel: true,
    onlyIncoming: true,      // chỉ báo tin khách gửi tới
    allowUnknown: false,     // false = không báo tin không xác định được chiều
    max: 8,
    notify: false,
    pollMs: 2000,            // tự gọi lại danh sách (chỉ khi tab đang xem)
    pollMinGap: 1200,        // không gọi lại dày hơn mức này
    domTrigger: true,        // dòng trên màn hình vừa đổi -> gọi lại danh sách NGAY (lấy chiều tin)
    watchList: true,         // dự phòng bằng API danh sách (chiều chính xác)
    watchDom: false,         // theo dõi giao diện: KHÔNG biết chiều -> mặc định tắt
    defaultPoll: true,       // nếu chưa học được request danh sách nào thì tự dựng request (đúng dạng trong HAR)
    untaggedPoll: true,      // hỏi riêng nhóm CHƯA GẮN TAG (tags=["NO_TAG"] — đúng dạng trong tinnhanmoi.har)
    untaggedMs: 1200         // nhịp hỏi nhóm chưa gắn tag
  };

  const CFG = (function () {
    const out = Object.assign({}, DEFAULTS);
    try {
      const raw = localStorage.getItem('radar.cfg');
      if (raw) Object.assign(out, JSON.parse(raw) || {});
    } catch (e) { /* ignore */ }
    return out;
  })();

  const state = {
    people: new Map(),   // psid  -> { name, convId, avatar }
    convs: new Map(),    // convId -> { psid, name, snippet, updated_at, lastSentById }
    domSnap: new Map(),
    items: [],
    seeded: false,
    domReady: false,
    wsHits: 0,
    listHits: 0,
    domHits: 0,
    listReq: null,
    pageCounts: null,      // pages_with_current_count lần trước
    pagePollAt: {},
    pagePollFail: 0,
    internal: false,      // đang tự gọi (không ghi đè request danh sách)
    untaggedReq: null,    // request riêng cho nhóm CHƯA GẮN TAG
    panel: null,
    fab: null,
    diagOpen: false,
    log: [],
    diag: {
      hook: false, hookErr: '', sockets: [], frames: 0, listReq: 0, polls: 0, lastPollAt: 0, bodyReady: false,
      pageTriggers: 0, pagePolls: 0, pageFail: 0, xhrHits: 0, defaultPolls: 0,
      pollOk: 0, pollBad: 0, pollJsonErr: 0, hiddenSkips: 0,
      phxTopics: {}, phxEvents: {}, rawFrames: [], jsonFrames: 0,
      convPatches: 0, patchWithSender: 0, patchWithSnippet: 0, patchKeys: '', ticks: 0,
      untaggedPolls: 0, untaggedErr: 0, untaggedConvs: 0,
      msgFrames: 0, threadFrames: 0, parsed: 0,
      skippedOut: 0, skippedUnknown: 0, lastFrameAt: 0, lastErr: '', lastSender: ''
    }
  };

  /** nhật ký ngắn để nhìn thấy script đang làm gì (hiện trong bảng 🔍) */
  function logEvent(tag, text) {
    state.log.unshift({ t: Date.now(), tag: tag, text: String(text == null ? '' : text).slice(0, 160) });
    if (state.log.length > 40) state.log.length = 40;
    if (state.diagOpen) render();
  }

  const LOG = (...a) => { try { console.log('%c[radar]', 'color:#0ea5e9;font-weight:600', ...a); } catch (e) { /* ignore */ } };

  // ======================================================================
  // 1. GIẢI MÃ KHUNG WEBSOCKET
  // ======================================================================
  function unesc(s) {
    return String(s == null ? '' : s)
      .replace(/\\+u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\+\//g, '/')
      .replace(/\\+"/g, '"')
      .replace(/\\{2,}/g, '\\');
  }

  function pageIdNow() {
    const m = /\/pages\/(\d{5,})/.exec(String(location.pathname || '') + ' ' + String(location.href || ''));
    if (m) return m[1];
    const keys = Array.from(state.convs.keys());
    for (let i = 0; i < keys.length; i++) {
      const p = String(keys[i]).split('_')[0];
      if (/^\d{5,}$/.test(p)) return p;
    }
    const rs = rows();
    for (let i = 0; i < rs.length; i++) {
      const p = String(convIdOfRow(rs[i])).split('_')[0];
      if (/^\d{5,}$/.test(p)) return p;
    }
    return '';
  }

  /**
   * Khung CẤP TIN NHẮN (insertMessage): biết chính xác ai gửi.
   * Chỉ nhận khi khung có đúng 1 tin — nhiều tin trong 1 khung thì bỏ (không đoán).
   */
  function parseMessageFrame(text, pageId) {
    if (text.indexOf('insertMessage') < 0) return null;
    const re = /\[5,\\"insertMessage\\",/g;
    const at = [];
    let m;
    while ((m = re.exec(text))) { at.push(m.index); if (at.length > 1) return null; }
    if (!at.length) return null;

    const seg = text.slice(at[0], at[0] + 1600);
    const mt = /\[5,\\"insertMessage\\",\\"((?:[^"\\]|\\.)*?)\\"/.exec(seg);
    if (!mt) return null;
    const mp = /\[9\],\[19,\\"80\\"\],\[19,\\"(\d+)\\"\]/.exec(seg);       // psid của hội thoại
    if (!mp) return null;
    const ms = /\\"mid\.[^"\\]*\\",\\"\d+\\",\[19,\\"(\d+)\\"\]/.exec(seg);  // SENDER ID
    const mi = /\\"mid\.([^"\\]*)\\"/.exec(seg);                            // mã tin (mid.$…)
    const sender = ms ? ms[1] : '';
    const msgId = mi ? mi[1] : '';
    const snippet = unesc(mt[1]).replace(/\s+/g, ' ').trim();
    if (!snippet) return null;

    let outgoing = null;
    if (sender) outgoing = pageId ? (sender === pageId) : (sender !== mp[1] ? null : false);
    return {
      psid: mp[1], snippet, avatar: '', ads: [], at: Date.now(),
      sender, msgId, outgoing: outgoing === true, dirKnown: outgoing !== null, kind: 'message'
    };
  }

  /**
   * Khung CẤP HỘI THOẠI (deleteThenInsertThread): có psid + đoạn tin cuối, KHÔNG có sender.
   * Dùng khi không bắt được khung cấp tin nhắn; chiều chỉ suy ra từ tiền tố "Bạn:" nên yếu.
   */
  function parseThreadFrame(text, pageId) {
    if (text.indexOf('deleteThenInsertThread') < 0) return null;
    const psids = [];
    let m;
    const reE = /entity_id=(\d{5,})/g;
    while ((m = reE.exec(text))) {
      if (pageId && m[1] === pageId) continue;
      if (psids.indexOf(m[1]) < 0) {
        psids.push(m[1]);
        if (psids.length > 1) return null;   // khung gộp nhiều hội thoại -> bỏ
      }
    }
    if (psids.length !== 1) return null;

    const clean = unesc(text);
    const ms = /deleteThenInsertThread[^[]*\[19,"\d+"\],\[19,"-?\d+"\],"([^"]{0,400})"/.exec(clean);
    if (!ms) return null;
    const snippet = String(ms[1]).replace(/\s+/g, ' ').trim();
    if (!snippet) return null;

    let avatar = '';
    const ma = /(https:\/\/scontent[^"'\s]+)/.exec(clean);
    if (ma) avatar = ma[1];

    const ads = [];
    const reA = /ad_id\.(\d{5,})/g;
    while ((m = reA.exec(text))) if (ads.indexOf(m[1]) < 0) ads.push(m[1]);

    // chỉ là suy đoán -> dirKnown = false, trừ khi có tiền tố rõ ràng của shop
    const outPrefix = /^Bạn\s*:|^Bạn\s+đã\s+(gửi|trả lời|phản hồi)|^You\s*:|^You\s+sent/i.test(snippet);
    return {
      psid: psids[0], snippet, avatar, ads, at: Date.now(),
      sender: '', outgoing: outPrefix, dirKnown: outPrefix, kind: 'thread'
    };
  }

  // ======================================================================
  // 2. BẮT WEBSOCKET
  // ======================================================================
  function readWsData(data) {
    try {
      state.diag.frames++;
      if (typeof data === 'string') return onFrameText(data);
      if (!data) return;
      if (typeof data.byteLength === 'number') {
        let text = '';
        try { text = new TextDecoder('utf-8', { fatal: false }).decode(data); }
        catch (e) {
          const arr = (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) ? data : new Uint8Array(data.buffer || data);
          for (let i = 0; i < arr.length; i++) text += String.fromCharCode(arr[i]);
        }
        return onFrameText(text);
      }
      if (typeof data.text === 'function') {
        data.text().then(t => { try { onFrameText(t); } catch (e) {} }).catch(() => {});
      }
    } catch (e) { state.diag.lastErr = 'ws: ' + e.message; }
  }

  function onFrameText(text) {
    if (!CFG.on) return;
    const raw = String(text == null ? '' : text);
    try {
      const rf = state.diag.rawFrames;
      rf.unshift(raw.slice(0, 1500));
      if (rf.length > 3) rf.length = 3;
    } catch (e) { /* ignore */ }

    const pageId = pageIdNow();
    let hit = parseMessageFrame(raw, pageId);
    if (hit) state.diag.msgFrames++;
    else { hit = parseThreadFrame(raw, pageId); if (hit) state.diag.threadFrames++; }

    if (hit) {
      state.diag.parsed++;
      state.diag.lastFrameAt = Date.now();
      state.diag.lastSender = hit.sender || (hit.dirKnown ? 'tiền tố' : '?');
      route(hit, 'websocket');
      return;
    }
    // Không phải khung Facebook cổ điển -> thử đọc JSON (socket Phoenix của Pancake)
    parseJsonFrame(raw, pageId);
  }

  /**
   * Socket của Pancake là Phoenix: wss://pancake.vn/socket/websocket?vsn=2.0.0
   * Khung Phoenix v2: [join_ref, ref, topic, event, payload] (mảng JSON 5 phần tử).
   * Không đoán tên event — đọc mọi payload rồi tự tìm đối tượng giống hội thoại / tin nhắn.
   */
  function parseJsonFrame(text, pageId) {
    const t = String(text || '').trim();
    if (!t || (t.charAt(0) !== '[' && t.charAt(0) !== '{')) return;
    let j;
    try { j = JSON.parse(t); } catch (e) { return; }
    state.diag.jsonFrames++;
    if (Array.isArray(j) && j.length >= 5 && typeof j[2] === 'string' && typeof j[3] === 'string') {
      const topic = j[2], event = j[3], payload = j[4];
      if (/^phoenix/i.test(topic)) return;                       // heartbeat
      const d = state.diag;
      d.phxTopics[topic] = (d.phxTopics[topic] || 0) + 1;
      d.phxEvents[event] = (d.phxEvents[event] || 0) + 1;
      if (/^(phx_reply|phx_error|phx_close|presence_diff|presence_state)$/i.test(event)) return;
      if (event === 'pages:update_conversation') { onConversationPatch(payload, pageId); return; }
      deepScan(payload, 0, pageId);
      try { render(); } catch (e) { /* ignore */ }
      return;
    }
    deepScan(j, 0, pageId);
    try { render(); } catch (e) { /* ignore */ }
  }

  /** đọc mốc thời gian kiểu Pancake: 2026-10-19T10:08:45.000000 (không có múi giờ) */
  function parseTs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : 0);
    const str = String(v);
    const t = Date.parse(str);
    if (!isNaN(t)) return t;
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(str);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
  }

  /**
   * Khung `pages:update_conversation` của socket Pancake (đọc từ bảng chẩn đoán thật):
   *   ["7",null,"multiple_pages:<uid>","pages:update_conversation",
   *    {"page_id":"769625892902516","conversation":{"id":"769625892902516_2890…","type":"INBOX","tags":[…],"seen":true,…}}]
   * Khung này tới TRƯỚC khi React vẽ lại dòng, nên đây là đường "báo trước".
   *  • nếu khung có đủ snippet + last_sent_by  -> báo ngay (biết chắc chiều tin)
   *  • nếu khung chỉ là bản vá thiếu dữ liệu  -> gọi riêng trang đó ngay (150 ms) để lấy bản chuẩn
   */
  function onConversationPatch(payload, pageId) {
    const d = state.diag;
    if (!payload || typeof payload !== 'object') return;
    const cv = payload.conversation || payload.conv || payload.thread || null;
    if (!cv || typeof cv !== 'object') { deepScan(payload, 0, pageId); return; }

    d.convPatches = (d.convPatches || 0) + 1;
    const keys = Object.keys(cv);
    if (keys.length) d.patchKeys = keys.join(',').slice(0, 400);
    const id = String(cv.id || '');
    const pid = String(payload.page_id || cv.page_id || (id.indexOf('_') > 0 ? id.split('_')[0] : pageId || ''));
    const hasSender = !!(cv.last_sent_by && (cv.last_sent_by.id != null || cv.last_sent_by.name));
    const hasSnippet = cv.snippet != null || cv.last_message != null;
    if (hasSender) d.patchWithSender = (d.patchWithSender || 0) + 1;
    if (hasSnippet) d.patchWithSnippet = (d.patchWithSnippet || 0) + 1;

    if (id && hasSnippet) {
      const known = state.convs.get(id) || {};
      const patch = {
        id: id,
        page_id: pid,
        from_psid: cv.from_psid || known.psid || (id.indexOf('_') > 0 ? id.split('_')[1] : ''),
        snippet: cv.snippet != null ? cv.snippet : cv.last_message,
        updated_at: cv.updated_at || cv.updatedAt || '',
        last_sent_by: cv.last_sent_by || null,
        customers: cv.customers || null
      };
      if (hasSender) ingestList({ conversations: [patch] }, true, true, 'websocket');
      else if (patch.last_sent_by) ingestList({ conversations: [patch] }, true, true, 'websocket');
    }
    // dù khung đủ hay thiếu: đẩy nhanh dữ liệu chuẩn của trang (last_sent_by chính xác)
    if (pid && /^\d{5,}$/.test(pid)) {
      if (state.__patchTimer) clearTimeout(state.__patchTimer);
      state.__patchTimer = setTimeout(() => { state.__patchTimer = 0; try { targetPagePoll(pid, true); } catch (e) { /* ignore */ } }, 80);
    }
  }

  /** dò trong payload: đối tượng nào giống hội thoại thì đưa vào ingestList, giống tin nhắn thì báo */
  function deepScan(node, depth, pageId) {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) deepScan(node[i], depth + 1, pageId); return; }
    if (typeof node !== 'object') return;

    const id = node.id != null ? String(node.id) : '';
    const kind = String(node.type || node.kind || '');
    const looksConv = (node.from_psid || /^\d{5,}_\d{5,}$/.test(id)) &&
      (node.snippet != null || node.updated_at != null || node.updatedAt != null) &&
      /conversation|thread|inbox|^$/i.test(kind);

    if (looksConv) {
      try { ingestList({ conversations: [node] }, true, true); } catch (e) { /* ignore */ }
    } else {
      // Dạng tin nhắn THẬT của Pancake (đọc trong loaddanhsach.har, GET …/messages):
      //   { id, message: "<div>…</div>", original_message: "…", type,
      //     from: { id, name }, inserted_at, page_id, conversation_id }
      const fromObj = (node.from && typeof node.from === 'object') ? node.from : null;
      const sender = fromObj ? fromObj.id : (node.sender_id || node.senderId || node.from_id || node.from_psid);
      let body = node.original_message;
      if (body == null) body = node.message;
      if (body == null) body = node.content || node.text;
      if (typeof body !== 'string') body = '';
      body = body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const convId = String(node.conversation_id || node.conversationId || node.thread_id || '');
      if (sender && body && convId) {
        // bỏ qua tin cũ (khi mở hội thoại, server đẩy cả lịch sử) — chỉ nhận tin trong 5 phút
        const ts = parseTs(node.inserted_at || node.created_at || node.sent_at);
        if (ts && Date.now() - ts > 5 * 60 * 1000) return;
        const psid = convId.indexOf('_') > 0 ? convId.split('_')[1] : String(node.from_psid || '');
        if (psid) {
          const pid = pageId || String(node.page_id || convId.split('_')[0]);
          const out = (String(sender) === pid) ? true : (String(sender) === psid ? false : null);
          route({
            psid: psid, snippet: body.slice(0, 200), avatar: '', ads: [], at: Date.now(),
            sender: String(sender), msgId: String(node.mid || node.id || node.message_id || ''),
            outgoing: out === true, dirKnown: out !== null, kind: 'message'
          }, 'websocket');
        }
      }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length && i < 40; i++) {
      const v = node[keys[i]];
      if (v && typeof v === 'object') deepScan(v, depth + 1, pageId);
    }
  }

  /** quyết định có báo hay không, dựa đúng vào chiều tin */
  function route(hit, via) {
    if (CFG.onlyIncoming) {
      if (hit.dirKnown && hit.outgoing) {
        state.diag.skippedOut++;
        logEvent('⏭', 'bỏ tin shop · ' + String(hit.snippet || '').slice(0, 70));
        return;
      }
      if (!hit.dirKnown && !CFG.allowUnknown) {
        state.diag.skippedUnknown++;
        logEvent('❔', 'bỏ vì chưa rõ chiều · ' + String(hit.snippet || '').slice(0, 70));
        return;
      }
    }
    if (via === 'websocket') state.wsHits++;
    if (via === 'giao diện') state.domHits++;
    publish(hit, via);
  }

  (function hookWebSocket() {
    try {
      const Orig = window.WebSocket;
      if (typeof Orig !== 'function') { state.diag.hookErr = 'không có WebSocket'; return; }
      if (Orig.__radarHook) { state.diag.hook = true; return; }
      const onMsg = ev => { if (ev && ev.data) readWsData(ev.data); };
      const Wrapped = new Proxy(Orig, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
          try {
            const url = String(args && args[0] || '');
            if (state.diag.sockets.length < 10) state.diag.sockets.push(url.slice(0, 90));
            // Nghe MỌI socket: Pancake dùng socket riêng wss://pancake.vn/socket/websocket?vsn=2.0.0
            // (Phoenix). Bản 1.7.0 chỉ nghe socket facebook.com nên "khung nhận: 0" dù đã thấy socket.
            if (!/google-analytics|googletagmanager|hotjar|sentry|doubleclick/i.test(url)) {
              try { ws.addEventListener('message', onMsg); } catch (e) { /* ignore */ }
              try { const old = ws.onmessage; ws.onmessage = function (ev) { try { onMsg(ev); } catch (e) {} if (typeof old === 'function') return old.apply(this, arguments); }; } catch (e) { /* ignore */ }
            }
          } catch (e) { state.diag.lastErr = 'attach: ' + e.message; }
          return ws;
        }
      });
      try { Wrapped.__radarHook = true; } catch (e) { /* ignore */ }
      Object.defineProperty(window, 'WebSocket', { value: Wrapped, configurable: true, writable: true });
      state.diag.hook = true;
    } catch (e) {
      state.diag.hookErr = String(e && e.message || e);
      LOG('không treo được hook websocket:', e);
    }
  })();

  // ======================================================================
  // 3. API DANH SÁCH — chiều tin lấy từ last_sent_by
  // ======================================================================
  /**
   * Hai kiểu endpoint danh sách có thật trong dữ liệu:
   *   POST /api/v1/conversations?pages[..]=0&…&unread_first=true&mode=OR&tags=[…]   (tinnhanmoi.har)
   *   GET  /api/v1/pages/<page_id>/conversations?current_count=40&next_cursor=…      (loaddanhsach.har)
   */
  function isListUrl(url) {
    const u = String(url || '').split('#')[0].split('?')[0];
    if (/\/messages/.test(u)) return false;
    if (/\/api\/v1\/conversations\/?$/.test(u)) return true;
    if (/\/api\/v1\/pages\/[^/]+\/conversations\/?$/.test(u)) return true;
    return false;
  }

  function ingestList(json, fromPage, quiet, viaName) {
    if (!json || typeof json !== 'object') return;
    const arr = json.conversations || json.data || [];
    if (!Array.isArray(arr) || !arr.length) return;
    state.listHits++;
    if (viaName === 'chưa gắn tag') state.diag.untaggedConvs = arr.length;
    if (!quiet || arr.length > 1) logEvent('🔄', (viaName === 'chưa gắn tag' ? 'chưa gắn tag: ' : 'danh sách: ') + arr.length + ' hội thoại');
    const fresh = [];
    arr.forEach(cv => {
      if (!cv || typeof cv !== 'object') return;
      const id = String(cv.id || cv.conversation_id || '');
      if (!id) return;
      const pageId = String(cv.page_id || id.split('_')[0] || '');
      const psid = String(cv.from_psid || (id.indexOf('_') > 0 ? id.split('_')[1] : ''));
      let name = '';
      const cs = cv.customers;
      if (Array.isArray(cs) && cs.length && cs[0] && cs[0].name) name = String(cs[0].name);
      else if (cv.from && cv.from.name) name = String(cv.from.name);
      const avatar = (Array.isArray(cs) && cs[0] && (cs[0].avatar || cs[0].picture)) || cv.from_avatar || '';
      const snippet = String(cv.snippet || '');
      const updated = String(cv.updated_at || '');
      // last_sent_by là OBJECT: {id, name, …} -> id chính là psid khách hoặc id trang
      const sb = cv.last_sent_by;
      const sbId = (sb && typeof sb === 'object') ? String(sb.id || sb.admin_id || '') : '';
      const prev = state.convs.get(id);
      state.convs.set(id, { psid, name, snippet, updated_at: updated, lastSentById: sbId });
      if (psid && name) state.people.set(psid, { name, convId: id, avatar: avatar || (state.people.get(psid) || {}).avatar || '' });

      // hội thoại MỚI (chưa từng thấy) cũng là tin mới — nhưng chỉ báo khi cập nhật gần đây,
      // tránh báo cả loạt hội thoại cũ khi lần đầu gọi riêng một trang
      const ts = updated ? (Date.parse(updated) || 0) : 0;
      const recent = !updated || (ts && Date.now() - ts < 15 * 60 * 1000);
      const isNewConv = !prev && !!snippet && recent;
      if (state.seeded && snippet && ((prev && (prev.updated_at !== updated || prev.snippet !== snippet)) || isNewConv)) {
        let outgoing = null;
        if (sbId && psid) outgoing = (sbId === psid) ? false : (pageId && sbId === pageId ? true : null);
        const lag = state.lastChangeAt && (Date.now() - state.lastChangeAt < 15000) ? (Date.now() - state.lastChangeAt) : 0;
        fresh.push({ psid, snippet, outgoing: outgoing === true, dirKnown: outgoing !== null, ads: [], avatar: '', at: Date.now(), sender: sbId, kind: 'list', lag, updatedAt: updated });
      }
    });

    if (!state.seeded) { state.seeded = true; watchPageCounts(json); if (!quiet) render(); return; }
    if (CFG.watchList) fresh.forEach(f => route(f, viaName || 'danh sách'));
    if (!fromPage && !quiet) watchPageCounts(json);
    if (!quiet) render();
  }

  /**
   * Danh sách nhiều trang chỉ trả về MỘT phần hội thoại (đo trong tinnhanmoi.har: 1 hội thoại),
   * nên tin của hội thoại nằm ngoài phần đó sẽ không thấy.
   * Bù lại: response có pages_with_current_count — số chưa đọc của TỪNG trang.
   * Trang nào tăng số chưa đọc -> gọi riêng danh sách trang đó (1 request) để lấy đúng hội thoại.
   */
  function watchPageCounts(json) {
    const pc = json && json.pages_with_current_count;
    if (!pc || typeof pc !== 'object') return;
    const prev = state.pageCounts;
    state.pageCounts = Object.assign({}, pc);
    if (!prev) return;
    Object.keys(pc).forEach(pageId => {
      const now = Number(pc[pageId]) || 0;
      const was = Number(prev[pageId]) || 0;
      if (now > was) {
        state.diag.pageTriggers++;
        logEvent('🔔', 'trang ' + pageId + ' có ' + now + ' tin chưa đọc (trước ' + was + ')');
        targetPagePoll(pageId);
      }
    });
  }

  /** gọi danh sách riêng của một trang (endpoint GET có thật trong loaddanhsach.har) */
  function targetPagePoll(pageId, urgent) {
    if (state.pagePollFail >= 2) return;
    const now = Date.now();
    const gapPage = urgent ? 1500 : 3000;
    if (now - (state.pagePollAt[pageId] || 0) < gapPage) return;
    state.pagePollAt[pageId] = now;
    const url = '/api/v1/pages/' + encodeURIComponent(pageId) + '/conversations?current_count=40&unread_first=true&mode=OR&except_tags=[]&from_platform=web';
    state.diag.pagePolls++;
    state.internal = true;
    let pr;
    // dùng fetch GỐC (không qua hook của chính mình) để response không bị xử lý hai lần
    const f = (typeof _fetch === 'function') ? _fetch : fetch;
    try {
      pr = f(url, { method: 'GET', credentials: 'include' });
    } catch (e) {
      state.internal = false;
      state.pagePollFail++; state.diag.pageFail++;
      logEvent('⚠️', 'gọi trang ' + pageId + ' lỗi: ' + e.message);
      return;
    }
    state.internal = false;
    Promise.resolve(pr).then(r => {
      if (!r || !r.ok) {
        state.pagePollFail++; state.diag.pageFail++;
        logEvent('⚠️', 'gọi trang ' + pageId + ' HTTP ' + (r && r.status));
        return null;
      }
      return r.json();
    }).then(j => { if (j) ingestList(j, true); })
      .catch(err => { state.pagePollFail++; state.diag.pageFail++; logEvent('⚠️', 'gọi trang lỗi: ' + err.message); });
  }

  /** lưu request danh sách học được (từ fetch HOẶC từ XMLHttpRequest của ứng dụng) */
  function saveListReq(rec) {
    if (!rec || !rec.url) return;
    if (/\/messages/.test(String(rec.url))) return;
    if (!rec.method) rec.method = 'POST';
    rec.at = Date.now();
    rec.lastPoll = 0;
    state.listReq = rec;
    state.diag.listReq = (state.diag.listReq || 0) + 1;
    try { render(); } catch (e) { /* ignore */ }
  }

  function captureListReq(url, method, init, input) {
    const rec = {
      url: String(url || ''),
      method: String(method || 'GET').toUpperCase(),
      headers: (init && init.headers) || null,
      body: null,
      at: Date.now()
    };
    try {
      if (init && init.body != null) {
        const b = init.body;
        const ok = typeof b === 'string' ||
          (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) ||
          (typeof FormData !== 'undefined' && b instanceof FormData) ||
          (typeof Blob !== 'undefined' && b instanceof Blob);
        if (ok) rec.body = b;              // FormData / chuỗi dùng lại nhiều lần được
      } else if (input && typeof input === 'object' && typeof input.clone === 'function' && rec.method !== 'GET' && rec.method !== 'HEAD') {
        const c = input.clone();
        let ct = '';
        try { ct = String((input.headers && input.headers.get && input.headers.get('content-type')) || ''); } catch (e) { /* ignore */ }
        if (/multipart\/form-data/.test(ct)) c.formData().then(fd => { rec.body = fd; state.diag.bodyReady = true; }).catch(() => {});
        else c.text().then(t => { rec.body = t; state.diag.bodyReady = true; }).catch(() => {});
      }
    } catch (e) { state.diag.lastErr = 'capture: ' + e.message; }
    saveListReq(rec);
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      let method = (init && init.method) || (input && input.method) || 'GET';
      let mine = false;
      try { mine = state.internal; } catch (e) { /* ignore */ }
      try { if (!mine && isListUrl(url)) captureListReq(url, method, init, input); } catch (e) { /* ignore */ }
      const p = _fetch.apply(this, arguments);
      try {
        if (isListUrl(url)) {
          p.then(r => { let c; try { c = r.clone(); } catch (e) { return; } c.json().then(j => ingestList(j, false, false, /NO_TAG/i.test(url) ? 'chưa gắn tag' : undefined)).catch(err => { state.diag.pollJsonErr = (state.diag.pollJsonErr || 0) + 1; logEvent('⚠️', 'đọc JSON danh sách lỗi: ' + ((err && err.message) || err)); }); }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  /**
   * ỨNG DỤNG DÙNG XMLHttpRequest, KHÔNG PHẢI fetch.
   * Bằng chứng: tinnhanmoi.har ghi `_resourceType: "xhr"` cho POST /api/v1/conversations,
   * trang nạp chunk `vendor-axios-*.js` (axios mặc định dùng XHR).
   * Bản 1.6.0 chỉ bắt được XMLHttpRequest ở mức "biết url" nên khi gọi lại đã mất method + body
   * (POST thành GET, không có body) -> request hỏng, không có tin nào được báo.
   */
  if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
    const _xopen = XMLHttpRequest.prototype.open;
    const _xsend = XMLHttpRequest.prototype.send;
    const _xset = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, url) {
      try { this.__rdUrl = url; this.__rdMethod = m; this.__rdHeaders = {}; this.__rdDone = false; } catch (e) { /* ignore */ }
      return _xopen.apply(this, arguments);
    };
    if (typeof _xset === 'function') {
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try { if (this.__rdHeaders) this.__rdHeaders[String(k)] = String(v); } catch (e) { /* ignore */ }
        return _xset.apply(this, arguments);
      };
    }
    XMLHttpRequest.prototype.send = function (body) {
      const xhr = this;
      try {
        if (isListUrl(xhr.__rdUrl)) {
          state.diag.xhrHits = (state.diag.xhrHits || 0) + 1;
          if (!state.internal) {
            saveListReq({
              url: String(xhr.__rdUrl),
              method: String(xhr.__rdMethod || 'GET').toUpperCase(),
              headers: xhr.__rdHeaders || null,
              body: (body != null ? body : null),
              fromXhr: true
            });
          }
          const read = () => {
            if (xhr.__rdDone) return;
            xhr.__rdDone = true;
            try { if (xhr.responseText) ingestList(JSON.parse(xhr.responseText)); } catch (e) { /* ignore */ }
          };
          try { xhr.addEventListener('load', read); } catch (e) { /* ignore */ }
          try { xhr.addEventListener('readystatechange', function () { if (this.readyState === 4) read(); }); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return _xsend.apply(this, arguments);
    };
  }

  /** body chuẩn của request danh sách (đúng như postData trong tinnhanmoi.har: type=ALL,UNREAD) */
  function unreadBody() {
    try {
      const fd = new FormData();
      fd.append('type', 'ALL,UNREAD');
      return fd;
    } catch (e) { return 'type=ALL%2CUNREAD'; }
  }

  /** tự dựng request danh sách khi CHƯA học được request nào của ứng dụng */
  function buildDefaultReq() {
    const pages = [];
    const add = id => { const x = String(id || ''); if (/^\d{5,}$/.test(x) && pages.indexOf(x) < 0) pages.push(x); };
    add(pageIdNow());
    Array.from(state.convs.keys()).forEach(k => add(String(k).split('_')[0]));
    rows().forEach(el => add(String(convIdOfRow(el)).split('_')[0]));
    if (!pages.length) return null;
    const key = pages.join(',');
    if (state.defaultReq && state.defaultReq.key === key) return state.defaultReq;
    const q = pages.map(id => 'pages[' + id + ']=0').join('&');
    state.defaultReq = {
      key: key,
      url: '/api/v1/conversations?' + q + '&unread_first=true&mode=OR',
      method: 'POST',
      headers: null,
      body: unreadBody(),
      lastPoll: 0,
      own: true
    };
    return state.defaultReq;
  }

  /** bỏ content-type khi gửi lại FormData (boundary do trình duyệt tự sinh) */
  function safeHeaders(h, body) {
    if (!h) return null;
    try {
      const isFD = typeof FormData !== 'undefined' && body instanceof FormData;
      const drop = k => isFD && String(k).toLowerCase() === 'content-type';
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const out = new Headers();
        h.forEach((v, k) => { if (!drop(k)) out.set(k, v); });
        return out;
      }
      if (Array.isArray(h)) return h.filter(pair => !drop(pair[0]));
      if (typeof h === 'object') {
        const out = {};
        Object.keys(h).forEach(k => { if (!drop(k)) out[k] = h[k]; });
        return out;
      }
    } catch (e) { /* ignore */ }
    return h;
  }

  /**
   * Chọn request để gọi lại:
   *  • request của ứng dụng (ưu tiên — chắc chắn hợp lệ với phiên đăng nhập), trừ khi nó là
   *    request "trang kế tiếp" (có next_cursor) vì gọi lại chỉ nhận đúng trang đó;
   *  • nếu đã 2 lần lỗi HTTP thì chuyển sang request tự dựng;
   *  • nếu chưa học được gì và biết page id từ URL/DOM thì tự dựng.
   */
  function pickReq() {
    if (!CFG.defaultPoll) return state.listReq || null;
    const usable = x => x && !/next_cursor=/.test(String(x.url));
    if (state.preferDefault) {
      const d0 = buildDefaultReq();
      if (d0) return d0;
    }
    if (usable(state.listReq)) return state.listReq;
    const d = buildDefaultReq();
    return d || state.listReq || null;
  }

  /** danh sách page id đang theo dõi (lấy từ request đã học, từ URL, từ hội thoại, từ DOM) */
  function pageIds() {
    const out = [];
    const add = id => { const x = String(id || ''); if (/^\d{5,}$/.test(x) && out.indexOf(x) < 0) out.push(x); };
    const lr = state.listReq && String(state.listReq.url || '');
    if (lr) { const re = /pages\[(\d+)\]/g; let m; while ((m = re.exec(lr))) add(m[1]); }
    add(pageIdNow());
    Array.from(state.convs.keys()).forEach(k => add(String(k).split('_')[0]));
    rows().forEach(el => add(String(convIdOfRow(el)).split('_')[0]));
    return out;
  }

  /**
   * Request CHƯA GẮN TAG — chép đúng từ tinnhanmoi.har (entry #5):
   *   POST /api/v1/conversations?pages[..]=0&unread_first=true&mode=OR
   *        &tags=["NO_TAG"]&except_tags=[]&cursor_mode=true&from_platform=web
   *   body: multipart  type=ALL,UNREAD
   * Danh sách mặc định của ứng dụng bị lọc theo tag nên hội thoại CHƯA gắn tag không bao giờ xuất hiện;
   * phải hỏi riêng bằng bộ lọc NO_TAG.
   */
  function buildUntaggedReq() {
    const ids = pageIds();
    if (!ids.length) return null;
    const key = ids.join(',');
    if (state.untaggedReq && state.untaggedReq.key === key) return state.untaggedReq;
    const q = ids.map(id => 'pages[' + id + ']=0').join('&');
    state.untaggedReq = {
      key: key, own: true, untagged: true, lastPoll: 0,
      url: '/api/v1/conversations?' + q + '&unread_first=true&mode=OR' +
        '&tags=%5B%22NO_TAG%22%5D&except_tags=[]&cursor_mode=true&from_platform=web',
      method: 'POST',
      headers: null,
      body: unreadBody()
    };
    return state.untaggedReq;
  }

  function pollUntagged(force) {
    if (!CFG.on || !CFG.watchList || !CFG.untaggedPoll) return;
    if (state.diag.untaggedErr >= 3) return;                       // hỏng 3 lần thì thôi, không phá Pancake
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const r = buildUntaggedReq();
    if (!r) return;
    const gap = force ? 700 : Math.max(700, (Number(CFG.untaggedMs) || 1200) - 200);
    if (Date.now() - (r.lastPoll || 0) < gap) return;
    r.lastPoll = Date.now();
    state.diag.untaggedPolls = (state.diag.untaggedPolls || 0) + 1;
    const prevInternal = state.internal;
    state.internal = true;
    try {
      const pr = fetch(r.url, { method: 'POST', credentials: 'include', cache: 'no-store', body: r.body });
      Promise.resolve(pr).then(res => {
        if (res && res.ok === false) {
          state.diag.untaggedErr = (state.diag.untaggedErr || 0) + 1;
          logEvent('⚠️', 'danh sách chưa gắn tag HTTP ' + res.status);
        }
      }).catch(err => logEvent('⚠️', 'gọi chưa gắn tag lỗi: ' + err.message));
    } catch (e) {
      state.diag.untaggedErr = (state.diag.untaggedErr || 0) + 1;
      logEvent('⚠️', 'gọi chưa gắn tag lỗi: ' + e.message);
    } finally {
      state.internal = prevInternal;
    }
  }

  function pollList(force, urgent) {
    if (!CFG.on || !CFG.watchList) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { state.diag.hiddenSkips = (state.diag.hiddenSkips || 0) + 1; return; }
    const r = pickReq();
    if (!r) return;
    if (r.own) {
      state.diag.defaultPolls = (state.diag.defaultPolls || 0) + 1;
      if (state.diag.defaultPolls === 1) logEvent('🛠', 'dùng request tự dựng cho trang hiện tại');
    }
    // urgent = dòng vừa đổi trên màn hình: gần như gọi ngay, không để bị chặn bởi nhịp quét
    const pollMs = Math.max(1000, Number(CFG.pollMs) || 2000);
    const gap = urgent ? 150
      : (force ? Math.max(600, Number(CFG.pollMinGap) || 1200) : Math.max(300, pollMs - 200));
    if (Date.now() - (r.lastPoll || 0) < gap) { state.diag.pollSkips = (state.diag.pollSkips || 0) + 1; return; }
    r.lastPoll = Date.now();
    const method = String(r.method || 'POST').toUpperCase();
    const opt = { method: method, credentials: 'include', cache: 'no-store' };   // không dùng bản cache của trình duyệt
    const h = safeHeaders(r.headers, r.body);
    if (h) opt.headers = h;
    let body = r.body;
    if (method !== 'GET' && method !== 'HEAD' && (body == null || body === '')) body = unreadBody();
    if (body != null && method !== 'GET' && method !== 'HEAD') opt.body = body;
    const prevInternal = state.internal;
    state.internal = true;                 // request của chính mình: không ghi đè request đã học
    try {
      const pr = fetch(r.url, opt);
      state.diag.lastPollAt = Date.now();
      state.diag.polls = (state.diag.polls || 0) + 1;
      state.diag.pollOk = (state.diag.pollOk || 0) + 1;
      Promise.resolve(pr).then(res => {
        if (res && res.ok === false) {
          state.diag.pollBad = (state.diag.pollBad || 0) + 1;
          state.reqFail = (state.reqFail || 0) + 1;
          logEvent('⚠️', 'danh sách HTTP ' + res.status + ' (' + method + ')');
          if (state.reqFail >= 2 && !state.preferDefault) {
            state.preferDefault = true;
            state.reqFail = 0;
            logEvent('🛠', 'request của ứng dụng trả lỗi -> chuyển sang request tự dựng');
          }
        }
      }).catch(err => logEvent('⚠️', 'gọi danh sách lỗi: ' + err.message));
    } catch (e) {
      logEvent('⚠️', 'gọi danh sách lỗi: ' + e.message);
    } finally {
      state.internal = prevInternal;
    }
  }

  // ======================================================================
  // 4. GIAO DIỆN (mặc định TẮT: giao diện không cho biết chiều tin)
  // ======================================================================
  function rows() {
    return Array.from(document.querySelectorAll('.conversation-list-item'));
  }

  function convIdOfRow(el) {
    if (!el) return '';
    const m = /^(\d{5,}_\d{5,})__/.exec(el.id || '');
    if (m) return m[1];
    const inner = el.querySelector('[id]');
    if (inner) {
      const m2 = /^(\d{5,}_\d{5,})__/.exec(inner.id || '');
      if (m2) return m2[1];
    }
    return '';
  }

  function textOf(el, sels) {
    for (let i = 0; i < sels.length; i++) {
      const n = el.querySelector(sels[i]);
      if (n && n.textContent && n.textContent.trim()) return n.textContent.trim().replace(/\s+/g, ' ');
    }
    return '';
  }

  function scanDom() {
    if (!CFG.on || !(CFG.watchDom || CFG.domTrigger) || !document.body) return;
    const list = rows();
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const id = convIdOfRow(el);
      if (!id) continue;
      const psid = id.indexOf('_') > 0 ? id.split('_')[1] : '';
      if (!psid) continue;
      const name = textOf(el, ['.name-text', '.name-module-text', '.name-module', '[class*="name"]']);
      const snip = textOf(el, ['.snippet-text', '.snippet-line', '.snippet-wrap', '[class*="snippet"]']);
      if (name && !(state.people.get(psid) || {}).name) {
        state.people.set(psid, { name, convId: id, avatar: (state.people.get(psid) || {}).avatar || '' });
      }
      const prev = state.domSnap.get(id);
      if (prev === undefined) { state.domSnap.set(id, snip); continue; }
      if (snip && snip !== prev) {
        state.domSnap.set(id, snip);
        if (!state.domReady) continue;
        // dòng vừa đổi: gọi lại danh sách NGAY để biết chiều tin (last_sent_by) — nhanh hơn chờ 2 giây
        if (CFG.domTrigger) {
          state.lastChangeAt = Date.now();
          if (state.__pollTimer) clearTimeout(state.__pollTimer);
          state.__pollTimer = setTimeout(() => { state.__pollTimer = 0; pollList(true, true); }, 60);
        }
        if (!CFG.watchDom) continue;   // không tự báo vì giao diện không cho biết chiều
        const outPrefix = /^Bạn\s*:|^Bạn\s+đã\s+|^You\s*:/i.test(snip);
        route({ psid, snippet: snip, avatar: '', ads: [], at: Date.now(), sender: '', outgoing: outPrefix, dirKnown: outPrefix, kind: 'dom' }, 'giao diện');
      }
    }
    state.domReady = true;
    render();
  }

  function watchDom() {
    if (!(CFG.watchDom || CFG.domTrigger) || typeof MutationObserver === 'undefined') return;
    const tryAttach = () => {
      const list = document.querySelector('.conversation-list');
      if (!list) return false;
      if (list.__rdObserved) return true;
      list.__rdObserved = true;
      const mo = new MutationObserver(() => {
        if (state.__scanTimer) return;
        state.__scanTimer = setTimeout(() => { state.__scanTimer = 0; try { scanDom(); } catch (e) { state.diag.lastErr = 'dom: ' + e.message; } }, 300);
      });
      mo.observe(list, { childList: true, subtree: true, characterData: true });
      return true;
    };
    if (!tryAttach()) { const t = setInterval(() => { if (tryAttach()) clearInterval(t); }, 1500); }
    scanDom();
  }

  // ======================================================================
  // 5. VỊ TRÍ + PHÁT SỰ KIỆN
  // ======================================================================
  function positionOf(psid, convId) {
    const list = rows();
    for (let i = 0; i < list.length; i++) {
      const id = convIdOfRow(list[i]);
      if (id && (id === convId || (psid && id.endsWith('_' + psid)))) return { pos: i + 1, total: list.length, el: list[i] };
    }
    return { pos: 0, total: list.length, el: null };
  }

  const normText = s => String(s || '').replace(/^(Bạn|You)\s*(:|đã|sent)\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

  function publish(hit, via) {
    if (!hit || !hit.psid) return;
    const key = normText(hit.snippet);
    // Gộp trùng theo đúng bản chất từng nguồn:
    //  • cả hai đến từ websocket  -> so mã tin (mid): khách nhắn lại đúng câu cũ vẫn là tin mới
    //  • cả hai đến từ danh sách  -> so updated_at: cùng mốc thời gian mới là cùng một tin
    //  • khác nguồn (ws + danh sách của cùng một tin) -> gộp theo nội dung trong 8 giây
    const dup = state.items.some(it => {
      if (it.psid !== hit.psid) return false;
      if (hit.msgId && it.msgId) return hit.msgId === it.msgId;
      if (hit.updatedAt && it.updatedAt) return hit.updatedAt === it.updatedAt;
      return normText(it.snippet) === key && Date.now() - it.at < 8000;
    });
    if (dup) return;
    const convId = (pageIdNow() ? pageIdNow() + '_' : '') + hit.psid;
    const know = state.people.get(hit.psid) || {};
    const pos = positionOf(hit.psid, convId);
    const item = {
      psid: hit.psid, convId,
      name: know.name || (state.convs.get(convId) || {}).name || '',
      snippet: hit.snippet,
      avatar: hit.avatar || know.avatar || '',
      ads: hit.ads || [],
      via: via,
      at: hit.at || Date.now(),
      posNow: pos.pos,
      dirKnown: !!hit.dirKnown,
      sender: hit.sender || '',
      lag: hit.lag || 0,
      updatedAt: hit.updatedAt || '',
      msgId: hit.msgId || ''
    };
    state.items.unshift(item);
    if (state.items.length > 40) state.items.length = 40;
    render();
    logEvent('📥', (item.name || hit.psid) + ' · ' + item.snippet.slice(0, 70));
    notify(item);
    LOG('tin tới:', item.name || hit.psid, '·', item.snippet.slice(0, 50), '·', via, '· vị trí', pos.pos || 'mới');
  }

  function notify(item) {
    if (!CFG.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification((item.name || 'Khách') + ' vừa nhắn', { body: item.snippet, tag: 'radar-' + item.psid }); }
    catch (e) { /* ignore */ }
  }

  // ======================================================================
  // 6. BẢNG
  // ======================================================================
  const CSS = `
  .__rd_fab{position:fixed;right:16px;bottom:96px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
    background:#0ea5e9;color:#fff;border:0;cursor:pointer;box-shadow:0 4px 14px rgba(14,165,233,.45);font-size:20px}
  .__rd_fab .n{position:absolute;top:-4px;right:-4px;background:#e11d48;color:#fff;border-radius:10px;font-size:11px;
    padding:1px 5px;font-family:system-ui,sans-serif}
  .__rd_panel{position:fixed;right:16px;bottom:150px;z-index:2147483000;width:350px;max-height:64vh;overflow:auto;
    background:#0f172a;color:#e2e8f0;border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.45);
    font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .__rd_panel.off{display:none}
  .__rd_head{padding:10px 12px 8px;background:#0b1220;border-radius:14px 14px 0 0}
  .__rd_hrow{display:flex;align-items:center;gap:6px}
  .__rd_ver{font-size:10px;color:#8a94a6;border:1px solid #d7dce5;border-radius:6px;padding:0 4px}
  .__rd_head b{font-size:13px}
  .__rd_head .sp{flex:1}
  .__rd_head button{background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:8px;cursor:pointer;
    font-size:11px;padding:3px 7px}
  .__rd_head button.on{background:#0ea5e9;color:#fff;border-color:#0ea5e9}
  .__rd_stat{margin-top:6px;font-size:10.5px;color:#7dd3fc;font-family:ui-monospace,Menlo,monospace}
  .__rd_stat .bad{color:#fca5a5}
  .__rd_diag{display:none;margin-top:6px;font-size:10.5px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
  .__rd_diag.open{display:block}
  .__rd_empty{padding:14px 12px;color:#94a3b8;font-size:12px}
  .__rd_item{display:flex;gap:9px;padding:9px 12px;border-top:1px solid #1e293b;cursor:pointer}
  .__rd_item:hover{background:#152238}
  .__rd_item.new{background:#12283a;animation:__rd_flash 1.6s ease}
  @keyframes __rd_flash{from{background:#0ea5e933}to{background:#12283a}}
  .__rd_ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#334155;flex:0 0 34px}
  .__rd_ava.ph{display:flex;align-items:center;justify-content:center;font-weight:600;color:#cbd5e1}
  .__rd_body{flex:1;min-width:0}
  .__rd_top{display:flex;align-items:baseline;gap:6px}
  .__rd_name{font-weight:600;color:#f8fafc;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .__rd_pos{font-size:10px;padding:1px 6px;border-radius:999px;background:#1e293b;color:#7dd3fc;white-space:nowrap}
  .__rd_pos.top{background:#0ea5e9;color:#fff}
  .__rd_time{margin-left:auto;font-size:10px;color:#64748b;white-space:nowrap}
  .__rd_snip{color:#cbd5e1;font-size:12px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .__rd_ad{color:#c4b5fd;font-size:10px}
  .__rd_via{color:#475569;font-size:10px}
  `;

  function style() {
    if (document.getElementById('__rd_style')) return;
    const st = document.createElement('style');
    st.id = '__rd_style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeStr = ts => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  const VIA_TEXT = { websocket: 'websocket', 'danh sách': 'API danh sách', 'chưa gắn tag': 'chưa gắn tag', 'giao diện': 'giao diện', 'thử': 'tin thử' };

  function render() {
    if (!document.body) return;
    style();

    // Giao diện có thể bị dựng lại (SPA điều hướng): nếu nút/bảng cũ đã bị gỡ khỏi DOM thì tạo lại,
    // tránh trường hợp "script chạy mà không thấy gì trên màn hình".
    if (state.fab && !document.body.contains(state.fab)) { state.fab = null; }
    if (state.panel && !document.body.contains(state.panel)) { state.panel = null; }

    if (!state.fab) {
      const b = document.createElement('button');
      b.className = '__rd_fab';
      b.title = 'Radar tin nhắn TỚI';
      b.textContent = '📨';
      b.appendChild(Object.assign(document.createElement('span'), { className: 'n' }));
      b.addEventListener('click', () => { CFG.panel = !CFG.panel; save(); render(); });
      document.body.appendChild(b);
      state.fab = b;
    }
    const badge = state.fab.querySelector('.n');
    if (badge) {
      const n = state.items.filter(i => Date.now() - i.at < 120000).length;
      badge.textContent = n ? String(n) : '';
      badge.style.display = n ? 'block' : 'none';
    }

    if (!state.panel) {
      const p = document.createElement('div');
      p.className = '__rd_panel';
      document.body.appendChild(p);
      state.panel = p;
    }
    const p = state.panel;
    p.classList.toggle('off', !CFG.panel);

    const d = state.diag;
    const srcName = state.listReq
      ? ((state.listReq.fromXhr ? 'XHR' : 'fetch') + ' ' + (state.listReq.method || '?'))
      : (d.defaultPolls ? 'tự dựng POST' : 'chưa có');
    const lastAt = d.lastPollAt || (state.listReq && state.listReq.at) || 0;
    const stat = (d.hook ? 'WS ' + d.sockets.length + ' socket · ' + d.msgFrames + ' tin' : 'WS chưa treo được hook') +
      ' · DS ' + state.listHits + ' lần' + (lastAt ? ' (' + timeStr(lastAt) + ')' : '') +
      ' · bỏ ' + d.skippedOut + ' tin shop' + (d.skippedUnknown ? ' · ' + d.skippedUnknown + ' chưa rõ chiều' : '') +
      ' · Tên ' + state.people.size + ' · nguồn ' + srcName;

    const head = '<div class="__rd_head">' +
      '<div class="__rd_hrow"><b>📨 Tin khách gửi tới</b><span class="__rd_ver">v' + VERSION + '</span><span class="sp"></span>' +
      '<button data-a="in" class="' + (CFG.onlyIncoming ? 'on' : '') + '" title="Chỉ báo tin của khách">chỉ tin tới</button>' +
      '<button data-a="notify" class="' + (CFG.notify ? 'on' : '') + '" title="Thông báo hệ thống">🔔</button>' +
      '<button data-a="test" title="Bắn một tin thử">🧪</button>' +
      '<button data-a="diag" title="Chẩn đoán">🔍</button>' +
      '<button data-a="clear" title="Xoá danh sách">🧹</button></div>' +
      '<div class="__rd_stat' + (d.hook ? '' : ' bad') + '">' + esc(stat) + '</div>' +
      '<div class="__rd_diag' + (state.diagOpen ? ' open' : '') + '">' + esc(diagText()) + '</div>' +
      '</div>';

    const list = CFG.on ? state.items.slice(0, CFG.max) : [];
    let body = '';
    if (!CFG.on) body = '<div class="__rd_empty">Radar đang TẮT.</div>';
    else if (!list.length) body = '<div class="__rd_empty">Chưa có tin khách gửi tới. Tin của shop sẽ không hiện ở đây.</div>';
    else {
      body = list.map(it => {
        const pos = positionOf(it.psid, it.convId);
        const label = pos.pos ? ('dòng ' + pos.pos + (pos.pos > 1 ? ' → #1' : '')) : 'dòng mới #1';
        const top = !pos.pos || pos.pos === 1;
        const initial = (it.name || '?').trim().charAt(0).toUpperCase() || '?';
        const ava = it.avatar
          ? '<img class="__rd_ava" src="' + esc(it.avatar) + '" onerror="this.style.display=\'none\'">'
          : '<div class="__rd_ava ph">' + esc(initial) + '</div>';
        return '<div class="__rd_item' + (Date.now() - it.at < 4000 ? ' new' : '') + '" data-psid="' + esc(it.psid) + '">' + ava +
          '<div class="__rd_body"><div class="__rd_top">' +
          '<span class="__rd_name">' + esc(it.name || ('Khách ' + it.psid.slice(-6))) + '</span>' +
          '<span class="__rd_pos' + (top ? ' top' : '') + '">' + esc(label) + '</span>' +
          '<span class="__rd_time">' + timeStr(it.at) + '</span></div>' +
          '<div class="__rd_snip">' + esc(it.snippet) + '</div>' +
          (it.via === 'chưa gắn tag' ? '<div class="__rd_ad">🏷️ chưa gắn tag</div>' : '') +
          (it.ads && it.ads.length ? '<div class="__rd_ad">🔥 quảng cáo · ad_id ' + esc(it.ads[0]) + '</div>' : '') +
          '<div class="__rd_via">chiều: ' + (it.dirKnown ? 'khách → shop' : 'chưa rõ') + ' · ' +
            (it.via === 'websocket' ? 'báo TRƯỚC khi dòng hiện' : (it.lag ? 'báo sau dòng ' + (it.lag / 1000).toFixed(1) + 's' : 'nguồn: ' + esc(VIA_TEXT[it.via] || it.via))) + '</div>' +
          '</div></div>';
      }).join('');
    }
    p.innerHTML = head + body;

    p.querySelectorAll('[data-a]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const a = btn.getAttribute('data-a');
        if (a === 'in') { CFG.onlyIncoming = !CFG.onlyIncoming; save(); }
        if (a === 'clear') { state.items = []; }
        if (a === 'test') {
          publish({ psid: '000000000000', snippet: 'Đây là tin THỬ — radar đang chạy bình thường.', avatar: '', outgoing: false, dirKnown: true, ads: [], at: Date.now() }, 'thử');
        }
        if (a === 'diag') { state.diagOpen = !state.diagOpen; }
        if (a === 'notify') {
          CFG.notify = !CFG.notify;
          if (CFG.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
          }
          save();
        }
        render();
      });
    });

    p.querySelectorAll('.__rd_item').forEach(el => {
      el.addEventListener('click', () => {
        const psid = el.getAttribute('data-psid');
        const hit = state.items.find(i => i.psid === psid);
        if (hit) focusRow(hit.psid, hit.convId);
      });
    });
  }

  function diagText() {
    const d = state.diag;
    const logs = state.log.slice(0, 12).map(e => timeStr(e.t) + ' ' + e.tag + ' ' + e.text);
    return [
      'phiên bản: ' + VERSION,
      'trang: ' + location.href.slice(0, 120),
      'hook websocket: ' + (d.hook ? 'đã treo' : 'THẤT BẠI') + (d.hookErr ? ' — ' + d.hookErr : ''),
      'socket đã thấy: ' + (d.sockets.length ? '\n  ' + d.sockets.join('\n  ') : 'chưa có'),
      'khung nhận: ' + d.frames + ' · cấp tin nhắn: ' + d.msgFrames + ' · cấp hội thoại: ' + d.threadFrames + ' · khung JSON: ' + (d.jsonFrames || 0),
      'socket topics: ' + (Object.keys(d.phxTopics || {}).length ? Object.keys(d.phxTopics).map(k => k + ' (' + d.phxTopics[k] + ')').join(' · ') : '—'),
      'socket events: ' + (Object.keys(d.phxEvents || {}).length ? Object.keys(d.phxEvents).map(k => k + (d.phxEvents[k] > 1 ? ' (' + d.phxEvents[k] + ')' : '')).join(' · ') : '—'),
      'khung thô gần nhất: ' + ((d.rawFrames && d.rawFrames.length) ? '\n  ' + d.rawFrames.map(x => x.replace(/\s+/g, ' ')).join('\n  ') : '—'),
      'bỏ vì là tin shop: ' + d.skippedOut + ' · bỏ vì chưa rõ chiều: ' + d.skippedUnknown,
      'lần cuối có tin: ' + (d.lastFrameAt ? new Date(d.lastFrameAt).toLocaleTimeString() : '—') + ' · sender cuối: ' + (d.lastSender || '—'),
      'API danh sách: ' + state.listHits + ' lần · tên đã biết: ' + state.people.size,
      'trang có tin mới: ' + d.pageTriggers + ' · gọi riêng trang: ' + d.pagePolls + ' (lỗi ' + d.pageFail + ')',
      'dòng trong danh sách: ' + rows().length,
      'request danh sách: ' + d.listReq + ' lần · tự gọi lại: ' + (d.polls || 0) + ' lần · lần cuối: ' + (d.lastPollAt ? new Date(d.lastPollAt).toLocaleTimeString() : '—'),
      'chưa gắn tag: hỏi ' + (d.untaggedPolls || 0) + ' lần · lỗi ' + (d.untaggedErr || 0) + ' · ' + (d.untaggedConvs || 0) + ' hội thoại chưa gắn tag đã thấy',
      'khung cập nhật hội thoại: ' + (d.convPatches || 0) + ' · có người gửi: ' + (d.patchWithSender || 0) + ' · có nội dung: ' + (d.patchWithSnippet || 0),
      'khoá trong khung gần nhất: ' + (d.patchKeys || '—'),
      'nhịp quét đã chạy: ' + (d.ticks || 0) + ' lần',
      'gọi lại: thành công ' + (d.pollOk || 0) + ' · HTTP lỗi ' + (d.pollBad || 0) + ' · JSON lỗi ' + (d.pollJsonErr || 0) + ' · bỏ vì quá sát nhịp ' + (d.pollSkips || 0) + ' · tab ẩn ' + (d.hiddenSkips || 0),
      'nguồn request: ' + (state.listReq ? ((state.listReq.fromXhr ? 'XMLHttpRequest' : 'fetch') + ' ' + state.listReq.method + ' — ' + String(state.listReq.url).slice(0, 100)) : 'chưa học được (sẽ tự dựng)'),
      'XHR thấy: ' + (d.xhrHits || 0) + ' · body học được: ' + (state.listReq && state.listReq.body != null ? 'có' : 'chưa') + ' · tự dựng: ' + (d.defaultPolls || 0),
      'lỗi gần nhất: ' + (d.lastErr || '—'),
      '',
      'NHẬT KÝ (mới nhất ở trên):',
      (logs.length ? logs.join('\n') : '  (chưa có hoạt động)')
    ].join('\n');
  }

  function focusRow(psid, convId) {
    const pos = positionOf(psid, convId);
    if (!pos.el) return;
    try { pos.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    const old = pos.el.style.outline;
    pos.el.style.outline = '2px solid #0ea5e9';
    setTimeout(() => { pos.el.style.outline = old; }, 1600);
  }

  function save() {
    try { localStorage.setItem('radar.cfg', JSON.stringify(CFG)); } catch (e) { /* ignore */ }
  }

  // ======================================================================
  // 7. API + KHỞI ĐỘNG
  // ======================================================================
  window.__radar = {
    version: VERSION,
    cfg: CFG,
    get items() { return state.items.slice(); },
    get people() { return state.people; },
    get state() { return state; },
    debug: () => ({
      version: VERSION, url: location.href, on: CFG.on,
      wsHits: state.wsHits, listHits: state.listHits, domHits: state.domHits,
      people: state.people.size, convs: state.convs.size,
      items: state.items.length, rows: rows().length,
      diag: JSON.parse(JSON.stringify(state.diag))
    }),
    set(patch) { Object.assign(CFG, patch); save(); render(); return CFG; },
    clear() { state.items = []; render(); },
    scan: () => { scanDom(); render(); return state.domHits; },
    /** gọi lại danh sách ngay (dùng cho kiểm thử / khi cần làm mới) */
    poll: () => {
      const r0 = state.listReq || state.defaultReq;
      if (r0) r0.lastPoll = 0;
      pollList(true);
      const r = state.listReq || state.defaultReq;
      return r ? { url: r.url, method: r.method, hasBody: r.body != null } : null;
    },
    feed(b64) { try { readWsData(typeof b64 === 'string' ? atob(b64) : b64); } catch (e) { state.diag.lastErr = 'feed: ' + e.message; return false; } return true; },
    help() {
      console.log('%c[radar] cách dùng', 'color:#0ea5e9;font-weight:600');
      console.log('  __radar.debug()   — trạng thái + chẩn đoán');
      console.log('  __radar.set({on:false}) — tắt radar');
      console.log('  __radar.set({onlyIncoming:false}) — hiện cả tin shop (để đối chiếu)');
      console.log('  __radar.set({allowUnknown:true}) — cho phép báo tin chưa rõ chiều');
      console.log('  __radar.clear() · __radar.scan() · __radar.feed("<base64>")');
    }
  };

  (function boot() {
    const go = () => { try { render(); } catch (e) { /* ignore */ } try { watchDom(); } catch (e) { /* ignore */ } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
    window.addEventListener('load', go);

    setTimeout(() => {
      try {
        const r = state.listReq;
        logEvent('🚀', 'radar v' + VERSION + ' đang chạy · ' +
          (r ? 'đã học request ' + (r.fromXhr ? 'XHR' : 'fetch') + ' ' + r.method : 'chưa học request danh sách (sẽ tự dựng)') +
          ' · dòng trên màn hình: ' + rows().length);
      } catch (e) { /* ignore */ }
    }, 3000);

    setInterval(() => {
      state.diag.ticks = (state.diag.ticks || 0) + 1;
      if (CFG.on) pollList();
    }, Math.max(1000, Number(CFG.pollMs) || 2000));

    setInterval(() => { try { pollUntagged(); } catch (e) { /* ignore */ } }, Math.max(700, Number(CFG.untaggedMs) || 1200));

    // nhịp tim: chứng minh radar còn thức và cho biết 30 giây qua nó làm được gì
    const hb = { listHits: 0, polls: 0, frames: 0, skippedOut: 0 };
    setInterval(() => {
      try {
        const d = state.diag;
        const now = { listHits: state.listHits, polls: d.polls || 0, frames: d.frames || 0, skippedOut: d.skippedOut || 0 };
        const dl = k => (now[k] - (hb[k] || 0));
        logEvent('💓', '30 giây: quét ' + dl('polls') + ' lần · danh sách ' + dl('listHits') + ' lần · khung ' + dl('frames') +
          ' · bỏ ' + dl('skippedOut') + ' tin shop' + (d.hiddenSkips ? ' · tab ẩn ' + d.hiddenSkips + ' lần' : ''));
        hb.listHits = now.listHits; hb.polls = now.polls; hb.frames = now.frames; hb.skippedOut = now.skippedOut;
      } catch (e) { /* ignore */ }
    }, 30000);
    setInterval(() => {
      if (!CFG.on) return;
      try { if (CFG.watchDom || CFG.domTrigger) scanDom(); } catch (e) { /* ignore */ }
      try { render(); } catch (e) { /* ignore */ }
    }, 4000);
  })();
})();

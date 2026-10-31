// ==UserScript==
// @name         Pancake - Radar tin nhắn TỚI (chỉ tin khách gửi đến)
// @namespace    https://github.com/chongoan4444/TEST1
// @version      1.7.0
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

  const VERSION = '1.7.0';

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
    defaultPoll: true        // nếu chưa học được request danh sách nào thì tự dựng request (đúng dạng trong HAR)
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
    panel: null,
    fab: null,
    diagOpen: false,
    log: [],
    diag: {
      hook: false, hookErr: '', sockets: [], frames: 0, listReq: 0, polls: 0, lastPollAt: 0, bodyReady: false,
      pageTriggers: 0, pagePolls: 0, pageFail: 0, xhrHits: 0, defaultPolls: 0,
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
    const pageId = pageIdNow();
    let hit = parseMessageFrame(text, pageId);
    if (hit) state.diag.msgFrames++;
    else { hit = parseThreadFrame(text, pageId); if (hit) state.diag.threadFrames++; }
    if (!hit) return;

    state.diag.parsed++;
    state.diag.lastFrameAt = Date.now();
    state.diag.lastSender = hit.sender || (hit.dirKnown ? 'tiền tố' : '?');
    route(hit, 'websocket');
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
            if (/facebook\.com|\/chat|lightspeed|messenger/i.test(url)) ws.addEventListener('message', onMsg);
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

  function ingestList(json, fromPage) {
    if (!json || typeof json !== 'object') return;
    const arr = json.conversations || json.data || [];
    if (!Array.isArray(arr) || !arr.length) return;
    state.listHits++;
    logEvent('🔄', 'danh sách: ' + arr.length + ' hội thoại');
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

    if (!state.seeded) { state.seeded = true; watchPageCounts(json); render(); return; }
    if (CFG.watchList) fresh.forEach(f => route(f, 'danh sách'));
    if (!fromPage) watchPageCounts(json);
    render();
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
  function targetPagePoll(pageId) {
    if (state.pagePollFail >= 2) return;
    const now = Date.now();
    if (now - (state.pagePollAt[pageId] || 0) < 3000) return;
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
          p.then(r => { let c; try { c = r.clone(); } catch (e) { return; } c.json().then(j => ingestList(j)).catch(() => {}); }).catch(() => {});
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

  function pollList(force, urgent) {
    if (!CFG.on || !CFG.watchList) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const r = pickReq();
    if (!r) return;
    if (r.own) {
      state.diag.defaultPolls = (state.diag.defaultPolls || 0) + 1;
      if (state.diag.defaultPolls === 1) logEvent('🛠', 'dùng request tự dựng cho trang hiện tại');
    }
    // urgent = dòng vừa đổi trên màn hình: gần như gọi ngay, không để bị chặn bởi nhịp quét
    const gap = urgent ? 250
      : (force ? Math.max(600, Number(CFG.pollMinGap) || 1200) : Math.max(1000, Number(CFG.pollMs) || 2000));
    if (Date.now() - (r.lastPoll || 0) < gap) return;
    r.lastPoll = Date.now();
    const method = String(r.method || 'POST').toUpperCase();
    const opt = { method: method, credentials: 'include' };
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
      Promise.resolve(pr).then(res => {
        if (res && res.ok === false) {
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
          state.__pollTimer = setTimeout(() => { state.__pollTimer = 0; pollList(true, true); }, 150);
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
  const VIA_TEXT = { websocket: 'websocket', 'danh sách': 'API danh sách', 'giao diện': 'giao diện', 'thử': 'tin thử' };

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
      'khung nhận: ' + d.frames + ' · cấp tin nhắn: ' + d.msgFrames + ' · cấp hội thoại: ' + d.threadFrames,
      'bỏ vì là tin shop: ' + d.skippedOut + ' · bỏ vì chưa rõ chiều: ' + d.skippedUnknown,
      'lần cuối có tin: ' + (d.lastFrameAt ? new Date(d.lastFrameAt).toLocaleTimeString() : '—') + ' · sender cuối: ' + (d.lastSender || '—'),
      'API danh sách: ' + state.listHits + ' lần · tên đã biết: ' + state.people.size,
      'trang có tin mới: ' + d.pageTriggers + ' · gọi riêng trang: ' + d.pagePolls + ' (lỗi ' + d.pageFail + ')',
      'dòng trong danh sách: ' + rows().length,
      'request danh sách: ' + d.listReq + ' lần · tự gọi lại: ' + (d.polls || 0) + ' lần · lần cuối: ' + (d.lastPollAt ? new Date(d.lastPollAt).toLocaleTimeString() : '—'),
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

    setInterval(() => { if (CFG.on) pollList(); }, Math.max(1000, Number(CFG.pollMs) || 2000));
    setInterval(() => {
      if (!CFG.on) return;
      try { if (CFG.watchDom || CFG.domTrigger) scanDom(); } catch (e) { /* ignore */ }
      try { render(); } catch (e) { /* ignore */ }
    }, 4000);
  })();
})();

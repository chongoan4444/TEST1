// ==UserScript==
// @name         Pancake - Radar tin nhắn TỚI (chỉ tin khách gửi đến)
// @namespace    https://github.com/chongoan4444/TEST1
// @version      1.4.0
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

  const VERSION = '1.4.0';

  const DEFAULTS = {
    on: true,
    panel: true,
    onlyIncoming: true,      // chỉ báo tin khách gửi tới
    allowUnknown: false,     // false = không báo tin không xác định được chiều
    max: 8,
    notify: false,
    pollMs: 8000,            // tự gọi lại danh sách (chỉ khi tab đang xem)
    watchList: true,         // dự phòng bằng API danh sách (chiều chính xác)
    watchDom: false          // theo dõi giao diện: KHÔNG biết chiều -> mặc định tắt
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
    panel: null,
    fab: null,
    diagOpen: false,
    log: [],
    diag: {
      hook: false, hookErr: '', sockets: [], frames: 0, listReq: 0, polls: 0, lastPollAt: 0, bodyReady: false,
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
    const sender = ms ? ms[1] : '';
    const snippet = unesc(mt[1]).replace(/\s+/g, ' ').trim();
    if (!snippet) return null;

    let outgoing = null;
    if (sender) outgoing = pageId ? (sender === pageId) : (sender !== mp[1] ? null : false);
    return {
      psid: mp[1], snippet, avatar: '', ads: [], at: Date.now(),
      sender, outgoing: outgoing === true, dirKnown: outgoing !== null, kind: 'message'
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

  function ingestList(json) {
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

      if (state.seeded && prev && (prev.updated_at !== updated || prev.snippet !== snippet) && snippet) {
        let outgoing = null;
        if (sbId && psid) outgoing = (sbId === psid) ? false : (pageId && sbId === pageId ? true : null);
        fresh.push({ psid, snippet, outgoing: outgoing === true, dirKnown: outgoing !== null, ads: [], avatar: '', at: Date.now(), sender: sbId, kind: 'list' });
      }
    });

    if (!state.seeded) { state.seeded = true; render(); return; }
    if (CFG.watchList) fresh.forEach(f => route(f, 'danh sách'));
    render();
  }

  function captureListReq(url, method, init, input) {
    const rec = {
      url: url,
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
    state.listReq = rec;
    state.diag.listReq = (state.diag.listReq || 0) + 1;
    render();
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      let method = (init && init.method) || (input && input.method) || 'GET';
      try { if (isListUrl(url)) captureListReq(url, method, init, input); } catch (e) { /* ignore */ }
      const p = _fetch.apply(this, arguments);
      try {
        if (isListUrl(url)) {
          p.then(r => { let c; try { c = r.clone(); } catch (e) { return; } c.json().then(j => ingestList(j)).catch(() => {}); }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__rdUrl = url; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (isListUrl(xhr.__rdUrl)) {
      try { state.listReq = { url: xhr.__rdUrl, init: null }; } catch (e) { /* ignore */ }
      xhr.addEventListener('load', function () { try { ingestList(JSON.parse(xhr.responseText)); } catch (e) { /* ignore */ } });
    }
    return _send.apply(this, arguments);
  };

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

  function pollList() {
    const r = state.listReq;
    if (!CFG.on || !CFG.watchList || !r) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (Date.now() - (r.lastPoll || 0) < Math.max(3000, Number(CFG.pollMs) || 10000)) return;
    r.lastPoll = Date.now();
    const opt = { method: r.method, credentials: 'include' };
    const h = safeHeaders(r.headers, r.body);
    if (h) opt.headers = h;
    if (r.body != null) opt.body = r.body;
    try {
      fetch(r.url, opt)
        .then(() => { state.diag.lastPollAt = Date.now(); state.diag.polls = (state.diag.polls || 0) + 1; })
        .catch(err => logEvent('⚠️', 'gọi danh sách lỗi: ' + err.message));
    } catch (e) { logEvent('⚠️', 'gọi danh sách lỗi: ' + e.message); }
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
    if (!CFG.on || !CFG.watchDom || !document.body) return;
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
        const outPrefix = /^Bạn\s*:|^Bạn\s+đã\s+|^You\s*:/i.test(snip);
        route({ psid, snippet: snip, avatar: '', ads: [], at: Date.now(), sender: '', outgoing: outPrefix, dirKnown: outPrefix, kind: 'dom' }, 'giao diện');
      }
    }
    state.domReady = true;
    render();
  }

  function watchDom() {
    if (!CFG.watchDom || typeof MutationObserver === 'undefined') return;
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
    const dup = state.items.some(it => it.psid === hit.psid && normText(it.snippet) === key && Date.now() - it.at < 20000);
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
      sender: hit.sender || ''
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
    const lastAt = d.lastPollAt || (state.listReq && state.listReq.at) || 0;
    const stat = (d.hook ? 'WS ' + d.sockets.length + ' socket · ' + d.msgFrames + ' tin' : 'WS chưa treo được hook') +
      ' · DS ' + state.listHits + ' lần' + (lastAt ? ' (' + timeStr(lastAt) + ')' : '') +
      ' · bỏ ' + d.skippedOut + ' tin shop' + (d.skippedUnknown ? ' · ' + d.skippedUnknown + ' chưa rõ chiều' : '') +
      ' · Tên ' + state.people.size;

    const head = '<div class="__rd_head">' +
      '<div class="__rd_hrow"><b>📨 Tin khách gửi tới</b><span class="sp"></span>' +
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
          '<div class="__rd_via">chiều: ' + (it.dirKnown ? 'khách → shop' : 'chưa rõ') + ' · nguồn: ' + esc(VIA_TEXT[it.via] || it.via) + '</div>' +
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
      'dòng trong danh sách: ' + rows().length,
      'request danh sách: ' + d.listReq + ' lần · tự gọi lại: ' + (d.polls || 0) + ' lần · lần cuối: ' + (d.lastPollAt ? new Date(d.lastPollAt).toLocaleTimeString() : '—'),
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
      if (!state.listReq) return null;
      state.listReq.lastPoll = 0;
      pollList();
      return { url: state.listReq.url, method: state.listReq.method, hasBody: state.listReq.body != null };
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

    setInterval(() => { if (CFG.on) pollList(); }, Math.max(5000, Number(CFG.pollMs) || 10000));
    setInterval(() => {
      if (!CFG.on) return;
      try { if (CFG.watchDom) scanDom(); } catch (e) { /* ignore */ }
      if (state.items.length) render();
    }, 4000);
  })();
})();

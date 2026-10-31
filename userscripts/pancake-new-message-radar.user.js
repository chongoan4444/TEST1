// ==UserScript==
// @name         Pancake - Radar tin nhắn tới (báo trước)
// @namespace    https://github.com/chongoan4444/TEST1
// @version      1.0.0
// @description  Báo TIN NHẮN TỚI trước khi Pancake vẽ dòng chat: tên khách + nội dung + vị trí dòng sẽ xuất hiện. Đọc khung websocket Facebook (ad_id/psid/snippet) đã kiểm chứng trong batmesss.har, ghép tên từ API danh sách. Không đoán: khung gộp nhiều hội thoại thì bỏ.
// @author       Arena Agent
// @match        https://pancake.vn/*
// @match        https://*.pancake.vn/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/**
 * RADAR TIN NHẮN TỚI — script RIÊNG, không phụ thuộc script gắn nhãn.
 *
 * Căn cứ dữ liệu thật (batmesss.har):
 *   - 1 kết nối wss://edge-chat.facebook.com/chat, 118 khung
 *   - 8 khung "deleteThenInsertThread" mang: psid (entity_id=…), nội dung tin,
 *     URL ảnh đại diện; có khung còn mang nhãn ad_id.<số> (nguồn quảng cáo)
 *   - trong danh sách hội thoại: 1175/1177 id có dạng <page_id>_<from_psid>
 *     -> ghép psid với tên khách lấy từ API danh sách là chắc chắn
 *
 * NGUYÊN TẮC: khung có NHIỀU hơn 1 psid (khung gộp) -> bỏ, không đoán.
 */
(function () {
  'use strict';

  const VERSION = '1.0.0';

  const DEFAULTS = {
    on: true,             // bật/tắt radar
    panel: true,          // hiện bảng
    onlyIncoming: true,   // chỉ báo tin KHÁCH gửi tới (bỏ tin của shop)
    max: 8,               // số dòng giữ lại trong bảng
    notify: false,        // thông báo hệ thống (cần bấm nút để xin quyền)
    flashMs: 2500
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
    convs: new Map(),    // convId -> { psid, name, snippet, updated_at, lastSentBy }
    items: [],           // lịch sử báo
    seeded: false,
    wsAlive: false,        // đã đọc được ít nhất 1 khung -> không dùng dự phòng danh sách
    wsHits: 0,
    listHits: 0,
    panel: null,
    fab: null
  };

  const LOG = (...a) => console.log('%c[radar]', 'color:#0ea5e9;font-weight:600', ...a);

  // ======================================================================
  // 1. GIẢI MÃ KHUNG WEBSOCKET
  // ======================================================================

  /** bỏ các lớp escape của Facebook: \uXXXX, \\/, \\" */
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
    return '';
  }

  /**
   * Tách một khung websocket.
   * Trả null nếu: không có tin mới, hoặc khung gộp nhiều hội thoại (không dám đoán).
   */
  function parseFrame(text, pageId) {
    if (!text || text.length > 200000) return null;
    if (text.indexOf('deleteThenInsertThread') < 0) return null;

    // psid: entity_id trong URL media; bỏ entity_id của chính trang
    const psids = [];
    let m;
    const reE = /entity_id=(\d{5,})/g;
    while ((m = reE.exec(text))) {
      if (pageId && m[1] === pageId) continue;
      if (psids.indexOf(m[1]) < 0) {
        psids.push(m[1]);
        if (psids.length > 1) return null;     // khung gộp nhiều hội thoại -> bỏ, không đoán
      }
    }
    if (psids.length !== 1) return null;

    // Bỏ các lớp escape (\\" -> ", \\uXXXX -> chữ) rồi mới đọc — dễ đúng hơn quét trên chuỗi thô
    const clean = unesc(text);
    const ms = /deleteThenInsertThread[^[]*\[19,"\d+"\],\[19,"-?\d+"\],"([^"]{0,400})"/.exec(clean);
    if (!ms) return null;
    const snippet = String(ms[1]).replace(/\s+/g, ' ').trim();
    if (!snippet) return null;

    // ảnh đại diện (nếu có) để nhận ra khách dù chưa biết tên
    let avatar = '';
    const ma = /(https:\/\/scontent[^"'\\\s]+)/.exec(clean);
    if (ma) avatar = ma[1];

    // Facebook tự thêm "Bạn:" / "Bạn đã gửi …" cho tin do shop gửi
    const outgoing = /^Bạn\s*:|^Bạn\s+đã\s+(gửi|trả lời|phản hồi)/i.test(snippet);

    // nhãn quảng cáo (nếu có) — chỉ để hiện thêm, không bắt buộc
    const ads = [];
    const reA = /ad_id\.(\d{5,})/g;
    while ((m = reA.exec(text))) if (ads.indexOf(m[1]) < 0) ads.push(m[1]);

    return { psid: psids[0], snippet, avatar, outgoing, ads, at: Date.now() };
  }

  // ======================================================================
  // 2. BẮT WEBSOCKET (không làm hỏng app)
  // ======================================================================
  function readWsData(data) {
    try {
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
    } catch (e) { /* ignore */ }
  }

  function onFrameText(text) {
    if (!CFG.on) return;
    const hit = parseFrame(text, pageIdNow());
    if (!hit) return;
    state.wsAlive = true;                    // websocket có tác dụng -> không cần dự phòng bằng danh sách
    if (CFG.onlyIncoming && hit.outgoing) return;
    state.wsHits++;
    publish(hit, 'websocket');
  }

  (function hookWebSocket() {
    const Orig = window.WebSocket;
    if (typeof Orig !== 'function' || Orig.__radarHook) return;
    const onMsg = ev => { if (ev && ev.data) readWsData(ev.data); };
    const Wrapped = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        try {
          if (/facebook\.com|\/chat|lightspeed/i.test(String(args[0] || ''))) ws.addEventListener('message', onMsg);
        } catch (e) { /* ignore */ }
        return ws;
      }
    });
    try { Wrapped.__radarHook = true; } catch (e) { /* ignore */ }
    try { Object.defineProperty(window, 'WebSocket', { value: Wrapped, configurable: true, writable: true }); }
    catch (e) { try { window.WebSocket = Wrapped; } catch (e2) { /* ignore */ } }
  })();

  // ======================================================================
  // 3. ĐỌC DANH SÁCH HỘI THOẠI (để lấy TÊN + vị trí dòng)
  // ======================================================================
  function isListUrl(url) {
    return /\/api\/v1\/pages\/[^/]+\/conversations(\?|$)/.test(String(url || '').split('#')[0]) &&
      !/\/messages/.test(String(url || ''));
  }

  function ingestList(json) {
    if (!json || typeof json !== 'object') return;
    const arr = json.conversations || json.data || [];
    if (!Array.isArray(arr) || !arr.length) return;
    state.listHits++;
    const fresh = [];
    arr.forEach(cv => {
      if (!cv || typeof cv !== 'object') return;
      const id = String(cv.id || cv.conversation_id || '');
      const psid = String(cv.from_psid || (id.indexOf('_') > 0 ? id.split('_')[1] : ''));
      let name = '';
      const cs = cv.customers;
      if (Array.isArray(cs) && cs.length && cs[0] && cs[0].name) name = String(cs[0].name);
      else if (cv.from && cv.from.name) name = String(cv.from.name);
      const avatar = (Array.isArray(cs) && cs[0] && (cs[0].avatar || cs[0].picture)) || cv.from_avatar || '';
      const prev = state.convs.get(id);
      state.convs.set(id, {
        psid, name, snippet: String(cv.snippet || ''), updated_at: String(cv.updated_at || ''), lastSentBy: String(cv.last_sent_by || '')
      });
      if (psid && name) state.people.set(psid, { name, convId: id, avatar: avatar || (state.people.get(psid) || {}).avatar || '' });
      // phát hiện tin mới bằng danh sách (chỉ để dự phòng khi websocket không có)
      if (state.seeded && prev && (prev.updated_at !== String(cv.updated_at || '') || prev.snippet !== String(cv.snippet || ''))) {
        fresh.push({ id, psid, name, snippet: String(cv.snippet || ''), lastSentBy: String(cv.last_sent_by || '') });
      }
    });
    state.seeded = true;
    if (CFG.on && !state.wsAlive) {
      fresh.forEach(f => publish({ psid: f.psid, snippet: f.snippet, avatar: '', outgoing: false, ads: [], at: Date.now() }, 'danh sách'));
    }
    render();
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      const p = _fetch.apply(this, arguments);
      try {
        if (isListUrl(url)) {
          p.then(r => { let c; try { c = r.clone(); } catch (e) { return; } c.json().then(ingestList).catch(() => {}); }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__rdUrl = url; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    if (isListUrl(xhr.__rdUrl)) {
      xhr.addEventListener('load', function () { try { ingestList(JSON.parse(xhr.responseText)); } catch (e) { /* ignore */ } });
    }
    return _send.apply(this, arguments);
  };

  // ======================================================================
  // 4. VỊ TRÍ DÒNG TRONG DANH SÁCH
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

  /** trả { pos, total } nếu hội thoại đang có trong danh sách */
  function positionOf(psid, convId) {
    const list = rows();
    for (let i = 0; i < list.length; i++) {
      const id = convIdOfRow(list[i]);
      if (id && (id === convId || (psid && id.endsWith('_' + psid)))) return { pos: i + 1, total: list.length, el: list[i] };
    }
    return { pos: 0, total: list.length, el: null };
  }

  function nameOfPsid(psid) {
    const p = state.people.get(psid);
    return (p && p.name) || '';
  }

  // ======================================================================
  // 5. PHÁT SỰ KIỆN + VẼ BẢNG
  // ======================================================================
  function publish(hit, via) {
    const convId = (pageIdNow() ? pageIdNow() + '_' : '') + hit.psid;
    const know = state.people.get(hit.psid) || {};
    const pos = positionOf(hit.psid, convId);
    // trùng lặp: cùng psid + cùng nội dung trong 20 giây thì bỏ
    const dup = state.items.some(it => it.psid === hit.psid && it.snippet === hit.snippet && Date.now() - it.at < 20000);
    if (dup) return;

    const item = {
      psid: hit.psid,
      convId,
      name: know.name || nameOfPsid(hit.psid) || '',
      snippet: hit.snippet,
      avatar: hit.avatar || know.avatar || '',
      ads: hit.ads || [],
      via,
      at: hit.at || Date.now(),
      posNow: pos.pos,
      posPredicted: pos.pos > 1 ? 1 : (pos.pos === 1 ? 1 : 1),
      total: pos.total
    };
    state.items.unshift(item);
    if (state.items.length > 40) state.items.length = 40;
    render();
    notify(item);
    LOG('tin tới:', item.name || hit.psid, '·', item.snippet.slice(0, 60), '· vị trí', pos.pos || 'mới');
  }

  function notify(item) {
    if (!CFG.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification((item.name || 'Khách') + ' vừa nhắn', { body: item.snippet, tag: 'radar-' + item.psid });
    } catch (e) { /* ignore */ }
  }

  const CSS = `
  .__rd_fab{position:fixed;right:16px;bottom:96px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
    background:#0ea5e9;color:#fff;border:0;cursor:pointer;box-shadow:0 4px 14px rgba(14,165,233,.45);font-size:20px}
  .__rd_fab .n{position:absolute;top:-4px;right:-4px;background:#e11d48;color:#fff;border-radius:10px;font-size:11px;
    padding:1px 5px;font-family:system-ui,sans-serif}
  .__rd_panel{position:fixed;right:16px;bottom:150px;z-index:2147483000;width:340px;max-height:60vh;overflow:auto;
    background:#0f172a;color:#e2e8f0;border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.45);
    font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .__rd_panel.off{display:none}
  .__rd_head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0b1220;border-radius:14px 14px 0 0}
  .__rd_head b{font-size:13px;letter-spacing:.02em}
  .__rd_head .sp{flex:1}
  .__rd_head button{background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:8px;cursor:pointer;
    font-size:11px;padding:3px 7px}
  .__rd_head button.on{background:#0ea5e9;color:#fff;border-color:#0ea5e9}
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

  function timeStr(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function render() {
    if (!document.body) return;
    style();
    if (!state.fab) {
      const b = document.createElement('button');
      b.className = '__rd_fab';
      b.title = 'Radar tin nhắn tới';
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

    const head = '<div class="__rd_head"><b>📨 Tin nhắn tới</b>' +
      '<span class="sp"></span>' +
      '<button data-a="in" class="' + (CFG.onlyIncoming ? 'on' : '') + '" title="Chỉ báo tin của khách">chỉ tin tới</button>' +
      '<button data-a="notify" class="' + (CFG.notify ? 'on' : '') + '" title="Thông báo hệ thống">🔔</button>' +
      '<button data-a="clear" title="Xoá danh sách">🧹</button></div>';

    const list = (CFG.on ? state.items.slice(0, CFG.max) : []);
    let body = '';
    if (!CFG.on) body = '<div class="__rd_empty">Radar đang TẮT.</div>';
    else if (!list.length) body = '<div class="__rd_empty">Chưa có tin mới. Khung websocket sẽ báo ở đây trước khi dòng chat hiện ra.</div>';
    else {
      body = list.map(it => {
        const posNow = positionOf(it.psid, it.convId);
        const posLabel = posNow.pos
          ? ('dòng ' + posNow.pos + (posNow.pos > 1 ? ' → #1' : ''))
          : 'dòng mới #1';
        const top = !posNow.pos || posNow.pos === 1;
        const initial = (it.name || '?').trim().charAt(0).toUpperCase() || '?';
        const ava = it.avatar
          ? '<img class="__rd_ava" src="' + esc(it.avatar) + '" onerror="this.style.display=\'none\'">'
          : '<div class="__rd_ava ph">' + esc(initial) + '</div>';
        return '<div class="__rd_item' + (Date.now() - it.at < 4000 ? ' new' : '') + '" data-psid="' + esc(it.psid) + '">' +
          ava +
          '<div class="__rd_body">' +
          '<div class="__rd_top"><span class="__rd_name">' + esc(it.name || ('Khách ' + it.psid.slice(-6))) + '</span>' +
          '<span class="__rd_pos' + (top ? ' top' : '') + '">' + esc(posLabel) + '</span>' +
          '<span class="__rd_time">' + timeStr(it.at) + '</span></div>' +
          '<div class="__rd_snip">' + esc(it.snippet) + '</div>' +
          (it.ads && it.ads.length ? '<div class="__rd_ad">🔥 quảng cáo · ad_id ' + esc(it.ads[0]) + '</div>' : '') +
          '<div class="__rd_via">nguồn: ' + esc(it.via === 'websocket' ? 'websocket (trước khi hiện)' : 'danh sách (sau khi hiện)') + '</div>' +
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
  // 6. API + KHỞI ĐỘNG
  // ======================================================================
  window.__radar = {
    version: VERSION,
    cfg: CFG,
    get items() { return state.items.slice(); },
    get people() { return state.people; },
    debug: () => ({
      version: VERSION, url: location.href, on: CFG.on,
      wsHits: state.wsHits, listHits: state.listHits, wsAlive: state.wsAlive,
      people: state.people.size, convs: state.convs.size, items: state.items.length,
      rows: rows().length
    }),
    set(patch) { Object.assign(CFG, patch); save(); render(); return CFG; },
    clear() { state.items = []; render(); },
    /** nạp một khung thật (base64 hoặc chuỗi) để thử */
    feed(b64) { try { readWsData(typeof b64 === 'string' ? atob(b64) : b64); } catch (e) { return false; } return true; },
    help() {
      console.log('%c[radar] cách dùng', 'color:#0ea5e9;font-weight:600');
      console.log('  __radar.debug()            — xem trạng thái');
      console.log('  __radar.set({on:false})    — tắt radar');
      console.log('  __radar.set({onlyIncoming:false}) — báo cả tin của shop');
      console.log('  __radar.clear()            — xoá danh sách');
      console.log('  __radar.feed("<base64>")   — nạp khung websocket để thử');
    }
  };

  (function boot() {
    const go = () => { render(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
    window.addEventListener('load', go);
    // quét lại vị trí dòng khi danh sách đổi (nhẹ: 1 giây/lần, chỉ khi bảng mở)
    setInterval(() => { if (CFG.on && CFG.panel && state.items.length) render(); }, 4000);
  })();
})();

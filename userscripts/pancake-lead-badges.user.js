// ==UserScript==
// @name         Pancake - Phân loại tệp khách theo nguồn
// @namespace    https://github.com/chongoan4444/TEST1
// @version      1.0.0
// @description  Gắn nhãn Quảng cáo / Bài viết / Livestream / Tự nhắn + điểm ưu tiên cho từng hội thoại ngay trên danh sách Pancake. Không cần mở từng đoạn chat.
// @author       Arena Agent
// @match        https://pancake.vn/*
// @match        https://*.pancake.vn/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ======================================================================
  // 1. CẤU HÌNH  (đổi trực tiếp ở đây, hoặc trong console:
  //    localStorage.setItem('leadSource.cfg', JSON.stringify({pollMs:10000})))
  // ======================================================================
  const DEFAULTS = {
    pollMs: 20000,        // tự gọi lại danh sách hội thoại mỗi N ms (0 = tắt)
    autoEnrich: true,     // khách mới/chưa rõ -> tự xem tin nhắn để phân loại chính xác
    enrichLimit: 3,       // tối đa N hội thoại enrich mỗi vòng (tránh spam API)
    showPanel: true,      // hiện bảng nổi
    showChips: true,      // gắn nhãn vào từng dòng trong danh sách
    topN: 12,             // số dòng hiện trong bảng nổi
    tagMap: {},           // {'83': {name:'Từ quảng cáo', source:'ads'}, '172': {name:'Live', source:'live'}}
    weights: { unread: 30, recent_24h: 20, recent_3d: 10, has_phone: 15, many_msgs: 10, intent: 20, source_ads: 10, source_post: 5 },
    thresholds: { hot: 70, warm: 40 },
    intent: ['gia', 'bao nhieu', 'nhieu tien', 'size', 'mau', 'con hang', 'con khong', 'dat hang', 'dat',
      'mua', 'lay', 'ship', 'giao', 'ib', 'inbox', 'chot', 'order', 'sdt', 'so dien thoai', 'dia chi',
      'chuyen khoan', 'ck', 'giam gia', 'khuyen mai', 'sale', 'ai ban', 'con size', 'ship cod'],
  };

  const CFG = (function () {
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = (typeof localStorage !== 'undefined') ? (localStorage.getItem('leadSource.cfg') || '{}') : '{}';
      const user = JSON.parse(raw);
      Object.keys(user).forEach(k => {
        out[k] = (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && out[k] && typeof out[k] === 'object')
          ? Object.assign({}, out[k], user[k]) : user[k];
      });
    } catch (e) { /* cfg hỏng -> dùng mặc định */ }
    return out;
  })();

  const SOURCE_LABEL = { ads: 'Quảng cáo', post: 'Bài viết', live: 'Livestream', organic: 'Tự nhắn', unknown: 'Chưa rõ' };
  const SOURCE_SHORT = { ads: 'QC', post: 'BV', live: 'LV', organic: 'TN', unknown: '?' };
  const SOURCE_COLOR = { ads: '#7c3aed', post: '#0ea5e9', live: '#e11d48', organic: '#059669', unknown: '#6b7280' };
  const CONF_LABEL = { high: 'cao', mid: 'trung bình', low: 'thấp' };

  const AD_KEYS = ['ad_id', 'ad_ids', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'ad_name',
    'ad_name_id', 'ads_context_data', 'referral', 'ad_referral', 'is_ad', 'from_ad', 'click_id', 'adgroup_id', 'source_ad_id'];
  const POST_KEYS = ['post_id', 'post', 'comment_id', 'post_story', 'post_permalink', 'live_video_id'];
  const COMMENT_HINTS = ['COMMENT', 'REPLY', 'POST_COMMENT'];
  const LIVE_HINTS = ['LIVE', 'LIVESTREAM'];

  const LOG = (...a) => console.log('%c[lead-source]', 'color:#7c3aed;font-weight:600', ...a);

  // ======================================================================
  // 2. PHÂN LOẠI (giống hệt tools/lead_source.py)
  // ======================================================================

  function stripAccents(s) {
    return String(s || '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  function jsonify(v, n) {
    n = n || 90;
    return (v && typeof v === 'object') ? clip(JSON.stringify(v), n) : clip(v, n);
  }

  function isEmptyish(v) {
    return v === null || v === undefined || v === '' || v === false || v === 0 || v === '0' ||
      (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  }

  function deepFind(obj, keySet, path, out, depth) {
    out = out || [];
    path = path || '';
    depth = depth || 0;
    if (depth > 8 || !obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 60); i++) deepFind(obj[i], keySet, path + '[' + i + ']', out, depth + 1);
      return out;
    }
    for (const k of Object.keys(obj)) {
      const p = path ? path + '.' + k : k;
      const v = obj[k];
      if (keySet.indexOf(String(k).toLowerCase()) >= 0) out.push({ path: p, value: v });
      if (v && typeof v === 'object') deepFind(v, keySet, p, out, depth + 1);
      else if (typeof v === 'string' && (v[0] === '{' || v[0] === '[') && v.length < 5000) {
        try { deepFind(JSON.parse(v), keySet, p, out, depth + 1); } catch (e) {} // eslint-disable-line no-empty
      }
    }
    return out;
  }

  /** -> { source, confidence, evidence[] } */
  function classify(conv, msgs) {
    msgs = msgs || [];
    const evidence = [];
    let source = null;
    let confidence = 'low';

    const convType = String(conv.type || '').toUpperCase();
    const msgTypes = {};
    msgs.forEach(m => {
      if (!m || typeof m !== 'object') return;
      ['type', 'message_type', 'verb'].forEach(k => { if (typeof m[k] === 'string') msgTypes[m[k].toUpperCase()] = 1; });
    });
    const typesList = Object.keys(msgTypes);

    // --- 1. Quảng cáo
    let adHits = [];
    const blobs = [['extra_info', conv.extra_info], ['conv', { post: conv.post, type: conv.type }], ['messages', msgs]];
    blobs.forEach(([name, blob]) => {
      if (!blob) return;
      deepFind(blob, AD_KEYS).forEach(hit => {
        if (isEmptyish(hit.value)) return;
        adHits.push(name + '.' + hit.path + ' = ' + jsonify(hit.value));
      });
    });
    adHits = adHits.filter((h, i) => !adHits.some((o, j) => j !== i && o.split(' = ')[0].indexOf(h.split(' = ')[0] + '.') === 0));
    if (adHits.length) {
      source = 'ads'; confidence = 'high';
      evidence.push.apply(evidence, adHits.slice(0, 4));
    }

    // --- 2. Bài viết
    const postHits = [];
    deepFind({ extra_info: conv.extra_info, conv: { post_id: conv.post_id, post: conv.post } }, POST_KEYS)
      .forEach(hit => { if (!isEmptyish(hit.value)) postHits.push(hit.path + ' = ' + jsonify(hit.value)); });
    const isCommentType = COMMENT_HINTS.some(h => convType.indexOf(h) >= 0) ||
      typesList.some(t => COMMENT_HINTS.some(h => t.indexOf(h) >= 0));
    if (postHits.length || isCommentType) {
      if (!source) { source = 'post'; confidence = postHits.length ? 'high' : 'mid'; }
      else if (source === 'ads') evidence.push('(đồng thời có dấu hiệu comment)');
      evidence.push.apply(evidence, postHits.slice(0, 3));
      if (isCommentType) evidence.push('type = ' + (convType || typesList.join('/')) + ' → comment');
    }

    // --- 3. Livestream
    const liveOrder = !isEmptyish(conv.has_livestream_order);
    const liveType = LIVE_HINTS.some(h => convType.indexOf(h) >= 0) || typesList.some(t => LIVE_HINTS.some(h => t.indexOf(h) >= 0));
    if (liveOrder || liveType) {
      if (!source) { source = 'live'; confidence = 'mid'; }
      evidence.push(liveOrder ? 'has_livestream_order có giá trị' : 'type = ' + convType + ' → live');
    }

    // --- 4. Tag
    const namedTags = [];
    (conv.tags || []).forEach(tid => {
      const info = CFG.tagMap[String(tid)];
      if (!info) return;
      if (info.name && info.name !== '(chưa rõ)') namedTags.push(info.name + ' #' + tid);
      if (info.source && SOURCE_LABEL[info.source]) {
        if (!source) { source = info.source; confidence = 'mid'; }
        else if (info.source === source) { confidence = 'high'; }
        evidence.push('tag #' + tid + ' = ' + (info.name || '?') + ' → nguồn ' + SOURCE_LABEL[info.source]);
      }
    });
    if (namedTags.length) evidence.push('tags: ' + namedTags.join(', '));
    else if ((conv.tags || []).length) evidence.push('tags chưa map tên: ' + conv.tags.map(t => '#' + t).join(', '));

    // --- 5. Mặc định
    if (!source) {
      if (convType === '' || convType === 'INBOX') {
        source = 'organic'; confidence = 'low';
        evidence.push('type = INBOX, không có dấu hiệu ads / post / live');
      } else {
        source = 'unknown'; confidence = 'low';
        evidence.push('type = ' + convType + ' (chưa nhận diện được)');
      }
    }
    return { source: source, confidence: confidence, evidence: evidence };
  }

  function parseDate(v) {
    if (!v) return null;
    const d = new Date(String(v).replace('Z', '+00:00'));
    return isNaN(d.getTime()) ? null : d;
  }

  function buildLead(conv, msgs, now) {
    const c = classify(conv, msgs);
    const cust = (conv.customers && conv.customers[0]) || {};
    const from = conv.from || {};
    const name = cust.name || from.name || '(không tên)';
    const psid = conv.from_psid || cust.fb_id || from.id || '';
    const phones = (conv.recent_phone_numbers || []).filter(p => typeof p === 'string' || typeof p === 'number');
    const updated = parseDate(conv.updated_at);
    const lastCust = parseDate(conv.last_customer_interactive_at);
    const snippet = conv.snippet || '';
    const unread = Number(conv.unread_count || 0) || 0;
    const nMsgs = Number(conv.message_count || 0) || 0;
    const w = CFG.weights;
    let score = 0;
    const reasons = [];

    if (unread > 0) { score += w.unread; reasons.push('chưa đọc ' + unread + ' tin +' + w.unread); }
    const ref = lastCust || updated;
    if (ref) {
      const ageH = (now - ref.getTime()) / 3600000;
      if (ageH <= 24) { score += w.recent_24h; reasons.push('tương tác < 24h +' + w.recent_24h); }
      else if (ageH <= 72) { score += w.recent_3d; reasons.push('tương tác < 3 ngày +' + w.recent_3d); }
    }
    if (conv.has_phone || phones.length) { score += w.has_phone; reasons.push('có SĐT +' + w.has_phone); }
    if (nMsgs >= 3) { score += w.many_msgs; reasons.push(nMsgs + ' tin nhắn +' + w.many_msgs); }
    const norm = stripAccents(snippet);
    const hits = CFG.intent.filter(k => {
      const kk = stripAccents(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + kk + '([^a-z0-9]|$)').test(norm);
    });
    if (hits.length) { score += w.intent; reasons.push('ý định mua: ' + hits.slice(0, 3).join(', ') + ' +' + w.intent); }
    if (c.source === 'ads') { score += w.source_ads; reasons.push('từ quảng cáo +' + w.source_ads); }
    else if (c.source === 'post') { score += w.source_post; reasons.push('từ bài viết +' + w.source_post); }
    score = Math.max(0, Math.min(100, score));

    const prioKey = score >= CFG.thresholds.hot ? 'hot' : (score >= CFG.thresholds.warm ? 'warm' : 'cold');

    return {
      id: conv.id || '',
      name: name,
      psid: String(psid || ''),
      phone: phones.length ? String(phones[0]) : '',
      pageId: String(conv.page_id || ''),
      pageName: (conv.last_sent_by && conv.last_sent_by.name) || '',
      source: c.source,
      sourceLabel: SOURCE_LABEL[c.source],
      confidence: c.confidence,
      evidence: c.evidence,
      tags: conv.tags || [],
      snippet: snippet,
      messageCount: nMsgs,
      unread: unread,
      score: score,
      prio: prioKey === 'hot' ? 'CHỐT NGAY' : (prioKey === 'warm' ? 'Ưu tiên' : 'Theo dõi'),
      prioKey: prioKey,
      updatedAt: updated ? updated.toISOString() : '',
      lastCustomerAt: lastCust ? lastCust.toISOString() : '',
      reasons: reasons,
      enriched: !!(msgs && msgs.length),
    };
  }

  // Cổng cho test tự động (node require file này)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classify: classify, buildLead: buildLead, stripAccents: stripAccents, CFG: CFG };
    return;
  }
  if (typeof document === 'undefined') return;

  // ======================================================================
  // 3. BẮT DỮ LIỆU: hook fetch + XHR của app
  // ======================================================================
  const state = {
    convs: new Map(),          // id -> conversation
    msgs: new Map(),           // id -> [message]
    firstSeen: new Map(),      // id -> ts (để biết khách "mới")
    listReq: null,             // {url, init} của request danh sách gần nhất
    msgUrlTpl: null,           // mẫu URL .../conversations/<id>/messages
    lastSync: 0,
    errors: [],
  };
  const CONV_LIST_RE = /\/api\/v1\/conversations(\?|$)/;
  const CONV_MSGS_RE = /\/api\/v1\/conversations\/([^/?#]+)\/messages/;

  function noteError(msg) {
    state.errors.push({ at: Date.now(), msg: String(msg).slice(0, 200) });
    if (state.errors.length > 6) state.errors.shift();
    scheduleRepaint();
  }

  function ingestList(url, init, json) {
    const list = json && json.conversations;
    if (!Array.isArray(list)) return;
    if (url) state.listReq = { url: url, init: init || null };
    const nowTs = Date.now();
    list.forEach(c => {
      if (!c || !c.id) return;
      if (!state.firstSeen.has(c.id)) state.firstSeen.set(c.id, nowTs);
      state.convs.set(c.id, c);
    });
    if (state.firstSeen.size > 800) {
      const keys = Array.from(state.firstSeen.keys()).slice(0, 300);
      keys.forEach(k => state.firstSeen.delete(k));
    }
    state.lastSync = nowTs;
    scheduleRepaint();
  }

  function ingestMessages(url, json) {
    const m = CONV_MSGS_RE.exec(url || '');
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    const list = (json && (json.messages || json.data)) || [];
    if (!Array.isArray(list)) return;
    state.msgs.set(id, list);
    if (!state.msgUrlTpl) state.msgUrlTpl = url;
    scheduleRepaint();
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      const p = _fetch.apply(this, arguments);
      try {
        if (CONV_LIST_RE.test(url) || CONV_MSGS_RE.test(url)) {
          p.then(res => {
            let clone;
            try { clone = res.clone(); } catch (e) { return; }
            clone.json().then(j => {
              if (CONV_MSGS_RE.test(url)) ingestMessages(url, j); else ingestList(url, init, j);
            }).catch(() => {});
          }).catch(() => {});
        }
      } catch (e) { /* không làm hỏng app */ }
      return p;
    };
  }

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lsUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const url = xhr.__lsUrl || '';
    if (CONV_LIST_RE.test(url) || CONV_MSGS_RE.test(url)) {
      xhr.addEventListener('load', function () {
        try {
          const j = JSON.parse(xhr.responseText);
          if (CONV_MSGS_RE.test(url)) ingestMessages(url, j);
          else ingestList(url, { method: 'POST', body: body }, j);
        } catch (e) { /* ignore */ }
      });
    }
    return _send.apply(this, arguments);
  };

  // ======================================================================
  // 4. TỰ POLL (để hội thoại mới hiện ra là có nhãn ngay, không cần F5)
  // ======================================================================
  function replayList() {
    const req = state.listReq;
    if (!req) return;
    let init;
    if (req.init && req.init.body) {
      init = { method: req.init.method || 'POST', headers: req.init.headers || {}, body: req.init.body, credentials: 'include' };
    } else {
      const fd = new FormData();
      fd.append('type', 'ALL,UNREAD');
      init = { method: 'POST', body: fd, credentials: 'include' };
    }
    fetch(req.url, init)
      .then(r => r.json())
      .then(j => ingestList(req.url, req.init, j))
      .catch(err => noteError('poll: ' + err.message));
  }

  let enrichQueue = [];
  function enrich(convId) {
    if (!convId || state.msgs.has(convId)) return;
    let url;
    if (state.msgUrlTpl) {
      url = state.msgUrlTpl.replace(/\/conversations\/[^/?#]+\/messages/, '/conversations/' + encodeURIComponent(convId) + '/messages');
    } else {
      url = '/api/v1/conversations/' + encodeURIComponent(convId) + '/messages?page_number=1&limit=20';
    }
    fetch(url, { credentials: 'include' })
      .then(r => r.json())
      .then(j => ingestMessages(url, j))
      .catch(err => noteError('enrich: ' + err.message));
  }

  function processEnrich() {
    if (!CFG.autoEnrich) return;
    const now = Date.now();
    const pending = Array.from(state.convs.values())
      .filter(c => !state.msgs.has(c.id))
      .sort((a, b) => (now - (state.firstSeen.get(b.id) || 0)) - (now - (state.firstSeen.get(a.id) || 0)));
    const pick = pending.slice(0, CFG.enrichLimit);
    pick.forEach((c, i) => setTimeout(() => enrich(c.id), i * 900));
  }

  function tick() {
    if (document.hidden) return;
    if (CFG.pollMs > 0) replayList();
    processEnrich();
  }
  setTimeout(tick, 1500);
  setInterval(tick, Math.max(5000, CFG.pollMs || 20000));

  // ======================================================================
  // 5. GIAO DIỆN: bảng nổi + nhãn trên từng dòng
  // ======================================================================
  let host = null;
  let shadow = null;
  let repaintTimer = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .wrap { width: 372px; max-height: 74vh; display: flex; flex-direction: column;
            background: #fff; border: 1px solid #e6e9f0; border-radius: 14px; overflow: hidden;
            box-shadow: 0 12px 40px rgba(17,24,39,.18); font-size: 13px; color: #111827; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eef0f5;
          background: linear-gradient(180deg,#fbfcff,#f4f6fb); cursor: default; }
    .hd .t { font-weight: 650; font-size: 13px; letter-spacing: -.1px; }
    .hd .dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px #dcfce7; }
    .hd .grow { flex: 1; }
    .btn { border: 1px solid #e6e9f0; background: #fff; border-radius: 8px; padding: 3px 8px; font-size: 12px;
           cursor: pointer; color: #374151; }
    .btn:hover { background: #f3f4f6; }
    .counts { display: flex; gap: 6px; padding: 8px 12px; flex-wrap: wrap; border-bottom: 1px solid #f2f4f8; }
    .cnt { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: #374151;
           background: #f6f7fb; border: 1px solid #eceff5; border-radius: 999px; padding: 2px 8px; }
    .cnt b { font-weight: 700; }
    .cnt i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .list { overflow-y: auto; padding: 6px; }
    .item { display: flex; gap: 8px; padding: 8px; border-radius: 10px; cursor: pointer; align-items: flex-start; }
    .item:hover { background: #f7f8fd; }
    .score { min-width: 34px; text-align: center; font-weight: 700; font-size: 15px; line-height: 1.15; }
    .score small { display: block; font-size: 9px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; }
    .hot { color: #dc2626; } .warm { color: #d97706; } .cold { color: #6b7280; }
    .mid { flex: 1; min-width: 0; }
    .row1 { display: flex; align-items: center; gap: 6px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; color: #fff; border-radius: 999px;
             padding: 1px 7px; font-size: 10.5px; font-weight: 700; white-space: nowrap; }
    .nm { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sn { color: #6b7280; font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .meta { color: #9ca3af; font-size: 11px; margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
    .acts { display: flex; gap: 4px; }
    .icon { border: none; background: transparent; cursor: pointer; font-size: 13px; padding: 2px 3px; border-radius: 6px; opacity: .55; }
    .icon:hover { opacity: 1; background: #eef1f7; }
    .ft { padding: 7px 12px; border-top: 1px solid #eef0f5; color: #9ca3af; font-size: 11px;
          display: flex; justify-content: space-between; gap: 8px; }
    .empty { padding: 18px 14px; color: #6b7280; font-size: 12.5px; line-height: 1.6; }
    .collapsed .list, .collapsed .counts, .collapsed .ft { display: none; }
    .err { color: #b91c1c; }
  `;

  function ensureHost() {
    if (host && document.contains(host)) return;
    host = document.createElement('div');
    host.id = '__lead_source_host';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.id = 'wrap';
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    wrap.addEventListener('click', onPanelClick);
  }

  function leads(now) {
    const out = [];
    state.convs.forEach(c => out.push(buildLead(c, state.msgs.get(c.id) || [], now)));
    return out.sort((a, b) => b.score - a.score);
  }

  function hhmm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 1) return 'vừa xong';
    if (diff < 60) return Math.round(diff) + ' phút';
    if (diff < 1440) return Math.round(diff / 60) + ' giờ';
    return Math.round(diff / 1440) + ' ngày';
  }

  // CSS.escape có thể không tồn tại (trình duyệt cũ / môi trường test)
  function cssEscape(v) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function paint() {
    if (!CFG.showPanel) { if (host) host.style.display = 'none'; return; }
    ensureHost();
    host.style.display = '';
    const wrap = shadow.getElementById('wrap');
    if (!wrap) return;
    const now = Date.now();
    const all = leads(now);
    const counts = { ads: 0, post: 0, live: 0, organic: 0, unknown: 0 };
    all.forEach(r => { counts[r.source] = (counts[r.source] || 0) + 1; });
    const hot = all.filter(r => r.prioKey === 'hot').length;
    const list = all.slice(0, CFG.topN);

    const wasCollapsed = wrap.classList.contains('collapsed');
    const prevList = shadow.querySelector('.list');
    const scrollTop = prevList ? prevList.scrollTop : 0;
    wrap.innerHTML =
      '<div class="hd"><span class="dot"></span><span class="t">Tệp khách</span>' +
      '<span class="grow"></span>' +
      '<span class="cnt"><b>' + all.length + '</b></span>' +
      '<button class="btn" data-act="collapse">' + (wasCollapsed ? '▾' : '▴') + '</button></div>' +
      '<div class="counts">' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.ads + '"></i>Quảng cáo <b>' + counts.ads + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.post + '"></i>Bài viết <b>' + counts.post + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.live + '"></i>Live <b>' + counts.live + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.organic + '"></i>Tự nhắn <b>' + counts.organic + '</b></span>' +
      '<span class="cnt"><i style="background:#dc2626"></i>Chốt ngay <b>' + hot + '</b></span>' +
      '</div>' +
      (list.length ? '<div class="list">' + list.map(r => itemHtml(r, state.msgs.has(r.id))).join('') + '</div>'
        : '<div class="empty">Chưa bắt được danh sách hội thoại.<br>Mở trang <b>Hội thoại / multi_pages</b> của Pancake, ' +
          'script sẽ tự đọc dữ liệu và gắn nhãn (không cần mở từng đoạn chat).</div>') +
      '<div class="ft"><span>' + (state.lastSync ? 'đồng bộ ' + hhmm(new Date(state.lastSync).toISOString()) + ' trước' : 'chưa đồng bộ') + '</span>' +
      '<span class="' + (state.errors.length ? 'err' : '') + '">' + (state.errors.length ? state.errors[state.errors.length - 1].msg : 'poll ' + (CFG.pollMs / 1000) + 's') + '</span></div>';
    if (wasCollapsed) wrap.classList.add('collapsed');
    const newList = shadow.querySelector('.list');
    if (newList && scrollTop) newList.scrollTop = scrollTop;
  }

  function itemHtml(r, fetched) {
    const cl = r.prioKey;
    const color = SOURCE_COLOR[r.source];
    const conf = r.confidence === 'high' ? '' : ' · tin cậy ' + CONF_LABEL[r.confidence];
    const tip = esc(r.evidence.join('\n') + (r.reasons.length ? '\n\n' + r.reasons.join('\n') : ''));
    return '<div class="item" data-id="' + esc(r.id) + '" data-act="focus" title="' + tip + '">' +
      '<div class="score ' + cl + '">' + r.score + '<small>' + (r.prioKey === 'hot' ? 'CHỐT' : (r.prioKey === 'warm' ? 'ưu tiên' : 'theo dõi')) + '</small></div>' +
      '<div class="mid">' +
      '<div class="row1"><span class="badge" style="background:' + color + '">' + SOURCE_SHORT[r.source] + '</span>' +
      '<span class="nm">' + esc(r.name) + '</span></div>' +
      '<div class="sn">' + esc(r.snippet) + '</div>' +
      '<div class="meta"><span>' + esc(r.pageName || '') + '</span><span>' + hhmm(r.updatedAt) + '</span>' +
      (r.unread > 0 ? '<span style="color:#dc2626;font-weight:600">' + r.unread + ' chưa đọc</span>' : '') +
      (r.phone ? '<span>' + esc(r.phone) + '</span>' : '') +
      '<span>' + esc(SOURCE_LABEL[r.source]) + conf + '</span></div>' +
      '</div>' +
      '<div class="acts">' +
      '<button class="icon" data-act="focus" data-id="' + esc(r.id) + '" title="Tìm trong danh sách">🔍</button>' +
      '<button class="icon" data-act="copy" data-id="' + esc(r.id) + '" title="Copy thông tin khách">📋</button>' +
      (fetched ? '' : '<button class="icon" data-act="enrich" data-id="' + esc(r.id) + '" title="Xem tin nhắn để phân loại chính xác hơn">↻</button>') +
      '</div></div>';
  }

  function onPanelClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id');
    if (act === 'collapse') {
      const wrap = shadow.getElementById('wrap');
      wrap.classList.toggle('collapsed');
      btn.textContent = wrap.classList.contains('collapsed') ? '▾' : '▴';
      return;
    }
    if (!id) return;
    const conv = state.convs.get(id);
    if (act === 'copy') {
      const lead = buildLead(conv, state.msgs.get(id) || [], Date.now());
      const text = lead.name + ' | psid ' + lead.psid + ' | ' + lead.sourceLabel + ' | ' + lead.score + ' điểm | ' +
        lead.snippet.replace(/\n/g, ' ');
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1200);
      });
      return;
    }
    if (act === 'enrich') { enrich(id); btn.style.opacity = '.3'; return; }
    if (act === 'focus') focusInList(conv);
  }

  // ---------- gắn nhãn vào danh sách hội thoại của Pancake ----------
  const chips = new Map(); // convId -> element

  // Quét DOM 1 lần cho tất cả khách (thay vì mỗi khách quét lại toàn trang)
  function buildNameIndex() {
    const index = new Map();
    const nodes = document.querySelectorAll('span,div,a,p,b,strong,h4');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.childElementCount) continue;
      if (el.classList && el.classList.contains('__ls_chip')) continue;
      if (el.offsetParent === null) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 48) continue;
      if (!index.has(t)) index.set(t, el);
    }
    return index;
  }

  let nameIndex = null;
  function findNameNode(name) {
    if (!name) return null;
    if (!nameIndex) nameIndex = buildNameIndex();
    return nameIndex.get(name) || null;
  }

  function findRowEl(node) {
    let el = node;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const r = el.getBoundingClientRect();
      let cur = '';
      try { cur = getComputedStyle(el).cursor; } catch (e) { /* ignore */ }
      const cls = String(el.className || '');
      if (r.height >= 34 && (cur === 'pointer' || el.getAttribute('role') === 'button' ||
        /(^|[-_ ])(row|item|conversation|thread|conv)/i.test(cls))) return el;
      el = el.parentElement;
    }
    return node.parentElement;
  }

  function makeChip(lead) {
    const chip = document.createElement('span');
    chip.className = '__ls_chip';
    chip.dataset.lsId = lead.id;
    chip.textContent = SOURCE_SHORT[lead.source] + ' ' + lead.score;
    chip.title = SOURCE_LABEL[lead.source] + ' · ' + lead.score + ' điểm\n' +
      lead.evidence.join('\n') + (lead.reasons.length ? '\n\n' + lead.reasons.join('\n') : '');
    chip.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'background:' + SOURCE_COLOR[lead.source] + ';color:#fff;border-radius:999px;padding:0 6px;' +
      'font-size:10px;font-weight:700;line-height:16px;height:16px;margin-left:6px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;vertical-align:middle;' +
      'cursor:default;flex:0 0 auto;';
    return chip;
  }

  let lastDecorate = 0;

  function decorate() {
    if (!CFG.showChips || document.hidden) return;
    const now = Date.now();
    if (now - lastDecorate < 600) return;
    lastDecorate = now;
    nameIndex = null; // dựng lại index mỗi lượt
    state.convs.forEach(conv => {
      const lead = buildLead(conv, state.msgs.get(conv.id) || [], now);
      const existing = chips.get(conv.id);
      if (existing && document.contains(existing)) {
        if (existing.textContent !== SOURCE_SHORT[lead.source] + ' ' + lead.score) {
          existing.textContent = SOURCE_SHORT[lead.source] + ' ' + lead.score;
          existing.style.background = SOURCE_COLOR[lead.source];
        }
        return;
      }
      if (document.querySelector('.__ls_chip[data-ls-id="' + cssEscape(conv.id) + '"]')) return;
      const nameNode = findNameNode(lead.name);
      if (!nameNode) return;
      const chip = makeChip(lead);
      nameNode.insertAdjacentElement('afterend', chip);
      chips.set(conv.id, chip);
    });
  }

  function focusInList(conv) {
    if (!conv) return;
    const lead = buildLead(conv, state.msgs.get(conv.id) || [], Date.now());
    const chip = document.querySelector('.__ls_chip[data-ls-id="' + cssEscape(conv.id) + '"]');
    const target = chip || findNameNode(lead.name);
    if (!target) { LOG('Không thấy dòng của', lead.name, '— thử cuộn danh sách hoặc bấm lọc theo nguồn.'); return; }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const row = findRowEl(target);
    const old = row.style.boxShadow;
    row.style.boxShadow = '0 0 0 2px #7c3aed inset';
    setTimeout(() => { row.style.boxShadow = old; }, 1400);
  }

  function scheduleRepaint() {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      try { paint(); } catch (e) { LOG('paint lỗi', e); }
      try { decorate(); } catch (e) { LOG('decorate lỗi', e); }
    }, 250);
  }

  // re-render khi React vẽ lại danh sách
  const mo = new MutationObserver(() => scheduleRepaint());
  function startObserver() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();

  // ======================================================================
  // 6. API console để debug
  // ======================================================================
  window.__leadSource = {
    cfg: CFG,
    state: state,
    get leads() { return leads(Date.now()); },
    refresh: tick,
    reload: () => { state.convs.clear(); tick(); },
    classify: classify,
    buildLead: buildLead,
    /** đổi cấu hình: __leadSource.set({tagMap:{'83':{name:'Từ quảng cáo',source:'ads'}}}) */
    set: function (patch) {
      Object.assign(CFG, patch);
      localStorage.setItem('leadSource.cfg', JSON.stringify(CFG));
      scheduleRepaint();
      return CFG;
    },
    help: function () {
      LOG('Ví dụ map tag:\n  __leadSource.set({tagMap: {"83": {name:"Từ quảng cáo", source:"ads"}}})' +
        '\nĐổi chu kỳ poll:  __leadSource.set({pollMs: 10000})' +
        '\nXem dữ liệu thô: __leadSource.state.convs');
    },
  };

  LOG('đã bật. Gõ __leadSource.help() để xem cách cấu hình.');
})();

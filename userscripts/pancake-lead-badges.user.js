// ==UserScript==
// @name         Pancake - Phân loại tệp khách theo nguồn
// @namespace    https://github.com/chongoan4444/TEST1
// @version      3.1.0
// @description  Gắn nhãn Quảng cáo / Bài viết / Livestream / Tự nhắn + điểm ưu tiên cho các hội thoại ĐANG HIỂN THỊ trên Pancake. Alt+O bật/tắt. Tự dò lại DOM khi Pancake đổi giao diện.
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
  // 1. CẤU HÌNH
  //    __leadSource.set({...})  |  Alt+O ẩn/hiện  |  __leadSource.help()
  // ======================================================================
  const DEFAULTS = {
    enabled: true,          // BẬT/TẮT toàn bộ (Alt+O hoặc nút ✕) — dữ liệu vẫn được cập nhật ngầm
    showPanel: true,        // riêng bảng nổi (nút ▭) — nhãn trên dòng chat vẫn chạy
    showChips: true,
    showLegend: true,
    pollMs: 25000,          // gọi lại danh sách hội thoại
    scanMs: 1500,           // quét dự phòng các dòng ĐANG HIỂN THỊ
    enrichVisible: true,    // chỉ xem tin nhắn của hội thoại đang hiển thị (để nhận ra quảng cáo)
    enrichLimit: 4,         // tối đa N hội thoại mỗi lượt
    enrichSpacing: 700,     // ms giữa 2 request
    enrichTTL: 600000,      // không hỏi lại hội thoại đã hỏi trong 10 phút
    topN: 12,
    // đổi selector khi Pancake đổi giao diện: __leadSource.set({selRow:'.abc'})
    selList: '', selRow: '', selName: '', selSnippet: '', selTag: '',
    tagMap: {},             // {'83': {name:'Từ quảng cáo', source:'ads'}}  (tag id từ API)
    tagNameSource: {},      // {'QC': 'ads', 'live': 'live'}  (tên tag hiện trên dòng chat)
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
    } catch (e) { /* cfg hỏng -> mặc định */ }
    return out;
  })();

  const SOURCE_LABEL = { ads: 'Quảng cáo', post: 'Bài viết', live: 'Livestream', organic: 'Tự nhắn', unknown: 'Chưa rõ' };
  const SOURCE_SHORT = { ads: 'QC', post: 'BV', live: 'LV', organic: 'TN', unknown: '?' };
  const SOURCE_COLOR = { ads: '#7c3aed', post: '#0ea5e9', live: '#e11d48', organic: '#059669', unknown: '#6b7280' };
  const CONF_LABEL = { high: 'cao', mid: 'trung bình', low: 'thấp' };
  const PRIO_LABEL = { hot: 'CHỐT NGAY', warm: 'Ưu tiên', cold: 'Theo dõi' };

  // Tín hiệu QUẢNG CÁO thật của Pancake: message.attachments[].type = "ad_click" + ad_id
  const AD_KEYS = ['ad_id', 'ad_ids', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'ad_name',
    'ad_name_id', 'ads_context_data', 'referral', 'ad_referral', 'is_ad', 'from_ad', 'adgroup_id',
    'source_ad_id', 'click_from'];
  const AD_TYPE_VALUES = ['ad_click', 'ad_referral', 'ad'];
  const POST_KEYS = ['post_id', 'post', 'comment_id', 'post_permalink'];
  const LIVE_KEYS = ['has_livestream_order', 'is_livestream_order', 'live_video_id'];
  const COMMENT_HINTS = ['COMMENT', 'REPLY', 'POST_COMMENT'];

  const LOG = (...a) => console.log('%c[lead-source]', 'color:#7c3aed;font-weight:600', ...a);

  // ======================================================================
  // 2. PHÂN LOẠI
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
        try { deepFind(JSON.parse(v), keySet, p, out, depth + 1); } catch (e) { /* ignore */ }
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

    // ---- 1. Quảng cáo: attachments[].ad_id / type = ad_click
    let adHits = [];
    const blobs = [['extra_info', conv.extra_info], ['messages', msgs]];
    blobs.forEach(([name, blob]) => {
      if (!blob) return;
      deepFind(blob, AD_KEYS).forEach(hit => {
        if (isEmptyish(hit.value)) return;
        adHits.push(name + '.' + hit.path + ' = ' + jsonify(hit.value));
      });
    });
    msgs.forEach((m, i) => {
      (m && m.attachments || []).forEach((a, j) => {
        if (a && typeof a === 'object' && AD_TYPE_VALUES.indexOf(String(a.type || '').toLowerCase()) >= 0) {
          adHits.push('messages[' + i + '].attachments[' + j + '].type = ' + a.type);
        }
      });
    });
    adHits = adHits.filter((h, i) => !adHits.some((o, j) => j !== i && o.split(' = ')[0].indexOf(h.split(' = ')[0] + '.') === 0));
    if (adHits.length) {
      source = 'ads'; confidence = 'high';
      evidence.push.apply(evidence, adHits.slice(0, 4));
    }

    // ---- 2. Comment bài viết
    const postHits = [];
    deepFind({ extra_info: conv.extra_info, conv: { post_id: conv.post_id, post: conv.post } }, POST_KEYS)
      .forEach(hit => { if (!isEmptyish(hit.value)) postHits.push(hit.path + ' = ' + jsonify(hit.value)); });
    const isCommentType = COMMENT_HINTS.some(h => convType.indexOf(h) >= 0) ||
      typesList.some(t => COMMENT_HINTS.some(h => t.indexOf(h) >= 0));
    if (postHits.length || isCommentType) {
      if (!source) { source = 'post'; confidence = postHits.length ? 'high' : 'mid'; }
      else evidence.push('(đồng thời có dấu hiệu comment)');
      evidence.push.apply(evidence, postHits.slice(0, 3));
      if (isCommentType) evidence.push('type = ' + (convType || typesList.join('/')) + ' → comment');
    }

    // ---- 3. Livestream
    const liveHits = deepFind({ conv: conv, messages: msgs }, LIVE_KEYS).filter(h => !isEmptyish(h.value));
    const liveType = typesList.some(t => t.indexOf('LIVE') >= 0) || convType.indexOf('LIVE') >= 0;
    if (liveHits.length || liveType) {
      if (!source) { source = 'live'; confidence = 'mid'; }
      if (liveHits.length) evidence.push(liveHits[0].path + ' = ' + jsonify(liveHits[0].value));
    }

    // ---- 4. Tag: id (từ API) và tên (đọc từ dòng chat)
    const namedTags = [];
    (conv.tags || []).forEach(tid => {
      const info = CFG.tagMap[String(tid)];
      if (!info) return;
      if (info.name && info.name !== '(chưa rõ)') namedTags.push(info.name + ' #' + tid);
      if (info.source && SOURCE_LABEL[info.source]) {
        if (!source) { source = info.source; confidence = 'mid'; }
        else if (info.source === source) { confidence = 'high'; }
        evidence.push('tag #' + tid + ' = ' + (info.name || '?') + ' → ' + SOURCE_LABEL[info.source]);
      }
    });
    (conv.domTags || []).forEach(rawName => {
      const key = stripAccents(rawName);
      let hit = null;
      Object.keys(CFG.tagNameSource || {}).forEach(k => {
        if (hit) return;
        if (stripAccents(k) === key) hit = CFG.tagNameSource[k];
      });
      if (!hit || !SOURCE_LABEL[hit]) return;
      if (!source) { source = hit; confidence = 'mid'; }
      else if (hit === source) { confidence = 'high'; }
      evidence.push('tag trên dòng chat: "' + rawName + '" → ' + SOURCE_LABEL[hit]);
    });
    if (namedTags.length) evidence.push('tags: ' + namedTags.join(', '));

    // ---- 5. Mặc định
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
      psid: String(conv.from_psid || cust.fb_id || '' || ''),
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
      prio: PRIO_LABEL[prioKey],
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
  // 3. BẮT DỮ LIỆU (fetch + XHR)
  //    - danh sách: POST /api/v1/conversations
  //                 GET  /api/v1/pages/<page>/conversations
  //    - tin nhắn:  GET  /api/v1/pages/<page>/conversations/<id>/messages
  // ======================================================================
  const VERSION = '3.1.0';
  const RE_MESSAGES_URL = /\/conversations\/([^/?#]+)\/messages(\?|$)/;
  const RE_API = /\/api\/v1\//;
  const BOOT_AT = Date.now();

  const state = {
    convs: new Map(),
    msgs: new Map(),
    firstSeen: new Map(),
    listReqs: [],          // [{url, init, at}] tối đa 3
    msgUrlTpl: null,
    lastSync: 0,
    version: 0,
    enriching: new Set(),
    enrichTried: new Map(),
    errors: [],
  };

  function noteError(msg) {
    state.errors.push({ at: Date.now(), msg: String(msg).slice(0, 160) });
    if (state.errors.length > 5) state.errors.shift();
    schedulePaint();
  }

  /** Có nên đọc response này không (không phụ thuộc đúng URL của Pancake). */
  function shouldSniff(url) {
    if (!url || !RE_API.test(url) || RE_MESSAGES_URL.test(url)) return true;
    if (/conversation|message|tag|label/i.test(url)) return true;
    return Date.now() - BOOT_AT < 30000;   // 30s đầu: đọc thử mọi API -> không bỏ lỡ endpoint mới
  }

  /** Đọc mọi response: nhận ra conversations hoặc messages bằng DẤU HIỆU DỮ LIỆU. */
  function maybeIngest(url, init, json) {
    if (!json || typeof json !== 'object') return;
    if (Array.isArray(json.conversations) && json.conversations.length) ingestList(url, init, json);

    const list = json.messages || json.data;
    if (!Array.isArray(list)) return;
    const m = RE_MESSAGES_URL.exec(url || '');
    if (m && (list.length === 0 || (list[0] && typeof list[0] === 'object'))) {
      ingestMessagesFor(decodeURIComponent(m[1]), list, url);
      return;
    }
    if (!list.length || !list[0] || !list[0].conversation_id) return;
    const byConv = {};
    list.forEach(x => {
      const cid = x && x.conversation_id;
      if (cid) (byConv[cid] = byConv[cid] || []).push(x);
    });
    Object.keys(byConv).forEach(cid => ingestMessagesFor(cid, byConv[cid], url));
  }

  function rememberListReq(url, init) {
    if (!url) return;
    const key = url.replace(/[?&](next_cursor|current_count)=[^&]*/g, '');
    const found = state.listReqs.filter(r => r.key === key);
    if (found.length) { found[0].at = Date.now(); found[0].url = url; found[0].init = init || found[0].init; }
    else state.listReqs.push({ key: key, url: url, init: init || null, at: Date.now() });
    state.listReqs = state.listReqs.slice(-3);
  }

  function ingestList(url, init, json) {
    const list = json && json.conversations;
    if (!Array.isArray(list)) return;
    rememberListReq(url, init);
    const ts = Date.now();
    list.forEach(c => {
      if (!c || !c.id) return;
      if (!state.firstSeen.has(c.id)) state.firstSeen.set(c.id, ts);
      state.convs.set(c.id, c);
    });
    // dọn bớt để không phình bộ nhớ
    if (state.convs.size > 2500) {
      const keys = Array.from(state.convs.keys()).slice(0, state.convs.size - 2000);
      keys.forEach(k => state.convs.delete(k));
    }
    if (state.msgs.size > 400) {
      Array.from(state.msgs.keys()).slice(0, state.msgs.size - 300).forEach(k => state.msgs.delete(k));
    }
    state.lastSync = ts;
    state.version++;
    scheduleDecor();
    schedulePaint();
  }

  function ingestMessagesFor(id, list, url) {
    if (!id || !Array.isArray(list)) return;
    state.msgs.set(id, list);
    if (url && !state.msgUrlTpl && RE_MESSAGES_URL.test(url)) state.msgUrlTpl = url;
    state.enriching.delete(id);
    state.version++;
    scheduleDecor();
    schedulePaint();
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      const p = _fetch.apply(this, arguments);
      try {
        if (shouldSniff(url)) {
          p.then(res => {
            let clone;
            try { clone = res.clone(); } catch (e) { return; }
            clone.json().then(j => maybeIngest(url, init, j)).catch(() => {});
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
    if (shouldSniff(url)) {
      xhr.addEventListener('load', function () {
        try {
          maybeIngest(url, { method: 'POST', body: body }, JSON.parse(xhr.responseText));
        } catch (e) { /* ignore */ }
      });
    }
    return _send.apply(this, arguments);
  };

  // ======================================================================
  // 4. POLL + ENRICH (chỉ cho hội thoại đang hiển thị)
  // ======================================================================
  function replayList() {
    const reqs = state.listReqs.filter(r => Date.now() - r.at < 10 * 60 * 1000).slice(-2);
    reqs.forEach(req => {
      let init;
      if (req.init && req.init.body) {
        init = { method: req.init.method || 'POST', headers: req.init.headers || {}, body: req.init.body, credentials: 'include' };
      } else {
        init = { method: 'GET', credentials: 'include' };
      }
      fetch(req.url, init)
        .then(r => r.json())
        .then(j => ingestList(req.url, req.init, j))
        .catch(err => noteError('poll: ' + err.message));
    });
  }

  function messagesUrl(conv) {
    const convId = conv.id || '';
    const pageId = conv.page_id || convId.split('_')[0] || '';
    const custId = (conv.customers && conv.customers[0] && conv.customers[0].id) || '';
    if (state.msgUrlTpl) {
      let url = state.msgUrlTpl.replace(/\/conversations\/[^/?#]+\/messages/, '/conversations/' + encodeURIComponent(convId) + '/messages');
      if (custId && /^[0-9a-f-]{30,}$/i.test(custId)) {
        url = url.replace(/customer_id=[^&]*/, 'customer_id=' + encodeURIComponent(custId));
      }
      return url;
    }
    const q = (custId && /^[0-9a-f-]{30,}$/i.test(custId)) ? '?customer_id=' + encodeURIComponent(custId) : '?';
    return '/api/v1/pages/' + encodeURIComponent(pageId) + '/conversations/' + encodeURIComponent(convId) + '/messages' + q;
  }

  function enrich(conv) {
    if (!conv || !conv.id) return;
    const id = conv.id;
    if (state.msgs.has(id) || state.enriching.has(id)) return;
    const last = state.enrichTried.get(id);
    if (last && Date.now() - last < CFG.enrichTTL) return;
    state.enriching.add(id);
    state.enrichTried.set(id, Date.now());
    const url = messagesUrl(conv);
    fetch(url, { credentials: 'include' })
      .then(r => r.json())
      .then(j => ingestMessages(url, j))
      .catch(err => { state.enriching.delete(id); noteError('enrich: ' + err.message); });
  }

  let enrichTimer = null;
  function queueEnrich(convs) {
    if (!CFG.enrichVisible || !convs.length) return;
    if (enrichTimer) return;
    const todo = convs.filter(c => c && c.id && !state.msgs.has(c.id) && !state.enriching.has(c.id)).slice(0, CFG.enrichLimit);
    if (!todo.length) return;
    enrichTimer = setTimeout(() => {
      enrichTimer = null;
      todo.forEach((c, i) => setTimeout(() => enrich(c), i * CFG.enrichSpacing));
    }, 250);
  }

  function tick() {
    if (document.hidden) return;
    if (CFG.pollMs > 0) replayList();
  }

  // ======================================================================
  // 5. ĐỌC DOM THẬT CỦA PANCAKE
  //    .conversation-list > .conversation-list-item#<page>_<psid>__<n>
  //      .name-module > .name-module-text > .name-text
  //      .snippet-wrap > .snippet-line > .snippet-text
  //      .conversation_tags_item
  // ======================================================================
  const SEL_DEFAULTS = {
    list: '.conversation-list',
    row: '.conversation-list-item',
    name: '.name-text, .name-module-text, [class*="name-text"], [class*="conversation-name"]',
    snippet: '.snippet-text, [class*="snippet-text"]',
    tag: '.conversation_tags_item, [class*="tags_item"]',
  };

  function selList() { return CFG.selList || SEL_DEFAULTS.list; }
  function selRow() { return CFG.selRow || SEL_DEFAULTS.row; }
  function selName() { return CFG.selName || SEL_DEFAULTS.name; }
  function selSnippet() { return CFG.selSnippet || SEL_DEFAULTS.snippet; }
  function selTag() { return CFG.selTag || SEL_DEFAULTS.tag; }

  function safeQuery(sel, root) {
    try { return (root || document).querySelectorAll(sel); } catch (e) { return []; }
  }

  // chẩn đoán: đang khớp được bao nhiêu dòng bằng cách nào
  const dom = { mode: 'none', rows: 0, visible: 0, labeled: 0 };

  function listContainer() {
    const l = safeQuery(selList());
    return l.length ? l[0] : document.body;
  }

  function convIdOf(el) {
    const id = el && el.id;
    if (!id) return null;
    const m = /^(\d{5,}_\d{5,})(?:__\d+)?$/.exec(id);
    return m ? m[1] : null;
  }

  /** Tìm dòng hội thoại: selector chuẩn → con của list → quét id toàn trang. */
  function findRows() {
    let rows = safeQuery(selRow());
    if (rows.length) { dom.mode = 'selector'; return rows; }

    const cont = safeQuery(selList());
    if (cont.length) {
      const kids = cont[0].querySelectorAll('[id]');
      const good = [];
      for (let i = 0; i < kids.length; i++) if (convIdOf(kids[i])) good.push(kids[i]);
      if (good.length) { dom.mode = 'list-children'; return good; }
    }

    const all = document.querySelectorAll('[id]');
    const good = [];
    for (let i = 0; i < all.length && good.length < 400; i++) if (convIdOf(all[i])) good.push(all[i]);
    dom.mode = good.length ? 'id-scan' : 'none';
    return good;
  }

  /** Chỉ các dòng ĐANG HIỂN THỊ trong khung nhìn. */
  function visibleRows() {
    const rows = findRows();
    dom.rows = rows.length;
    if (!rows.length) { dom.visible = 0; return []; }

    let top = 0, bottom = window.innerHeight || 800;
    const cont = safeQuery(selList());
    if (cont.length) {
      let cr; try { cr = cont[0].getBoundingClientRect(); } catch (e) { cr = null; }
      if (cr && cr.height > 0) { top = cr.top; bottom = cr.bottom; }
    }

    const out = [];
    let zero = 0;
    for (let i = 0; i < rows.length; i++) {
      let r; try { r = rows[i].getBoundingClientRect(); } catch (e) { continue; }
      if (r.height <= 0) { zero++; continue; }
      if (r.bottom > top && r.top < bottom) out.push(rows[i]);
    }
    if (!out.length && zero === rows.length) {          // layout chưa kịp tính -> lấy 40 dòng đầu
      for (let i = 0; i < Math.min(rows.length, 40); i++) out.push(rows[i]);
    }
    dom.visible = out.length;
    return out;
  }

  /** Tên khách trong 1 dòng: selector → fallback lá đầu tiên có chữ. */
  function nameNode(row) {
    if (!row) return null;
    const n = safeQuery(selName(), row);
    if (n.length) return n[0];
    const leaves = row.querySelectorAll('span,div,b,strong,p,a');
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (el.childElementCount) continue;
      if (el.closest('.av, [class*="avatar"]')) continue;      // bỏ qua avatar
      const t = (el.textContent || '').trim();
      if (!t || t.length > 48) continue;
      if (/^\d{1,2}:\d{2}$/.test(t)) continue;                 // giờ
      if (!/[^\d\s]/.test(t)) continue;                        // số đếm chưa đọc
      return el;
    }
    return null;
  }

  function rowText(row, sel) {
    const n = safeQuery(sel, row);
    return n.length ? (n[0].textContent || '').trim() : '';
  }

  function convFromRow(row, convId) {
    const tags = [];
    safeQuery(selTag(), row).forEach(t => tags.push((t.textContent || '').trim()));
    const nn = nameNode(row);
    const name = rowText(row, selName()) || (nn ? nn.textContent.trim() : '');
    return {
      id: convId,
      page_id: convId.split('_')[0],
      type: '',
      snippet: rowText(row, selSnippet()),
      tags: [],
      domTags: tags,
      customers: [{ fb_id: convId.split('_')[1] || '', id: '', name: name }],
      from: { name: name },
      from_psid: convId.split('_')[1] || '',
      message_count: 0,
      unread_count: row.classList.contains('unread') ? 1 : 0,
      updated_at: '',
      last_customer_interactive_at: '',
      has_phone: false,
      recent_phone_numbers: [],
      _fromDom: true,
    };
  }

  // ======================================================================
  // 6. GẮN NHÃN
  // ======================================================================
  const chips = new Map();
  let decorTimer = null;
  let lastDecor = 0;

  function chipText(lead, pending) {
    const base = SOURCE_SHORT[lead.source] + ' ' + lead.score;
    return (lead.prioKey === 'hot' ? '🔥 ' : '') + base + (pending ? '…' : '');
  }

  function chipTitle(lead, pending) {
    return SOURCE_LABEL[lead.source] + ' · ' + lead.score + ' điểm · ' + lead.prio + ' · tin cậy ' + CONF_LABEL[lead.confidence] +
      (pending ? '\n(đang xem tin nhắn để chắc chắn hơn)' : '') +
      (lead.evidence.length ? '\n\nBằng chứng:\n• ' + lead.evidence.join('\n• ') : '') +
      (lead.reasons.length ? '\n\nĐiểm:\n• ' + lead.reasons.join('\n• ') : '') +
      '\n\n(Alt+O để ẩn/hiện)';
  }

  function makeChip(lead, pending) {
    const chip = document.createElement('span');
    chip.className = '__ls_chip';
    chip.dataset.lsId = lead.id;
    chip.dataset.lsSource = lead.source;
    chip.textContent = chipText(lead, pending);
    chip.title = chipTitle(lead, pending);
    chip.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'background:' + SOURCE_COLOR[lead.source] + ';color:#fff;border-radius:999px;padding:0 5px;' +
      'font-size:9.5px;font-weight:700;line-height:15px;height:15px;margin-left:5px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;vertical-align:middle;' +
      'cursor:default;flex:0 0 auto;letter-spacing:.2px;white-space:nowrap;';
    return chip;
  }

  function updateChip(chip, lead, pending) {
    const t = chipText(lead, pending);
    if (chip.textContent !== t) chip.textContent = t;
    if (chip.dataset.lsSource !== lead.source) {
      chip.dataset.lsSource = lead.source;
      chip.style.background = SOURCE_COLOR[lead.source];
    }
    const title = chipTitle(lead, pending);
    if (chip.title !== title) chip.title = title;
  }

  function decorate() {
    if (!CFG.enabled || !CFG.showChips || document.hidden) return;
    const rows = visibleRows();
    dom.labeled = 0;
    if (!rows.length) { schedulePaint(); return; }
    const now = Date.now();
    const needEnrich = [];

    rows.forEach(row => {
      const convId = convIdOf(row);
      if (!convId) return;
      let conv = state.convs.get(convId);
      if (!conv) conv = convFromRow(row, convId);
      else if (row.classList.contains('unread') && !conv.unread_count) conv = Object.assign({}, conv, { unread_count: 1 });

      const msgs = state.msgs.get(convId);
      const lead = buildLead(conv, msgs || [], now);
      const pending = !msgs && conv.type !== 'COMMENT' && !conv._fromDom;
      if (pending && conv.type !== 'COMMENT') needEnrich.push(conv);

      let chip = chips.get(convId);
      if (chip && chip.parentElement && row.contains(chip)) { updateChip(chip, lead, pending); dom.labeled++; return; }
      if (chip) chips.delete(convId);
      chip = row.querySelector('.__ls_chip');
      if (chip) { chips.set(convId, chip); updateChip(chip, lead, pending); dom.labeled++; return; }

      const nameEl = nameNode(row);
      if (!nameEl) return;
      const c = makeChip(lead, pending);
      try { nameEl.insertAdjacentElement('afterend', c); } catch (e) { return; }
      chips.set(convId, c);
      dom.labeled++;
    });

    queueEnrich(needEnrich);
  }

  function scheduleDecor(force) {
    if (decorTimer) return;
    const wait = force ? 0 : Math.max(60, 400 - (Date.now() - lastDecor));
    decorTimer = setTimeout(() => {
      decorTimer = null;
      lastDecor = Date.now();
      try { decorate(); } catch (e) { LOG('decorate lỗi', e); }
    }, wait);
  }

  function clearChips() {
    document.querySelectorAll('.__ls_chip').forEach(el => el.remove());
    chips.clear();
  }

  // ======================================================================
  // 7. BẢNG NỔI
  // ======================================================================
  let host = null, shadow = null, fab = null;
  let paintTimer = null, paintSig = '';

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .wrap { width: 372px; max-height: 74vh; display: flex; flex-direction: column;
            background: #fff; border: 1px solid #e6e9f0; border-radius: 14px; overflow: hidden;
            box-shadow: 0 12px 40px rgba(17,24,39,.16); font-size: 13px; color: #111827; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eef0f5;
          background: linear-gradient(180deg,#fbfcff,#f4f6fb); }
    .hd .t { font-weight: 650; font-size: 12.5px; }
    .hd .dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px #dcfce7; }
    .hd .grow { flex: 1; }
    .kbd { font-size: 9px; border: 1px solid #e6e9f0; border-radius: 5px; padding: 1px 4px; color: #9ca3af; background: #fff; }
    .btn { border: 1px solid #e6e9f0; background: #fff; border-radius: 7px; padding: 2px 6px; font-size: 11.5px;
           cursor: pointer; color: #374151; line-height: 1.4; }
    .btn:hover { background: #eef1f7; }
    .btn.on { background: #111827; color: #fff; border-color: #111827; }
    .counts { display: flex; gap: 5px; padding: 7px 10px; flex-wrap: wrap; border-bottom: 1px solid #f2f4f8; }
    .cnt { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #374151;
           background: #f6f7fb; border: 1px solid #eceff5; border-radius: 999px; padding: 1px 7px; }
    .cnt b { font-weight: 700; }
    .cnt i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    .list { overflow-y: auto; padding: 5px; }
    .item { display: flex; gap: 7px; padding: 7px; border-radius: 9px; cursor: pointer; align-items: flex-start; }
    .item:hover { background: #f7f8fd; }
    .score { min-width: 32px; text-align: center; font-weight: 700; font-size: 14px; line-height: 1.15; }
    .score small { display: block; font-size: 8.5px; font-weight: 700; text-transform: uppercase; }
    .hot { color: #dc2626; } .warm { color: #d97706; } .cold { color: #6b7280; }
    .mid { flex: 1; min-width: 0; }
    .row1 { display: flex; align-items: center; gap: 5px; }
    .badge { color: #fff; border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 700; }
    .nm { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sn { color: #6b7280; font-size: 11.5px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .meta { color: #9ca3af; font-size: 10.5px; margin-top: 2px; display: flex; gap: 7px; flex-wrap: wrap; }
    .icon { border: none; background: transparent; cursor: pointer; font-size: 12px; padding: 1px 2px; border-radius: 5px; opacity: .5; }
    .icon:hover { opacity: 1; background: #eef1f7; }
    .legendBox { padding: 7px 10px; border-top: 1px solid #f2f4f8; background: #fcfdff;
                 display: flex; flex-wrap: wrap; gap: 4px 9px; font-size: 10.5px; color: #4b5563; }
    .sym { display: inline-flex; align-items: center; gap: 3px; }
    .sym b { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 14px;
             border-radius: 4px; color: #fff; font-size: 9px; font-weight: 700; padding: 0 3px; }
    .ft { padding: 6px 10px; border-top: 1px solid #eef0f5; color: #9ca3af; font-size: 10.5px;
          display: flex; justify-content: space-between; gap: 8px; }
    .empty { padding: 16px 12px; color: #6b7280; font-size: 12px; line-height: 1.6; }
    .collapsed .list, .collapsed .counts, .collapsed .ft, .collapsed .legendBox { display: none; }
    .err { color: #b91c1c; }
  `;

  const FAB_CSS = `
    button { width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
             background: #7c3aed; color: #fff; font-size: 17px; line-height: 1;
             box-shadow: 0 8px 24px rgba(124,58,237,.38); }
    button:hover { filter: brightness(1.08); }
  `;

  function ensureHost() {
    if (host && document.contains(host)) return;
    host = document.createElement('div');
    host.id = '__lead_source_host';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.id = 'wrap';
    shadow.appendChild(st);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    wrap.addEventListener('click', onPanelClick);
  }

  function ensureFab() {
    if (fab && document.contains(fab)) return;
    fab = document.createElement('div');
    fab.id = '__lead_source_fab';
    fab.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
    const sh = fab.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = FAB_CSS;
    const b = document.createElement('button');
    b.textContent = '🏷️';
    b.title = 'Mở phân loại tệp khách (Alt+O)';
    b.addEventListener('click', () => {
      if (!CFG.enabled) setEnabled(true);
      else { CFG.showPanel = true; saveCfg({ showPanel: true }); paint(true); }
      syncFab();
    });
    sh.appendChild(st);
    sh.appendChild(b);
    document.documentElement.appendChild(fab);
  }

  function syncFab() {
    const needFab = !CFG.enabled || !CFG.showPanel;
    if (!needFab) { if (fab) fab.style.display = 'none'; return; }
    ensureFab();
    fab.style.display = '';
    const b = fab.shadowRoot && fab.shadowRoot.querySelector('button');
    if (b) {
      b.textContent = CFG.enabled ? '▤' : '🏷️';
      b.title = CFG.enabled ? 'Mở bảng tệp khách' : 'Bật phân loại tệp khách (Alt+O)';
    }
  }

  function legendHtml() {
    if (!CFG.showLegend) return '';
    const sym = (code, color, label) =>
      '<span class="sym"><b style="background:' + color + '">' + code + '</b>' + label + '</span>';
    return '<div class="legendBox">' +
      sym('QC', SOURCE_COLOR.ads, 'Quảng cáo') +
      sym('BV', SOURCE_COLOR.post, 'Bài viết') +
      sym('LV', SOURCE_COLOR.live, 'Livestream') +
      sym('TN', SOURCE_COLOR.organic, 'Tự nhắn') +
      sym('?', SOURCE_COLOR.unknown, 'Chưa rõ') +
      sym('🔥', '#dc2626', 'Chốt ngay') +
      '<span class="sym">… = chưa xem tin nhắn</span>' +
      '</div>';
  }

  function itemHtml(r, pending) {
    const conf = r.confidence === 'high' ? '' : ' · tin cậy ' + CONF_LABEL[r.confidence];
    const tip = esc(r.evidence.join('\n') + (r.reasons.length ? '\n\n' + r.reasons.join('\n') : ''));
    return '<div class="item" data-id="' + esc(r.id) + '" data-act="focus" title="' + tip + '">' +
      '<div class="score ' + r.prioKey + '">' + r.score +
      '<small>' + (r.prioKey === 'hot' ? 'CHỐT' : (r.prioKey === 'warm' ? 'ưu tiên' : 'theo dõi')) + '</small></div>' +
      '<div class="mid"><div class="row1"><span class="badge" style="background:' + SOURCE_COLOR[r.source] + '">' +
      SOURCE_SHORT[r.source] + '</span><span class="nm">' + esc(r.name) + '</span></div>' +
      '<div class="sn">' + esc(r.snippet) + '</div>' +
      '<div class="meta"><span>' + esc(r.pageName || '') + '</span><span>' + hhmm(r.updatedAt) + '</span>' +
      (r.unread > 0 ? '<span style="color:#dc2626;font-weight:600">' + r.unread + ' chưa đọc</span>' : '') +
      '<span>' + esc(SOURCE_LABEL[r.source]) + conf + (pending ? ' …' : '') + '</span></div></div>' +
      '<div><button class="icon" data-act="focus" data-id="' + esc(r.id) + '" title="Tìm trong danh sách">🔍</button>' +
      '<button class="icon" data-act="copy" data-id="' + esc(r.id) + '" title="Copy thông tin khách">📋</button></div></div>';
  }

  function paint(force) {
    if (!CFG.enabled || !CFG.showPanel) { if (host) host.style.display = 'none'; syncFab(); return; }
    ensureHost();
    host.style.display = '';

    const now = Date.now();
    const all = [];
    state.convs.forEach((c, id) => all.push(buildLead(c, state.msgs.get(id) || [], now)));
    all.sort((a, b) => b.score - a.score);

    const sig = state.version + '|' + all.length + '|' + all.slice(0, CFG.topN).map(r => r.id + r.score + r.source).join(',');
    if (!force && sig === paintSig) return;
    paintSig = sig;

    const counts = { ads: 0, post: 0, live: 0, organic: 0, unknown: 0 };
    all.forEach(r => { counts[r.source] = (counts[r.source] || 0) + 1; });
    const hot = all.filter(r => r.prioKey === 'hot').length;

    const wrap = shadow.getElementById('wrap');
    if (!wrap) return;
    const wasCollapsed = wrap.classList.contains('collapsed');
    const prevList = shadow.querySelector('.list');
    const scrollTop = prevList ? prevList.scrollTop : 0;

    wrap.innerHTML =
      '<div class="hd"><span class="dot"></span><span class="t">Tệp khách</span>' +
      '<span class="cnt" style="padding:1px 6px"><b>' + all.length + '</b></span><span class="grow"></span>' +
      '<span class="kbd">Alt+O</span>' +
      '<button class="btn ' + (CFG.showLegend ? 'on' : '') + '" data-act="legend" title="Bảng kí hiệu">?</button>' +
      '<button class="btn" data-act="hidePanel" title="Ẩn bảng, giữ nhãn trên dòng chat">▭</button>' +
      '<button class="btn" data-act="collapse" title="Thu gọn">' + (wasCollapsed ? '▾' : '▴') + '</button>' +
      '<button class="btn" data-act="off" title="Ẩn tất cả (Alt+O)">✕</button></div>' +
      '<div class="counts">' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.ads + '"></i>Quảng cáo <b>' + counts.ads + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.post + '"></i>Bài viết <b>' + counts.post + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.live + '"></i>Live <b>' + counts.live + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.organic + '"></i>Tự nhắn <b>' + counts.organic + '</b></span>' +
      '<span class="cnt"><i style="background:#dc2626"></i>Chốt ngay <b>' + hot + '</b></span></div>' +
      (all.length ? '<div class="list">' + all.slice(0, CFG.topN).map(r => itemHtml(r, !state.msgs.has(r.id))).join('') + '</div>'
        : '<div class="empty">Chưa đọc được danh sách hội thoại.<br>Mở trang <b>Hội thoại</b> của Pancake — script tự đọc '
          + 'dữ liệu và gắn nhãn cho các dòng đang hiển thị.</div>') +
      legendHtml() +
      '<div class="ft"><span>' + (state.lastSync ? 'đồng bộ ' + hhmm(new Date(state.lastSync).toISOString()) + ' trước' : 'chưa đồng bộ') +
      ' · ' + dom.rows + ' dòng' + (dom.mode !== 'selector' && dom.mode !== 'none' ? ' (' + dom.mode + ')' : '') + '</span>' +
      '<span class="' + (state.errors.length || (dom.rows && !dom.labeled) ? 'err' : '') + '">' +
      esc(state.errors.length ? state.errors[state.errors.length - 1].msg
        : (dom.rows && !dom.labeled ? 'không gắn được nhãn → __leadSource.debug()'
          : (dom.rows ? dom.labeled + ' nhãn / ' + dom.visible + ' đang hiện' : 'chưa thấy dòng hội thoại'))) + '</span></div>';

    if (wasCollapsed) wrap.classList.add('collapsed');
    const newList = shadow.querySelector('.list');
    if (newList && scrollTop) newList.scrollTop = scrollTop;
    syncFab();
  }

  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      if (!CFG.enabled || !CFG.showPanel) return;
      try { paint(); } catch (e) { LOG('paint lỗi', e); }
    }, 700);
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
    if (act === 'legend') {
      CFG.showLegend = !CFG.showLegend;
      saveCfg({ showLegend: CFG.showLegend });
      paint(true);
      return;
    }
    if (act === 'hidePanel') {
      CFG.showPanel = false;
      saveCfg({ showPanel: false });
      paint(true);
      return;
    }
    if (act === 'off') { setEnabled(false); return; }
    if (!id) return;
    const conv = state.convs.get(id) || { id: id };
    if (act === 'copy') {
      const lead = buildLead(conv, state.msgs.get(id) || [], Date.now());
      navigator.clipboard.writeText(lead.name + ' | psid ' + lead.psid + ' | ' + lead.sourceLabel + ' | ' +
        lead.score + ' điểm | ' + lead.snippet.replace(/\n/g, ' '))
        .then(() => { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📋'; }, 1200); })
        .catch(() => {});
      return;
    }
    if (act === 'focus') focusInList(conv);
  }

  function focusInList(conv) {
    if (!conv || !conv.id) return;
    const chip = document.querySelector('.__ls_chip[data-ls-id="' + cssEscape(conv.id) + '"]');
    const row = (chip && chip.closest(SEL_ROW)) || document.getElementById(conv.id) ||
      document.querySelector('[id^="' + cssEscape(conv.id) + '__"]');
    if (!row) { LOG('Không thấy dòng của', conv.id, '— cuộn danh sách hoặc đổi bộ lọc.'); return; }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const old = row.style.boxShadow;
    row.style.boxShadow = '0 0 0 2px #7c3aed inset';
    setTimeout(() => { row.style.boxShadow = old; }, 1400);
  }

  // ======================================================================
  // 8. BẬT / TẮT
  //    Alt+O hoặc ✕  : ẩn/hiện TẤT CẢ (panel + nhãn). Nút 🏷️ vẫn còn để bật lại.
  //    ▭             : chỉ ẩn panel, nhãn trên dòng chat vẫn cập nhật.
  //    Dữ liệu + enrich LUÔN chạy, kể cả khi đã ẩn -> bật lại là có ngay.
  // ======================================================================
  function setEnabled(on) {
    CFG.enabled = !!on;
    saveCfg({ enabled: CFG.enabled });
    if (!CFG.enabled) {
      if (host) host.style.display = 'none';
      clearChips();
    } else {
      ensureHost();
      host.style.display = '';
      paint(true);
      scheduleDecor(true);
    }
    syncFab();
    return CFG.enabled;
  }

  function onKeydown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = (e.key || '').toLowerCase();
    if (k !== 'o' && e.code !== 'KeyO') return;
    e.preventDefault();
    e.stopPropagation();
    setEnabled(!CFG.enabled);
    LOG(CFG.enabled ? 'đã bật' : 'đã ẩn (Alt+O để bật lại)');
  }

  document.addEventListener('keydown', onKeydown, true);

  function cssEscape(v) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hhmm(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diff < 1) return 'vừa xong';
    if (diff < 60) return Math.round(diff) + ' phút';
    if (diff < 1440) return Math.round(diff / 60) + ' giờ';
    return Math.round(diff / 1440) + ' ngày';
  }

  function saveCfg(patch) {
    try {
      const cur = JSON.parse(localStorage.getItem('leadSource.cfg') || '{}');
      Object.assign(cur, patch);
      localStorage.setItem('leadSource.cfg', JSON.stringify(cur));
    } catch (e) { /* ignore */ }
  }

  // ======================================================================
  // 9. VÒNG QUAN SÁT (nhẹ)
  // ======================================================================
  let mo = null;
  let moTarget = null;

  function attachObserver() {
    const target = listContainer();
    if (mo && moTarget === target && document.contains(target)) return;
    if (!mo) mo = new MutationObserver(() => scheduleDecor());
    if (moTarget) { try { mo.disconnect(); } catch (e) { /* ignore */ } }
    moTarget = target;
    mo.observe(target, { childList: true, subtree: true });
  }

  let scrollTimer = null;
  function onScroll() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => { scrollTimer = null; scheduleDecor(true); }, 120);
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  function start() {
    attachObserver();
    scheduleDecor(true);
    paint(true);
    syncFab();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  setTimeout(tick, 1200);
  setInterval(tick, Math.max(8000, CFG.pollMs || 25000));
  setInterval(() => {                     // quét dự phòng + gắn lại observer nếu Pancake render lại
    if (document.hidden || !CFG.enabled) return;
    attachObserver();
    scheduleDecor(true);
  }, Math.max(800, CFG.scanMs));
  setInterval(() => { if (CFG.enabled && CFG.showPanel) schedulePaint(); }, 3000);

  // ======================================================================
  // 10. API console
  // ======================================================================
  window.__leadSource = {
    cfg: CFG,
    state: state,
    get visible() { return !!CFG.enabled; },
    get leads() {
      const now = Date.now(), out = [];
      state.convs.forEach((c, id) => out.push(buildLead(c, state.msgs.get(id) || [], now)));
      return out.sort((a, b) => b.score - a.score);
    },
    get visibleRows() { return visibleRows().map(convIdOf).filter(Boolean); },
    toggle: () => setEnabled(!CFG.enabled),
    show: () => setEnabled(true),
    hide: () => setEnabled(false),
    refresh: () => { scheduleDecor(true); schedulePaint(); tick(); },
    reload: () => { state.convs.clear(); state.msgs.clear(); clearChips(); tick(); paint(true); },
    classify: classify,
    buildLead: buildLead,
    set: function (patch) {
      Object.assign(CFG, patch);
      saveCfg(patch);
      if ('enabled' in patch) setEnabled(patch.enabled);
      else { paint(true); scheduleDecor(true); }
      return CFG;
    },
    debug: function () {
      const rows = findRows();
      const vis = visibleRows();
      const sample = vis[0] || rows[0] || null;
      const rep = {
        version: VERSION,
        url: location.href,
        enabled: CFG.enabled,
        showPanel: CFG.showPanel,
        showChips: CFG.showChips,
        convs: state.convs.size,
        msgs: state.msgs.size,
        listRequests: state.listReqs.length,
        domMode: dom.mode,
        rowsFound: rows.length,
        rowsVisible: vis.length,
        rowsWithChip: document.querySelectorAll('.__ls_chip').length,
        selectors: { list: selList(), row: selRow(), name: selName() },
        sampleRowHtml: sample ? String(sample.outerHTML).slice(0, 800) : null,
        errors: state.errors.map(e => e.msg),
      };
      console.log('%c[lead-source] chẩn đoán', 'color:#7c3aed;font-weight:700', rep);
      try {
        navigator.clipboard.writeText(JSON.stringify(rep, null, 2));
        LOG('đã copy báo cáo chẩn đoán — dán cho dev là biết sửa gì');
      } catch (e) { /* ignore */ }
      return rep;
    },
    help: function () {
      LOG('Alt+O  = ẩn/hiện tất cả · ▭ = chỉ ẩn bảng · 🏷️/▤ = mở lại' +
        '\nChỉ xem tin nhắn của dòng đang hiển thị:  __leadSource.set({enrichVisible: false}) để tắt' +
        '\nMap tag id:  __leadSource.set({tagMap: {"83": {name:"Từ quảng cáo", source:"ads"}}})' +
        '\nMap tên tag trên dòng chat:  __leadSource.set({tagNameSource: {"QC": "ads", "LIVE": "live"}})' +
        '\nNhịp quét:   __leadSource.set({scanMs: 2000, pollMs: 30000})');
    },
  };

  if (!CFG.enabled) {
    LOG('đang ở trạng thái ĐÃ ẨN (lưu từ lần trước). Bấm nút 🏷️ góc phải hoặc Alt+O để bật lại.');
  }
  LOG('v' + VERSION + ' đã bật · Alt+O ẩn/hiện · chỉ xử lý dòng đang hiển thị · __leadSource.debug() để chẩn đoán');
})();

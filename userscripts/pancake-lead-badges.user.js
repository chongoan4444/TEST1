// ==UserScript==
// @name         Pancake - Phân loại tệp khách theo nguồn
// @namespace    https://github.com/chongoan4444/TEST1
// @version      3.8.0
// @description  Gắn nhãn Quảng cáo / Bài viết / Livestream / Tự nhắn cho các hội thoại ĐANG HIỂN THỊ trên Pancake — chỉ khi có bằng chứng thật, không chấm điểm, chưa đọc tin nhắn thì hiện "?". Alt+O bật/tắt.
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
    pollMs: 45000,          // gọi lại danh sách hội thoại
    scanMs: 3000,           // quét dự phòng (observer + cuộn đã lo việc gắn nhãn)
    enrichVisible: true,    // chỉ xem tin nhắn của hội thoại đang hiển thị (để nhận ra quảng cáo)
    enrichLimit: 3,         // tối đa N hội thoại mỗi lượt (càng ít càng nhẹ)
    enrichSpacing: 700,     // ms giữa 2 request
    enrichTTL: 600000,      // không hỏi lại hội thoại đã hỏi trong 10 phút
    wsRealtime: true,       // nghe websocket Facebook để biết trước hội thoại nào từ quảng cáo
    topN: 12,
    // đổi selector khi Pancake đổi giao diện: __leadSource.set({selRow:'.abc'})
    selList: '', selRow: '', selName: '', selSnippet: '', selTag: '',
    tagMap: {},             // {'83': {name:'Từ quảng cáo', source:'ads'}}  (tag id từ API)
    tagNameSource: {},      // {'QC': 'ads', 'live': 'live'}  (tên tag hiện trên dòng chat)
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
  const CONF_LABEL = { high: 'chắc chắn', mid: 'khá chắc', low: 'thấp', none: 'chưa kiểm tra' };
  const SOURCE_ORDER = ['ads', 'post', 'live', 'organic', 'unknown'];

  // Bằng chứng THẬT, kiểm tra trên 947 hội thoại + 163 tin nhắn trong loaddanhsach.har / batmesss.har:
  //   - 22 tin có attachments[].type = "ad_click" (kèm ad_id) -> quảng cáo
  //   - 3 attachment có post_attachments/comment (chia sẻ/bình luận bài viết) -> bài viết
  //   - 2 hội thoại type = "COMMENT" -> bình luận bài viết
  //   - is_livestream_order / has_livestream_order / live_video_status: KHÔNG có giá trị nào (toàn null)
  //   - extra_info, post, post_id của danh sách hội thoại: LUÔN rỗng -> không dùng để đoán
  const AD_KEYS = ['ad_id', 'ad_ids', 'ads_context_data', 'referral', 'ad_referral', 'is_ad', 'from_ad'];
  const AD_TYPE_VALUES = ['ad_click', 'ad_referral'];
  const POST_KEYS = ['post_id', 'post', 'comment_id', 'post_permalink'];
  const LIVE_KEYS = ['is_livestream_order', 'has_livestream_order', 'live_video_id', 'live_video_status'];
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

  /**
   * -> { source, confidence, evidence[] }
   *
   * NGUYÊN TẮC: chỉ kết luận khi có bằng chứng thật trong dữ liệu Pancake.
   *   ads     : message.attachments[].type = "ad_click" (kèm ad_id)      -> chắc chắn
   *   post    : attachment có post_attachments/comment, hoặc hội thoại type = COMMENT
   *   live    : chỉ khi có cờ is_livestream_order / has_livestream_order / live_video_id
   *   organic : ĐÃ đọc tin nhắn và không có dấu hiệu nào ở trên
   *   unknown : CHƯA đọc tin nhắn -> KHÔNG đoán (đây chính là lỗi "hiện TN, bấm vào lại thành QC")
   */
  function classify(conv, msgs, checked, attr) {
    msgs = msgs || [];
    attr = attr || null;
    const evidence = [];
    let source = null;
    let confidence = 'high';

    // ---------- 0. NGUỒN CẤP HỘI THOẠI (Pancake trả trong response tin nhắn) ----------
    if (attr && attr.ad && attr.ad.length) {
      source = 'ads';
      evidence.push((attr.src === 'ws'
        ? 'Facebook đẩy ad_id của hội thoại qua websocket (biết trước khi dòng hiện ra) · ad_id '
        : 'Pancake ghi nhận khách bấm quảng cáo · ad_id ') + (attr.adId || attr.ad[0].ad_id || '') +
        (attr.ad[0].post_id ? ' · post_id ' + attr.ad[0].post_id : ''));
    }

    // ---------- 1. QUẢNG CÁO (theo từng tin nhắn) ----------
    const adHits = [];
    msgs.forEach((m, i) => {
      if (!m || !Array.isArray(m.attachments)) return;
      m.attachments.forEach((a, j) => {
        if (!a || typeof a !== 'object') return;
        const t = String(a.type || '').toLowerCase();
        const at = 'tin nhắn ' + (i + 1) + '.attachments[' + j + ']';
        if (AD_TYPE_VALUES.indexOf(t) >= 0) {
          adHits.push(at + '.type = ' + a.type + (a.ad_id ? ' · ad_id ' + a.ad_id : ''));
        } else if (!isEmptyish(a.ad_id)) {
          adHits.push(at + '.ad_id = ' + jsonify(a.ad_id));
        }
      });
    });
    deepFind({ extra_info: conv.extra_info }, AD_KEYS).forEach(hit => {
      if (isEmptyish(hit.value)) return;
      adHits.push('extra_info.' + hit.path + ' = ' + jsonify(hit.value));
    });
    if (adHits.length) {
      source = 'ads';
      evidence.push.apply(evidence, adHits.slice(0, 3));
    }

    // ---------- 2. BÀI VIẾT (chia sẻ / bình luận bài viết) ----------
    const postHits = [];
    msgs.forEach((m, i) => {
      if (!m || !Array.isArray(m.attachments)) return;
      m.attachments.forEach((a, j) => {
        if (!a || typeof a !== 'object') return;
        const t = String(a.type || '').toLowerCase();
        if (AD_TYPE_VALUES.indexOf(t) >= 0) return;                 // đã tính là quảng cáo
        if (a.comment && typeof a.comment === 'object' && (a.comment.content || a.comment.msg_id)) {
          postHits.push('tin nhắn ' + (i + 1) + ': bình luận bài viết "' +
            String(a.comment.content || '').replace(/\s+/g, ' ').slice(0, 40) + '"');
        } else if (Array.isArray(a.post_attachments) || a.post_type) {
          postHits.push('tin nhắn ' + (i + 1) + ': chia sẻ bài viết' + (a.post_type ? ' (' + a.post_type + ')' : ''));
        }
      });
    });
    const convType = String(conv.type || '').toUpperCase();
    if (COMMENT_HINTS.some(h => convType.indexOf(h) >= 0)) {
      postHits.push('hội thoại type = ' + convType + ' (bình luận bài viết)');
    }
    deepFind({ conv: { post: conv.post, post_id: conv.post_id } }, POST_KEYS).forEach(hit => {
      if (!isEmptyish(hit.value)) postHits.push(hit.path + ' = ' + jsonify(hit.value));
    });
    if (attr && attr.post) postHits.unshift('hội thoại gắn với bài viết (post) — Pancake trả trong dữ liệu tin nhắn');
    if (!source && postHits.length) {
      source = 'post';
      evidence.push.apply(evidence, postHits.slice(0, 3));
    }

    // ---------- 3. LIVESTREAM (chỉ khi Pancake gắn cờ) ----------
    const liveHits = [];
    if (attr && attr.live) liveHits.push('hội thoại có cờ livestream trong dữ liệu tin nhắn');
    const liveFlag = o => o && (o.is_livestream_order === true || o.has_livestream_order === true ||
      !isEmptyish(o.live_video_id) || !isEmptyish(o.live_video_status));
    if (liveFlag(conv)) liveHits.push('hội thoại có has_livestream_order = true');
    msgs.forEach((m, i) => {
      if (liveFlag(m)) liveHits.push('tin nhắn ' + (i + 1) + ' có cờ livestream');
      (m && Array.isArray(m.attachments) ? m.attachments : []).forEach(a => {
        if (a && /live/i.test(String(a.type || ''))) liveHits.push('tin nhắn ' + (i + 1) + '.attachments.type = ' + a.type);
      });
    });
    if (!source && liveHits.length) {
      source = 'live';
      confidence = 'mid';
      evidence.push.apply(evidence, liveHits.slice(0, 2));
    }

    // ---------- 4. Tag do BẠN tự cấu hình (chỉ khi chưa có bằng chứng dữ liệu) ----------
    if (!source) {
      (conv.domTags || []).forEach(rawName => {
        if (source) return;
        const key = stripAccents(rawName);
        Object.keys(CFG.tagNameSource || {}).forEach(k => {
          if (source) return;
          if (stripAccents(k) === key && SOURCE_LABEL[CFG.tagNameSource[k]]) {
            source = CFG.tagNameSource[k];
            confidence = 'mid';
            evidence.push('tag trên dòng chat: "' + rawName + '" → ' + SOURCE_LABEL[source] + ' (do bạn cấu hình)');
          }
        });
      });
      if (!source) {
        (conv.tags || []).forEach(tid => {
          const info = CFG.tagMap[String(tid)];
          if (source || !info || !SOURCE_LABEL[info.source]) return;
          source = info.source;
          confidence = 'mid';
          evidence.push('tag #' + tid + ' = ' + (info.name || '?') + ' → ' + SOURCE_LABEL[source] + ' (do bạn cấu hình)');
        });
      }
    }

    // ---------- 5. CHƯA ĐỌC TIN NHẮN -> KHÔNG ĐOÁN ----------
    if (!source) {
      const seen = checked || msgs.length > 0;
      if (!seen) {
        source = 'unknown';
        confidence = 'none';
        evidence.push('chưa đọc tin nhắn của hội thoại này → chưa kết luận');
      } else {
        source = 'organic';
        confidence = 'high';
        evidence.push(msgs.length
          ? 'đã đọc ' + msgs.length + ' tin nhắn: không có ad_click / bài viết / livestream'
          : 'hội thoại chưa có tin nhắn nào (đã kiểm tra)');
      }
    }

    return { source: source, confidence: confidence, evidence: evidence };
  }

  function parseDate(v) {
    if (!v) return null;
    const d = new Date(String(v).replace('Z', '+00:00'));
    return isNaN(d.getTime()) ? null : d;
  }

  function buildLead(conv, msgs, now, checked, attr) {
    const c = classify(conv, msgs, checked, attr);
    const cust = (conv.customers && conv.customers[0]) || {};
    const from = conv.from || {};
    const name = cust.name || from.name || '(không tên)';
    const phones = (conv.recent_phone_numbers || []).filter(p => typeof p === 'string' || typeof p === 'number');
    const updated = parseDate(conv.updated_at);
    const lastCust = parseDate(conv.last_customer_interactive_at);
    const snippet = conv.snippet || '';
    const unread = Number(conv.unread_count || 0) || 0;
    const nMsgs = Number(conv.message_count || 0) || 0;

    return {
      id: conv.id || '',
      name: name,
      psid: String(conv.from_psid || cust.fb_id || ''),
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
      checked: !!(checked || (msgs && msgs.length) || (attr && (attr.ad.length || attr.post || attr.live))),
      updatedAt: updated ? updated.toISOString() : '',
      lastCustomerAt: lastCust ? lastCust.toISOString() : '',
      at: (updated || lastCust) ? (updated || lastCust).getTime() : 0,
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
  const VERSION = '3.8.0';
  const RE_MESSAGES_URL = /\/conversations\/([^/?#]+)\/messages(\?|$)/;
  const RE_API = /\/api\/v1\//;
  const BOOT_AT = Date.now();

  const state = {
    convs: new Map(),
    msgs: new Map(),
    firstSeen: new Map(),
    listReqs: [],          // [{url, init, at}] tối đa 3
    msgUrlTpl: null,
    custIds: new Map(),      // conv_id -> customer_id (học từ URL Pancake tự gọi)
    attr: new Map(),         // conv_id -> {ad[], post, live} lấy từ response tin nhắn
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
  const RE_JUNK = /\/(avatar|logs|contents|promotion|check_|toggle_|sync_|update_global_id|profile_in|websocket)/i;
  function shouldSniff(url) {
    if (!url || typeof url !== 'string') return false;
    if (RE_MESSAGES_URL.test(url)) return true;
    if (!RE_API.test(url)) return false;              // ngoài /api/v1/ thì bỏ qua (đỡ parse vô ích)
    if (RE_JUNK.test(url)) return false;
    if (/conversation|message|tag|label/i.test(url)) return true;
    return Date.now() - BOOT_AT < 8000;               // 8s đầu mới dò thêm endpoint lạ
  }

  const RE_CONV_SHAPE = /^\d{5,}_\d{5,}$/;

  /** Một object có phải hội thoại không (dựa vào hình dạng, không dựa vào tên khóa). */
  function looksLikeConv(x) {
    return !!x && typeof x === 'object' && typeof x.id === 'string' && RE_CONV_SHAPE.test(x.id) &&
      ('snippet' in x || 'customers' in x || 'updated_at' in x || 'message_count' in x || 'from_psid' in x);
  }

  /** Tìm mảng hội thoại ở bất kỳ đâu trong response (tối đa 3 tầng, tránh quét nặng). */
  function findConvArray(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 3) return null;
    if (Array.isArray(node)) return (node.length && looksLikeConv(node[0])) ? node : null;
    const prefer = ['conversations', 'data', 'list', 'items', 'results', 'payload', 'rows'];
    for (let i = 0; i < prefer.length; i++) {
      const v = node[prefer[i]];
      if (v && typeof v === 'object') { const r = findConvArray(v, depth + 1); if (r) return r; }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length && i < 20; i++) {
      const v = node[keys[i]];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const r = findConvArray(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  /** Đọc mọi response: nhận ra conversations hoặc messages bằng DẤU HIỆU DỮ LIỆU. */
  function maybeIngest(url, init, json) {
    if (!json || typeof json !== 'object') return;
    if (Array.isArray(json.conversations) && json.conversations.length) ingestList(url, init, json);
    else {
      const found = findConvArray(json);
      if (found && found.length) { ingestList(url, init, { conversations: found }); }
    }

    const list = json.messages || json.data;
    if (!Array.isArray(list)) return;
    const m = RE_MESSAGES_URL.exec(url || '');
    if (m && (list.length === 0 || (list[0] && typeof list[0] === 'object'))) {
      ingestMessagesFor(decodeURIComponent(m[1]), list, url, json);
      return;
    }
    if (!list.length || !list[0] || !list[0].conversation_id) return;
    const byConv = {};
    list.forEach(x => {
      const cid = x && x.conversation_id;
      if (cid) (byConv[cid] = byConv[cid] || []).push(x);
    });
    Object.keys(byConv).forEach(cid => ingestMessagesFor(cid, byConv[cid], url, json));
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
      // Pancake lúc trả mảng, lúc trả map {uuid: khách} -> chuẩn hoá về mảng
      if (c.customers && !Array.isArray(c.customers) && typeof c.customers === 'object') {
        c.customers = Object.keys(c.customers).map(k => {
          const v = c.customers[k];
          return (v && typeof v === 'object') ? v : { id: k, name: String(v || '') };
        });
      }
      const known = state.custIds && state.custIds.get(c.id);
      if (known && (!c.customers || !c.customers.length)) c.customers = [{ id: known, name: '' }];
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
    if (state.attr.size > 600) {
      Array.from(state.attr.keys()).slice(0, state.attr.size - 400).forEach(k => state.attr.delete(k));
    }
    state.lastSync = ts;
    state.version++;
    scheduleDecor();
    schedulePaint();
  }

  /**
   * Pancake ghi nguồn ở CẤP HỘI THOẠI ngay trong response tin nhắn:
   *   ad_clicks: {"<customer_uuid>": [{ad_id, post_id, inserted_at}]}
   *   activities[].ad_id, customers[].ad_clicks, post, has_livestream_order…
   * (kiểm trên 31 response thật: 27 response có ad_clicks; danh sách hội thoại thì KHÔNG có)
   * => đọc tin nhắn 1 lần là biết QC/BV/LV, không phụ thuộc trang tin mới nhất.
   */
  function extractAttribution(json) {
    const out = { ad: [], post: null, live: false, adId: '' };
    if (!json || typeof json !== 'object') return out;
    const ac = json.ad_clicks;
    if (ac && typeof ac === 'object' && !Array.isArray(ac)) {
      Object.keys(ac).forEach(k => { if (Array.isArray(ac[k])) out.ad = out.ad.concat(ac[k]); });
    } else if (Array.isArray(ac)) out.ad = ac.slice();
    (Array.isArray(json.activities) ? json.activities : []).forEach(a => {
      if (a && a.ad_id) out.ad.push({ ad_id: a.ad_id, post_id: a.post_id });
    });
    (Array.isArray(json.customers) ? json.customers : []).forEach(c => {
      if (c && Array.isArray(c.ad_clicks)) out.ad = out.ad.concat(c.ad_clicks);
    });
    if (json.post) out.post = json.post;
    else if (json.post_id) out.post = { id: json.post_id };
    out.live = !!(json.has_livestream_order === true || json.is_livestream_order === true ||
      json.live_video_status || json.live_video_id);
    out.adId = out.ad.length ? String(out.ad[0].ad_id || '') : '';
    return out;
  }

  function learnCustId(id, url) {
    if (!id || !url || !state.custIds) return;
    const m = /[?&]customer_id=([0-9a-fA-F-]{30,})/.exec(url);
    if (m) state.custIds.set(id, decodeURIComponent(m[1]));
  }

  function ingestMessagesFor(id, list, url, payload) {
    if (!id || !Array.isArray(list)) return;
    learnCustId(id, url);
    const attr = extractAttribution(payload || {});
    if (attr.ad.length || attr.post || attr.live) state.attr.set(id, attr);
    const known = state.convs.get(id);
    const hasProof = attr.ad.length > 0 || !!attr.post || attr.live;
    // rỗng mà không có bằng chứng, trong khi hội thoại có tin -> coi như CHƯA đọc
    if (!list.length && !hasProof && known && Number(known.message_count || 0) > 0) {
      state.enriching.delete(id);
      return;
    }
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
  // 3bis. NGHE TRƯỚC TỪ WEBSOCKET — nhãn có TRƯỚC khi dòng hiện ra
  //
  //  Bằng chứng thật (batmesss.har, khung nhận từ wss://edge-chat.facebook.com/chat):
  //    khung "deleteThenInsertThread" mang sẵn  entity_id=<psid>  và nhãn
  //    "name":"ad_id.120251435064020732"
  //  -> Facebook đẩy psid + ad_id của hội thoại ngay khi khách nhắn, TRƯỚC khi
  //     Pancake gọi lại danh sách (đo trong HAR: 7/9 hội thoại có dữ liệu tin nhắn
  //     tới trước lần xuất hiện đầu tiên trong danh sách; sớm hơn 0,3s … 114s).
  //  Nguyên tắc: chỉ nhận khi khung có ĐÚNG MỘT psid — khung gộp nhiều hội thoại
  //  thì bỏ, không đoán (đoán là đúng lỗi TN -> QC ngày trước).
  // ======================================================================
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

  /** tách psid + ad_id từ một khung websocket; trả null nếu không chắc chắn */
  function parseRealtime(text, pageId) {
    if (!text || text.length > 200000 || text.indexOf('ad_id.') < 0) return null;
    const psids = [];
    const ads = [];
    let m;
    const reE = /entity_id=(\d{5,})/g;
    while ((m = reE.exec(text))) {
      if (pageId && m[1] === pageId) continue;          // entity_id của chính trang
      if (psids.indexOf(m[1]) < 0) {
        psids.push(m[1]);
        if (psids.length > 1) return null;              // khung gộp nhiều hội thoại -> bỏ
      }
    }
    const reA = /ad_id\.(\d{5,})/g;
    while ((m = reA.exec(text))) if (ads.indexOf(m[1]) < 0) ads.push(m[1]);
    if (!psids.length || !ads.length || !pageId) return null;
    return { id: pageId + '_' + psids[0], psid: psids[0], ads: ads, adId: ads[0] };
  }

  function ingestWsText(text) {
    if (!CFG.wsRealtime || !text) return;
    const hit = parseRealtime(text, pageIdNow());
    if (!hit) return;
    const prev = state.attr.get(hit.id);
    if (prev && prev.ad && prev.ad.length) return;      // đã có bằng chứng rồi
    state.attr.set(hit.id, {
      ad: hit.ads.map(a => ({ ad_id: a })), post: null, live: false, adId: hit.adId, src: 'ws'
    });
    state.wsHits = (state.wsHits || 0) + 1;
    state.version++;
    scheduleDecor();
    schedulePaint();
    LOG('websocket: hội thoại ' + hit.id + ' là quảng cáo (ad_id ' + hit.adId + ') — biết trước khi dòng hiện ra');
  }

  function readWsData(data) {
    try {
      if (typeof data === 'string') { ingestWsText(data); return; }
      if (!data) return;
      // ArrayBuffer / TypedArray / Buffer (kiểm bằng byteLength để không phụ thuộc "realm")
      if (typeof data.byteLength === 'number') {
        let text = '';
        try {
          text = new TextDecoder('utf-8', { fatal: false }).decode(data);
        } catch (e) {
          const arr = (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array)
            ? data : new Uint8Array(data.buffer || data);
          for (let i = 0; i < arr.length; i++) text += String.fromCharCode(arr[i]);
        }
        ingestWsText(text);
        return;
      }
      if (typeof data.text === 'function') {
        data.text().then(t => { try { ingestWsText(t); } catch (e) {} }).catch(() => {});
      }
    } catch (e) { /* không làm hỏng app */ }
  }

  (function hookWebSocket() {
    const Orig = window.WebSocket;
    if (typeof Orig !== 'function' || Orig.__lsHooked) return;
    const onMsg = ev => { if (ev && ev.data) readWsData(ev.data); };
    const attach = (ws, url) => {
      try {
        if (!/facebook\.com|\/chat|lightspeed/i.test(String(url || ''))) return;
        ws.addEventListener('message', onMsg);
      } catch (e) { /* ignore */ }
    };
    const Wrapped = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        try { attach(ws, args[0]); } catch (e) { /* ignore */ }
        return ws;
      }
    });
    try { Wrapped.__lsHooked = true; } catch (e) { /* ignore */ }
    try {
      Object.defineProperty(window, 'WebSocket', { value: Wrapped, configurable: true, writable: true });
    } catch (e) {
      try { window.WebSocket = Wrapped; } catch (e2) { /* bó tay */ }
    }
  })();

  // ======================================================================
  // 4. POLL + ENRICH (chỉ cho hội thoại đang hiển thị)
  // ======================================================================
  function replayList() {
    const reqs = state.listReqs.filter(r => Date.now() - r.at < 10 * 60 * 1000).slice(-1);
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
    // URL thật của Pancake:
    // /api/v1/pages/<page>/conversations/<conv>/messages?customer_id=<uuid>&user_view=true&is_new_api=true&separate_pos=true
    const q = (custId && /^[0-9a-f-]{30,}$/i.test(custId)) ? '?customer_id=' + encodeURIComponent(custId) + '&' : '?';
    return '/api/v1/pages/' + encodeURIComponent(pageId) + '/conversations/' + encodeURIComponent(convId) +
      '/messages' + q + 'user_view=true&is_new_api=true&separate_pos=true';
  }

  /**
   * URL xem tin nhắn — thử lần lượt các biến thể ĐÃ THẤY TRẢ TIN NHẮN trong HAR thật:
   *   ?customer_id=…&user_view=true&is_new_api=true&separate_pos=true   (có messages)
   *   ?customer_id=…&separate_pos=true                                  (có messages)
   * Còn ?customer_id=… (một mình) và ? rỗng thì Pancake trả hồ sơ khách, KHÔNG có messages.
   */
  function msgUrls(conv) {
    const convId = conv.id || '';
    const pageId = conv.page_id || convId.split('_')[0] || '';
    const cust = (conv.customers && conv.customers[0]) || {};
    const custId = cust.id || (state.custIds && state.custIds.get(convId)) || '';
    const base = '/api/v1/pages/' + encodeURIComponent(pageId) + '/conversations/' + encodeURIComponent(convId) + '/messages';
    const out = [];
    if (state.msgUrlTpl) {
      out.push(state.msgUrlTpl.replace(/\/conversations\/[^/?#]+\/messages/, '/conversations/' + encodeURIComponent(convId) + '/messages')
        .replace(/customer_id=[^&]*/, 'customer_id=' + encodeURIComponent(custId)));
    }
    if (custId) {
      const q = 'customer_id=' + encodeURIComponent(custId);
      out.push(base + '?' + q + '&user_view=true&is_new_api=true&separate_pos=true');
      out.push(base + '?' + q + '&separate_pos=true');
      out.push(base + '?' + q);
    }
    return out.filter((u, i, a) => a.indexOf(u) === i);
  }

  async function enrich(conv) {
    if (!conv || !conv.id || !CFG.enabled) return;
    const id = conv.id;
    if (state.msgs.has(id) || state.enriching.has(id)) return;
    const last = state.enrichTried.get(id);
    if (last && Date.now() - last < CFG.enrichTTL) return;
    state.enriching.add(id);
    state.enrichTried.set(id, Date.now());

    const urls = msgUrls(conv);
    let lastKeys = null;
    for (let i = 0; i < urls.length; i++) {
      if (!CFG.enabled) break;
      try {
        const res = await fetch(urls[i], { credentials: 'include' });
        const j = await res.json();
        const arr = (j && Array.isArray(j.messages)) ? j.messages : null;
        state.enrichDbg = { id: id, got: arr ? arr.length : 0, keys: Object.keys(j || {}).slice(0, 8), url: urls[i].slice(-70) };
        if (arr) { ingestMessagesFor(id, arr, urls[i], j); return; }
        lastKeys = Object.keys(j || {}).slice(0, 6).join(',');
      } catch (e) {
        state.enrichDbg = { id: id, got: 0, keys: ['lỗi: ' + e.message], url: urls[i].slice(-70) };
        lastKeys = 'lỗi: ' + e.message;
      }
    }
    state.enriching.delete(id);
    state.enrichTried.set(id, Date.now() - CFG.enrichTTL + 60000);   // thử lại sau 60s
    state.enrichFail = (state.enrichFail || 0) + 1;
    if (!urls.length) noteError('không có customer_id để xem tin nhắn của ' + id);
    else if (lastKeys) noteError('tin nhắn ' + id + ': Pancake trả [' + lastKeys + '] — không có messages');
  }

  let enrichTimer = null;
  const enrichTimers = [];
  function queueEnrich(convs) {
    if (!CFG.enabled || !CFG.enrichVisible || !convs.length) return;
    if (enrichTimer) return;
    const todo = convs.filter(c => c && c.id && !state.msgs.has(c.id) && !state.enriching.has(c.id)).slice(0, CFG.enrichLimit);
    if (!todo.length) return;
    enrichTimer = setTimeout(() => {
      enrichTimer = null;
      if (!CFG.enabled) return;
      todo.forEach((c, i) => {
        const t = setTimeout(() => {
          const k = enrichTimers.indexOf(t);
          if (k >= 0) enrichTimers.splice(k, 1);
          enrich(c);
        }, 300 + i * CFG.enrichSpacing);
        enrichTimers.push(t);
      });
    }, 300);
  }

  function tick() {
    if (!CFG.enabled || document.hidden) return;      // tắt là dừng hẳn, không gọi mạng
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
    tag: '.list-tags, [class*="list_tags"], .tag-wrap, .conversation_tags_item, [class*="tags_item"]',
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
  const dom = { mode: 'none', rows: 0, visible: 0, labeled: 0, noName: 0, idFromWrapper: false };

  function listContainer() {
    const l = safeQuery(selList());
    return l.length ? l[0] : document.body;
  }

  // id hội thoại của CHÍNH phần tử: `<page>_<psid>` hoặc `<page>_<psid>__<n>`
  const RE_CONV_ID = /^(\d{5,}_\d{5,})(?:__\d+)?$/;
  function selfConvId(el) {
    const id = el && el.id;
    if (!id) return null;
    const m = RE_CONV_ID.exec(id);
    return m ? m[1] : null;
  }

  // Pancake có 2 kiểu đánh dấu: id nằm ngay trên dòng, HOẶC nằm trên thẻ bọc
  // `<div offsetx id="page_psid"><div class="media conversation-list-item">`.
  // => phải leo lên tối đa 7 cấp mới không bị "0 nhãn".
  function convIdOf(el) {
    let n = el, depth = 0;
    while (n && n.getAttribute && depth < 7) {
      const id = selfConvId(n);
      if (id) { if (n !== el) dom.idFromWrapper = true; return id; }
      n = n.parentElement; depth++;
    }
    return null;
  }

  // phần tử tìm được có thể là thẻ bọc -> lấy đúng dòng bên trong
  function rowOf(el) {
    if (!el) return null;
    try { if (el.matches(selRow())) return el; } catch (e) {}
    const inner = safeQuery(selRow(), el);
    return inner.length ? inner[0] : el;
  }

  let rowsCache = null, rowsCacheAt = 0;
  function dropRowsCache() { rowsCache = null; }

  /** Tìm dòng hội thoại: selector chuẩn → con của list → quét id toàn trang. */
  function findRows() {
    if (rowsCache && Date.now() - rowsCacheAt < 1200) return rowsCache;
    const out = findRowsNow();
    rowsCache = out; rowsCacheAt = Date.now();
    return out;
  }

  function findRowsNow() {
    let rows = safeQuery(selRow());
    if (rows.length) { dom.mode = 'selector'; return rows; }

    const cont = safeQuery(selList());
    if (cont.length) {
      const kids = cont[0].querySelectorAll('[id]');
      const good = [];
      for (let i = 0; i < kids.length; i++) {
        if (!selfConvId(kids[i])) continue;
        const r = rowOf(kids[i]);
        if (good.indexOf(r) < 0) good.push(r);
      }
      if (good.length) { dom.mode = 'list-children'; return good; }
    }

    const all = document.querySelectorAll('[id]');
    const good = [];
    for (let i = 0; i < all.length && good.length < 400; i++) {
      if (!selfConvId(all[i])) continue;
      const r = rowOf(all[i]);
      if (good.indexOf(r) < 0) good.push(r);
    }
    dom.mode = good.length ? 'id-scan' : 'none';
    return good;
  }

  /** Chỉ các dòng ĐANG HIỂN THỊ trong khung nhìn. */
  function visibleRows() {
    const rows = findRows();
    dom.rows = rows.length;
    if (!rows.length) { dom.visible = 0; return []; }

    const vh = window.innerHeight || 800;
    let top = 0, bottom = vh;
    const cont = safeQuery(selList());
    if (cont.length) {
      let cr; try { cr = cont[0].getBoundingClientRect(); } catch (e) { cr = null; }
      // chỉ tính phần GIAO giữa khung danh sách và khung nhìn (khung list có thể cao hơn màn hình)
      if (cr && cr.height > 0 && Math.min(vh, cr.bottom) > Math.max(0, cr.top)) {
        top = Math.max(0, cr.top);
        bottom = Math.min(vh, cr.bottom);
      }
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
    // querySelectorAll gộp nhiều selector sẽ trả về theo THỨ TỰ DOM, không phải thứ tự
    // ưu tiên (.name-module-text đứng trước .name-text) -> phải thử từng cái một.
    const sels = selName().split(',');
    for (let i = 0; i < sels.length; i++) {
      const sel = sels[i].trim();
      if (!sel) continue;
      const n = safeQuery(sel, row);
      for (let j = 0; j < n.length; j++) if ((n[j].textContent || '').trim()) return n[j];
    }
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

  function chipText(lead) {
    return SOURCE_SHORT[lead.source] || '?';
  }

  function chipTitle(lead) {
    const conf = lead.confidence === 'none' ? 'chưa kiểm tra' : CONF_LABEL[lead.confidence];
    return SOURCE_LABEL[lead.source] + ' · ' + conf +
      (lead.source === 'unknown' ? '\n(đang tải tin nhắn để kiểm tra — không đoán trước)' : '') +
      (lead.evidence.length ? '\n\nCăn cứ:\n• ' + lead.evidence.join('\n• ') : '') +
      '\n\n(Alt+O để ẩn/hiện)';
  }

  function makeChip(lead) {
    const chip = document.createElement('span');
    chip.className = '__ls_chip';
    chip.dataset.lsId = lead.id;
    chip.dataset.lsSource = lead.source;
    chip.textContent = chipText(lead);
    chip.title = chipTitle(lead);
    chip.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'background:' + SOURCE_COLOR[lead.source] + ';color:#fff;border-radius:999px;padding:0 5px;' +
      'font-size:9.5px;font-weight:700;line-height:15px;height:15px;margin-left:5px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;vertical-align:middle;' +
      'cursor:default;flex:0 0 auto;letter-spacing:.2px;white-space:nowrap;';
    return chip;
  }

  function updateChip(chip, lead) {
    const t = chipText(lead);
    if (chip.textContent !== t) chip.textContent = t;
    if (chip.dataset.lsSource !== lead.source) {
      chip.dataset.lsSource = lead.source;
      chip.style.background = SOURCE_COLOR[lead.source];
    }
    const title = chipTitle(lead);
    if (chip.title !== title) chip.title = title;
  }

  function decorate() {
    if (!CFG.enabled || !CFG.showChips || document.hidden) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const rows = visibleRows();
    dom.labeled = 0; dom.noName = 0; dom.idFromWrapper = false;
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
      const checked = state.msgs.has(convId) || state.attr.has(convId);
      const lead = cachedLead(conv, msgs, checked, now);
      if (!checked && CFG.enrichVisible) needEnrich.push(conv);

      let chip = chips.get(convId);
      if (chip && chip.parentElement && row.contains(chip)) {
        if (chip.dataset.lsSig !== lead.sig) { updateChip(chip, lead); chip.dataset.lsSig = lead.sig; }
        dom.labeled++;
        return;
      }
      if (chip) chips.delete(convId);
      chip = row.querySelector('.__ls_chip');
      if (chip) { chips.set(convId, chip); updateChip(chip, lead); chip.dataset.lsSig = lead.sig; dom.labeled++; return; }

      // 3 đường gắn, luôn cố cho nhãn xuất hiện thay vì bỏ qua dòng
      const nameEl = nameNode(row);
      const c = makeChip(lead);
      let placed = false;
      if (nameEl) {
        try { nameEl.insertAdjacentElement('afterend', c); placed = true; } catch (e) {}
      }
      if (!placed) {
        const snip = safeQuery(selSnippet(), row);
        if (snip.length) { try { snip[0].insertAdjacentElement('beforebegin', c); placed = true; } catch (e) {} }
      }
      if (!placed) {
        try { row.insertAdjacentElement('afterbegin', c); placed = true; } catch (e) {}
      }
      if (!placed) { dom.noName++; return; }
      c.dataset.lsSig = lead.sig;
      chips.set(convId, c);
      dom.labeled++;
    });

    queueEnrich(needEnrich);
    dom.ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
  }

  // Cache kết quả phân loại: Pancake re-render liên tục, không thể build lại từ đầu mỗi lần.
  const leadCache = new Map();
  let leadEpoch = -1;

  function cachedLead(conv, msgs, checked, now) {
    if (leadEpoch !== state.version) { leadCache.clear(); leadEpoch = state.version; }
    const key = conv.id || '';
    const unread = Number(conv.unread_count || 0) || 0;
    const attr = state.attr.get(key);
    const aSig = attr ? (attr.ad.length ? 'A' + attr.adId : (attr.post ? 'P' : (attr.live ? 'L' : '-'))) : '-';
    const extra = unread + ':' + (checked ? (msgs ? msgs.length : 0) : -1) + ':' + (conv._fromDom ? 'd' : 'a') + ':' + aSig;
    const hit = leadCache.get(key);
    if (hit && hit.extra === extra) return hit.lead;
    const lead = buildLead(conv, msgs || [], now, checked, attr);
    lead.sig = lead.source + '|' + lead.confidence + '|' + lead.evidence.length + '|' + unread;
    if (leadCache.size > 3000) leadCache.clear();
    leadCache.set(key, { extra: extra, lead: lead });
    return lead;
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

  // Gắn nhãn NGAY (không chờ timer) — dùng khi bật lại giao diện hoặc khi tab được focus lại.
  function decorateNow() {
    if (decorTimer) { clearTimeout(decorTimer); decorTimer = null; }
    lastDecor = Date.now();
    try { decorate(); } catch (e) { LOG('decorate lỗi', e); }
    schedulePaint();
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
    .btn.toggle { font-weight: 700; padding: 0 7px; }
    .btn.toggle.on { background: #7c3aed; color: #fff; border-color: #7c3aed; }
    .kind { min-width: 30px; text-align: center; font-weight: 800; font-size: 12px; line-height: 1.2;
             letter-spacing: .3px; padding-top: 1px; }
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
    fab = null;                       // bị React/Pancake xoá -> dựng lại
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

  // xếp theo LOẠI TIN (quảng cáo → bài viết → live → tự nhắn → chưa kiểm tra), cùng loại thì mới nhất trước
  function sortLeads(a, b) {
    const d = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
    if (d) return d;
    return (b.at || 0) - (a.at || 0);
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
      sym('?', SOURCE_COLOR.unknown, 'Chưa kiểm tra') +
      '<span class="sym">? = chưa đọc tin nhắn (không đoán trước)</span>' +
      '</div>';
  }

  function itemHtml(r, pending) {
    const conf = r.confidence === 'high' ? '' : ' · ' + CONF_LABEL[r.confidence];
    const tip = esc(r.evidence.join('\n') || 'chưa có căn cứ');
    return '<div class="item" data-id="' + esc(r.id) + '" data-act="focus" title="' + tip + '">' +
      '<div class="kind" style="color:' + SOURCE_COLOR[r.source] + '">' + SOURCE_SHORT[r.source] + '</div>' +
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
    state.convs.forEach((c, id) => all.push(cachedLead(c, state.msgs.get(id), state.msgs.has(id), now)));
    all.sort(sortLeads);

    const sig = state.version + '|' + all.length + '|' + all.slice(0, CFG.topN).map(r => r.id + r.source + r.at).join(',');
    if (!force && sig === paintSig) return;
    paintSig = sig;

    const counts = { ads: 0, post: 0, live: 0, organic: 0, unknown: 0 };
    all.forEach(r => { counts[r.source] = (counts[r.source] || 0) + 1; });
    const unverified = all.filter(r => r.source === 'unknown').length;

    const wrap = shadow.getElementById('wrap');
    if (!wrap) return;
    const wasCollapsed = wrap.classList.contains('collapsed');
    const prevList = shadow.querySelector('.list');
    const scrollTop = prevList ? prevList.scrollTop : 0;

    wrap.innerHTML =
      '<div class="hd"><span class="dot"></span><span class="t">Tệp khách</span>' +
      '<span class="cnt" style="padding:1px 6px"><b>' + all.length + '</b></span><span class="grow"></span>' +
      '<button class="btn toggle ' + (CFG.showChips ? 'on' : '') + '" data-act="chips" title="Bật/tắt nhãn trên dòng chat">' +
        (CFG.showChips ? '🏷️ Nhãn BẬT' : '🚫 Nhãn TẮT') + '</button>' +
      '<button class="btn ' + (unverified ? '' : 'on') + '" data-act="retry" title="Đọc lại tin nhắn cho các dòng đang hiển thị">🔁' +
        (unverified ? ' ' + unverified : '') + '</button>' +
      '<span class="kbd">Alt+O = đóng bảng</span>' +
      '<button class="btn ' + (CFG.showLegend ? 'on' : '') + '" data-act="legend" title="Bảng kí hiệu">?</button>' +
      '<button class="btn" data-act="hidePanel" title="Ẩn bảng — nhãn trên dòng chat vẫn hiện">▭</button>' +
      '<button class="btn" data-act="collapse" title="Thu gọn">' + (wasCollapsed ? '▾' : '▴') + '</button>' +
      '<button class="btn" data-act="off" title="Đóng bảng — nhãn vẫn hiện (Alt+O)">✕</button></div>' +
      '<div class="counts">' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.ads + '"></i>Quảng cáo <b>' + counts.ads + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.post + '"></i>Bài viết <b>' + counts.post + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.live + '"></i>Live <b>' + counts.live + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.organic + '"></i>Tự nhắn <b>' + counts.organic + '</b></span>' +
      '<span class="cnt"><i style="background:' + SOURCE_COLOR.unknown + '"></i>Chưa kiểm tra <b>' + unverified + '</b></span></div>' +
      (all.length ? '<div class="list">' + all.slice(0, CFG.topN).map(r => itemHtml(r, !state.msgs.has(r.id))).join('') + '</div>'
        : '<div class="empty">Chưa đọc được danh sách hội thoại.<br>Mở trang <b>Hội thoại</b> của Pancake — script tự đọc '
          + 'dữ liệu và gắn nhãn cho các dòng đang hiển thị.</div>') +
      legendHtml() +
      '<div class="ft"><span>' + (state.lastSync ? 'đồng bộ ' + hhmm(new Date(state.lastSync).toISOString()) + ' trước' : 'chưa đồng bộ') +
      ' · ' + dom.rows + ' dòng' + (dom.mode !== 'selector' && dom.mode !== 'none' ? ' (' + dom.mode + ')' : '') + '</span>' +
      '<span class="' + (state.errors.length || (dom.rows && !dom.labeled) ? 'err' : '') + '">' +
      esc(state.errors.length ? state.errors[state.errors.length - 1].msg
        : (dom.rows && !dom.labeled ? 'không gắn được nhãn → __leadSource.debug()'
          : (dom.rows ? dom.labeled + ' nhãn / ' + dom.visible + ' đang hiện' +
            (dom.noName ? ' · ' + dom.noName + ' dòng thiếu tên' : '') : 'chưa thấy dòng hội thoại'))) + '</span></div>';

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
    if (act === 'hidePanel') { setPanel(false); return; }
    if (act === 'chips') {
      // CHỈ bật/tắt nhãn trên dòng chat — script vẫn chạy bình thường
      CFG.showChips = !CFG.showChips;
      saveCfg({ showChips: CFG.showChips });
      if (CFG.showChips) decorateNow();
      else { chips.clear(); clearChips(); }
      paint(true);
      LOG(CFG.showChips ? 'đã bật nhãn trên dòng chat' : 'đã tắt nhãn trên dòng chat (script vẫn cập nhật ngầm)');
      return;
    }
    if (act === 'retry') {
      state.enrichTried.clear();
      state.enrichFail = 0;
      state.msgs.clear();
      decorateNow();
      paint(true);
      LOG('đang đọc lại tin nhắn cho các dòng đang hiển thị…');
      return;
    }
    if (act === 'off') {
      // đóng BẢNG. Nhãn trên dòng chat vẫn hiện (chỉ nút 🏷️ Nhãn mới tắt nhãn)
      setPanel(false);
      LOG('đã đóng bảng — nhãn vẫn hiện. Muốn tắt nhãn: bấm 🏷️ Nhãn (trong bảng) hoặc __leadSource.set({showChips:false})');
      return;
    }
    if (!id) return;
    const conv = state.convs.get(id) || { id: id };
    if (act === 'copy') {
      const lead = buildLead(conv, state.msgs.get(id) || [], Date.now(), state.msgs.has(id), state.attr.get(id));
      navigator.clipboard.writeText(lead.name + ' | psid ' + lead.psid + ' | ' + lead.sourceLabel + ' | ' +
        lead.sourceLabel + ' | ' + lead.evidence.slice(0, 2).join(' ; ') + ' | ' + lead.snippet.replace(/\n/g, ' '))
        .then(() => { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📋'; }, 1200); })
        .catch(() => {});
      return;
    }
    if (act === 'focus') focusInList(conv);
  }

  function focusInList(conv) {
    if (!conv || !conv.id) return;
    const chip = document.querySelector('.__ls_chip[data-ls-id="' + cssEscape(conv.id) + '"]');
    const row = (chip && chip.closest(selRow())) || document.getElementById(conv.id) ||
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
  /** Ẩn/hiện BẢNG — không liên quan tới nhãn trên dòng chat. */
  function setPanel(show) {
    CFG.showPanel = !!show;
    saveCfg({ showPanel: CFG.showPanel });
    if (!CFG.showPanel) {
      if (host) host.style.display = 'none';
    } else if (CFG.enabled) {
      ensureHost();
      host.style.display = '';
      paint(true);
    }
    syncFab();
    return CFG.showPanel;
  }

  function setEnabled(on) {
    CFG.enabled = !!on;
    saveCfg({ enabled: CFG.enabled });
    if (!CFG.enabled) {
      stopLoops();            // dừng hẳn: không quét, không poll, không fetch, không observer
      chips.clear();
      clearChips();
      dom.labeled = 0; dom.rows = 0; dom.visible = 0;
      if (host) host.style.display = 'none';
    } else {
      ensureHost();
      host.style.display = '';
      attachObserver();
      startLoops();
      paint(true);
      decorateNow();
      setTimeout(() => { if (CFG.enabled) tick(); }, 600);   // cập nhật lại danh sách ngay khi bật
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
    if (!CFG.enabled) { setEnabled(true); return; }
    setPanel(!CFG.showPanel);
    LOG(CFG.showPanel ? 'đã mở bảng (nhãn vẫn hiện)' : 'đã đóng bảng — nhãn vẫn hiện, dùng nút 🏷️ Nhãn để tắt nhãn');
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
    if (!mo) mo = new MutationObserver(() => { dropRowsCache(); scheduleDecor(); });
    if (moTarget) { try { mo.disconnect(); } catch (e) { /* ignore */ } }
    moTarget = target;
    mo.observe(target, { childList: true, subtree: true });
  }

  let scrollTimer = null;
  function onScroll() {
    if (!CFG.enabled) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => { scrollTimer = null; if (CFG.enabled) scheduleDecor(true); }, 120);
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  // ---- vòng chạy: BẬT thì mới chạy, TẮT là dừng sạch (không timer, không observer, không fetch)
  const loops = { poll: null, scan: null, paint: null };

  function scanTick() {
    if (document.hidden) return;
    syncFab();                              // giữ nút bật lại luôn tồn tại
    if (!CFG.enabled || !CFG.showChips) return;
    attachObserver();
    if (dom.rows && !dom.labeled) { chips.clear(); decorateNow(); }   // tự phục hồi
    else scheduleDecor(true);
  }

  function startLoops() {
    if (loops.poll) return;                 // đã chạy rồi
    if (CFG.pollMs > 0) loops.poll = setInterval(tick, Math.max(8000, CFG.pollMs));
    loops.scan = setInterval(scanTick, Math.max(800, CFG.scanMs));
    loops.paint = setInterval(() => { if (CFG.enabled && CFG.showPanel) schedulePaint(); }, 3000);
  }

  function stopLoops() {
    ['poll', 'scan', 'paint'].forEach(k => {
      if (loops[k]) { clearInterval(loops[k]); loops[k] = null; }
    });
    if (enrichTimer) { clearTimeout(enrichTimer); enrichTimer = null; }
    while (enrichTimers.length) clearTimeout(enrichTimers.pop());
    if (decorTimer) { clearTimeout(decorTimer); decorTimer = null; }
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    if (mo) { try { mo.disconnect(); } catch (e) { /* ignore */ } mo = null; moTarget = null; }
    state.enriching.clear();
  }

  function start() {
    attachObserver();
    scheduleDecor(true);
    paint(true);
    syncFab();
    if (CFG.enabled) startLoops();
    else syncFab();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // quay lại tab -> gắn lại ngay (trong lúc ẩn tab Pancake có thể đã render lại danh sách)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && CFG.enabled) { attachObserver(); decorateNow(); }
  });

  // ======================================================================
  // 10. API console
  // ======================================================================
  window.__leadSource = {
    cfg: CFG,
    state: state,
    get visible() { return !!CFG.enabled; },
    get leads() {
      const now = Date.now(), out = [];
      state.convs.forEach((c, id) => out.push(cachedLead(c, state.msgs.get(id), state.msgs.has(id) || state.attr.has(id), now)));
      return out.sort(sortLeads);
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
        rowsNoName: dom.noName,
        unverified: Array.from(state.convs.keys()).filter(k => !state.msgs.has(k)).length,
        running: !!(loops.scan || loops.poll),
        decorateMs: dom.ms || 0,
        enrichFail: state.enrichFail || 0,
        wsHits: state.wsHits || 0,
        enrichLast: state.enrichDbg || null,
        idFromWrapper: dom.idFromWrapper,
        rowHasOwnId: !!(sample && selfConvId(sample)),
        sampleConvId: sample ? convIdOf(sample) : null,
        nameNodeFound: sample ? !!nameNode(sample) : null,
        selectors: { list: selList(), row: selRow(), name: selName() },
        sampleRowHtml: sample ? String(sample.outerHTML).slice(0, 1200) : null,
        errors: state.errors.map(e => e.msg),
      };
      rep.verdict = !rep.rowsFound ? 'không thấy dòng hội thoại nào (kiểm tra selectors.row)'
        : (!rep.sampleConvId ? 'thấy dòng nhưng KHÔNG đọc được id hội thoại'
          : (!rep.rowsWithChip ? 'đọc được id nhưng chưa gắn được nhãn (kiểm tra enabled/showChips/tab ẩn)'
            : 'OK'));
      console.log('%c[lead-source] chẩn đoán', 'color:#7c3aed;font-weight:700', rep);
      try {
        navigator.clipboard.writeText(JSON.stringify(rep, null, 2));
        LOG('đã copy báo cáo chẩn đoán — dán cho dev là biết sửa gì');
      } catch (e) { /* ignore */ }
      return rep;
    },
    help: function () {
      LOG('Nhãn: QC = quảng cáo · BV = bài viết · LV = livestream · TN = tự nhắn · ? = chưa đọc tin nhắn (không đoán)' +
        '\n🏷️ Nhãn BẬT/TẮT = nút duy nhất tắt nhãn trên dòng chat' +
        '\nAlt+O / ✕ / ▭ = đóng bảng — NHÃN VẪN HIỆN' +
        '\nMuốn dừng hẳn script: __leadSource.set({enabled:false})' +
        '\nChỉ xem tin nhắn của dòng đang hiển thị:  __leadSource.set({enrichVisible: false}) để tắt' +
        '\nMap tag id:  __leadSource.set({tagMap: {"83": {name:"Từ quảng cáo", source:"ads"}}})' +
        '\nMap tên tag trên dòng chat:  __leadSource.set({tagNameSource: {"QC": "ads", "LIVE": "live"}})' +
        '\nNhịp quét:   __leadSource.set({scanMs: 2000, pollMs: 30000})');
    },
  };

  if (!CFG.enabled) {
    LOG('script ĐANG TẮT (lưu từ lần trước) — không quét, không gọi mạng. Bấm nút 🏷️ góc phải hoặc Alt+O để bật.');
  }
  LOG('v' + VERSION + ' đã bật · Alt+O ẩn/hiện · chỉ xử lý dòng đang hiển thị · __leadSource.debug() để chẩn đoán');
})();

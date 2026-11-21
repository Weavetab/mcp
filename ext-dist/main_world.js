(function () {
  if (window.__wt_mainWorldLoaded) return;
  window.__wt_mainWorldLoaded = true;

  function shadowQuery(selector, all) {
    var out = all ? [] : null;
    function walk(root) {
      if (!root) return null;
      if (all) {
        try { out.push.apply(out, root.querySelectorAll(selector)); } catch (_) {}
      } else {
        try {
          var hit = root.querySelector(selector);
          if (hit) return hit;
        } catch (_) {}
      }
      var nodes = root.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) {
          var sub = walk(nodes[i].shadowRoot);
          if (!all && sub) return sub;
        }
      }
      return null;
    }
    var single = walk(document);
    return all ? out : single;
  }

  function isOccluded(el) {
    var rect = el.getBoundingClientRect();
    var topEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return topEl !== el && !el.contains(topEl);
  }

  function getStableSelector(el) {
    if (el.id) {
      var esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
      return '#' + esc;
    }
    var parts = [];
    while (el && el.parentNode && el.tagName) {
      var index = 1;
      var sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName === el.tagName) index++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      el = el.parentNode;
    }
    return parts.join(' > ');
  }

  // passive data-wt-id assignment + live index in main world so cdp helpers read real dom state
  var interactiveSel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  window.__wt_liveIndex = window.__wt_liveIndex || [];
  window.__wt_nextId = window.__wt_nextId || 1;

  var io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var id = entries[i].target.getAttribute('data-wt-id');
      if (!id) continue;
      for (var j = 0; j < window.__wt_liveIndex.length; j++) {
        if (window.__wt_liveIndex[j].id === id) {
          window.__wt_liveIndex[j].isVisible = entries[i].isIntersecting;
          window.__wt_liveIndex[j].intersectionRatio = entries[i].intersectionRatio;
          break;
        }
      }
    }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] }) : null;

  function refreshEntry(cur) {
    var el = cur._el && cur._el.isConnected ? cur._el : document.querySelector('[data-wt-id="' + cur.id + '"]');
    if (!el) return cur;
    cur._el = el;
    var rect = el.getBoundingClientRect();
    var inVp = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    cur.x = Math.round(rect.left + rect.width / 2);
    cur.y = Math.round(rect.top + rect.height / 2);
    cur.viewport = inVp ? 'visible' : (rect.top >= window.innerHeight ? 'below' : 'above');
    cur.isVisible = inVp;
    cur.rect = { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    cur.label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 60) || '';
    return cur;
  }

  function indexEl(el) {
    if (!el || el.hasAttribute('data-wt-ignore')) return;
    var existingId = el.getAttribute('data-wt-id');
    var label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 60) || '';

    if (existingId) {
      for (var i = 0; i < window.__wt_liveIndex.length; i++) {
        var cur = window.__wt_liveIndex[i];
        if (cur.id === existingId) {
          cur.label = label;
          cur._el = el;
          return;
        }
      }
      return;
    }

    var id = String(window.__wt_nextId++);
    el.setAttribute('data-wt-id', id);
    el.__wt_id = id;
    var entry = {
      id: id,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      label: label,
      placeholder: el.getAttribute('placeholder') || '',
      selector: getStableSelector(el),
      x: 0,
      y: 0,
      viewport: 'visible',
      href: el.href || null,
      isVisible: true,
      intersectionRatio: 1.0,
      hasClickListener: el.onclick !== null,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      _el: el
    };
    window.__wt_liveIndex.push(entry);
    if (io) { try { io.observe(el); } catch (_) {} }
  }

  function unindexEl(el) {
    var id = el.getAttribute && el.getAttribute('data-wt-id');
    if (!id) return;
    for (var i = window.__wt_liveIndex.length - 1; i >= 0; i--) {
      if (window.__wt_liveIndex[i].id === id) window.__wt_liveIndex.splice(i, 1);
    }
    if (io) { try { io.unobserve(el); } catch (_) {} }
  }

  var idObs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      for (var a = 0; a < m.addedNodes.length; a++) {
        var n = m.addedNodes[a];
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(interactiveSel)) indexEl(n);
        if (n.querySelectorAll) {
          var d = n.querySelectorAll(interactiveSel);
          for (var k = 0; k < d.length; k++) indexEl(d[k]);
        }
      }
      for (var r = 0; r < m.removedNodes.length; r++) {
        var rn = m.removedNodes[r];
        if (rn.nodeType !== 1) continue;
        if (rn.getAttribute && rn.getAttribute('data-wt-id')) unindexEl(rn);
        if (rn.querySelectorAll) {
          var rd = rn.querySelectorAll('[data-wt-id]');
          for (var rk = 0; rk < rd.length; rk++) unindexEl(rd[rk]);
        }
      }
    }
  });

  function startIndexing() {
    if (!document.body) return;
    var existing = document.querySelectorAll(interactiveSel);
    for (var i = 0; i < existing.length; i++) indexEl(existing[i]);
    idObs.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startIndexing, { once: true });
  } else {
    startIndexing();
  }

  window.__Weavetab = {
    version: '2.6.4',
    suppressVisuals: false,
    shadowQuery: function (sel) { return shadowQuery(sel, false); },

    getScrollInfo: function () {
      var vv = window.visualViewport || {};
      var body = document.body || document.documentElement;
      return {
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        viewportW: Math.round(vv.width || window.innerWidth),
        viewportH: Math.round(vv.height || window.innerHeight),
        pageW: Math.round(body.scrollWidth),
        pageH: Math.round(body.scrollHeight),
        maxScrollX: Math.round(Math.max(0, body.scrollWidth - window.innerWidth)),
        maxScrollY: Math.round(Math.max(0, body.scrollHeight - window.innerHeight)),
        scrollRatio: body.scrollHeight > 0 ? +(window.scrollY / body.scrollHeight).toFixed(3) : 0
      };
    },

    waitForStable: function (quietMs, timeoutMs) {
      quietMs = quietMs || 300;
      timeoutMs = timeoutMs || 5000;
      return new Promise(function (resolve) {
        var timer = null;
        var deadline = setTimeout(function () {
          obs.disconnect();
          resolve(false);
        }, timeoutMs);
        function reset() {
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            clearTimeout(deadline);
            obs.disconnect();
            resolve(true);
          }, quietMs);
        }
        var obs = new MutationObserver(reset);
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        reset();
      });
    },

    getElementByWtId: function (id) {
      var idx = window.__wt_liveIndex || [];
      var entry = null;
      for (var i = 0; i < idx.length; i++) {
        if (idx[i].id === String(id)) { entry = idx[i]; break; }
      }
      if (!entry) return null;
      return refreshEntry(entry);
    },

    getFormValues: function () {
      var out = [];
      var els = document.querySelectorAll('input, select, textarea');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.hasAttribute('data-wt-ignore')) continue;
        var rawVal = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
        var val = el.type === 'password' ? '[REDACTED]' : rawVal;
        out.push({
          name: el.name || el.id || null,
          id: el.id || null,
          wtId: el.getAttribute('data-wt-id') || null,
          type: el.type || el.tagName.toLowerCase(),
          tag: el.tagName.toLowerCase(),
          value: val,
          placeholder: el.placeholder || null
        });
      }
      return out;
    },

    checkVisible: function (selector) {
      var el = document.querySelector(selector) || shadowQuery(selector, false);
      if (!el) return { found: false };
      var r = el.getBoundingClientRect();
      var vv = window.visualViewport || {};
      var vw = vv.width || window.innerWidth;
      var vh = vv.height || window.innerHeight;
      var visible = r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
      var topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        found: true,
        visible: visible,
        occluded: topEl !== el && !el.contains(topEl),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      };
    },

    getLiveIndex: function (filter) {
      var idx = window.__wt_liveIndex || [];
      for (var i = 0; i < idx.length; i++) refreshEntry(idx[i]);
      if (filter === 'all') return idx;
      return idx.filter(function (e) { return e.viewport === 'visible' || e.isVisible; });
    },

    popUserFeedback: function () {
      try {
        var raw = localStorage.getItem('__wt_chat_queue_persist');
        if (!raw) return null;
        var arr = JSON.parse(raw);
        if (!arr || !arr.length) return null;
        var item = arr.shift();
        localStorage.setItem('__wt_chat_queue_persist', JSON.stringify(arr));
        return item;
      } catch (_) {
        return null;
      }
    },

    getAlertState: function () {
      return { pending: !!(window.__wt_alertPending), ts: Date.now() };
    }
  };

  window.__Weavetab_shadowQuery = function (selector) {
    return shadowQuery(selector, false);
  };
  window.__Weavetab_shadowQuery_all = function (selector) {
    return shadowQuery(selector, true);
  };

  window.__Weavetab_getCoords = function (selector) {
    var el = document.querySelector(selector) || shadowQuery(selector, false);
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, height: window.innerHeight };
    return {
      x: rect.left + rect.width / 2 + (vv.offsetLeft || 0),
      y: rect.top + rect.height / 2 + (vv.offsetTop || 0),
      raw: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
      occluded: isOccluded(el),
      visible: rect.width > 0 && rect.height > 0 && rect.top < (vv.height || window.innerHeight) && rect.bottom > 0
    };
  };

  window.__Weavetab_fullMap = function () {
    var map = [];
    var idCounter = window.__wt_nextId || 1;
    function crawl(root, depth) {
      var list = root.querySelectorAll('a,button,input,select,textarea,[role],[onclick],[tabindex]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.hasAttribute('data-wt-ignore')) continue;
        var rect = el.getBoundingClientRect();
        var essential = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON';
        if (rect.width === 0 && !essential) continue;
        var id = el.getAttribute('data-wt-id');
        if (!id) {
          id = String(idCounter++);
          el.setAttribute('data-wt-id', id);
        }
        map.push({
          id: id,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
          role: el.getAttribute('role'),
          selector: '[data-wt-id="' + id + '"]',
          coords: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          inShadow: depth > 0
        });
      }
      var allNodes = root.querySelectorAll('*');
      for (var j = 0; j < allNodes.length; j++) {
        if (allNodes[j].shadowRoot) crawl(allNodes[j].shadowRoot, depth + 1);
      }
    }
    crawl(document, 0);
    window.__wt_nextId = idCounter;
    return map;
  };

  var consoleBuf = [];
  var consoleCursor = 0;
  ['log', 'warn', 'error', 'info', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      var text = args.map(function (a) {
        try {
          return typeof a === 'symbol' ? a.toString() : String(a);
        } catch (_) {
          return '[object]';
        }
      }).join(' ');
      consoleBuf.push({ level: level, time: Date.now(), text: text });
      if (consoleBuf.length > 500) consoleBuf.shift();
      return orig.apply(console, args);
    };
  });

  window.__Weavetab_readConsole = function (opts) {
    var cfg = opts || {};
    var since = cfg.since === undefined ? 'last' : cfg.since;
    var level = cfg.level || null;
    var from = since === 'last' ? consoleCursor : 0;
    var entries = consoleBuf.slice(from);
    consoleCursor = consoleBuf.length;
    return level ? entries.filter(function (e) { return e.level === level; }) : entries;
  };

  window.__wt_chat_queue = window.__wt_chat_queue || [];

  ['alert', 'confirm', 'prompt'].forEach(function (fn) {
    var orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function () {
      window.__wt_alertPending = true;
      window.postMessage({ type: '__WT_ALERT_STATE', waiting: true }, '*');
      try {
        return orig.apply(window, arguments);
      } finally {
        window.__wt_alertPending = false;
        window.postMessage({ type: '__WT_ALERT_STATE', waiting: false }, '*');
      }
    };
  });
})();

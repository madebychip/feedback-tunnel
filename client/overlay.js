/* feedback-tunnel overlay. Injected into every HTML page by the review proxy.
   Everything renders inside one shadow root so the prototype's CSS can't touch it. */
(() => {
  'use strict';
  if (window.__feedbackTunnel || window.top !== window.self) return;
  window.__feedbackTunnel = true;

  const API = '/__ft/api';
  const KEY_ME = 'feedback-tunnel:me';
  const KEY_SEEN = 'feedback-tunnel:seen';
  const PIN = 32;
  const NARROW = 560;
  const touch = matchMedia('(hover: none)').matches;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  const S = {
    isHost: false, me: null,
    comments: [], version: -1, failures: 0, offline: false,
    mode: 'browse', path: pagePath(), open: null, composer: null,
    panel: false, showResolved: true, hover: null, hlFor: null,
  };
  const pins = new Map(); // id -> { c, el, tried, clips, dom, x, y, vis, orphan }
  const ui = {};
  let hostEl, root, cursorEl;

  // The overlay follows the *visual* viewport. On phones, a prototype that is
  // wider than the screen stretches the layout viewport, and plain fixed
  // positioning would push the toolbar off-screen. Pinch-zoom is handled too.
  const V = { x: 0, y: 0, s: 1, w: innerWidth, h: innerHeight, key: '' };
  function syncViewport() {
    const vv = window.visualViewport;
    const x = vv ? vv.offsetLeft : 0;
    const y = vv ? vv.offsetTop : 0;
    const sc = vv ? vv.scale : 1;
    const w = (vv ? vv.width : innerWidth) * sc;
    const hh = (vv ? vv.height : innerHeight) * sc;
    const key = `${x}|${y}|${sc}|${w}|${hh}`;
    if (key === V.key) return;
    Object.assign(V, { x, y, s: sc, w, h: hh, key });
    root.style.width = `${w}px`;
    root.style.height = `${hh}px`;
    root.style.transform = `translate(${x}px, ${y}px) scale(${1 / sc})`;
  }
  // Layout-viewport client coordinates -> overlay coordinates.
  const mapX = (x) => (x - V.x) * V.s;
  const mapY = (y) => (y - V.y) * V.s;

  const saved = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---- Small helpers --------------------------------------------------------

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'html') el.innerHTML = v; // static icon markup only, never user text
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const I = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 20V12a8 8 0 1 1 8 8z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  function ink(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.56 ? '#202124' : '#ffffff';
  }
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const ours = (e) => e.composedPath().includes(hostEl);
  const isEditable = (n) => n && n.nodeType === 1 && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));

  function pagePath() {
    const hash = location.hash;
    return location.pathname + (hash.startsWith('#/') ? hash : '');
  }

  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function browserName() {
    const u = navigator.userAgent;
    const b = /Edg\//.test(u) ? 'Edge' : /Firefox\/|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
    const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
      : /Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  }

  // Shadcn/Tailwind's -500 step: readable on white, and ink() (below) already
  // knows which of these need dark text instead of white (the warm ones do).
  const PALETTE = ['#ef4444', '#f97316', '#22c55e', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6'];
  const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

  function initial(name) {
    const t = String(name || '').trim();
    return t ? t[0].toUpperCase() : '?';
  }

  // `author` is either a comment's `.author`, `S.me`, or a live preview of one:
  // whatever it is, all that matters here is { name, color }.
  function avatar(author, size) {
    const color = author?.color || '#80868b';
    const el = h('span', {
      class: 'av',
      'aria-hidden': 'true',
      style: `--c:${color};--ci:${ink(color)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px`,
    });
    el.textContent = initial(author?.name);
    return el;
  }

  function meColor() {
    return S.me ? S.me.color : '#1a73e8';
  }

  // ---- Describing and re-finding elements -----------------------------------

  // Visible-ish text with a space between blocks ("Bali Kintamani Citrus…", not "Bali KintamaniCitrus…").
  function textOf(el, max = 160) {
    if (!el.firstElementChild) return el.textContent || '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentNode.nodeName) ? 2 : 1),
    });
    let out = '';
    for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) out += ' ' + n.nodeValue;
    return out;
  }

  function elementText(el) {
    let t = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
    if (!t && /^(INPUT|TEXTAREA)$/.test(el.tagName)) t = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    if (!t) t = textOf(el);
    return t.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  const KINDS = {
    a: 'Link', img: 'Image', svg: 'Icon', picture: 'Image', video: 'Video', canvas: 'Canvas', iframe: 'Embed',
    input: 'Field', textarea: 'Field', select: 'Dropdown', nav: 'Navigation', header: 'Header', footer: 'Footer',
    main: 'Main content', section: 'Section', article: 'Article', aside: 'Sidebar', form: 'Form', ul: 'List',
    ol: 'List', li: 'List item', p: 'Paragraph', label: 'Label', table: 'Table', dialog: 'Dialog',
  };

  function humanLabel(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind;
    if (tag === 'button' || role === 'button' || (tag === 'input' && /^(button|submit|reset)$/.test(el.type))) kind = 'Button';
    else if (/^h[1-6]$/.test(tag)) kind = 'Heading';
    else if (role === 'img') kind = 'Image';
    else if (KINDS[tag]) kind = KINDS[tag];
    else kind = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ? 'Text' : 'Box';
    let t = elementText(el);
    if (!/^(Button|Link|Heading|Field|Dropdown|Text|Paragraph|Label)$/.test(kind)) {
      const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading) t = elementText(heading);
    }
    if (!t) return kind;
    return `${kind} “${t.length > 32 ? t.slice(0, 31) + '…' : t}”`;
  }

  const generatedId = (id) => /[:.]|radix|headlessui|react-aria|mui-|\d{3,}/i.test(id);

  // Structural path (tags + positions). Classes are left out on purpose:
  // Tailwind and CSS-module class names change too often to re-find anything.
  function selectorFor(el) {
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id) && !generatedId(cur.id)
        && document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
        parts.unshift('#' + CSS.escape(cur.id));
        return parts.join(' > ');
      }
      const tid = cur.getAttribute('data-testid');
      if (tid) {
        const s = `[data-testid="${tid.replace(/"/g, '\\"')}"]`;
        if (document.querySelectorAll(s).length === 1) {
          parts.unshift(s);
          return parts.join(' > ');
        }
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function readableClasses(el) {
    const raw = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return raw.split(/\s+/)
      .filter((c) => c && c.length < 40 && !/[:[\]/!@]/.test(c) && !/^(css|sc|jsx|emotion|svelte)-[\w-]+$/i.test(c))
      .slice(0, 6).join(' ');
  }

  const shortFile = (f) => {
    const s = String(f).replace(/\\/g, '/');
    const i = s.lastIndexOf('/src/');
    return i >= 0 ? s.slice(i + 1) : s.split('/').slice(-3).join('/');
  };
  const FRAMEWORK = /^(Anonymous|Fragment|Suspense|StrictMode|Router|LayoutRouter|InnerLayoutRouter|OuterLayoutRouter|RenderFromTemplateContext|HotReload|ReactDevOverlay|AppRouter|ServerRoot|Root|Head|Html|Body|SegmentViewNode|ClientPageRoot|ClientSegmentRoot|RouteAnnouncer|AppContainer|HistoryUpdater|SegmentBoundaryTriggerNode)$|(Provider|Consumer|Boundary|Context|Handler|Adapter)$|^(Inner|Outer)\w*(Router|Handler|Boundary)\w*$|ScrollAndFocus|ScrollAndMaybeFocus|ScrollHandler|DevRoot/;

  // Component names help a coding agent jump to the right file.
  function componentPath(el) {
    const out = [];
    try {
      let node = el;
      let key;
      while (node && !(key = Object.keys(node).find((k) => k.startsWith('__reactFiber$')))) node = node.parentElement;
      if (key) {
        for (let f = node[key]; f && out.length < 4; f = f.return) {
          const t = f.type;
          const name = typeof t === 'function' ? t.displayName || t.name
            : t && typeof t === 'object' ? t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name : null;
          if (!name || name.length < 3 || !/^[A-Z]/.test(name) || FRAMEWORK.test(name)) continue;
          if (out.length && out[out.length - 1].startsWith(name)) continue;
          const src = f._debugSource;
          out.push(src ? `${name} (${shortFile(src.fileName)}:${src.lineNumber})` : name);
        }
        return out;
      }
      let v = el;
      while (v && !v.__vueParentComponent) v = v.parentElement;
      for (let inst = v?.__vueParentComponent; inst && out.length < 4; inst = inst.parent) {
        const t = inst.type || {};
        const name = t.__name || t.name;
        if (name) out.push(t.__file ? `${name} (${shortFile(t.__file)})` : name);
      }
      if (out.length) return out;
      let s = el;
      while (s && !s.__svelte_meta) s = s.parentElement;
      const loc = s?.__svelte_meta?.loc;
      if (loc?.file) out.push(`${shortFile(loc.file)}:${loc.line}`);
    } catch {}
    return out;
  }

  // Clicking an icon usually lands on a <path>; pin the icon (or its button) instead.
  function pickTarget(node) {
    let el = node instanceof Element ? node : node?.parentElement;
    if (!el) return null;
    const svg = el.closest('svg');
    if (svg) el = svg.closest('button,a,[role="button"]') || svg;
    return el;
  }

  function describe(el, offset) {
    return {
      selector: selectorFor(el),
      text: elementText(el),
      tag: el.tagName.toLowerCase(),
      label: humanLabel(el),
      id: el.id || '',
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
      classes: readableClasses(el),
      components: componentPath(el),
      offset,
    };
  }

  function findByText(tag, text) {
    const probe = text.slice(0, 40);
    if (!tag || probe.length < 3) return null;
    const list = document.getElementsByTagName(tag);
    for (let i = 0; i < Math.min(list.length, 3000); i++) {
      if (elementText(list[i]).startsWith(probe)) return list[i];
    }
    return null;
  }

  function resolveAnchor(a) {
    let el = null;
    try { el = a.selector ? document.querySelector(a.selector) : null; } catch {}
    if (el && a.text && !elementText(el).startsWith(a.text.slice(0, 24))) {
      // Same spot, different content. If the original text lives elsewhere now, follow it;
      // otherwise stay put (the fix may have changed the copy).
      const moved = findByText(a.tag, a.text);
      if (moved) el = moved;
    }
    if (!el && a.text) el = findByText(a.tag, a.text);
    return el;
  }

  // Scroll containers that could hide the pin (e.g. a horizontal carousel).
  function clipsOf(el) {
    const out = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement && out.length < 12; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(p);
    }
    return out;
  }

  function insideClips(clips, x, y) {
    for (const c of clips) {
      const r = c.getBoundingClientRect();
      if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return false;
    }
    return true;
  }

  // ---- Styles ---------------------------------------------------------------

  const STYLES = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.root{position:fixed;left:0;top:0;width:100vw;height:100vh;transform-origin:0 0;pointer-events:none;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#202124;-webkit-font-smoothing:antialiased;color-scheme:light;--green:#188038;--sub:#5f6368;--line:rgba(32,33,36,.12);--hover:rgba(32,33,36,.06)}
.ui{pointer-events:auto}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--me);outline-offset:2px}
.field:focus-visible{outline:none}
h2,h3,p{margin:0}
.av{display:inline-grid;place-items:center;flex:none;border-radius:50%;background:var(--c);color:var(--ci);font-weight:650;line-height:1;overflow:hidden;user-select:none}
.av img{width:100%;height:100%;object-fit:cover;display:block}

.pins{position:absolute;inset:0}
.pin{position:absolute;left:0;top:0;width:${PIN}px;height:${PIN}px;perspective:240px;will-change:transform}
.pin .flip{position:absolute;inset:0;transform-style:preserve-3d}
.pin.resolved .flip{transform:rotateY(180deg)}
.face{position:absolute;inset:0;display:grid;place-items:center;border-radius:50% 50% 50% 3px;backface-visibility:hidden;-webkit-backface-visibility:hidden;box-shadow:0 1px 2px rgba(0,0,0,.24),0 4px 12px rgba(0,0,0,.18)}
.front{background:var(--c);border:2px solid #fff}
.back{background:var(--green);color:#fff;border:2px solid #fff;transform:rotateY(180deg)}
.back svg{width:16px;height:16px}
.pin:hover .front,.pin.active .front{box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 28%,transparent),0 4px 12px rgba(0,0,0,.2)}
.pin:hover .back,.pin.active .back{box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 28%,transparent),0 4px 12px rgba(0,0,0,.2)}
.num{position:absolute;top:-6px;right:-8px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#202124;color:#fff;font-size:10.5px;font-weight:650;line-height:17px;text-align:center;box-shadow:0 0 0 2px #fff;font-variant-numeric:tabular-nums}
.pin.resolved .num{display:none}
.pin.pop .flip{animation:drop .45s cubic-bezier(.34,1.56,.64,1)}
.pin.celebrate .flip{animation:flip .8s cubic-bezier(.34,1.56,.64,1) both}
.pin.celebrate::before,.pin.celebrate::after{content:"";position:absolute;inset:0;border-radius:50% 50% 50% 3px;border:2px solid var(--green);opacity:0;animation:ring 1.1s ease-out .4s}
.pin.celebrate::after{animation-delay:.7s}
@keyframes flip{0%{transform:rotateY(0) scale(1)}45%{transform:rotateY(90deg) scale(1.25)}100%{transform:rotateY(180deg) scale(1)}}
@keyframes ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(2.6)}}
@keyframes drop{0%{transform:translateY(-14px) scale(.5);opacity:0}}

.hl{position:fixed;left:0;top:0;border:2px solid var(--me);background:color-mix(in srgb,var(--me) 7%,transparent);border-radius:4px;transition:transform .07s,width .07s,height .07s}
.hl-label{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;max-width:min(320px,80vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--me);color:var(--mi);font-size:11.5px;font-weight:650;padding:3px 7px;border-radius:5px}
.hl.below .hl-label{bottom:auto;top:100%;margin:4px 0 0}
.hl.inside .hl-label{bottom:auto;top:4px;left:4px;margin:0}

.floating{position:absolute;inset:0;filter:drop-shadow(0 1px 1px rgba(0,0,0,.12)) drop-shadow(0 10px 22px rgba(0,0,0,.17))}
.note{position:fixed;left:0;top:0;width:296px;padding:14px 14px 18px;background:#fffdf6;background:color-mix(in srgb,var(--c) 12%,#fffdf6);border-radius:3px;clip-path:polygon(0 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%);animation:note-in .24s cubic-bezier(.2,.9,.3,1.15)}
.note::after{content:"";position:absolute;right:0;bottom:0;width:18px;height:18px;background:linear-gradient(135deg,color-mix(in srgb,var(--c) 34%,#fff) 50%,transparent 50%)}
.note.shake{animation:shake .32s}
@keyframes note-in{from{opacity:0;scale:.94;rotate:-1.5deg}}
@keyframes shake{25%{translate:-5px 0}75%{translate:5px 0}}
.note-head{display:flex;align-items:flex-start;gap:10px}
.who{display:flex;flex-direction:column;min-width:0;flex:1}
.who strong{font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{color:var(--sub);font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tag{font-size:11px;padding:0 6px;border-radius:4px;background:rgba(32,33,36,.07)}
.note-num{font-size:12px;font-weight:650;color:var(--sub);font-variant-numeric:tabular-nums;padding-top:3px}
.x{width:26px;height:26px;display:grid;place-items:center;border-radius:6px;color:var(--sub);margin:-2px -4px 0 0;flex:none}
.x:hover{background:var(--hover)}
.x svg{width:16px;height:16px}
.body{margin-top:10px;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
.on{margin-top:10px;font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gone{margin-top:6px;font-size:12px;color:#b06000}
.status{margin-top:12px;display:flex;align-items:center;gap:7px;color:var(--green);font-weight:650;font-size:12.5px}
.status .dot,.ok{flex:none;width:18px;height:18px;border-radius:50%;background:var(--green);color:#fff;display:grid;place-items:center}
.status .dot svg,.ok svg{width:11px;height:11px}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:12px}
.hint{margin-right:auto;font-size:11.5px;color:var(--sub);white-space:nowrap}
.btn{height:32px;padding:0 14px;border-radius:8px;font-weight:650;font-size:13px;white-space:nowrap}
.btn.primary{background:var(--c);color:var(--ci)}
.btn.primary:disabled{opacity:.6;cursor:default}
.btn.ghost{color:#3c4043}
.btn.ghost:hover{background:var(--hover)}
.btn.resolve{background:var(--green);color:#fff}
.btn.sm{height:28px;padding:0 10px;font-size:12.5px}
.field{display:block;width:100%;font:inherit;font-size:14px;font-weight:400;color:#202124;background:#fff;border:1px solid rgba(32,33,36,.2);border-radius:8px;padding:9px 11px;outline:none}
.field:focus{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 24%,transparent)}
.ta{margin-top:10px;resize:vertical;min-height:78px;line-height:1.45}
.err{margin-top:8px;color:#c5221f;font-size:12.5px}
.note.sheet{left:12px;right:12px;width:auto;top:calc(60px + env(safe-area-inset-top));transform:none!important}

.bar{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;padding:4px;background:#fff;border-radius:999px;border:1px solid rgba(32,33,36,.08);box-shadow:0 1px 2px rgba(0,0,0,.1),0 8px 24px rgba(0,0,0,.14)}
.bar-me{width:36px;height:36px;display:grid;place-items:center;border-radius:50%}
.bar-me:hover{background:var(--hover)}
.anon{width:28px;height:28px;border-radius:50%;border:1.5px dashed #9aa0a6;display:grid;place-items:center;color:var(--sub);font-weight:650}
.bar-btn{height:36px;padding:0 12px;border-radius:999px;display:flex;align-items:center;gap:7px;font-weight:650;color:#3c4043}
.bar-btn:hover{background:var(--hover)}
.bar-btn svg{width:18px;height:18px;display:block}
.bar .comment[aria-pressed="true"]{background:var(--me);color:var(--mi)}
kbd{font:inherit;font-size:10.5px;min-width:18px;height:18px;padding:0 4px;border-radius:4px;border:1px solid currentColor;opacity:.5;display:grid;place-items:center;line-height:1}
.count{font-variant-numeric:tabular-nums}
.bar.offline::after{content:"";width:8px;height:8px;border-radius:50%;background:#f9ab00;margin:0 10px 0 4px}
@media (max-width:420px){.bar-btn .lbl{display:none}}

.banner{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:5px 5px 5px 16px;border-radius:999px;background:var(--me);color:var(--mi);font-weight:650;box-shadow:0 4px 16px rgba(0,0,0,.2);white-space:nowrap;animation:fade .2s}
.banner button{height:28px;padding:0 12px;border-radius:999px;background:rgba(255,255,255,.24);font-weight:650}

.panel{position:fixed;top:calc(12px + env(safe-area-inset-top));right:12px;bottom:calc(70px + env(safe-area-inset-bottom));width:min(340px,calc(100vw - 24px));background:#fff;border-radius:14px;border:1px solid rgba(32,33,36,.08);box-shadow:0 10px 36px rgba(0,0,0,.18);overflow:auto;overscroll-behavior:contain;padding:14px 8px 16px;animation:fade .15s}
.panel-head{display:flex;align-items:center;justify-content:space-between;padding:0 8px 6px}
.panel h2{font-size:15px;font-weight:650}
.host{margin:0 8px 8px;font-size:12px;color:var(--sub)}
.empty{margin:20px 8px;color:var(--sub);line-height:1.5}
.row{display:flex;gap:10px;width:100%;text-align:left;padding:10px 8px;border-radius:10px;align-items:flex-start}
.row:hover{background:var(--hover)}
.row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.row-top{display:flex;gap:8px;align-items:baseline}
.row-top strong{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-text{color:#3c4043;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.row.done .row-text{color:var(--sub)}
.row-warn{font-size:11.5px;color:#b06000}
.row-num{font-size:12px;font-weight:650;color:var(--sub);font-variant-numeric:tabular-nums;padding-top:1px}
.toggle{display:flex;align-items:center;gap:8px;margin:12px 8px 4px;font-size:12.5px;color:var(--sub);cursor:pointer}
.toggle input{accent-color:var(--green);margin:0}
.others{margin:16px 8px 0;border-top:1px solid var(--line);padding-top:12px}
.others h3{font-size:12.5px;font-weight:650;color:var(--sub);margin-bottom:4px}
.other{display:flex;justify-content:space-between;gap:12px;padding:6px 0;color:#1a73e8;text-decoration:none}
.other:hover span:first-child{text-decoration:underline}

.scrim{position:fixed;inset:0;background:rgba(32,33,36,.38);display:grid;place-items:center;padding:16px;animation:fade .15s}
.card{width:min(420px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:16px;padding:22px 22px 18px;box-shadow:0 24px 64px rgba(0,0,0,.3);animation:rise .24s cubic-bezier(.2,.9,.3,1.1)}
.card h2{font-size:19px;font-weight:650;letter-spacing:-.01em}
.sub{margin-top:4px;color:var(--sub);font-size:13.5px}
.lab{display:block;margin:18px 0 6px;font-size:12.5px;font-weight:650;color:#3c4043}
label.lab .field{margin-top:6px}
.id-row{display:flex;align-items:flex-start;gap:14px;margin-top:18px}
.id-row .lab{margin:0;flex:1}
.card .actions{margin-top:18px}

.toasts{position:fixed;right:16px;bottom:calc(70px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;align-items:flex-end;width:min(340px,calc(100vw - 32px))}
.toast{display:flex;align-items:flex-start;gap:10px;width:100%;background:#202124;color:#fff;border-radius:12px;padding:11px 12px;box-shadow:0 8px 24px rgba(0,0,0,.26);animation:rise .26s cubic-bezier(.2,.9,.3,1.1);transition:opacity .35s,translate .35s}
.toast.out{opacity:0;translate:0 6px}
.toast .ok{width:22px;height:22px;margin-top:1px}
.toast .ok svg{width:13px;height:13px}
.toast-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.toast-body{color:rgba(255,255,255,.72);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.toast .btn.ghost{color:#8ab4f8;margin:-4px -4px 0 0}
.toast .btn.ghost:hover{background:rgba(255,255,255,.1)}
@keyframes fade{from{opacity:0}}
@keyframes rise{from{opacity:0;translate:0 8px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

  // ---- Mounting -------------------------------------------------------------

  function mount() {
    hostEl = document.createElement('feedback-tunnel');
    hostEl.style.cssText = 'all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483647';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.append(h("style", {}, STYLES));
    root = h('div', { class: 'root' });
    shadow.append(root);

    ui.pins = h('div', { class: 'pins' });
    ui.hlLabel = h('span', { class: 'hl-label' });
    ui.hl = h('div', { class: 'hl', hidden: true }, ui.hlLabel);
    ui.floating = h('div', { class: 'floating' });
    ui.banner = h('div', { class: 'banner ui', hidden: true, role: 'status' },
      touch ? 'Tap anything to leave a note' : 'Click anything to leave a note',
      h('button', { onclick: () => setMode('browse') }, 'Done'));
    ui.panel = h('aside', { class: 'panel ui', hidden: true, 'aria-label': 'Notes' });
    ui.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    ui.bar = buildBar();
    root.append(ui.pins, ui.hl, ui.floating, ui.banner, ui.panel, ui.toasts, ui.bar);

    // Keep our keystrokes and clicks from reaching the prototype's own handlers
    // (global hotkeys, click-outside-to-close menus, and so on).
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'click', 'touchstart', 'focusin']) {
      shadow.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.append(hostEl);
    syncViewport();
    applyMe();
  }

  function buildBar() {
    ui.meBtn = h('button', { class: 'bar-me', onclick: () => openIdentity() });
    ui.commentBtn = h('button', {
      class: 'bar-btn comment', 'aria-pressed': 'false',
      onclick: () => setMode(S.mode === 'comment' ? 'browse' : 'comment'),
    }, h('span', { html: I.note }), h('span', { class: 'lbl' }, 'Comment'), touch ? null : h('kbd', {}, 'C'));
    ui.count = h('span', { class: 'count' }, '0');
    ui.listBtn = h('button', { class: 'bar-btn', 'aria-expanded': 'false', onclick: togglePanel },
      h('span', { html: I.list }), ui.count);
    return h('div', { class: 'bar ui', role: 'toolbar', 'aria-label': 'Feedback' }, ui.meBtn, ui.commentBtn, ui.listBtn);
  }

  function applyMe() {
    const c = meColor();
    root.style.setProperty('--me', c);
    root.style.setProperty('--mi', ink(c));
    ui.meBtn.replaceChildren(S.me ? avatar(S.me, 28) : h('span', { class: 'anon' }, '?'));
    ui.meBtn.setAttribute('aria-label', S.me ? `You're ${S.me.name}. Change your name.` : 'Choose your name');
    ui.meBtn.title = S.me ? S.me.name : 'Choose your name';
    cursorStyle();
  }

  // A pin-shaped cursor in your colour while commenting.
  function cursorStyle() {
    if (!cursorEl) {
      cursorEl = document.createElement('style');
      cursorEl.setAttribute('data-feedback-tunnel', '');
    }
    if (!cursorEl.isConnected) (document.head || document.documentElement).append(cursorEl);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 23V13a10 10 0 1 1 10 10z" fill="${meColor()}" stroke="#fff" stroke-width="2"/></svg>`;
    cursorEl.textContent = `html.ft-commenting,html.ft-commenting *{cursor:url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 23,crosshair!important}`;
  }

  // ---- Identity (name + colour) ----------------------------------------------

  function openIdentity(then) {
    closeModal();
    const firstTime = !S.me;
    const color = S.me?.color || randomColor(); // picked once, then kept for the session
    const input = h('input', {
      class: 'field', type: 'text', maxlength: '40', autocomplete: 'name', 'aria-label': 'Your name',
      value: S.me?.custom ? S.me.name : null, placeholder: 'Anonymous',
    });
    const preview = avatar({ name: input.value, color }, 52);
    input.addEventListener('input', () => { preview.textContent = initial(input.value); });
    const card = h('div', {
      class: 'card', role: 'dialog', 'aria-modal': 'true',
      'aria-label': firstTime ? 'What are you looking at?' : 'Your name',
    });
    card.style.setProperty('--c', color);
    card.style.setProperty('--ci', ink(color));
    const save = () => {
      const name = input.value.trim();
      S.me = { name: name || 'Anonymous', color, custom: !!name };
      saved.set(KEY_ME, S.me);
      applyMe();
      closeModal();
      if (then) then();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    card.append(
      h('h2', {}, firstTime ? 'What are you looking at?' : 'Your name'),
      firstTime
        ? h('p', { class: 'sub' },
          'This is a working prototype, not the final build. Click Comment, then click anything — a button, a photo, a line of text — to leave a note right on it.')
        : null,
      h('div', { class: 'id-row' }, preview, h('label', { class: 'lab' }, 'Your name', input)),
      firstTime ? h('p', { class: 'sub' }, 'Shown on your notes. Leave it blank to stay anonymous.') : null,
      h('div', { class: 'actions' },
        S.me ? h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel') : null,
        h('button', { class: 'btn primary', onclick: save }, firstTime ? 'Start commenting' : 'Save')),
    );
    ui.modal = h('div', { class: 'scrim ui', onclick: (e) => { if (e.target === ui.modal) closeModal(); } }, card);
    root.append(ui.modal);
    setTimeout(() => input.focus(), 40);
  }

  function closeModal() {
    ui.modal?.remove();
    ui.modal = null;
  }

  // ---- Modes ----------------------------------------------------------------

  function setMode(m) {
    if (m === 'comment' && !S.me) return openIdentity(() => setMode('comment'));
    S.mode = m;
    const on = m === 'comment';
    ui.commentBtn.setAttribute('aria-pressed', String(on));
    ui.banner.hidden = !on;
    document.documentElement.classList.toggle('ft-commenting', on);
    if (on) cursorStyle();
    else S.hover = null;
  }

  // ---- Composer (a new note) ------------------------------------------------

  function placeComposer(e) {
    const el = pickTarget(e.target);
    if (!el) return;
    if (S.composer && S.composer.text.value.trim()) {
      shake(S.composer.card);
      S.composer.text.focus({ preventScroll: true });
      return;
    }
    closeNote();
    const r = el.getBoundingClientRect();
    const offset = {
      x: r.width ? clamp01((e.clientX - r.left) / r.width) : 0.5,
      y: r.height ? clamp01((e.clientY - r.top) / r.height) : 0.5,
    };
    openComposer(el, offset);
  }

  function openComposer(el, offset) {
    closeComposer();
    const color = meColor();
    const anchor = describe(el, offset);
    const text = h('textarea', { class: 'field ta', rows: '3', maxlength: '4000', placeholder: 'What should change here?', 'aria-label': 'Your note' });
    const err = h('p', { class: 'err', hidden: true, role: 'alert' });
    const post = h('button', { class: 'btn primary' }, 'Post note');
    const card = h('div', { class: 'note ui', style: `--c:${color};--ci:${ink(color)}`, role: 'dialog', 'aria-label': 'New note' },
      h('div', { class: 'note-head' },
        avatar(S.me, 28),
        h('div', { class: 'who' }, h('strong', {}, S.me.name), h('span', { class: 'meta' }, `On ${anchor.label}`))),
      text, err,
      h('div', { class: 'actions' },
        touch ? null : h('span', { class: 'hint' }, `${mac ? '⌘' : 'Ctrl'} + Enter`),
        h('button', { class: 'btn ghost', onclick: closeComposer }, 'Cancel'),
        post));
    const pin = makePin({ author: S.me }, true);
    ui.pins.append(pin);
    ui.floating.append(card);
    S.composer = { el, offset, anchor, card, pin, text, x: 0, y: 0, tried: 0 };

    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    async function submit() {
      const body = text.value.trim();
      if (!body) { fail('Write a note first.'); text.focus(); return; }
      err.hidden = true;
      post.disabled = true;
      post.textContent = 'Posting…';
      try {
        const r = await fetch(`${API}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: body,
            author: { name: S.me.name, color: S.me.color },
            page: { path: S.path, title: document.title },
            anchor,
            context: {
              viewport: { w: Math.round(V.w), h: Math.round(V.h) },
              pageWidth: document.documentElement.scrollWidth,
              dpr: devicePixelRatio,
              browser: browserName(),
            },
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        closeComposer();
        upsert(d.comment);
        pins.get(d.comment.id)?.dom.classList.add('pop');
        poll();
      } catch (e2) {
        post.disabled = false;
        post.textContent = 'Post note';
        fail(e2.message && e2.message !== 'Failed to fetch' ? e2.message
          : "Couldn't post the note. The prototype may be offline, so try again in a moment.");
      }
    }
    post.addEventListener('click', submit);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    requestAnimationFrame(() => text.focus({ preventScroll: true }));
  }

  function closeComposer() {
    if (!S.composer) return;
    S.composer.card.remove();
    S.composer.pin.remove();
    S.composer = null;
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  // ---- Pins -----------------------------------------------------------------

  function makePin(c, draft) {
    const color = c.author.color || '#80868b';
    return h('button', {
      class: 'pin ui', style: `--c:${color}`,
      'aria-label': draft ? 'New note' : `Note ${c.id} by ${c.author.name}`,
      onclick: draft ? null : () => toggleNote(c.id),
    },
    h('span', { class: 'flip' },
      h('span', { class: 'face front' }, avatar(c.author, 24)),
      h('span', { class: 'face back', html: I.check })),
    draft ? null : h('span', { class: 'num' }, String(c.id)));
  }

  function syncPins() {
    const want = S.comments.filter((c) => c.page?.path === S.path && (S.showResolved || c.status !== 'resolved'));
    const ids = new Set(want.map((c) => c.id));
    for (const [id, p] of pins) {
      if (!ids.has(id)) { p.dom.remove(); pins.delete(id); }
    }
    for (const c of want) {
      let p = pins.get(c.id);
      if (!p) {
        p = { c, el: null, tried: -1e9, clips: [], dom: makePin(c), x: 0, y: 0, vis: false, orphan: false };
        p.dom.hidden = true;
        pins.set(c.id, p);
        ui.pins.append(p.dom);
      } else {
        if (p.c.anchor.selector !== c.anchor.selector) p.el = null;
        p.c = c;
      }
      p.dom.classList.toggle('resolved', c.status === 'resolved');
      p.dom.setAttribute('aria-label', `Note ${c.id} by ${c.author.name}${c.status === 'resolved' ? ', resolved' : ''}`);
    }
  }

  function upsert(c) {
    const i = S.comments.findIndex((x) => x.id === c.id);
    if (i >= 0) S.comments[i] = c;
    else S.comments.push(c);
    markSeen();
    syncPins();
    renderPanel();
    renderCount();
    if (S.open === c.id) openNote(c.id);
  }

  // The green-pin moment.
  function celebrate(c) {
    const p = pins.get(c.id);
    if (p) {
      p.dom.classList.remove('celebrate');
      void p.dom.offsetWidth;
      p.dom.classList.add('celebrate');
      setTimeout(() => p.dom.classList.remove('celebrate'), 2400);
    }
    const by = c.resolvedBy?.name;
    const title = !by || by === 'FEEDBACK.md' ? `Note ${c.id} resolved`
      : S.me && by === S.me.name && S.isHost ? `You resolved note ${c.id}` : `${by} resolved note ${c.id}`;
    const here = c.page?.path === S.path;
    toast({
      ok: true, title, body: c.text,
      action: here ? { label: 'Show', run: () => focusNote(c.id) } : { label: 'Open page', run: () => { location.href = c.page.path; } },
    });
  }

  // ---- Open note ------------------------------------------------------------

  function toggleNote(id) {
    if (S.open === id) closeNote();
    else openNote(id);
  }

  function openNote(id) {
    const c = S.comments.find((x) => x.id === id);
    if (!c) return;
    const wasOpen = S.open === id;
    closeNote();
    if (S.composer && !S.composer.text.value.trim()) closeComposer();
    S.open = id;
    ui.note = buildNote(c);
    if (wasOpen) ui.note.style.animation = 'none';
    ui.floating.append(ui.note);
    pins.get(id)?.dom.classList.add('active');
  }

  function buildNote(c) {
    const resolved = c.status === 'resolved';
    const w = c.context?.viewport?.w;
    const byName = c.resolvedBy?.name && c.resolvedBy.name !== 'FEEDBACK.md' ? ` by ${c.resolvedBy.name}` : '';
    let action = null;
    if (S.isHost) {
      action = resolved
        ? h('button', { class: 'btn ghost sm', onclick: () => setStatus(c, 'open') }, 'Reopen')
        : h('button', { class: 'btn resolve', onclick: () => setStatus(c, 'resolved') }, 'Resolve');
    }
    return h('div', { class: 'note ui', style: `--c:${c.author.color};--ci:${ink(c.author.color)}`, role: 'dialog', 'aria-label': `Note ${c.id}` },
      h('div', { class: 'note-head' },
        avatar(c.author, 28),
        h('div', { class: 'who' },
          h('strong', {}, c.author.name),
          h('span', { class: 'meta' }, timeAgo(c.createdAt), w ? h('span', { class: 'tag' }, `${w}px wide`) : null)),
        h('span', { class: 'note-num' }, `#${c.id}`),
        h('button', { class: 'x', 'aria-label': 'Close note', html: I.close, onclick: closeNote })),
      h('p', { class: 'body' }, c.text),
      h('p', { class: 'on' }, `On ${c.anchor?.label || 'this element'}`),
      pins.get(c.id)?.orphan ? h('p', { class: 'gone' }, "This element isn't on the page anymore.") : null,
      resolved || action
        ? h('div', { class: 'actions', style: resolved ? 'justify-content:space-between' : null },
          resolved ? h('span', { class: 'status', style: 'margin:0' }, h('span', { class: 'dot', html: I.check }), `Resolved${byName}`) : null,
          action)
        : null);
  }

  function closeNote() {
    if (S.open != null) pins.get(S.open)?.dom.classList.remove('active');
    ui.note?.remove();
    ui.note = null;
    S.open = null;
  }

  function focusNote(id) {
    const p = pins.get(id);
    if (p?.el?.isConnected) p.el.scrollIntoView({ block: 'center', inline: 'center', behavior: smooth });
    if (V.w < NARROW && S.panel) togglePanel();
    openNote(id);
  }

  async function setStatus(c, status) {
    try {
      const r = await fetch(`${API}/comments/${c.id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, by: S.me ? { name: S.me.name } : { name: 'Host' } }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      upsert(d.comment);
      if (status === 'resolved') celebrate(d.comment);
      poll();
    } catch (e) {
      toast({ title: e.message || "Couldn't update the note. Check that feedback-tunnel is still running." });
    }
  }

  // ---- Notes panel ----------------------------------------------------------

  function togglePanel() {
    S.panel = !S.panel;
    ui.panel.hidden = !S.panel;
    ui.listBtn.setAttribute('aria-expanded', String(S.panel));
    renderPanel();
  }

  function row(c) {
    const done = c.status === 'resolved';
    return h('button', { class: 'row' + (done ? ' done' : ''), onclick: () => focusNote(c.id) },
      avatar(c.author, 26),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-top' }, h('strong', {}, c.author.name), h('span', { class: 'meta' }, timeAgo(c.createdAt))),
        h('span', { class: 'row-text' }, c.text),
        pins.get(c.id)?.orphan ? h('span', { class: 'row-warn' }, "Can't find this element on the page anymore") : null),
      done ? h('span', { class: 'ok', html: I.check, 'aria-label': 'Resolved' }) : h('span', { class: 'row-num' }, `#${c.id}`));
  }

  function renderPanel() {
    if (!S.panel) return;
    const here = S.comments.filter((c) => c.page?.path === S.path);
    const open = here.filter((c) => c.status !== 'resolved');
    const done = here.filter((c) => c.status === 'resolved');
    const others = new Map();
    for (const c of S.comments) {
      if (c.page?.path !== S.path && c.status !== 'resolved') others.set(c.page.path, (others.get(c.page.path) || 0) + 1);
    }
    const parts = [
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Notes on this page'),
        h('button', { class: 'x', html: I.close, 'aria-label': 'Close notes', onclick: togglePanel })),
      S.isHost ? h('p', { class: 'host' }, "You're the host, so you can resolve notes.") : null,
      here.length ? null : h('p', { class: 'empty' }, 'No notes here yet. Turn on Comment and click anything to leave one.'),
      open.map(row),
      done.length ? h('label', { class: 'toggle' },
        h('input', {
          type: 'checkbox', checked: S.showResolved,
          onchange: (e) => { S.showResolved = e.target.checked; syncPins(); renderPanel(); },
        }),
        `Show ${done.length} resolved`) : null,
      S.showResolved ? done.map(row) : null,
      others.size ? h('div', { class: 'others' },
        h('h3', {}, 'Open notes on other pages'),
        [...others].map(([path, n]) => h('a', { class: 'other', href: path }, h('span', {}, path), h('span', {}, String(n))))) : null,
    ];
    ui.panel.replaceChildren(...parts.flat().filter(Boolean));
  }

  function renderCount() {
    const n = S.comments.filter((c) => c.page?.path === S.path && c.status !== 'resolved').length;
    ui.count.textContent = String(n);
    ui.listBtn.setAttribute('aria-label', `Notes on this page, ${n} open`);
  }

  // ---- Toasts ---------------------------------------------------------------

  function toast({ title, body, action, ok }) {
    const t = h('div', { class: 'toast ui' },
      ok ? h('span', { class: 'ok', html: I.check }) : null,
      h('div', { class: 'toast-main' }, h('strong', {}, title), body ? h('span', { class: 'toast-body' }, body) : null),
      action ? h('button', { class: 'btn ghost sm', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
    ui.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 5600);
    setTimeout(() => t.remove(), 6000);
  }

  // ---- Syncing with the review server ---------------------------------------

  function markSeen() {
    saved.set(KEY_SEEN, Object.fromEntries(S.comments.map((c) => [c.id, c.status])));
  }

  async function poll(first) {
    try {
      const r = await fetch(`${API}/comments?since=${S.version}`, { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const d = await r.json();
      S.failures = 0;
      setOffline(false);
      if (d.unchanged) return;
      const before = first ? saved.get(KEY_SEEN) || {} : Object.fromEntries(S.comments.map((c) => [c.id, c.status]));
      S.comments = d.comments;
      S.version = d.version;
      syncPins();
      // Anything resolved since this person last looked gets its moment,
      // including after a hot reload wiped the page.
      for (const c of S.comments) if (c.status === 'resolved' && before[c.id] === 'open') celebrate(c);
      markSeen();
      renderPanel();
      renderCount();
      if (S.open != null) openNote(S.open);
    } catch {
      if (++S.failures >= 3) setOffline(true);
    }
  }

  function setOffline(off) {
    if (off === S.offline) return;
    S.offline = off;
    ui.bar.classList.toggle('offline', off);
    ui.bar.title = off ? 'Lost connection to the prototype. Notes sync again when it is back.' : '';
    if (off) toast({ title: 'Lost connection to the prototype', body: 'Notes will sync again when it comes back.' });
  }

  // ---- Frame loop: keep pins, notes and highlight glued to elements ----------

  function placeCard(card, px, py) {
    const narrow = V.w < NARROW;
    card.classList.toggle('sheet', narrow);
    if (narrow) return;
    const w = card.offsetWidth;
    const ht = card.offsetHeight;
    let x = px + PIN + 10;
    if (x + w > V.w - 12) x = px - w - 12;
    x = Math.max(12, x);
    const y = Math.max(12, Math.min(py - PIN - 4, V.h - ht - 76));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (!hostEl.isConnected) document.documentElement.append(hostEl);
    if (S.mode === 'comment' && !cursorEl.isConnected) cursorStyle();

    syncViewport();
    const path = pagePath();
    if (path !== S.path) {
      S.path = path;
      closeNote();
      closeComposer();
      syncPins();
      renderPanel();
      renderCount();
    }

    const W = V.w;
    const H = V.h;
    for (const p of pins.values()) {
      if ((!p.el || !p.el.isConnected) && t - p.tried > 700) {
        p.tried = t;
        p.el = resolveAnchor(p.c.anchor);
        p.clips = p.el ? clipsOf(p.el) : [];
      }
      const el = p.el && p.el.isConnected ? p.el : null;
      p.orphan = !el;
      p.vis = false;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) {
          p.x = mapX(r.left + p.c.anchor.offset.x * r.width);
          p.y = mapY(r.top + p.c.anchor.offset.y * r.height);
          p.vis = p.x > -4 && p.y > -4 && p.x < W + 4 && p.y < H + 4
            && insideClips(p.clips, r.left + p.c.anchor.offset.x * r.width, r.top + p.c.anchor.offset.y * r.height);
        }
      }
      if (p.vis) {
        p.dom.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - PIN)}px)`;
        if (p.dom.hidden) p.dom.hidden = false;
      } else if (!p.dom.hidden) {
        p.dom.hidden = true;
      }
    }

    const cp = S.composer;
    if (cp) {
      if (!cp.el?.isConnected && t - cp.tried > 700) { cp.tried = t; cp.el = resolveAnchor(cp.anchor); }
      if (cp.el?.isConnected) {
        const r = cp.el.getBoundingClientRect();
        cp.x = mapX(r.left + cp.offset.x * r.width);
        cp.y = mapY(r.top + cp.offset.y * r.height);
      }
      cp.pin.style.transform = `translate(${Math.round(cp.x)}px, ${Math.round(cp.y - PIN)}px)`;
      placeCard(cp.card, cp.x, cp.y);
    }
    if (S.open != null && ui.note) {
      const p = pins.get(S.open);
      if (p?.vis) placeCard(ui.note, p.x, p.y);
      else if (p && !ui.note.style.transform) placeCard(ui.note, W / 2 - 150, H / 3);
    }

    const target = cp ? (cp.el?.isConnected ? cp.el : null) : S.mode === 'comment' && !ui.modal ? S.hover : null;
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      ui.hl.hidden = false;
      const top = mapY(r.top);
      const bottom = mapY(r.bottom);
      ui.hl.style.transform = `translate(${mapX(r.left)}px, ${top}px)`;
      ui.hl.style.width = `${r.width * V.s}px`;
      ui.hl.style.height = `${r.height * V.s}px`;
      if (target !== S.hlFor) {
        S.hlFor = target;
        ui.hlLabel.textContent = humanLabel(target);
      }
      ui.hl.className = 'hl' + (top >= 28 ? '' : bottom + 28 < H ? ' below' : ' inside');
    } else if (!ui.hl.hidden) {
      ui.hl.hidden = true;
      S.hlFor = null;
    }
  }

  // ---- Global listeners -----------------------------------------------------

  function listen() {
    // Clicking outside an open note closes it.
    addEventListener('pointerdown', (e) => {
      if (ours(e)) return;
      if (S.mode === 'browse' && S.open != null) closeNote();
      if (S.panel && V.w < NARROW) togglePanel();
    }, true);

    // In comment mode the prototype stops reacting to clicks; a click places a note instead.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
      addEventListener(type, (e) => {
        if (S.mode !== 'comment' || ours(e) || ui.modal) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'click') placeComposer(e);
      }, true);
    }

    addEventListener('pointermove', (e) => {
      if (S.mode !== 'comment' || e.pointerType === 'touch') return;
      S.hover = ours(e) ? null : pickTarget(e.target);
    }, true);

    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const handled = ui.modal ? (closeModal(), true)
          : S.composer ? (closeComposer(), true)
          : S.open != null ? (closeNote(), true)
          : S.panel ? (togglePanel(), true)
          : S.mode === 'comment' ? (setMode('browse'), true) : false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey && !ui.modal
        && !isEditable(e.composedPath()[0])) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMode(S.mode === 'comment' ? 'browse' : 'comment');
      }
    }, true);

    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  // ---- Boot -----------------------------------------------------------------

  async function boot() {
    let b;
    try {
      b = await (await fetch(`${API}/bootstrap`, { cache: 'no-store' })).json();
    } catch {
      return; // not behind the review proxy; stay invisible
    }
    S.isHost = !!b.isHost;
    const me = saved.get(KEY_ME);
    if (me && typeof me.name === 'string' && /^#[0-9a-f]{6}$/i.test(me.color || '')) S.me = me;

    // Wait for the app to finish loading and hydrating before adding anything to the DOM.
    await new Promise((resolve) => {
      const go = () => setTimeout(resolve, 250);
      if (document.readyState === 'complete') go();
      else addEventListener('load', go, { once: true });
    });

    mount();
    listen();
    await poll(true);
    requestAnimationFrame(frame);
    setInterval(() => { if (!document.hidden) poll(); }, 2000);
  }

  boot();
})();

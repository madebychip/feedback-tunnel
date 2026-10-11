/* feedback-tunnel overlay. Injected into every HTML page by the review proxy.
   Everything renders inside one shadow root so the prototype's CSS can't touch it. */
(() => {
  'use strict';
  if (window.__feedbackTunnel || window.top !== window.self) return;
  window.__feedbackTunnel = true;

  const API = '/__ft/api';
  const KEY_ME = 'feedback-tunnel:me';
  const KEY_SEEN = 'feedback-tunnel:seen';
  const KEY_FILE_TIP = 'feedback-tunnel:file-tip';
  const PIN = 28; // pin height; two-digit numbers widen it into a pill
  const NARROW = 560;
  const COMPOSE_MAXH = 6 * 24 + 4; // the composer grows to six lines, then scrolls
  const RESOLVED = '#A8A29E';
  const touch = matchMedia('(hover: none)').matches;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const reduced = smooth === 'auto';

  const S = {
    isHost: false, me: null,
    comments: [], version: -1, failures: 0, offline: false,
    mode: 'browse', path: pagePath(), open: null, composer: null,
    panel: false, tab: 'open', hover: null, hlFor: null, hlColor: null, peek: null,
    celebrating: new Set(), celebrateTimers: {},
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

  // Lucide (lucide.dev), ISC licence.
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const I = {
    comment: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
    // Not Lucide: a filled teardrop in the pins' own shape (tail bottom-left).
    note: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 0C15.523 0 20 4.477 20 10C20 15.523 15.523 20 10 20H0V10C0 4.477 4.477 0 10 0Z"/></svg>',
    list: svg('<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>'),
    panel: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    reopen: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
    locate: svg('<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/>'),
    desktop: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
    tablet: svg('<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>'),
    mobile: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
    unlink: svg('<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>'),
    down: svg('<path d="m6 9 6 6 6-6"/>'),
    up: svg('<path d="m18 15-6-6-6 6"/>'),
    copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  };
  const icon = (name) => h('span', { class: 'i', 'aria-hidden': 'true', html: I[name] });

  function ink(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.56 ? '#0C0A09' : '#FFFFFF';
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

  function dayOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
    return days === 0 ? 'today' : days === 1 ? 'yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function browserName() {
    const u = navigator.userAgent;
    const b = /Edg\//.test(u) ? 'Edge' : /Firefox\/|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
    const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
      : /Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  }

  // Tailwind's -400 step: light enough for dark ink on every swatch. None of
  // them is yellow, which the design system keeps for its own highlight.
  const PALETTE = [
    ['Red', '#F87171'], ['Orange', '#FB923C'], ['Green', '#4ADE80'], ['Teal', '#2DD4BF'], ['Sky', '#38BDF8'],
    ['Blue', '#60A5FA'], ['Indigo', '#818CF8'], ['Violet', '#A78BFA'], ['Pink', '#F472B6'], ['Rose', '#FB7185'],
  ];
  const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)][1];

  // A note's screen size, as the reviewer saw it.
  function deviceOf(w) {
    if (!w) return null;
    return w < 600 ? { name: 'Mobile', icon: 'mobile' } : w < 1024 ? { name: 'Tablet', icon: 'tablet' } : { name: 'Desktop', icon: 'desktop' };
  }

  function initial(name) {
    const t = String(name || '').trim();
    return t ? t[0].toUpperCase() : '?';
  }

  // `author` is either a comment's `.author`, `S.me`, or a live preview of one:
  // whatever it is, all that matters here is { name, color }.
  function avatar(author, size) {
    const color = author?.color || RESOLVED;
    const font = size <= 20 ? 10 : size <= 24 ? 11 : size <= 32 ? 13 : 18;
    const el = h('span', {
      class: 'av',
      'aria-hidden': 'true',
      style: `--c:${color};--ci:${ink(color)};width:${size}px;height:${size}px;font-size:${font}px`,
    });
    // Trimmed to the capital's height, so the letter centres on what you see, not the font's line box.
    el.append(h('span', { class: 'ch' }, initial(author?.name)));
    return el;
  }

  function meColor() {
    return S.me ? S.me.color : '#FAFAF9';
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
  // Made By Chip design system, dark mode. Every floating surface gets a light
  // edge plus a dark outer hairline, so it holds up on light and dark prototypes.
  // Motion: colour 150ms, press scale(.98), tab 300ms, things that enter 300-520ms
  // on the stack curve, things that leave 320ms.

  const STYLES = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.root{position:fixed;left:0;top:0;width:100vw;height:100vh;transform-origin:0 0;pointer-events:none;font:400 14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased;color-scheme:dark;
  --bg:#0C0A09;--fg:#FAFAF9;--card:#1C1917;--secondary:#292524;--accent:#34302C;--muted:#A59F97;--tertiary:#777169;
  --primary:#FAFAF9;--primary-fg:#0C0A09;--primary-hover:#E7E5E4;--border:rgba(255,255,255,.08);--input:#34302C;--ring:#A59F97;--edge:rgba(255,255,255,.16);
  --success:#3DB36A;--resolved:${RESOLVED};--warn:#E58A77;
  --shadow-ring:0 0 0 .5px rgba(255,255,255,.16),0 1px 1px rgba(0,0,0,.3);
  --shadow-overlay:0 0 0 1px rgba(0,0,0,.5),0 2px 4px rgba(0,0,0,.45),0 24px 48px -12px rgba(0,0,0,.85);
  --pin-ring:0 0 0 2px #FAFAF9,0 0 0 3px rgba(0,0,0,.3),0 6px 16px -4px rgba(0,0,0,.6);
  --ease-colour:cubic-bezier(.4,0,.2,1);--ease-tab:cubic-bezier(.25,.1,.35,1);--ease-stack:cubic-bezier(.32,.72,0,1)}
.ui{pointer-events:auto}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:inherit;-webkit-tap-highlight-color:transparent}
button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.compose:focus-visible,.field:focus-visible{outline:none}
h2,h3,p{margin:0;font:inherit}
.i{display:inline-flex;flex:none}
.i svg{display:block;width:16px;height:16px}
.surface{background:var(--card);border:1px solid var(--edge);box-shadow:var(--shadow-overlay)}
.av .ch{display:block;text-box:trim-both cap alphabetic}
.av{display:inline-grid;place-items:center;flex:none;border-radius:50%;background:var(--c);color:var(--ci);font-weight:600;line-height:1;overflow:hidden;user-select:none}
kbd{display:inline-flex;align-items:center;justify-content:center;flex:none;height:20px;min-width:20px;padding:0 6px;border-radius:6px;border:1px solid var(--border);background:var(--secondary);color:var(--muted);font:400 12px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;height:32px;padding:0 12px;border-radius:9999px;font-size:14px;font-weight:500;line-height:1;white-space:nowrap;user-select:none;transition:background-color 150ms var(--ease-colour),color 150ms var(--ease-colour),opacity 150ms var(--ease-colour),transform 150ms var(--ease-colour)}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.4;cursor:default;pointer-events:none}
.btn.primary{background:var(--primary);color:var(--primary-fg)}
.btn.secondary{background:var(--secondary);color:var(--fg)}
.btn.ghost{color:var(--muted)}
.btn.icon{width:32px;padding:0}
.btn.lg{height:40px;padding:0 20px}
.btn.block{width:100%}
.btn.s14 .i svg,.btn.s14>svg{width:14px;height:14px}
.btn>svg{display:block;width:16px;height:16px}
@media (hover:hover){
  .btn.primary:hover{background:var(--primary-hover)}
  .btn.secondary:hover{background:var(--accent)}
  .btn.ghost:hover{background:var(--secondary);color:var(--fg)}
}

/* Dock */
.bar{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;align-items:center;padding:6px;border-radius:9999px;transition:width 300ms var(--ease-tab)}
.bar-row{display:flex;align-items:center;gap:4px}
/* Icon-only dock buttons; the label lives in the hover tooltip. */
.dock-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;min-width:40px;padding:0 10px;border-radius:9999px;color:var(--fg);transition:background-color 150ms var(--ease-colour),transform 150ms var(--ease-colour)}
.dock-btn:active{transform:scale(.98)}
.dock-btn .i svg{width:20px;height:20px}
.dock-btn.comment .i svg{width:18px;height:18px}
.dock-btn.notes:has(.badge:not([hidden])){padding-right:8px}
@media (hover:hover){.dock-btn:hover{background:var(--secondary)}}
.bar-row:not([hidden]){animation:fade 150ms var(--ease-colour)}
.bar-row.commenting{gap:12px;min-height:40px;padding:0 4px 0 6px}
.bar-btn{position:relative}
.bar-btn[aria-expanded="true"]{background:var(--secondary);color:var(--fg)}
.badge{display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;padding:0 7px;border-radius:9999px;background:var(--accent);color:var(--fg);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.bar-label{font-size:14px;color:var(--fg);white-space:nowrap}
.me-btn{display:flex;border-radius:50%;transition:box-shadow 150ms var(--ease-colour)}
.tip{position:absolute;bottom:calc(100% + 14px);font-weight:500;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:12px;background:var(--card);border:1px solid var(--edge);color:var(--fg);font-size:12px;line-height:16px;white-space:nowrap;box-shadow:var(--shadow-overlay);opacity:0;translate:0 4px;pointer-events:none;transition:opacity 150ms var(--ease-colour),translate 150ms var(--ease-colour)}
.tip.l{left:-6px}
.tip.r{right:-6px}
.bar-btn:focus-visible .tip{opacity:1;translate:0 0}
@media (hover:hover){
  .bar-btn:hover .tip{opacity:1;translate:0 0;transition-delay:300ms}
  .me-btn:hover{box-shadow:0 0 0 2px var(--accent)}
}
.bar.offline::after{content:"";position:absolute;top:1px;right:1px;width:9px;height:9px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 2px var(--card)}

/* Pins: the tail (the square corner) sits on the exact spot that was clicked */
.pins{position:absolute;inset:0}
.pin{position:absolute;left:0;top:0;display:block;border-radius:14px 14px 14px 4px;will-change:transform;--c:var(--pc)}
.pin.resolved{--c:var(--resolved)}
.pin-face{display:flex;align-items:center;justify-content:center;height:${PIN}px;min-width:${PIN}px;padding:0 8px;border-radius:14px 14px 14px 4px;background:var(--c);color:var(--ci);font-size:13px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;box-shadow:var(--pin-ring);transform-origin:0 100%;transition:background-color 150ms var(--ease-colour),box-shadow 150ms var(--ease-colour)}
.pin .tick{display:none}
.pin .tick svg{display:block;width:14px;height:14px}
.pin.resolved .pin-face{width:${PIN}px;padding:0;color:#0C0A09}
.pin.resolved .num{display:none}
.pin.resolved .tick{display:block}
.pin.active .pin-face{box-shadow:0 0 0 2px #FAFAF9,0 0 0 6px color-mix(in srgb,var(--c) 35%,transparent),0 6px 16px -4px rgba(0,0,0,.6)}
.pin.draft{border-radius:50%}
.pin.draft .av{box-shadow:var(--pin-ring);animation:pin-in 320ms var(--ease-stack)}
.pin.pop .pin-face{animation:pin-in 320ms var(--ease-stack)}
.pin.celebrate .pin-face{animation:resolve-pop 520ms var(--ease-stack)}
.pin.celebrate::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:0 0 0 2px var(--success);opacity:0;animation:ring 900ms var(--ease-colour) 120ms}
.pin.leaving .pin-face{animation:pin-out 320ms var(--ease-stack) forwards}
@keyframes pin-in{from{opacity:0;transform:translateY(-8px) scale(.6)}}
@keyframes pin-out{to{opacity:0;transform:translateY(-10px) scale(.85)}}
@keyframes resolve-pop{35%{transform:scale(1.22)}}
@keyframes ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(2.2)}}

/* Element outline, in the commenter's colour */
.hl{position:fixed;left:0;top:0;box-shadow:0 0 0 2px var(--hc);background:color-mix(in srgb,var(--hc) 10%,transparent);transition:transform 70ms,width 70ms,height 70ms}
.hl-label{position:absolute;left:-2px;bottom:100%;margin-bottom:6px;max-width:min(320px,80vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--hc);color:var(--hi);font-size:12px;font-weight:600;line-height:16px;padding:4px 8px;border-radius:6px}
.hl.below .hl-label{bottom:auto;top:100%;margin:6px 0 0}
.hl.inside .hl-label{bottom:auto;top:4px;left:4px;margin:0}
.hl.quiet .hl-label{display:none}

/* Composer and posted note */
.floating{position:absolute;inset:0}
.note{position:fixed;left:0;top:0;width:320px;max-width:calc(100% - 24px);display:flex;flex-direction:column;gap:16px;padding:20px;border-radius:16px;animation:card-in 300ms var(--ease-stack)}
.note.composer{width:360px;gap:12px;padding:12px}
@media (max-width:560px){.note.composer{width:320px}}
.note.shake{animation:shake 320ms}
.note-head{display:flex;align-items:center;gap:12px}
.note-head>.btn.icon{margin-right:-6px}
.who{display:flex;flex-direction:column;flex:1;min-width:0}
.who strong{font-size:14px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who span{font-size:12px;line-height:16px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{font-size:16px;line-height:28px;white-space:pre-wrap;text-wrap:pretty;overflow-wrap:anywhere;max-height:40vh;overflow:auto;transition:color 150ms var(--ease-colour)}
.note.resolved .body{color:var(--muted)}
.meta-line{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--muted)}
.meta-line .i svg{width:14px;height:14px}
.meta-text{display:flex;min-width:0;white-space:nowrap}
.meta-text .where{min-width:0;overflow:hidden;text-overflow:ellipsis}
.meta-text .screen{flex:none}
.compose{display:block;width:100%;margin:0;padding:4px 4px 0;font:inherit;font-size:14px;line-height:24px;color:var(--fg);background:transparent;border:0;outline:none;resize:none}
.compose::placeholder{color:var(--tertiary)}
.compose-foot{display:flex;align-items:center;gap:8px}
.hint{flex:1;display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;color:var(--tertiary);white-space:nowrap}

/* Pin hover preview */
.peek{position:fixed;left:0;top:0;width:max-content;max-width:240px;display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:16px;animation:fade 150ms var(--ease-colour)}
.peek-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}
.peek-head strong{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.peek-head .when{color:var(--muted);white-space:nowrap}
.peek-text{font-size:12px;line-height:20px;text-wrap:pretty;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

/* Notes panel */
.panel{position:fixed;top:calc(12px + env(safe-area-inset-top));right:12px;bottom:calc(80px + env(safe-area-inset-bottom));width:min(320px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;border-radius:16px;transform-origin:bottom right;animation:panel-in 300ms var(--ease-stack)}
.panel.closing{animation:panel-out 150ms var(--ease-colour) forwards}
.panel-head{display:flex;align-items:center;gap:8px;padding:20px 20px 0}
.panel-head h2{flex:1;font-size:16px;font-weight:600;line-height:24px}
.panel-head .btn{margin:-4px -6px -4px 0}
.tabs{position:relative;display:flex;gap:4px;flex:none;height:36px;margin:16px 20px 12px;padding:4px;border-radius:9999px;background:var(--secondary)}
.tabs-pill{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 6px);border-radius:9999px;background:var(--card);box-shadow:var(--shadow-ring);transition:translate 300ms var(--ease-tab)}
.tabs[data-tab="resolved"] .tabs-pill{translate:calc(100% + 4px) 0}
.tab{position:relative;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;border-radius:9999px;font-size:14px;color:var(--muted);transition:color 150ms var(--ease-colour)}
.tab[aria-selected="true"]{color:var(--fg);font-weight:500}
.tab .n{font-weight:400;color:var(--tertiary);font-variant-numeric:tabular-nums}
.tab[aria-selected="true"] .n{color:var(--muted)}
.list{flex:1;min-height:0;display:flex;flex-direction:column;gap:4px;padding:0 8px 12px;overflow:auto;overscroll-behavior:contain}
.row{position:relative;flex:none;border-radius:12px;transition:background-color 150ms var(--ease-colour)}
.row-main{display:flex;gap:12px;width:100%;padding:12px;border-radius:12px;text-align:left}
.row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.row-top{display:flex;align-items:center;gap:8px;height:24px}
.row-top strong{font-size:14px;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-top .date{flex:1;font-size:12px;color:var(--tertiary);white-space:nowrap}
.row-num{font-size:12px;color:var(--tertiary);font-variant-numeric:tabular-nums;transition:opacity 150ms var(--ease-colour)}
.row-text{font-size:14px;line-height:24px;text-wrap:pretty;color:var(--fg);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.row-meta{display:flex;min-width:0;font-size:12px;line-height:16px;color:var(--tertiary)}
.row-actions{position:absolute;top:8px;right:8px;display:flex;opacity:0;pointer-events:none;transition:opacity 150ms var(--ease-colour)}
.row-actions .btn>svg{width:14px;height:14px}
.row:focus-within .row-actions{opacity:1;pointer-events:auto}
.row:focus-within .row-num{opacity:0}
@media (hover:hover){
  .tab:hover{color:var(--fg)}
  .row:hover{background:var(--secondary)}
  .row:hover .row-actions{opacity:1;pointer-events:auto}
  .row:hover .row-num{opacity:0}
  .row-actions .btn.ghost:hover{background:var(--accent)}
}
.filetip{flex:none;display:flex;flex-direction:column;gap:6px;margin:0 4px 8px;padding:12px 12px 12px 14px;border-radius:12px;background:var(--secondary)}
.filetip-head{display:flex;align-items:flex-start;gap:8px}
.filetip-head strong{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.filetip-head .btn.icon{width:28px;height:28px;margin:-4px -6px -4px 0}
.filetip-head .btn.icon>svg{width:14px;height:14px}
.filetip p{font-size:13px;line-height:20px;color:var(--muted);text-wrap:pretty}
.filetip .q{color:var(--fg)}
.filetip-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.btn.sm{height:28px;padding:0 10px;font-size:13px;gap:6px}
.btn.tonal{background:var(--accent);color:var(--fg)}
@media (hover:hover){.btn.tonal:hover{background:#433D37}.filetip-head .btn.icon:hover{background:var(--accent)}}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 24px;text-align:center}
.list.is-empty .empty{flex:1;padding-bottom:64px}
.empty-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:var(--secondary);color:var(--muted)}
.empty-icon svg{width:20px;height:20px}
.empty strong{font-size:14px;font-weight:600}
.empty p{max-width:240px;font-size:14px;line-height:24px;color:var(--muted);text-wrap:balance}
.empty .btn{margin-top:8px}
.others{flex:none;margin:8px 12px 0;padding-top:16px;border-top:1px solid var(--border)}
.others h3{margin-bottom:4px;font-size:12px;font-weight:500;color:var(--muted)}
.other{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:14px;color:var(--fg);text-decoration:none}
.other span:first-child{transition:color 150ms var(--ease-colour);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.other span:last-child{color:var(--tertiary);font-variant-numeric:tabular-nums}
@media (hover:hover){.other:hover span:first-child{color:var(--muted)}}

/* Welcome dialog */
.scrim{position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:rgba(12,10,9,.6);animation:fade 150ms var(--ease-colour)}
.card{position:relative;width:min(400px,100%);max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:24px;padding:32px 24px 24px;border-radius:16px;animation:card-in 300ms var(--ease-stack)}
.card.shake{animation:shake 320ms}
.card-head{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.card-head h2{font-size:20px;font-weight:600;line-height:28px}
.card-head p{max-width:288px;font-size:14px;line-height:24px;color:var(--muted);text-wrap:balance}
.stage{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:16px;border:1px solid var(--border);background:var(--bg)}
.sk{display:block;flex:none;max-width:100%;border-radius:9999px;background:var(--secondary)}
.sk-nav{display:flex;align-items:center;gap:8px}
.sk-nav .gap{flex:1}
.sk-body{display:flex;align-items:flex-start;gap:16px;padding-top:8px}
.sk-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;padding-top:8px}
.sk-target{display:flex;flex-direction:column;justify-content:center;gap:6px;flex:none;width:144px;height:48px;padding:0 12px;border-radius:8px;border:1.5px solid var(--c);background:color-mix(in srgb,var(--c) 8%,transparent);transition:border-color 150ms var(--ease-colour),background-color 150ms var(--ease-colour)}
.mini{position:relative;align-self:flex-end;width:256px;max-width:100%;display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:16px}
.mini-name{position:relative}
.field{display:block;width:100%;height:40px;padding:0 16px 0 56px;border-radius:9999px;border:1px solid var(--input);background:var(--bg);color:var(--fg);font:inherit;font-size:14px;outline:none;transition:border-color 150ms var(--ease-colour)}
.field::placeholder{color:var(--tertiary);opacity:1}
.field:focus{border-color:var(--ring)}
.swatch-btn{position:absolute;left:6px;top:6px;display:flex;align-items:center;gap:4px;padding:2px 6px 2px 2px;border-radius:9999px;color:var(--muted);transition:background-color 150ms var(--ease-colour),color 150ms var(--ease-colour)}
.swatch-btn .i svg{width:12px;height:12px}
.swatch-btn[aria-expanded="true"]{background:var(--accent);color:var(--fg)}
.swatches{position:absolute;left:0;bottom:calc(100% + 8px);z-index:1;display:grid;grid-template-columns:repeat(5,24px);gap:10px;padding:12px;border-radius:20px;animation:pop 150ms var(--ease-colour)}
.swatch{width:24px;height:24px;border-radius:50%;background:var(--s);transition:box-shadow 150ms var(--ease-colour),transform 150ms var(--ease-colour)}
.swatch[aria-checked="true"]{box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--fg)}
.swatch:active{transform:scale(.92)}
.mini-hint{padding:4px 12px 6px;font-size:12px;line-height:20px;color:var(--muted)}
@media (hover:hover){
  .swatch-btn:hover{background:var(--accent);color:var(--fg)}
  .swatch:hover{transform:scale(1.1)}
}

/* Toasts */
.toasts{position:fixed;right:16px;bottom:calc(80px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:flex-end;gap:8px;width:min(340px,calc(100vw - 32px))}
.toasts.beside{right:calc(min(320px,100vw - 24px) + 24px)}
.toast{display:flex;align-items:flex-start;gap:12px;width:100%;padding:12px 12px 12px 14px;border-radius:16px;animation:card-in 300ms var(--ease-stack);transition:opacity 320ms var(--ease-stack),translate 320ms var(--ease-stack)}
.toast.out{opacity:0;translate:0 8px}
.ok{display:grid;place-items:center;flex:none;width:22px;height:22px;margin-top:1px;border-radius:50%;background:var(--success);color:#0C0A09}
.ok svg{display:block;width:13px;height:13px}
.toast-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:2px}
.toast-main strong{font-size:14px;font-weight:600;line-height:20px}
.toast-body{font-size:13px;line-height:20px;text-wrap:pretty;color:var(--muted);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.toast .btn{height:28px;padding:0 10px;font-size:13px}

@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;translate:0 4px}}
@keyframes card-in{from{opacity:0;scale:.97;translate:0 6px}}
@keyframes panel-in{from{opacity:0;scale:.96;translate:0 8px}}
@keyframes panel-out{to{opacity:0;scale:.98;translate:0 6px}}
@keyframes shake{25%{translate:-5px 0}75%{translate:5px 0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

  // ---- Mounting -------------------------------------------------------------

  function mount() {
    hostEl = document.createElement('feedback-tunnel');
    hostEl.style.cssText = 'all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483647';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.append(h('style', {}, STYLES));
    root = h('div', { class: 'root' });
    shadow.append(root);

    ui.pins = h('div', { class: 'pins' });
    ui.hlLabel = h('span', { class: 'hl-label' });
    ui.hl = h('div', { class: 'hl', hidden: true }, ui.hlLabel);
    ui.floating = h('div', { class: 'floating' });
    ui.panel = h('aside', { class: 'panel surface ui', hidden: true, 'aria-label': 'Comments' });
    buildPanel();
    ui.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    ui.bar = buildBar();
    root.append(ui.hl, ui.pins, ui.floating, ui.panel, ui.toasts, ui.bar);

    // Keep our keystrokes and clicks from reaching the prototype's own handlers
    // (global hotkeys, click-outside-to-close menus, and so on).
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'click', 'touchstart', 'focusin']) {
      shadow.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.append(hostEl);
    syncViewport();
    applyMe();
  }

  // One dock, two states. It changes in place when commenting starts, so the
  // controls never jump around the screen.
  function buildBar() {
    ui.commentBtn = h('button', {
      class: 'dock-btn bar-btn comment', 'aria-pressed': 'false', 'aria-label': 'Comment',
      onclick: () => setMode(S.mode === 'comment' ? 'browse' : 'comment'),
    },
      icon('note'),
      touch ? null : h('span', { class: 'tip l', 'aria-hidden': 'true' }, 'Comment', h('kbd', {}, 'C')));
    ui.count = h('span', { class: 'badge', hidden: true }, '0');
    ui.listBtn = h('button', { class: 'dock-btn bar-btn notes', 'aria-expanded': 'false', onclick: togglePanel },
      icon('list'), ui.count,
      touch ? null : h('span', { class: 'tip r', 'aria-hidden': 'true' }, 'All comments', h('kbd', {}, 'N')));
    ui.resting = h('div', { class: 'bar-row' }, ui.commentBtn, ui.listBtn);

    ui.meBtn = h('button', { class: 'me-btn', 'aria-label': 'Change your name or colour', onclick: () => openIdentity() });
    ui.doneBtn = h('button', { class: 'btn secondary done', onclick: () => setMode('browse') }, 'Done');
    ui.commenting = h('div', { class: 'bar-row commenting', hidden: true },
      ui.meBtn,
      h('span', { class: 'bar-label' }, touch ? 'Tap anything to leave a comment' : 'Click anything to leave a comment'),
      touch ? null : h('kbd', {}, 'Esc'),
      ui.doneBtn);

    return h('div', { class: 'bar surface ui', role: 'toolbar', 'aria-label': 'Feedback' }, ui.resting, ui.commenting);
  }

  // Resizes the dock smoothly between its two states (a lightweight FLIP: measure
  // the width it's leaving, swap which row is visible, measure the width it's
  // entering, then animate old -> new) instead of an abrupt reflow.
  function morphBar(commenting) {
    const from = ui.bar.getBoundingClientRect().width;
    ui.resting.hidden = commenting;
    ui.commenting.hidden = !commenting;
    const to = ui.bar.getBoundingClientRect().width;
    ui.bar.style.overflow = 'hidden';
    ui.bar.style.width = `${from}px`;
    void ui.bar.offsetWidth;
    ui.bar.style.width = `${to}px`;
    clearTimeout(morphBar.t);
    morphBar.t = setTimeout(() => { ui.bar.style.width = ''; ui.bar.style.overflow = ''; }, 320);
  }

  function applyMe() {
    const c = meColor();
    root.style.setProperty('--me', c);
    root.style.setProperty('--mi', ink(c));
    ui.meBtn.replaceChildren(avatar(S.me, 24));
    cursorStyle();
  }

  // A pin-shaped cursor in your colour while commenting.
  function cursorStyle() {
    if (!cursorEl) {
      cursorEl = document.createElement('style');
      cursorEl.setAttribute('data-feedback-tunnel', '');
    }
    if (!cursorEl.isConnected) (document.head || document.documentElement).append(cursorEl);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 23V13a10 10 0 1 1 10 10z" fill="${meColor()}" stroke="#FAFAF9" stroke-width="2"/></svg>`;
    cursorEl.textContent = `html.ft-commenting,html.ft-commenting *{cursor:url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 23,crosshair!important}`;
  }

  // ---- Identity (name + colour) ----------------------------------------------

  // Greeting first, then a preview of a real comment. The name field sits in the
  // comment itself, and picking a colour repaints the avatar and the outlined
  // element exactly as they'll look in comment mode.
  function openIdentity(then) {
    closeModal();
    const firstTime = !S.me;
    let color = S.me?.color || randomColor();
    const input = h('input', {
      class: 'field', type: 'text', maxlength: '40', autocomplete: 'name', 'aria-label': 'Your name',
      placeholder: 'Your name', value: S.me?.custom ? S.me.name : null,
    });
    const face = h('span', { class: 'i' });
    const chevron = h('span', { class: 'i', html: I.up }); // the menu opens upward
    const swatchBtn = h('button', {
      class: 'swatch-btn', type: 'button', 'aria-label': 'Change your colour', 'aria-haspopup': 'true', 'aria-expanded': 'false',
      onclick: () => setMenu(swatches.hidden),
    }, face, chevron);
    const swatches = h('div', { class: 'swatches surface', role: 'radiogroup', 'aria-label': 'Your colour', hidden: true },
      PALETTE.map(([name, hex]) => h('button', {
        class: 'swatch', type: 'button', role: 'radio', 'aria-label': name, 'data-hex': hex, style: `--s:${hex}`,
        onclick: () => { color = hex; paint(); setMenu(false); input.focus(); },
      })));
    const start = h('button', { class: 'btn primary lg block', disabled: true, onclick: () => save() },
      firstTime ? 'Start commenting' : 'Save');
    const sk = (w, ht) => h('span', { class: 'sk', style: `width:${w}px;height:${ht}px` });
    const card = h('div', {
      class: 'card surface', role: 'dialog', 'aria-modal': 'true',
      'aria-label': firstTime ? 'Help shape this prototype' : 'Your name and colour',
      onpointerdown: (e) => { if (!swatches.hidden && !swatches.contains(e.target) && !swatchBtn.contains(e.target)) setMenu(false); },
    },
      h('div', { class: 'card-head' },
        h('h2', {}, firstTime ? 'Help shape this prototype' : 'Your name and colour'),
        h('p', {}, firstTime
          ? 'Tap Comment, then click any button, photo or line of text to leave a comment right on it.'
          : 'This is how your comments appear to everyone reviewing.')),
      h('div', { class: 'stage' },
        h('div', { class: 'sk-nav', 'aria-hidden': 'true' }, sk(32, 8), sk(48, 8), sk(40, 8), h('span', { class: 'gap' }), sk(48, 16)),
        h('div', { class: 'sk-body', 'aria-hidden': 'true' },
          h('div', { class: 'sk-col' }, sk(96, 12), sk(64, 12), sk(80, 8)),
          h('div', { class: 'sk-target' }, sk(56, 8), sk(80, 8))),
        h('div', { class: 'mini surface' },
          h('div', { class: 'mini-name' }, swatchBtn, input, swatches),
          h('div', { class: 'mini-hint', 'aria-hidden': 'true' }, 'What should change here?'))),
      start);

    function paint() {
      face.replaceChildren(avatar({ name: input.value, color }, 24));
      card.style.setProperty('--c', color);
      for (const s of swatches.children) s.setAttribute('aria-checked', String(s.dataset.hex === color));
      start.disabled = !input.value.trim();
    }
    function setMenu(open) {
      swatches.hidden = !open;
      swatchBtn.setAttribute('aria-expanded', String(open));
      chevron.innerHTML = open ? I.down : I.up;
    }
    function save() {
      const name = input.value.trim();
      if (!name) { shake(card); input.focus(); return; }
      S.me = { name, color, custom: true };
      saved.set(KEY_ME, S.me);
      applyMe();
      closeModal();
      if (then) then();
    }

    input.addEventListener('input', paint);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    paint();
    // Esc closes the colour menu first (back to the name, so Enter still submits), then the dialog.
    ui.modalEscape = () => (swatches.hidden ? false : (setMenu(false), input.focus(), true));
    ui.modal = h('div', { class: 'scrim ui', onclick: (e) => { if (e.target === ui.modal) closeModal(); } }, card);
    root.append(ui.modal);
    setTimeout(() => input.focus(), 40);
  }

  function closeModal() {
    ui.modal?.remove();
    ui.modal = null;
    ui.modalEscape = null;
  }

  // ---- Modes ----------------------------------------------------------------

  function setMode(m) {
    wake();
    if (m === 'comment' && !S.me) return openIdentity(() => setMode('comment'));
    S.mode = m;
    const on = m === 'comment';
    ui.commentBtn.setAttribute('aria-pressed', String(on));
    morphBar(on);
    document.documentElement.classList.toggle('ft-commenting', on);
    if (on) { cursorStyle(); setPeek(null); }
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
    if (V.w < NARROW && e.clientY > innerHeight * 0.4) {
      window.scrollBy({ top: e.clientY - innerHeight * 0.25, behavior: smooth });
    }
    openComposer(el, offset);
  }

  function openComposer(el, offset) {
    wake();
    closeComposer();
    const anchor = describe(el, offset);
    // Send lives in a footer row, so long notes never run underneath it. Keyboard
    // hints sit in the footer too, not in the placeholder. Enter posts,
    // Shift+Enter makes a new line, Esc cancels (global).
    const text = h('textarea', {
      class: 'compose', rows: '1', maxlength: '4000',
      placeholder: 'What should change here?', 'aria-label': 'Your comment',
    });
    const send = h('button', { class: 'btn primary icon', 'aria-label': 'Post comment', disabled: true, html: I.send });
    const hint = h('span', { class: 'hint' });
    const card = h('div', { class: 'note composer surface ui', role: 'dialog', 'aria-label': 'New note' },
      text, h('div', { class: 'compose-foot' }, hint, send));
    // While writing, the pin is your avatar.
    const pin = h('span', { class: 'pin draft' }, avatar(S.me, 24));
    ui.pins.append(pin);
    ui.floating.append(card);
    S.composer = { el, offset, anchor, card, pin, text, x: 0, y: 0, tried: 0 };

    const setHint = (multi) => {
      if (touch || hint.dataset.multi === String(multi)) return;
      hint.dataset.multi = String(multi);
      hint.replaceChildren(...(multi
        ? [h('kbd', {}, 'Shift'), h('kbd', {}, 'Enter'), 'new line']
        : [h('kbd', {}, 'Enter'), 'to send']));
    };
    const grow = () => {
      text.style.height = 'auto';
      const sh = text.scrollHeight;
      text.style.height = `${Math.min(sh, COMPOSE_MAXH)}px`;
      send.disabled = !text.value.trim();
      setHint(sh > 30); // past one line
    };

    async function submit() {
      const body = text.value.trim();
      if (!body) { shake(card); return; }
      text.disabled = true;
      send.disabled = true;
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
        text.disabled = false;
        send.disabled = false;
        text.focus();
        shake(card);
        toast({ title: e2.message && e2.message !== 'Failed to fetch' ? e2.message
          : "Couldn't post the comment. The prototype may be offline, so try again in a moment." });
      }
    }
    text.addEventListener('input', grow);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    requestAnimationFrame(() => { grow(); text.focus({ preventScroll: true }); });
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

  // Colour says who wrote it; the number says which note it is and matches the
  // #N in the Notes panel. The name and first line show on hover.
  function makePin(c) {
    const color = c.author.color || RESOLVED;
    const el = h('button', {
      class: 'pin ui', style: `--pc:${color};--ci:${ink(color)}`,
      onclick: () => toggleNote(c.id),
    },
    h('span', { class: 'pin-face' },
      h('span', { class: 'num' }, String(c.id)),
      h('span', { class: 'tick', html: I.check })));
    if (!touch) {
      el.addEventListener('pointerenter', () => setPeek(c.id));
      el.addEventListener('pointerleave', () => setPeek(null));
    }
    return el;
  }

  // Resolved pins leave the page. They come back, grey with a tick, while the
  // Resolved tab is open, while their note is open, or for their moment.
  function onPage(c) {
    return c.status !== 'resolved' || S.open === c.id || S.celebrating.has(c.id) || (S.panel && S.tab === 'resolved');
  }

  function syncPins() {
    wake();
    const want = S.comments.filter((c) => c.page?.path === S.path && onPage(c));
    const ids = new Set(want.map((c) => c.id));
    for (const [id, p] of pins) {
      if (ids.has(id)) continue;
      pins.delete(id);
      dropPin(p.dom);
      if (S.peek === id) setPeek(null);
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
      p.dom.classList.toggle('active', S.open === c.id);
      p.dom.setAttribute('aria-label', `Comment ${c.id} by ${c.author.name}${c.status === 'resolved' ? ', resolved' : ''}`);
    }
  }

  function dropPin(dom) {
    if (reduced || dom.hidden) { dom.remove(); return; }
    dom.classList.add('leaving');
    dom.style.pointerEvents = 'none';
    setTimeout(() => dom.remove(), 320);
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

  // The resolved moment: the pin pops grey with a tick, then leaves the page.
  function celebrate(c) {
    S.celebrating.add(c.id);
    syncPins();
    const p = pins.get(c.id);
    if (p) {
      p.dom.classList.remove('celebrate');
      void p.dom.offsetWidth;
      p.dom.classList.add('celebrate');
    }
    clearTimeout(S.celebrateTimers[c.id]);
    S.celebrateTimers[c.id] = setTimeout(() => {
      S.celebrating.delete(c.id);
      pins.get(c.id)?.dom.classList.remove('celebrate');
      syncPins();
    }, 1600);
    const by = c.resolvedBy?.name;
    const title = !by || by === 'FEEDBACK.md' ? `Comment ${c.id} resolved`
      : S.me && by === S.me.name && S.isHost ? `You resolved comment ${c.id}` : `${by} resolved comment ${c.id}`;
    const here = c.page?.path === S.path;
    toast({
      ok: true, title, body: c.text,
      action: here ? { label: 'Show', run: () => focusNote(c.id) } : { label: 'Open page', run: () => { location.href = c.page.path; } },
    });
  }

  function setPeek(id) {
    wake();
    if (S.peek === id) return;
    S.peek = id;
    ui.peek?.remove();
    ui.peek = null;
    const c = id != null ? S.comments.find((x) => x.id === id) : null;
    if (!c || S.open === id || S.composer) return;
    ui.peek = h('div', { class: 'peek surface', 'aria-hidden': 'true' },
      h('div', { class: 'peek-head' }, avatar(c.author, 20), h('strong', {}, c.author.name), h('span', { class: 'when' }, timeAgo(c.createdAt))),
      h('div', { class: 'peek-text' }, c.text));
    ui.peek.hidden = true;
    ui.floating.append(ui.peek);
  }

  // ---- Open note ------------------------------------------------------------

  function toggleNote(id) {
    if (S.open === id) closeNote();
    else openNote(id);
  }

  function openNote(id) {
    wake();
    const c = S.comments.find((x) => x.id === id);
    if (!c) return;
    const wasOpen = S.open === id;
    closeNote(false);
    if (S.composer && !S.composer.text.value.trim()) closeComposer();
    setPeek(null);
    S.open = id;
    syncPins();
    ui.note = buildNote(c);
    if (wasOpen) ui.note.style.animation = 'none';
    ui.floating.append(ui.note);
  }

  // Who said it, what they said, then where and on what screen.
  function buildNote(c) {
    const resolved = c.status === 'resolved';
    const by = c.resolvedBy?.name && c.resolvedBy.name !== 'FEEDBACK.md' ? ` by ${c.resolvedBy.name}` : '';
    // "Resolved today" fits beside the Reopen button; who resolved it is in the tooltip.
    const when = !resolved ? timeAgo(c.createdAt) : `Resolved ${dayOf(c.resolvedAt)}`.trim();
    const action = !S.isHost ? null : resolved
      ? h('button', { class: 'btn secondary s14', 'aria-label': 'Reopen comment', onclick: () => setStatus(c, 'open') }, icon('reopen'), 'Reopen')
      : h('button', { class: 'btn secondary s14', 'aria-label': 'Resolve comment', onclick: () => setStatus(c, 'resolved') }, icon('check'), 'Resolve');
    return h('div', { class: `note surface ui${resolved ? ' resolved' : ''}`, role: 'dialog', 'aria-label': `Comment ${c.id}` },
      h('div', { class: 'note-head' },
        avatar(c.author, 32),
        h('div', { class: 'who' }, h('strong', {}, c.author.name), h('span', { title: resolved ? `Resolved${by}` : null }, when)),
        action,
        h('button', { class: 'btn ghost icon', 'aria-label': 'Close comment', html: I.close, onclick: () => closeNote() })),
      h('p', { class: 'body' }, c.text),
      metaLine(c));
  }

  // Element and screen share one quiet line. The icon shows the device, or a
  // broken link once the element is gone.
  function metaLine(c) {
    const w = c.context?.viewport?.w;
    const dev = deviceOf(w);
    const orphan = pins.get(c.id)?.orphan;
    const where = orphan ? 'Element no longer on page' : c.anchor?.label || 'Element';
    const screen = dev ? `${dev.name} ${w}px` : '';
    return h('p', { class: 'meta-line', title: [where, screen].filter(Boolean).join(' · ') },
      icon(orphan ? 'unlink' : dev ? dev.icon : 'desktop'), metaText(where, screen));
  }

  // "Label · Device": a long label gives way, so the device always shows.
  function metaText(where, screen) {
    return h('span', { class: 'meta-text' },
      h('span', { class: 'where' }, where),
      screen ? h('span', { class: 'screen' }, `\u00A0· ${screen}`) : null);
  }

  function closeNote(sync = true) {
    ui.note?.remove();
    ui.note = null;
    const was = S.open;
    S.open = null;
    if (sync && was != null) syncPins();
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
      if (status === 'resolved') S.celebrating.add(c.id);
      upsert(d.comment);
      if (status === 'resolved') celebrate(d.comment);
      poll();
    } catch (e) {
      toast({ title: e.message || "Couldn't update the comment. Check that feedback-tunnel is still running." });
    }
  }

  // ---- Notes panel ----------------------------------------------------------

  function buildPanel() {
    ui.tabOpen = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('open') }, 'Open', h('span', { class: 'n' }));
    ui.tabDone = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('resolved') }, 'Resolved', h('span', { class: 'n' }));
    ui.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Comments' }, h('span', { class: 'tabs-pill' }), ui.tabOpen, ui.tabDone);
    ui.list = h('div', { class: 'list', role: 'tabpanel' });
    ui.panel.append(
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Comments on this page'),
        h('button', { class: 'btn ghost icon', html: I.close, 'aria-label': 'Close comments', onclick: togglePanel })),
      ui.tabs, ui.list);
  }

  function togglePanel() {
    wake();
    const opening = !S.panel;
    S.panel = opening;
    ui.listBtn.setAttribute('aria-expanded', String(opening));
    // Toasts move out from under the panel while it's open (there's no room beside it on a phone).
    ui.toasts.classList.toggle('beside', opening && V.w >= 720);
    if (opening) {
      ui.panel.classList.remove('closing');
      ui.panel.hidden = false;
      renderPanel();
    } else if (reduced) {
      ui.panel.hidden = true;
    } else {
      ui.panel.classList.add('closing');
      ui.panel.addEventListener('animationend', () => {
        if (S.panel) return; // reopened mid-close
        ui.panel.hidden = true;
        ui.panel.classList.remove('closing');
      }, { once: true });
    }
    syncPins();
  }

  function setTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    renderPanel();
    syncPins();
    if (!reduced) ui.list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.4,0,.2,1)' });
  }

  // Hover a note to jump to it on the page or resolve it. The number matches its pin.
  function row(c) {
    const done = c.status === 'resolved';
    const orphan = pins.get(c.id)?.orphan;
    const dev = deviceOf(c.context?.viewport?.w);
    const meta = orphan ? metaText('Element no longer on page', '')
      : c.anchor?.label || dev ? metaText(c.anchor?.label || 'Element', dev?.name || '') : null;
    const statusBtn = !S.isHost ? null : done
      ? h('button', { class: 'btn ghost icon', 'aria-label': 'Reopen comment', title: 'Reopen', html: I.reopen, onclick: () => setStatus(c, 'open') })
      : h('button', { class: 'btn ghost icon', 'aria-label': 'Resolve comment', title: 'Resolve', html: I.check, onclick: () => setStatus(c, 'resolved') });
    return h('div', { class: 'row' },
      h('button', { class: 'row-main', onclick: () => focusNote(c.id) },
        avatar(c.author, 24),
        h('span', { class: 'row-body' },
          h('span', { class: 'row-top' },
            h('strong', {}, c.author.name),
            h('span', { class: 'date' }, timeAgo(c.createdAt)),
            done ? null : h('span', { class: 'row-num' }, `#${c.id}`)),
          h('span', { class: 'row-text' }, c.text),
          meta ? h('span', { class: 'row-meta' }, meta) : null)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost icon', 'aria-label': 'Show on page', title: 'Show on page', html: I.locate, onclick: () => focusNote(c.id) }),
        statusBtn));
  }

  function emptyState(title, text, cta) {
    return h('div', { class: 'empty' },
      h('span', { class: 'empty-icon', html: I.comment }),
      h('strong', {}, title),
      h('p', {}, text),
      cta ? h('button', {
        class: 'btn primary s14',
        onclick: () => { if (V.w < NARROW) togglePanel(); setMode('comment'); },
      }, icon('comment'), 'Comment') : null);
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
    ui.tabs.hidden = !here.length;
    ui.tabs.dataset.tab = S.tab;
    ui.tabOpen.setAttribute('aria-selected', String(S.tab === 'open'));
    ui.tabDone.setAttribute('aria-selected', String(S.tab === 'resolved'));
    ui.tabOpen.lastChild.textContent = String(open.length);
    ui.tabDone.lastChild.textContent = String(done.length);

    const list = S.tab === 'open' ? open : done;
    const items = !here.length
      ? [emptyState('No comments yet', 'Tap Comment, then click anything on the page to leave the first one.', true)]
      : !list.length
        ? [S.tab === 'open'
          ? emptyState('All done here', 'Every comment on this page has been resolved.')
          : emptyState('Nothing resolved yet', 'Resolved comments show up here, and their pins come back on the page.')]
        : list.map(row);
    if (others.size) {
      items.push(h('div', { class: 'others' },
        h('h3', {}, 'Open comments on other pages'),
        [...others].map(([path, n]) => h('a', { class: 'other', href: path }, h('span', {}, path), h('span', {}, String(n))))));
    }
    const tip = fileTip();
    if (tip) items.unshift(tip);
    ui.list.classList.toggle('is-empty', !list.length);
    ui.list.replaceChildren(...items);
  }

  // ---- Where comments go (host only) ----------------------------------------
  // FEEDBACK.md lives on the host's laptop, so only the host hears about it.
  // The next step is handing it to their coding agent, so that leads.

  const agentPrompt = () => `work through ${S.feedbackFile}`;

  async function copyPrompt() {
    const text = agentPrompt();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = h('textarea', { style: 'position:fixed;opacity:0' }, text);
      root.append(t); t.select();
      try { document.execCommand('copy'); } catch {}
      t.remove();
    }
  }

  async function openFeedbackFile() {
    try {
      const r = await fetch(`${API}/open-feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
    } catch (e) {
      toast({ title: e.message || `Couldn't open ${S.feedbackFile}. It's in your project folder.` });
    }
  }

  function fileTip() {
    if (!S.isHost || !S.feedbackFile || !S.comments.length || saved.get(KEY_FILE_TIP)?.dismissed) return null;
    const file = S.feedbackFile;
    const copyBtn = h('button', { class: 'btn primary s14 sm' }, icon('copy'), 'Copy prompt');
    copyBtn.addEventListener('click', async () => {
      await copyPrompt();
      copyBtn.replaceChildren(icon('check'), 'Copied');
      setTimeout(() => copyBtn.isConnected && copyBtn.replaceChildren(icon('copy'), 'Copy prompt'), 1600);
    });
    return h('div', { class: 'filetip', role: 'note' },
      h('div', { class: 'filetip-head' },
        h('strong', {}, `Comments are saved to ${file}`),
        h('button', {
          class: 'btn ghost icon', 'aria-label': 'Dismiss', html: I.close,
          onclick: () => { saved.set(KEY_FILE_TIP, { ...saved.get(KEY_FILE_TIP), dismissed: true }); renderPanel(); },
        })),
      h('p', {}, 'Ask your coding agent to ', h('span', { class: 'q' }, `“${agentPrompt()}”`), '. Each fix shows up here as resolved.'),
      h('div', { class: 'filetip-actions' },
        copyBtn,
        h('button', { class: 'btn tonal s14 sm', onclick: openFeedbackFile }, icon('file'), 'Open file')));
  }

  // The first time the host sees a comment, a toast says where it went.
  function fileToast() {
    if (!S.isHost || !S.feedbackFile || !S.comments.length || saved.get(KEY_FILE_TIP)?.toasted) return;
    saved.set(KEY_FILE_TIP, { ...saved.get(KEY_FILE_TIP), toasted: true });
    toast({
      title: `Comments are saved to ${S.feedbackFile}`,
      body: `Ask your coding agent to “${agentPrompt()}”.`,
      action: { label: 'Copy prompt', run: () => copyPrompt().then(() => toast({ ok: true, title: 'Prompt copied', body: 'Paste it into your coding agent.' })) },
    });
  }

  // The dock counts open notes only. Resolved ones don't count.
  function renderCount() {
    const n = S.comments.filter((c) => c.page?.path === S.path && c.status !== 'resolved').length;
    ui.count.textContent = String(n);
    ui.count.hidden = !n;
    ui.listBtn.setAttribute('aria-label', `Comments on this page, ${n} open`);
  }

  // ---- Toasts ---------------------------------------------------------------

  function toast({ title, body, action, ok }) {
    const t = h('div', { class: 'toast surface ui' },
      ok ? h('span', { class: 'ok', html: I.check }) : null,
      h('div', { class: 'toast-main' }, h('strong', {}, title), body ? h('span', { class: 'toast-body' }, body) : null),
      action ? h('button', { class: 'btn secondary', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
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
      // Anything resolved since this person last looked gets its moment,
      // including after a hot reload wiped the page. Mark them first so their
      // pins stay put for it instead of leaving and coming straight back.
      const fresh = S.comments.filter((c) => c.status === 'resolved' && before[c.id] === 'open');
      for (const c of fresh) S.celebrating.add(c.id);
      syncPins();
      for (const c of fresh) celebrate(c);
      markSeen();
      renderPanel();
      renderCount();
      fileToast();
      if (S.open != null) openNote(S.open);
    } catch {
      if (++S.failures >= 3) setOffline(true);
    }
  }

  // Poll every 2 s while someone is reviewing. After a minute without any
  // interaction, ease off to every 10 s so a phone's radio can power down
  // between requests; the next scroll, tap or key snaps it straight back.
  const POLL_FAST = 2000;
  const POLL_SLOW = 10000;
  const POLL_EASE_AFTER = 60000;
  let lastInteraction = performance.now();
  let pollTimer = 0;

  function pollDelay() {
    if (S.composer || ui.note || ui.modal || S.panel || S.mode === 'comment') return POLL_FAST;
    const idle = performance.now() - lastInteraction - POLL_EASE_AFTER;
    if (idle <= 0) return POLL_FAST;
    return Math.min(POLL_SLOW, POLL_FAST + (idle / 60000) * (POLL_SLOW - POLL_FAST));
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!document.hidden) await poll();
      schedulePoll();
    }, pollDelay());
  }

  function interacted() {
    const wasSlow = pollDelay() > POLL_FAST;
    lastInteraction = performance.now();
    if (wasSlow) { poll(); schedulePoll(); }
  }

  function setOffline(off) {
    if (off === S.offline) return;
    S.offline = off;
    ui.bar.classList.toggle('offline', off);
    ui.bar.title = off ? 'Lost connection to the prototype. Comments sync again when it is back.' : '';
    if (off) toast({ title: 'Lost connection to the prototype', body: 'Comments will sync again when it comes back.' });
  }

  // ---- Frame loop: keep pins, notes and highlight glued to elements ----------

  // left/top is the pin's top-left corner; pw its width. The card opens beside
  // the pin, top-aligned with it, and flips to the other side near the edge.
  // left/top/pw/ph is the pin's box. Wide screens put the card beside the pin.
  // Phones have no room beside it, so the card goes below the pin (or above,
  // whichever fits), lined up with it. The overlay follows the visual viewport,
  // so when the keyboard opens and shrinks it, the card rides up with it.
  function placeCard(card, left, top, pw, ph) {
    const w = card.offsetWidth;
    const ht = card.offsetHeight;
    const bottom = V.h - 84; // keep clear of the dock
    let x;
    let y;
    if (V.w < NARROW) {
      x = Math.min(Math.max(12, left - 12), V.w - w - 12);
      const below = top + ph + 8;
      const above = top - ht - 8;
      y = below + ht <= bottom ? below : above >= 12 ? above : Math.min(below, bottom - ht);
    } else {
      x = left + pw + 8;
      if (x + w > freeRight()) x = left - w - 8;
      y = Math.min(top, bottom - ht);
    }
    card.style.transform = `translate(${Math.round(Math.max(12, x))}px, ${Math.round(Math.max(12, y))}px)`;
  }

  // The right edge that cards can use: the open Notes panel takes the rest.
  function freeRight() {
    return S.panel && !ui.panel.hidden ? V.w - ui.panel.offsetWidth - 24 : V.w - 12;
  }

  // The loop runs every frame only while something is happening (scrolling,
  // pointer moving, a note or composer open, an animation settling). Otherwise
  // it checks four times a second, which is enough to follow layout shifts and
  // hot reloads without keeping the reviewer's device busy.
  const IDLE_AFTER = 1000;
  const IDLE_EVERY = 250;
  let lastActivity = 0;
  let rafOn = false;
  let idleTimer = 0;
  function wake() {
    lastActivity = performance.now();
    if (rafOn || !hostEl) return;
    clearTimeout(idleTimer);
    rafOn = true;
    requestAnimationFrame(loop);
  }
  function loop(t) {
    frame(t);
    const active = performance.now() - lastActivity < IDLE_AFTER || S.composer || ui.note || ui.peek
      || (S.mode === 'comment' && S.hover);
    if (active) { rafOn = true; requestAnimationFrame(loop); }
    else { rafOn = false; idleTimer = setTimeout(() => loop(performance.now()), IDLE_EVERY); }
  }

  function frame(t) {
    if (document.hidden) return;
    if (!hostEl.isConnected) document.documentElement.append(hostEl);
    if (S.mode === 'comment' && !cursorEl.isConnected) cursorStyle();

    syncViewport();
    const path = pagePath();
    if (path !== S.path) {
      S.path = path;
      closeNote();
      closeComposer();
      setPeek(null);
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
      // A 24px round avatar whose lower-left edge sits on the clicked spot.
      const left = Math.round(cp.x - 4);
      const top = Math.round(cp.y - 20);
      cp.pin.style.transform = `translate(${left}px, ${top}px)`;
      placeCard(cp.card, left, top, 24, 24);
    }
    if (S.open != null && ui.note) {
      const p = pins.get(S.open);
      if (p?.vis) placeCard(ui.note, p.x, p.y - PIN, p.dom.offsetWidth, PIN);
      else if (p && !ui.note.style.transform) placeCard(ui.note, W / 2 - 160, H / 3, 0, 0);
    }
    if (ui.peek) {
      const p = pins.get(S.peek);
      if (p?.vis) {
        const w = ui.peek.offsetWidth;
        let x = p.x + p.dom.offsetWidth + 8;
        if (x + w > freeRight()) x = p.x - w - 8;
        ui.peek.style.transform = `translate(${Math.round(Math.max(12, x))}px, ${Math.round(Math.max(8, p.y - PIN - 4))}px)`;
        ui.peek.hidden = false;
      } else {
        ui.peek.hidden = true;
      }
    }

    // Outline: the element being written about, else the one under the pointer
    // in comment mode, else the open note's element (without a label).
    let target = null;
    let color = meColor();
    let quiet = false;
    if (cp) target = cp.el?.isConnected ? cp.el : null;
    else if (S.mode === 'comment' && !ui.modal && S.hover) target = S.hover;
    else if (S.open != null) {
      const p = pins.get(S.open);
      if (p?.vis && p.el) {
        target = p.el;
        color = p.c.status === 'resolved' ? RESOLVED : p.c.author.color;
        quiet = true;
      }
    }
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      ui.hl.hidden = false;
      const top = mapY(r.top);
      const bottom = mapY(r.bottom);
      ui.hl.style.transform = `translate(${mapX(r.left)}px, ${top}px)`;
      ui.hl.style.width = `${r.width * V.s}px`;
      ui.hl.style.height = `${r.height * V.s}px`;
      if (target !== S.hlFor || color !== S.hlColor) {
        S.hlFor = target;
        S.hlColor = color;
        ui.hlLabel.textContent = humanLabel(target);
        ui.hl.style.setProperty('--hc', color);
        ui.hl.style.setProperty('--hi', ink(color));
        // Follow the element's own corners, so a pill gets a pill-shaped outline.
        ui.hl.style.borderRadius = getComputedStyle(target).borderRadius;
      }
      ui.hl.className = 'hl' + (quiet ? ' quiet' : '') + (top >= 30 ? '' : bottom + 30 < H ? ' below' : ' inside');
    } else if (!ui.hl.hidden) {
      ui.hl.hidden = true;
      S.hlFor = null;
    }
  }

  // ---- Global listeners -----------------------------------------------------

  function listen() {
    const opts = { capture: true, passive: true };
    for (const type of ['scroll', 'wheel', 'pointermove', 'pointerdown', 'touchmove', 'keydown', 'resize', 'transitionrun', 'animationstart']) {
      addEventListener(type, wake, opts);
    }
    for (const type of ['scroll', 'wheel', 'pointermove', 'pointerdown', 'touchstart', 'keydown']) {
      addEventListener(type, interacted, opts);
    }
    window.visualViewport?.addEventListener('resize', wake);
    window.visualViewport?.addEventListener('scroll', wake);
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
        const handled = ui.modal ? ((ui.modalEscape?.() || closeModal()), true)
          : S.composer ? (closeComposer(), true)
          : S.open != null ? (closeNote(), true)
          : S.panel ? (togglePanel(), true)
          : S.mode === 'comment' ? (setMode('browse'), true) : false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || ui.modal || isEditable(e.composedPath()[0])) return;
      const k = e.key.toLowerCase();
      if (k === 'c' || k === 'n') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (k === 'c') setMode(S.mode === 'comment' ? 'browse' : 'comment');
        else togglePanel();
      }
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      lastInteraction = performance.now(); // coming back to the tab counts as reviewing
      poll();
      schedulePoll();
    });
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
    S.feedbackFile = b.feedbackFile || null; // host only
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
    wake();
    schedulePoll();
  }

  boot();
})();

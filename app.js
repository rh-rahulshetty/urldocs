/* UrlDocs — static web page annotator. No backend: annotations live in the URL hash. */
(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const frame = $("page");
  const frameWrap = $("frameWrap");
  const empty = $("empty");
  const statusEl = $("status");
  const floatBtn = $("floatBtn");
  const noteCard = $("noteCard");
  const noteText = $("noteText");
  const swatches = $("swatches");
  const noteList = $("noteList");
  const noteCount = $("noteCount");
  const noNotes = $("noNotes");
  const clearBtn = $("clearBtn");
  const toast = $("toast");
  const shareBtn = $("shareBtn");
  const loadBtn = $("loadBtn");
  const urlInput = $("urlInput");

  // ---------- state ----------
  const PROXIES = [
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
    (u) => "https://api.cors.lol/" + u,
  ];
  const MAX_HTML = 5 * 1024 * 1024;
  const COLORS = { yellow: "#fff3b0", green: "#d9f0d0", blue: "#d8e6fb" };

  let pageUrl = ""; // original URL the user asked for
  let annotations = []; // [{i, c, t, p:[{e,a,b,c}]}]
  let dirty = false;
  let pending = null; // {ranges} while text is selected
  let toastTimer = null;

  // ---------- small utils ----------
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function say(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("err", !!isError);
  }

  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    toast.classList.toggle("err", !!isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), isError ? 6000 : 2500);
  }

  function shortUrl(u) {
    try {
      const x = new URL(u);
      return x.hostname + (x.pathname !== "/" ? x.pathname : "");
    } catch {
      return u;
    }
  }

  const cardOpen = () => !noteCard.classList.contains("hidden");

  // ---------- load pipeline ----------
  $("loadForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = urlInput.value.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      say("That doesn't look like a valid URL.", true);
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      say("Only http(s) URLs are supported.", true);
      return;
    }
    loadPage(url);
  });

  async function fetchWithProxies(target) {
    let lastErr;
    for (const make of PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        const res = await fetch(make(target), { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        if (text.length > MAX_HTML) throw new Error("page is larger than 5 MB");
        if (text.trim().length === 0) throw new Error("empty response");
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("all proxies failed");
  }

  function canAccessFrame() {
    try {
      return !!(frame.contentDocument && frame.contentDocument.body);
    } catch {
      return false; // cross-origin: the browser blocks our access to the DOM
    }
  }

  async function loadPage(url, keepAnns) {
    pageUrl = url;
    closeCard();
    floatBtn.classList.add("hidden");
    empty.style.display = "none";
    frame.style.display = "none";
    frame.removeAttribute("src");
    try { clearAnnotations(); } catch { /* doc not ready */ }
    if (keepAnns) annotations = keepAnns;
    else {
      annotations = [];
      // fresh load: drop any stale hash so a later refresh doesn't resurrect old notes
      history.replaceState(null, "", location.pathname + location.search);
    }
    dirty = false;
    shareBtn.disabled = true;
    say("Loading " + shortUrl(url) + " …");
    loadBtn.disabled = true;
    let settled = false;
    const target = (() => { try { return new URL(url); } catch { return null; } })();
    const sameOrigin = target && target.origin === location.origin;

    const finishDirect = (readonly) => {
      frame.style.display = "block";
      wireFrame(readonly);
      if (readonly) {
        say("Showing " + shortUrl(url) + " — this site can't be annotated (it blocks access from other sites).");
      } else {
        say("Loaded " + shortUrl(url) + " — select any text to annotate.");
      }
    };

    try {
      if (sameOrigin) {
        // Removing src may trigger an intermediate about:blank load; ignore
        // it and wire only once a real document is present.
        frame.addEventListener("load", function onSameLoad() {
          let doc = null;
          try { doc = frame.contentDocument; } catch { /* not ours */ }
          if (!doc || !doc.body || doc.URL === "about:blank") return;
          frame.removeEventListener("load", onSameLoad);
          if (!settled) { settled = true; finishDirect(false); }
        });
        frame.src = url;
      } else {
        // 1) Try embedding the live page directly. It renders with full JS/CSS,
        //    but if the site is cross-origin (always) or sends X-Frame-Options
        //    we can't reach its DOM, so annotation stays off.
        frame.addEventListener("load", () => {
          if (settled) return;
          if (canAccessFrame()) {
            settled = true;
            finishDirect(false);
          }
          // else: keep the live page on screen; try the proxy below.
        });
        frame.src = url;

        // 2) Proxy: fetch the HTML ourselves so we CAN annotate it.
        const html = await fetchWithProxies(url);
        const doc = parseHtml(url, html);
        const blobUrl = URL.createObjectURL(new Blob([doc.outerHTML], { type: "text/html" }));
        frame.addEventListener("load", () => {
          if (settled) { URL.revokeObjectURL(blobUrl); return; }
          settled = true;
          URL.revokeObjectURL(blobUrl);
          finishDirect(false);
        }, { once: true });
        frame.src = blobUrl;
      }
    } catch (e) {
      // All proxies failed. If the direct embed is still on screen, keep it
      // as a read-only view instead of a blank page.
      if (!settled && !sameOrigin) {
        settled = true;
        frame.style.display = "block";
        wireFrame(true);
        say(
          "Could not fetch " + shortUrl(url) + " through the proxies (" + e.message +
          ") — showing the live page read-only; annotation is unavailable for this site.",
          true
        );
      } else {
        frame.style.display = "none";
        empty.style.display = "";
        say(
          "Could not load this page (" + e.message + "). " +
            "Some sites block proxy traffic or need JavaScript — try the demo page or a different site.",
          true
        );
      }
    } finally {
      loadBtn.disabled = false;
    }
  }

  // The fetch goes through a proxy, so the document's origin is lost:
  // rewrite absolute URLs to the target origin and drop scripts/iframes/CSP.
  function parseHtml(targetUrl, html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("base[href]").forEach((b) => b.remove());
    const fix = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      try {
        const a = new URL(v, targetUrl);
        if (a.protocol === "http:" || a.protocol === "https:") el.setAttribute(attr, a.href);
      } catch { /* leave as-is */ }
    };
    doc.querySelectorAll("script").forEach((s) => s.remove());
    doc.querySelectorAll("link[href]").forEach((l) => fix(l, "href"));
    doc.querySelectorAll("img[src]").forEach((i) => fix(i, "src"));
    doc.querySelectorAll("iframe,object,embed").forEach((f) => f.remove());
    doc.querySelectorAll("meta[csp],meta[http-equiv='Content-Security-Policy']").forEach((m) => m.remove());
    doc.querySelectorAll("[style*='position:fixed'],[style*='position: fixed']").forEach((el) =>
      el.setAttribute("style", (el.getAttribute("style") || "").replace(/position\s*:\s*fixed/gi, "position:relative"))
    );
    return doc;
  }

  $("demoBtn").addEventListener("click", loadDemo);
  $("demoBtn2").addEventListener("click", loadDemo);

  function loadDemo() {
    pageUrl = location.href.split("#")[0] + "demo.html";
    closeCard();
    empty.style.display = "none";
    frame.style.display = "block";
    annotations = [];
    dirty = false;
    history.replaceState(null, "", location.pathname + location.search);
    frame.removeAttribute("src");
    frame.src = "demo.html";
    // NOTE: removing src first triggers an intermediate about:blank navigation
    // whose load event must be ignored, so this listener stays until a real
    // document is present, then wires the frame once and removes itself.
    frame.addEventListener(
      "load",
      function onDemoLoad() {
        let doc = null;
        try { doc = frame.contentDocument; } catch { /* cross-origin: not the demo */ }
        const ready =
          doc && doc.body &&
          doc.URL !== "about:blank" &&
          doc.body.querySelectorAll("p").length > 0;
        if (!ready) return; // about:blank or not yet rendered; wait for the real load
        frame.removeEventListener("load", onDemoLoad);
        wireFrame();
        say("Demo page loaded — select any text to annotate.");
      }
    );
  }

  // ---------- iframe wiring ----------
  function wireFrame(readonly) {
    if (readonly) {
      // Cross-origin live page: we can't touch its DOM, so no annotation
      // wiring. The sidebar still works for any restored note list.
      updateSidebar();
      updateShareState();
      return;
    }
    try {
      frame.contentDocument.documentElement.setAttribute("data-url", pageUrl);
    } catch { /* cross-origin; should not happen for blob/relative loads */ }
    const win = frame.contentWindow;
    win.addEventListener("mouseup", onFrameMouseUp);
    win.addEventListener("scroll", () => {
      if (pending && !cardOpen()) {
        pending = null;
        setSelecting(false);
        floatBtn.classList.add("hidden");
      }
    }, { passive: true });
    render();
  }

  function setSelecting(on) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.body) doc.body.classList.toggle("urldocs-selecting", on);
    } catch { /* cross-origin frame: nothing to highlight */ }
  }

  function onFrameMouseUp() {
    const win = frame.contentWindow;
    if (!win) return;
    const sel = win.getSelection();
    const valid =
      sel && sel.rangeCount > 0 && !sel.isCollapsed &&
      frame.contentDocument.body.contains(sel.getRangeAt(0).commonAncestorContainer) &&
      !sel.getRangeAt(0).collapsed;
    if (!valid) {
      setSelecting(false);
      if (!cardOpen()) floatBtn.classList.add("hidden");
      return;
    }
    pending = { ranges: rangesOfSelection(sel) };
    setSelecting(true);
    if (cardOpen()) return; // card is up; a re-selection just updates the pending ranges
    const r = sel.getRangeAt(0);
    const rect = r.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    const wRect = frameWrap.getBoundingClientRect();
    floatBtn.style.top = Math.max(4, rect.top + fRect.top - wRect.top + 4) + "px";
    floatBtn.style.left = Math.max(4, Math.min(rect.left + fRect.left - wRect.left, wRect.width - floatBtn.offsetWidth - 8)) + "px";
    floatBtn.classList.remove("hidden");
  }

  function rangesOfSelection(sel) {
    const out = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      const s = anchorToText(r.startContainer, r.startOffset, true);
      const e = anchorToText(r.endContainer, r.endOffset, false);
      if (!s || !e) continue;
      out.push({ e: s.off, a: s.path, b: e.off, c: e.path });
    }
    return out;
  }

  // ---------- path addressing ----------
  // An anchor = { a: element path, e: start char, b: end char } where the char
  // offsets count into the element's textContent. This is invariant under our
  // splitText/mark wrapping, so anchors keep resolving after a render pass.
  function elPathOf(el) {
    const parts = [];
    let n = el;
    const doc = frame.contentDocument;
    while (n && n !== doc.documentElement) {
      // Our own <mark> wrappers are transparent in the address space.
      if (n.classList && n.classList.contains("urldocs-mark")) {
        n = n.parentElement;
        continue;
      }
      if (n === doc.body) break;
      const parent = n.parentElement;
      if (!parent) break;
      const sibs = Array.from(parent.children).filter((c) => c.nodeName === n.nodeName);
      parts.unshift(n.nodeName + "#" + sibs.indexOf(n));
      n = parent;
    }
    parts.unshift("BODY");
    return parts.join("/");
  }

  // Char position of a boundary (node+offset) within el's textContent.
  function charPosIn(el, node, offset) {
    let pos = 0;
    const tw = frame.contentDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
    let n;
    while ((n = tw.nextNode())) {
      if (n === node) return pos + offset;
      pos += n.length;
    }
    return -1;
  }

  function rangesOfSelection(sel) {
    const out = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      const root = r.commonAncestorContainer;
      let el = root.nodeType === 3 ? root.parentElement : root;
      while (el && el.classList && el.classList.contains("urldocs-mark")) el = el.parentElement;
      if (!el) continue;
      const s = charPosIn(el, r.startContainer, r.startOffset);
      const e = charPosIn(el, r.endContainer, r.endOffset);
      if (s < 0 || e < 0 || e <= s) continue;
      out.push({ a: elPathOf(el), e: s, b: e });
    }
    return out;
  }

  function resolveEl(pathStr) {
    const doc = frame.contentDocument;
    if (!doc.body) return null;
    const parts = String(pathStr).split("/");
    if (parts[0] !== "BODY") return null;
    let el = doc.body;
    for (let i = 1; i < parts.length; i++) {
      // segment: TAG#index among same-tag siblings (e.g. "P#1")
      const seg = parts[i];
      const h = seg.lastIndexOf("#");
      if (h < 0) return null;
      const tag = seg.slice(0, h);
      const idx = parseInt(seg.slice(h + 1), 10);
      if (tag.length === 0 || isNaN(idx)) return null;
      const sibs = Array.from(el.children).filter((c) => c.nodeName === tag.toUpperCase());
      el = sibs[idx];
      if (!el) return null;
    }
    return el;
  }

  // Map a char offset in el's textContent to a (text node, offset) boundary.
  function pointIn(el, pos) {
    const tw = frame.contentDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
    let acc = 0, n;
    while ((n = tw.nextNode())) {
      if (pos <= acc + n.length) {
        const off = pos - acc;
        // pos on a node boundary → use the NEXT node at 0 when one exists;
        // otherwise this node at its end.
        if (off === n.length) {
          const nxt = tw.nextNode();
          if (nxt) return { node: nxt, off: 0 };
        }
        return { node: n, off };
      }
      acc += n.length;
    }
    return null;
  }

  function rangeFrom(r) {
    const win = frame.contentWindow;
    if (!win || !win.document.body) return null;
    const range = win.document.createRange();
    try {
      const el = resolveEl(r.a);
      if (!el) return null;
      const s = pointIn(el, r.e);
      const e = pointIn(el, r.b);
      if (!s || !e) return null;
      range.setStart(s.node, s.off);
      range.setEnd(e.node, e.off);
      if (range.toString().length === 0) return null;
      return range;
    } catch {
      return null;
    }
  }

  function rectOf(r) {
    const range = rangeFrom(r);
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }

  // ---------- annotation render (inside the loaded page) ----------
  const STYLE_ID = "urldocs-style";
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "::selection { background: #c3d9fb; } " +
      "body.urldocs-selecting ::selection { background: #9ec2fb; color: inherit; } " +
      ".urldocs-mark { padding: 1px 0; } " +
      ".urldocs-mark[data-c='yellow'] { background: " + COLORS.yellow + "; } " +
      ".urldocs-mark[data-c='green'] { background: " + COLORS.green + "; } " +
      ".urldocs-mark[data-c='blue'] { background: " + COLORS.blue + "; } " +
      ".urldocs-pin { position: absolute; width: 18px; height: 18px; border-radius: 50%; " +
      "border: 1px solid rgba(0,0,0,.35); color: #222; font: 11px/16px sans-serif; text-align: center; " +
      "cursor: pointer; z-index: 2147483646; box-shadow: 0 1px 2px rgba(0,0,0,.3); } " +
      ".urldocs-pin[data-c='yellow'] { background: " + COLORS.yellow + "; } " +
      ".urldocs-pin[data-c='green'] { background: " + COLORS.green + "; } " +
      ".urldocs-pin[data-c='blue'] { background: " + COLORS.blue + "; }";
    (doc.head || doc.documentElement).appendChild(s);
  }

  function clearAnnotations() {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("mark.urldocs-mark").forEach((m) => m.replaceWith(...m.childNodes));
    // NOTE: no normalize() here — merging adjacent text nodes would break anchors.
    doc.querySelectorAll(".urldocs-pin").forEach((p) => p.remove());
  }

  // Wraps exactly the selected part of one text node, splitting it at the
  // range boundaries when needed.
  function wrapTextNode(doc, tn, r, annIdx) {
    let start = r.startContainer === tn ? r.startOffset : 0;
    let end = r.endContainer === tn ? r.endOffset : tn.length;
    if (end <= start || start < 0 || end > tn.length) return;
    let node = tn;
    try {
      if (start > 0) {
        node = tn.splitText(start);
        if (end - start < node.length) node.splitText(end - start);
      } else if (end < tn.length) {
        tn.splitText(end);
      }
    } catch {
      return; // node already re-split by an earlier overlapping item; skip
    }
    const mark = doc.createElement("mark");
    mark.className = "urldocs-mark";
    mark.dataset.a = String(annIdx);
    const color = annotations[annIdx] && annotations[annIdx].c;
    if (color) mark.dataset.c = color;
    node.replaceWith(mark);
    mark.appendChild(node);
  }

  // One left-to-right pass wraps every annotation's text nodes, splitting at
  // the exact range boundaries so each anchor (text node + offset) keeps
  // resolving after the wrap.
  function applyMarks(items) {
    const doc = frame.contentDocument;
    const sorted = [...items].sort((x, y) => x.range.compareBoundaryPoints(0, y.range));
    let lastEnd = null; // [container, offset] of the last wrapped region's end
    for (const it of sorted) {
      let r = it.range;
      if (lastEnd) {
        // Only clip when this range actually starts before the previous region's end.
        try {
          const prevEnd = doc.createRange();
          prevEnd.setStart(lastEnd[0], lastEnd[1]);
          prevEnd.collapse(true);
          const curStart = doc.createRange();
          curStart.setStart(r.startContainer, r.startOffset);
          curStart.collapse(true);
          if (prevEnd.compareBoundaryPoints(2 /* END_TO_START */, curStart) > 0) {
            const clipped = doc.createRange();
            clipped.setStart(lastEnd[0], lastEnd[1]);
            clipped.setEnd(r.endContainer, r.endOffset);
            if (clipped.toString().length === 0) continue;
            r = clipped;
          }
        } catch {
          continue; // invalid boundary: skip this item
        }
      }
      let root = r.commonAncestorContainer;
      // A TreeWalker rooted at a text node yields nothing; widen to its parent.
      if (root.nodeType === 3) root = root.parentElement || doc.body;
      const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
      let node;
      while ((node = walker.nextNode())) {
        if (r.intersectsNode(node)) wrapTextNode(doc, node, r, it.ann);
      }
      lastEnd = [r.endContainer, r.endOffset];
    }
  }

  function addPin(ann, pt, win) {
    const doc = frame.contentDocument;
    const pin = doc.createElement("span");
    pin.className = "urldocs-pin";
    pin.dataset.c = ann.c;
    pin.dataset.a = String(ann.i);
    pin.textContent = String(ann.i + 1);
    pin.style.top = pt.y + (win.scrollY || 0) + "px";
    pin.style.left = pt.x + (win.scrollX || 0) + "px";
    doc.body.appendChild(pin);
  }

  function render() {
    let doc, win;
    try {
      doc = frame.contentDocument;
      win = frame.contentWindow;
    } catch {
      return; // cross-origin: can't annotate this frame
    }
    if (!doc || !doc.body || !win) return;
    ensureStyle(doc);
    clearAnnotations();
    const items = [];
    const firstPts = new Map(); // ann index -> first rect
    annotations.forEach((ann, i) => {
      ann.i = i;
      ann.p.forEach((r) => {
        const range = rangeFrom(r);
        if (range) items.push({ range, ann: i });
        if (!firstPts.has(i)) {
          const rect = range ? range.getBoundingClientRect() : null;
          if (rect && (rect.width > 0 || rect.height > 0)) firstPts.set(i, rect);
        }
      });
    });
    applyMarks(items);
    firstPts.forEach((pt, i) => addPin(annotations[i], pt, win));
    doc.querySelectorAll(".urldocs-pin").forEach((pin) => {
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        focusNote(parseInt(pin.dataset.a, 10));
      });
    });
    updateSidebar();
    updateShareState();
  }

  // ---------- note card ----------
  floatBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pending) return;
    noteCard.classList.remove("hidden");
    noteText.value = "";
    selectColor("yellow");
    const wRect = frameWrap.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    const sel = frame.contentWindow.getSelection();
    let left = 16, top = 16;
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      left = Math.max(8, Math.min(rect.left + fRect.left - wRect.left, wRect.width - noteCard.offsetWidth - 16));
      top = Math.max(8, rect.bottom + fRect.top - wRect.top + 8);
    }
    noteCard.style.top = top + "px";
    noteCard.style.left = left + "px";
    noteText.focus();
  });

  function selectColor(c) {
    swatches.querySelectorAll(".sw").forEach((b) => b.classList.toggle("sel", b.dataset.c === c));
  }
  swatches.addEventListener("click", (e) => {
    const b = e.target.closest(".sw");
    if (b) selectColor(b.dataset.c);
  });

  const currentColor = () => {
    const sel = swatches.querySelector(".sw.sel");
    return sel ? sel.dataset.c : "yellow";
  };

  $("noteSave").addEventListener("click", saveNote);
  noteText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
    if (e.key === "Escape") closeCard();
  });
  $("noteCancel").addEventListener("click", closeCard);

  function saveNote() {
    if (!pending) return;
    annotations.push({
      c: currentColor(),
      t: noteText.value.trim(),
      p: pending.ranges.map((r) => ({ a: r.a, e: r.e, b: r.b })),
    });
    closeCard();
    dirty = true;
    render();
    syncHash();
    showToast("Note added");
  }

  function closeCard() {
    noteCard.classList.add("hidden");
    pending = null;
    setSelecting(false);
    floatBtn.classList.add("hidden");
  }

  // ---------- sidebar ----------
  function updateSidebar() {
    noteList.innerHTML = "";
    noteCount.textContent = String(annotations.length);
    noNotes.hidden = annotations.length > 0;
    clearBtn.hidden = annotations.length === 0;
    annotations.forEach((ann, i) => {
      const li = document.createElement("li");
      li.className = "noteItem";
      li.dataset.c = ann.c;
      li.innerHTML =
        '<button type="button" class="goto" title="Jump to note">' + (i + 1) + "</button>" +
        (ann.t ? '<p class="ntext">' + esc(ann.t) + "</p>" : '<p class="ntext muted">Highlighted</p>');
      li.querySelector(".goto").addEventListener("click", () => focusNote(i));
      li.addEventListener("dblclick", () => focusNote(i));
      noteList.appendChild(li);
    });
  }

  function focusNote(i) {
    const ann = annotations[i];
    let win, doc;
    try {
      win = frame.contentWindow;
      doc = frame.contentDocument;
    } catch {
      return; // cross-origin frame: can't jump to the highlight
    }
    if (!ann || !win || !doc || !doc.body) return;
    const pt = ann.p.map((r) => rectOf(r)).find(Boolean);
    if (!pt) {
      showToast("This highlight no longer fits the page (the site's HTML changed).", true);
      return;
    }
    win.scrollTo({ top: Math.max(0, pt.y - 80), behavior: "smooth" });
    const mark = doc.querySelector('mark.urldocs-mark[data-a="' + i + '"]');
    if (mark) {
      mark.style.outline = "2px solid #333";
      setTimeout(() => (mark.style.outline = ""), 1200);
    }
  }

  clearBtn.addEventListener("click", () => {
    annotations = [];
    dirty = true;
    render();
    syncHash();
    showToast("All notes cleared");
  });

  // ---------- share link (URL hash) ----------
  function serialize() {
    const clean = annotations.map((a) => ({
      c: a.c,
      t: a.t,
      p: a.p.map((r) => ({ a: r.a, e: r.e, b: r.b })),
    }));
    return JSON.stringify({ u: pageUrl, a: clean });
  }

  function encodePayload(json) {
    return window.LZString
      ? LZString.compressToEncodedURIComponent(json)
      : encodeURIComponent(json);
  }

  function buildShareUrl() {
    return location.href.split("#")[0] + "#d=" + encodePayload(serialize());
  }

  function updateShareState() {
    shareBtn.disabled = annotations.length === 0;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* noop */ }
      ta.remove();
      return ok;
    }
  }

  shareBtn.addEventListener("click", async () => {
    if (annotations.length === 0) return;
    const url = buildShareUrl();
    const ok = await copyText(url);
    showToast(ok ? "Share link copied to clipboard" : "Clipboard blocked — check the console for the link", !ok);
    console.log("Share link:", url);
    history.replaceState(null, "", url);
  });

  function syncHash() {
    if (!dirty) return;
    dirty = false;
    // Same "#d=" prefix as shared links, so a plain refresh restores the notes.
    history.replaceState(null, "", "#d=" + encodePayload(serialize()));
  }

  function tryParsePayload(str) {
    try {
      const o = JSON.parse(str);
      return o && typeof o.u === "string" && Array.isArray(o.a) ? o : null;
    } catch {
      return null;
    }
  }

  function parseHash() {
    const h = location.hash;
    if (!h.startsWith("#d=")) return null;
    const data = h.slice(3);
    if (window.LZString) {
      const o = tryParsePayload(LZString.decompressFromEncodedURIComponent(data));
      if (o) return o;
    }
    try {
      return tryParsePayload(decodeURIComponent(data));
    } catch {
      return null;
    }
  }

  // ---------- restore from hash ----------
  (function init() {
    const obj = parseHash();
    if (obj && obj.a.length) {
      say("Found " + obj.a.length + " saved note" + (obj.a.length > 1 ? "s" : "") + " — loading " + shortUrl(obj.u) + " …");
      const anns = obj.a;
      anns.forEach((a, i) => (a.i = i));
      loadPage(obj.u, anns);
    }
  })();
})();

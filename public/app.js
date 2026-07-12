/*
 * app.js — the diary's conduct. Owns the live canvas lifecycle:
 *
 *   write (pointer) → idle 2.8s → "drink your ink" (fade) → commit page PNG
 *   → POST /api/chat (SSE) → sentenceCut → Handwriting.renderAndAnimate per
 *   sentence, serialized so each reply writes itself before the next begins.
 *
 * The page has exactly one canvas, shared in two roles: while writing it shows
 * the user's own strokes; while a reply streams in it becomes the surface the
 * quill writes onto. "Drinking the ink" is the hand-off between the two.
 */

(function () {
  "use strict";

  const IDLE_MS = 2800;          // pen still for this long → commit (matches Riddle)
  const PEN_COLOR = "rgba(205, 190, 162, 0.95)";
  const PEN_WIDTH = 2.4;
  const FADE_STEP_MS = 16;
  const FADE_PER_STEP = 0.06;    // ink sinks into the page
  const CFG_STORAGE_KEY = "riddle.config.v1";

  // Responsive scaling. Layout is measured in CSS pixels (window.innerWidth);
  // the canvas backing store is multiplied by devicePixelRatio so quill ink is
  // crisp on Retina/HiDPI phones & iPads. RX scales the layout-derived sizes
  // (pen width, margins, font, line height) so a phone gets the same proportions
  // as a desktop, not the desktop's literal pixels.
  let DPR = 1;
  let CSS_W = 0;        // canvas width in CSS px (= window.innerWidth)
  let CSS_H = 0;        // canvas height in CSS px (= window.innerHeight, minus iOS bars via dvh)
  function RX() { return Math.max(0.60, Math.min(1.15, CSS_W / 900)); }

  const canvas = document.getElementById("page");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");
  const configBtn = document.getElementById("configBtn");
  const configPanel = document.getElementById("configPanel");
  const cfgProvider = document.getElementById("cfgProvider");
  const cfgBaseUrl = document.getElementById("cfgBaseUrl");
  const cfgModel = document.getElementById("cfgModel");
  const cfgKey = document.getElementById("cfgKey");
  const cfgSave = document.getElementById("cfgSave");
  const cfgClear = document.getElementById("cfgClear");
  const cfgSaved = document.getElementById("cfgSaved");

  // In-memory mirror of the stored config, so streamReply can include it even if
  // the user hasn't reopened the panel since last save. Kept in sync by saveConfig.
  let config = { provider: "openai", baseUrl: "", model: "", key: "" };

  // --- canvas sizing ----------------------------------------------------------
  function resize() {
    // preserve nothing: clearing on resize is fine for a diary page.
    // Layout size comes from CSS (#page is 100vw / 100dvh, so iOS toolbar
    // changes resize it cleanly without the 100vh jump). The backing store is
    // scaled by devicePixelRatio so the quill writes crisp on Retina/HiDPI.
    DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const r = canvas.getBoundingClientRect();
    CSS_W = Math.max(1, Math.round(r.width));
    CSS_H = Math.max(1, Math.round(r.height));
    canvas.width = Math.floor(CSS_W * DPR);
    canvas.height = Math.floor(CSS_H * DPR);
    // keep the displayed size at CSS pixels (CSS already does; set explicitly so
    // a stale inline size from an older call never lingers)
    canvas.style.width = CSS_W + "px";
    canvas.style.height = CSS_H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);  // draw in CSS px, stored at DPR
    paintBackground();
    redrawUserStrokes();
  }

  function paintBackground() {
    ctx.fillStyle = "#1a1611";
    ctx.fillRect(0, 0, CSS_W, CSS_H);
  }

  // --- user handwriting state -------------------------------------------------
  // strokes: array of { points: [{x,y}], color, width }
  // Kept so we can redraw after resize and fade them out when the diary "drinks".
  let strokes = [];
  let drawing = false;
  let currentStroke = null;
  let idleTimer = null;
  let busy = false;              // true while the diary is drinking/thinking/writing back

  function redrawUserStrokes() {
    for (const s of strokes) drawStroke(s, 1);
  }

  function drawStroke(s, alpha) {
    if (!s.points.length) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // --- pointer input ----------------------------------------------------------
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (busy) return;
    canvas.setPointerCapture?.(e.pointerId);
    drawing = true;
    currentStroke = { points: [pos(e)], color: PEN_COLOR, width: PEN_WIDTH * RX() };
    strokes.push(currentStroke);
    hintEl.classList.add("faded");
    clearTimeout(idleTimer);
  }

  function onMove(e) {
    if (!drawing) return;
    const p = pos(e);
    const prev = currentStroke.points[currentStroke.points.length - 1];
    currentStroke.points.push(p);
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = currentStroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function onUp() {
    if (!drawing) return;
    drawing = false;
    currentStroke = null;
    scheduleCommit();
  }

  function scheduleCommit() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(commit, IDLE_MS);
  }

  // --- commit: drink the ink, send the page ----------------------------------
  async function commit() {
    if (busy || !strokes.length) return;
    busy = true;
    setBusyUI(true);
    setStatus("the diary is drinking your ink…");

    const image = canvas.toDataURL("image/png");

    await drinkInk();           // fade user strokes away
    strokes = [];
    paintBackground();

    setStatus("the diary is thinking…");
    try {
      await streamReply(image);
    } catch (err) {
      // surface a graceful in-character failure rather than a thrown page
      console.error("streamReply failed:", err);
      await Handwriting.renderAndAnimate(
        "Something troubles the ink. Try your page again.",
        ctx,
        { fontPx: Math.round(46 * RX()), offsetX: Math.round(80 * RX()), offsetY: CSS_H / 2 }
      );
    } finally {
      setStatus("");
      busy = false;
      setBusyUI(false);
      hintEl.classList.remove("faded");
    }
  }

  function drinkInk() {
    return new Promise((resolve) => {
      let alpha = 1;
      const tick = () => {
        alpha -= FADE_PER_STEP;
        if (alpha <= 0) {
          paintBackground();
          resolve();
          return;
        }
        paintBackground();
        for (const s of strokes) drawStroke(s, alpha);
        setTimeout(tick, FADE_STEP_MS);
      };
      tick();
    });
  }

  // --- SSE consumption + sentence-by-sentence inking -------------------------
  // Sentence boundaries mirror Riddle's sentence_cut: . ! ? … followed by space.
  function sentenceCut(accumulated) {
    // returns [completeSentencesJoined, remainder]
    const boundaries = /[.!?…]+[\s]/;
    let rest = accumulated;
    let sentences = [];
    while (true) {
      const m = rest.match(boundaries);
      if (!m || m.index === undefined) break;
      const end = m.index + m[0].length;
      sentences.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    return [sentences.join(""), rest];
  }

  async function streamReply(image) {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image,
        base_url: config.baseUrl || undefined,
        model: config.model || undefined,
        key: config.key || undefined,
      }),
    });
    if (!resp.ok || !resp.body) throw new Error(`chat ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulatedText = "";
    const rx = RX();
    let nextY = Math.round(CSS_H / 2);
    const lineHeight = Math.round(CSS_H * 0.12);
    const margin = Math.round(80 * rx);
    const maxRight = CSS_W - margin;

    // Serialize sentence-writing: each promise resolves only after the quill finishes.
    let writeChain = Promise.resolve();
    let pendingSentence = "";

    const flushSentences = (force) => {
      const [complete, remainder] = sentenceCut(accumulatedText + (force ? " " : ""));
      if (!complete) {
        pendingSentence = remainder;
        return;
      }
      const toWrite = complete;
      accumulatedText = remainder;
      pendingSentence = remainder;

      // Split into lines that fit; write each on its own row.
      const pieces = toWrite.match(/[^.!?…]+[.!?…]*\s*/g) || [toWrite];
      for (const piece of pieces) {
        const pe = piece.trim();
        if (!pe) continue;
        writeChain = writeChain.then(async () => {
          const y = nextY;
          const res = await Handwriting.renderAndAnimate(pe, ctx, {
            fontPx: Math.round(52 * rx),
            offsetX: margin,
            offsetY: y,
          });
          nextY = Math.min(CSS_H - lineHeight, y + lineHeight);
        });
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // parse SSE: events separated by \n\n; data lines start with "data:"
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (data === "[DONE]") {
          flushSentences(true);
          // write any trailing prose that never hit a sentence boundary
          if (pendingSentence.trim()) {
            writeChain = writeChain.then(() =>
              Handwriting.renderAndAnimate(pendingSentence.trim(), ctx, {
                fontPx: Math.round(52 * rx), offsetX: margin, offsetY: nextY,
              })
            );
          }
          await writeChain;
          return;
        }
        try {
          const obj = JSON.parse(data);
          if (obj.delta) {
            accumulatedText += obj.delta;
            flushSentences(false);
          }
        } catch (_) { /* ignore malformed chunk */ }
      }
    }
    await writeChain;
  }

  // --- bits -------------------------------------------------------------------
  function setStatus(text) {
    if (!text) { statusEl.classList.add("hidden"); return; }
    statusEl.textContent = text;
    statusEl.classList.remove("hidden");
  }

  // --- config panel ----------------------------------------------------------
  // Providers come from the server so the BASE_URL presets stay in one place.
  // The dropdown is seeded on first load; the chosen provider only changes the
  // BASE_URL field, it never changes the request shape (always OpenAI-compatible).
  let providers = [];

  function setBusyUI(disabled) {
    configBtn.disabled = disabled;
    cfgSave.disabled = disabled;
    cfgClear.disabled = disabled;
  }

  function flashSaved(msg) {
    cfgSaved.textContent = msg;
    cfgSaved.classList.add("show");
    setTimeout(() => cfgSaved.classList.remove("show"), 1600);
  }

  async function initConfigPanel() {
    // populate provider dropdown
    try {
      const resp = await fetch("/api/defaults");
      const data = await resp.json();
      providers = data.providers || [];
      const defaults = data.defaults || {};
      for (const p of providers) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        cfgProvider.appendChild(opt);
      }
      // populate vision-model suggestions on the MODEL field (datalist)
      const modelList = document.getElementById("visionModels");
      if (modelList) {
        for (const m of (data.vision_models || [])) {
          const o = document.createElement("option");
          o.value = m;
          modelList.appendChild(o);
        }
      }
      // load saved config, falling back to server defaults for empty fields
      const saved = loadStored();
      config = { ...config, ...saved };
      cfgProvider.value = config.provider || "openai";
      cfgBaseUrl.value = config.baseUrl ?? defaults.base_url ?? "";
      cfgModel.value = config.model ?? defaults.model ?? "";
      // key is NOT prefilled into the field — retype each session is safer, and
      // showing it would imply we keep it around permanently.
      cfgKey.value = config.key || "";
    } catch (e) {
      console.warn("could not load /api/defaults:", e);
      // still let the user type manually
      cfgProvider.appendChild(new Option("Custom", "custom"));
    }
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(CFG_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }

  function saveConfig() {
    config = {
      provider: cfgProvider.value,
      baseUrl: cfgBaseUrl.value.trim(),
      model: cfgModel.value.trim(),
      key: cfgKey.value, // keep as-is; trailing spaces dropped at use time
    };
    try {
      localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(config));
    } catch (_) { /* private mode etc. */ }
    flashSaved(
      config.key ? "saved — the diary will use this oracle."
                 : "saved — empty key, the diary uses the offline mock."
    );
  }

  function clearConfig() {
    config = { provider: "openai", baseUrl: "", model: "", key: "" };
    try { localStorage.removeItem(CFG_STORAGE_KEY); } catch (_) {}
    cfgProvider.value = "openai";
    cfgBaseUrl.value = "";
    cfgModel.value = "";
    cfgKey.value = "";
    flashSaved("cleared.");
  }

  function onProviderChange() {
    const sel = providers.find((p) => p.id === cfgProvider.value);
    if (!sel) return;
    const cur = cfgBaseUrl.value.trim();
    // only overwrite BASE_URL when it's empty or already matches another preset —
    // never clobber a value the user typed themselves.
    const isPreset = providers.some((p) => p.defaultBaseUrl && p.defaultBaseUrl === cur);
    if (!cur || isPreset) cfgBaseUrl.value = sel.defaultBaseUrl;
  }

  function togglePanel() {
    if (configBtn.disabled) return;
    configPanel.classList.toggle("hidden");
  }

  // --- wire up ----------------------------------------------------------------
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onUp);
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));
  // iOS Safari sometimes resizes without firing a classic event after the
  // toolbar hides; a visualViewport listener catches that without looping.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      // avoid clearing an in-flight stroke's canvas on every micro-change
      if (!drawing) resize();
    });
  }
  configBtn.addEventListener("click", togglePanel);
  cfgProvider.addEventListener("change", onProviderChange);
  cfgSave.addEventListener("click", saveConfig);
  cfgClear.addEventListener("click", clearConfig);

  resize();
  initConfigPanel();
})();

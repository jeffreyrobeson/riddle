/*
 * handwriting.js — turn a sentence into a quill writing it by hand.
 *
 * Pipeline (mirrors Riddle's src/handwriting, minus the e-ink specifics):
 *   1. rasterize the text with the Dancing Script typeface to an offscreen canvas
 *   2. binarize to a 0/1 mask by luminance threshold
 *   3. Zhang–Suen skeletonization → single-pixel-wide spine
 *   4. chain-code trace: walk the skeleton into ordered pen strokes [stroke][point]{x,y}
 *   5. requestAnimationFrame replay onto the live canvas, a fixed number of
 *      skeleton-pixels worth of arc per frame, so each word writes itself in.
 *
 * Exported window.Handwriting.renderAndAnimate(text, ctx, opts) -> Promise<void>
 * resolves when the whole sentence has been drawn.
 */

(function () {
  "use strict";

  // Match what Riddle uses for the "hand" of the diary.
  const INK_FONT = '"Dancing Script", cursive';
  // How fast the quill moves, in skeleton pixels advanced per animation frame.
  const PIXELS_PER_FRAME = 110;
  // Replay stroke color — faded ink on aged paper.
  const INK_RGB = "210, 196, 166"; // warm parchment-ink
  const INK_ALPHA_MAX = 0.92;

  // ---------------------------------------------------------------------------
  // Step 1 + 2: raster → binary mask. Foreground=1, background=0.
  // ---------------------------------------------------------------------------
  function rasterize(text, fontPx) {
    const measurer = document.createElement("canvas");
    const mctx = measurer.getContext("2d");
    mctx.font = `${fontPx}px ${INK_FONT}`;
    const metrics = mctx.measureText(text);
    const width = Math.max(1, Math.ceil(metrics.width) + 4);
    const height = Math.ceil(fontPx * 1.45);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";                       // ink color doesn't matter; luminance does
    ctx.font = `${fontPx}px ${INK_FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 2, height / 2);

    const img = ctx.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      // alpha channel of an opaque glyph on transparent canvas is our mask source.
      // Falling back to luminance covers any antialiasing edge case.
      const a = img.data[i * 4 + 3];
      mask[i] = a > 40 ? 1 : 0;
    }
    return { mask, width, height };
  }

  // ---------------------------------------------------------------------------
  // Step 3: Zhang–Suen thinning.
  // Classic two-pass algorithm. Produces a 1px-wide skeleton by iteratively
  // deleting boundary pixels that satisfy the 8-neighborhood conditions.
  // ---------------------------------------------------------------------------
  function zhangSuen(mask, w, h) {
    const m = new Uint8Array(mask); // work copy
    const toDelete = [];            // reused scratch
    let changed = true;
    while (changed) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        toDelete.length = 0;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            if (m[idx] !== 1) continue;
            const p2 = m[(y - 1) * w + x];
            const p3 = m[(y - 1) * w + x + 1];
            const p4 = m[y * w + x + 1];
            const p5 = m[(y + 1) * w + x + 1];
            const p6 = m[(y + 1) * w + x];
            const p7 = m[(y + 1) * w + x - 1];
            const p8 = m[y * w + x - 1];
            const p9 = m[(y - 1) * w + x - 1];
            const neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (neighbors < 2 || neighbors > 6) continue;
            // transitions 0->1 around the 8-cycle
            const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
            let transitions = 0;
            for (let k = 0; k < 8; k++) {
              if (seq[k] === 0 && seq[k + 1] === 1) transitions++;
            }
            if (transitions !== 1) continue;
            if (pass === 0) {
              if (p2 * p4 * p6 !== 0) continue;
              if (p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0) continue;
              if (p2 * p6 * p8 !== 0) continue;
            }
            toDelete.push(idx);
          }
        }
        if (toDelete.length) changed = true;
        for (const idx of toDelete) m[idx] = 0;
      }
    }
    return m;
  }

  // ---------------------------------------------------------------------------
  // Step 4: chain-code trace. Walk the skeleton into ordered pen strokes.
  //
  // Strategy: repeatedly pick an endpoint (a foreground pixel with exactly one
  // foreground neighbor) — or, if none remain, any leftover foreground pixel
  // (a closed loop) — and greedy-walk through unvisited foreground neighbors in
  // 8-connectivity. Walking marks pixels visited so each is consumed once.
  // Each maximal walk becomes one stroke. Strokes within one sentence are kept
  // in discovery order so the replay looks like continuous cursive writing.
  // ---------------------------------------------------------------------------
  const NB = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];

  function neighborCount(m, x, y, w, h) {
    let c = 0;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (m[ny * w + nx] === 1) c++;
    }
    return c;
  }

  function traceSkeleton(m, w, h) {
    const visited = new Uint8Array(w * h);
    const strokes = [];

    const findStart = () => {
      // prefer endpoints (1 neighbor) — these are natural pen-start/pen-end spots
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (m[idx] === 1 && !visited[idx] && neighborCount(m, x, y, w, h) === 1) {
            return [x, y];
          }
        }
      }
      // then any remaining foreground (closed loops / blobs)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (m[idx] === 1 && !visited[idx]) return [x, y];
        }
      }
      return null;
    };

    let start = findStart();
    while (start) {
      const [sx, sy] = start;
      let x = sx, y = sy;
      const stroke = [];
      // mark first pixel and walk
      visited[y * w + x] = 1;
      stroke.push({ x, y });
      while (true) {
        let next = null;
        for (const [dx, dy] of NB) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (m[ni] === 1 && !visited[ni]) {
            next = [nx, ny];
            break;
          }
        }
        if (!next) break;
        x = next[0]; y = next[1];
        visited[y * w + x] = 1;
        stroke.push({ x, y });
      }
      strokes.push(stroke);
      start = findStart();
    }
    return strokes;
  }

  // ---------------------------------------------------------------------------
  // Step 5: replay strokes onto the live canvas with requestAnimationFrame.
  // Advances PIXELS_PER_FRAME worth of points each frame and draws line segments
  // along the stroke polyline. Resolves when every stroke is finished.
  // ---------------------------------------------------------------------------
  function replay(strokes, target, offsetX, offsetY, scale) {
    return new Promise((resolve) => {
      // flatten into one list of segments so we can advance uniformly
      const segs = []; // {x0,y0,x1,y1} per consecutive pair
      for (const s of strokes) {
        for (let i = 1; i < s.length; i++) {
          segs.push({
            x0: s[i - 1].x, y0: s[i - 1].y,
            x1: s[i].x, y1: s[i].y,
            length: Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y),
          });
        }
        // a small "pen-up gap" between strokes so cursive lifts read as a pause
        segs.push({ penup: true, length: 6 });
      }

      let segIdx = 0;
      let segDone = 0; // distance covered into the current segment

      const ctx = target.getContext("2d");
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1.4, 2.2 * scale);
      ctx.strokeStyle = `rgba(${INK_RGB}, ${INK_ALPHA_MAX})`;

      const tx = (px) => offsetX + px * scale;
      const ty = (py) => offsetY + py * scale;

      const step = () => {
        if (segIdx >= segs.length) {
          resolve();
          return;
        }
        for (let budget = PIXELS_PER_FRAME; budget > 0 && segIdx < segs.length; ) {
          const seg = segs[segIdx];
          if (seg.penup) {
            segIdx++;
            budget -= seg.length;
            continue;
          }
          const remaining = seg.length - segDone;
          const take = Math.min(budget, remaining);
          const t0 = segDone / Math.max(0.0001, seg.length);
          const t1 = (segDone + take) / Math.max(0.0001, seg.length);
          ctx.beginPath();
          ctx.moveTo(tx(lerp(seg.x0, seg.x1, t0)), ty(lerp(seg.y0, seg.y1, t0)));
          ctx.lineTo(tx(lerp(seg.x0, seg.x1, t1)), ty(lerp(seg.y0, seg.y1, t1)));
          ctx.stroke();
          segDone += take;
          budget -= take;
          if (segDone >= seg.length - 0.001) {
            segIdx++;
            segDone = 0;
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------------------
  // Public entry point. Animate one sentence.
  //
  // opts: { fontPx, scale, offsetX, offsetY } — placement onto the live canvas.
  // Returns a Promise resolved when the quill finishes this sentence.
  // ---------------------------------------------------------------------------
  async function renderAndAnimate(text, ctx, opts = {}) {
    if (!text || !text.trim()) return;
    const fontPx = opts.fontPx || 56;
    const scale = opts.scale || 1.0;

    // Wait for the hand to be loaded, otherwise the raster is in fallback serif.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) { /* fonts API optional */ }
    }

    const { mask, width, height } = rasterize(text, fontPx);
    const skel = zhangSuen(mask, width, height);
    const strokes = traceSkeleton(skel, width, height);
    if (!strokes.length) return;

    // Place the sentence starting at opts.offsetX on the live canvas.
    const offsetX = opts.offsetX ?? 80;
    const offsetY = opts.offsetY ?? (ctx.canvas.height / 2);
    await replay(strokes, ctx.canvas, offsetX, offsetY, scale);
    return { width: width * scale, height: height * scale, strokes };
  }

  window.Handwriting = { renderAndAnimate };
})();

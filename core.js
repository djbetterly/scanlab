// ScanLab core: JS port of scripts/contact_sheet.py (keep the two in sync).
// Pure functions on {data: Uint8ClampedArray RGBA, width, height}.
// Works in the browser and in Node (for parity tests).
(function (root) {
  'use strict';
  const P = {
    CLIP: 0.02, WCLIP: 0.02, CCLIP: 0.1, BW_CHROMA: 40,
    PRINT_IN: [8, 10], PRINT_DPI: 300, MARGIN_IN: 0.25, STRIP_DPI: 600,
  };

  function runs(mask, minlen) {
    const out = []; let start = -1;
    for (let i = 0; i <= mask.length; i++) {
      const v = i < mask.length && mask[i];
      if (v && start < 0) start = i;
      if (!v && start >= 0) { if (i - start >= minlen) out.push([start, i]); start = -1; }
    }
    return out;
  }

  function median(buf, n) {          // buf: Float32Array scratch (sorted in place)
    const s = buf.subarray(0, n).sort();
    return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function percentile(sorted, p) {    // numpy 'linear'
    const n = sorted.length; if (!n) return 0;
    const idx = (p / 100) * (n - 1), lo = Math.floor(idx), hi = Math.min(lo + 1, n - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Luminance as mean of RGB (matches L = a.mean(axis=2)).
  function lumOf(img) {
    const { data, width: W, height: H } = img, L = new Float32Array(W * H);
    for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    return L;
  }

  // View of L with long axis as rows. get(r, c).
  function view(L, W, H) {
    const vertical = H >= W;
    return vertical
      ? { h: H, w: W, vertical, get: (r, c) => L[r * W + c] }
      : { h: W, w: H, vertical, get: (r, c) => L[c * W + r] };
  }

  // Lines of A[r0:r1, c0:c1]; axis 0 -> one value per column, axis 1 -> per row.
  // Returns {rebate: Uint8Array, med: Float32Array}.
  function rebateLines(A, r0, r1, c0, c1, axis, darkOk) {
    const nLines = axis === 0 ? c1 - c0 : r1 - r0, len = axis === 0 ? r1 - r0 : c1 - c0;
    const buf = new Float32Array(len), vals = new Float32Array(len);
    const rebate = new Uint8Array(nLines), med = new Float32Array(nLines);
    for (let k = 0; k < nLines; k++) {
      for (let t = 0; t < len; t++) vals[t] = axis === 0 ? A.get(r0 + t, c0 + k) : A.get(r0 + k, c0 + t);
      buf.set(vals); const m = median(buf, len);
      let flat = 0; for (let t = 0; t < len; t++) if (Math.abs(vals[t] - m) <= 8) flat++;
      let r = m < 120 && flat / len >= 0.85;
      if (darkOk && m < 40) r = true;
      rebate[k] = r ? 1 : 0; med[k] = m;
    }
    return { rebate, med };
  }

  // Returns [{measure:[y0,y1,x0,x1], apply:[y0,y1,x0,x1]}] in image coords.
  function detectFrames(L, W, H) {
    const A = view(L, W, H), boxes = [];
    const not = (u) => Array.from(u, (v) => !v);
    const lanes = runs(not(rebateLines(A, 0, A.h, 0, A.w, 0).rebate), A.w * 0.08);
    for (const [x0, x1] of lanes) {
      const laneW = x1 - x0;
      const rows = runs(not(rebateLines(A, 0, A.h, x0, x1, 1, true).rebate), laneW * 0.4);
      for (const [y0, y1] of rows) {
        const cl = rebateLines(A, y0, y1, x0, x1, 0);
        const cols = runs(not(cl.rebate), laneW * 0.3);
        if (!cols.length) continue;
        const [c0, c1] = cols.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
        const ratio = (y1 - y0) / (c1 - c0);
        if (ratio < 0.5 || ratio > 2.0) continue;
        let a0 = c0, a1 = c1;
        while (a0 > 0 && cl.med[a0 - 1] < 40) a0--;
        while (a1 < laneW && cl.med[a1] < 40) a1++;
        boxes.push({ measure: [y0, y1, x0 + c0, x0 + c1], apply: [y0, y1, x0 + a0, x0 + a1] });
      }
    }
    if (!A.vertical) for (const b of boxes)
      for (const k of ['measure', 'apply']) { const [y0, y1, x0, x1] = b[k]; b[k] = [x0, x1, y0, y1]; }
    return boxes;
  }

  function isBW(img, L) {
    const d = img.data, ch = [];
    for (let j = 0, i = 0; j < L.length; j++, i += 4) if (L[j] > 60) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      ch.push(Math.max(r, g, b) - Math.min(r, g, b));
    }
    if (!ch.length) return true;
    return percentile(Float32Array.from(ch).sort(), 95) < P.BW_CHROMA;
  }

  const clip255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  function region(L, W, [y0, y1, x0, x1], n) {
    const out = new Float32Array(Math.max(0, (y1 - y0 - 2 * n) * (x1 - x0 - 2 * n))); let k = 0;
    for (let y = y0 + n; y < y1 - n; y++) for (let x = x0 + n; x < x1 - n; x++) out[k++] = L[y * W + x];
    return out;
  }

  function colorBalance(img, out, W, m, ap, n) {
    const [y0, y1, x0, x1] = m, d = img.data, info = {};
    const N = (y1 - y0 - 2 * n) * (x1 - x0 - 2 * n), reg = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    let k = 0;
    for (let y = y0 + n; y < y1 - n; y++) for (let x = x0 + n; x < x1 - n; x++, k++) {
      const i = (y * W + x) * 4; reg[0][k] = d[i]; reg[1][k] = d[i + 1]; reg[2][k] = d[i + 2];
    }
    const [ay0, ay1, ax0, ax1] = ap;
    const forApply = (f) => { for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) f((y * W + x) * 3); };
    // 1. per-channel levels
    for (let c = 0; c < 3; c++) {
      const s = Float32Array.from(reg[c]).sort();
      const bp = percentile(s, P.CCLIP), wp = percentile(s, 100 - P.CCLIP), kk = 255 / Math.max(wp - bp, 1);
      forApply((i) => { out[i + c] = (out[i + c] - bp) * kk; });
      for (let t = 0; t < N; t++) reg[c][t] = clip255((reg[c][t] - bp) * kk);
    }
    forApply((i) => { for (let c = 0; c < 3; c++) out[i + c] = clip255(out[i + c]); });
    const lumChroma = () => {
      const lum = new Float32Array(N), chroma = new Float32Array(N);
      for (let t = 0; t < N; t++) {
        const r = reg[0][t], g = reg[1][t], b = reg[2][t];
        lum[t] = (r + g + b) / 3; chroma[t] = Math.max(r, g, b) - Math.min(r, g, b);
      }
      return [lum, chroma];
    };
    // 2. highlight white balance
    let [lum, chroma] = lumChroma();
    let idx = []; for (let t = 0; t < N; t++) if (lum[t] > 190) idx.push(t);
    if (idx.length > 500) {
      const thr = percentile(Float32Array.from(idx, (t) => chroma[t]).sort(), 50);
      const mm = [0, 0, 0]; let cnt = 0;
      for (const t of idx) if (chroma[t] <= thr) { for (let c = 0; c < 3; c++) mm[c] += reg[c][t]; cnt++; }
      for (let c = 0; c < 3; c++) mm[c] /= cnt;
      const mx = Math.max(...mm), gains = mm.map((v) => Math.min(1.25, Math.max(1.0, mx / Math.max(v, 1))));
      forApply((i) => { for (let c = 0; c < 3; c++) out[i + c] = clip255(out[i + c] * gains[c]); });
      for (let c = 0; c < 3; c++) for (let t = 0; t < N; t++) reg[c][t] = clip255(reg[c][t] * gains[c]);
      info.gain = gains.map((g) => +g.toFixed(2));
    }
    // 3. midtone grey balance (half strength, clamped)
    [lum, chroma] = lumChroma();
    idx = []; for (let t = 0; t < N; t++) if (lum[t] > 50 && lum[t] < 190) idx.push(t);
    if (idx.length > 500) {
      const thr = percentile(Float32Array.from(idx, (t) => chroma[t]).sort(), 25);
      const mm = [0, 0, 0]; let cnt = 0;
      for (const t of idx) if (chroma[t] < thr) { for (let c = 0; c < 3; c++) mm[c] += reg[c][t]; cnt++; }
      if (cnt) {
        for (let c = 0; c < 3; c++) mm[c] /= cnt;
        const target = (mm[0] + mm[1] + mm[2]) / 3;
        const gs = mm.map((v) => {
          let g = Math.log(target / 255) / Math.log(Math.min(254, Math.max(1, v)) / 255);
          return Math.min(1.18, Math.max(0.85, 1 + (g - 1) * 0.5));
        });
        forApply((i) => { for (let c = 0; c < 3; c++) out[i + c] = 255 * Math.pow(out[i + c] / 255, gs[c]); });
        info.gamma = gs.map((g) => +g.toFixed(2));
      }
    }
    return info;
  }

  // Correct one strip. Returns {img (RGBA ImageData-like), bw, frames:[...]}
  function correctStrip(img) {
    const { width: W, height: H, data } = img, L = lumOf(img), bw = isBW(img, L);
    const out = new Float32Array(W * H * 3);
    for (let j = 0, i = 0; j < W * H; j++, i += 4) { out[j * 3] = data[i]; out[j * 3 + 1] = data[i + 1]; out[j * 3 + 2] = data[i + 2]; }
    const frames = [];
    for (const { measure, apply } of detectFrames(L, W, H)) {
      const [y0, y1, x0, x1] = measure;
      const n = Math.max(5, Math.floor(Math.min(y1 - y0, x1 - x0) * 0.065));
      if (y1 - y0 <= 2 * n || x1 - x0 <= 2 * n) continue;
      if (bw) {
        const s = region(L, W, measure, n).sort();
        const bp = percentile(s, P.CLIP), wp = percentile(s, 100 - P.WCLIP), kk = 255 / Math.max(wp - bp, 1);
        const [ay0, ay1, ax0, ax1] = apply;
        for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) {
          const i = (y * W + x) * 3;
          for (let c = 0; c < 3; c++) out[i + c] = clip255((out[i + c] - bp) * kk);
        }
        frames.push({ box: measure, black: Math.round(bp), white: Math.round(wp) });
      } else {
        frames.push({ box: measure, ...colorBalance(img, out, W, measure, apply, n) });
      }
    }
    const res = new Uint8ClampedArray(W * H * 4);
    for (let j = 0; j < W * H; j++) {
      let r = Math.round(out[j * 3]), g = Math.round(out[j * 3 + 1]), b = Math.round(out[j * 3 + 2]);
      if (bw) { const y = Math.round((r * 299 + g * 587 + b * 114) / 1000); r = g = b = y; } // PIL 'L'; saturation exactly 0
      res[j * 4] = r; res[j * 4 + 1] = g; res[j * 4 + 2] = b; res[j * 4 + 3] = 255;
    }
    return { img: { data: res, width: W, height: H }, bw, frames };
  }

  // Sheet layout (pre-scaling): vertical strips side by side, horizontal stacked below.
  function sheetLayout(sizes) {
    const pad = 60, vert = [], horz = [];
    sizes.forEach((s, i) => (s.h >= s.w ? vert : horz).push(i));
    const rowW = vert.reduce((a, i) => a + sizes[i].w, 0) + pad * Math.max(vert.length - 1, 0);
    const rowH = Math.max(0, ...vert.map((i) => sizes[i].h));
    const W = Math.max(rowW, ...horz.map((i) => sizes[i].w)) + 2 * pad;
    const H = pad + rowH + horz.reduce((a, i) => a + sizes[i].h + pad, 0) + (vert.length ? pad : 0);
    const pos = []; let x = pad;
    for (const i of vert) { pos[i] = [x, pad]; x += sizes[i].w + pad; }
    let y = pad + rowH + (vert.length ? pad : 0);
    for (const i of horz) { pos[i] = [pad, y]; y += sizes[i].h + pad; }
    // fit to print
    const [wi, hi] = H >= W ? P.PRINT_IN : [P.PRINT_IN[1], P.PRINT_IN[0]];
    const PW = wi * P.PRINT_DPI, PH = hi * P.PRINT_DPI, m = Math.round(P.MARGIN_IN * P.PRINT_DPI), labelH = Math.round(0.3 * P.PRINT_DPI);
    const bw = PW - 2 * m, bh = PH - 2 * m - labelH, k = Math.min(bw / W, bh / H);
    const sw = Math.round(W * k), sh = Math.round(H * k);
    return { layoutW: W, layoutH: H, pos, printW: PW, printH: PH, scale: k,
      dest: [Math.floor((PW - sw) / 2), m + Math.floor((bh - sh) / 2), sw, sh],
      label: [m, PH - m - labelH + 20] };
  }

  // Patch JFIF APP0 density -> dpi (canvas JPEGs carry no/1:1 density).
  function setJpegDpi(bytes, dpi) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] === 0xe0 &&
        String.fromCharCode(...bytes.subarray(6, 10)) === 'JFIF') {
      bytes[13] = 1; bytes[14] = dpi >> 8; bytes[15] = dpi & 255; bytes[16] = dpi >> 8; bytes[17] = dpi & 255;
      return bytes;
    }
    const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
    const outb = new Uint8Array(bytes.length + app0.length);
    outb.set(bytes.subarray(0, 2)); outb.set(app0, 2); outb.set(bytes.subarray(2), 2 + app0.length);
    return outb;
  }

  root.ScanCore = { P, runs, detectFrames, lumOf, isBW, correctStrip, sheetLayout, setJpegDpi, percentile };
  if (typeof module !== 'undefined') module.exports = root.ScanCore;
})(typeof window !== 'undefined' ? window : globalThis);

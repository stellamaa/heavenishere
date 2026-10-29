(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), trail = $('trail'), ui = $('ui'), srcC = $('src');
  const tctx = trail.getContext('2d'), uctx = ui.getContext('2d');
  const sctx = srcC.getContext('2d', { willReadFrequently: true });
  const SW = srcC.width, SH = srcC.height;
  const pauseBtn = $('pause'), sceneBtn = $('scene'), fileIn = $('file'), trails = $('trails'), note = $('note');
  const hueTxt = $('hueTxt'), chromaTxt = $('chromaTxt'), lightTxt = $('lightTxt'), nTxt = $('nTxt'), sw = $('sw');

  const root = getComputedStyle(document.documentElement);
  const tok = (n) => root.getPropertyValue(n).trim();
  const BG = tok('--bg'), INK = tok('--ink'), DIM = tok('--dim'), LINE = tok('--line-strong');
  const bgRGB = [1, 3, 5].map((i) => parseInt(BG.slice(i, i + 2), 16));
  const TAU = Math.PI * 2;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const HUES = ['Red', 'Orange', 'Yellow', 'Chartreuse', 'Green', 'Spring', 'Cyan', 'Azure', 'Blue', 'Violet', 'Magenta', 'Rose'];
  const hueName = (h) => HUES[Math.round(h / 30) % 12];
  const ang = (h) => ((h - 90) * Math.PI) / 180;

  let W = 1, H = 1, dpr = 1, cx = 0, cy = 0, R = 40, ptr = null;
  let running = false, raf = 0, last = 0, frame = 0, tScene = 0, pluckAcc = 0, nextPluck = 0.6;
  let src = { kind: 'scene', el: null };
  let objUrl = null;
  let stats = { sx: 0, sy: 0, c: 0, l: 0, n: 0 };
  const sec = new Float32Array(12);

  /* ---------- built-in scene: drifting colour blobs ---------- */
  const BLOBS = [
    { fx: 0.31, fy: 0.23, px: 0.0, py: 1.2, fr: 0.5, pr: 0.3, h: 8, hs: 9, s: 90, l: 52, r: 0.34 },
    { fx: 0.22, fy: 0.37, px: 1.7, py: 0.4, fr: 0.4, pr: 2.1, h: 48, hs: -7, s: 95, l: 55, r: 0.30 },
    { fx: 0.41, fy: 0.19, px: 3.1, py: 2.2, fr: 0.6, pr: 1.0, h: 140, hs: 6, s: 70, l: 46, r: 0.32 },
    { fx: 0.27, fy: 0.43, px: 4.4, py: 3.6, fr: 0.3, pr: 0.7, h: 200, hs: 11, s: 85, l: 50, r: 0.36 },
    { fx: 0.36, fy: 0.29, px: 5.2, py: 0.9, fr: 0.55, pr: 2.8, h: 262, hs: -9, s: 80, l: 54, r: 0.30 },
    { fx: 0.19, fy: 0.33, px: 2.4, py: 4.1, fr: 0.45, pr: 1.6, h: 318, hs: 8, s: 88, l: 56, r: 0.28 },
    { fx: 0.29, fy: 0.26, px: 0.8, py: 2.9, fr: 0.35, pr: 3.3, h: 0, hs: 0, s: 0, l: 88, r: 0.22 }
  ];
  function drawScene(g, w, h, t) {
    const b = (t * 5) % 360;
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, `hsl(${b} 40% 16%)`);
    bg.addColorStop(1, `hsl(${(b + 120) % 360} 36% 8%)`);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    for (const o of BLOBS) {
      const x = w * (0.5 + 0.36 * Math.sin(t * o.fx + o.px));
      const y = h * (0.5 + 0.34 * Math.cos(t * o.fy + o.py));
      const r = h * (o.r + 0.08 * Math.sin(t * o.fr + o.pr));
      const hue = (((o.h + t * o.hs) % 360) + 360) % 360;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `hsla(${hue},${o.s}%,${o.l}%,0.95)`);
      gr.addColorStop(0.6, `hsla(${hue},${o.s}%,${o.l - 10}%,0.45)`);
      gr.addColorStop(1, `hsla(${hue},${o.s}%,${o.l - 14}%,0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }
  }
  function drawCover(el) {
    const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.max(SW / iw, SH / ih), dw = iw * s, dh = ih * s;
    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = BG;
    sctx.fillRect(0, 0, SW, SH);
    sctx.drawImage(el, (SW - dw) / 2, (SH - dh) / 2, dw, dh);
  }
  function sample() {
    if (src.kind === 'scene') drawScene(sctx, SW, SH, tScene);
    else drawCover(src.el);
    try { return sctx.getImageData(0, 0, SW, SH).data; } catch (e) { return null; }
  }

  /* ---------- polar plot ---------- */
  const PH = new Float32Array(SW * SH), PC = new Float32Array(SW * SH), PL = new Float32Array(SW * SH);
  const boostIn = $('boost');
  let avx = 0, avy = 0, cpeakS = 0.2;
  /* Exaggerate: muted pictures are stretched so they still fill the wheel. Chroma is auto-gained against the
     recent peak, and hues are fanned out around the picture's own mean hue when they sit in a narrow band. */
  function render(data, fade) {
    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = 1;
    tctx.fillStyle = `rgba(${bgRGB[0]},${bgRGB[1]},${bgRGB[2]},${fade})`;
    tctx.fillRect(0, 0, W, H);
    if (!data) return;
    const a = +boostIn.value / 100;
    const gainC = 1 + a * (Math.min(10, Math.max(1, 0.85 / Math.max(cpeakS, 0.04))) - 1);
    const rho0 = Math.hypot(avx, avy);
    const spreadF = 1 + a * 3 * rho0 * rho0;
    const mh0 = (Math.atan2(avy, avx) * 180) / Math.PI;
    tctx.globalCompositeOperation = 'multiply';
    tctx.globalAlpha = 0.85;
    const sz = Math.max(1.8, R * 0.014);
    const n = data.length / 4;
    let sx = 0, sy = 0, sc = 0, sl = 0, st = 0, ce = 0, m = 0, cpk = 0;
    sec.fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
      const lum = (mx + mn) / 2;
      sl += lum;
      sc += c;
      if (c < 0.012) continue;
      if (c > cpk) cpk = c;
      let h;
      if (mx === r) h = ((g - b) / c + 6) % 6;
      else if (mx === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
      h *= 60;
      const hr = (h * Math.PI) / 180;
      sx += c * Math.cos(hr);
      sy += c * Math.sin(hr);
      st += c;
      const d = ((h - mh0 + 540) % 360) - 180;
      const h2 = (((mh0 + d * spreadF) % 360) + 360) % 360;
      const c2 = Math.pow(Math.min(1, c * gainC), 0.85);
      sec[Math.floor((h2 + 15) / 30) % 12] += c2;
      ce += c2;
      PH[m] = h2; PC[m] = c2; PL[m] = lum; m++;
      const ap = ang(h2), rad = c2 * R;
      tctx.fillStyle = `hsl(${h2 | 0} ${(45 + 25 * c2) | 0}% ${(82 - 8 * c2) | 0}%)`;
      tctx.fillRect(cx + Math.cos(ap) * rad - sz / 2, cy + Math.sin(ap) * rad - sz / 2, sz, sz);
    }
    avx += ((st > 0 ? sx / st : 0) - avx) * 0.1;
    avy += ((st > 0 ? sy / st : 0) - avy) * 0.1;
    cpeakS += (cpk - cpeakS) * (cpk > cpeakS ? 0.5 : 0.05);
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'source-over';
    stats = { sx, sy, c: sc / n, l: sl / n, n, sec, st: ce, ce: ce / n, ph: PH, pc: PC, pl: PL, m };
  }

  function drawUI() {
    const g = uctx;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    g.strokeStyle = LINE;
    for (const f of [0.25, 0.5, 0.75, 1]) {
      g.globalAlpha = f === 1 ? 1 : 0.5;
      g.beginPath(); g.arc(cx, cy, R * f, 0, TAU); g.stroke();
    }
    g.globalAlpha = 0.2;
    for (let h = 0; h < 360; h += 30) {
      const a = ang(h);
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
    }
    g.globalAlpha = 1;
    g.font = '10px "DM Mono", ui-monospace, Menlo, monospace';
    g.fillStyle = DIM;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    for (let h = 0; h < 360; h += 60) {
      const a = ang(h);
      g.fillText(h + '°', cx + Math.cos(a) * (R + 18), cy + Math.sin(a) * (R + 18));
    }
    g.textAlign = 'left';
    for (const f of [0.25, 0.5, 0.75, 1]) g.fillText(Math.round(f * 100) + '%', cx + 5, cy - R * f + 9);

    if (ptr) {
      const dx = ptr.x - cx, dy = ptr.y - cy, r = Math.hypot(dx, dy);
      if (r <= R + 12) {
        const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        const c = Math.min(1, r / R);
        const px = cx + dx, py = cy + dy;
        g.strokeStyle = INK; g.lineWidth = 1; g.globalAlpha = 0.55;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(px, py); g.stroke();
        g.globalAlpha = 1;
        g.beginPath(); g.arc(px, py, 5, 0, TAU);
        g.fillStyle = `hsl(${hue | 0} ${(45 + 25 * c) | 0}% ${(82 - 8 * c) | 0}%)`; g.fill();
        g.strokeStyle = INK; g.lineWidth = 1.5; g.stroke();
        const txt = `H ${Math.round(hue)}°  C ${Math.round(c * 100)}%`;
        const tw = g.measureText(txt).width;
        const left = px + 12 + tw + 8 > W;
        const tx = left ? px - 12 - tw - 4 : px + 12;
        const ty = Math.max(14, py - 14);
        g.fillStyle = BG; g.fillRect(tx - 4, ty - 8, tw + 8, 16);
        g.fillStyle = INK; g.textAlign = 'left';
        g.fillText(txt, tx, ty);
      }
    }
  }
  let uiQueued = false;
  function queueUI() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => { uiQueued = false; drawUI(); });
  }

  function readout() {
    const { sx, sy, c, l, n } = stats;
    const has = Math.hypot(sx, sy) > 1e-3;
    const hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
    hueTxt.textContent = has ? `${hueName(hue)} ${Math.round(hue)}°` : '–';
    sw.style.setProperty('--sw', has ? `hsl(${hue | 0} 65% 74%)` : 'transparent');
    chromaTxt.textContent = Math.round(c * 100) + '%';
    lightTxt.textContent = Math.round(l * 100) + '%';
    nTxt.textContent = n.toLocaleString('en-GB');
  }

  /* ---------- loop ---------- */
  const fadeAmt = () => 0.5 * Math.pow(1 - +trails.value / 100, 1.4) + 0.03;
  function clearTrail() { tctx.globalCompositeOperation = 'source-over'; tctx.globalAlpha = 1; tctx.fillStyle = BG; tctx.fillRect(0, 0, W, H); }
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    if (src.kind === 'scene') tScene += dt * (reduce ? 0.5 : 1.6);
    render(sample(), fadeAmt());
    audio.update(stats);
    pluckAcc += dt;
    while (pluckAcc > nextPluck) {
      pluckAcc -= nextPluck;
      nextPluck = 0.5 + Math.random() * 0.7;
      const q = stats;
      if (q.m > 0) {
        let i = (Math.random() * q.m) | 0;
        for (let k = 0; k < 2; k++) {
          const j = (Math.random() * q.m) | 0;
          if (q.pc[j] > q.pc[i]) i = j;
        }
        audio.pluck(q.ph[i], q.pc[i], q.pl[i]);
      }
    }
    if (++frame % 6 === 0) readout();
    if (frame % 30 === 0) syncSoundUI();
  }
  function startLoop() { if (raf) return; last = performance.now(); raf = requestAnimationFrame(tick); }
  function stopLoop() { cancelAnimationFrame(raf); raf = 0; }
  function warm(n) {
    const t0 = tScene;
    for (let i = 0; i < n; i++) { tScene = t0 + i * 0.07; render(sample(), 0.14); }
    readout();
  }
  function beginRun() {
    if (running) return;
    running = true;
    audio.setActive(true);
    audio.blip();
    stage.classList.remove('idle');
    pauseBtn.hidden = false;
    startLoop();
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [trail, ui]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2; cy = H / 2;
    R = Math.max(40, Math.min(W, H) / 2 - 36);
    clearTrail();
    drawUI();
    if (!running) warm(30);
  }

  /* ---------- sound ---------- */
  /* Twelve quiet voices, one per 30 degree sector of the hue wheel, tuned to a major pentatonic so any mix stays consonant.
     Each voice is as loud as the share of the (exaggerated) chroma in its sector; lightness opens a low-pass filter.
     Short plucks are fired from random dots, pitched by hue and register by lightness. A lead voice plays the hue under
     the pointer. Everything runs through a soft-clip overdrive and a convolution reverb. */
  const audio = (() => {
    const PENT = [0, 2, 4, 7, 9];
    const note = (i, base) => base * Math.pow(2, (Math.floor(i / 5) * 12 + PENT[i % 5]) / 12);
    let ctx = null, comp = null, master = null, bus = null, lp = null, pv = null, pg = null, pf = null, organWave = null, lfoDepth = null;
    const voices = [];
    const accW = new Float32Array(12);
    let accN = 0, accL = 0, accE = 0, lastChord = -99;
    let on = true, active = false;
    function impulse(c, secs, decay) {
      const len = Math.floor(c.sampleRate * secs), buf = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }
    function curve(k) {
      const n = 1024, a = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; a[i] = Math.tanh(k * x) / Math.tanh(k); }
      return a;
    }
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return true; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      comp = ctx.createDynamicsCompressor(); comp.connect(ctx.destination);
      master = ctx.createGain(); master.gain.value = 0; master.connect(comp);
      /* organ spectrum: drawbar-style harmonics 1, 2, 3, 4, 5, 6, 8 */
      const re = new Float32Array(9), im = new Float32Array(9);
      [[1, 1], [2, 0.75], [3, 0.5], [4, 0.4], [5, 0.1], [6, 0.22], [8, 0.1]].forEach(([k, a]) => { im[k] = a; });
      organWave = ctx.createPeriodicWave(re, im);
      /* rotary-speaker feel: slow vibrato on pitch and a little tremolo on level */
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.6;
      lfoDepth = ctx.createGain(); lfoDepth.gain.value = 6;
      const lfoAm = ctx.createGain(); lfoAm.gain.value = 0.07;
      const trem = ctx.createGain(); trem.gain.value = 0.93;
      lfo.connect(lfoDepth); lfo.connect(lfoAm); lfoAm.connect(trem.gain); lfo.start();
      bus = ctx.createGain();
      const pre = ctx.createGain(); pre.gain.value = 2.2;
      const shaper = ctx.createWaveShaper(); shaper.curve = curve(2.2); shaper.oversample = '2x';
      const post = ctx.createGain(); post.gain.value = 0.55;
      bus.connect(trem); trem.connect(pre); pre.connect(shaper); shaper.connect(post);
      const dry = ctx.createGain(); dry.gain.value = 0.75; post.connect(dry); dry.connect(master);
      const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, 2.8, 2.6);
      const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 3200;
      const wet = ctx.createGain(); wet.gain.value = 0.7;
      post.connect(conv); conv.connect(wlp); wlp.connect(wet); wet.connect(master);
      lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.4; lp.connect(bus);
      for (let i = 0; i < 12; i++) {
        const o = ctx.createOscillator(); o.setPeriodicWave(organWave); o.frequency.value = note(i, 261.63); lfoDepth.connect(o.detune);
        const g = ctx.createGain(); g.gain.value = 0;
        o.connect(g); g.connect(lp); o.start(); voices.push(g);
      }
      pv = ctx.createOscillator(); pv.setPeriodicWave(organWave); pv.frequency.value = 523.25; lfoDepth.connect(pv.detune);
      pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 1200;
      pg = ctx.createGain(); pg.gain.value = 0;
      pv.connect(pf); pf.connect(pg); pg.connect(bus); pv.start();
      return true;
    }
    function apply() {
      if (!ctx) return;
      const t = ctx.currentTime, live = on && active;
      master.gain.setTargetAtTime(live ? 0.8 : 0, t, 0.15);
      if (!live) pg.gain.setTargetAtTime(0, t, 0.05);
    }
    return {
      isOn: () => on,
      state: () => (ctx ? ctx.state : 'none'),
      nudge() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
      blip() {
        if (!ctx || !on) return;
        const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 523.25;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        o.connect(g); g.connect(comp); o.start(t); o.stop(t + 0.45);
      },
      setOn(v) { on = v; if (v) ensure(); apply(); },
      setActive(v) { active = v; if (v && on) ensure(); apply(); },
      update(s) {
        if (!ctx || !on || !active || !s.sec) return;
        const t = ctx.currentTime;
        /* the bed under the plucks only moves every few seconds, on the average of what the picture did in between */
        for (let i = 0; i < 12; i++) accW[i] += s.st > 0 ? s.sec[i] / s.st : 0;
        accN++; accL += s.l; accE += s.ce;
        if (t - lastChord < 4) return;
        lastChord = t;
        const loud = 0.35 + Math.min(1, accE / accN * 2) * 0.65;
        for (let i = 0; i < 12; i++) {
          voices[i].gain.setTargetAtTime(Math.min(0.5, Math.sqrt(accW[i] / accN) * 0.14 * loud), t, 1.4);
          accW[i] = 0;
        }
        lp.frequency.setTargetAtTime(500 + (accL / accN) * 4500, t, 1.4);
        accN = 0; accL = 0; accE = 0;
      },
      pluck(h, c, l) {
        if (!ctx || !on || !active) return;
        const t = ctx.currentTime;
        const root = note(Math.min(9, Math.floor(h / 36)), l < 0.5 ? 130.81 : 261.63);
        /* a held organ chord per dot: root, fifth, octave and a quiet octave-plus-fifth, with a short key-down attack and a release */
        const stack = [[1, 1], [1.5, 0.55], [2, 0.5], [3, 0.18 + 0.12 * c]];
        const hold = 1.2 + Math.random() * 1.2, rel = 0.45;
        const fl = ctx.createBiquadFilter(), g = ctx.createGain();
        fl.type = 'lowpass'; fl.frequency.value = 2400 + c * 3200; fl.Q.value = 0.5;
        const peak = 0.06 + 0.1 * c;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.014);
        g.gain.setValueAtTime(peak, t + hold);
        g.gain.exponentialRampToValueAtTime(0.0008, t + hold + rel);
        fl.connect(g); g.connect(bus);
        for (const [ratio, amp] of stack) {
          const o = ctx.createOscillator(), og = ctx.createGain();
          o.setPeriodicWave(organWave); o.frequency.value = root * ratio;
          o.detune.value = (Math.random() - 0.5) * 6;
          lfoDepth.connect(o.detune);
          og.gain.value = amp * 0.6;
          o.connect(og); og.connect(fl);
          o.onended = () => { try { lfoDepth.disconnect(o.detune); } catch (e) {} };
          o.start(t); o.stop(t + hold + rel + 0.05);
        }
      },
      point(h, c) {
        if (!ctx || !on || !active) return;
        const t = ctx.currentTime;
        if (h == null) { pg.gain.setTargetAtTime(0, t, 0.08); return; }
        pv.frequency.setTargetAtTime(note(Math.min(9, Math.floor(h / 36)), 523.25), t, 0.03);
        pf.frequency.setTargetAtTime(500 + c * 5500, t, 0.05);
        pg.gain.setTargetAtTime(0.08 + 0.3 * c, t, 0.05);
      }
    };
  })();
  const soundBtn = $('sound');
  function syncSoundUI() {
    const on = audio.isOn(), st = audio.state();
    const blocked = on && running && st !== 'running' && st !== 'none';
    soundBtn.textContent = !on ? 'Sound off' : blocked ? 'Sound blocked, tap' : 'Sound on';
    soundBtn.setAttribute('aria-pressed', String(on));
  }
  soundBtn.addEventListener('click', () => {
    const st = audio.state();
    if (audio.isOn() && st !== 'running' && st !== 'none') { audio.nudge(); audio.blip(); syncSoundUI(); return; }
    const v = !audio.isOn();
    audio.setOn(v);
    if (v) audio.blip();
    syncSoundUI();
  });
  document.addEventListener('pointerdown', () => audio.nudge());

  /* ---------- controls ---------- */
  document.addEventListener('click', beginRun);
  $('tools').addEventListener('click', (e) => e.stopPropagation());
  pauseBtn.addEventListener('click', () => {
    if (raf) {
      stopLoop(); pauseBtn.textContent = 'Resume'; audio.setActive(false);
      if (src.el && src.el.pause) src.el.pause();
    } else {
      startLoop(); pauseBtn.textContent = 'Pause'; audio.setActive(true);
      if (src.el && src.el.play) { const p = src.el.play(); if (p && p.catch) p.catch(() => {}); }
    }
  });
  sceneBtn.addEventListener('click', () => {
    if (src.el && src.el.pause) src.el.pause();
    src = { kind: 'scene', el: null };
    sceneBtn.hidden = true;
    clearTrail(); startLoop(); pauseBtn.textContent = 'Pause'; audio.setActive(true);
  });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const fail = () => { URL.revokeObjectURL(url); note.textContent = 'That file could not be read as a picture or video.'; };
    const done = (el) => {
      const old = objUrl; objUrl = url;
      if (old) URL.revokeObjectURL(old);
      if (src.el && src.el.pause) src.el.pause();
      src = { kind: 'file', el };
      note.textContent = '';
      sceneBtn.hidden = false;
      clearTrail();
      beginRun(); startLoop(); pauseBtn.textContent = 'Pause'; audio.setActive(true);
    };
    if (f.type.indexOf('video/') === 0) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = () => { done(v); const p = v.play(); if (p && p.catch) p.catch(() => {}); };
      v.onerror = fail;
      v.src = url;
    } else {
      const im = new Image();
      im.onload = () => done(im);
      im.onerror = fail;
      im.src = url;
    }
    fileIn.value = '';
  });
  function pointerHC() {
    if (!ptr) return null;
    const dx = ptr.x - cx, dy = ptr.y - cy, r = Math.hypot(dx, dy);
    if (r > R + 12) return null;
    return { hue: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, c: Math.min(1, r / R) };
  }
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    ptr = { x: e.clientX - r.left, y: e.clientY - r.top };
    queueUI();
    const p = pointerHC();
    if (p && running) audio.point(p.hue, p.c); else audio.point(null, 0);
  });
  stage.addEventListener('pointerleave', () => { ptr = null; queueUI(); audio.point(null, 0); });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueUI);
})();

/* MOSAIK project page: all interactivity. Vanilla JS, no dependencies.
   Data comes from window.MOSAIK_VIEW (static/js/data_viewers.js), so the page also works from file://. */
(function () {
  'use strict';

  var V = window.MOSAIK_VIEW;
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var PC = { a: '#E8743B', b: '#17A091', c: '#3A66CF' };
  var TINT = { a: 'rgba(232,116,59,0.10)', b: 'rgba(23,160,145,0.10)', c: 'rgba(58,102,207,0.10)' };
  var SUB = { a: 4, b: 2, c: 1 };          // patches per region side
  var TOK = { a: 16, b: 4, c: 1 };         // tokens per region
  var FULL = 4096;
  var TIERS = ['mild', 'balanced', 'quarter', 'headline'];
  // recorded mean tokens per step over all 50 steps (incl. the 4,096-token p16 warm-up), same for all six prompts
  var MEAN_TOK = { mild: 3090, balanced: 1685, quarter: 1085, headline: 683 };

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- image loading (cached promises) ---------- */
  var imgCache = {};
  function loadImg(src) {
    if (!imgCache[src]) {
      imgCache[src] = new Promise(function (resolve, reject) {
        var im = new Image();
        im.decoding = 'async';
        im.onload = function () { resolve(im); };
        im.onerror = function () { delete imgCache[src]; reject(new Error('Could not load ' + src)); };
        im.src = src;
      });
    }
    return imgCache[src];
  }

  /* ---------- layout helpers ---------- */
  function shares(codes) {
    var n = { a: 0, b: 0, c: 0 };
    for (var i = 0; i < codes.length; i++) n[codes[i]]++;
    return { a: n.a / 256, b: n.b / 256, c: n.c / 256, tok: n.a * 16 + n.b * 4 + n.c };
  }

  /* Greedy allocation, as in the paper: start all regions at p64 (256 tokens); repeatedly apply the
     highest-priority AVAILABLE refinement that fits the budget. p64->p32 costs +3 (priority d/3);
     a region's p32->p16 (+12, priority d/12) becomes available only once it is at p32, so it is pushed
     onto the max-heap at that moment. Ties: p64->p32 first, then region index. */
  function greedy(d, budget) {
    var lay = new Array(256).fill('c'), used = 256, h = [];
    function less(x, y) { return (y[0] - x[0]) || (x[2] - y[2]) || (x[1] - y[1]); }   // <0: x before y
    function push(e) {
      h.push(e);
      for (var i = h.length - 1; i > 0;) {
        var p = (i - 1) >> 1; if (less(h[i], h[p]) >= 0) break;
        var t = h[i]; h[i] = h[p]; h[p] = t; i = p;
      }
    }
    function pop() {
      var top = h[0], last = h.pop();
      if (h.length) {
        h[0] = last;
        for (var i = 0; ;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < h.length && less(h[l], h[m]) < 0) m = l;
          if (r < h.length && less(h[r], h[m]) < 0) m = r;
          if (m === i) break;
          var t = h[i]; h[i] = h[m]; h[m] = t; i = m;
        }
      }
      return top;
    }
    for (var i = 0; i < d.length; i++) push([d[i] / 3, i, 1]);
    while (h.length && used < budget) {
      var a = pop(), r = a[1];
      if (a[2] === 1) {
        if (used + 3 <= budget) { lay[r] = 'b'; used += 3; push([d[r] / 12, r, 2]); }
      } else if (used + 12 <= budget) { lay[r] = 'a'; used += 12; }
    }
    return { codes: lay.join(''), used: used };
  }

  /* Layout overlay (same style as the GIFs): a faint patch-size tint, thin white patch-grid lines, and a
     brighter white edge where neighbouring regions use different patch sizes. Light enough to keep the
     image's own colours. */
  function drawLayout(ctx, codes, W) {
    var cs = W / 16, px = Math.max(1, W / 520);   // ~1 CSS px at the displayed size
    for (var i = 0; i < 256; i++) {
      ctx.fillStyle = TINT[codes[i]];
      ctx.fillRect((i % 16) * cs, Math.floor(i / 16) * cs, cs, cs);
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = px;
    ctx.beginPath();
    for (var r = 0; r < 256; r++) {
      var s = SUB[codes[r]], x0 = (r % 16) * cs, y0 = Math.floor(r / 16) * cs, step = cs / s;
      for (var q = 0; q < s; q++) {
        var t = Math.round(q * step);
        ctx.moveTo(x0 + t, y0); ctx.lineTo(x0 + t, y0 + cs);
        ctx.moveTo(x0, y0 + t); ctx.lineTo(x0 + cs, y0 + t);
      }
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2 * px;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (var k = 0; k < 256; k++) {
      var cx = k % 16, cy = Math.floor(k / 16);
      if (cx < 15 && codes[k + 1] !== codes[k]) { ctx.moveTo((cx + 1) * cs, cy * cs); ctx.lineTo((cx + 1) * cs, (cy + 1) * cs); }
      if (cy < 15 && codes[k + 16] !== codes[k]) { ctx.moveTo(cx * cs, (cy + 1) * cs); ctx.lineTo((cx + 1) * cs, (cy + 1) * cs); }
    }
    ctx.stroke();
    ctx.restore();
  }

  function setFill(input) {
    var min = +input.min || 0, max = +input.max || 100;
    input.style.setProperty('--fill', ((+input.value - min) / (max - min) * 100) + '%');
  }

  function setShares(root, s) {
    $$('.shares b', root).forEach(function (b) { b.textContent = pct(s[b.getAttribute('data-k')]); });
  }

  /* ---------- prompt picker ---------- */
  function makePicker(el, current, onChange) {
    el.innerHTML = '';
    V.order.forEach(function (key) {
      var p = V.prompts[key];
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(key === current));
      b.setAttribute('aria-label', p.name);
      b.title = p.name;
      var im = document.createElement('img');
      im.src = 'static/img/thumbs/' + key + '.webp';
      im.alt = '';
      im.width = 52; im.height = 52;
      b.appendChild(im);
      b.addEventListener('click', function () {
        $$('button', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        onChange(key);
      });
      el.appendChild(b);
    });
  }

  function makeSeg(el, onChange) {
    $$('button', el).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('button', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        onChange(b.getAttribute('data-tier'));
      });
    });
  }

  function whenVisible(el, cb, opts) {
    if (!('IntersectionObserver' in window)) { cb(true); return; }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { cb(e.isIntersecting); });
    }, opts || { threshold: 0.35 }).observe(el);
  }

  /* ======================= teaser pause toggle ======================= */
  (function teaser() {
    var box = $('#teaser'); if (!box) return;
    var btn = $('.teaser-toggle', box);
    if (reduceMQ.matches) { box.classList.add('paused'); btn.hidden = true; return; }
    btn.addEventListener('click', function () {
      var paused = box.classList.toggle('paused');
      btn.setAttribute('aria-pressed', String(paused));
      btn.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    });
  })();

  /* ======================= viewer 1: layout across denoising ======================= */
  (function evolveViewer() {
    var root = $('#evolve'); if (!root || !V) return;
    var canvas = $('canvas', root), ctx = canvas.getContext('2d');
    var W = canvas.width;
    var slider = $('#ev-step'), out = $('.ev-step-o', root);
    var playBtn = $('.play', root);
    var hudStep = $('.hud-step', root), hudTok = $('.hud-tok', root);
    var loading = $('.v-loading', root), promptEl = $('.v-prompt', root);
    var spark = $('.spark', root);
    var areas = $('.spark-areas', root), cur = $('.spark-cur', root);

    var st = { key: 'tiger', tier: 'quarter', step: 25, playing: false, userPaused: false, visible: false, overlay: true };
    var sprite = null, spriteSrc = '', timer = 0, reqId = 0;

    function T() { return V.prompts[st.key].tiers[st.tier]; }

    function buildSpark() {
      var t = T(), n = t.n || t.layouts.length, w = 300 / n, H = 64;
      var paths = { a: '', b: '', c: '' };
      var tops = [];
      for (var k = 0; k < n; k++) {
        var s = shares(t.layouts[k]);
        tops.push([s.a, s.a + s.b]);
      }
      // stacked bands, bottom to top: p16, p32, p64 (as step shapes)
      function band(lo, hi) {
        var d = '', k, x;
        for (k = 0; k < n; k++) { x = k * w; d += (k ? 'L' : 'M') + x.toFixed(2) + ' ' + (H - hi(k) * H).toFixed(2) + 'L' + (x + w).toFixed(2) + ' ' + (H - hi(k) * H).toFixed(2); }
        for (k = n - 1; k >= 0; k--) { x = k * w; d += 'L' + (x + w).toFixed(2) + ' ' + (H - lo(k) * H).toFixed(2) + 'L' + x.toFixed(2) + ' ' + (H - lo(k) * H).toFixed(2); }
        return d + 'Z';
      }
      paths.a = band(function () { return 0; }, function (k) { return tops[k][0]; });
      paths.b = band(function (k) { return tops[k][0]; }, function (k) { return tops[k][1]; });
      paths.c = band(function (k) { return tops[k][1]; }, function () { return 1; });
      areas.innerHTML = '<path d="' + paths.a + '" fill="' + PC.a + '"/>' +
        '<path d="' + paths.b + '" fill="' + PC.b + '"/>' +
        '<path d="' + paths.c + '" fill="' + PC.c + '" fill-opacity="0.85"/>';
    }

    function draw() {
      var t = T(), k = st.step - 1, codes = t.layouts[k], s = shares(codes);
      var tok = t.toks[k];
      if (sprite && spriteSrc === t.sprite) {
        var cell = t.cell, col = k % t.cols, row = Math.floor(k / t.cols);
        ctx.drawImage(sprite, col * cell + 1, row * cell + 1, cell - 2, cell - 2, 0, 0, W, W);
        if (st.overlay) drawLayout(ctx, codes, W);
      }
      hudStep.textContent = 'step ' + st.step + '/50';
      hudTok.textContent = k === 0 ? fmt(tok) + ' tokens · p16 warm-up' : fmt(tok) + ' / ' + fmt(t.budget) + ' tokens';
      out.textContent = st.step;
      slider.value = st.step; setFill(slider);
      setShares(root, s);
      var x = (k + 0.5) * (300 / (t.n || 50));
      cur.setAttribute('x1', x); cur.setAttribute('x2', x);
      if (!st.playing) {
        canvas.setAttribute('aria-label', V.prompts[st.key].name + ', step ' + st.step + ' of 50, ' + fmt(tok) +
          ' tokens. Image area: p16 ' + pct(s.a) + ', p32 ' + pct(s.b) + ', p64 ' + pct(s.c) + '.');
      }
    }

    function ensureSprite() {
      var src = T().sprite;
      if (spriteSrc === src && sprite) return Promise.resolve();
      var my = ++reqId;
      loading.hidden = false;
      return loadImg(src).then(function (im) {
        if (my !== reqId) return;
        sprite = im; spriteSrc = src; loading.hidden = true; draw();
        // warm the other budget of the same prompt
        var other = V.prompts[st.key].tiers[st.tier === 'quarter' ? 'headline' : 'quarter'];
        if (other) loadImg(other.sprite).catch(function () {});
      }, function () { if (my === reqId) loading.textContent = 'could not load frames'; });
    }

    function setMeta() {
      var p = V.prompts[st.key], t = T();
      promptEl.textContent = '“' + p.prompt + '”';
      buildSpark();
    }

    function tick() {
      timer = 0;
      if (!st.playing) return;
      if (!sprite || spriteSrc !== T().sprite) { timer = setTimeout(tick, 120); return; }
      st.step = st.step === 50 ? 1 : st.step + 1;
      draw();
      timer = setTimeout(tick, st.step === 50 ? 1400 : 110);   // hold the last step
    }

    function play() {
      if (st.playing) return;
      st.playing = true; playBtn.classList.add('on'); playBtn.setAttribute('aria-label', 'Pause');
      ensureSprite();
      if (!timer) timer = setTimeout(tick, 110);
    }
    function pause() {
      st.playing = false; playBtn.classList.remove('on'); playBtn.setAttribute('aria-label', 'Play');
      if (timer) { clearTimeout(timer); timer = 0; }
      draw();
    }

    playBtn.addEventListener('click', function () {
      if (st.playing) { st.userPaused = true; pause(); } else { st.userPaused = false; play(); }
    });
    slider.addEventListener('input', function () {
      var v = +slider.value;              // read first: pause() redraws and would reset the slider
      st.userPaused = true; st.step = v;
      if (st.playing) pause(); else draw();
    });

    // click / drag on the sparkline to seek. Mouse and pen act at once; touch waits until the gesture is
    // clearly horizontal (or a clean tap), so a vertical page scroll that starts on the chart changes nothing.
    function seekFromEvent(e) {
      var r = spark.getBoundingClientRect();
      st.step = Math.floor(Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width)) * 50) + 1;
      st.userPaused = true;
      if (st.playing) pause(); else draw();
    }
    var dragging = false, pend = null;
    function startDrag(e) {
      dragging = true; pend = null;
      if (spark.setPointerCapture) { try { spark.setPointerCapture(e.pointerId); } catch (x) {} }
      seekFromEvent(e);
    }
    spark.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') { pend = { x: e.clientX, y: e.clientY, id: e.pointerId }; return; }
      startDrag(e);
    });
    spark.addEventListener('pointermove', function (e) {
      if (pend && e.pointerId === pend.id) {
        var dx = Math.abs(e.clientX - pend.x), dy = Math.abs(e.clientY - pend.y);
        if (dx > 8 && dx > dy) startDrag(e);
        else if (dy > 8) pend = null;
        return;
      }
      if (dragging) seekFromEvent(e);
    });
    spark.addEventListener('pointerup', function (e) {
      if (pend && e.pointerId === pend.id) seekFromEvent(e);   // a tap
      dragging = false; pend = null;
    });
    spark.addEventListener('pointercancel', function () { dragging = false; pend = null; });

    makePicker($('[data-picker="evolve"]', root), st.key, function (key) {
      st.key = key; setMeta(); ensureSprite().then(draw); draw();
    });
    makeSeg($('.seg', root), function (tier) {
      st.tier = tier; setMeta(); ensureSprite().then(draw); draw();
    });

    ctx.fillStyle = '#F5F7FA'; ctx.fillRect(0, 0, W, W);
    setMeta(); draw();

    // load frames when the viewer comes near; autoplay while visible (never with reduced motion)
    var loaded = false;
    whenVisible(root, function (vis) {
      if (vis && !loaded) { loaded = true; ensureSprite(); }
    }, { rootMargin: '600px 0px' });
    whenVisible(root, function (vis) {
      st.visible = vis;
      if (vis && !reduceMQ.matches && !st.userPaused) play();
      if (!vis && st.playing) pause();
    }, { threshold: 0.45 });
  })();

  /* ======================= viewer 2: budget ======================= */
  (function budgetViewer() {
    var root = $('#budget'); if (!root || !V) return;
    var canvas = $('canvas', root), ctx = canvas.getContext('2d'), W = canvas.width;
    var slider = $('#bu-slider'), bigB = $('.bu-b', root), live = $('.bu-live', root);
    var hudPct = $('.hud-pct', root);
    var stack = $('.stack', root);
    var ticks = $('.ticks', root), promptLive = $('.bu-prompt', root);

    var LOG16 = Math.log(16);
    function v2b(v) { var b = 256 * Math.pow(16, v / 1000); return Math.min(4096, Math.max(256, Math.round(b / 2) * 2)); }
    function b2v(b) { return 1000 * Math.log(b / 256) / LOG16; }

    var st = { key: 'tiger', B: 1024, overlay: true };
    var img = null, imgSrc = '', liveTimer = 0;

    function P() { return V.prompts[st.key]; }

    function draw() {
      var g = greedy(P().dmg_mean, st.B), s = shares(g.codes);
      if (img && imgSrc === P().final_p16) {
        ctx.drawImage(img, 0, 0, W, W);
        if (st.overlay) drawLayout(ctx, g.codes, W);
      } else {
        ctx.fillStyle = '#F5F7FA'; ctx.fillRect(0, 0, W, W);
        drawLayout(ctx, g.codes, W);
      }
      bigB.textContent = fmt(st.B);
      hudPct.textContent = pct(g.used / FULL) + ' of p16 tokens';
      $('.a', stack).style.width = (s.a * 100) + '%';
      $('.b', stack).style.width = (s.b * 100) + '%';
      $('.c', stack).style.width = (s.c * 100) + '%';
      setShares(root, s);
      slider.setAttribute('aria-valuetext', fmt(st.B) + ' tokens per step');
      canvas.setAttribute('aria-label', P().name + ' at a budget of ' + fmt(st.B) + ' tokens: p16 covers ' + pct(s.a) +
        ' of the image, p32 ' + pct(s.b) + ', p64 ' + pct(s.c) + '.');
      clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        live.textContent = fmt(st.B) + ' tokens: p16 ' + pct(s.a) + ', p32 ' + pct(s.b) + ', p64 ' + pct(s.c) + ' of the image.';
      }, 600);
    }

    function loadBase() {
      var src = P().final_p16;
      return loadImg(src).then(function (im) { if (P().final_p16 === src) { img = im; imgSrc = src; draw(); } }, function () {});
    }

    function setB(b, fromSlider) {
      st.B = b;
      if (!fromSlider) slider.value = b2v(b);
      setFill(slider);
      draw();
    }

    // tier ticks under the slider
    ['headline', 'quarter', 'balanced', 'mild'].forEach(function (t) {
      var b = Math.round(V.tier_r[t] * FULL);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = fmt(b);
      btn.style.left = (b2v(b) / 10) + '%';
      btn.setAttribute('aria-label', 'Set budget to ' + fmt(b) + ' tokens (' + V.tier_label[t] + ' tier)');
      btn.addEventListener('click', function () { setB(b); });
      ticks.appendChild(btn);
    });

    function setKey(key) {
      st.key = key;
      var p = P();
      promptLive.textContent = 'Prompt: ' + p.prompt;
      loadBase();
      draw();
    }

    slider.addEventListener('input', function () { setB(v2b(+slider.value), true); });
    makePicker($('[data-picker="budget"]', root), st.key, setKey);

    slider.value = b2v(st.B);
    setKey(st.key);
    setFill(slider);
  })();

  /* ======================= before / after comparison ======================= */
  (function compare() {
    var root = $('#compare'); if (!root || !V) return;
    var box = $('.compare', root), range = $('.cmp-range', root), live = $('.cmp-live', root);
    var a = $('.cmp-a', root), b = $('.cmp-b', root), tagR = $('.cmp-tag.r', root);
    var st = { key: 'wolf', tier: 'quarter' }, first = true;

    function update() {
      var p = V.prompts[st.key], f = p.budget_finals[st.tier];
      a.src = p.final_p16; a.alt = 'PixelDiT at full compute: ' + p.prompt;
      var tl = V.tier_label[st.tier];                       // e.g. "≈70% fewer FLOPs"
      b.src = f.img; b.alt = 'MOSAIK, ' + tl + ' tier, budget ' + fmt(f.budget) + ' tokens per step: ' + p.prompt;
      // B applies to steps 2-50 (step 1 is a full p16 warm-up); the tag also shows the recorded mean over all 50 steps
      tagR.textContent = 'MOSAIK · ' + fmt(f.budget) + '-token budget';
      if (!first) live.textContent = p.name + ': PixelDiT at 4,096 tokens vs. MOSAIK at a budget of ' + fmt(f.budget) +
        ' tokens per step, ' + tl + ' tier.';
      first = false;
      TIERS.forEach(function (t) { if (t !== st.tier) loadImg(p.budget_finals[t].img).catch(function () {}); });
    }
    function setPos(v) {
      v = Math.max(0, Math.min(100, Math.round(v)));
      range.value = v; box.style.setProperty('--pos', v + '%');
      range.setAttribute('aria-valuetext', v + '% PixelDiT, ' + (100 - v) + '% MOSAIK');
    }
    // pointer: the divider follows the cursor or finger; keyboard: the invisible range input.
    // Mouse and pen act on pointerdown. Touch waits until the gesture is clearly horizontal (or a clean tap),
    // so a vertical scroll that starts on the image leaves the divider alone (the browser then sends pointercancel).
    var drag = false, pend = null;
    function fromEvent(e) { var r = box.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100); }
    function startDrag(e) {
      drag = true; pend = null;
      if (box.setPointerCapture) { try { box.setPointerCapture(e.pointerId); } catch (x) {} }
      fromEvent(e);
    }
    box.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') { pend = { x: e.clientX, y: e.clientY, id: e.pointerId }; return; }
      startDrag(e); e.preventDefault();
    });
    box.addEventListener('pointermove', function (e) {
      if (pend && e.pointerId === pend.id) {
        var dx = Math.abs(e.clientX - pend.x), dy = Math.abs(e.clientY - pend.y);
        if (dx > 8 && dx > dy) startDrag(e);
        else if (dy > 8) pend = null;
        return;
      }
      if (drag) fromEvent(e);
    });
    box.addEventListener('pointerup', function (e) {
      var tap = pend && e.pointerId === pend.id;
      if (tap) fromEvent(e);
      if (e.pointerType !== 'touch') { try { range.focus({ preventScroll: true }); } catch (x) {} }
      drag = false; pend = null;
    });
    box.addEventListener('pointercancel', function () { drag = false; pend = null; });
    range.addEventListener('input', function () { setPos(+range.value); });
    setPos(50);
    makePicker($('[data-picker="compare"]', root), st.key, function (k) { st.key = k; update(); });
    makeSeg($('.seg', root), function (t) { st.tier = t; update(); });
    update();
  })();

  /* ======================= BibTeX copy ======================= */
  (function bib() {
    var btn = $('.copy'), code = $('#bibtex-code'); if (!btn || !code) return;
    var label = $('span', btn);
    function done(ok) {
      btn.classList.toggle('done', ok);
      label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      setTimeout(function () { btn.classList.remove('done'); label.textContent = 'Copy'; }, 1800);
    }
    function fallback() {
      var r = document.createRange(); r.selectNodeContents(code);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      done(ok);
    }
    btn.addEventListener('click', function () {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(code.textContent).then(function () { done(true); }, fallback);
      } else { fallback(); }
    });
  })();

  /* ======================= nav: mark the current section ======================= */
  (function nav() {
    if (!('IntersectionObserver' in window)) return;
    var links = $$('.nav a[href^="#"]').filter(function (a) { return a.getAttribute('href').length > 1 && !a.classList.contains('nav-brand'); });
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('on'); a.removeAttribute('aria-current'); });
        var a = map[e.target.id];
        if (a) { a.classList.add('on'); a.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    $$('main section[id]').forEach(function (s) { io.observe(s); });
  })();

  /* phone-width figures that scroll sideways: drop the right-edge fade once the end is reached */
  $$('.fig-scroll').forEach(function (el) {
    function upd() { el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 4); }
    el.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    upd();
  });

  $$('input[type="range"]').forEach(function (r) { if (!r.classList.contains('cmp-range')) { setFill(r); r.addEventListener('input', function () { setFill(r); }); } });
})();

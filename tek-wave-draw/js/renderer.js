/*
 * Canvas 渲染器：仪器风格栅格 + 多通道轨迹 + 光标 / 框选 / 读数。
 * 所有坐标以 CSS 像素计算，内部按 devicePixelRatio 放大，保证高分屏清晰。
 */
(function (root) {
  'use strict';

  const PALETTES = {
    dark: {
      bg: '#070c14',
      plot: '#0a1220',
      plotEdge: '#16233a',
      gridMinor: 'rgba(120,160,220,0.10)',
      gridMajor: 'rgba(120,160,220,0.22)',
      axis: 'rgba(140,180,240,0.42)',
      text: '#7f93ae',
      textStrong: '#e6eefc',
      zero: 'rgba(150,190,250,0.35)',
      cursor: '#ffb020',
      cursorText: '#241703',
      cursorAlt: 'rgba(255,176,32,0.18)',
      badge: 'rgba(10,18,32,0.78)',
      tooltipBg: 'rgba(8,15,26,0.94)',
      tooltipBorder: 'rgba(120,160,220,0.35)',
      selectFill: 'rgba(80,170,255,0.14)',
      selectStroke: 'rgba(120,200,255,0.8)',
      colors: ['#ffd166', '#4dd0e1', '#ff7eb6', '#7ee787', '#c4b5fd', '#fdba74', '#5eead4', '#f87171']
    },
    light: {
      bg: '#eef2f7',
      plot: '#ffffff',
      plotEdge: '#cfd8e3',
      gridMinor: 'rgba(30,60,100,0.09)',
      gridMajor: 'rgba(30,60,100,0.18)',
      axis: 'rgba(30,60,100,0.35)',
      text: '#5a6b80',
      textStrong: '#10202f',
      zero: 'rgba(30,60,100,0.3)',
      cursor: '#b45309',
      cursorText: '#ffffff',
      cursorAlt: 'rgba(180,83,9,0.14)',
      badge: 'rgba(255,255,255,0.82)',
      tooltipBg: 'rgba(255,255,255,0.96)',
      tooltipBorder: 'rgba(30,60,100,0.22)',
      selectFill: 'rgba(37,120,220,0.10)',
      selectStroke: 'rgba(37,120,220,0.7)',
      colors: ['#a16207', '#0e7490', '#be185d', '#15803d', '#6d28d9', '#c2410c', '#0f766e', '#b91c1c']
    }
  };

  const MONO = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const MONO_SMALL = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const SANS = '12px -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  /** 向上取到 1-2-5 档位 */
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const m = v / base;
    const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return step * base;
  }

  /** 1-2-5 档位的下一档 */
  function niceNext(v) {
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const m = Math.round(v / base);
    if (m < 2) return 2 * base;
    if (m < 5) return 5 * base;
    return 10 * base;
  }

  class ScopeRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.width = 800;
      this.height = 400;
      this.dpr = 1;
      this.frames = [];
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = Math.max(320, Math.round(rect.width));
      this.height = Math.max(220, Math.round(rect.height));
      const w = Math.round(this.width * this.dpr);
      const h = Math.round(this.height * this.dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    }

    layout() {
      const left = this.width < 520 ? 52 : 66;
      const bottom = this.height - 30;
      return {
        left,
        top: 14,
        right: this.width - 14,
        bottom,
        get w() { return this.right - this.left; },
        get h() { return this.bottom - this.top; }
      };
    }

    xOf(t, view) {
      const L = this.layout();
      return L.left + (t - view.t0) / (view.t1 - view.t0) * L.w;
    }

    tOf(x, view) {
      const L = this.layout();
      return view.t0 + (x - L.left) / L.w * (view.t1 - view.t0);
    }

    /** 每个可见通道的纵向几何（自动量程 / 固定档位） */
    computeFrames(state) {
      const L = this.layout();
      const visible = state.channels.filter(c => c.visible);
      const n = visible.length;
      const frames = [];
      for (let i = 0; i < n; i++) {
        const ch = visible[i];
        const laneH = state.mode === 'stack' ? L.h / n : L.h;
        const laneTop = state.mode === 'stack' ? L.top + laneH * i : L.top;
        const ext = ch.columnExtremes(state.view.t0, state.view.t1, Math.max(1, Math.round(L.w)));
        let lo = Infinity, hi = -Infinity;
        for (let c = 0; c < ext.min.length; c++) {
          if (ext.min[c] < lo) lo = ext.min[c];
          if (ext.max[c] > hi) hi = ext.max[c];
        }
        const empty = !Number.isFinite(lo) || !Number.isFinite(hi);
        let unitsPerPx, centerVal;
        if (state.verticalMode === 'auto') {
          const divs = state.mode === 'stack' ? 4 : 8;
          const pxPerDiv = laneH / divs;
          if (empty || hi - lo < 1e-12) {
            unitsPerPx = (ch.vScale || 1) / pxPerDiv;
            centerVal = ch.yZero || 0;
          } else {
            // 自动量程吸附到 1-2-5 档位，刻度读数更整齐
            let perDiv = niceCeil((hi - lo) / divs * 1.02);
            let center = Math.round((hi + lo) / 2 / (perDiv / 2)) * (perDiv / 2);
            let guard = 0;
            while (Math.max(center - lo, hi - center) > perDiv * divs * 0.49 && guard++ < 6) {
              perDiv = niceNext(perDiv);
              center = Math.round((hi + lo) / 2 / (perDiv / 2)) * (perDiv / 2);
            }
            unitsPerPx = perDiv / pxPerDiv;
            centerVal = center;
          }
        } else {
          const divs = state.mode === 'stack' ? 4 : 8;
          unitsPerPx = (ch.vScale || 1) * ch.userScale / (laneH / divs);
          centerVal = ch.yZero || 0;
        }
        const centerY = laneTop + laneH / 2 - (state.verticalMode === 'auto'
          ? ch.offsetDiv * laneH / 8
          : ch.offsetDiv * laneH / (state.mode === 'stack' ? 4 : 8));
        frames.push({
          ch, index: i, laneTop, laneH, ext, empty,
          unitsPerPx, centerVal, centerY,
          yOf(v) { return this.centerY - (v - this.centerVal) / this.unitsPerPx; }
        });
      }
      this.frames = frames;
      return frames;
    }

    draw(state) {
      const ctx = this.ctx;
      const p = PALETTES[state.theme] || PALETTES.dark;
      const L = this.layout();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, this.width, this.height);

      // 绘图区
      const grad = ctx.createLinearGradient(0, L.top, 0, L.bottom);
      grad.addColorStop(0, state.theme === 'dark' ? '#0c1526' : '#ffffff');
      grad.addColorStop(1, state.theme === 'dark' ? '#080f1b' : '#fbfdff');
      ctx.fillStyle = grad;
      ctx.fillRect(L.left, L.top, L.w, L.h);
      ctx.strokeStyle = p.plotEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(L.left + 0.5, L.top + 0.5, L.w - 1, L.h - 1);

      this.drawGraticule(ctx, p, L, state);

      const frames = this.computeFrames(state);
      if (!frames.length) {
        ctx.fillStyle = p.text;
        ctx.font = SANS;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('打开 .isf 文件，或点击「示例数据」', L.left + L.w / 2, L.top + L.h / 2);
        this.drawTimeAxis(ctx, p, L, state);
        return;
      }

      if (state.mode === 'stack') this.drawLaneSeps(ctx, p, L, frames);

      ctx.save();
      ctx.beginPath();
      ctx.rect(L.left, L.top, L.w, L.h);
      ctx.clip();
      // 当前通道最后绘制，叠加时不会被其它通道盖住
      const order = frames.filter(f => f.ch.id !== state.activeId)
        .concat(frames.filter(f => f.ch.id === state.activeId));
      for (const f of order) this.drawTrace(ctx, p, L, f, state);
      if (state.showCursors) this.drawCursors(ctx, p, L, state);
      if (state.hover && state.showHover) this.drawHover(ctx, p, L, state, frames);
      if (state.boxSelect) this.drawBox(ctx, p, L, state.boxSelect);
      ctx.restore();

      this.drawTimeAxis(ctx, p, L, state);
      this.drawValueAxis(ctx, p, L, state, frames);
      this.drawBadges(ctx, p, L, state, frames);
      if (state.showCursors) {
        this.drawCursorLabels(ctx, p, L, state, frames);
        this.drawCursorTags(ctx, p, L, state);
      }
    }

    drawGraticule(ctx, p, L, state) {
      if (!state.showGrid) return;
      const cols = 10, rows = 8;
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.gridMinor;
      ctx.beginPath();
      for (let i = 0; i <= cols * 5; i++) {
        if (i % 5 === 0) continue;
        const x = Math.round(L.left + L.w * i / (cols * 5)) + 0.5;
        ctx.moveTo(x, L.top); ctx.lineTo(x, L.bottom);
      }
      for (let i = 0; i <= rows * 5; i++) {
        if (i % 5 === 0) continue;
        const y = Math.round(L.top + L.h * i / (rows * 5)) + 0.5;
        ctx.moveTo(L.left, y); ctx.lineTo(L.right, y);
      }
      ctx.stroke();

      ctx.strokeStyle = p.gridMajor;
      ctx.beginPath();
      for (let i = 0; i <= cols; i++) {
        const x = Math.round(L.left + L.w * i / cols) + 0.5;
        ctx.moveTo(x, L.top); ctx.lineTo(x, L.bottom);
      }
      for (let i = 0; i <= rows; i++) {
        const y = Math.round(L.top + L.h * i / rows) + 0.5;
        ctx.moveTo(L.left, y); ctx.lineTo(L.right, y);
      }
      ctx.stroke();
    }

    drawLaneSeps(ctx, p, L, frames) {
      ctx.strokeStyle = p.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < frames.length; i++) {
        const y = Math.round(frames[i].laneTop) + 0.5;
        ctx.moveTo(L.left, y); ctx.lineTo(L.right, y);
      }
      ctx.stroke();
      // 0 电平参考线（若落在道内）
      ctx.strokeStyle = p.zero;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (const f of frames) {
        const y = f.yOf(0);
        if (y > f.laneTop + 2 && y < f.laneTop + f.laneH - 2) {
          ctx.moveTo(L.left, Math.round(y) + 0.5);
          ctx.lineTo(L.right, Math.round(y) + 0.5);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawTrace(ctx, p, L, f, state) {
      const ch = f.ch;
      const color = p.colors[ch.colorIndex % p.colors.length];
      const range = ch.indexRange(state.view.t0, state.view.t1);
      if (!range) return;
      const [i0, i1] = range;
      const span = i1 - i0 + 1;
      const cols = Math.max(1, Math.round(L.w));
      const x0 = L.left;
      const pxPerCol = L.w / cols;

      ctx.save();
      ctx.beginPath();
      if (state.mode === 'stack') ctx.rect(L.left, f.laneTop, L.w, f.laneH);
      else ctx.rect(L.left, L.top, L.w, L.h);
      ctx.clip();

      if (span <= cols * 2) {
        // 稀疏：逐点连线
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const x = this.xOf(ch.startTime + i * ch.xIncrement, state.view);
          const y = f.yOf((ch.raw[i] - ch.yOff) * ch.yMult + ch.yZero);
          if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        if (span < cols * 0.6) {
          ctx.fillStyle = color;
          for (let i = i0; i <= i1; i++) {
            const x = this.xOf(ch.startTime + i * ch.xIncrement, state.view);
            const y = f.yOf((ch.raw[i] - ch.yOff) * ch.yMult + ch.yZero);
            ctx.fillRect(x - 1.25, y - 1.25, 2.5, 2.5);
          }
        }
        ctx.restore();
        return;
      }

      const ext = f.ext;
      // 每列 min-max 竖线：完整保留毛刺与包络
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const mn = ext.min[c], mx = ext.max[c];
        if (!Number.isFinite(mn)) continue;
        const x = x0 + (c + 0.5) * pxPerCol;
        const yTop = f.yOf(mx), yBot = f.yOf(mn);
        if (yBot - yTop < 1) {
          const y = (yTop + yBot) / 2;
          ctx.moveTo(x, y - 0.5);
          ctx.lineTo(x, y + 0.5);
        } else {
          ctx.moveTo(x, yTop);
          ctx.lineTo(x, yBot);
        }
      }
      ctx.stroke();

      // 中值包络线：让波形轮廓可读
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let c = 0; c < cols; c++) {
        if (!Number.isFinite(ext.mid[c])) { started = false; continue; }
        const x = x0 + (c + 0.5) * pxPerCol;
        const y = f.yOf(ext.mid[c]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    drawTimeAxis(ctx, p, L, state) {
      const span = state.view.t1 - state.view.t0;

      ctx.font = MONO_SMALL;
      // 按标签实际宽度挑选刻度数量，避免相邻标签互相压叠
      let ticks = 4;
      let labels = [];
      for (const cand of [10, 8, 5, 4]) {
        const step = span / cand;
        const candLabels = [];
        for (let i = 0; i <= cand; i++) candLabels.push(state.view.t0 + step * i);
        const unitScale = TekWave.pick(Math.max(Math.abs(state.view.t0), Math.abs(state.view.t1), span))[0];
        const sv = Math.abs(step / unitScale);
        const d = sv >= 1 ? 1 : sv >= 0.1 ? 2 : sv >= 0.01 ? 3 : 4;
        const maxW = Math.max.apply(null, candLabels.map(t => ctx.measureText(TekWave.formatTimeFixed(t, unitScale, d)).width));
        ticks = cand;
        labels = candLabels;
        if (L.w / cand >= maxW + 16) break;
      }

      const tickStep = span / ticks;
      const unitScale = TekWave.pick(Math.max(Math.abs(state.view.t0), Math.abs(state.view.t1), span))[0];
      const sv = Math.abs(tickStep / unitScale);
      const digits = sv >= 1 ? 1 : sv >= 0.1 ? 2 : sv >= 0.01 ? 3 : 4;

      ctx.fillStyle = p.text;
      ctx.textBaseline = 'top';
      for (let i = 0; i <= ticks; i++) {
        const x = L.left + L.w * i / ticks;
        ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
        ctx.fillText(TekWave.formatTimeFixed(labels[i], unitScale, digits), x, L.bottom + 8);
      }
      ctx.textAlign = 'left';
      ctx.fillText(TekWave.formatTimeFixed(tickStep, unitScale, digits) + '/div', L.left, L.bottom + 20);
    }

    drawValueAxis(ctx, p, L, state, frames) {
      ctx.font = MONO_SMALL;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';

      // 叠加模式只标当前通道的刻度，避免多通道刻度互相压叠
      const list = state.mode === 'overlay'
        ? frames.filter(f => f.ch.id === state.activeId).slice(0, 1)
        : frames;

      for (const f of list) {
        // 分道模式每道 3 个刻度（1/4、1/2、3/4 处），叠加模式 9 个
        const stack = state.mode === 'stack';
        const count = stack ? 3 : 9;
        const frac = (k) => stack ? (0.25 + k * 0.25) : (k / 8);
        const values = [];
        for (let k = 0; k < count; k++) {
          values.push(f.centerVal + (f.centerY - (f.laneTop + f.laneH * frac(k))) * f.unitsPerPx);
        }
        const maxAbs = Math.max.apply(null, values.map(Math.abs).concat([1e-12]));
        const unitScale = TekWave.pick(maxAbs)[0];
        const vals = values.map(v => v / unitScale);
        const mag = Math.max.apply(null, vals.map(Math.abs).concat([1e-12]));
        const digits = mag >= 100 ? 1 : mag >= 10 ? 1 : mag >= 1 ? 2 : 3;

        ctx.fillStyle = p.text;
        for (let k = 0; k < count; k++) {
          ctx.fillText(vals[k].toFixed(digits), L.left - 8, f.laneTop + f.laneH * frac(k));
        }
      }

      // 单位：单通道或多通道单位一致时在左上角标注
      const units = Array.from(new Set(frames.map(f => f.ch.yUnit)));
      if (units.length === 1) {
        ctx.textAlign = 'left';
        ctx.fillStyle = p.text;
        ctx.fillText(units[0], 6, L.top + 8);
      }
    }

    drawBadges(ctx, p, L, state, frames) {
      ctx.font = MONO;
      ctx.textBaseline = 'middle';
      let badgeRight = L.left + 6;
      frames.forEach((f, i) => {
        const ch = f.ch;
        const color = p.colors[ch.colorIndex % p.colors.length];
        const divs = state.mode === 'stack' ? 4 : 8;
        const perDiv = f.unitsPerPx * (f.laneH / divs);
        const label = ch.label + '  ' + TekWave.formatSI(perDiv, ch.yUnit + '/div', 2);
        const w = ctx.measureText(label).width + 18;
        const x = L.left + 6;
        const y = state.mode === 'stack' ? f.laneTop + 5 : L.top + 5 + i * 23;
        if (x + w > badgeRight) badgeRight = x + w;
        ctx.fillStyle = p.badge;
        this.roundRect(ctx, x, y, w, 19, 4);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y + 4, 3, 11);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(label, x + 9, y + 10);
      });
      this._badgeRight = badgeRight;
    }


    drawCursors(ctx, p, L, state) {
      const [c1, c2] = state.cursors;
      const xs = [this.xOf(c1, state.view), this.xOf(c2, state.view)];
      if (Math.abs(xs[1] - xs[0]) > 2) {
        ctx.fillStyle = p.cursorAlt;
        ctx.fillRect(Math.min(xs[0], xs[1]), L.top, Math.abs(xs[1] - xs[0]), L.h);
      }
      xs.forEach((x, i) => {
        const hot = state.hoverCursor === i;
        ctx.strokeStyle = p.cursor;
        ctx.lineWidth = hot ? 2 : 1;
        ctx.globalAlpha = hot ? 1 : 0.8;
        // 悬停 / 拖动时画成实线，形状更明确
        ctx.setLineDash(hot ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, L.top);
        ctx.lineTo(Math.round(x) + 0.5, L.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // 顶部手柄三角：抓取区域的可视提示
        const hw = hot ? 8 : 6;
        ctx.fillStyle = p.cursor;
        ctx.beginPath();
        ctx.moveTo(x - hw, L.top);
        ctx.lineTo(x + hw, L.top);
        ctx.lineTo(x, L.top + (hot ? 10 : 8));
        ctx.closePath();
        ctx.fill();
      });
    }

    /** 光标名称标签（X1 / X2）贴在各自光标的底部 */
    drawCursorTags(ctx, p, L, state) {
      const xs = [this.xOf(state.cursors[0], state.view), this.xOf(state.cursors[1], state.view)];
      const gap = Math.abs(xs[1] - xs[0]);
      ctx.font = MONO_SMALL;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const w = 26, h = 15;
      xs.forEach((x, i) => {
        const hot = state.hoverCursor === i;
        const cx = Math.max(L.left + w / 2 + 1, Math.min(L.right - w / 2 - 1, x));
        // 两条线挨太近时把 X2 的标签上移一格，避免相互压叠
        const y = (i === 1 && gap < w + 6) ? L.bottom - 19 - h - 3 : L.bottom - 19;
        ctx.fillStyle = p.cursor;
        ctx.globalAlpha = hot ? 1 : 0.92;
        this.roundRect(ctx, cx - w / 2, y, w, h, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (hot) {
          ctx.strokeStyle = p.textStrong;
          ctx.lineWidth = 1;
          this.roundRect(ctx, cx - w / 2 + 0.5, y + 0.5, w - 1, h - 1, 3);
          ctx.stroke();
        }
        ctx.fillStyle = p.cursorText;
        ctx.fillText('X' + (i + 1), cx, y + h / 2 + 0.5);
      });
      ctx.textAlign = 'left';
    }

    drawCursorLabels(ctx, p, L, state) {
      const [c1, c2] = state.cursors;
      const dt = Math.abs(c2 - c1);
      const full = 'X1 ' + TekWave.formatTime(c1) +
        '   ΔX ' + TekWave.formatTime(dt) + ' (' + TekWave.formatSI(dt > 0 ? 1 / dt : NaN, 'Hz', 3) + ')' +
        '   X2 ' + TekWave.formatTime(c2);
      const brief = 'X1 ' + TekWave.formatTime(c1) + '  ΔX ' + TekWave.formatTime(dt) +
        '  X2 ' + TekWave.formatTime(c2);
      ctx.font = MONO_SMALL;
      ctx.textBaseline = 'middle';
      let text = full;
      let w = ctx.measureText(text).width + 16;
      if (w > L.w - 20) { text = brief; w = ctx.measureText(text).width + 16; }
      // 默认贴右上角；若会被左上角通道标签压到，就下移一行
      const x = Math.max(L.left + 6, L.right - w - 8);
      const y = x < (this._badgeRight || 0) + 8 ? L.top + 28 : L.top + 6;
      ctx.fillStyle = p.badge;
      ctx.strokeStyle = p.cursor;
      ctx.lineWidth = 1;
      this.roundRect(ctx, x, y, w, 19, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.textStrong;
      ctx.textAlign = 'left';
      ctx.fillText(text, x + 8, y + 10);
    }

    drawHover(ctx, p, L, state, frames) {
      const { x, y } = state.hover;
      const t = this.tOf(x, state.view);
      ctx.strokeStyle = p.text;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, L.top);
      ctx.lineTo(Math.round(x) + 0.5, L.bottom);
      ctx.moveTo(L.left, Math.round(y) + 0.5);
      ctx.lineTo(L.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 采样点标记
      const visible = frames.filter(f => !f.empty);
      visible.forEach((f) => {
        const s = f.ch.sampleAtTime(t);
        if (!s) return;
        const py = f.yOf(s.value);
        if (py < f.laneTop - 2 || py > f.laneTop + f.laneH + 2) return;
        ctx.fillStyle = p.colors[f.ch.colorIndex % p.colors.length];
        ctx.beginPath();
        ctx.arc(this.xOf(s.time, state.view), py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      });

      const lines = [{ text: 'T ' + TekWave.formatTime(t), color: p.textStrong }];
      visible.forEach((f) => {
        const s = f.ch.sampleAtTime(t);
        lines.push({
          text: f.ch.label + '  ' + (s ? TekWave.formatValue(s.value, f.ch.yUnit) : '—'),
          color: p.colors[f.ch.colorIndex % p.colors.length]
        });
      });
      ctx.font = MONO;
      const w = Math.max(...lines.map(l => ctx.measureText(l.text).width)) + 18;
      const h = lines.length * 16 + 10;
      let bx = x + 14;
      if (bx + w > L.right) bx = x - w - 14;
      bx = Math.max(L.left + 4, bx);
      let by = y + 14;
      if (by + h > L.bottom) by = y - h - 14;
      by = Math.max(L.top + 4, by);
      ctx.fillStyle = p.tooltipBg;
      ctx.strokeStyle = p.tooltipBorder;
      ctx.lineWidth = 1;
      this.roundRect(ctx, bx, by, w, h, 5);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, bx + 9, by + 13 + i * 16);
      });
    }

    drawBox(ctx, p, L, box) {
      const x = Math.min(box.x0, box.x1);
      const y = Math.min(box.y0, box.y1);
      const w = Math.abs(box.x1 - box.x0);
      const h = Math.abs(box.y1 - box.y0);
      ctx.fillStyle = p.selectFill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = p.selectStroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      ctx.setLineDash([]);
    }

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  root.ScopeRenderer = ScopeRenderer;
  root.SCOPE_PALETTES = PALETTES;
})(typeof globalThis !== 'undefined' ? globalThis : this);

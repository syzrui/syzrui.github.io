/*
 * 波形通道模型：多分辨率 min/max 金字塔、按屏幕像素列抽取、可视区间测量。
 * 10M 点全览时每帧只读几千个桶，缩放/平移保持 60fps 量级。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TekWave = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE_BUCKET = 16;   // 第 0 层每桶原始点数
  const LEVEL_RATIO = 16;   // 层间压缩比
  const LEVEL_COUNT = 5;    // 16 / 256 / 4k / 65k / 1M

  let seq = 0;

  class WaveformChannel {
    constructor(parsed) {
      Object.assign(this, parsed);
      this.id = 'w' + (++seq);
      this.colorIndex = 0;
      this.visible = true;
      this.userScale = 1;     // 固定档位时对 V/div 的倍率
      this.offsetDiv = 0;     // 垂直位移（格）
      this._levels = null;
      this._cols = 0;
      this._buf = null;
    }

    /** 建立 min/max 金字塔（每通道约 n/7 个点，10M 点约 5MB） */
    buildPyramids() {
      if (this._levels) return this;
      const n = this.sampleCount;
      const l0 = Math.ceil(n / BASE_BUCKET);
      const min0 = new Float32Array(l0).fill(Infinity);
      const max0 = new Float32Array(l0).fill(-Infinity);
      const raw = this.raw;
      const mult = this.yMult, off = this.yOff, zero = this.yZero;
      for (let i = 0; i < n; i++) {
        const v = (raw[i] - off) * mult + zero;
        const j = (i / BASE_BUCKET) | 0;
        if (v < min0[j]) min0[j] = v;
        if (v > max0[j]) max0[j] = v;
      }
      const levels = [{ size: BASE_BUCKET, min: min0, max: max0 }];
      for (let k = 1; k < LEVEL_COUNT; k++) {
        const prev = levels[k - 1];
        const len = Math.ceil(prev.min.length / LEVEL_RATIO);
        if (len < 2) break;
        const mn = new Float32Array(len).fill(Infinity);
        const mx = new Float32Array(len).fill(-Infinity);
        for (let i = 0; i < prev.min.length; i++) {
          const j = (i / LEVEL_RATIO) | 0;
          const a = prev.min[i], b = prev.max[i];
          if (a < mn[j]) mn[j] = a;
          if (b > mx[j]) mx[j] = b;
        }
        levels.push({ size: BASE_BUCKET * Math.pow(LEVEL_RATIO, k), min: mn, max: mx });
      }
      this._levels = levels;
      return this;
    }

    timeRange() {
      return [this.startTime, this.startTime + (this.sampleCount - 1) * this.xIncrement];
    }

    /** 时间窗口 → 采样点下标区间（已裁剪到数据范围内） */
    indexRange(t0, t1) {
      if (!this.sampleCount || !this.xIncrement) return null;
      const [tStart, tEnd] = this.timeRange();
      if (t1 < tStart || t0 > tEnd) return null;
      let a = Math.floor((t0 - this.startTime) / this.xIncrement);
      let b = Math.ceil((t1 - this.startTime) / this.xIncrement);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const last = this.sampleCount - 1;
      a = Math.max(0, Math.min(last, a));
      b = Math.max(0, Math.min(last, b));
      if (b < a) return null;
      return [a, b];
    }

    sampleAtTime(t) {
      if (!this.xIncrement) return null;
      const i = Math.round((t - this.startTime) / this.xIncrement);
      if (i < 0 || i >= this.sampleCount) return null;
      return { index: i, value: this.valueAt(i), time: this.startTime + i * this.xIncrement };
    }

    /**
     * 每个屏幕像素列的 min / max / mid。
     * 返回的对象在多次调用间复用，渲染层请立即使用。
     */
    columnExtremes(t0, t1, cols) {
      if (!this._buf || this._cols !== cols) {
        this._buf = {
          min: new Float32Array(cols).fill(Infinity),
          max: new Float32Array(cols).fill(-Infinity),
          mid: new Float32Array(cols).fill(0),
          count: 0
        };
        this._cols = cols;
      }
      const out = this._buf;
      out.count = 0;
      const range = this.indexRange(t0, t1);
      out.min.fill(Infinity);
      out.max.fill(-Infinity);
      if (!range) return out;

      const [start, end] = range;
      const span = end - start + 1;
      out.count = span;
      const perCol = span / cols;

      if (perCol <= 64 || !this._levels) {
        for (let c = 0; c < cols; c++) {
          const lo = Math.min(end, Math.floor(start + span * c / cols));
          const hi = Math.max(lo, Math.min(end, Math.ceil(start + span * (c + 1) / cols) - 1));
          let mn = Infinity, mx = -Infinity;
          for (let i = lo; i <= hi; i++) {
            const v = (this.raw[i] - this.yOff) * this.yMult + this.yZero;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          out.min[c] = mn; out.max[c] = mx; out.mid[c] = (mn + mx) / 2;
        }
        return out;
      }

      this.buildPyramids();
      let level = this._levels[0];
      for (const lv of this._levels) if (lv.size <= perCol / 4) level = lv;
      const lmin = level.min, lmax = level.max, len = lmin.length;
      const inv = 1 / level.size;
      for (let c = 0; c < cols; c++) {
        const s0 = start + span * c / cols;
        const s1 = start + span * (c + 1) / cols;
        let b0 = Math.floor(s0 * inv);
        let b1 = Math.floor((s1 - 1) * inv);
        if (b0 < 0) b0 = 0;
        if (b1 > len - 1) b1 = len - 1;
        if (b1 < b0) b1 = b0;
        let mn = Infinity, mx = -Infinity;
        for (let b = b0; b <= b1; b++) {
          if (lmin[b] < mn) mn = lmin[b];
          if (lmax[b] > mx) mx = lmax[b];
        }
        out.min[c] = mn; out.max[c] = mx; out.mid[c] = (mn + mx) / 2;
      }
      return out;
    }

    /** 可视区间统计（抽样上限 maxPoints，避免遍历 10M 点） */
    measure(t0, t1, maxPoints) {
      const range = this.indexRange(t0, t1);
      if (!range) return null;
      const [start, end] = range;
      const total = end - start + 1;
      const stride = Math.max(1, Math.floor(total / (maxPoints || 120000)));
      let mn = Infinity, mx = -Infinity, sum = 0, sumSq = 0, count = 0;
      for (let i = start; i <= end; i += stride) {
        const v = (this.raw[i] - this.yOff) * this.yMult + this.yZero;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; sumSq += v * v; count++;
      }
      if (!count) return null;
      const avg = sum / count;
      const rms = Math.sqrt(Math.max(0, sumSq / count));
      const pp = mx - mn;

      // 以中值为阈值、加 8% 回差找上升沿，取周期中位数
      let freq = null, period = null;
      if (pp > 1e-12 && total > 32) {
        const mid = (mn + mx) / 2;
        const hyst = pp * 0.08;
        const hi = mid + hyst, lo = mid - hyst;
        let armed = true;
        const edges = [];
        for (let i = start; i <= end && edges.length < 128; i += stride) {
          const v = (this.raw[i] - this.yOff) * this.yMult + this.yZero;
          if (armed && v > hi) { edges.push(i); armed = false; }
          else if (!armed && v < lo) armed = true;
        }
        if (edges.length >= 3) {
          const periods = [];
          for (let i = 1; i < edges.length; i++) periods.push((edges[i] - edges[i - 1]) * this.xIncrement);
          periods.sort((a, b) => a - b);
          const med = periods[periods.length >> 1];
          // 只接受“规则”的周期：多数周期应落在中位数 ±20% 内，否则视为噪声不报频率
          const near = periods.filter(p => Math.abs(p - med) <= med * 0.2).length;
          if (med > 0 && near / periods.length >= 0.6) { period = med; freq = 1 / med; }
        }
      }
      return { min: mn, max: mx, pp, avg, rms, freq, period, sampled: count, total };
    }

    /* 光标区间均值不在这里：全点累加可能上千万点，必须分片计算，见 js/average.js */
  }

  /* ------------------------------ 数值格式化 ------------------------------ */

  const PREFIXES = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']
  ];

  function pick(value) {
    const abs = Math.abs(value);
    if (!Number.isFinite(abs)) return [1, ''];
    if (abs === 0) return [1, ''];
    for (const p of PREFIXES) if (abs >= p[0]) return p;
    return PREFIXES[PREFIXES.length - 1];
  }

  /** 工程计数法：1.25 kSa/s、500 V、−680 mV */
  function formatSI(value, unit, digits) {
    if (!Number.isFinite(value)) return '—';
    const [scale, prefix] = pick(value);
    const v = value / scale;
    const d = digits == null ? (Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3) : digits;
    return v.toFixed(d) + ' ' + prefix + (unit || '');
  }

  /** 时间轴刻度：按量级自适应精度 */
  function formatTime(t, step) {
    if (!Number.isFinite(t)) return '—';
    const abs = Math.abs(t);
    const [scale, prefix] = abs === 0 ? [1, ''] : pick(abs);
    const v = t / scale;
    let d;
    if (step) {
      const sv = Math.abs(step / scale);
      d = sv >= 1 ? 1 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(sv)) + 1));
    } else {
      d = Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : Math.abs(v) >= 1 ? 3 : 4;
    }
    return v.toFixed(d) + ' ' + prefix + 's';
  }

  function prefixOf(scale) {
    for (const p of PREFIXES) if (p[0] === scale) return p[1];
    return '';
  }

  function fixZero(v, d) {
    const eps = 0.5 * Math.pow(10, -d);
    if (Math.abs(v) < eps) v = 0;
    return v.toFixed(d);
  }

  /** 固定单位的时间格式化（整条坐标轴统一 ms / µs，避免混排） */
  function formatTimeFixed(t, scale, digits) {
    if (!Number.isFinite(t)) return '—';
    return fixZero(t / scale, digits) + ' ' + prefixOf(scale) + 's';
  }

  /** 自适应精度的电压/电流读数 */
  function formatValue(v, unit) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    const digits = a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
    return formatSI(v, unit, digits);
  }

  /** 固定单位的数值格式化 */
  function formatFixed(v, scale, digits, unit) {
    if (!Number.isFinite(v)) return '—';
    return fixZero(v / scale, digits) + ' ' + prefixOf(scale) + (unit || '');
  }

  /** 档位序列 1-2-5 */
  function nextScale(current, up) {
    const mant = [1, 2, 5];
    const exp = Math.floor(Math.log10(current));
    const base = Math.pow(10, exp);
    const idx = mant.findIndex(m => Math.abs(current / base - m) < 0.01);
    let i = idx < 0 ? 1 : idx;
    if (up) i = (i + 1) % 3; else i = (i + 2) % 3;
    const e = up && i === 0 ? exp + 1 : (!up && i === 2 ? exp - 1 : exp);
    return mant[i] * Math.pow(10, e);
  }

  return {
    WaveformChannel,
    formatSI, formatValue, formatTime, formatTimeFixed, formatFixed,
    nextScale, pick, prefixOf
  };
});

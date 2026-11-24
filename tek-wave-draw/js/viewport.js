/*
 * TekViewport —— 时间轴的唯一状态源。
 *
 * 设计原则（对应需求规格书第五章）：
 *   1. 只保存三个量：viewStartTime (t0)、viewDuration (dur)、plotWidth (width)；
 *   2. 「像素 ↔ 时间」的正反变换只在这里实现一次，绘制 / 刻度 / 缩放 / 平移 /
 *      光标 / 测量全部调用它，不允许任何模块自己再写一份；
 *   3. 所有窗口变更都是「先定长度、再定起点」，且起点只做单向平移，
 *      不会出现两条边界互相推翻导致的来回跳。
 *
 * 坐标约定：x 一律是「绘图区局部像素」（0 = 绘图区左边界，width = 右边界）。
 * 想从鼠标控件坐标换算，请先减去绘图区左边界（timeAtControl / xOfControl 已封装）。
 */
(function (root) {
  'use strict';

  class Viewport {
    constructor() {
      this.t0 = -1e-3;        // viewStartTime，单位秒
      this.dur = 2e-3;        // viewDuration，单位秒
      this.left = 0;          // 绘图区左边界（canvas 控件坐标）
      this.width = 1;         // plotWidth，绘图区有效宽度（px，整数）
      this.minDur = 1e-9;
      this.maxDur = 1;           // 最大窗口长度 = 数据完整跨度（缩到此为止，不允许更宽）
      this.dataMin = 0;          // 当前数据集有效时间范围（窗口必须落在其中）
      this.dataMax = 1;
      this.hardMin = 0;          // 兼容旧字段：等同 dataMin / dataMax
      this.hardMax = 1;
      this.version = 0;          // 每次窗口变化 +1，供测量模块判断是否需要重算
    }

    /* ==================== 几何 ==================== */

    /** 窗口结束时间（只读派生量，永远等于 t0 + dur） */
    get t1() {
      return this.t0 + this.dur;
    }

    /** 返回宽度是否发生变化（供上层决定是否重排光标） */
    setLayout(left, width) {
      const w = Math.max(1, Math.round(width));
      const changed = w !== this.width;
      this.left = left;
      this.width = w;
      return changed;
    }

    /**
     * 由数据范围给出窗口边界：
     *   · 最大窗口长度 = 数据完整跨度（全波形视图，缩到此为止）
     *   · 窗口必须整体落在 [lo, hi] 内，时间轴不会跑到没有数据的区域
     * 调用方只负责给最小窗口长度（采样率决定）。
     */
    setLimits(minDur, lo, hi) {
      this.dataMin = Math.min(lo, hi);
      this.dataMax = Math.max(lo, hi);
      const span = this.dataSpan();
      this.minDur = Math.min(Math.max(minDur > 0 ? minDur : 1e-15, 1e-15), span);
      this.maxDur = span;
      this.hardMin = this.dataMin;
      this.hardMax = this.dataMax;
    }

    /** 当前数据集的完整时间跨度（最大可显示窗口） */
    dataSpan() {
      const span = this.dataMax - this.dataMin;
      return span > 0 && Number.isFinite(span) ? span : 1e-15;
    }

    /* ==================== 坐标互转（唯一实现） ==================== */

    /** 时间 → 绘图区局部像素（可超出 [0,width]，表示在视野外） */
    xOf(t) {
      return (t - this.t0) / this.dur * this.width;
    }

    /** 绘图区局部像素 → 时间 */
    timeAt(x) {
      return this.t0 + (x / this.width) * this.dur;
    }

    /** 绘图区局部像素 → 控件坐标 */
    xOfControl(x) {
      return this.left + x;
    }

    /** 时间 → 控件坐标 */
    tToControl(t) {
      return this.left + this.xOf(t);
    }

    /** 控件坐标 → 时间（已扣除左侧坐标轴区域） */
    timeAtControl(x) {
      return this.timeAt(x - this.left);
    }

    /** 时间跨度 → 像素跨度 */
    spanToPx(span) {
      return span / this.dur * this.width;
    }

    /** 像素跨度 → 时间跨度 */
    pxToSpan(px) {
      return px / this.width * this.dur;
    }

    /** 窗口长度裁剪到 [minDur, maxDur] */
    clampDur(dur) {
      if (!(dur > 0) || !Number.isFinite(dur)) return this.minDur;
      return Math.min(this.maxDur, Math.max(this.minDur, dur));
    }

    /* ==================== 窗口变更 ==================== */

    /**
     * 设置窗口：长度先裁剪，再单向平移起点。
     * 调用方必须传入「最终生效」的长度（例如缩放时先 clamp 再算起点），
     * 否则起点会按一个随后被裁剪掉的长度计算，锚点就保不住了。
     *
     * 两条不变量：
     *   1. dur 永不超过数据跨度 → 缩到最大就是「全波形视图」，不能更外；
     *   2. 窗口整体落在 [dataMin, dataMax] 内 → 时间轴不会落到数据之外。
     */
    setWindow(t0, dur) {
      const span = this.dataSpan();
      const eps = span * 1e-12;               // 只为吸收浮点误差，肉眼看不出（≈1e-9 px）
      let d = this.clampDur(dur);
      let s = Number.isFinite(t0) ? t0 : this.t0;

      if (d >= span - eps) {
        // 达到数据跨度：唯一合法位置就是完整铺满 [dataMin, dataMax]
        d = span;
        s = this.dataMin;
      } else {
        const maxStart = this.dataMax - d;
        if (s > maxStart) s = maxStart;
        if (s < this.dataMin) s = this.dataMin;
      }

      if (s !== this.t0 || d !== this.dur) this.version++;
      this.t0 = s;
      this.dur = d;
      return this;
    }

    /** 全波形视图：窗口 = 数据完整范围（初始状态与最大缩小档） */
    showFull() {
      return this.setWindow(this.dataMin, this.dataSpan());
    }

    /**
     * 平移：Δt = -Δx / W · T（Δx 为鼠标水平位移，向右为正 → 时间窗左移）。
     * 内部按「起点状态 + 累计位移」计算，不做逐帧累加，长时间拖动也不会有浮点漂移。
     */
    panPx(dx) {
      return this.setWindow(this.t0 - this.pxToSpan(dx), this.dur);
    }

    /**
     * 拖动平移：把拖动开始时刻指针下的时间 anchorT 固定在当前像素 x 处。
     * 与 panPx 等价（t0' = anchorT - x/W·T），但消除了累计误差，
     * 也能保证「鼠标移动多少像素，波形就移动多少像素」。
     */
    panToAnchor(anchorT, x) {
      return this.setWindow(anchorT - (x / this.width) * this.dur, this.dur);
    }

    /**
     * 以绘图区局部像素 x 处为锚点缩放 k 倍（k<1 放大，k>1 缩小）。
     * 缩放前后 x 处的实际时间保持不变：t0' = tx - x/W · T'，
     * T' 使用裁剪后的真实长度，因此触及上下限时锚点依然不跳。
     */
    zoomAt(x, k) {
      const nd = this.clampDur(this.dur * k);
      if (Math.abs(nd - this.dur) <= this.dur * 1e-15) return this;   // 已到极限，画面不动
      const tx = this.timeAt(x);
      return this.setWindow(tx - (x / this.width) * nd, nd);
    }

    /** 以鼠标所在控件坐标缩放（自动扣除左边界；超出绘图区返回 false 表示不处理） */
    zoomAtControl(x, k) {
      const local = x - this.left;
      if (!(this.width > 0) || local < 0 || local > this.width) return false;
      this.zoomAt(local, k);
      return true;
    }

    /** 以绘图区中心缩放 */
    zoomAtCenter(k) {
      return this.zoomAt(this.width / 2, k);
    }

    /** 把时间区间 [a,b] 铺满绘图区（框选 / 适应 / 轴条拖选） */
    showRange(a, b) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const d = this.clampDur(hi - lo);
      return this.setWindow((lo + hi) / 2 - d / 2, d);
    }
  }

  root.TekViewport = Viewport;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * 区间均值求解器：X1→X2 之间「全部采样点」参与计算，不做任何抽样。
 *
 * 为什么不能在主线程里直接 for 一圈：真实 ISF 每通道 1000 万点，四个通道一起求和
 * 约 4000 万次加法，一口气跑完会阻塞 100 ms 量级，拖动立刻掉帧。
 *
 * 做法：
 *   1) 分片累加：每片最多 SLICE_MS 毫秒，超预算立刻 setTimeout(0) 让出主线程；
 *   2) 交互停稳 DEBOUNCE_MS 之后才开挖，拖动光标/缩放的过程中不会反复重启；
 *   3) 结果按「通道 + 采样点下标区间」缓存，同一区间只算一次；
 *   4) 精度：先对原始码值求和 —— 16 bit 整数，1000 万点之和最大 3.3e11 < 2^53，
 *      用 double 累加得到的是「精确整数和」，最后一次性做
 *      (sum/n − yOff)·yMult + yZero，数学上严格等于全点算术平均，且没有逐点累加的舍入误差。
 *
 * 对外状态只有三种：命中缓存（返回数值）／已排期或正在算（返回 null，界面显示「计算中…」）／
 * 区间非法（返回 null，调用方显示 —）。
 */
(function (root) {
  'use strict';

  const SYNC_LIMIT = 120000;    // ≤ 此点数直接同步算完（四通道合计 < 1.5 ms），不必打扰用户
  const BLOCK = 1 << 16;        // 每累加 6.5 万点看一次表，时间片不会明显超出预算
  const SLICE_MS = 4;           // 单片时间预算（一帧 16.7 ms，留足重绘余量）
  const DEBOUNCE_MS = 120;      // 交互停稳多久后开始计算
  const CACHE_PER_CHANNEL = 64; // 每个通道最多记住多少个区间结果

  class AverageSolver {
    constructor() {
      this._cache = new WeakMap(); // ch → Map('i0:i1' → mean)
      this._jobs = new Map();      // ch → job（只保留活动任务，算完即删）
      this.onUpdate = null;        // 某区间算完后通知外部重绘（可能已被取消，需自查缓存）
      this.stats = { asyncJobs: 0, syncJobs: 0, slices: 0, maxSliceMs: 0, maxPoints: 0 };
    }

    _key(i0, i1) { return i0 + ':' + i1; }

    _map(ch, create) {
      let m = this._cache.get(ch);
      if (!m && create) { m = new Map(); this._cache.set(ch, m); }
      return m;
    }

    /** 已算好的值；未算过返回 undefined（区别于 0 / NaN 这类合法结果） */
    value(ch, i0, i1) {
      const m = this._cache.get(ch);
      return m ? m.get(this._key(i0, i1)) : undefined;
    }

    /** 该通道是否有任务在排队或计算中 */
    busy(ch) {
      return this._jobs.has(ch);
    }

    /**
     * 请求区间 [i0, i1]（含两端）的均值。
     * @returns {number|null} 命中缓存或同步算完 → 数值；否则 → null（调用方显示「计算中…」）
     */
    request(ch, i0, i1) {
      if (!ch || !ch.raw || !(i1 >= i0)) return null;
      const key = this._key(i0, i1);
      const hit = this.value(ch, i0, i1);
      if (hit !== undefined) return hit;

      const job = this._jobs.get(ch);
      if (job && job.key === key && !job.stale) return null; // 已在计算 / 已排期
      this._stop(ch);                                        // 区间变了，旧任务作废

      const n = i1 - i0 + 1;
      if (n <= SYNC_LIMIT) {
        const sum = this._sum(ch, i0, i1);
        this._store(ch, key, this._mean(ch, sum, n));
        this.stats.syncJobs++;
        if (n > this.stats.maxPoints) this.stats.maxPoints = n;
        return this.value(ch, i0, i1);
      }

      this._jobs.set(ch, { key, i0, i1, i: i0, sum: 0, timer: 0, stale: false });
      const j = this._jobs.get(ch);
      this.stats.asyncJobs++;
      if (n > this.stats.maxPoints) this.stats.maxPoints = n;
      j.timer = setTimeout(() => this._run(ch, j), DEBOUNCE_MS);
      return null;
    }

    /** 数据被替换 / 关闭光标时调用：停掉所有排队任务 */
    cancelAll() {
      for (const ch of Array.from(this._jobs.keys())) this._stop(ch);
    }

    /* ------------------------------ 内部 ------------------------------ */

    _stop(ch) {
      const j = this._jobs.get(ch);
      if (!j) return;
      j.stale = true;
      if (j.timer) clearTimeout(j.timer);
      this._jobs.delete(ch);
    }

    /** 原始码值的精确整数和 */
    _sum(ch, i0, i1) {
      const raw = ch.raw;
      let s = 0;
      for (let i = i0; i <= i1; i++) s += raw[i];
      return s;
    }

    /** 全点算术平均：码值线性变换，先求均值再变换，与逐点变换后平均完全等价 */
    _mean(ch, sum, n) {
      return ((sum / n) - ch.yOff) * ch.yMult + ch.yZero;
    }

    _store(ch, key, value) {
      const m = this._map(ch, true);
      m.set(key, value);
      while (m.size > CACHE_PER_CHANNEL) m.delete(m.keys().next().value);
    }

    _run(ch, j) {
      if (j.stale) return;
      const raw = ch.raw;
      const end = j.i1;
      const t0 = performance.now();
      let i = j.i;
      let sum = j.sum;

      while (i <= end) {
        const stop = Math.min(end + 1, i + BLOCK);
        for (; i < stop; i++) sum += raw[i];
        if (performance.now() - t0 >= SLICE_MS) break;
      }

      j.sum = sum;
      j.i = i;
      this.stats.slices++;
      const spent = performance.now() - t0;
      if (spent > this.stats.maxSliceMs) this.stats.maxSliceMs = spent;

      if (i > end) {
        this._jobs.delete(ch);
        this._store(ch, j.key, this._mean(ch, sum, j.i1 - j.i0 + 1));
        if (this.onUpdate) this.onUpdate();
      } else {
        j.timer = setTimeout(() => this._run(ch, j), 0);
      }
    }
  }

  root.TekAverage = { Solver: AverageSolver, SYNC_LIMIT, DEBOUNCE_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);

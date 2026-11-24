/*
 * 光标测量模块：只负责「按当前时间轴把像素锚点换算成时间，再算测量值」，
 * 不持有任何状态、不修改视图、不碰 DOM —— 这样任何一处状态变化后重算都不会有副作用。
 *
 * 内部时间单位统一为秒，显示层再做 ns/µs/ms/s 换算。
 */
(function (root) {
  'use strict';

  const MIN_STEP = 1e-15;   // 低于此时间差视为 0（避免除零与浮点噪声）

  /**
   * 取某时刻的波形幅值：命中采样点直接取，落在两点之间线性插值。
   * 超出通道有效数据范围返回 null（调用方显示为无效）。
   */
  function interpolate(ch, t) {
    if (!ch || !ch.sampleCount || !(ch.xIncrement > 0)) return null;
    if (!Number.isFinite(t)) return null;
    const tStart = ch.startTime;
    const tEnd = tStart + (ch.sampleCount - 1) * ch.xIncrement;
    if (t < tStart || t > tEnd) return null;

    const pos = (t - tStart) / ch.xIncrement;
    const i0 = Math.floor(pos + 1e-9);
    const idx0 = Math.max(0, Math.min(ch.sampleCount - 1, i0));
    const idx1 = Math.min(ch.sampleCount - 1, idx0 + 1);
    const frac = Math.max(0, Math.min(1, pos - idx0));
    const v0 = ch.valueAt(idx0);
    const v1 = ch.valueAt(idx1);
    const value = v0 + (v1 - v0) * frac;
    return {
      value,
      exact: frac < 1e-9,
      index: idx0,
      indexNext: idx1,
      frac
    };
  }

  /**
   * 计算 X1 / X2 的全部测量参数。
   *
   * @param {object} state 需要 state.viewport（统一时间轴）与 state.cursors（像素锚点）
   * @returns {CursorMeasurements}
   */
  function cursorMeasurements(state) {
    const vp = state.viewport;
    const x1 = state.cursors.x1;
    const x2 = state.cursors.x2;

    // 1) 像素锚点 → 时间（唯一换算入口）
    const timeX1 = vp.timeAt(x1);
    const timeX2 = vp.timeAt(x2);
    const dSigned = timeX2 - timeX1;
    const deltaTime = Math.abs(dSigned);

    // 2) 时间分辨率：可见通道里最粗的采样间隔，低于半个间隔就认为测不出周期
    let res = 0;
    for (const ch of state.channels) {
      if (ch.visible && ch.xIncrement > res) res = ch.xIncrement;
    }
    const validDelta = deltaTime > Math.max(MIN_STEP, res * 0.5);
    const period = validDelta ? deltaTime : null;
    const frequency = validDelta ? 1 / deltaTime : null;

    // 3) 逐通道取幅值 → ΔY → X1↔X2 区间均值
    const rows = [];
    for (const ch of state.channels) {
      if (!ch.visible) continue;
      const a = interpolate(ch, timeX1);
      const b = interpolate(ch, timeX2);
      const valueX1 = a ? a.value : null;
      const valueX2 = b ? b.value : null;
      const deltaValue = (valueX1 != null && valueX2 != null) ? valueX2 - valueX1 : null;
      // 区间均值：两端都落在有效数据内才算；宽区间等间隔抽样（最多 2 万点），
      // 4 通道合计约 8 万次加法，单帧开销 < 1 ms，又足以覆盖窄脉冲
      const average = (a && b) ? ch.averageBetween(timeX1, timeX2, 20000) : null;
      rows.push({
        ch,
        valueX1,
        valueX2,
        deltaValue,
        average,
        exactX1: a ? a.exact : false,
        exactX2: b ? b.exact : false,
        valid: valueX1 != null && valueX2 != null
      });
    }

    const valid = rows.length > 0;
    return {
      x1, x2,
      timeX1, timeX2,
      deltaTime,          // 恒为非负
      deltaSigned: dSigned,
      period,
      frequency,
      freqValid: frequency != null,
      resolution: res,
      rows,
      valid
    };
  }

  root.TekMeasure = { interpolate, cursorMeasurements };
})(typeof globalThis !== 'undefined' ? globalThis : this);

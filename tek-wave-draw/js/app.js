/*
 * 网页示波器主逻辑：文件加载、视图状态、测量、交互。
 * 纯静态实现，无框架、无构建步骤。
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const CH_LIMIT = 8;
  const ZOOM_IN_MIN_POINTS = 16; // 时间窗口最短 = 16 个采样间隔
  const ZOOM_SENSITIVITY = 0.0016; // 每像素滚动的缩放指数

  /* 时间轴唯一状态源：所有像素↔时间换算、平移、缩放都经由它 */
  const viewport = new TekViewport();

  const state = {
    channels: [],
    viewport,                    // ← 取代原来的 state.view
    mode: 'stack',
    verticalMode: 'auto',
    showGrid: true,
    showHover: true,
    showCursors: false,
    cursors: { x1: 0, x2: 0 },   // ← 绘图区局部像素锚点（不是时间！）
    hoverCursor: -1,
    lastCursor: -1,      // 重合时交替选中用
    activeId: null,
    hover: null,
    pointer: null,
    boxTool: false,
    boxSelect: null,
    measure: null,               // 最新一次光标测量结果
    theme: localStorage.getItem('tekscope-theme') === 'light' ? 'light' : 'dark',
    renderMs: 0
  };

  const canvas = $('#scopeCanvas');
  const wrap = $('#dropZone');
  const renderer = new ScopeRenderer(canvas);
  renderer.vp = viewport;

  /** 交互状态机：idle | pan | cursor | box | timebox | pinch（同一时刻只允许一种） */
  const interaction = { mode: 'idle', index: -1, anchorT: 0, x0: 0, t0: 0 };

  let renderQueued = false;
  let measureTimer = null;
  let dragDepth = 0;
  let autoDemoTried = false;

  document.body.dataset.theme = state.theme;

  /* ============================ 基础工具 ============================ */

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function nextFrame() {
    return new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
  }

  function palette() {
    return (window.SCOPE_PALETTES || {})[state.theme] || { colors: ['#4dd0e1'] };
  }

  function colorOf(ch) {
    const cols = palette().colors;
    return cols[ch.colorIndex % cols.length];
  }

  /**
   * 单帧刷新：几何同步 → 用最新时间轴重算测量 → 绘制 → 刷新读数。
   * 波形、刻度、光标、测量值都取自同一份状态，不存在“画面新、数据旧”。
   */
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      syncGeometry();
      state.measure = TekMeasure.cursorMeasurements(state);
      const t = performance.now();
      renderer.draw(state);
      state.renderMs = performance.now() - t;
      updateCursorCard();
      updateStatus();
    });
  }

  /** 可视区间统计表（通道峰峰/频率）较重，单独节流；光标读数在渲染帧内实时算 */
  function scheduleMeasure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(updateMeasurements, 120);
  }

  function viewChanged() {
    scheduleRender();
    scheduleMeasure();
    // 视图变了但指针没动时，命中状态可能已经失效，这里按指针实际位置重算
    refreshHoverCursor();
  }

  /* ============================ 时间轴 ============================ */

  function dataBounds() {
    if (!state.channels.length) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    for (const ch of state.channels) {
      const [a, b] = ch.timeRange();
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    if (!(hi > lo)) return [lo, lo + 1e-3];
    return [lo, hi];
  }

  function minSpan() {
    let dt = Infinity;
    for (const ch of state.channels) if (ch.xIncrement > 0) dt = Math.min(dt, ch.xIncrement);
    if (!Number.isFinite(dt)) dt = 1e-9;
    return dt * ZOOM_IN_MIN_POINTS;
  }

  /**
   * 数据范围 → 视口边界。
   * 最大窗口长度就是数据完整跨度：加载后即处于该状态，滚轮再往下只会被限制住，
   * 不会缩到数据之外（这正是「时间轴与波形数据不匹配」的根因）。
   */
  function syncLimits() {
    const [lo, hi] = dataBounds();
    viewport.setLimits(minSpan(), lo, hi);
    // 数据集本身变化（增删通道后跨度变小）时，旧窗口可能已越界：
    // 就地按新边界收敛，避免“窗口还停在上一份数据的范围里”。
    viewport.setWindow(viewport.t0, viewport.dur);
  }

  /**
   * 绘图区几何同步。
   * plotWidth 变化属于「布局变化」，与时间轴缩放不是一回事：
   * 这里按同比例缩放两个光标的像素锚点，使其相对位置不变，再裁到 [0, width]。
   */
  function syncGeometry() {
    const L = renderer.layout();
    const oldW = viewport.width;
    if (!viewport.setLayout(L.left, L.w)) return;
    const k = oldW > 0 ? viewport.width / oldW : 1;
    if (Number.isFinite(k) && k > 0) {
      state.cursors.x1 *= k;
      state.cursors.x2 *= k;
    }
    clampCursorX();
  }

  function clampCursorX() {
    const w = viewport.width;
    state.cursors.x1 = Math.max(0, Math.min(w, state.cursors.x1));
    state.cursors.x2 = Math.max(0, Math.min(w, state.cursors.x2));
  }

  /**
   * 全波形视图：时间窗口 = 数据完整范围，不加内边距。
   * 这一状态同时就是允许缩放的最大窗口，加载完成后必须停在这里。
   */
  function fitView() {
    syncLimits();
    viewport.showFull();
    viewChanged();
  }

  /** 按钮 / 快捷键缩放：以绘图区中心为锚点 */
  function zoomBy(k) {
    viewport.zoomAtCenter(k);
    viewChanged();
  }

  /** 键盘平移：fraction 为正表示窗口右移 */
  function panByFraction(fraction) {
    viewport.setWindow(viewport.t0 + viewport.dur * fraction, viewport.dur);
    viewChanged();
  }

  function setView(t0, t1) {
    viewport.showRange(t0, t1);
    viewChanged();
  }

  /* ============================ 加载 ============================ */

  function showLoading(text) {
    const el = $('#loading');
    if (text == null) { el.hidden = true; return; }
    $('#loadingText').textContent = text;
    el.hidden = false;
  }

  function colorIndexForLabel(label) {
    const m = /^CH\s*([1-8])$/i.exec(label || '');
    return m ? Number(m[1]) - 1 : -1;
  }

  function sortChannels() {
    state.channels.sort((a, b) => {
      const na = parseInt((a.label || '').replace(/\D+/g, ''), 10);
      const nb = parseInt((b.label || '').replace(/\D+/g, ''), 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a.label).localeCompare(String(b.label));
    });
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && f.size > 0);
    if (!files.length) return;
    showLoading('读取 ' + files.length + ' 个文件…');
    await nextFrame();

    const added = [];
    let limitWarned = false;
    for (const file of files) {
      showLoading('解析 ' + file.name + ' …');
      await nextFrame();
      try {
        const buffer = await file.arrayBuffer();
        const parsed = TekISF.parse(buffer, file.name);
        if (!parsed.sampleCount) throw new Error('波形点数为 0');
        const ch = new TekWave.WaveformChannel(parsed);
        const ci = colorIndexForLabel(ch.label);
        ch.colorIndex = ci >= 0 ? ci : (state.channels.length + added.length) % 8;
        showLoading('建立索引 ' + ch.label + ' …');
        await nextFrame();
        ch.buildPyramids();
        added.push(ch);
      } catch (err) {
        console.error(err);
        toast('解析失败：' + file.name + ' — ' + err.message, true);
      }
    }
    showLoading(null);
    if (!added.length) return;

    // 同名通道替换、重名文件覆盖
    for (const ch of added) {
      const i = state.channels.findIndex(c => c.label === ch.label || c.fileName === ch.fileName);
      if (i >= 0) {
        ch.visible = state.channels[i].visible;
        ch.userScale = state.channels[i].userScale;
        ch.offsetDiv = state.channels[i].offsetDiv;
        ch.colorIndex = state.channels[i].colorIndex;
        state.channels[i] = ch;
      } else if (state.channels.length < CH_LIMIT) {
        state.channels.push(ch);
      } else if (!limitWarned) {
        limitWarned = true;
        toast('最多同时显示 ' + CH_LIMIT + ' 个通道，多余文件已忽略', true);
      }
    }
    sortChannels();
    // 优先保持当前通道；否则选编号最小的通道
    if (!state.channels.some(c => c.id === state.activeId)) {
      state.activeId = state.channels[0].id;
    }
    refreshAll();
    fitView();
    toast('已加载 ' + added.length + ' 个通道，共 ' +
      added.reduce((a, c) => a + c.sampleCount, 0).toLocaleString() + ' 个采样点');
  }

  /** 内置示例：首屏默认波形与「示例数据」按钮共用同一组路径（相对站内根，部署到 GitHub Pages 子路径也成立） */
  const SAMPLE_DIR = './samples/';
  const SAMPLE_FILES = ['CH1.isf', 'CH2.isf', 'CH3.isf', 'CH4.isf'].map(n => SAMPLE_DIR + n);

  /** 优先读取 ./samples/ 下的真实波形，失败则退回合成波形 */
  async function loadSamples(silent) {
    const names = SAMPLE_FILES;
    try {
      showLoading('加载示例波形…');
      const responses = await Promise.all(names.map(n => fetch(n, { cache: 'force-cache' })));
      if (responses.some(r => !r.ok)) throw new Error('示例文件缺失');
      const buffers = await Promise.all(responses.map(r => r.arrayBuffer()));
      showLoading(null);
      const added = [];
      for (let i = 0; i < buffers.length; i++) {
        const parsed = TekISF.parse(buffers[i], names[i].split('/').pop());
        const ch = new TekWave.WaveformChannel(parsed);
        ch.colorIndex = i;
        ch.isSample = true;
        ch.buildPyramids();
        added.push(ch);
      }
      state.channels = added;
      state.activeId = added[0].id;
      refreshAll();
      fitView();
      if (!silent) toast('已加载四通道示例波形（每 50 点抽取 1 点）');
    } catch (err) {
      showLoading(null);
      console.warn('[示例] 无法读取 ' + SAMPLE_DIR + '：', err.message);
      buildSyntheticDemo();
      if (!silent) toast('已生成合成演示波形');
    }
  }

  /** 无网络 / file:// 打开时的兜底：合成四通道波形 */
  function buildSyntheticDemo() {
    const n = 200000;
    const xIncr = 4e-8;
    const t0 = -3.728e-3;
    const specs = [
      { label: 'CH1', unit: 'V', vScale: 500, fn: (t) => {
          const ph = (t + 3.728e-3) % 2e-3;
          return ph < 1.2e-4 ? 1220 - ph * 2e6 : -680;
        } },
      { label: 'CH2', unit: 'V', vScale: 100, fn: (t) => {
          const ph = (t + 3.728e-3) % 2e-3;
          return (ph > 1.1e-4 && ph < 2.1e-4) ? 124 : -12;
        } },
      { label: 'CH3', unit: 'V', vScale: 50, fn: (t) => 50 + 40 * Math.sin(2 * Math.PI * 500 * t) + (Math.random() - 0.5) * 6 },
      { label: 'CH4', unit: 'V', vScale: 2, fn: (t) => {
          const ph = (t + 3.728e-3) % 2e-3;
          return ph < 1e-4 ? 4.2 * Math.exp(-ph * 12000) * Math.cos(2 * Math.PI * 22000 * ph) : 0.12;
        } }
    ];
    state.channels = specs.map((s, i) => {
      const raw = new Float32Array(n);
      for (let k = 0; k < n; k++) raw[k] = s.fn(t0 + k * xIncr);
      const parsed = {
        fileName: 'demo-' + s.label + '.isf', label: s.label, wfid: '合成演示波形 ' + s.label,
        encoding: 'DEMO', fields: {}, raw, sampleCount: n, bitNr: 32,
        xUnit: 's', yUnit: s.unit, xIncrement: xIncr, xZero: t0, ptOff: 0,
        yMult: 1, yOff: 0, yZero: 0, vScale: s.vScale, hScale: 800e-6,
        vPos: 0, vOffset: 0, hDelay: 0,
        startTime: t0, endTime: t0 + (n - 1) * xIncr,
        duration: (n - 1) * xIncr, sampleRate: 1 / xIncr,
        valueAt(i) { return this.raw[i]; }
      };
      const ch = new TekWave.WaveformChannel(parsed);
      ch.colorIndex = i;
      ch.isDemo = true;
      return ch;
    });
    state.activeId = state.channels[0].id;
    refreshAll();
    fitView();
  }

  /* ============================ 界面刷新 ============================ */

  function activeChannel() {
    return state.channels.find(c => c.id === state.activeId) || state.channels[0] || null;
  }

  function refreshAll() {
    syncLimits();
    renderChannelList();
    updateMeasurements();
    updateCursorCard();
    updateInfo();
    updateToolbar();
    scheduleRender();
    updateStatus();
  }

  function updateToolbar() {
    $$('[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === state.mode));
    $$('[data-vmode]').forEach(b => {
      b.classList.toggle('is-on', b.dataset.vmode === state.verticalMode);
      // 叠加视图下各通道单位/量级不同，自动量程会让波形糊满屏幕，故仅固定档位可用
      if (b.dataset.vmode === 'auto') {
        b.disabled = state.mode === 'overlay';
        b.title = state.mode === 'overlay' ? '叠加视图使用固定档位（各通道 V/div）' : '';
      }
    });
    $('#btnCursor').classList.toggle('is-on', state.showCursors);
    $('#btnGrid').classList.toggle('is-on', state.showGrid);
    $('#btnHover').classList.toggle('is-on', state.showHover);
    $('#btnBox').classList.toggle('is-on', state.boxTool);
  }

  const EYE_ON = '<svg viewBox="0 0 16 16" fill="none"><path d="M1.4 8S3.9 3.6 8 3.6 14.6 8 14.6 8 12.1 12.4 8 12.4 1.4 8 1.4 8z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M6.2 4.1A6.6 6.6 0 018 3.6C12.1 3.6 14.6 8 14.6 8a10 10 0 01-2 2.6M4.1 5.3A10 10 0 001.4 8S3.9 12.4 8 12.4c.7 0 1.3-.1 1.9-.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  function renderChannelList() {
    const list = $('#channelList');
    const visible = state.channels.filter(c => c.visible).length;
    $('#channelSummary').textContent = visible + ' / ' + state.channels.length;

    if (!state.channels.length) {
      list.innerHTML = '<p class="empty">尚未加载波形<br><span>打开 .isf 或拖入文件</span></p>';
      return;
    }
    list.innerHTML = state.channels.map(ch => {
      const isActive = ch.id === state.activeId;
      const perDiv = (ch.vScale || 1) * ch.userScale;
      const meta = state.verticalMode === 'auto'
        ? '自动量程 · ' + TekWave.formatSI(ch.sampleRate, 'Sa/s', 2)
        : TekWave.formatSI(perDiv, ch.yUnit + '/div', 2) + ' · ' + TekWave.formatSI(ch.sampleRate, 'Sa/s', 2);
      return '<div class="ch-card' + (isActive ? ' is-active' : '') + (ch.visible ? '' : ' is-off') +
        '" data-id="' + ch.id + '" data-act="select" style="--ch:' + colorOf(ch) + '">' +
        '<div class="ch-top">' +
          '<span class="ch-name">' + escapeHtml(ch.label) + '</span>' +
          '<button class="ch-eye' + (ch.visible ? '' : ' off') + '" data-act="toggle" type="button" title="显示 / 隐藏">' +
            (ch.visible ? EYE_ON : EYE_OFF) + '</button>' +
          '<button class="ch-eye ch-del" data-act="remove" type="button" title="移除该通道">' +
            '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="ch-meta" title="' + escapeHtml(ch.fileName) + '">' + escapeHtml(meta) + '</div>' +
        '<div class="ch-ctrl">' +
          '<button class="vbtn" data-act="vdown" type="button" title="增大 V/div"' +
            (state.verticalMode === 'auto' ? ' disabled' : '') + '>−</button>' +
          '<button class="vbtn" data-act="vup" type="button" title="减小 V/div"' +
            (state.verticalMode === 'auto' ? ' disabled' : '') + '>+</button>' +
          '<input type="range" data-act="offset" min="-4" max="4" step="0.05" value="' + ch.offsetDiv +
            '" aria-label="垂直位移" title="垂直位移（格）">' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateMeasurements() {
    const body = $('#measureBody');
    const visible = state.channels.filter(c => c.visible);
    if (!visible.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">—</td></tr>';
      return;
    }
    const rows = [];
    for (const ch of visible) {
      const m = ch.measure(viewport.t0, viewport.t1, 120000);
      const color = colorOf(ch);
      if (!m) {
        rows.push('<tr><td class="ch" style="color:' + color + '">' + escapeHtml(ch.label) +
          '</td><td colspan="5" class="muted">超出数据范围</td></tr>');
        continue;
      }
      // 行内统一单位，避免 kV / V 混排
      const unitScale = TekWave.pick(Math.abs(ch.vScale) || Math.abs(m.pp) || 1)[0];
      const mag = Math.max(Math.abs(m.pp), Math.abs(m.max), Math.abs(m.min)) / unitScale;
      const digits = mag >= 100 ? 1 : mag >= 10 ? 2 : 3;
      const f = (v) => TekWave.formatFixed(v, unitScale, digits);
      rows.push(
        '<tr>' +
        '<td class="ch" style="color:' + color + '">' + escapeHtml(ch.label) +
          '<em>' + escapeHtml(ch.yUnit) + '</em></td>' +
        '<td>' + f(m.pp) + '</td>' +
        '<td>' + f(m.max) + '</td>' +
        '<td>' + f(m.min) + '</td>' +
        '<td>' + f(m.avg) + '</td>' +
        '<td>' + f(m.rms) + '</td>' +
        '<td>' + (m.freq ? TekWave.formatSI(m.freq, 'Hz', 3) : '—') + '</td>' +
        '</tr>'
      );
    }
    body.innerHTML = rows.join('');
  }

  /** 窄面板用的紧凑读数：400mA / +40.0V / 11.72V（单位紧贴数值，省横向空间） */
  function compactValue(v, unit, signed, refScale) {
    if (!Number.isFinite(v)) return '—';
    let val = v;
    if (signed && Math.abs(val) < 5e-13) val = 0;
    const [scale, prefix] = refScale ? [refScale, TekWave.prefixOf(refScale)] : TekWave.pick(val);
    const x = val / scale;
    const a = Math.abs(x);
    // 相对参考量级判定为 0（例如电流通道里 1e-10 A 的差值），避免出现 “+0A”
    if (signed && a < 1e-4) { val = 0; }
    const x2 = val / scale;
    const a2 = Math.abs(x2);
    let s = a2 >= 100 ? x2.toFixed(1) : a2 >= 10 ? x2.toFixed(2) : a2 >= 1 ? x2.toFixed(3) : x2.toFixed(4);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return (signed && x2 > 0 ? '+' : '') + s + prefix + (unit || '');
  }

  /**
   * 光标读数面板：数据全部来自 state.measure（每帧按最新时间轴重算），
   * 这里只做格式化与 DOM 写入，且只有内容变化时才写 innerHTML。
   */
  function updateCursorCard() {
    const box = $('#cursorReadout');
    if (!state.showCursors) {
      if (box.dataset.sig !== 'off') {
        box.innerHTML = '<p class="muted">开启「光标」后可拖动 X1 / X2。两条光标锚定在绘图区像素位置：缩放、平移时屏幕位置不变，对应时间与测量值实时重算。</p>';
        box.dataset.sig = 'off';
      }
      return;
    }
    const m = state.measure || TekMeasure.cursorMeasurements(state);

    const parts = [
      '<div class="kv-row"><span class="cx">X1</span><span>' + TekWave.formatTime(m.timeX1) + '</span></div>',
      '<div class="kv-row"><span class="cx">X2</span><span>' + TekWave.formatTime(m.timeX2) + '</span></div>',
      '<div class="kv-row"><span>ΔT</span><span>' + TekWave.formatTime(m.deltaTime) + '</span></div>',
      '<div class="kv-row"><span>周期 T</span><span>' + (m.period != null ? TekWave.formatTime(m.period) : '—') + '</span></div>',
      '<div class="kv-row"><span>频率 f</span><span>' + (m.freqValid ? TekWave.formatSI(m.frequency, 'Hz', 4) : '—') + '</span></div>'
    ];

    if (m.rows.length) {
      const rows = ['<table class="ctable"><thead><tr><th>通道</th><th>Y@X1</th><th>Y@X2</th><th>ΔY</th><th>均值</th></tr></thead><tbody>'];
      for (const r of m.rows) {
        const ch = r.ch;
        // ΔY / 均值沿用 X1/X2 中较大者的量级，避免 “-80 mA” 与 “0 A” 混排
        const refScale = (r.valueX1 != null && r.valueX2 != null)
          ? TekWave.pick(Math.max(Math.abs(r.valueX1), Math.abs(r.valueX2)))[0]
          : null;
        const avgText = r.average == null ? '—' : compactValue(r.average, ch.yUnit, false, refScale);
        const title = ch.label +
          '｜X1 ' + (r.valueX1 == null ? '（超出数据范围）' : TekWave.formatValue(r.valueX1, ch.yUnit)) +
          '，X2 ' + (r.valueX2 == null ? '（超出数据范围）' : TekWave.formatValue(r.valueX2, ch.yUnit)) +
          '，ΔY ' + (r.deltaValue == null ? '—' : TekWave.formatValue(r.deltaValue, ch.yUnit)) +
          '，区间均值 ' + (r.average == null ? '—' : TekWave.formatValue(r.average, ch.yUnit)) +
          (r.average == null ? '' : '（区间内采样点等间隔抽样求平均，最多 2 万点）');
        rows.push('<tr title="' + escapeHtml(title) + '">' +
          '<td class="ch" style="color:' + colorOf(ch) + '">' + escapeHtml(ch.label) + '</td>' +
          '<td>' + (r.valueX1 == null ? '—' : compactValue(r.valueX1, ch.yUnit)) + '</td>' +
          '<td>' + (r.valueX2 == null ? '—' : compactValue(r.valueX2, ch.yUnit)) + '</td>' +
          '<td>' + (r.deltaValue == null ? '—' : compactValue(r.deltaValue, ch.yUnit, true, refScale)) + '</td>' +
          '<td>' + avgText + '</td>' +
          '</tr>');
      }
      rows.push('</tbody></table>');
      parts.push('<div class="ctable-wrap">' + rows.join('') + '</div>');
      parts.push('<p class="note">Y 按时间回查采样点（两点之间线性插值）；均值 = X1→X2 区间内采样点平均（宽区间等间隔抽样，最多 2 万点）；f = 1/|ΔT| 只有当 X1→X2 正好跨一个完整周期时才等于信号频率。</p>');
    }
    const html = parts.join('');
    if (html !== box.dataset.sig) {
      box.innerHTML = html;
      box.dataset.sig = html;
    }
  }

  function updateInfo() {
    const ch = activeChannel();
    const dl = $('#fileInfo');
    if (!ch) { dl.innerHTML = '<dt class="muted">未选择通道</dt>'; return; }
    const [t0, t1] = ch.timeRange();
    const items = [
      ['通道', ch.label],
      ['文件', ch.isDemo ? '合成演示波形' : (ch.isSample ? '示例数据（50:1 降采样）' : ch.fileName)],
      ['点数', ch.sampleCount.toLocaleString()],
      ['采样率', TekWave.formatSI(ch.sampleRate, 'Sa/s', 3)],
      ['采样间隔', TekWave.formatSI(ch.xIncrement, 's', 3)],
      ['时基', TekWave.formatSI(ch.hScale || ch.xIncrement * 10, 's/div', 2)],
      ['垂直档位', state.verticalMode === 'auto' ? '自动量程' : TekWave.formatSI(ch.vScale * ch.userScale, ch.yUnit + '/div', 3)],
      ['编码 / 位宽', ch.encoding + ' · ' + ch.bitNr + ' bit'],
      ['时间范围', TekWave.formatTime(t0) + ' → ' + TekWave.formatTime(t1)],
      ['说明', ch.wfid || '—']
    ];
    dl.innerHTML = items.map(([k, v]) =>
      '<dt>' + escapeHtml(k) + '</dt><dd title="' + escapeHtml(v) + '">' + escapeHtml(v) + '</dd>').join('');
  }

  function updateStatus() {
    const dur = viewport.dur;
    let points = 0;
    for (const ch of state.channels) {
      if (!ch.visible) continue;
      const r = ch.indexRange(viewport.t0, viewport.t1);
      if (r) points += r[1] - r[0] + 1;
    }
    $('#statusWindow').textContent = '窗口 ' + TekWave.formatTime(viewport.t0) + ' → ' +
      TekWave.formatTime(viewport.t1) + '（' + TekWave.formatTime(dur, dur / 10) + '）';
    $('#statusPoints').textContent = state.channels.length ? ('显示 ' + points.toLocaleString() + ' 点') : '点数 —';
    const ch = activeChannel();
    $('#statusRate').textContent = '采样率 ' + (ch ? TekWave.formatSI(ch.sampleRate, 'Sa/s', 3) : '—');
    $('#statusRender').textContent = '渲染 ' + state.renderMs.toFixed(1) + ' ms';
  }

  /* ============================ 交互 ============================ */

  function localPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function insidePlot(pt) {
    const L = renderer.layout();
    return pt.x >= L.left && pt.x <= L.right && pt.y >= L.top && pt.y <= L.bottom;
  }

  /* ---------------- 光标（像素锚点） ---------------- */

  function cursorTolerance() {
    if (interaction.mode === 'cursor') return 10;
    return state.hoverCursor >= 0 ? 9 : 7;
  }

  function cursorX(i) {
    return i === 0 ? state.cursors.x1 : state.cursors.x2;
  }

  /** 光标像素锚点：只允许落在绘图区内（规格 4.2.10） */
  function setCursorX(i, x) {
    const v = Math.max(0, Math.min(viewport.width, x));
    if (i === 0) state.cursors.x1 = v; else state.cursors.x2 = v;
  }

  /**
   * 命中检测：取最近的一条；两条重合（<3px）时按「上次拖动的另一条」交替选中，
   * 保证重合状态下仍能分别操作 X1 / X2。
   */
  function hitCursor(pt) {
    if (!state.showCursors) return -1;
    const tol = cursorTolerance();
    const L = renderer.layout();
    const d1 = Math.abs(L.left + state.cursors.x1 - pt.x);
    const d2 = Math.abs(L.left + state.cursors.x2 - pt.x);
    const h1 = d1 <= tol, h2 = d2 <= tol;
    if (h1 && h2) {
      if (Math.abs(state.cursors.x1 - state.cursors.x2) < 3) {
        return state.lastCursor === 0 ? 1 : 0;
      }
      return d1 <= d2 ? 0 : 1;
    }
    if (h1) return 0;
    if (h2) return 1;
    return -1;
  }

  /** 光标线悬停样式：让用户明确知道这里可以拖动 */
  function setCanvasCursor(over) {
    const changed = state.hoverCursor !== over;
    state.hoverCursor = over;
    canvas.style.cursor = over >= 0 ? 'ew-resize' : '';
    return changed;
  }

  /** 视图变化后按指针“当前实际位置”重算命中，避免高亮与实体脱节 */
  function refreshHoverCursor() {
    if (interaction.mode === 'cursor') return;
    if (!state.pointer) { setCanvasCursor(-1); return; }
    setCanvasCursor(insidePlot(state.pointer) ? hitCursor(state.pointer) : -1);
  }

  /** 拖动光标：只改这一条的像素锚点，另一条与时间轴都不动 */
  function moveCursor(i, localX) {
    setCursorX(i, localX);
    scheduleRender();
  }

  /* ---------------- 交互状态机 ---------------- */

  function resetInteraction() {
    interaction.mode = 'idle';
    interaction.index = -1;
    wrap.classList.remove('is-panning', 'is-boxing');
  }

  /** 绘图区局部像素（拖动平移允许越界，光标则夹在区内） */
  function localXOf(pt) {
    return pt.x - renderer.layout().left;
  }

  function beginPan(pt) {
    interaction.mode = 'pan';
    interaction.x0 = pt.x;
    interaction.anchorT = viewport.timeAtControl(pt.x);   // 按下时指针下的时间
    interaction.t0 = viewport.t0;
    wrap.classList.add('is-panning');
  }

  function beginCursor(i) {
    interaction.mode = 'cursor';
    interaction.index = i;
    state.lastCursor = i;
    setCanvasCursor(i);
  }

  /** 时间刻度条区域（绘图区下方），拖动可框选横轴宽度 */
  function onTimeAxisStrip(pt) {
    const L = renderer.layout();
    return pt.x >= L.left - 2 && pt.x <= L.right + 2 && pt.y > L.bottom && pt.y <= L.bottom + 28;
  }

  canvas.addEventListener('pointerdown', (evt) => {
    if (!state.channels.length) return;
    if (interaction.mode !== 'idle') return;      // 互斥：已有手势进行中
    const pt = localPoint(evt);
    const onAxis = onTimeAxisStrip(pt);
    if (!insidePlot(pt) && !onAxis) return;
    canvas.setPointerCapture(evt.pointerId);

    const L = renderer.layout();
    const wantBox = evt.button === 2 || evt.altKey;
    const ci = hitCursor(pt);

    if ((wantBox || state.boxTool) && !onAxis) {
      interaction.mode = 'box';
      state.boxSelect = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      wrap.classList.add('is-boxing');
    } else if (ci >= 0) {
      // 光标优先于平移（规格 7.1）
      beginCursor(ci);
    } else if (onAxis) {
      interaction.mode = 'timebox';
      state.boxSelect = { x0: pt.x, y0: L.top, x1: pt.x, y1: L.bottom };
      wrap.classList.add('is-boxing');
      canvas.style.cursor = 'col-resize';
    } else {
      beginPan(pt);
    }
    evt.preventDefault();
  });

  canvas.addEventListener('pointermove', (evt) => {
    const pt = localPoint(evt);
    state.pointer = pt;

    if (interaction.mode === 'idle') {
      const changed = setCanvasCursor(hitCursor(pt));
      if (state.hoverCursor < 0 && onTimeAxisStrip(pt)) canvas.style.cursor = 'col-resize';
      if (state.channels.length && insidePlot(pt)) {
        state.hover = state.showHover ? pt : null;
        scheduleRender();
      } else if (state.hover) {
        state.hover = null;
        scheduleRender();
      } else if (changed) {
        scheduleRender();
      }
      return;
    }

    if (interaction.mode === 'pan') {
      // 拖动平移：按下时指针下的时间固定在原像素处 → 位移与波形位移严格 1:1
      viewport.panToAnchor(interaction.anchorT, localXOf(pt));
      viewChanged();
    } else if (interaction.mode === 'cursor') {
      moveCursor(interaction.index, localXOf(pt));
    } else if (interaction.mode === 'box' || interaction.mode === 'timebox') {
      const L = renderer.layout();
      const b = state.boxSelect;
      state.boxSelect = interaction.mode === 'timebox'
        ? { x0: b.x0, y0: L.top, x1: pt.x, y1: L.bottom }
        : { x0: b.x0, y0: b.y0, x1: pt.x, y1: pt.y };
      scheduleRender();
    }
  });

  function endDrag(evt) {
    if (interaction.mode === 'box' || interaction.mode === 'timebox') {
      const b = state.boxSelect;
      if (b && Math.abs(b.x1 - b.x0) > 6) {
        const t0 = renderer.tOf(Math.min(b.x0, b.x1));
        const t1 = renderer.tOf(Math.max(b.x0, b.x1));
        state.boxSelect = null;
        setView(t0, t1);              // 框选/轴条拖选 → 直接显示该时间区间
      }
      state.boxSelect = null;
      if (interaction.mode === 'box' && state.boxTool) { state.boxTool = false; updateToolbar(); }
      scheduleRender();
    }
    resetInteraction();

    // 松手后按当前指针位置恢复光标样式，避免停在 grabbing / 错位
    if (evt && typeof evt.clientX === 'number') {
      const pt = localPoint(evt);
      state.pointer = pt;
      setCanvasCursor(insidePlot(pt) ? hitCursor(pt) : -1);
      scheduleRender();
    } else {
      setCanvasCursor(-1);
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    state.pointer = null;
    if (interaction.mode !== 'idle') return;      // 拖动中离开不打断手势
    setCanvasCursor(-1);
    if (state.hover) { state.hover = null; }
    scheduleRender();
  });
  // 窗口失焦 / 页面隐藏：清理交互状态，避免卡在拖动态
  window.addEventListener('blur', () => {
    if (interaction.mode === 'idle') return;
    resetInteraction();
    state.boxSelect = null;
    setCanvasCursor(-1);
    scheduleRender();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && interaction.mode !== 'idle') {
      resetInteraction();
      state.boxSelect = null;
      scheduleRender();
    }
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', (e) => { e.preventDefault(); fitView(); });

  /** 把各浏览器的 wheel delta 统一成「像素」并限制单次步进 */
  function wheelPixels(evt) {
    let d = evt.deltaY;
    if (evt.deltaMode === 1) d *= 16;        // 行模式（Firefox 等）
    else if (evt.deltaMode === 2) d *= 320;  // 页模式
    return Math.max(-320, Math.min(320, d));
  }

  canvas.addEventListener('wheel', (evt) => {
    if (!state.channels.length) return;
    const pt = localPoint(evt);
    // 只有指针在绘图区内才缩放（规格 3.2.9）
    if (!insidePlot(pt)) return;
    evt.preventDefault();
    state.pointer = pt;

    const d = wheelPixels(evt);
    if (!d) return;

    if (evt.shiftKey) {
      viewport.panPx(-d);                  // Shift+滚轮：平移
      viewChanged();
      return;
    }
    // 缩放中心 = 鼠标当前所在时间点；滚轮向上（deltaY<0）放大
    viewport.zoomAt(localXOf(pt), Math.exp(d * ZOOM_SENSITIVITY));
    viewChanged();
  }, { passive: false });

  canvas.addEventListener('touchstart', (evt) => {
    if (evt.touches.length === 2) {
      const a = evt.touches[0], b = evt.touches[1];
      const rect = canvas.getBoundingClientRect();
      const midX = (a.clientX + b.clientX) / 2 - rect.left - renderer.layout().left;
      interaction.mode = 'pinch';
      interaction.x0 = midX;
      interaction.dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (evt) => {
    if (interaction.mode === 'pinch' && evt.touches.length === 2) {
      evt.preventDefault();
      const a = evt.touches[0], b = evt.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (dist > 0 && interaction.dist > 0) {
        viewport.zoomAt(interaction.x0, interaction.dist / dist);
        viewChanged();
      }
      interaction.dist = dist;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    if (interaction.mode === 'pinch') resetInteraction();
  });

  /* 通道卡片 */
  $('#channelList').addEventListener('click', (evt) => {
    const card = evt.target.closest('.ch-card');
    if (!card) return;
    const ch = state.channels.find(c => c.id === card.dataset.id);
    if (!ch) return;
    const act = evt.target.dataset.act;

    if (act === 'toggle') {
      ch.visible = !ch.visible;
      refreshAll();
      return;
    }
    if (act === 'remove') {
      const i = state.channels.indexOf(ch);
      if (i >= 0) state.channels.splice(i, 1);
      if (state.activeId === ch.id) state.activeId = state.channels[0] ? state.channels[0].id : null;
      if (!state.channels.length) {
        viewport.t0 = -1e-3;
        viewport.dur = 2e-3;
        viewport.version++;
      }
      refreshAll();
      if (state.channels.length) scheduleMeasure();
      return;
    }
    if (act === 'vup' || act === 'vdown') {
      state.verticalMode = 'fixed';
      ch.userScale = Math.max(0.01, Math.min(1000, act === 'vup'
        ? ch.userScale / 1.25 : ch.userScale * 1.25));
      refreshAll();
      return;
    }
    state.activeId = ch.id;
    refreshAll();
  });

  $('#channelList').addEventListener('input', (evt) => {
    if (evt.target.dataset.act !== 'offset') return;
    const card = evt.target.closest('.ch-card');
    const ch = state.channels.find(c => c.id === card.dataset.id);
    if (!ch) return;
    ch.offsetDiv = Number(evt.target.value);
    scheduleRender();
  });

  /* 工具栏 */
  $$('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    if (state.mode === 'overlay' && state.verticalMode === 'auto') {
      state.verticalMode = 'fixed';
      toast('叠加视图按各通道 V/div 显示，可逐通道调整');
    }
    updateToolbar();
    renderChannelList();
    scheduleRender();
    updateInfo();
  }));

  $$('[data-vmode]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    state.verticalMode = btn.dataset.vmode;
    refreshAll();
  }));

  $('#btnZoomIn').addEventListener('click', () => zoomBy(1 / 1.6));
  $('#btnZoomOut').addEventListener('click', () => zoomBy(1.6));
  $('#btnFit').addEventListener('click', fitView);
  $('#btnBox').addEventListener('click', () => {
    state.boxTool = !state.boxTool;
    updateToolbar();
    toast(state.boxTool ? '框选模式：在波形区拖出矩形即可放大' : '已退出框选模式');
  });
  $('#btnCursor').addEventListener('click', () => {
    state.showCursors = !state.showCursors;
    if (state.showCursors) {
      // 像素锚点：默认落在绘图区 35% / 65% 处，之后就一直固定在这两个像素上
      const w = viewport.width;
      state.cursors.x1 = Math.round(w * 0.35);
      state.cursors.x2 = Math.round(w * 0.65);
      state.lastCursor = -1;
      toast('光标已开启：X1 / X2 锚定在像素位置，缩放平移时屏幕不动、时间与测量值实时重算');
    } else {
      setCanvasCursor(-1);
    }
    updateToolbar();
    updateCursorCard();
    scheduleRender();
  });
  $('#btnGrid').addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    updateToolbar();
    scheduleRender();
  });
  $('#btnHover').addEventListener('click', () => {
    state.showHover = !state.showHover;
    if (!state.showHover) state.hover = null;
    updateToolbar();
    scheduleRender();
  });

  /* 键盘 */
  document.addEventListener('keydown', (evt) => {
    const tag = (evt.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('#helpModal').hidden) {
      if (evt.key === 'Escape') $('#helpModal').hidden = true;
      return;
    }
    switch (evt.key) {
      case '+': case '=': zoomBy(1 / 1.6); evt.preventDefault(); break;
      case '-': case '_': zoomBy(1.6); evt.preventDefault(); break;
      case 'ArrowLeft': panByFraction(-0.08); evt.preventDefault(); break;
      case 'ArrowRight': panByFraction(0.08); evt.preventDefault(); break;
      case 'r': case 'R': fitView(); break;
      case 'c': case 'C': $('#btnCursor').click(); break;
      case 'g': case 'G': $('#btnGrid').click(); break;
      case 'h': case 'H': $('#btnHover').click(); break;
      case 'z': case 'Z': $('#btnBox').click(); break;
      case ' ':
        evt.preventDefault();
        state.mode = state.mode === 'stack' ? 'overlay' : 'stack';
        updateToolbar();
        scheduleRender();
        break;
      default:
        if (/^[1-8]$/.test(evt.key)) {
          const ch = state.channels[Number(evt.key) - 1];
          if (ch) { state.activeId = ch.id; refreshAll(); }
        }
    }
  });

  /* ============================ 文件 / 导出 ============================ */

  $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (evt) => {
    loadFiles(evt.target.files);
    evt.target.value = '';
  });
  $('#btnSample').addEventListener('click', () => {
    const hasReal = state.channels.some(c => !c.isSample && !c.isDemo);
    if (hasReal && !window.confirm('载入示例数据将替换当前已加载的通道，继续？')) return;
    loadSamples(false);
  });
  $('#btnClear').addEventListener('click', () => {
    if (!state.channels.length) return;
    state.channels = [];
    state.activeId = null;
    state.hover = null;
    updateMeasurements();
    updateCursorCard();
    updateInfo();
    renderChannelList();
    scheduleRender();
    updateStatus();
  });

  wrap.addEventListener('dragenter', (evt) => {
    evt.preventDefault();
    dragDepth++;
    wrap.classList.add('dragover');
  });
  wrap.addEventListener('dragover', (evt) => evt.preventDefault());
  wrap.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; wrap.classList.remove('dragover'); }
  });
  wrap.addEventListener('drop', (evt) => {
    evt.preventDefault();
    dragDepth = 0;
    wrap.classList.remove('dragover');
    loadFiles(evt.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  $('#btnExportPng').addEventListener('click', () => {
    if (!state.channels.length) { toast('请先加载波形', true); return; }
    const savedHover = state.hover;
    state.hover = null;
    renderer.draw(state);
    canvas.toBlob((blob) => {
      if (blob) download(blob, 'tekscope-' + stamp() + '.png');
      state.hover = savedHover;
      scheduleRender();
      toast('已导出 PNG 截图');
    }, 'image/png');
  });

  $('#btnExportCsv').addEventListener('click', () => {
    if (!state.channels.length) { toast('请先加载波形', true); return; }
    const visible = state.channels.filter(c => c.visible && c.indexRange(viewport.t0, viewport.t1));
    if (!visible.length) { toast('当前视窗内没有数据', true); return; }
    const MAX_ROWS = 200000;
    const lines = [];
    const numOut = (v) => Number.isFinite(v) ? Number(v.toPrecision(9)) : '';

    // 若各通道时间基一致，导出宽表；否则按通道分块
    const sameBase = visible.every(c =>
      Math.abs(c.startTime - visible[0].startTime) < c.xIncrement * 0.5 &&
      Math.abs(c.xIncrement - visible[0].xIncrement) < c.xIncrement * 1e-6);

    if (sameBase) {
      const ref = visible[0];
      const r = ref.indexRange(viewport.t0, viewport.t1);
      const total = r[1] - r[0] + 1;
      const stride = Math.max(1, Math.ceil(total / MAX_ROWS));
      lines.push(['time_s'].concat(visible.map(c => c.label + '_' + c.yUnit)).join(','));
      for (let i = r[0]; i <= r[1]; i += stride) {
        const t = ref.startTime + i * ref.xIncrement;
        const row = [Number(t.toPrecision(12))];
        for (const c of visible) {
          const k = Math.round((t - c.startTime) / c.xIncrement);
          row.push(k >= 0 && k < c.sampleCount ? numOut((c.raw[k] - c.yOff) * c.yMult + c.yZero) : '');
        }
        lines.push(row.join(','));
      }
    } else {
      lines.push('channel,time_s,value');
      for (const c of visible) {
        const r = c.indexRange(viewport.t0, viewport.t1);
        const total = r[1] - r[0] + 1;
        const stride = Math.max(1, Math.ceil(total / (MAX_ROWS / visible.length)));
        for (let i = r[0]; i <= r[1]; i += stride) {
          lines.push(c.label + ',' + Number((c.startTime + i * c.xIncrement).toPrecision(12)) + ',' +
            numOut((c.raw[i] - c.yOff) * c.yMult + c.yZero));
        }
      }
    }
    download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), 'tekscope-' + stamp() + '.csv');
    toast('已导出可视区间数据（' + (lines.length - 1).toLocaleString() + ' 行）');
  });

  /* 主题 / 帮助 */
  $('#btnTheme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = state.theme;
    localStorage.setItem('tekscope-theme', state.theme);
    renderChannelList();
    updateMeasurements();
    scheduleRender();
  });

  $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
  $('#btnCloseHelp').addEventListener('click', () => { $('#helpModal').hidden = true; });
  $('#helpModal').addEventListener('click', (evt) => {
    if (evt.target.id === 'helpModal') $('#helpModal').hidden = true;
  });

  /* 尺寸变化：重排画布位图后重新同步绘图区几何（光标锚点按比例重排） */
  const ro = new ResizeObserver(() => {
    renderer.resize();
    syncGeometry();
    scheduleRender();
  });
  ro.observe(wrap);

  /* 启动 */
  renderChannelList();
  updateStatus();
  scheduleRender();

  // 调试 / 自动化测试出口（不影响正常使用）
  window.__tekScope = {
    state, renderer, viewport,
    fitView, zoomBy, panByFraction, setView, hitCursor,
    interaction,                        // 交互状态机（idle/pan/cursor/...）
    layout: () => renderer.layout(),
    measurements: () => TekMeasure.cursorMeasurements(state),
    // 测试用：把光标放到指定像素 / 取光标像素与时间
    setCursorPx: (i, x) => { setCursorX(i, x); scheduleRender(); },
    cursorPx: (i) => cursorX(i),
    cursorTime: (i) => viewport.timeAt(cursorX(i))
  };

  // 首屏自动尝试加载随附示例（file:// 打开时 fetch 会失败，静默跳过）
  if (!autoDemoTried) {
    autoDemoTried = true;
    loadSamples(true);
  }
})();

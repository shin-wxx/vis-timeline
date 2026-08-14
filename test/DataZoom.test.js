import assert from "node:assert";

import jsdom_global from "jsdom-global";

import DataZoom from "../lib/timeline/component/DataZoom.js";
import TimeStep from "../lib/timeline/TimeStep.js";

const internals = {};

/**
 * Build a mock body for DataZoom with controllable range and event emitter.
 * @param {number} start  Range start (ms)
 * @param {number} end    Range end (ms)
 * @param {Object} [utilOverrides] Optional util overrides (e.g. getTimeStep)
 * @returns {Object} mock body
 */
function buildMockBody(start = 0, end = 1000, utilOverrides = {}) {
  const listeners = {};
  const range = {
    start,
    end,
    getRange() {
      return { start: this.start, end: this.end };
    },
  };
  return {
    range,
    dom: {
      top: document.createElement("div"),
      bottom: document.createElement("div"),
      center: { clientWidth: 900 },
    },
    domProps: {
      center: { width: 900 },
    },
    hiddenDates: [],
    util: {
      getScale: () => undefined,
      getStep: () => undefined,
      // 默认返回 undefined → DataZoom 走回退自动计算路径；
      // 测试可覆盖为 () => configuredTimeStep 以模拟 timeAxis.step
      getTimeStep: () => undefined,
      // 模拟主轴 toScreen：基于 center 宽度(900) 映射，与 track 宽度不同，
      // 用以验证 _renderTicks 使用 toScreen（主轴尺度）而非 track.clientWidth。
      toScreen: (time) =>
        ((time - range.start) / (range.end - range.start)) * 900,
      ...utilOverrides,
    },
    emitter: {
      on(evt, cb) {
        (listeners[evt] = listeners[evt] || []).push(cb);
      },
      off() {},
      emit(evt, ...args) {
        (listeners[evt] || []).forEach((cb) => cb(...args));
      },
    },
    _listeners: listeners,
    _setRange(s, e) {
      range.start = s;
      range.end = e;
    },
  };
}

/**
 * Mock DOM dimensions (jsdom doesn't do layout, clientWidth is read-only).
 * @param {DataZoom} dz
 * @param {number} width
 */
function mockTrackDimensions(dz, width = 200) {
  Object.defineProperty(dz.dom.track, "clientWidth", {
    configurable: true,
    value: width,
  });
  dz.dom.track.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width,
    height: 40,
    right: width,
    bottom: 40,
  });
}

/**
 * Build a TimeStep configured like the main TimeAxis's step would be after a
 * redraw over the given range, with a forced scale/step. Used to simulate
 * body.util.getTimeStep() returning me.timeAxis.step.
 * @param {number} start  ms
 * @param {number} end    ms
 * @param {string} scale  e.g. "hour" | "day" | "week"
 * @param {number} step   step size
 * @param {Object} [opts] extra TimeStep options (showMajorLabels, showWeekScale)
 * @returns {TimeStep}
 */
function buildAxisStep(start, end, scale, step, opts = {}) {
  const ts = new TimeStep(new Date(start), new Date(end), undefined, [], opts);
  ts.setScale({ scale, step });
  return ts;
}

describe("DataZoom", () => {
  before(() => {
    internals.jsdom = jsdom_global({ pretendToBeVisual: true });
    global["Element"] = window.Element;

    // Controllable rAF: callbacks queued, flushed manually
    internals.rafQueue = [];
    global["requestAnimationFrame"] = (cb) => {
      internals.rafQueue.push(cb);
      return internals.rafQueue.length;
    };
    internals.flushRaf = () => {
      const q = internals.rafQueue;
      internals.rafQueue = [];
      q.forEach((cb) => cb());
    };
  });

  after(() => {
    internals.jsdom();
  });

  afterEach(() => {
    internals.rafQueue = [];
  });

  // ======================== 基础功能 ========================

  describe("constructor & defaults", () => {
    it("should initialize with default ratios [0, 1]", () => {
      const body = buildMockBody(100, 200);
      const dz = new DataZoom(body, { enabled: true });
      assert.strictEqual(dz.filterStartRatio, 0);
      assert.strictEqual(dz.filterEndRatio, 1);
    });

    it("should cache initial visible window from body.range", () => {
      const body = buildMockBody(100, 200);
      const dz = new DataZoom(body, { enabled: true });
      assert.strictEqual(dz._lastVisStart, 100);
      assert.strictEqual(dz._lastVisEnd, 200);
    });

    it("should register rangechange listener", () => {
      const body = buildMockBody(100, 200);
      new DataZoom(body, { enabled: true });
      assert(
        body._listeners["rangechange"] &&
          body._listeners["rangechange"].length > 0,
        "rangechange listener registered",
      );
    });
  });

  // ======================== getFilterRange ========================

  describe("getFilterRange", () => {
    it("should return full visible window when ratios are [0, 1]", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      const fr = dz.getFilterRange();
      assert.strictEqual(fr.start, 1000);
      assert.strictEqual(fr.end, 2000);
    });

    it("should return sub-range based on ratios", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.3;
      dz.filterEndRatio = 0.7;
      const fr = dz.getFilterRange();
      assert.strictEqual(fr.start, 1300);
      assert.strictEqual(fr.end, 1700);
    });

    it("should update when visible window changes (ratio follows)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.25;
      dz.filterEndRatio = 0.75;
      // Change visible window
      body._setRange(0, 4000);
      const fr = dz.getFilterRange();
      assert.strictEqual(fr.start, 1000);
      assert.strictEqual(fr.end, 3000);
    });
  });

  // ======================== 缩放锚定逻辑 ========================

  describe("zoom anchoring (_onRangeChange)", () => {
    it("pan: should keep ratios unchanged when span is same", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.3;
      dz.filterEndRatio = 0.7;

      // Pan: same span, different position
      body._setRange(1500, 2500);
      body.emitter.emit("rangechange", { start: 1500, end: 2500 });

      assert.strictEqual(dz.filterStartRatio, 0.3);
      assert.strictEqual(dz.filterEndRatio, 0.7);
    });

    it("zoom out: should preserve filter absolute range, shrink ratios", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.3;
      dz.filterEndRatio = 0.7;
      // Filter absolute range: [1300, 1700]

      // Zoom out: expand window 2x
      body._setRange(500, 2500);
      body.emitter.emit("rangechange", { start: 500, end: 2500 });

      // Ratios should shrink (filter abs stays [1300, 1700])
      const fr = dz.getFilterRange();
      assert.strictEqual(fr.start, 1300);
      assert.strictEqual(fr.end, 1700);
      // Ratio span should be 0.2 (was 0.4), since window doubled
      assert.ok(
        Math.abs(dz.filterEndRatio - dz.filterStartRatio - 0.2) < 0.01,
        "ratio span should halve",
      );
    });

    it("zoom in: should correct to [0,1] when visible ⊆ filter", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.2;
      dz.filterEndRatio = 0.8;
      // Filter absolute range: [1200, 1800]

      // Zoom in: visible window [1300, 1700] is inside filter [1200, 1800]
      body._setRange(1300, 1700);
      body.emitter.emit("rangechange", { start: 1300, end: 1700 });

      assert.strictEqual(dz.filterStartRatio, 0);
      assert.strictEqual(dz.filterEndRatio, 1);
    });

    it("zoom in: should preserve filter abs when visible ⊄ filter", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.3;
      dz.filterEndRatio = 0.7;
      // Filter absolute range: [1300, 1700]

      // Zoom in: visible [1100, 1500] is NOT inside filter [1300, 1700]
      // (1100 < 1300, so visible ⊄ filter)
      body._setRange(1100, 1500);
      body.emitter.emit("rangechange", { start: 1100, end: 1500 });

      // Filter absolute range should be preserved (clamped to visible)
      const fr = dz.getFilterRange();
      // oldFStart=1300, oldFEnd=1700, newVis=[1100,1500], span=400
      // r0 = (1300-1100)/400 = 0.5, r1 = (1700-1100)/400 = 1.5 → clamped to 1
      assert.ok(Math.abs(fr.start - 1300) < 1, "filter start preserved");
      assert.ok(Math.abs(fr.end - 1500) < 1, "filter end clamped to visible");
    });

    it("zoom out: should reset when filter mostly outside visible", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.45;
      dz.filterEndRatio = 0.55;
      // Filter absolute range: [1450, 1550], span=100

      // Zoom out massively: window [0, 100000]
      body._setRange(0, 100000);
      body.emitter.emit("rangechange", { start: 0, end: 100000 });

      // r0 = 1450/100000 = 0.0145, r1 = 1550/100000 = 0.0155
      // span = 0.001 < 0.02 → reset to [0, 1]
      assert.strictEqual(dz.filterStartRatio, 0);
      assert.strictEqual(dz.filterEndRatio, 1);
    });

    it("should handle multiple rapid zoom steps correctly", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.6;
      // Filter abs: [1400, 1600]

      // Step 1: zoom out 2x
      body._setRange(500, 2500);
      body.emitter.emit("rangechange", { start: 500, end: 2500 });
      const fr1 = dz.getFilterRange();
      assert.ok(Math.abs(fr1.start - 1400) < 1, "step1 filter start");
      assert.ok(Math.abs(fr1.end - 1600) < 1, "step1 filter end");

      // Step 2: zoom out again 2x
      body._setRange(0, 3000);
      body.emitter.emit("rangechange", { start: 0, end: 3000 });
      const fr2 = dz.getFilterRange();
      assert.ok(Math.abs(fr2.start - 1400) < 1, "step2 filter start");
      assert.ok(Math.abs(fr2.end - 1600) < 1, "step2 filter end");
    });
  });

  // ======================== 性能优化回归测试 ========================

  describe("performance: rAF throttle for _renderTicks", () => {
    it("should not call _renderTicks synchronously during rangechange", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw(); // ensure DOM exists

      let tickCallCount = 0;
      const origRenderTicks = dz._renderTicks.bind(dz);
      dz._renderTicks = () => {
        tickCallCount++;
        origRenderTicks();
      };

      // Trigger multiple rangechange events without flushing rAF
      body._setRange(1100, 2100);
      body.emitter.emit("rangechange", { start: 1100, end: 2100 });
      body._setRange(1200, 2200);
      body.emitter.emit("rangechange", { start: 1200, end: 2200 });
      body._setRange(1300, 2300);
      body.emitter.emit("rangechange", { start: 1300, end: 2300 });

      // _renderTicks should NOT have been called yet (queued in rAF)
      assert.strictEqual(tickCallCount, 0);

      // Flush rAF — should call _renderTicks exactly once
      internals.flushRaf();
      assert.strictEqual(tickCallCount, 1);
    });

    it("should coalesce multiple rangechange into one tick render", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      let tickCallCount = 0;
      const origRenderTicks = dz._renderTicks.bind(dz);
      dz._renderTicks = () => {
        tickCallCount++;
        origRenderTicks();
      };

      // 5 rapid rangechange events
      for (let i = 1; i <= 5; i++) {
        body._setRange(1000 + i * 100, 2000 + i * 100);
        body.emitter.emit("rangechange", {
          start: 1000 + i * 100,
          end: 2000 + i * 100,
        });
      }

      internals.flushRaf();
      assert.strictEqual(
        tickCallCount,
        1,
        "only one tick render after coalesce",
      );
    });
  });

  describe("performance: no datazoomfilterchange emit during rangechange", () => {
    it("should NOT emit datazoomfilterchange during rangechange (zoom)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      let emitCount = 0;
      const origEmit = body.emitter.emit.bind(body.emitter);
      body.emitter.emit = (evt, ...args) => {
        if (evt === "datazoomfilterchange") emitCount++;
        origEmit(evt, ...args);
      };

      // Zoom out — ratio changes, but should NOT emit
      body._setRange(500, 2500);
      body.emitter.emit("rangechange", { start: 500, end: 2500 });

      assert.strictEqual(
        emitCount,
        0,
        "no datazoomfilterchange during rangechange",
      );

      // Flush rAF — still no emit (rAF only for ticks, not filter)
      internals.flushRaf();
      assert.strictEqual(
        emitCount,
        0,
        "no datazoomfilterchange after rAF flush",
      );
    });

    it("should NOT emit datazoomfilterchange during pan", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      let emitCount = 0;
      const origEmit = body.emitter.emit.bind(body.emitter);
      body.emitter.emit = (evt, ...args) => {
        if (evt === "datazoomfilterchange") emitCount++;
        origEmit(evt, ...args);
      };

      // Pan (same span) — ratio unchanged, no emit
      body._setRange(1500, 2500);
      body.emitter.emit("rangechange", { start: 1500, end: 2500 });

      assert.strictEqual(emitCount, 0, "no emit during pan");
    });
  });

  describe("performance: direct emit on user interaction", () => {
    it("should emit datazoomfilterchange on _onMouseMove (drag)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true, filterData: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      let emitCount = 0;
      body.emitter.emit = (evt) => {
        if (evt === "datazoomfilterchange") emitCount++;
      };

      // Simulate drag start
      dz._startDrag("move", { clientX: 100, preventDefault: () => {} });

      // Simulate mouse move (10% of track width)
      dz._onMouseMove({ clientX: 100 + 20 });

      assert.ok(emitCount > 0, "emitted on drag move");
    });

    it("should emit datazoomfilterchange on _onWheel", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true, zoomOnScroll: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      let emitCount = 0;
      body.emitter.emit = (evt) => {
        if (evt === "datazoomfilterchange") emitCount++;
      };

      dz._onWheel({
        deltaY: -100,
        clientX: 100,
        preventDefault: () => {},
      });

      assert.ok(emitCount > 0, "emitted on wheel");
    });

    it("should emit datazoomfilterchange on _onTrackClick", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      let emitCount = 0;
      body.emitter.emit = (evt) => {
        if (evt === "datazoomfilterchange") emitCount++;
      };

      // Click on track (not on window/handle)
      dz._onTrackClick({
        target: dz.dom.track,
        clientX: 50,
      });

      assert.ok(emitCount > 0, "emitted on track click");
    });
  });

  // ======================== 刻度对齐 ========================

  describe("_renderTicks: scale alignment with TimeAxis", () => {
    it("should reuse TimeAxis full step config via body.util.getTimeStep", () => {
      const dayMs = 86400000;
      const start = new Date("2025-01-01T00:00:00").getTime();
      const end = start + dayMs; // 24 hours
      const axisStep = buildAxisStep(start, end, "hour", 1);
      const body = buildMockBody(start, end, {
        getTimeStep: () => axisStep,
      });
      const dz = new DataZoom(body, { enabled: true, showLabels: false });
      dz.redraw();
      mockTrackDimensions(dz, 480);

      dz._renderTicks();

      // With scale=hour, step=1 over 24h, expect ~25 ticks (0h through 24h)
      const ticks = dz.dom.labels.querySelectorAll(".vis-data-zoom-grid");
      assert.ok(
        ticks.length >= 23 && ticks.length <= 25,
        `expected ~24 hourly ticks, got ${ticks.length}`,
      );
    });

    it("should produce different tick count for different scales", () => {
      const dayMs = 86400000;
      const start = new Date("2025-01-01T00:00:00").getTime();
      const end = start + dayMs * 7; // 7 days

      // scale = "day", step = 1 → ~8 ticks (7 days + endpoints)
      const axisDay = buildAxisStep(start, end, "day", 1);
      const bodyDay = buildMockBody(start, end, {
        getTimeStep: () => axisDay,
      });
      const dzDay = new DataZoom(bodyDay, { enabled: true, showLabels: false });
      dzDay.redraw();
      mockTrackDimensions(dzDay, 480);
      dzDay._renderTicks();
      const ticksDay = dzDay.dom.labels.querySelectorAll(".vis-data-zoom-grid");

      // scale = "hour", step = 1 → ~169 ticks but capped at 100
      const axisHour = buildAxisStep(start, end, "hour", 1);
      const bodyHour = buildMockBody(start, end, {
        getTimeStep: () => axisHour,
      });
      const dzHour = new DataZoom(bodyHour, {
        enabled: true,
        showLabels: false,
      });
      dzHour.redraw();
      mockTrackDimensions(dzHour, 480);
      dzHour._renderTicks();
      const ticksHour = dzHour.dom.labels.querySelectorAll(
        ".vis-data-zoom-grid",
      );

      assert.ok(
        ticksDay.length < ticksHour.length,
        `day scale (${ticksDay.length} ticks) should have fewer ticks than hour scale (${ticksHour.length} ticks)`,
      );
    });

    it("should fall back to auto-scale when getTimeStep returns undefined", () => {
      const start = new Date("2025-01-01T00:00:00").getTime();
      const end = start + 86400000 * 30; // 30 days
      const body = buildMockBody(start, end); // getTimeStep returns undefined
      const dz = new DataZoom(body, { enabled: true, showLabels: false });
      dz.redraw();
      mockTrackDimensions(dz, 480);

      // Should not throw, should produce some ticks
      dz._renderTicks();
      const ticks = dz.dom.labels.querySelectorAll(".vis-data-zoom-grid");
      assert.ok(ticks.length > 0, "fallback auto-scale produced ticks");
    });

    it("should position ticks via toScreen matching the axis mapping", () => {
      // 核心对齐回归：DataZoom 刻度的时间戳与主轴 TimeStep 迭代一致，且位置由
      // body.util.toScreen（主轴尺度，基于 center 宽度）决定，而非 track 宽度。
      // track 宽度(600) 与 center 宽度(900) 故意不同，以验证确实走 toScreen。
      const start = new Date("2025-01-01T00:00:00").getTime();
      const end = start + 86400000 * 3; // 3 days
      const axisStep = buildAxisStep(start, end, "day", 1, {
        showMajorLabels: true,
      });
      const body = buildMockBody(start, end, {
        getTimeStep: () => axisStep,
      });
      const dz = new DataZoom(body, { enabled: true, showLabels: false });
      dz.redraw();
      mockTrackDimensions(dz, 600);
      dz._renderTicks();

      // 重新用同样的 axisStep 配置独立迭代，收集时间戳
      const ref = new TimeStep(
        new Date(start),
        new Date(end),
        undefined,
        axisStep.hiddenDates || [],
        axisStep.options,
      );
      ref.setMoment(axisStep.moment);
      if (axisStep.format) ref.setFormat(axisStep.format);
      ref.setScale({ scale: axisStep.scale, step: axisStep.step });
      ref.start();
      const expected = [];
      while (ref.hasNext() && expected.length < 100) {
        expected.push(ref.getCurrent().valueOf());
        ref.next();
      }

      const tickEls = dz.dom.labels.querySelectorAll(".vis-data-zoom-grid");
      assert.strictEqual(
        tickEls.length,
        expected.length,
        "tick count matches axis step iteration",
      );

      expected.forEach((t, i) => {
        const x = body.util.toScreen(t); // 与主轴相同的映射
        // grid 线定位与 TimeAxis._repaintMinorLine 一致：translate(toScreen - lineWidth/2)
        const expected = x - 0.5; // lineWidth = 1
        const transform = tickEls[i].style.transform;
        const match = transform.match(/translate\((-?[\d.]+)px/);
        const actual = match ? parseFloat(match[1]) : NaN;
        assert.ok(
          Math.abs(actual - expected) < 0.01,
          `grid ${i} at ${actual}px expected ${expected}px (time ${t})`,
        );
      });
    });
  });

  // ======================== _renderWindow ========================

  describe("_renderWindow", () => {
    it("should position window based on ratios", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      dz.filterStartRatio = 0.25;
      dz.filterEndRatio = 0.75;
      dz._renderWindow();

      assert.strictEqual(dz.dom.window.style.left, "25%");
      assert.strictEqual(dz.dom.window.style.width, "50%");
    });

    it("should enforce minimum width", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      dz.filterStartRatio = 0.495;
      dz.filterEndRatio = 0.498;
      dz._renderWindow();

      // Width = 0.3% < 0.5% → should be clamped to 0.5%
      assert.strictEqual(dz.dom.window.style.width, "0.5%");
    });
  });

  // ======================== 拖动逻辑 ========================

  describe("drag logic (_onMouseMove)", () => {
    it("move: should shift both ratios by delta", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.3;
      dz.filterEndRatio = 0.7;

      dz._startDrag("move", { clientX: 100, preventDefault: () => {} });
      // Move right by 10% of track width = 20px
      dz._onMouseMove({ clientX: 120 });

      assert.ok(
        Math.abs(dz.filterStartRatio - 0.4) < 0.01,
        "start ratio shifted by 0.1",
      );
      assert.ok(
        Math.abs(dz.filterEndRatio - 0.8) < 0.01,
        "end ratio shifted by 0.1",
      );
    });

    it("move: should clamp to [0, 1] boundaries", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.8;
      dz.filterEndRatio = 0.9;

      dz._startDrag("move", { clientX: 100, preventDefault: () => {} });
      // Move right by 50% = 100px — should clamp
      dz._onMouseMove({ clientX: 200 });

      assert.strictEqual(dz.filterEndRatio, 1, "end clamped to 1");
      assert.ok(dz.filterStartRatio >= 0, "start >= 0");
    });

    it("left handle: should not cross right handle (MIN_SPAN)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.5;
      dz.filterEndRatio = 0.6;

      dz._startDrag("left", { clientX: 100, preventDefault: () => {} });
      // Move right by 50% = 100px — should be clamped by MIN_SPAN
      dz._onMouseMove({ clientX: 200 });

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(span >= 0.02, `left handle respects MIN_SPAN (span=${span})`);
    });

    it("right handle: should not cross left handle (MIN_SPAN)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.5;

      dz._startDrag("right", { clientX: 100, preventDefault: () => {} });
      // Move left by 50% = 100px — should be clamped by MIN_SPAN
      dz._onMouseMove({ clientX: 0 });

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(span >= 0.02, `right handle respects MIN_SPAN (span=${span})`);
    });
  });

  // ======================== 滚轮缩放选区 ========================

  describe("_onWheel", () => {
    it("should narrow filter on scroll up (deltaY < 0)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true, zoomOnScroll: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0;
      dz.filterEndRatio = 1;

      // Scroll up at center (clientX=100 = 50% of 200px track)
      dz._onWheel({
        deltaY: -100,
        clientX: 100,
        preventDefault: () => {},
      });

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(span < 1, "filter narrowed on scroll up");
    });

    it("should widen filter on scroll down (deltaY > 0)", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true, zoomOnScroll: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.6;

      dz._onWheel({
        deltaY: 100,
        clientX: 100,
        preventDefault: () => {},
      });

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(span > 0.2, "filter widened on scroll down");
    });

    it("should not shrink below MIN_SPAN", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true, zoomOnScroll: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.49;
      dz.filterEndRatio = 0.51;

      // Multiple scroll up events
      for (let i = 0; i < 10; i++) {
        dz._onWheel({
          deltaY: -100,
          clientX: 100,
          preventDefault: () => {},
        });
      }

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(span >= 0.02, `MIN_SPAN enforced (span=${span})`);
    });
  });

  // ======================== 轨道点击 ========================

  describe("_onTrackClick", () => {
    it("should center filter on click position, preserving span", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.6;
      const originalSpan = 0.2;

      // Click at center (clientX=100 = 50% of 200px track)
      dz._onTrackClick({
        target: dz.dom.track,
        clientX: 100,
      });

      const span = dz.filterEndRatio - dz.filterStartRatio;
      assert.ok(
        Math.abs(span - originalSpan) < 0.01,
        "span preserved on click",
      );
      // Center should be at 0.5
      const center = (dz.filterStartRatio + dz.filterEndRatio) / 2;
      assert.ok(Math.abs(center - 0.5) < 0.05, "filter centered on click");
    });

    it("should clamp when clicking near left edge", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      mockTrackDimensions(dz, 200);

      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.6;

      // Click at left edge (clientX=0)
      dz._onTrackClick({
        target: dz.dom.track,
        clientX: 0,
      });

      assert.strictEqual(dz.filterStartRatio, 0, "start clamped to 0");
    });

    it("should ignore clicks on window/handle elements", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();

      dz.filterStartRatio = 0.4;
      dz.filterEndRatio = 0.6;
      const beforeR0 = dz.filterStartRatio;
      const beforeR1 = dz.filterEndRatio;

      dz._onTrackClick({
        target: dz.dom.window,
        clientX: 0,
      });

      assert.strictEqual(dz.filterStartRatio, beforeR0, "ignored window click");
      assert.strictEqual(dz.filterEndRatio, beforeR1, "ignored window click");
    });
  });

  // ======================== enabled/disabled ========================

  describe("enabled / disabled", () => {
    it("should not create DOM when disabled", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: false });
      dz.redraw();
      assert.strictEqual(dz.dom.container, undefined);
    });

    it("should remove DOM when disabled after being enabled", () => {
      const body = buildMockBody(1000, 2000);
      const dz = new DataZoom(body, { enabled: true });
      dz.redraw();
      assert.ok(dz.dom.container, "DOM created when enabled");

      dz.setOptions({ enabled: false });
      dz.redraw();
      assert.strictEqual(
        dz.dom.container,
        undefined,
        "DOM removed when disabled",
      );
    });
  });
});

import util from "../../util.js";
import TimeStep from "../TimeStep.js";
import Component from "./Component.js";

/**
 * DataZoom - 可见窗口内的二次过滤选择器组件。
 *
 * 在时间轴顶部或底部渲染一条可交互的导航条，其轨道代表主时间轴的**当前
 * 可见窗口**（range.start/end），随时间轴缩放/平移实时更新。用户可拖动
 * 两端把手或选窗来调整**过滤区间**（以比例存储），选区外的数据被过滤。
 * 交互只改变过滤比例，不移动时间轴；时间轴可独立缩放/平移。
 *
 * 时间轴缩放时的选窗行为：
 * - **平移**：ratio 不变，选窗按比例跟随可见窗口。
 * - **缩小**：选窗锚定到绝对时间不变，ratio 自动缩小（选窗在轨道上变窄）。
 * - **放大**：选窗锚定到绝对时间不变；若可见窗口完全落入选窗绝对范围内，
 *   修正选窗 = 可见窗口（ratio = [0, 1]），避免选窗超出可见范围。
 *
 * @extends Component
 */
class DataZoom extends Component {
  /**
   * @param {{range: Range, dom: Object, domProps: Object, emitter: Object}} body
   * @param {Object} [options] See DataZoom.setOptions for the available options.
   * @constructor DataZoom
   */
  constructor(body, options) {
    super();
    this.body = body;

    this.defaultOptions = {
      enabled: false,
      height: 40,
      position: "bottom", // 'bottom' | 'top'
      showLabels: true,
      zoomOnScroll: true,
      filterData: true,
      handleWidth: 8,
    };
    this.options = util.extend({}, this.defaultOptions);

    this.dom = {};
    this._dragState = null;

    // 过滤选区在可见窗口内的比例位置 [0, 1]，默认覆盖整个可见窗口（不过滤）
    this.filterStartRatio = 0;
    this.filterEndRatio = 1;

    // 缓存上一次的可见窗口，用于区分缩放/平移并保持选窗锚定到绝对时间。
    // 初始化为当前可见窗口（DataZoom 可能在初始 rangechange 之后才创建）
    const initRange = this.body.range.getRange();
    this._lastVisStart = initRange.start;
    this._lastVisEnd = initRange.end;

    // rAF 节流标志：避免 rangechange 高频触发时重复重建 tick DOM
    this._tickRafPending = false;

    // rAF 节流标志：避免高频触发时重复遍历 item DOM 应用强调/弱化样式
    this._emphasisRafPending = false;

    // 预绑定事件处理器引用（便于 destroy 时移除）
    this._bindedOnMouseMove = this._onMouseMove.bind(this);
    this._bindedOnMouseUp = this._onMouseUp.bind(this);
    this._bindedOnRangeChange = this._onRangeChange.bind(this);

    this.setOptions(options);

    // 监听 range 变化，同步选窗位置（非自身拖动时）
    this.body.emitter.on("rangechange", this._bindedOnRangeChange);
  }

  /**
   * Set options for the DataZoom component.
   * @param {Object} options
   */
  setOptions(options) {
    if (options) {
      util.extend(this.options, options);
    }
  }

  /**
   * Repaint the component. Called automatically by Core._redraw().
   * @return {boolean} Returns true if the component is resized
   */
  redraw() {
    if (!this.options.enabled) {
      // 禁用时若 DOM 已存在则移除
      if (this.dom.container && this.dom.container.parentNode) {
        this.dom.container.parentNode.removeChild(this.dom.container);
      }
      this.dom = {};
      // 禁用时清除残留的强调/弱化样式
      this._clearItemEmphasis();
      return false;
    }

    this._ensureDom();
    this._renderTicks();
    this._renderWindow();
    // 重新应用 item 强调/弱化（ItemSet 在本组件之前 redraw，item DOM 已就绪）
    this._scheduleItemEmphasis();
    return false;
  }

  // ======================== DOM 创建 ========================

  /**
   * 懒创建 DOM 结构并挂载到 body.dom.bottom 或 body.dom.top
   * @private
   */
  _ensureDom() {
    if (this.dom.container) return;

    const container = document.createElement("div");
    container.className = "vis-data-zoom-container";
    container.style.height = `${this.options.height}px`;

    const track = document.createElement("div");
    track.className = "vis-data-zoom-track";

    const labels = document.createElement("div");
    labels.className = "vis-data-zoom-labels";

    const win = document.createElement("div");
    win.className = "vis-data-zoom-window";

    const handleL = document.createElement("div");
    handleL.className = "vis-data-zoom-handle vis-data-zoom-handle-left";

    const handleR = document.createElement("div");
    handleR.className = "vis-data-zoom-handle vis-data-zoom-handle-right";

    win.appendChild(handleL);
    win.appendChild(handleR);
    track.appendChild(labels);
    track.appendChild(win);
    container.appendChild(track);

    // 事件绑定
    win.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("vis-data-zoom-handle")) return;
      this._startDrag("move", e);
    });
    handleL.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      this._startDrag("left", e);
    });
    handleR.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      this._startDrag("right", e);
    });
    track.addEventListener("mousedown", (e) => this._onTrackClick(e));

    if (this.options.zoomOnScroll) {
      container.addEventListener("wheel", (e) => this._onWheel(e), {
        passive: false,
      });
    }

    // 隔离 dataZoom 上的交互，阻止起始事件冒泡到 body.dom.root。
    // 主时间轴的 hammer 平移/缩放监听挂在 root 上，若不拦截，拖动选窗时
    // hammer 会同时触发平移（方向与 dataZoom 相反），导致选窗视觉反转。
    ["mousedown", "pointerdown", "touchstart"].forEach((evt) => {
      container.addEventListener(evt, (e) => e.stopPropagation());
    });

    this.dom = {
      container,
      track,
      labels,
      window: win,
      handleLeft: handleL,
      handleRight: handleR,
    };

    // 挂载到 timeline 的 top/bottom 面板
    const host =
      this.options.position === "top"
        ? this.body.dom.top
        : this.body.dom.bottom;
    if (host) {
      host.appendChild(container);
    }
  }

  // ======================== 过滤区间与坐标换算 ========================

  /**
   * 返回过滤选区的绝对时间范围（基于当前可见窗口 + 比例）。
   * 随可见窗口变化自动按比例跟随（比例不变，绝对范围随可见窗口伸缩/平移）。
   * @return {{start: number, end: number}} 时间戳(ms)
   */
  getFilterRange() {
    const range = this.body.range.getRange();
    const span = range.end - range.start;
    return {
      start: range.start + this.filterStartRatio * span,
      end: range.start + this.filterEndRatio * span,
    };
  }

  /**
   * 将时间戳转换为轨道上的百分比位置 (0-100)，基于可见窗口。
   * @private
   */
  _timeToPercent(time, visRange) {
    const total = visRange.max - visRange.min;
    if (total === 0) return 0;
    return ((time - visRange.min) / total) * 100;
  }

  // ======================== 渲染 ========================

  /**
   * 使用 TimeStep 在当前可见窗口上生成刻度与标签。
   *
   * 复用主时间轴 (TimeAxis) 的 **完整** TimeStep 配置（moment / options /
   * format / hiddenDates / scale / step），确保刻度线生成算法与主时间轴完全
   * 一致，避免错位。仅复用 scale/step 是不够的：moment 决定时区（影响
   * roundToMinor/next 的舍入基准），options.showMajorLabels 影响 week 刻度的
   * 步进分支，hiddenDates 影响 stepOverHiddenDates，format 影响标签文本。
   *
   * 实现上以当前可见窗口重建一个新的 TimeStep 实例（避免修改 timeAxis.step
   * 的内部迭代状态），再从 timeAxis.step 拷贝全部配置。
   *
   * @private
   */
  _renderTicks() {
    if (!this.dom.labels) return;

    const range = this.body.range.getRange();
    const visRange = { min: range.start, max: range.end };
    if (!visRange.min || !visRange.max || visRange.max <= visRange.min) return;

    const trackWidth = this.dom.track.clientWidth;
    if (trackWidth <= 0) return;

    this.dom.labels.innerHTML = "";

    // 复用主时间轴的完整 TimeStep 配置（与 TimeAxis._repaintLabels 一致）
    const axisStep =
      this.body.util && this.body.util.getTimeStep
        ? this.body.util.getTimeStep()
        : null;

    let step;
    if (axisStep) {
      step = new TimeStep(
        new Date(visRange.min),
        new Date(visRange.max),
        undefined,
        axisStep.hiddenDates || [],
        axisStep.options,
      );
      if (axisStep.moment) step.setMoment(axisStep.moment);
      if (axisStep.format) step.setFormat(axisStep.format);
      step.setScale({ scale: axisStep.scale, step: axisStep.step });
    } else {
      const minimumStep = (visRange.max - visRange.min) / (trackWidth / 80);
      step = new TimeStep(
        new Date(visRange.min),
        new Date(visRange.max),
        minimumStep,
        this.body.hiddenDates || [],
      );
    }

    // 复用主时间轴的 toScreen（与 TimeAxis 相同的坐标映射）
    const toScreenFn =
      this.body.util && this.body.util.toScreen
        ? this.body.util.toScreen
        : null;

    // 与 TimeAxis props.minorLineWidth / majorLineWidth = 1 一致
    const lineWidth = 1;

    step.start();

    // 与 TimeAxis._repaintLabels 相同的迭代模式：
    // 预取 next/xNext，循环中 current=x、next=xNext，width=xNext-x
    let current;
    let next = step.getCurrent();
    let xNext = toScreenFn
      ? toScreenFn(next.valueOf())
      : (this._timeToPercent(next.valueOf(), visRange) / 100) * trackWidth;
    let x;
    let isMajor;
    let className;
    let width = 0;
    let count = 0;
    const MAX = 100;

    while (step.hasNext() && count < MAX) {
      count++;
      isMajor = step.isMajor();
      className = step.getClassName();
      current = next;
      x = xNext;

      step.next();
      next = step.getCurrent();
      xNext = toScreenFn
        ? toScreenFn(next.valueOf())
        : (this._timeToPercent(next.valueOf(), visRange) / 100) * trackWidth;

      width = xNext - x;

      // ---- 网格线（与 TimeAxis._repaintMinorLine / _repaintMajorLine 一致）----
      // TimeAxis: x = left - lineWidth/2; transform: translate(x, y)
      // DataZoom: 同样 translate(toScreen - lineWidth/2)
      const grid = document.createElement("div");
      grid.className =
        `vis-data-zoom-grid ${isMajor ? "vis-major" : "vis-minor"} ${className}`.trim();
      grid.style.transform = `translate(${x - lineWidth / 2}px, 0)`;
      grid.style.width = `${width}px`;
      this.dom.labels.appendChild(grid);

      // ---- 文字标签（与 TimeAxis._repaintMinorText / _repaintMajorText 一致）----
      // TimeAxis: transform: translate(toScreen, y)  — 无偏移
      if (this.options.showLabels) {
        if (isMajor) {
          const label = document.createElement("div");
          label.className = `vis-data-zoom-text vis-major ${className}`.trim();
          label.textContent = step.getLabelMajor(current);
          label.style.transform = `translate(${x}px, 0)`;
          this.dom.labels.appendChild(label);
        } else {
          const label = document.createElement("div");
          label.className = `vis-data-zoom-text vis-minor ${className}`.trim();
          label.textContent = step.getLabelMinor(current);
          label.style.transform = `translate(${x}px, 0)`;
          label.style.width = `${width}px`;
          this.dom.labels.appendChild(label);
        }
      }
    }
  }

  /**
   * 按过滤比例定位选窗（left/width 为百分比）。
   * @private
   */
  _renderWindow() {
    if (!this.dom.window) return;
    const left = this.filterStartRatio * 100;
    const width = (this.filterEndRatio - this.filterStartRatio) * 100;
    this.dom.window.style.left = `${left}%`;
    this.dom.window.style.width = `${Math.max(width, 0.5)}%`;
  }

  // ======================== Item 强调/弱化 ========================

  /**
   * rAF 节流地重新应用 item 强调/弱化样式。
   * 多个触发源（redraw / 拖动 / 滚轮 / rangechange）在同一帧内只执行一次。
   * @private
   */
  _scheduleItemEmphasis() {
    if (this._emphasisRafPending) return;
    this._emphasisRafPending = true;
    requestAnimationFrame(() => {
      this._emphasisRafPending = false;
      this._applyItemEmphasis();
    });
  }

  /**
   * 根据过滤选区对可见 item 应用强化/弱化样式，以示区别：
   * - 选区内 item：添加 `vis-data-zoom-emphasis`（box 外层 2px 黄色光晕）
   * - 选区外 item：添加 `vis-data-zoom-dim`（透明度 70%）
   *
   * 通过 item DOM 元素的 `vis-item` 反向引用读取 start/end 时间，判断是否
   * 与过滤区间重叠（与 Timeline._dataZoomItemFilter 相同的判定逻辑）。
   *
   * 注意：当选区外 item 被 DataView 硬过滤（filterData=true）时，它们不会
   * 出现在 DOM 中，此时只有选区内 item 被强化。若需看到弱化效果，应将
   * dataZoom.filterData 设为 false，使所有 item 渲染后由本方法区分样式。
   * @private
   */
  _applyItemEmphasis() {
    const center = this.body && this.body.dom && this.body.dom.center;
    if (!center || typeof center.querySelectorAll !== "function") return;
    const fr = this.getFilterRange();
    const items = center.querySelectorAll(".vis-item");
    items.forEach((el) => {
      const item = el["vis-item"];
      if (!item || !item.data) return;
      const start = util.convert(item.data.start, "Date").valueOf();
      const end = util
        .convert(
          item.data.end != null ? item.data.end : item.data.start,
          "Date",
        )
        .valueOf();
      const inRange = end >= fr.start && start <= fr.end;
      if (inRange) {
        el.classList.add("vis-data-zoom-emphasis");
        el.classList.remove("vis-data-zoom-dim");
      } else {
        el.classList.add("vis-data-zoom-dim");
        el.classList.remove("vis-data-zoom-emphasis");
      }
    });
  }

  /**
   * 清除所有 item 上的强调/弱化样式（DataZoom 禁用时调用）。
   * @private
   */
  _clearItemEmphasis() {
    const center = this.body && this.body.dom && this.body.dom.center;
    if (!center || typeof center.querySelectorAll !== "function") return;
    const items = center.querySelectorAll(
      ".vis-data-zoom-emphasis, .vis-data-zoom-dim",
    );
    items.forEach((el) => {
      el.classList.remove("vis-data-zoom-emphasis");
      el.classList.remove("vis-data-zoom-dim");
    });
  }

  // ======================== 交互 ========================

  /**
   * 开始拖拽把手或选窗
   * @param {'left'|'right'|'move'} type
   * @param {MouseEvent} e
   * @private
   */
  _startDrag(type, e) {
    e.preventDefault();
    this._dragState = {
      type,
      startX: e.clientX,
      startRatios: { start: this.filterStartRatio, end: this.filterEndRatio },
    };
    document.addEventListener("mousemove", this._bindedOnMouseMove);
    document.addEventListener("mouseup", this._bindedOnMouseUp);
    if (this.dom.container) {
      this.dom.container.classList.add("vis-data-zoom-dragging");
    }
  }

  /**
   * 拖拽中：只调整过滤比例，不移动时间轴。
   * @param {MouseEvent} e
   * @private
   */
  _onMouseMove(e) {
    if (!this._dragState) return;

    const { type, startX, startRatios } = this._dragState;
    const trackWidth = this.dom.track.clientWidth;
    if (trackWidth <= 0) return;

    const dx = e.clientX - startX;
    const dr = dx / trackWidth; // 鼠标位移换算为比例位移
    const MIN_SPAN = 0.02; // 最小过滤区间比例（2%）

    let r0 = startRatios.start;
    let r1 = startRatios.end;

    switch (type) {
      case "move": {
        r0 += dr;
        r1 += dr;
        if (r0 < 0) {
          r1 -= r0;
          r0 = 0;
        } // 左边界夹紧
        if (r1 > 1) {
          r0 -= r1 - 1;
          r1 = 1;
        } // 右边界夹紧
        break;
      }
      case "left": {
        r0 = Math.max(0, Math.min(r0 + dr, r1 - MIN_SPAN));
        break;
      }
      case "right": {
        r1 = Math.min(1, Math.max(r1 + dr, r0 + MIN_SPAN));
        break;
      }
    }

    this.filterStartRatio = r0;
    this.filterEndRatio = r1;
    this._renderWindow();
    this.body.emitter.emit("datazoomfilterchange");
    // filterData=false 时 item 不会重渲染，需主动刷新强调/弱化样式
    this._scheduleItemEmphasis();
  }

  /**
   * 结束拖拽
   * @private
   */
  _onMouseUp() {
    if (this._dragState) {
      this._dragState = null;
      document.removeEventListener("mousemove", this._bindedOnMouseMove);
      document.removeEventListener("mouseup", this._bindedOnMouseUp);
      if (this.dom.container) {
        this.dom.container.classList.remove("vis-data-zoom-dragging");
      }
    }
  }

  /**
   * 点击轨道空白处：将过滤选区居中移动到点击位置（保持宽度），不移动时间轴。
   * @param {MouseEvent} e
   * @private
   */
  _onTrackClick(e) {
    // 只响应点击轨道本身或标签层（非选窗/把手）
    if (e.target !== this.dom.track && e.target !== this.dom.labels) {
      return;
    }

    const trackWidth = this.dom.track.clientWidth;
    if (trackWidth <= 0) return;

    const rect = this.dom.track.getBoundingClientRect();
    const clickRatio = (e.clientX - rect.left) / trackWidth;

    const span = this.filterEndRatio - this.filterStartRatio;
    let r0 = clickRatio - span / 2;
    let r1 = r0 + span;
    if (r0 < 0) {
      r0 = 0;
      r1 = span;
    }
    if (r1 > 1) {
      r1 = 1;
      r0 = 1 - span;
    }

    this.filterStartRatio = r0;
    this.filterEndRatio = r1;
    this._renderWindow();
    this.body.emitter.emit("datazoomfilterchange");
    // filterData=false 时 item 不会重渲染，需主动刷新强调/弱化样式
    this._scheduleItemEmphasis();
  }

  /**
   * 滚轮缩放过滤选区：以鼠标位置比例为中心收窄/放宽过滤区间，不缩放时间轴。
   * @param {WheelEvent} e
   * @private
   */
  _onWheel(e) {
    e.preventDefault();

    const trackWidth = this.dom.track.clientWidth;
    if (trackWidth <= 0) return;

    const rect = this.dom.track.getBoundingClientRect();
    const centerRatio = (e.clientX - rect.left) / trackWidth;
    const factor = e.deltaY > 0 ? 1.1 : 0.9; // 下滚放宽选区，上滚收窄
    const MIN_SPAN = 0.02;

    let r0 = centerRatio + (this.filterStartRatio - centerRatio) * factor;
    let r1 = centerRatio + (this.filterEndRatio - centerRatio) * factor;
    r0 = Math.max(0, r0);
    r1 = Math.min(1, r1);
    if (r1 - r0 < MIN_SPAN) return; // 不过度缩放

    this.filterStartRatio = r0;
    this.filterEndRatio = r1;
    this._renderWindow();
    this.body.emitter.emit("datazoomfilterchange");
    // filterData=false 时 item 不会重渲染，需主动刷新强调/弱化样式
    this._scheduleItemEmphasis();
  }

  // ======================== 事件同步 ========================

  /**
   * rangechange 监听：主时间轴 pan/zoom 时可见窗口变化。
   *
   * 行为区分：
   * - **平移**（可见窗口 span 不变）：ratio 不变，选窗自动按比例跟随。
   * - **缩小**（可见窗口 span 变大）：选窗锚定到绝对时间不变，ratio 自动缩小。
   * - **放大**（可见窗口 span 变小）：选窗锚定到绝对时间不变；若可见窗口
   *   完全落入选窗绝对范围内（visible ⊆ filter），则修正选窗 = 可见窗口
   *   （ratio = [0, 1]），避免选窗超出可见范围。
   *
   * 性能优化：tick 渲染和 DataView 刷新通过 rAF 节流，避免 rangechange
   * 高频触发时重复重建 DOM / 全量过滤。选窗位置（CSS）立即更新（开销极低）。
   *
   * @private
   */
  _onRangeChange() {
    const range = this.body.range.getRange();
    const newVisStart = range.start;
    const newVisEnd = range.end;
    const newVisSpan = newVisEnd - newVisStart;

    if (this._lastVisStart != null && this._lastVisEnd != null) {
      const oldVisSpan = this._lastVisEnd - this._lastVisStart;
      const isZoom = Math.abs(newVisSpan - oldVisSpan) > 1; // 1ms 阈值

      if (isZoom) {
        // 用「当前 ratio + 旧可见窗口」计算选窗的当前绝对范围
        const oldFStart =
          this._lastVisStart + this.filterStartRatio * oldVisSpan;
        const oldFEnd = this._lastVisStart + this.filterEndRatio * oldVisSpan;

        if (newVisStart >= oldFStart && newVisEnd <= oldFEnd) {
          // 放大：visible ⊆ filter → 修正选窗 = visible（ratio = [0, 1]）
          this.filterStartRatio = 0;
          this.filterEndRatio = 1;
        } else {
          // 缩小或放大但 visible 不在 filter 内：保持选窗绝对范围不变
          let r0 = (oldFStart - newVisStart) / newVisSpan;
          let r1 = (oldFEnd - newVisStart) / newVisSpan;
          r0 = Math.max(0, Math.min(1, r0));
          r1 = Math.max(0, Math.min(1, r1));
          if (r1 - r0 < 0.02) {
            // 选窗大部分超出可见范围，重置为整个可见窗口
            r0 = 0;
            r1 = 1;
          }
          this.filterStartRatio = r0;
          this.filterEndRatio = r1;
        }
      }
      // 平移（非缩放）：ratio 不变，选窗自动按比例跟随
    }

    // 缓存当前可见窗口
    this._lastVisStart = newVisStart;
    this._lastVisEnd = newVisEnd;

    // 选窗位置立即更新（仅 CSS，开销极低）
    this._renderWindow();

    // tick 渲染通过 rAF 节流（DOM 重建开销大）
    if (!this._tickRafPending) {
      this._tickRafPending = true;
      requestAnimationFrame(() => {
        this._tickRafPending = false;
        this._renderTicks();
      });
    }

    // pan/zoom 改变过滤区间绝对范围，刷新 item 强调/弱化样式
    this._scheduleItemEmphasis();

    // ratio 变化时不在此处 emit datazoomfilterchange — rangechanged 会在
    // rangechange 之后触发并刷新 DataView。避免动画/拖动过程中高频全量过滤。
    // 用户直接拖动 dataZoom 选窗时通过 _onMouseMove 等直接 emit，不受影响。
  }

  // ======================== 销毁 ========================

  /**
   * Destroy the DataZoom component. Cleanup DOM and event listeners.
   */
  destroy() {
    this._tickRafPending = false;
    this._emphasisRafPending = false;
    document.removeEventListener("mousemove", this._bindedOnMouseMove);
    document.removeEventListener("mouseup", this._bindedOnMouseUp);

    // 清除 item 上的强调/弱化样式
    this._clearItemEmphasis();

    if (this.dom.container && this.dom.container.parentNode) {
      this.dom.container.parentNode.removeChild(this.dom.container);
    }
    this.dom = {};
    this.body = null;
  }
}

export default DataZoom;

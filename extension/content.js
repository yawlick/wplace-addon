(() => {
  'use strict';
  if (window.top !== window || globalThis.__wplaceAutoColorLoaded) return;
  globalThis.__wplaceAutoColorLoaded = true;

  const DEFAULTS = Object.freeze({
    settingsVersion: 12, enabled: true,
    debug: false, panelCollapsed: false,
  });
  const state = {
    settings: { ...DEFAULTS }, processing: false, generation: 0,
    queue: [], remaining: 0, processedCount: 0, skippedCount: 0,
    lastError: '', snapshotProblem: '', batchActive: false, rectMode: false, rectStart: null, rectPreview: null,
    lassoMode: false, lassoDrawing: false, lassoPoints: [], lassoPreview: null, suppressNextClick: false,
    panel: null, outputs: {}, panelFrame: 0,
  };
  let requestId = 0;
  const bridgeRequests = new Map();
  const log = (...args) => state.settings.debug && console.debug('[AutoColor]', ...args);
  const canvas = () => document.querySelector('#map .maplibregl-canvas, .maplibregl-canvas');
  const isEditable = (target) => target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const canContinue = (token) => token === state.generation && state.settings.enabled && state.batchActive;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'wac-page') return;
    if (event.data.type === 'progress') {
      if (event.data.batchId !== state.generation) return;
      state.processedCount = event.data.processed;
      state.skippedCount = event.data.skipped;
      state.remaining = event.data.remaining;
      updatePanel();
      return;
    }
    const pending = bridgeRequests.get(event.data.id);
    if (!pending) return;
    bridgeRequests.delete(event.data.id);
    clearTimeout(pending.timer);
    event.data.ok ? pending.resolve(event.data.result) : pending.reject(new Error(event.data.error));
  });

  function bridge(type, payload) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      // A batch runs as long as it has pixels; each stroke in it is synchronous
      // apart from microtasks, so it cannot hang on its own.
      const timeoutMs = 15000;
      const timer = type === 'runBatch' ? 0 : setTimeout(() => {
        if (!bridgeRequests.delete(id)) return;
        reject(new Error(`Тайм-аут обработчика сайта (${type}, ${timeoutMs / 1000} с)`));
      }, timeoutMs);
      bridgeRequests.set(id, { resolve, reject, timer });
      window.postMessage({ source: 'wac-content', id, type, payload }, '*');
    });
  }

  // The page bridge runs the whole batch and reports progress messages; a
  // newer batch or stop() supersedes it through the generation token.
  async function processQueue(token) {
    state.processing = true;
    updatePanel();
    try {
      await bridge('runBatch', { batchId: token, points: state.queue });
    } catch (error) {
      if (token === state.generation) {
        state.lastError = error?.message || 'Не удалось выполнить штрих';
        log('Batch failed:', state.lastError);
        stop('stroke failed');
      }
    } finally {
      if (token === state.generation) {
        state.processing = false;
        state.batchActive = false;
        state.queue = [];
        state.remaining = 0;
        updatePanel();
      }
    }
  }

  function stop(reason) {
    state.generation += 1;
    void bridge('stopBatch').catch(() => {});
    state.queue = [];
    state.remaining = 0;
    state.processing = false;
    state.batchActive = false;
    state.rectMode = false;
    state.lassoMode = false;
    clearRectanglePreview();
    clearLassoPreview();
    log('Stopped:', reason);
    updatePanel();
  }

  function setEnabled(enabled) {
    state.settings.enabled = enabled;
    if (!enabled) stop('disabled');
    persistSettings();
    updatePanel();
  }

  function toggleRectangleMode() {
    if (!state.settings.enabled) return;
    state.rectMode = !state.rectMode;
    state.lassoMode = false;
    clearLassoPreview();
    clearRectanglePreview();
    state.lastError = state.rectMode ? 'Выбери первый угол' : '';
    updatePanel();
  }

  function clearRectanglePreview() {
    state.rectStart = null;
    state.rectPreview?.remove();
    state.rectPreview = null;
  }

  function updateRectanglePreview(point) {
    if (!state.rectStart || !state.rectPreview) return;
    const x = Math.min(state.rectStart.x, point.x);
    const y = Math.min(state.rectStart.y, point.y);
    const rect = state.rectPreview.querySelector('rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', Math.abs(point.x - state.rectStart.x));
    rect.setAttribute('height', Math.abs(point.y - state.rectStart.y));
  }

  function clearLassoPreview() {
    state.lassoDrawing = false;
    state.lassoPoints = [];
    state.lassoPreview?.remove();
    state.lassoPreview = null;
  }

  function toggleLassoMode() {
    if (!state.settings.enabled) return;
    state.lassoMode = !state.lassoMode;
    state.rectMode = false;
    clearRectanglePreview();
    clearLassoPreview();
    state.lastError = state.lassoMode ? 'Зажми ЛКМ и обведи область' : '';
    updatePanel();
  }

  async function startBatch(points) {
    state.queue = points;
    state.batchActive = true;
    state.processedCount = 0;
    state.skippedCount = 0;
    state.remaining = points.length;
    state.generation += 1;
    void bridge('stopBatch').catch(() => {});
    const token = state.generation;
    state.snapshotProblem = '';
    state.lastError = 'Загрузка тайлов карты…';
    updatePanel();
    try {
      const result = await bridge('prepareBatch', { batchId: token, points });
      if (token === state.generation && !result.snapshotAvailable) state.snapshotProblem = 'Тайлы карты недоступны';
    } catch (error) {
      if (token === state.generation) state.snapshotProblem = `Тайлы карты: ${error?.message || String(error)}`;
    }
    if (!canContinue(token)) return;
    state.lastError = '';
    updatePanel();
    void processQueue(token);
  }

  function rectanglePoints({ minX, maxX, minY, maxY }) {
    const points = [];
    for (let y = minY; y <= maxY; y += 1) {
      const reverse = (y - minY) % 2 === 1;
      for (let offset = 0; offset <= maxX - minX; offset += 1) {
        points.push({ gridX: reverse ? maxX - offset : minX + offset, gridY: y });
      }
    }
    return points;
  }

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.code !== 'KeyQ' || event.repeat || isEditable(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleRectangleMode();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.code !== 'KeyL' || event.repeat || isEditable(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleLassoMode();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.code !== 'F8') return;
    event.preventDefault();
    setEnabled(!state.settings.enabled);
  }, true);

  window.addEventListener('click', async (event) => {
    if (state.suppressNextClick) {
      state.suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!state.rectMode || event.target !== canvas()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = { x: event.clientX, y: event.clientY };
    if (!state.rectStart) {
      state.rectStart = point;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'wac-rectangle-preview';
      svg.innerHTML = `<rect></rect><circle cx="${point.x}" cy="${point.y}" r="4"></circle>`;
      document.documentElement.append(svg);
      state.rectPreview = svg;
      updateRectanglePreview(point);
      state.lastError = 'Выбери второй угол';
      updatePanel();
      return;
    }
    state.rectMode = false;
    const first = state.rectStart;
    clearRectanglePreview();
    state.lastError = 'Расчёт прямоугольника…';
    updatePanel();
    try {
      const bounds = await bridge('rectangle', { a: first, b: point });
      startBatch(rectanglePoints(bounds));
    } catch (error) {
      state.lastError = error?.message || String(error);
      updatePanel();
    }
  }, true);

  window.addEventListener('mousedown', (event) => {
    if (!state.lassoMode || event.button !== 0 || event.target !== canvas()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearLassoPreview();
    state.lassoDrawing = true;
    state.lassoPoints = [{ x: event.clientX, y: event.clientY }];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'wac-lasso-preview';
    svg.innerHTML = '<polyline></polyline>';
    document.documentElement.append(svg);
    state.lassoPreview = svg;
    state.lastError = 'Обводи область и отпусти ЛКМ';
    updatePanel();
  }, true);

  window.addEventListener('mousemove', (event) => {
    if (state.rectMode && state.rectStart) updateRectanglePreview({ x: event.clientX, y: event.clientY });
    if (!state.lassoDrawing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = { x: event.clientX, y: event.clientY };
    const previous = state.lassoPoints[state.lassoPoints.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return;
    state.lassoPoints.push(point);
    state.lassoPreview?.querySelector('polyline')
      ?.setAttribute('points', state.lassoPoints.map((entry) => `${entry.x},${entry.y}`).join(' '));
  }, true);

  window.addEventListener('mouseup', async (event) => {
    if (!state.lassoDrawing || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const points = [...state.lassoPoints];
    state.suppressNextClick = true;
    state.lassoDrawing = false;
    state.lassoMode = false;
    state.lassoPreview?.querySelector('polyline')?.setAttribute(
      'points',
      [...points, points[0]].map((entry) => `${entry.x},${entry.y}`).join(' '),
    );
    state.lastError = 'Расчёт лассо…';
    updatePanel();
    try {
      const selected = await bridge('lasso', { points });
      clearLassoPreview();
      startBatch(selected);
    } catch (error) {
      clearLassoPreview();
      state.lastError = error?.message || String(error);
      updatePanel();
    }
  }, true);

  function persistSettings() {
    chrome.storage.local.set({ wacSettings: state.settings });
  }

  function updatePanel() {
    if (!state.panelFrame) state.panelFrame = requestAnimationFrame(flushPanel);
  }

  function flushPanel() {
    state.panelFrame = 0;
    if (!state.panel) return;
    state.panel.classList.toggle('wac-off', !state.settings.enabled);
    state.panel.classList.toggle('wac-collapsed', state.settings.panelCollapsed);
    state.outputs.phase.textContent = state.lastError
      || (state.processing ? 'обработка' : state.snapshotProblem || 'ожидание');
    state.outputs.count.textContent = String(state.processedCount);
    state.outputs.skipped.textContent = String(state.skippedCount);
    state.outputs.queue.textContent = String(state.remaining);
  }

  function mountPanel() {
    if (state.panel || !document.body) return;
    const panel = document.createElement('aside');
    panel.id = 'wac-panel';
    panel.innerHTML = `<div class="wac-head"><i class="wac-dot"></i><span class="wac-title">Pixel Auto Color <small>v1.12.0</small></span><button class="wac-icon-button" title="Свернуть">—</button></div><div class="wac-body"><div class="wac-status"><span>Состояние</span><output data-out="phase"></output><span>Добавлено</span><output data-out="count"></output><span>Пропущено</span><output data-out="skipped"></output><span>Осталось</span><output data-out="queue"></output></div><div class="wac-controls"></div><div class="wac-footer">Q — прямоугольник · L — лассо</div></div>`;
    state.panel = panel;
    for (const output of panel.querySelectorAll('[data-out]')) state.outputs[output.dataset.out] = output;
    const controls = panel.querySelector('.wac-controls');
    const rectangleButton = document.createElement('button');
    rectangleButton.className = 'wac-action-button';
    rectangleButton.textContent = 'Выбрать прямоугольник';
    rectangleButton.addEventListener('click', toggleRectangleMode);
    controls.append(rectangleButton);
    const lassoButton = document.createElement('button');
    lassoButton.className = 'wac-action-button';
    lassoButton.textContent = 'Выбрать лассо';
    lassoButton.addEventListener('click', toggleLassoMode);
    controls.append(lassoButton);
    const stopButton = document.createElement('button');
    stopButton.className = 'wac-action-button';
    stopButton.textContent = 'Остановить рисование';
    stopButton.addEventListener('click', () => {
      const discarded = state.remaining;
      stop('rectangle stopped');
      state.rectMode = false;
      clearRectanglePreview();
      state.lassoMode = false;
      clearLassoPreview();
      state.lastError = discarded ? `Остановлено, отброшено: ${discarded}` : 'Рисование остановлено';
      updatePanel();
    });
    controls.append(stopButton);
    panel.querySelector('.wac-icon-button').addEventListener('click', () => {
      state.settings.panelCollapsed = !state.settings.panelCollapsed;
      persistSettings();
      updatePanel();
    });
    document.body.append(panel);
    updatePanel();
  }

  chrome.storage.local.get({ wacSettings: DEFAULTS }, ({ wacSettings }) => {
    const migrated = wacSettings?.settingsVersion === DEFAULTS.settingsVersion ? wacSettings : { ...wacSettings, ...DEFAULTS };
    state.settings = { ...DEFAULTS, ...migrated };
    persistSettings();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    else mountPanel();
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'wac:get-state') respond({ settings: state.settings, processing: state.processing });
    if (message?.type === 'wac:set-enabled') { setEnabled(Boolean(message.enabled)); respond({ ok: true }); }
  });
})();

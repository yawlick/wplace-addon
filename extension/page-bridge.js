(() => {
  'use strict';
  const handlers = { move: null, middle: null, down: null, up: null };
  // findChunk() reads the Resource Timing list; the site loads 300+ chunks,
  // more than the default 250-entry buffer, so late chunks would be missing.
  try { performance.setResourceTimingBufferSize(10000); } catch { /* Not critical. */ }
  let map = null;
  let gridMath = null;
  let tileZoom = null;
  let bridgeInitError = '';
  let mapSnapshot = null;
  let snapshotBatchId = null;
  const paintedPixels = new Map();
  const PAINT_MEMORY_MS = 10 * 60 * 1000;

  // Values used by the current Wplace season. Kept locally because importing
  // the site's config chunk executes locale-dependent application code.
  const WPLACE_TILE_SIZE = 1000;
  const WPLACE_PIXEL_ZOOM = 11;
  const WEB_MERCATOR_HALF_WORLD = 20037508.34;
  // RGB values extracted from the current site's config chunk D15WkdMt.js.
  // Importing that chunk here executes locale code before initializeLocale().
  const SITE_PALETTE = [
    [0,0,0],[0,0,0],[60,60,60],[120,120,120],[210,210,210],[255,255,255],[96,0,24],[237,28,36],
    [255,127,39],[246,170,9],[249,221,59],[255,250,188],[14,185,104],[19,230,123],[135,255,94],[12,129,110],
    [16,174,166],[19,225,190],[40,80,158],[64,147,228],[96,247,242],[107,80,246],[153,177,251],[120,12,153],
    [170,56,185],[224,159,249],[203,0,122],[236,31,128],[243,141,169],[104,70,52],[149,104,42],[248,178,119],
    [170,170,170],[165,14,30],[250,128,114],[228,92,26],[214,181,148],[156,132,49],[197,173,49],[232,212,95],
    [74,107,58],[90,148,74],[132,197,115],[15,121,159],[187,250,242],[125,199,255],[77,49,184],[74,66,132],
    [122,113,196],[181,174,241],[219,164,99],[209,128,81],[255,197,165],[155,82,73],[209,128,120],[250,182,164],
    [123,99,82],[156,132,107],[51,57,65],[109,117,141],[179,185,209],[109,100,63],[148,140,107],[205,197,158],
  ];

  // The site's own successful paint request is the only confirmation that a
  // selected pixel was actually placed. Keep those colors briefly so a new
  // rectangle or lasso does not select them again while the map tiles refresh.
  function rememberPaint(body) {
    let data;
    try { data = JSON.parse(body); } catch { return; }
    if (!Array.isArray(data?.tiles)) return;
    const now = Date.now();
    for (const tile of data.tiles) {
      const xs = tile?.pixels?.x, ys = tile?.pixels?.y, colors = tile?.pixels?.colors;
      if (!Array.isArray(xs) || !Array.isArray(ys) || !Array.isArray(colors)) continue;
      for (let i = 0; i < Math.min(xs.length, ys.length, colors.length); i += 1) {
        const tileSize = gridMath?.tileSize ?? WPLACE_TILE_SIZE;
        const gridX = tile.x * tileSize + xs[i];
        const gridY = tile.y * tileSize + ys[i];
        if (Number.isInteger(gridX) && Number.isInteger(gridY) && Number.isInteger(colors[i])) {
          paintedPixels.set(`${gridX},${gridY}`, { color: colors[i], at: now });
        }
      }
    }
    while (paintedPixels.size > 50000) paintedPixels.delete(paintedPixels.keys().next().value);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const requestUrl = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    let paintRequest = false;
    try { paintRequest = method === 'POST' && new URL(requestUrl, location.href).pathname.endsWith('/paint'); } catch { /* Other requests are untouched. */ }
    const response = nativeFetch.apply(this, arguments);
    if (!paintRequest) return response;
    return response.then((result) => {
      if (result.ok && typeof init?.body === 'string') rememberPaint(init.body);
      return result;
    });
  };

  // Every pixel the site adds to its pending selection posts the whole pending
  // list to its service worker ('previewPixels'), waits for the reply and then
  // calls map.refreshTiles() on the pixel-art source, which re-fetches every
  // visible tile. Per pixel that is quadratic work plus a tile reload, so while
  // a batch runs only the latest preview is kept: the site gets an immediate
  // reply, and flushPreview() sends the newest list and refreshes the tiles
  // once every PREVIEW_FLUSH_MS and when the batch ends. The pending list
  // itself still lives in the site and is what its paint request submits.
  const PREVIEW_FLUSH_MS = 250;
  let coalescingBatches = 0;
  let lastFlush = 0;
  let pendingPreview = null;
  let pendingRefresh = null;
  let nativeRefreshTiles = null;
  const nativeWorkerPost = globalThis.ServiceWorker?.prototype.postMessage;
  if (nativeWorkerPost) {
    ServiceWorker.prototype.postMessage = function (message, ...rest) {
      if (!coalescingBatches || message?.type !== 'previewPixels') return nativeWorkerPost.call(this, message, ...rest);
      pendingPreview = { worker: this, message };
      queueMicrotask(() => navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', { data: { id: message.id } })));
    };
  }

  // The site plays a sound on every added pixel.
  const nativeMediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (coalescingBatches) return Promise.resolve();
    return nativeMediaPlay.apply(this, args);
  };

  function patchRefreshTiles(prototype) {
    if (typeof prototype.refreshTiles !== 'function' || prototype.refreshTiles.__wacPatched) return;
    nativeRefreshTiles = prototype.refreshTiles;
    const patched = function (...args) {
      if (!coalescingBatches) return nativeRefreshTiles.apply(this, args);
      pendingRefresh = { map: this, args };
      return undefined;
    };
    patched.__wacPatched = true;
    prototype.refreshTiles = patched;
  }

  function waitForWorkerReply(id) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve();
      };
      const onMessage = (event) => { if (event.data?.id === id) done(); };
      const timer = setTimeout(done, 10000);
      navigator.serviceWorker.addEventListener('message', onMessage);
    });
  }

  async function flushPreview() {
    lastFlush = performance.now();
    const preview = pendingPreview, refresh = pendingRefresh;
    pendingPreview = null;
    pendingRefresh = null;
    if (preview) {
      const reply = waitForWorkerReply(preview.message.id);
      try {
        nativeWorkerPost.call(preview.worker, preview.message);
        await reply;
      } catch (error) {
        console.warn('[AutoColor bridge] preview', error);
      }
    }
    if (refresh) nativeRefreshTiles.apply(refresh.map, refresh.args);
  }

  class PixelGridMath {
    constructor(tileSize) { this.tileSize = tileSize; }
    resolution(zoom) { return (2 * WEB_MERCATOR_HALF_WORLD) / (this.tileSize * (2 ** zoom)); }
    latLonToMeters(lat, lng) {
      return [
        lng / 180 * WEB_MERCATOR_HALF_WORLD,
        Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * WEB_MERCATOR_HALF_WORLD / 180,
      ];
    }
    metersToLatLon(x, y) {
      const lng = x / WEB_MERCATOR_HALF_WORLD * 180;
      let lat = y / WEB_MERCATOR_HALF_WORLD * 180;
      lat = 180 / Math.PI * (2 * Math.atan(Math.exp(lat * Math.PI / 180)) - Math.PI / 2);
      return [lat, lng];
    }
    latLonToPixelsFloor(lat, lng, zoom) {
      const [x, y] = this.latLonToMeters(lat, lng);
      const resolution = this.resolution(zoom);
      return [
        Math.floor((x + WEB_MERCATOR_HALF_WORLD) / resolution),
        Math.floor((WEB_MERCATOR_HALF_WORLD - y) / resolution),
      ];
    }
    pixelsToLatLon(x, y, zoom) {
      const resolution = this.resolution(zoom);
      return this.metersToLatLon(
        x * resolution - WEB_MERCATOR_HALF_WORLD,
        WEB_MERCATOR_HALF_WORLD - y * resolution,
      );
    }
  }

  function inspect(target, type, listener) {
    if (typeof listener !== 'function') return;
    const source = Function.prototype.toString.call(listener);
    if (target === window && type === 'mousemove' && source.includes('unproject') && source.includes('clientX')) handlers.move = listener;
    // Newer builds route these through rebindable hotkeys ('paint.pick-hover',
    // 'paint-hold'); older ones hard-coded the middle button and Space.
    if (target === document && type === 'mousedown'
      && (source.includes('paint.pick-hover') || /button\s*===\s*1/.test(source))) handlers.middle = listener;
    if (target === document && type === 'keydown' && source.includes('preventDefault')
      && (source.includes('`paint-hold`') || source.includes('Space'))) handlers.down = listener;
    if (target === document && type === 'keyup'
      && (source.includes('`paint-hold`') || source.includes('Space'))) handlers.up = listener;
  }

  const nativeWindowAdd = window.addEventListener;
  const nativeDocumentAdd = document.addEventListener;
  window.addEventListener = function (type, listener, options) {
    inspect(window, type, listener);
    return nativeWindowAdd.call(this, type, listener, options);
  };
  document.addEventListener = function (type, listener, options) {
    inspect(document, type, listener);
    return nativeDocumentAdd.call(this, type, listener, options);
  };

  async function unwrapMapLibre(module) {
    let value = module?.t;
    for (let depth = 0; depth < 5; depth += 1) {
      if (value?.Map?.prototype?.unproject) return value;
      if (value?.default?.Map?.prototype?.unproject) return value.default;
      if (value?.prototype?.unproject) return { Map: value };
      if (typeof value === 'function') value = value();
      else if (value && typeof value.then === 'function') value = await value;
      else break;
    }
    throw new Error('в модуле MapLibre не найден класс Map');
  }

  // Chunk file names are content hashes and change with every site deploy, so
  // find the MapLibre chunk among the scripts the page has already loaded.
  function loadedChunkUrls() {
    const urls = new Set();
    for (const entry of performance.getEntriesByType('resource')) {
      if (/\/_app\/immutable\/chunks\/[^/]+\.js$/.test(new URL(entry.name).pathname)) urls.add(entry.name);
    }
    for (const link of document.querySelectorAll('link[rel="modulepreload"][href*="/chunks/"]')) urls.add(link.href);
    return [...urls];
  }

  async function findChunk(matches) {
    for (const url of loadedChunkUrls()) {
      try {
        const response = await nativeFetch.call(window, url, { cache: 'force-cache' });
        if (!response.ok) continue;
        if (matches(await response.text())) return url;
      } catch { /* Try the next chunk. */ }
    }
    return null;
  }

  // The site's eyedropper reads the template color through a small module
  // function, (latLon, fallback) => palette index ?? fallback ?? null.
  // Calling it directly gives every pixel's template color without the
  // eyedropper's sound, haptics and palette re-render. The module is loaded
  // with the painting UI, so it is looked up lazily; the same URL resolves to
  // the module instance the site already uses. It used to live in the
  // 'Pending paint preview' chunk; since the 2026-11 build it has its own
  // chunk, so match the function itself: it reads RGBA from template pixels.
  let templateColorAt = null;

  async function loadTemplateLookup() {
    if (templateColorAt) return templateColorAt;
    try {
      const url = await findChunk((source) => source.includes('latLonToPixels(')
        && /\.pixels\[\w+\+3\]/.test(source) && /\?\?null\}/.test(source));
      if (!url) return null;
      const module = await import(url);
      templateColorAt = Object.values(module).find((value) => typeof value === 'function'
        && value.length === 2 && /\?\?null/.test(Function.prototype.toString.call(value))) ?? null;
    } catch (error) {
      console.warn('[AutoColor bridge] template lookup', error);
    }
    return templateColorAt;
  }

  async function initializeSiteModules(attempt = 0) {
    try {
      const chunkUrl = await findChunk((source) => source.includes('.maplibregl=') && source.includes('unproject'));
      if (!chunkUrl) {
        // MapLibre may be loaded lazily after the page's load event.
        if (attempt < 20) { setTimeout(() => initializeSiteModules(attempt + 1), 1000); return; }
        throw new Error('не найден чанк MapLibre на странице');
      }
      const mapModule = await import(chunkUrl);
      const library = await unwrapMapLibre(mapModule);
      const prototype = library.Map.prototype;
      patchRefreshTiles(prototype);
      const original = prototype.unproject;
      if (!original.__wacPatched) {
        const patched = function (...args) {
          map = this;
          return original.apply(this, args);
        };
        patched.__wacPatched = true;
        prototype.unproject = patched;
      }
      tileZoom = WPLACE_PIXEL_ZOOM;
      gridMath = new PixelGridMath(WPLACE_TILE_SIZE);
      bridgeInitError = '';
    } catch (error) {
      bridgeInitError = error?.message || String(error);
      console.warn('[AutoColor bridge]', error);
    }
  }

  // Wait until the site has created its map before patching MapLibre.
  if (document.readyState === 'complete') setTimeout(() => initializeSiteModules(), 0);
  else nativeWindowAdd.call(window, 'load', () => initializeSiteModules(), { once: true });

  function pointerEventLike(x, y, button, target) {
    return {
      type: button === 1 ? 'mousedown' : 'mousemove',
      clientX: x, clientY: y, screenX: x, screenY: y,
      pageX: x, pageY: y, offsetX: x, offsetY: y,
      button, buttons: 0, detail: 1, target, currentTarget: document,
      pointerType: 'mouse', isPrimary: true,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      composedPath() { return target ? [target, document, window] : [document, window]; },
    };
  }

  // The site's hotkey registry: bindings(id) returns names such as 'Space',
  // 'F', '5' or 'MouseMiddle'. Older builds have none.
  let hotkeys = null;

  async function loadHotkeys() {
    if (hotkeys) return hotkeys;
    try {
      const url = await findChunk((source) => source.includes('paint.pick-hover') && /isHoldKey\(\w+,\w+\)\{/.test(source));
      if (!url) return null;
      const module = await import(url);
      hotkeys = Object.values(module).find((value) => value && typeof value === 'object'
        && typeof value.bindings === 'function' && typeof value.isHoldKey === 'function') ?? null;
    } catch (error) {
      console.warn('[AutoColor bridge] hotkeys', error);
    }
    return hotkeys;
  }

  function binding(id) {
    try { return hotkeys?.bindings(id) ?? []; } catch { return []; }
  }

  const MOUSE_BUTTONS = { MouseLeft: 0, MouseMiddle: 1, MouseRight: 2, MouseBack: 3, MouseForward: 4 };

  function pickButton() {
    const name = binding('paint.pick-hover').find((entry) => entry in MOUSE_BUTTONS);
    return name ? MOUSE_BUTTONS[name] : 1;
  }

  // The site checks `event instanceof KeyboardEvent`, so the paint-hold key
  // must be a real (never dispatched) KeyboardEvent for the bound key.
  function holdKeyEvent(type) {
    const name = binding('paint-hold').find((entry) => !entry.startsWith('Mouse'))?.split('+').pop() || 'Space';
    let key = name, code = name;
    if (name === 'Space') key = ' ';
    else if (/^[A-Z]$/.test(name)) { key = name.toLowerCase(); code = `Key${name}`; }
    else if (/^\d$/.test(name)) code = `Digit${name}`;
    return new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
  }

  function savedPaletteIndex() {
    const index = Number(localStorage.getItem('selected-color'));
    return Number.isInteger(index) ? index : null;
  }

  // MessageChannel tasks are not throttled in background windows, unlike
  // setTimeout and requestAnimationFrame.
  function nextTask() {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

  // Each await queues behind the microtasks already scheduled, including
  // Svelte's effect flush and any flush that flush schedules in turn.
  async function settleMicrotasks() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }


  function tileUrl(tileX, tileY) {
    const template = map?.getSource?.('pixel-art-layer')?.tiles?.[0]
      ?? map?.getStyle?.()?.sources?.['pixel-art-layer']?.tiles?.[0];
    if (typeof template !== 'string') return null;
    return new URL(template.replace('{x}', tileX).replace('{y}', tileY).replace('{z}', tileZoom), location.href).href;
  }

  async function loadTile(tileX, tileY) {
    const url = tileUrl(tileX, tileY);
    if (!url) throw new Error('Не найден источник тайлов карты');
    const response = await nativeFetch.call(window, url, { cache: 'no-store', credentials: 'omit' });
    // A missing tile means nobody has painted anything there yet.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Тайл ${tileX},${tileY}: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const copy = document.createElement('canvas');
    try {
      copy.width = bitmap.width;
      copy.height = bitmap.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Не удалось прочитать тайл карты');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height);
    } finally {
      bitmap.close();
      copy.remove();
    }
  }

  // The map canvas cannot be used to read existing pixels: the site's template
  // overlay is a custom WebGL layer that shows through transparent map pixels
  // regardless of layer order, so an empty pixel looks already painted.
  // Read the same pixel tiles the map loads instead.
  async function prepareBatch({ batchId, points }) {
    snapshotBatchId = batchId;
    mapSnapshot = null;
    if (!Array.isArray(points) || !gridMath) return { snapshotAvailable: false };
    const tileSize = gridMath.tileSize;
    const keys = new Set(points.map((point) =>
      `${Math.floor(point.gridX / tileSize)},${Math.floor(point.gridY / tileSize)}`));
    const tiles = new Map();
    await Promise.all([...keys].map(async (key) => {
      const [tileX, tileY] = key.split(',').map(Number);
      tiles.set(key, await loadTile(tileX, tileY));
    }));
    if (snapshotBatchId !== batchId) return { snapshotAvailable: false };
    mapSnapshot = { tiles };
    return { snapshotAvailable: true };
  }

  function sameRenderedColor(gridX, gridY, colorIndex) {
    const desired = SITE_PALETTE[colorIndex];
    const tileSize = gridMath?.tileSize;
    if (!mapSnapshot || !desired || !tileSize) return false;
    const tileX = Math.floor(gridX / tileSize), tileY = Math.floor(gridY / tileSize);
    const key = `${tileX},${tileY}`;
    if (!mapSnapshot.tiles.has(key)) return false;
    const tile = mapSnapshot.tiles.get(key);
    let transparent = true;
    let offset = 0;
    if (tile) {
      const x = Math.floor((gridX - tileX * tileSize) * tile.width / tileSize);
      const y = Math.floor((gridY - tileY * tileSize) * tile.height / tileSize);
      offset = (y * tile.width + x) * 4;
      transparent = tile.data[offset + 3] < 128;
    }
    if (colorIndex === 0) return transparent;
    return !transparent && desired.every((value, channel) =>
      Math.abs(tile.data[offset + channel] - value) <= 4);
  }

  function alreadyPainted(gridX, gridY, colorIndex) {
    const previousPaint = paintedPixels.get(`${gridX},${gridY}`);
    return (previousPaint && Date.now() - previousPaint.at < PAINT_MEMORY_MS
      && previousPaint.color === colorIndex) || sameRenderedColor(gridX, gridY, colorIndex);
  }

  // Physical mouse movement may change the site's shared hover point at any
  // await. Moving to the pixel and pressing Space in the same JS task keeps
  // painting from jumping to the cursor.
  function paintPixel(gridX, gridY, canvas) {
    const { x, y } = screenPointForPixel(gridX, gridY);
    handlers.move(pointerEventLike(x, y, 0, canvas));
    handlers.down(holdKeyEvent('keydown'));
    handlers.up(holdKeyEvent('keyup'));
  }

  async function stroke({ gridX, gridY }) {
    const picked = await pickColor(gridX, gridY);
    if (picked.skipped) return picked;
    if (alreadyPainted(gridX, gridY, picked.colorIndex)) return { skipped: true, reason: 'already-correct' };
    paintPixel(gridX, gridY, document.querySelector('.maplibregl-canvas'));
    return { skipped: false };
  }

  // Runs the site's eyedropper on a pixel and returns the palette color it
  // selected, or why it selected none.
  async function pickColor(gridX, gridY) {
    const canvas = document.querySelector('.maplibregl-canvas');
    const { x, y } = screenPointForPixel(gridX, gridY);
    handlers.move(pointerEventLike(x, y, 0, canvas));
    const dialogsOpenBefore = new Set(document.querySelectorAll('dialog[open]'));

    // Since the 2026-11 build the eyedropper is async: it first awaits the
    // "seven seals" event lookup (an image load on the first seal pixel), then
    // falls back to the template lookup. It ends in one of two ways:
    //  - a color was found: it selects it and right away schedules
    //    requestAnimationFrame(() => #color-N.focus());
    //  - nothing was found: it reads the map canvas via map.once('render').
    // Both are watched until one happens, so the color is read only after
    // the site set it, and the canvas fallback stays suppressed: a point
    // outside the overlay must not alter the palette or enter the selection.
    let outsideOverlay = false;
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const nativeOnce = map && typeof map.once === 'function' ? map.once : null;
    if (nativeOnce) {
      map.once = function (type, listener) {
        if (type === 'render') {
          outsideOverlay = true;
          finish();
          return this;
        }
        return nativeOnce.call(this, type, listener);
      };
    }
    const nativeRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (callback) {
      const source = typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
      if (source.includes('getElementById') && source.includes('color-')) finish();
      return nativeRaf.call(window, callback);
    };
    let timer = 0;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5000); });
    // This calls the site's captured eyedropper handler directly. No browser
    // click is dispatched and no paint/network request is forged.
    let result;
    try {
      handlers.middle({ ...pointerEventLike(x, y, pickButton(), canvas), type: 'mousedown' });
      result = await Promise.race([finished, timeout]);
    } finally {
      clearTimeout(timer);
      if (nativeOnce) map.once = nativeOnce;
      window.requestAnimationFrame = nativeRaf;
    }
    if (outsideOverlay) return { skipped: true, reason: 'outside-overlay' };
    if (result === 'timeout') return { skipped: true, reason: 'eyedropper-timeout' };

    // The site's Svelte effects save the color to localStorage and open the
    // purchase dialog in microtasks after the color is set.
    await settleMicrotasks();
    const purchaseDialog = [...document.querySelectorAll('dialog[open]')]
      .find((dialog) => !dialogsOpenBefore.has(dialog));
    if (purchaseDialog) {
      // The site's color picker opens this dialog when $t(color) reports that
      // the account does not own the requested palette color. Close it through
      // the native dialog API so the site's close handler resets its state.
      purchaseDialog.close();
      return { skipped: true, reason: 'color-unavailable' };
    }
    return { skipped: false, colorIndex: savedPaletteIndex() };
  }

  function ensureMapAt(point) {
    // A click can arrive before the patched MapLibre method has observed a
    // native move. Calling the site's own hover handler captures its map now.
    if (!map && handlers.move) {
      const canvas = document.querySelector('.maplibregl-canvas');
      handlers.move(pointerEventLike(point.x, point.y, 0, canvas));
    }
    if (bridgeInitError) throw new Error(`Мост сайта не загрузился: ${bridgeInitError}`);
    if (!gridMath) throw new Error('Не загрузилась геометрия пиксельной сетки');
    if (!Number.isFinite(tileZoom)) throw new Error('Не удалось определить zoom пиксельной сетки');
    if (!map) {
      if (!handlers.move) throw new Error('Не найден обработчик карты — обнови страницу в режиме рисования');
      throw new Error('Карта не перехватилась — подвигай мышью над холстом после полной загрузки');
    }
  }

  function screenPointForPixel(x, y) {
    const [lat, lng] = gridMath.pixelsToLatLon(x + 0.5, y + 0.5, tileZoom);
    const screen = map.project({ lat, lng });
    return { x: screen.x, y: screen.y };
  }

  function screenPolygonForPixel(x, y) {
    return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([px, py]) => {
      const [lat, lng] = gridMath.pixelsToLatLon(px, py, tileZoom);
      const screen = map.project({ lat, lng });
      return { x: screen.x, y: screen.y };
    });
  }

  function rectangle(a, b) {
    ensureMapAt(a);
    const first = map.unproject([a.x, a.y]);
    const second = map.unproject([b.x, b.y]);
    const p1 = gridMath.latLonToPixelsFloor(first.lat, first.lng, tileZoom);
    const p2 = gridMath.latLonToPixelsFloor(second.lat, second.lng, tileZoom);
    const minX = Math.min(p1[0], p2[0]), maxX = Math.max(p1[0], p2[0]);
    const minY = Math.min(p1[1], p2[1]), maxY = Math.max(p1[1], p2[1]);
    const count = (maxX - minX + 1) * (maxY - minY + 1);
    if (count > 4096) throw new Error(`Слишком большая область: ${count} пикселей (максимум 4096)`);
    return { minX, maxX, minY, maxY };
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      const crosses = ((a.y > point.y) !== (b.y > point.y))
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function orientation(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function segmentsIntersect(a, b, c, d) {
    const abC = orientation(a, b, c), abD = orientation(a, b, d);
    const cdA = orientation(c, d, a), cdB = orientation(c, d, b);
    const epsilon = 1e-7;
    const between = (value, first, second) => value >= Math.min(first, second) - epsilon
      && value <= Math.max(first, second) + epsilon;
    const onSegment = (p, q, r) => Math.abs(orientation(p, q, r)) <= epsilon
      && between(r.x, p.x, q.x) && between(r.y, p.y, q.y);
    if (onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return true;
    return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
  }

  function polygonsIntersect(a, b) {
    if (a.some((point) => pointInPolygon(point, b))) return true;
    if (b.some((point) => pointInPolygon(point, a))) return true;
    for (let ai = 0; ai < a.length; ai += 1) {
      const a1 = a[ai], a2 = a[(ai + 1) % a.length];
      for (let bi = 0; bi < b.length; bi += 1) {
        if (segmentsIntersect(a1, a2, b[bi], b[(bi + 1) % b.length])) return true;
      }
    }
    return false;
  }

  function lasso(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) throw new Error('Контур лассо слишком короткий');
    ensureMapAt(polygon[0]);
    const gridPoints = polygon.map((point) => {
      const lngLat = map.unproject([point.x, point.y]);
      return gridMath.latLonToPixelsFloor(lngLat.lat, lngLat.lng, tileZoom);
    });
    const xs = gridPoints.map((point) => point[0]);
    const ys = gridPoints.map((point) => point[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const candidates = (maxX - minX + 1) * (maxY - minY + 1);
    if (candidates > 100000) throw new Error('Область лассо слишком большая');
    const points = [];
    for (let y = minY; y <= maxY; y += 1) {
      const reverse = (y - minY) % 2 === 1;
      for (let offset = 0; offset <= maxX - minX; offset += 1) {
        const x = reverse ? maxX - offset : minX + offset;
        const pixelPolygon = screenPolygonForPixel(x, y);
        if (!polygonsIntersect(pixelPolygon, polygon)) continue;
        points.push({ gridX: x, gridY: y });
        if (points.length > 4096) throw new Error('В лассо больше 4096 пикселей');
      }
    }
    if (!points.length) throw new Error('Внутри лассо нет пикселей');
    return points;
  }

  // The whole batch runs here so pixels do not round-trip through the content
  // script. The page gets control back only every few milliseconds, because
  // every task boundary lets the browser render a frame of the map first.
  const YIELD_EVERY_MS = 8;
  let runToken = 0;

  // With the template lookup, pixels are grouped by template color: the
  // eyedropper runs once per color (it still selects the color, so the site's
  // own owned-color check and purchase dialog apply), then every pixel of that
  // color is painted with Space alone.
  function groupByTemplateColor(points, lookup) {
    const groups = new Map();
    let skipped = 0;
    for (const point of points) {
      const [lat, lng] = gridMath.pixelsToLatLon(point.gridX + 0.5, point.gridY + 0.5, tileZoom);
      const colorIndex = lookup([lat, lng]);
      if (!Number.isInteger(colorIndex) || alreadyPainted(point.gridX, point.gridY, colorIndex)) {
        skipped += 1;
        continue;
      }
      if (groups.has(colorIndex)) groups.get(colorIndex).push(point);
      else groups.set(colorIndex, [point]);
    }
    return { groups, skipped };
  }

  async function runBatch({ batchId, points }) {
    if (!handlers.move || !handlers.middle || !handlers.down || !handlers.up) throw new Error('Открой режим рисования сайта');
    const token = ++runToken;
    let processed = 0, skipped = 0;
    const report = () => window.postMessage({
      source: 'wac-page', type: 'progress', batchId, processed, skipped,
      remaining: points.length - processed - skipped,
    }, '*');
    let sliceStart = performance.now();
    // Returns false once the batch has been stopped or superseded.
    const yieldIfDue = async () => {
      if (performance.now() - sliceStart >= YIELD_EVERY_MS) {
        report();
        if (performance.now() - lastFlush >= PREVIEW_FLUSH_MS) await flushPreview();
        else await nextTask();
        sliceStart = performance.now();
      }
      return token === runToken;
    };
    const strokeEach = async (list) => {
      for (const point of list) {
        const result = await stroke(point);
        if (result.skipped) skipped += 1;
        else processed += 1;
        if (!await yieldIfDue()) return false;
      }
      return true;
    };

    coalescingBatches += 1;
    lastFlush = performance.now();
    try {
      await loadHotkeys();
      const lookup = await loadTemplateLookup();
      if (token !== runToken) return { stopped: true };
      if (!lookup) {
        if (!await strokeEach(points)) return { stopped: true };
      } else {
        const grouped = groupByTemplateColor(points, lookup);
        skipped += grouped.skipped;
        const canvas = document.querySelector('.maplibregl-canvas');
        for (const [colorIndex, group] of grouped.groups) {
          const picked = await pickColor(group[0].gridX, group[0].gridY);
          if (token !== runToken) return { stopped: true };
          if (picked.skipped) {
            skipped += group.length;
            continue;
          }
          // The site picked something other than the lookup: trust the
          // eyedropper pixel by pixel for this group.
          if (picked.colorIndex !== colorIndex) {
            if (!await strokeEach(group)) return { stopped: true };
            continue;
          }
          for (const point of group) {
            paintPixel(point.gridX, point.gridY, canvas);
            processed += 1;
            if (!await yieldIfDue()) return { stopped: true };
          }
        }
      }
    } finally {
      coalescingBatches -= 1;
      await flushPreview();
      report();
    }
    return { stopped: false };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'wac-content') return;
    const { id, type, payload } = event.data;
    try {
      const result = type === 'runBatch'
        ? await runBatch(payload)
        : type === 'stopBatch'
          ? (runToken += 1, null)
        : type === 'prepareBatch'
          ? await prepareBatch(payload)
        : type === 'rectangle'
          ? rectangle(payload.a, payload.b)
          : type === 'lasso' ? lasso(payload.points) : null;
      window.postMessage({ source: 'wac-page', id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ source: 'wac-page', id, ok: false, error: error?.message || String(error) }, '*');
    }
  });
})();

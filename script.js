const GRID_X = 80, GRID_Y = 60, TILE = 32;
const BASE_PATH = 'textures/blocks/';
const PROTECTED_ROWS = new Set([57, 58, 59]);

let globalFrame = 0;
setInterval(() => { globalFrame++; }, 150);

let blockLibrary = [];
const backgroundLibrary = [
    { name: 'None', file: null, icon: 'textures/ui/SoilBlueprint.png' },
    { name: 'Alien', file: 'Alien.png' }, { name: 'Candy', file: 'Candy.png' },
    { name: 'Cemetery', file: 'Cemetery.png' }, { name: 'City', file: 'City.png' },
    { name: 'Forest', file: 'Forest.png' }, { name: 'Night', file: 'Night.png' },
    { name: 'Sand', file: 'Sand.png' }, { name: 'Star', file: 'Star.png' },
    { name: 'Summer Sky', file: 'SummerSky.png' }, { name: 'Winter', file: 'Winter.png' }
];

const canvas = document.getElementById('worldCanvas');
const ctx = canvas.getContext('2d');
const viewport = document.getElementById('viewport');
const altTextureExistsCache = {};
const glowTextureExistsCache = {};

let fgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let bgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let waterData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let protectedFgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let history = [], redoStack = [];
let historyTimeline = [];
let historyIndex = -1;
let pendingHistoryTimer = null;
let pendingHistoryLabel = null;
let draggingLayerId = null;
let renamingLayerId = null;
let layerClipboard = null;
let layerDeleteTargetId = null;
let layerPanelHasFocus = false;
let layerPanelMouseDownActiveLayerId = null;
let layerPanelShiftSeedId = null;
let layerPanelShiftHandledOnMouseDown = false;
let arrangeLayerHasFocus = false;
let arrangePanelSelectionIds = new Set();
let getArrangePanelSelectionIds = () => arrangePanelSelectionIds;
let selectArrangeLayerFromPanel = null;
let toggleArrangeLayerSelectionFromPanel = null;
let deleteArrangeSelectedLayersFromPanel = null;
let refreshArrangeSelectionBoundsFromPanel = null;
let getArrangeSelectionCount = () => 0;
let activeAtmosphere = null;
let customBgDataUrl = null;
let layerSeq = 1;
let editorLayers = [{ id: layerSeq++, name: 'Layer 1', fg: fgData, bg: bgData, water: waterData, visible: true, locked: false }];
let activeLayerId = editorLayers[0].id;
let selectedLayerId = activeLayerId;

let activeTool = 'move', activeSlot = 1;
let hotbar = Array(10).fill(null);
let bucketBlock = null, shapeBlock = null;
let targetBlockForReplace = null;

let scale = 0.8, posX = 0, posY = 0;
let isPanning = false, isDrawing = false, showGrid = false;
let shapeStart = null;
let shapePreviewEnd = null;
const imgCache = {};
const silhouetteCache = {}; // key: texture src ->black-silhouette canvas (for non-block shadows)

const SETTINGS_STORAGE_KEY = 'pw-world-editor-settings-v1';
const DEFAULT_KEYBINDS = {
    move: 'm',
    arrange: 'a',
    select: 'q',
    bucket: 'f',
    shapes: 's',
    pick: 'k',
    grid: 'g',
    navigate: 'n',
    inventory: 'i',
    layers: 'l',
    history: 'h',
    settings: ','
};
const KEYBIND_LABELS = {
    move: 'Move',
    arrange: 'Arrange',
    select: 'Box Select',
    bucket: 'Fill',
    shapes: 'Shapes',
    pick: 'Pick',
    grid: 'Toggle Grid',
    navigate: 'Navigate Tab',
    inventory: 'Inventory Tab',
    layers: 'Layers Tab',
    history: 'History Tab',
    settings: 'Settings Tab'
};
const HOTBAR_SLOT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
let appSettings = loadAppSettings();
let keybindListeningFor = null;

function makeGrid() {
    return Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
}

function cloneGrid(grid) {
    return JSON.parse(JSON.stringify(grid));
}

function makeLayer(name = `Layer ${editorLayers.length + 1}`) {
    return { id: layerSeq++, name, fg: makeGrid(), bg: makeGrid(), water: makeGrid(), visible: true, locked: false };
}

function splitLegacyWaterLayers(fg, bg, water = makeGrid()) {
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            if (isWaterBlock(bg[x][y])) {
                water[x][y] = bg[x][y];
                bg[x][y] = null;
            }
            if (isWaterBlock(fg[x][y])) {
                water[x][y] = fg[x][y];
                fg[x][y] = null;
            }
        }
    }
    return { fg, bg, water };
}

function loadAppSettings() {
    const fallback = {
        gridColor: '#dc2828',
        animatedBlocks: true,
        keybinds: { ...DEFAULT_KEYBINDS }
    };
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
        const keybinds = { ...fallback.keybinds, ...(saved.keybinds || {}) };
        Object.keys(keybinds).forEach(command => {
            if (/(^|\+)[0-9]$/.test(keybinds[command])) keybinds[command] = '';
        });
        return {
            gridColor: saved.gridColor || fallback.gridColor,
            animatedBlocks: saved.animatedBlocks !== false,
            keybinds
        };
    } catch {
        return fallback;
    }
}

function saveAppSettings() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
}

function eventToKeybind(e) {
    const raw = e.key;
    if (!raw || raw === 'Process' || raw === 'Dead') return '';
    const key = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase().replace(/\s+/g, '');
    if (['control', 'shift', 'alt', 'meta'].includes(key)) return '';
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    parts.push(key);
    return parts.join('+');
}

function formatKeybind(keybind) {
    if (!keybind) return 'None';
    return keybind.split('+').map(part => {
        if (part === 'ctrl') return 'Ctrl';
        if (part === 'shift') return 'Shift';
        if (part === 'alt') return 'Alt';
        if (part === ' ') return 'Space';
        if (part === ',') return ',';
        return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    }).join('+');
}

function keybindMatches(e, keybind) {
    return !!keybind && eventToKeybind(e) === keybind;
}

function isReservedHotbarKeybind(keybind) {
    return /(^|\+)[0-9]$/.test(keybind);
}

function getNextHotbarSlot() {
    const emptySlot = HOTBAR_SLOT_ORDER.find(slot => hotbar[slot] === null);
    return emptySlot ?? activeSlot;
}

function cloneArrangeRegion(region) {
    if (!region) return null;
    return {
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        fg: cloneGrid(region.fg),
        bg: cloneGrid(region.bg),
        water: cloneGrid(region.water || makeGrid())
    };
}

function isProtectedTile(x, y) {
    return x >= 0 && x < GRID_X && y >= 0 && y < GRID_Y && PROTECTED_ROWS.has(y);
}

function clearProtectedRowsFromGrid(grid) {
    for (let x = 0; x < GRID_X; x++) {
        PROTECTED_ROWS.forEach(row => {
            if (grid[x]) grid[x][row] = null;
        });
    }
}

function clearProtectedRowsFromLayers() {
    editorLayers.forEach(layer => {
        clearProtectedRowsFromGrid(layer.fg);
        clearProtectedRowsFromGrid(layer.bg);
        clearProtectedRowsFromGrid(layer.water || makeGrid());
    });
    clearProtectedRowsFromGrid(fgData);
    clearProtectedRowsFromGrid(bgData);
    clearProtectedRowsFromGrid(waterData);
}

function activeLayer() {
    return editorLayers.find(layer => layer.id === activeLayerId) || null;
}

function ensureActiveLayer() {
    let layer = activeLayer();
    if (layer) return layer;

    layer = makeLayer(`Layer ${editorLayers.length + 1}`);
    editorLayers.push(layer);
    activeLayerId = layer.id;
    selectedLayerId = layer.id;
    layerDeleteTargetId = layer.id;
    fgData = layer.fg;
    bgData = layer.bg;
    waterData = layer.water || makeGrid();
    layer.water = waterData;
    renderLayerPanel();
    return layer;
}

function beginGeneratedLayer(name = 'Generated Image', historyLabel = name) {
    flushPendingHistorySnapshot();
    saveHistory(historyLabel);
    flushPendingHistorySnapshot();
    syncActiveLayerRefs();

    const layer = makeLayer(name);
    layer.generated = true;
    const activeIndex = editorLayers.findIndex(item => item.id === activeLayerId);
    editorLayers.splice(activeIndex >= 0 ? activeIndex + 1 : editorLayers.length, 0, layer);
    setActiveLayer(layer.id);
    window.selectionActions?.deselect();
    return layer;
}

function finishGeneratedLayer(historyLabel = 'Generate Image') {
    syncActiveLayerRefs();
    const layer = activeLayer();
    if (layer) {
        layer.arrangeRegion = null;
        layer.resizeOriginal = null;
        layer.renderCache = buildLayerRenderCache(layer);
    }
    recordHistorySnapshot(historyLabel);
    renderLayerPanel();
}

function yieldFrame() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function invalidateLayerRenderCache(layer) {
    if (layer) layer.renderCache = null;
}

function clearActiveArrangeRegion() {
    const layer = activeLayer();
    if (layer) {
        layer.arrangeRegion = null;
        layer.resizeOriginal = null;
        invalidateLayerRenderCache(layer);
    }
}

function layerExists(id) {
    return editorLayers.some(layer => layer.id === id);
}

function normalizeLayerIds(layers, savedLayerSeq = 1) {
    const usedIds = new Set();
    let nextId = Math.max(1, Number(savedLayerSeq) || 1);

    return layers.map((layer, index) => {
        let id = Number(layer.id);
        if (!Number.isFinite(id) || id <= 0 || usedIds.has(id)) {
            while (usedIds.has(nextId)) nextId++;
            id = nextId++;
        }
        usedIds.add(id);
        const split = splitLegacyWaterLayers(
            cloneGrid(layer.fg || makeGrid()),
            cloneGrid(layer.bg || makeGrid()),
            cloneGrid(layer.water || makeGrid())
        );

        return {
            id,
            name: layer.name || `Layer ${index + 1}`,
            fg: split.fg,
            bg: split.bg,
            water: split.water,
            visible: layer.visible !== false,
            locked: !!layer.locked,
            generated: !!layer.generated || /^Img to /i.test(layer.name || ''),
            arrangeRegion: cloneArrangeRegion(layer.arrangeRegion || layer._arrangeRegion),
            resizeOriginal: cloneArrangeRegion(layer.resizeOriginal)
        };
    });
}

function syncActiveLayerRefs() {
    const layer = activeLayer();
    if (!layer) return;
    layer.fg = fgData;
    layer.bg = bgData;
    layer.water = waterData;
}

function setActiveLayer(id, options = {}) {
    if (options.sync !== false) syncActiveLayerRefs();
    const layer = editorLayers.find(item => item.id === id);
    if (!layer) return;
    activeLayerId = layer.id;
    selectedLayerId = layer.id;
    layerDeleteTargetId = layer.id;
    fgData = layer.fg;
    bgData = layer.bg;
    waterData = layer.water || makeGrid();
    layer.water = waterData;
    renderLayerPanel();
}

function selectLayerFromPanel(id, event = null) {
    const toggleArrangeLayer = toggleArrangeLayerSelectionFromPanel || window.selectionActions?.toggleArrangeLayerSelection;
    const selectArrangeLayer = selectArrangeLayerFromPanel || window.selectionActions?.selectArrangeLayer;
    if (event?.shiftKey && toggleArrangeLayer) {
        event.preventDefault();
        const arrangeSelectionIds = getArrangePanelSelectionIds?.() || arrangePanelSelectionIds;
        const seedLayerId = layerPanelShiftSeedId || activeLayerId;
        layerPanelShiftSeedId = null;
        if (!arrangeSelectionIds.size && seedLayerId && seedLayerId !== id && layerExists(seedLayerId) && selectArrangeLayer) {
            selectArrangeLayer(seedLayerId);
        }
        toggleArrangeLayer(id);
        layerPanelHasFocus = true;
        return;
    }
    if (activeTool === 'arrange' && selectArrangeLayer) {
        event?.preventDefault();
        selectArrangeLayer(id);
        layerPanelHasFocus = true;
        return;
    }
    if (window.selectionActions) window.selectionActions.deselect();
    if (activeTool === 'select') updateToolState('move');
    selectedLayerId = id;
    layerDeleteTargetId = id;
    layerPanelHasFocus = true;
    setActiveLayer(id);
}

function captureEditorState() {
    syncActiveLayerRefs();
    clearProtectedRowsFromLayers();
    return {
        layers: editorLayers.map(layer => ({
            id: layer.id,
            name: layer.name,
            fg: cloneGrid(layer.fg),
            bg: cloneGrid(layer.bg),
            water: cloneGrid(layer.water || makeGrid()),
            visible: layer.visible,
            locked: layer.locked,
            generated: !!layer.generated,
            arrangeRegion: cloneArrangeRegion(layer.arrangeRegion),
            resizeOriginal: cloneArrangeRegion(layer.resizeOriginal)
        })),
        activeLayerId,
        layerSeq,
        protectedFg: cloneGrid(protectedFgData),
        atm: activeAtmosphere,
        customBg: customBgDataUrl || null
    };
}

function restoreEditorState(state) {
    if (Array.isArray(state.layers)) {
        editorLayers = normalizeLayerIds(state.layers, state.layerSeq);
        const savedActiveLayerId = Number(state.activeLayerId);
        activeLayerId = layerExists(savedActiveLayerId) ? savedActiveLayerId : (editorLayers[0]?.id || null);
        selectedLayerId = activeLayerId;
        layerDeleteTargetId = activeLayerId;
        layerSeq = Math.max(Number(state.layerSeq) || 1, editorLayers.length ? Math.max(...editorLayers.map(layer => layer.id)) + 1 : 1);
    } else {
        const split = splitLegacyWaterLayers(
            cloneGrid(state.fg || makeGrid()),
            cloneGrid(state.bg || makeGrid()),
            cloneGrid(state.water || makeGrid())
        );
        editorLayers = [{ id: layerSeq++, name: 'Layer 1', fg: split.fg, bg: split.bg, water: split.water, visible: true, locked: false }];
        activeLayerId = editorLayers[0].id;
        selectedLayerId = activeLayerId;
        layerDeleteTargetId = activeLayerId;
    }
    if (state.protectedFg) protectedFgData = cloneGrid(state.protectedFg);
    clearProtectedRowsFromLayers();
    if (activeLayerId) setActiveLayer(activeLayerId, { sync: false });
    else {
        fgData = makeGrid();
        bgData = makeGrid();
        waterData = makeGrid();
    }
    if (state.customBg) applyCustomBackground(state.customBg, false);
    else setBackground(state.atm);
    renderLayerPanel();
}

function composeVisibleLayers(options = {}) {
    syncActiveLayerRefs();
    const fg = makeGrid();
    const bg = makeGrid();
    const water = makeGrid();
    editorLayers.forEach(layer => {
        if (!layer.visible) return;
        if (options.skipCached && layer.renderCache) return;
        for (let x = 0; x < GRID_X; x++) {
            for (let y = 0; y < GRID_Y; y++) {
                if (layer.bg[x][y]) bg[x][y] = layer.bg[x][y];
                if (layer.fg[x][y]) fg[x][y] = layer.fg[x][y];
                if (layer.water?.[x]?.[y]) water[x][y] = layer.water[x][y];
            }
        }
    });
    return { fg, bg, water };
}

function renderLayerPanel() {
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.onmousedown = (e) => {
        const row = e.target.closest('.layer-item');
        if (!row) return;
        const id = Number(row.dataset.layerId);
        if (id) selectLayerFromPanel(id, e);
    };
    list.innerHTML = '';
    [...editorLayers].reverse().forEach(layer => {
        const row = document.createElement('div');
        const arrangeSelectionIds = getArrangePanelSelectionIds?.() || arrangePanelSelectionIds;
        row.className = `layer-item${layer.id === activeLayerId ? ' active' : ''}${arrangeSelectionIds.has(layer.id) ? ' arrange-selected' : ''}${layer.id === layerDeleteTargetId ? ' delete-target' : ''}${layer.locked ? ' locked' : ''}`;
        row.dataset.layerId = layer.id;
        row.draggable = true;
        row.onmousedown = (e) => {
            e.stopPropagation();
            layerPanelMouseDownActiveLayerId = activeLayerId;
            layerPanelShiftHandledOnMouseDown = false;
            layerPanelHasFocus = true;
        };
        row.onclick = (e) => {
            if (e.shiftKey) {
                if (layerPanelShiftHandledOnMouseDown) {
                    layerPanelShiftHandledOnMouseDown = false;
                    return;
                }
                layerPanelShiftSeedId = layerPanelMouseDownActiveLayerId;
                selectLayerFromPanel(layer.id, e);
                return;
            }
            layerPanelShiftHandledOnMouseDown = false;
            selectLayerFromPanel(layer.id, e);
        };
        row.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const arrangeSelectionIds = getArrangePanelSelectionIds?.() || arrangePanelSelectionIds;
            if (!arrangeSelectionIds.has(layer.id)) selectLayerFromPanel(layer.id);
            showLayerContextMenu(e.clientX, e.clientY, layer.id);
        };
        row.ondragstart = (e) => {
            draggingLayerId = layer.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(layer.id));
        };
        row.ondragend = () => {
            draggingLayerId = null;
        };
        row.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        };
        row.ondrop = (e) => {
            e.preventDefault();
            const draggedId = draggingLayerId || Number(e.dataTransfer.getData('text/plain'));
            if (!draggedId || draggedId === layer.id) return;
            const from = editorLayers.findIndex(item => item.id === draggedId);
            const to = editorLayers.findIndex(item => item.id === layer.id);
            if (from < 0 || to < 0) return;
            saveHistory('Move Layer');
            const [moved] = editorLayers.splice(from, 1);
            editorLayers.splice(to, 0, moved);
            draggingLayerId = null;
            renderLayerPanel();
        };

        const thumb = document.createElement('canvas');
        thumb.className = 'layer-thumb';
        thumb.width = 36;
        thumb.height = 28;
        drawLayerThumbnail(layer, thumb);

        const visible = document.createElement('button');
        visible.className = `layer-toggle${layer.visible ? '' : ' off'}`;
        visible.innerHTML = `<img src="textures/ui/${layer.visible ? 'LayerVisible' : 'LayerHidden'}.svg" alt="${layer.visible ? 'Visible' : 'Hidden'}">`;
        visible.title = layer.visible ? 'Hide layer' : 'Show layer';
        visible.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        visible.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            saveHistory(layer.visible ? 'Hide Layer' : 'Show Layer');
            layer.visible = !layer.visible;
            renderLayerPanel();
        };

        let name;
        if (renamingLayerId === layer.id) {
            name = document.createElement('input');
            name.className = 'layer-rename-input';
            name.value = layer.name;
            name.onclick = (e) => e.stopPropagation();
            name.onkeydown = (e) => {
                if (e.key === 'Enter') finishRenameLayer(layer.id, name.value);
                if (e.key === 'Escape') {
                    renamingLayerId = null;
                    renderLayerPanel();
                }
            };
            name.onblur = () => finishRenameLayer(layer.id, name.value);
            setTimeout(() => {
                name.focus();
                name.select();
            }, 0);
        } else {
            name = document.createElement('div');
            name.className = 'layer-title';
            name.textContent = layer.name;
            name.title = 'Double-click or right-click to rename';
            name.ondblclick = (e) => {
                e.stopPropagation();
                startRenameLayer(layer.id);
            };
        }

        const menuDot = document.createElement('div');
        menuDot.className = 'layer-menu-dot';
        menuDot.textContent = layer.locked ? 'L' : '...';
        menuDot.title = 'Layer actions';
        menuDot.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        menuDot.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectLayerFromPanel(layer.id);
            showLayerContextMenu(e.clientX, e.clientY, layer.id);
        };

        row.appendChild(thumb);
        row.appendChild(visible);
        row.appendChild(name);
        row.appendChild(menuDot);
        list.appendChild(row);
    });
}

function drawLayerThumbnail(layer, canvasEl) {
    const tctx = canvasEl.getContext('2d');
    tctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    tctx.fillStyle = '#070707';
    tctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    const cellW = canvasEl.width / GRID_X;
    const cellH = canvasEl.height / GRID_Y;
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const bg = layer.bg[x][y];
            const fg = layer.fg[x][y];
            const water = layer.water?.[x]?.[y];
            if (bg) drawLayerThumbCell(tctx, bg, x * cellW, y * cellH, cellW, cellH, '#315071');
            if (fg) drawLayerThumbCell(tctx, fg, x * cellW, y * cellH, cellW, cellH, '#31c7c9');
            if (water) drawLayerThumbCell(tctx, water, x * cellW, y * cellH, cellW, cellH, '#2c7fd1');
        }
    }
}

function drawLayerThumbCell(tctx, block, x, y, w, h, fallback) {
    const img = block?.texture ? getImg(block.texture) : null;
    const drawW = Math.max(1, Math.ceil(w));
    const drawH = Math.max(1, Math.ceil(h));
    if (img && img.complete && img.naturalWidth > 0) {
        tctx.drawImage(img, x, y, drawW, drawH);
        return;
    }
    tctx.fillStyle = fallback;
    tctx.fillRect(x, y, drawW, drawH);
}

function getLayerContentBounds(layer) {
    if (layer?.arrangeRegion) {
        const r = layer.arrangeRegion;
        return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    let minX = GRID_X, minY = GRID_Y, maxX = -1, maxY = -1;
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            if (!layer.fg[x][y] && !layer.bg[x][y] && !layer.water?.[x]?.[y]) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function findTopLayerAtTile(x, y) {
    if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return null;
    for (let i = editorLayers.length - 1; i >= 0; i--) {
        const layer = editorLayers[i];
        if (!layer.visible) continue;
        if (layer.fg[x]?.[y] || layer.bg[x]?.[y] || layer.water?.[x]?.[y]) return layer;
    }
    return null;
}

function hideLayerContextMenu() {
    document.getElementById('layer-context-menu')?.classList.add('hidden');
    document.getElementById('arrange-context-menu')?.classList.add('hidden');
}

function showLayerContextMenu(x, y, layerId) {
    const menu = document.getElementById('layer-context-menu');
    if (!menu) return;
    document.getElementById('arrange-context-menu')?.classList.add('hidden');
    menu.dataset.layerId = layerId;
    menu.classList.remove('hidden');
    const maxX = window.innerWidth - menu.offsetWidth - 6;
    const maxY = window.innerHeight - menu.offsetHeight - 6;
    menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(30, Math.min(y, maxY))}px`;
}

function setMenuPosition(menu, x, y) {
    const maxX = window.innerWidth - menu.offsetWidth - 6;
    const maxY = window.innerHeight - menu.offsetHeight - 6;
    menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(30, Math.min(y, maxY))}px`;
}

function showArrangeContextMenu(x, y, layerId) {
    const menu = document.getElementById('arrange-context-menu');
    if (!menu) return;
    document.getElementById('layer-context-menu')?.classList.add('hidden');
    const targets = getLayerActionTargets(layerId);
    const anyVisible = targets.some(layer => layer.visible !== false);
    const anyUnlocked = targets.some(layer => !layer.locked);
    const visibilityLabel = menu.querySelector('[data-arrange-action="toggle-visible"] .menu-label');
    const lockLabel = menu.querySelector('[data-arrange-action="toggle-lock"] .menu-label');
    if (visibilityLabel) visibilityLabel.textContent = anyVisible ? 'Hide layer' : 'Show layer';
    if (lockLabel) lockLabel.textContent = anyUnlocked ? 'Lock layer' : 'Unlock layer';
    menu.dataset.layerId = layerId;
    menu.classList.remove('hidden');
    setMenuPosition(menu, x, y);
}

function startRenameLayer(layerId) {
    renamingLayerId = layerId;
    renderLayerPanel();
}

function finishRenameLayer(layerId, value) {
    const layer = editorLayers.find(item => item.id === layerId);
    if (!layer) return;
    const nextName = value.trim();
    renamingLayerId = null;
    if (nextName && nextName !== layer.name) {
        saveHistory('Rename Layer');
        layer.name = nextName;
    }
    renderLayerPanel();
}

function addLayer() {
    saveHistory('New Layer');
    syncActiveLayerRefs();
    const layer = makeLayer(`Layer ${editorLayers.length + 1}`);
    const activeIndex = editorLayers.findIndex(item => item.id === activeLayerId);
    editorLayers.splice(activeIndex + 1, 0, layer);
    setActiveLayer(layer.id);
}

function duplicateLayer() {
    const source = activeLayer();
    if (!source) return;
    saveHistory('Duplicate Layer');
    const layer = { id: layerSeq++, name: `${source.name} copy`, fg: cloneGrid(source.fg), bg: cloneGrid(source.bg), water: cloneGrid(source.water || makeGrid()), visible: true, locked: false, arrangeRegion: cloneArrangeRegion(source.arrangeRegion), resizeOriginal: cloneArrangeRegion(source.resizeOriginal) };
    const activeIndex = editorLayers.findIndex(item => item.id === source.id);
    editorLayers.splice(activeIndex + 1, 0, layer);
    setActiveLayer(layer.id);
}

function deleteLayer(targetLayerId) {
    window.selectionActions?.deselect();
    const requestedId = typeof targetLayerId === 'number' ? targetLayerId : Number(targetLayerId);
    const activeRowId = Number(document.querySelector('#layer-list .layer-item.active')?.dataset.layerId);
    const deleteTargetRowId = Number(document.querySelector('#layer-list .layer-item.delete-target')?.dataset.layerId);
    const candidateIds = [
        requestedId,
        activeRowId,
        deleteTargetRowId,
        selectedLayerId,
        layerDeleteTargetId,
        activeLayerId
    ];
    const targetId = candidateIds.find(id => Number.isFinite(id) && id > 0 && layerExists(id));
    const index = editorLayers.findIndex(item => item.id === targetId);
    if (index < 0) return;
    saveHistory('Delete Layer');
    editorLayers.splice(index, 1);
    const nextLayer = editorLayers[Math.min(index, editorLayers.length - 1)] || editorLayers[Math.max(0, index - 1)];
    if (nextLayer) {
        layerDeleteTargetId = nextLayer.id;
        selectedLayerId = nextLayer.id;
        setActiveLayer(nextLayer.id, { sync: false });
    } else {
        activeLayerId = null;
        selectedLayerId = null;
        layerDeleteTargetId = null;
        fgData = makeGrid();
        bgData = makeGrid();
        renderLayerPanel();
    }
}

function moveActiveLayer(offset) {
    const index = editorLayers.findIndex(item => item.id === activeLayerId);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= editorLayers.length) return;
    saveHistory('Move Layer');
    [editorLayers[index], editorLayers[next]] = [editorLayers[next], editorLayers[index]];
    renderLayerPanel();
}

function mergeVisibleLayers() {
    syncActiveLayerRefs();
    const visibleLayers = editorLayers.filter(layer => layer.visible);
    if (visibleLayers.length <= 1) return alert('Need at least two visible layers to merge.');

    saveHistory('Merge Visible Layers');
    const mergedData = composeVisibleLayers();
    const firstVisibleIndex = editorLayers.findIndex(layer => layer.visible);
    const mergedLayer = {
        id: layerSeq++,
        name: `Layer ${layerSeq - 1}`,
        fg: mergedData.fg,
        bg: mergedData.bg,
        water: mergedData.water,
        visible: true,
        locked: false
    };

    editorLayers = editorLayers.filter(layer => !layer.visible);
    editorLayers.splice(Math.max(0, firstVisibleIndex), 0, mergedLayer);
    layerDeleteTargetId = mergedLayer.id;
    selectedLayerId = mergedLayer.id;
    setActiveLayer(mergedLayer.id, { sync: false });
}

function cloneLayerForClipboard(source) {
    return {
        name: source.name,
        fg: cloneGrid(source.fg),
        bg: cloneGrid(source.bg),
        water: cloneGrid(source.water || makeGrid()),
        visible: source.visible,
        locked: false,
        arrangeRegion: cloneArrangeRegion(source.arrangeRegion),
        resizeOriginal: cloneArrangeRegion(source.resizeOriginal)
    };
}

function getLayerCopySources(preferredLayerId = null) {
    const arrangeSelectionIds = getArrangePanelSelectionIds?.() || arrangePanelSelectionIds;
    const selectedLayers = editorLayers.filter(layer => arrangeSelectionIds.has(layer.id));
    if (selectedLayers.length > 1) return selectedLayers;
    const preferredLayer = editorLayers.find(layer => layer.id === preferredLayerId);
    return preferredLayer ? [preferredLayer] : (activeLayer() ? [activeLayer()] : []);
}

function getLayerActionTargets(preferredLayerId = null) {
    return getLayerCopySources(preferredLayerId);
}

function setActiveLayerAfterLayerListChange(preferredIndex = 0) {
    const nextLayer = editorLayers[Math.min(preferredIndex, editorLayers.length - 1)] || editorLayers[editorLayers.length - 1] || null;
    if (nextLayer) {
        arrangePanelSelectionIds.clear();
        activeLayerId = nextLayer.id;
        selectedLayerId = nextLayer.id;
        layerDeleteTargetId = nextLayer.id;
        fgData = nextLayer.fg;
        bgData = nextLayer.bg;
        waterData = nextLayer.water || makeGrid();
        nextLayer.water = waterData;
    } else {
        activeLayerId = null;
        selectedLayerId = null;
        layerDeleteTargetId = null;
        fgData = makeGrid();
        bgData = makeGrid();
        waterData = makeGrid();
    }
}

function copyActiveLayer(preferredLayerId = null) {
    syncActiveLayerRefs();
    const sources = getLayerCopySources(preferredLayerId);
    if (!sources.length) return;
    layerClipboard = {
        layers: sources.map(cloneLayerForClipboard)
    };
}

function pasteLayer() {
    if (!layerClipboard) return;
    const clipboardLayers = Array.isArray(layerClipboard.layers) ? layerClipboard.layers : [layerClipboard];
    if (!clipboardLayers.length) return;
    saveHistory('Paste Layer');
    syncActiveLayerRefs();
    const pastedLayers = clipboardLayers.map(clip => ({
        id: layerSeq++,
        name: `${clip.name || 'Layer'} copy`,
        fg: cloneGrid(clip.fg),
        bg: cloneGrid(clip.bg),
        water: cloneGrid(clip.water || makeGrid()),
        visible: clip.visible !== false,
        locked: false,
        arrangeRegion: cloneArrangeRegion(clip.arrangeRegion),
        resizeOriginal: cloneArrangeRegion(clip.resizeOriginal)
    }));
    const activeIndex = editorLayers.findIndex(item => item.id === activeLayerId);
    editorLayers.splice(activeIndex >= 0 ? activeIndex + 1 : editorLayers.length, 0, ...pastedLayers);
    const activePastedLayer = pastedLayers[pastedLayers.length - 1];
    activeLayerId = activePastedLayer.id;
    selectedLayerId = activePastedLayer.id;
    layerDeleteTargetId = activePastedLayer.id;
    fgData = activePastedLayer.fg;
    bgData = activePastedLayer.bg;
    waterData = activePastedLayer.water || makeGrid();
    activePastedLayer.water = waterData;
    arrangePanelSelectionIds = new Set(pastedLayers.map(layer => layer.id));
    window.selectionActions?.selectArrangeLayers?.(pastedLayers, activePastedLayer.id);
    renderLayerPanel();
}

function setTargetLayersVisibility(preferredLayerId, visible) {
    const targets = getLayerActionTargets(preferredLayerId);
    if (!targets.length) return;
    saveHistory(visible ? 'Show Layers' : 'Hide Layers');
    targets.forEach(layer => layer.visible = visible);
    renderLayerPanel();
}

function setTargetLayersLocked(preferredLayerId, locked) {
    const targets = getLayerActionTargets(preferredLayerId);
    if (!targets.length) return;
    saveHistory(locked ? 'Lock Layers' : 'Unlock Layers');
    targets.forEach(layer => layer.locked = locked);
    renderLayerPanel();
}

function duplicateTargetLayers(preferredLayerId = null) {
    syncActiveLayerRefs();
    const sources = getLayerActionTargets(preferredLayerId);
    if (!sources.length) return;
    saveHistory(sources.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer');
    const insertIndex = Math.max(...sources.map(layer => editorLayers.findIndex(item => item.id === layer.id))) + 1;
    const copies = sources.map(source => ({
        id: layerSeq++,
        name: `${source.name} copy`,
        fg: cloneGrid(source.fg),
        bg: cloneGrid(source.bg),
        water: cloneGrid(source.water || makeGrid()),
        visible: source.visible !== false,
        locked: false,
        arrangeRegion: cloneArrangeRegion(source.arrangeRegion),
        resizeOriginal: cloneArrangeRegion(source.resizeOriginal)
    }));
    editorLayers.splice(insertIndex, 0, ...copies);
    const activeCopy = copies[copies.length - 1];
    activeLayerId = activeCopy.id;
    selectedLayerId = activeCopy.id;
    layerDeleteTargetId = activeCopy.id;
    fgData = activeCopy.fg;
    bgData = activeCopy.bg;
    waterData = activeCopy.water || makeGrid();
    activeCopy.water = waterData;
    arrangePanelSelectionIds = new Set(copies.map(layer => layer.id));
    window.selectionActions?.selectArrangeLayers?.(copies, activeCopy.id);
    renderLayerPanel();
}

function deleteTargetLayers(preferredLayerId = null) {
    const targets = getLayerActionTargets(preferredLayerId);
    if (!targets.length) return;
    const ids = new Set(targets.map(layer => layer.id));
    const firstIndex = editorLayers.findIndex(layer => ids.has(layer.id));
    saveHistory(targets.length > 1 ? 'Delete Layers' : 'Delete Layer');
    window.selectionActions?.deselect();
    editorLayers = editorLayers.filter(layer => !ids.has(layer.id));
    setActiveLayerAfterLayerListChange(Math.max(0, firstIndex));
    renderLayerPanel();
}

function cutTargetLayers(preferredLayerId = null) {
    const targets = getLayerActionTargets(preferredLayerId);
    if (!targets.length) return;
    copyActiveLayer(preferredLayerId);
    deleteTargetLayers(preferredLayerId);
}

function copyLayerBoundsData(layer, bounds) {
    const fg = [], bg = [], water = [];
    for (let dx = 0; dx < bounds.w; dx++) {
        fg[dx] = [];
        bg[dx] = [];
        water[dx] = [];
        for (let dy = 0; dy < bounds.h; dy++) {
            const x = bounds.x + dx;
            const y = bounds.y + dy;
            fg[dx][dy] = layer.fg[x][y] ? JSON.parse(JSON.stringify(layer.fg[x][y])) : null;
            bg[dx][dy] = layer.bg[x][y] ? JSON.parse(JSON.stringify(layer.bg[x][y])) : null;
            water[dx][dy] = layer.water?.[x]?.[y] ? JSON.parse(JSON.stringify(layer.water[x][y])) : null;
        }
    }
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, fg, bg, water };
}

function invertTargetLayerImage(preferredLayerId = null) {
    const targets = getLayerActionTargets(preferredLayerId);
    if (!targets.length) return;
    saveHistory('Flip Image');
    for (const layer of targets) {
        const bounds = getLayerContentBounds(layer);
        if (!bounds) continue;
        const nextFg = cloneGrid(layer.fg);
        const nextBg = cloneGrid(layer.bg);
        const nextWater = cloneGrid(layer.water || makeGrid());
        for (let dx = 0; dx < bounds.w; dx++) {
            for (let dy = 0; dy < bounds.h; dy++) {
                const fromX = bounds.x + dx;
                const toX = bounds.x + bounds.w - 1 - dx;
                const y = bounds.y + dy;
                nextFg[toX][y] = layer.fg[fromX][y] ? JSON.parse(JSON.stringify(layer.fg[fromX][y])) : null;
                nextBg[toX][y] = layer.bg[fromX][y] ? JSON.parse(JSON.stringify(layer.bg[fromX][y])) : null;
                nextWater[toX][y] = layer.water?.[fromX]?.[y] ? JSON.parse(JSON.stringify(layer.water[fromX][y])) : null;
            }
        }
        layer.fg = nextFg;
        layer.bg = nextBg;
        layer.water = nextWater;
        if (layer.arrangeRegion) {
            layer.arrangeRegion = copyLayerBoundsData(layer, bounds);
        }
        if (layer.resizeOriginal) {
            layer.resizeOriginal = cloneArrangeRegion(layer.arrangeRegion);
        }
        if (layer.id === activeLayerId) {
            fgData = layer.fg;
            bgData = layer.bg;
            waterData = layer.water;
        }
    }
    renderLayerPanel();
    refreshArrangeSelectionBoundsFromPanel?.();
}

function setArrangeTool() {
    updateToolState('arrange');
    activeTool = 'arrange';
    window.selectionActions?.deselect({ preserveLayerSelection: true });
    refreshArrangeSelectionBoundsFromPanel?.();
}

function activeLayerLocked() {
    const layer = activeLayer();
    return !!(layer && layer.locked);
}

function renderHistoryPanel() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';
    const start = Math.max(0, historyTimeline.length - 18);
    historyTimeline.slice(start).forEach((entry, index) => {
        const absoluteIndex = start + index;
        const row = document.createElement('div');
        row.className = `history-item${absoluteIndex === historyIndex ? ' current' : ''}`;
        const name = document.createElement('span');
        name.textContent = entry.label;
        const mark = document.createElement('span');
        mark.textContent = absoluteIndex === historyIndex ? 'now' : '';
        row.onclick = () => restoreHistoryAt(absoluteIndex);
        row.appendChild(name);
        row.appendChild(mark);
        list.appendChild(row);
    });
}

function recordHistorySnapshot(label = 'Edit') {
    syncActiveLayerRefs();
    if (historyIndex < historyTimeline.length - 1) {
        historyTimeline = historyTimeline.slice(0, historyIndex + 1);
    }
    const state = captureEditorState();
    const last = historyTimeline[historyTimeline.length - 1];
    if (last && JSON.stringify(last.state) === JSON.stringify(state)) {
        renderHistoryPanel();
        renderLayerPanel();
        return;
    }
    historyTimeline.push({ label, state });
    if (historyTimeline.length > 80) historyTimeline.shift();
    historyIndex = historyTimeline.length - 1;
    renderHistoryPanel();
    renderLayerPanel();
}

function scheduleHistorySnapshot(label = 'Edit') {
    clearTimeout(pendingHistoryTimer);
    pendingHistoryLabel = label;
    pendingHistoryTimer = setTimeout(flushPendingHistorySnapshot, 120);
}

function flushPendingHistorySnapshot() {
    if (!pendingHistoryTimer && !pendingHistoryLabel) return;
    clearTimeout(pendingHistoryTimer);
    pendingHistoryTimer = null;
    const label = pendingHistoryLabel || 'Edit';
    pendingHistoryLabel = null;
    recordHistorySnapshot(label);
}

function restoreHistoryAt(index, options = {}) {
    if (options.flush !== false) flushPendingHistorySnapshot();
    if (index < 0 || index >= historyTimeline.length) return;
    historyIndex = index;
    restoreEditorState(historyTimeline[index].state);
    window.selectionActions?.deselect();
    arrangePanelSelectionIds.clear();
    arrangeLayerHasFocus = false;
    renderHistoryPanel();
}

function autoLoadAssets() {
    if (typeof ASSET_LIST === 'undefined') {
        console.error("ASSET_LIST is missing");
        return;
    }

    // Build full candidate list
    const allCandidates = ASSET_LIST.map(asset => {
        const cleanName = asset.file
            .replace('_0.png', '')
            .replace('.png', '')
            .replace(/_/g, ' ');
        return {
            name: cleanName,
            fileName: asset.file,
            type: asset.folder === 'background' ? 'wall' : (asset.folder === 'water' ? 'water' : (asset.folder === 'prop' ? 'prop' : 'block')),
            texture: `${BASE_PATH}${asset.folder}/${asset.file}`,
            folder: asset.folder
        };
    });

    // Preload every texture; only keep entries whose image loads successfully.
    const promises = allCandidates.map(entry => new Promise(resolve => {
        const img = new Image();
        imgCache[entry.texture] = img;
        img.onload  = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = entry.texture;
    }));

    Promise.all(promises).then(results => {
        blockLibrary = allCandidates.filter((_, i) => results[i]);
        generateDefaultFloor();
        initUI();
        recordHistorySnapshot('Open');
    });

    function generateDefaultFloor() {
        const findBlock = (filename) => blockLibrary.find(b => b.fileName === filename);

        const bedrock = findBlock('Bedrock.png');
        const lavaRock = findBlock('End Lava Rock.png');
        const lava = findBlock('End Lava.png');

        for (let x = 0; x < GRID_X; x++) {
            if (bedrock) protectedFgData[x][57] = JSON.parse(JSON.stringify(bedrock));
            if (lavaRock) protectedFgData[x][58] = JSON.parse(JSON.stringify(lavaRock));
            if (lava) protectedFgData[x][59] = JSON.parse(JSON.stringify(lava));
        }
        clearProtectedRowsFromLayers();
    }
}

function getBlockTexture(x, y, block) {
    if (!block) return null;
    if (appSettings.animatedBlocks && block.fileName.includes('_0.png')) {
        const baseName = block.fileName.replace('_0.png', '');
        const frames = ASSET_LIST.filter(a =>
            a.file.startsWith(baseName + '_') && a.folder === block.folder
        );

        if (frames.length > 1) {
            const speed = 150; // ms per frame
            const currentFrame = Math.floor(performance.now() / speed) % frames.length;
            const animatedFileName = `${baseName}_${currentFrame}.png`;
            return getImg(`${BASE_PATH}${block.folder}/${animatedFileName}`);
        }
    }
    const altName = block.fileName.replace('.png', '_Alt.png');
    const isTopExposed = y === 0 || (fgData[x][y-1] === null || fgData[x][y-1]?.type === 'prop');
    const altKey = `${block.folder}/${altName}`;
    if (altTextureExistsCache[altKey] === undefined) {
        altTextureExistsCache[altKey] = ASSET_LIST.some(a => a.file === altName && a.folder === block.folder);
    }
    const hasAlt = altTextureExistsCache[altKey];

    if (isTopExposed && hasAlt) {
        return getImg(`${BASE_PATH}${block.folder}/${altName}`);
    }

    return getImg(block.texture);
}

function getStaticBlockTexture(block) {
    if (!block) return null;
    return getImg(block.texture);
}

function drawCachedLayerCell(cacheCtx, block, x, y) {
    const tex = getStaticBlockTexture(block);
    if (tex && tex.complete && tex.naturalWidth > 0) {
        cacheCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
    }
}

function drawCachedLayerShadow(cacheCtx, layer, x, y, block) {
    if (!shouldCastShadow(block)) return;
    const tex = getStaticBlockTexture(block);
    const silhouette = getShadowSilhouette(tex);
    if (!silhouette) return;
    const offsetX = block.type === 'prop' ? PROP_SHADOW_OFFSET_X : SHADOW_OFFSET;
    const offsetY = block.type === 'prop' ? PROP_SHADOW_OFFSET_Y : SHADOW_OFFSET;
    const px = x * TILE + offsetX;
    const py = y * TILE + offsetY;
    const minBx = Math.floor(px / TILE);
    const maxBx = Math.floor((px + TILE - 1) / TILE);
    const minBy = Math.floor(py / TILE);
    const maxBy = Math.floor((py + TILE - 1) / TILE);
    for (let bx = minBx; bx <= maxBx; bx++) {
        for (let by = minBy; by <= maxBy; by++) {
            if (bx < 0 || bx >= GRID_X || by < 0 || by >= GRID_Y) continue;
            if (!layer.bg?.[bx]?.[by] || isWaterBlock(layer.bg[bx][by]) || layer.water?.[bx]?.[by]) continue;
            const clipX = Math.max(px, bx * TILE);
            const clipY = Math.max(py, by * TILE);
            const clipW = Math.min(px + TILE, bx * TILE + TILE) - clipX;
            const clipH = Math.min(py + TILE, by * TILE + TILE) - clipY;
            if (clipW <= 0 || clipH <= 0) continue;
            cacheCtx.save();
            cacheCtx.globalAlpha = SHADOW_ALPHA;
            cacheCtx.beginPath();
            cacheCtx.rect(clipX, clipY, clipW, clipH);
            cacheCtx.clip();
            cacheCtx.drawImage(silhouette, px, py, TILE, TILE);
            cacheCtx.restore();
        }
    }
}

function buildLayerRenderCache(layer) {
    if (!layer) return null;
    const cache = document.createElement('canvas');
    cache.width = canvas.width;
    cache.height = canvas.height;
    const cacheCtx = cache.getContext('2d');

    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const bg = layer.bg?.[x]?.[y];
            if (bg && !isWaterBlock(bg)) drawCachedLayerCell(cacheCtx, bg, x, y);
        }
    }
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const fg = layer.fg?.[x]?.[y];
            if (fg && !isWaterBlock(fg)) drawCachedLayerShadow(cacheCtx, layer, x, y, fg);
        }
    }
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const water = layer.water?.[x]?.[y] || (isWaterBlock(layer.fg?.[x]?.[y]) ? layer.fg[x][y] : null) || (isWaterBlock(layer.bg?.[x]?.[y]) ? layer.bg[x][y] : null);
            if (water) drawCachedLayerCell(cacheCtx, water, x, y);
        }
    }
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const fg = layer.fg?.[x]?.[y];
            if (fg && !isWaterBlock(fg)) drawCachedLayerCell(cacheCtx, fg, x, y);
        }
    }
    return cache;
}

function saveHistory(label = 'Edit') {
    syncActiveLayerRefs();
    if (history.length > 50) history.shift();
    history.push(captureEditorState());
    scheduleHistorySnapshot(label);
    redoStack = []; // any new action clears redo
}

function undo() {
    flushPendingHistorySnapshot();
    if (historyTimeline.length > 0 && historyIndex <= 0) return;
    if (historyIndex > 0) {
        restoreHistoryAt(historyIndex - 1, { flush: false });
        return;
    }
}

function redo() {
    flushPendingHistorySnapshot();
    if (historyTimeline.length > 0 && historyIndex >= historyTimeline.length - 1) return;
    if (historyIndex >= 0 && historyIndex < historyTimeline.length - 1) {
        restoreHistoryAt(historyIndex + 1, { flush: false });
        return;
    }
}

function handleHistoryShortcut(e) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return true;
    }
    if (key === 'r' || key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
        return true;
    }
    return false;
}

document.addEventListener('keydown', handleHistoryShortcut, true);

document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (activeTool === 'select') return;
    if (key === 'c') {
        e.preventDefault();
        copyActiveLayer();
    }
    if (key === 'v') {
        e.preventDefault();
        pasteLayer();
    }
}, true);

function getImg(src) {
    if (!src) return null;
    if (!imgCache[src]) { imgCache[src] = new Image(); imgCache[src].src = src; }
    return imgCache[src];
}

function cloneBlock(block) {
    return JSON.parse(JSON.stringify(block));
}

function isWaterBlock(block) {
    return !!block && (block.type === 'water' || block.folder === 'water');
}

function usesBackgroundLayer(block) {
    return !!block && block.type === 'wall';
}

// Returns true if a prop block is a platform (renders in front of water).
function isPlatformBlock(block) {
    return !!block && block.type === 'prop' && /platform/i.test(block.name || block.fileName || '');
}

function placeBlockAt(x, y, block) {
    if (!block || x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return;
    if (isProtectedTile(x, y)) return;
    ensureActiveLayer();
    if (activeLayerLocked()) return;
    clearActiveArrangeRegion();

    // Wall/background blocks go to the background layer.
    if (usesBackgroundLayer(block)) {
        if (isWaterBlock(bgData[x][y])) waterData[x][y] = cloneBlock(bgData[x][y]);
        bgData[x][y] = cloneBlock(block);
        scheduleHistorySnapshot('Place Block');
        return;
    }

    // Water uses its own top layer so backgrounds and props can sit below it.
    if (isWaterBlock(block)) {
        if (isWaterBlock(fgData[x][y])) fgData[x][y] = null;
        if (isWaterBlock(bgData[x][y])) bgData[x][y] = null;
        waterData[x][y] = cloneBlock(block);
        scheduleHistorySnapshot('Place Block');
        return;
    }

    if (isWaterBlock(fgData[x][y])) {
        waterData[x][y] = cloneBlock(fgData[x][y]);
        fgData[x][y] = null;
    }

    fgData[x][y] = cloneBlock(block);
    scheduleHistorySnapshot('Place Block');
}

function setBackground(bgFile) {
    activeAtmosphere = bgFile;
    if (!bgFile) {
        canvas.style.backgroundImage = 'none';
        canvas.style.backgroundSize = 'cover';
        return;
    }
    canvas.style.backgroundImage = bgFile ? `url("textures/orbs/${bgFile}")` : 'none';
    canvas.style.backgroundSize = 'cover';
    if (typeof customBgDataUrl !== 'undefined' && customBgDataUrl && bgFile) {
        customBgDataUrl = null;
        const el = document.getElementById('custom-bg-preview');
        if (el) el.classList.add('hidden');
    }
}

function updateTransform() {
    const transform = `translate(-50%, -50%) translate3d(${posX}px, ${posY}px, 0) scale(${scale})`;
    canvas.style.transform = transform;
    const selectionCanvas = document.getElementById('selectionCanvas');
    if (selectionCanvas) selectionCanvas.style.transform = transform;
    if (document.getElementById('ref-overlay-layer')) updateRefOverlay();
}

// --- Inventory state ---
let invFilterFolder = 'all'; // current folder filter for main inventory
let sideInvFilterFolder = 'all';
// Per-button cached data for fast filtering (avoids DOM reads on every keystroke)
// invBtnData[i] = { el, nameLower, folder } for the main inventory list
let invBtnData = [];
let sideInvBtnData = [];

function initUI() {
    const invList = document.getElementById('block-list');
    const bucketList = document.getElementById('block-list-bucket');
    const shapesList = document.getElementById('block-list-shapes');
    const bgList = document.getElementById('bg-list');
    const replaceSuggestions = document.getElementById('clear-suggestions');

    [invList, bucketList, shapesList, bgList, replaceSuggestions].forEach(l => { if(l) l.innerHTML = ''; });
    invBtnData = [];

    // Use a DocumentFragment for batch DOM insertion (fast)
    const invFrag = document.createDocumentFragment();
    const bucketFrag = document.createDocumentFragment();
    const shapesFrag = document.createDocumentFragment();
    const replaceFrag = document.createDocumentFragment();

    blockLibrary.forEach(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return;

        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== "0") return;

        const uiDisplayName = b.fileName
            .replace('_0.png', '')
            .replace('.png', '')
            .replace(/_/g, ' ');
        const nameLower = uiDisplayName.toLowerCase();

        // --- Main inventory button ---
        const invBtn = document.createElement('div');
        invBtn.className = 'block-btn';
        invBtn.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;
        // Hide if image fails to load (catches textures missing at runtime)

        invBtn.onclick = () => {
            putBlockInHotbar(b);
            closeAll();
        };
        invFrag.appendChild(invBtn);
        invBtnData.push({ el: invBtn, nameLower, folder: b.folder });

        // --- Bucket / Shapes buttons ---
        const makeSimpleBtn = (callback) => {
            const btn = document.createElement('div');
            btn.className = 'block-btn';
            btn.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;

            btn.onclick = () => callback(b);
            return btn;
        };
        if (bucketList) bucketFrag.appendChild(makeSimpleBtn(block => { bucketBlock = block; updateToolState('bucket'); closeAll(); }));
        if (shapesList) shapesFrag.appendChild(makeSimpleBtn(block => { shapeBlock = block; updateToolState('shapes'); closeAll(); }));

        // --- Replace suggestions button ---
        const suggest = document.createElement('div');
        suggest.className = 'block-btn';
        suggest.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;

        suggest.onclick = () => {
            targetBlockForReplace = b;
            document.getElementById('clear-search').value = uiDisplayName;
            document.getElementById('replace-desc').innerText = `Replacing all "${uiDisplayName}" with your active hotbar block.`;
            document.getElementById('replace-controls').classList.remove('hidden');
            replaceSuggestions.classList.add('hidden');
        };
        replaceFrag.appendChild(suggest);
    });

    invList.appendChild(invFrag);
    if (bucketList) bucketList.appendChild(bucketFrag);
    if (shapesList) shapesList.appendChild(shapesFrag);
    replaceSuggestions.appendChild(replaceFrag);
    renderSideInventory();

    // --- Background list ---
    backgroundLibrary.forEach(bg => {
        const btn = document.createElement('div');
        btn.className = 'block-btn';
        const iconSrc = bg.file ? `textures/orbs/${bg.file}` : bg.icon;
        btn.innerHTML = `<img src="${iconSrc}"><span>${bg.name}</span>`;
        btn.onclick = () => { saveHistory(); setBackground(bg.file); closeAll(); };
        bgList.appendChild(btn);
    });

    // --- Filter tab buttons ---
    document.querySelectorAll('.inv-filter-btn').forEach(btn => {
        btn.onclick = () => {
            invFilterFolder = btn.dataset.filter;
            document.querySelectorAll('.inv-filter-btn').forEach(b => b.classList.remove('highlight'));
            btn.classList.add('highlight');
            applyInvFilter(document.getElementById('inv-search').value);
        };
    });
}

function putBlockInHotbar(block) {
    let targetSlot = getNextHotbarSlot();
    hotbar[targetSlot] = block;
    const slot = document.querySelector(`.slot[data-slot="${targetSlot}"]`);
    if (slot) slot.innerHTML = `<img src="${block.texture}">`;
    selectSlot(targetSlot);
}

function renderSideInventory() {
    const list = document.getElementById('side-inventory-list');
    if (!list) return;
    list.innerHTML = '';
    sideInvBtnData = [];
    blockLibrary.forEach(block => {
        if (block.fileName.includes('_Alt') || block.fileName.includes('_Glow')) return;
        const frameMatch = block.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== "0") return;
        const displayName = block.fileName.replace('_0.png', '').replace('.png', '').replace(/_/g, ' ');
        const btn = document.createElement('button');
        btn.className = 'side-inv-item';
        btn.title = displayName;
        btn.innerHTML = `<img src="${block.texture}" alt="">`;
        btn.onclick = () => putBlockInHotbar(block);
        list.appendChild(btn);
        sideInvBtnData.push({ el: btn, nameLower: displayName.toLowerCase(), folder: block.folder });
    });
    applySideInvFilter();
}

function applySideInvFilter() {
    const search = document.getElementById('side-inv-search');
    const term = (search?.value || '').toLowerCase();
    for (const item of sideInvBtnData) {
        const folderMatch = sideInvFilterFolder === 'all' || item.folder === sideInvFilterFolder;
        const nameMatch = !term || item.nameLower.includes(term);
        item.el.style.display = (folderMatch && nameMatch) ? '' : 'none';
    }
}

// Fast inventory filter -reads pre-cached data, never touches innerText or querySelectorAll
function applyInvFilter(term) {
    const termLower = term.toLowerCase();
    const folder = invFilterFolder;
    for (const item of invBtnData) {
        const folderMatch = folder === 'all' || item.folder === folder;
        const nameMatch = !termLower || item.nameLower.includes(termLower);
        item.el.style.display = (folderMatch && nameMatch) ? '' : 'none';
    }
}

// Generic filter for bucket/shapes/replace lists (these are smaller, no need for heavy optimization)
function filterList(listId, term) {
    const termLower = term.toLowerCase();
    const list = document.getElementById(listId);
    const btns = list.children; // faster than querySelectorAll
    for (let i = 0; i < btns.length; i++) {
        const span = btns[i].querySelector('span');
        const match = span && span.textContent.toLowerCase().includes(termLower);
        btns[i].style.display = match ? '' : 'none';
    }
}

function updateToolState(tool) {
    if (tool !== 'move') layerPanelHasFocus = false;
    if (window.selectionActions && tool !== activeTool && (activeTool === 'select' || activeTool === 'arrange')) {
        window.selectionActions.deselect({ preserveLayerSelection: true });
    }
    activeTool = tool;
    document.getElementById('bucket-btn')?.classList.toggle('active-tool', tool === 'bucket');
    document.getElementById('shapes-btn')?.classList.toggle('active-tool', tool === 'shapes');
    document.getElementById('pick-btn')?.classList.toggle('active-tool', tool === 'pick');
    document.getElementById('select-btn')?.classList.toggle('active-tool', tool === 'select');
    document.getElementById('arrange-btn')?.classList.toggle('active-tool', tool === 'arrange');
    document.getElementById('move-btn')?.classList.toggle('active-tool', tool === 'move');

    const display = document.getElementById('block-name');
    const formatDisplay = (txt) => txt ? txt.toUpperCase() : "NONE";

    if (tool === 'pick') display.innerText = "Tool: Pick Block";
    else if (tool === 'select') display.innerText = "Tool: Select";
    else if (tool === 'arrange') display.innerText = "Tool: Arrange Layer";
    else if (tool === 'bucket') display.innerHTML = `Tool: Bucket (${formatDisplay(bucketBlock?.name)})`;
    else if (tool === 'shapes') display.innerHTML = `Tool: Shapes (${formatDisplay(shapeBlock?.name)})`;
    else if (tool === 'move') display.innerText = "Tool: Move";
    else {
        const block = hotbar[activeSlot];
        display.innerText = block ? `Block: ${block.name}` : "EMPTY SLOT";
    }

    if(tool !== 'hotbar') {
        document.querySelectorAll('.slot').forEach(s => s.classList.remove('active'));
    }
}

function selectSlot(i) {
    activeSlot = i;
    updateToolState('hotbar');
    document.querySelectorAll('.slot').forEach(s => s.classList.toggle('active', Number(s.dataset.slot) === i));
}

function openMenu(id) { closeAll(); document.getElementById(id).classList.remove('hidden'); document.getElementById('overlay').classList.remove('hidden'); }
function closeAll() {
    document.querySelectorAll('.menu-popup, #overlay, .suggestions-list').forEach(el => el.classList.add('hidden'));
    hideLayerContextMenu();
}

function showDockPanel(name) {
    const panel = document.querySelector(`[data-dock-panel="${name}"]`);
    if (!panel) return;
    document.getElementById('side-toolbar')?.classList.remove('hidden');
    panel.classList.remove('hidden');
    panel.classList.remove('minimized');
    const minimizeBtn = panel.querySelector('.dock-minimize-btn');
    if (minimizeBtn) {
        minimizeBtn.textContent = '-';
        minimizeBtn.title = 'Minimize';
    }
    clampDockPanelHeight(panel);
    panel.scrollIntoView({ block: 'nearest' });
    updateSideToolbarVisibility();
}

function hideDockPanel(panel) {
    panel?.classList.add('hidden');
    updateSideToolbarVisibility();
}

function toggleDockPanel(name) {
    const panel = document.querySelector(`[data-dock-panel="${name}"]`);
    if (!panel) return;
    if (!panel.classList.contains('hidden')) hideDockPanel(panel);
    else showDockPanel(name);
}

function updateSideToolbarVisibility() {
    const toolbar = document.getElementById('side-toolbar');
    if (!toolbar) return;
    const hasOpenPanel = !!toolbar.querySelector('[data-dock-panel]:not(.hidden)');
    toolbar.classList.toggle('hidden', !hasOpenPanel);
}

window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('click', (e) => {
    if (!e.target.closest('#layer-context-menu') && !e.target.closest('#arrange-context-menu')) hideLayerContextMenu();
});
document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#layer-list') && !e.target.closest('#layer-context-menu') && !e.target.closest('#arrange-context-menu')) {
        layerPanelHasFocus = false;
    }
}, true);
document.querySelectorAll('.dock-close-btn').forEach(btn => {
    btn.onclick = (e) => {
        e.stopPropagation();
        hideDockPanel(btn.closest('[data-dock-panel]'));
    };
});
document.querySelectorAll('.dock-minimize-btn').forEach(btn => {
    btn.onclick = (e) => {
        e.stopPropagation();
        const panel = btn.closest('[data-dock-panel]');
        if (!panel) return;
        panel.classList.toggle('minimized');
        btn.textContent = panel.classList.contains('minimized') ? '+' : '-';
        btn.title = panel.classList.contains('minimized') ? 'Restore' : 'Minimize';
        fitDockPanelsWithinToolbar(panel);
        updateSideToolbarVisibility();
    };
});

function clampDockPanelHeight(panel) {
    const toolbar = document.getElementById('side-toolbar');
    if (!panel || !toolbar || panel.classList.contains('hidden')) return;
    const min = Number(panel.dataset.minHeight) || 84;
    const max = getDockPanelMaxHeight(panel, min);
    const current = panel.getBoundingClientRect().height || min;
    panel.style.height = `${Math.max(min, Math.min(max, current))}px`;
    panel.style.flexBasis = panel.style.height;
}

function getDockPanelMaxHeight(panel, minHeight = Number(panel?.dataset.minHeight) || 84) {
    const toolbar = document.getElementById('side-toolbar');
    if (!panel || !toolbar) return minHeight;
    const reservedHeight = [...toolbar.querySelectorAll('[data-dock-panel]:not(.hidden)')]
        .filter(item => item !== panel)
        .reduce((sum, item) => sum + (Number(item.dataset.minHeight) || 84), 0);
    return Math.max(minHeight, toolbar.clientHeight - reservedHeight);
}

function fitDockPanelsWithinToolbar(activePanel = null) {
    const toolbar = document.getElementById('side-toolbar');
    if (!toolbar) return;
    const panels = [...toolbar.querySelectorAll('[data-dock-panel]:not(.hidden)')];
    let overflow = panels.reduce((sum, panel) => sum + panel.getBoundingClientRect().height, 0) - toolbar.clientHeight;
    if (overflow <= 0) return;
    const shrinkTargets = panels.filter(panel => panel !== activePanel).reverse();
    for (const panel of shrinkTargets) {
        if (overflow <= 0) break;
        const min = Number(panel.dataset.minHeight) || 84;
        const current = panel.getBoundingClientRect().height;
        const shrinkBy = Math.min(overflow, Math.max(0, current - min));
        if (shrinkBy <= 0) continue;
        const next = current - shrinkBy;
        panel.style.height = `${next}px`;
        panel.style.flexBasis = `${next}px`;
        overflow -= shrinkBy;
    }
}

function initDockPanelResizers() {
    document.querySelectorAll('#side-toolbar [data-dock-panel]').forEach(panel => {
        if (panel.querySelector(':scope > .dock-resizer')) return;
        panel.dataset.minHeight = panel.classList.contains('nav-panel') ? '248' : panel.classList.contains('inventory-dock-panel') ? '170' : panel.classList.contains('history-panel') ? '150' : '120';
        const handle = document.createElement('div');
        handle.className = 'dock-resizer';
        handle.title = 'Drag to resize panel';
        panel.appendChild(handle);
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const toolbar = document.getElementById('side-toolbar');
            const startY = e.clientY;
            const startHeight = panel.getBoundingClientRect().height;
            const minHeight = Number(panel.dataset.minHeight) || 84;
            const maxHeight = getDockPanelMaxHeight(panel, minHeight);
            panel.classList.add('resizing');
            document.body.style.cursor = 'ns-resize';
            const onMove = (moveEvent) => {
                const next = Math.max(minHeight, Math.min(maxHeight, startHeight + moveEvent.clientY - startY));
                panel.style.height = `${next}px`;
                panel.style.flexBasis = `${next}px`;
                fitDockPanelsWithinToolbar(panel);
            };
            const onUp = () => {
                document.querySelectorAll('#side-toolbar [data-dock-panel]:not(.hidden)').forEach(item => {
                    const height = item.getBoundingClientRect().height;
                    item.style.height = `${height}px`;
                    item.style.flexBasis = `${height}px`;
                });
                panel.classList.remove('resizing');
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        clampDockPanelHeight(panel);
    });
}

initDockPanelResizers();
window.addEventListener('resize', () => {
    document.querySelectorAll('#side-toolbar [data-dock-panel]').forEach(clampDockPanelHeight);
});
const bindings = { 'inv-toggle': 'inventory-popup', 'bg-ui-btn': 'bg-popup', 'clear-menu-btn': 'clear-popup', 'help-btn': 'help-popup', 'ref-overlay-btn': 'ref-overlay-popup', 'custom-bg-btn': 'custom-bg-popup', 'img2blocks-btn': 'img2blocks-popup' };
Object.keys(bindings).forEach(id => { const el = document.getElementById(id); if(el) el.onclick = () => openMenu(bindings[id]); });

// --- Block Counter ---
let bcActiveFilter = 'all';

const FLOOR_ROWS = new Set([57, 58, 59]);

function getBlockCounts() {
    const fgCounts = {}, bgCounts = {};
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            if (FLOOR_ROWS.has(y)) continue; // skip default floor rows
            if (fgData[x][y]) {
                const key = fgData[x][y].name;
                fgCounts[key] = (fgCounts[key] || { block: fgData[x][y], count: 0 });
                fgCounts[key].count++;
            }
            if (bgData[x][y]) {
                const key = bgData[x][y].name;
                bgCounts[key] = (bgCounts[key] || { block: bgData[x][y], count: 0 });
                bgCounts[key].count++;
            }
            if (waterData[x][y]) {
                const key = waterData[x][y].name;
                fgCounts[key] = (fgCounts[key] || { block: waterData[x][y], count: 0 });
                fgCounts[key].count++;
            }
        }
    }
    return { fgCounts, bgCounts };
}

function renderBlockCounter(filter, searchTerm) {
    const { fgCounts, bgCounts } = getBlockCounts();
    const list = document.getElementById('block-counter-list');
    list.innerHTML = '';

    let totalFg = 0, totalBg = 0;
    Object.values(fgCounts).forEach(e => totalFg += e.count);
    Object.values(bgCounts).forEach(e => totalBg += e.count);

    document.getElementById('bc-total-fg').innerText = `FG: ${totalFg} blocks`;
    document.getElementById('bc-total-bg').innerText = `BG: ${totalBg} blocks`;
    document.getElementById('bc-total-all').innerText = `Total: ${totalFg + totalBg} blocks`;

    const combined = {};
    if (filter !== 'bg') {
        Object.entries(fgCounts).forEach(([k, v]) => {
            combined[k] = combined[k] || { block: v.block, fg: 0, bg: 0 };
            combined[k].fg = v.count;
        });
    }
    if (filter !== 'fg') {
        Object.entries(bgCounts).forEach(([k, v]) => {
            combined[k] = combined[k] || { block: v.block, fg: 0, bg: 0 };
            combined[k].bg = v.count;
        });
    }

    const entries = Object.entries(combined)
        .filter(([k]) => !searchTerm || k.toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => (b[1].fg + b[1].bg) - (a[1].fg + a[1].bg));

    if (entries.length === 0) {
        list.innerHTML = '<div class="bc-empty">No blocks placed yet.</div>';
        return;
    }

    entries.forEach(([name, data]) => {
        const total = data.fg + data.bg;
        const card = document.createElement('div');
        card.className = 'bc-count-row';
        const texture = data.block.texture || '';
        card.innerHTML = `
            <img src="${texture}">
            <div style="flex:1;min-width:0;">
                <div class="bc-count-name" title="${name}">${name}</div>
                <div class="bc-count-total">x ${total}</div>
                ${data.fg > 0 && data.bg > 0 ? `<div class="bc-count-meta"><span class="bc-count-fg">FG:${data.fg}</span> <span class="bc-count-bg">BG:${data.bg}</span></div>` : 
                  data.fg > 0 ? `<div class="bc-count-meta bc-count-fg">Foreground</div>` :
                  `<div class="bc-count-meta bc-count-bg">Background</div>`}
            </div>`;
        list.appendChild(card);
    });
}

function getBlockCounterEntries(filter = bcActiveFilter, searchTerm = '') {
    const { fgCounts, bgCounts } = getBlockCounts();
    const combined = {};
    if (filter !== 'bg') {
        Object.entries(fgCounts).forEach(([k, v]) => {
            combined[k] = combined[k] || { fg: 0, bg: 0 };
            combined[k].fg = v.count;
        });
    }
    if (filter !== 'fg') {
        Object.entries(bgCounts).forEach(([k, v]) => {
            combined[k] = combined[k] || { fg: 0, bg: 0 };
            combined[k].bg = v.count;
        });
    }
    return Object.entries(combined)
        .filter(([k]) => !searchTerm || k.toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => (b[1].fg + b[1].bg) - (a[1].fg + a[1].bg));
}

function buildBlockCounterText() {
    const filter = bcActiveFilter;
    const search = document.getElementById('block-counter-search')?.value || '';
    const entries = getBlockCounterEntries(filter, search);
    return entries
        .map(([name, data]) => `${name} x${data.fg + data.bg}`)
        .join('\n');
}

async function copyBlockCounterText() {
    const text = buildBlockCounterText();
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }
    const btn = document.getElementById('bc-copy-btn');
    if (btn) {
        const oldText = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = oldText, 900);
    }
}

function openBlockCounter() {
    openMenu('block-counter-popup');
    bcActiveFilter = 'all';
    renderBlockCounter('all', '');
    document.getElementById('block-counter-search').value = '';
    document.getElementById('bc-filter-all').classList.add('highlight');
    document.getElementById('bc-filter-fg').classList.remove('highlight');
    document.getElementById('bc-filter-bg').classList.remove('highlight');
}
const blockCounterBtn = document.getElementById('block-counter-btn');
if (blockCounterBtn) blockCounterBtn.onclick = openBlockCounter;

document.getElementById('bc-filter-all').onclick = () => {
    bcActiveFilter = 'all';
    document.getElementById('bc-filter-all').classList.add('highlight');
    document.getElementById('bc-filter-fg').classList.remove('highlight');
    document.getElementById('bc-filter-bg').classList.remove('highlight');
    renderBlockCounter('all', document.getElementById('block-counter-search').value);
};
document.getElementById('bc-filter-fg').onclick = () => {
    bcActiveFilter = 'fg';
    document.getElementById('bc-filter-all').classList.remove('highlight');
    document.getElementById('bc-filter-fg').classList.add('highlight');
    document.getElementById('bc-filter-bg').classList.remove('highlight');
    renderBlockCounter('fg', document.getElementById('block-counter-search').value);
};
document.getElementById('bc-filter-bg').onclick = () => {
    bcActiveFilter = 'bg';
    document.getElementById('bc-filter-all').classList.remove('highlight');
    document.getElementById('bc-filter-fg').classList.remove('highlight');
    document.getElementById('bc-filter-bg').classList.add('highlight');
    renderBlockCounter('bg', document.getElementById('block-counter-search').value);
};
document.getElementById('block-counter-search').oninput = (e) => {
    renderBlockCounter(bcActiveFilter, e.target.value);
};
document.getElementById('bc-copy-btn')?.addEventListener('click', copyBlockCounterText);

document.getElementById('bucket-btn').onclick = () => {
    if (activeTool === 'bucket') openMenu('bucket-popup');
    else updateToolState('bucket');
};
document.getElementById('shapes-btn').onclick = () => {
    if (activeTool === 'shapes') openMenu('shapes-popup');
    else updateToolState('shapes');
};
document.getElementById('inv-search').oninput = (e) => applyInvFilter(e.target.value);
document.getElementById('bucket-search').oninput = (e) => filterList('block-list-bucket', e.target.value);
document.getElementById('shapes-search').oninput = (e) => filterList('block-list-shapes', e.target.value);
document.getElementById('clear-search').oninput = (e) => {
    const term = e.target.value;
    const list = document.getElementById('clear-suggestions');
    if(term) { list.classList.remove('hidden'); filterList('clear-suggestions', term); }
    else { list.classList.add('hidden'); document.getElementById('replace-controls').classList.add('hidden'); }
};

document.getElementById('confirm-replace').onclick = () => {
    const newBlock = hotbar[activeSlot];
    if(!targetBlockForReplace || !newBlock) return alert("Select a block and an active hotbar block!");
    saveHistory();
    for(let x=0; x<GRID_X; x++) {
        for(let y=0; y<GRID_Y; y++) {
            if (isProtectedTile(x, y)) continue;
            if(fgData[x][y] && fgData[x][y].name === targetBlockForReplace.name) fgData[x][y] = JSON.parse(JSON.stringify(newBlock));
            if(bgData[x][y] && bgData[x][y].name === targetBlockForReplace.name) bgData[x][y] = JSON.parse(JSON.stringify(newBlock));
            if(waterData[x][y] && waterData[x][y].name === targetBlockForReplace.name) waterData[x][y] = JSON.parse(JSON.stringify(newBlock));
        }
    }
    closeAll();
};

document.getElementById('delete-all-trigger').onclick = () => {
    if(confirm("Delete all layers and blocks from this world? This leaves the world empty until you add or place new blocks.")) {
        saveHistory('Delete Everything');
        window.selectionActions?.deselect();
        editorLayers = [];
        activeLayerId = null;
        selectedLayerId = null;
        layerDeleteTargetId = null;
        fgData = makeGrid();
        bgData = makeGrid();
        renderLayerPanel();
        closeAll();
    }
};

document.querySelectorAll('.close-btn-fancy').forEach(b => b.onclick = closeAll);
document.getElementById('overlay').onclick = closeAll;
const gridToggleBtn = document.getElementById('grid-toggle');
if (gridToggleBtn) gridToggleBtn.onclick = () => showGrid = !showGrid;

function setMoveToolFromKeybind() {
    updateToolState('move');
}

function executeKeybindCommand(command) {
    const actions = {
        move: setMoveToolFromKeybind,
        arrange: setArrangeTool,
        select: setSelectToolFromMenu,
        bucket: () => updateToolState('bucket'),
        shapes: () => updateToolState('shapes'),
        pick: () => updateToolState('pick'),
        grid: () => showGrid = !showGrid,
        navigate: () => toggleDockPanel('navigate'),
        inventory: () => toggleDockPanel('inventory'),
        layers: () => toggleDockPanel('layers'),
        history: () => toggleDockPanel('history'),
        settings: () => openMenu('settings-popup')
    };
    actions[command]?.();
}

function handleSettingsKeybind(e) {
    for (const [command, keybind] of Object.entries(appSettings.keybinds)) {
        if (!keybindMatches(e, keybind)) continue;
        e.preventDefault();
        executeKeybindCommand(command);
        return true;
    }
    return false;
}

function renderSettingsPanel() {
    const gridInput = document.getElementById('grid-color-input');
    const animatedToggle = document.getElementById('animated-blocks-toggle');
    const list = document.getElementById('settings-keybind-list');
    if (!list) return;

    if (gridInput) gridInput.value = appSettings.gridColor;
    if (animatedToggle) animatedToggle.checked = appSettings.animatedBlocks;

    list.innerHTML = '';
    Object.entries(KEYBIND_LABELS).forEach(([command, label]) => {
        const row = document.createElement('div');
        row.className = 'keybind-row';

        const name = document.createElement('span');
        name.textContent = label;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'keybind-btn';
        button.dataset.keybindCommand = command;
        button.textContent = keybindListeningFor === command ? 'Press key...' : formatKeybind(appSettings.keybinds[command]);

        row.appendChild(name);
        row.appendChild(button);
        list.appendChild(row);
    });
}

document.getElementById('grid-color-input')?.addEventListener('input', (e) => {
    appSettings.gridColor = e.target.value || '#dc2828';
    saveAppSettings();
});
document.getElementById('animated-blocks-toggle')?.addEventListener('change', (e) => {
    appSettings.animatedBlocks = e.target.checked;
    saveAppSettings();
});
document.getElementById('settings-keybind-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.keybind-btn');
    if (!btn) return;
    keybindListeningFor = btn.dataset.keybindCommand;
    renderSettingsPanel();
    const activeBtn = document.querySelector(`[data-keybind-command="${keybindListeningFor}"]`);
    activeBtn?.classList.add('listening');
    activeBtn?.focus();
});

function captureKeybindSetting(e) {
    if (!keybindListeningFor) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (e.key === 'Escape') {
        keybindListeningFor = null;
        renderSettingsPanel();
        return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
        appSettings.keybinds[keybindListeningFor] = '';
    } else {
        const keybind = eventToKeybind(e);
        if (!keybind) return;
        if (isReservedHotbarKeybind(keybind)) return;
        Object.keys(appSettings.keybinds).forEach(command => {
            if (command !== keybindListeningFor && appSettings.keybinds[command] === keybind) {
                appSettings.keybinds[command] = '';
            }
        });
        appSettings.keybinds[keybindListeningFor] = keybind;
    }
    keybindListeningFor = null;
    saveAppSettings();
    renderSettingsPanel();
}

document.addEventListener('keydown', captureKeybindSetting, true);
document.getElementById('reset-keybinds-btn')?.addEventListener('click', () => {
    appSettings.keybinds = { ...DEFAULT_KEYBINDS };
    saveAppSettings();
    renderSettingsPanel();
});
renderSettingsPanel();

document.getElementById('layer-add-btn')?.addEventListener('click', addLayer);
document.getElementById('layer-duplicate-btn')?.addEventListener('click', duplicateLayer);
document.getElementById('layer-delete-btn')?.addEventListener('click', () => deleteLayer());
document.getElementById('layer-up-btn')?.addEventListener('click', () => moveActiveLayer(1));
document.getElementById('layer-down-btn')?.addEventListener('click', () => moveActiveLayer(-1));
document.getElementById('top-undo-btn')?.addEventListener('click', undo);
document.getElementById('top-redo-btn')?.addEventListener('click', redo);
document.getElementById('top-new-layer-btn')?.addEventListener('click', addLayer);
document.getElementById('side-inv-search')?.addEventListener('input', applySideInvFilter);
document.getElementById('arrange-btn')?.addEventListener('click', setArrangeTool);
document.getElementById('move-btn')?.addEventListener('click', () => updateToolState('move'));
document.querySelectorAll('.side-inv-filter').forEach(btn => {
    btn.onclick = () => {
        sideInvFilterFolder = btn.dataset.filter;
        document.querySelectorAll('.side-inv-filter').forEach(item => item.classList.remove('active'));
        btn.classList.add('active');
        applySideInvFilter();
    };
});
document.getElementById('layer-context-menu')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-layer-action]');
    if (!btn) return;
    const layerId = Number(e.currentTarget.dataset.layerId);
    if (!layerId) return;
    setActiveLayer(layerId);
    const layer = activeLayer();
    const action = btn.dataset.layerAction;
    if (action === 'rename') startRenameLayer(layerId);
    if (action === 'toggle-lock') {
        saveHistory(layer.locked ? 'Unlock Layer' : 'Lock Layer');
        layer.locked = !layer.locked;
        renderLayerPanel();
    }
    if (action === 'toggle-visible') {
        saveHistory(layer.visible ? 'Hide Layer' : 'Show Layer');
        layer.visible = !layer.visible;
        renderLayerPanel();
    }
    if (action === 'merge-visible') mergeVisibleLayers();
    if (action === 'copy-layer') copyActiveLayer(layerId);
    if (action === 'paste-layer') pasteLayer();
    if (action === 'duplicate') duplicateLayer();
    if (action === 'move-up') moveActiveLayer(1);
    if (action === 'move-down') moveActiveLayer(-1);
    if (action === 'delete') deleteLayer(layerId);
    hideLayerContextMenu();
});

document.getElementById('arrange-context-menu')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-arrange-action]');
    if (!btn) return;
    const layerId = Number(e.currentTarget.dataset.layerId);
    if (!layerId) return;
    if (layerExists(layerId)) setActiveLayer(layerId);
    const targets = getLayerActionTargets(layerId);
    const action = btn.dataset.arrangeAction;
    if (action === 'toggle-visible') setTargetLayersVisibility(layerId, !targets.some(layer => layer.visible !== false));
    if (action === 'toggle-lock') setTargetLayersLocked(layerId, targets.some(layer => !layer.locked));
    if (action === 'cut-layer') cutTargetLayers(layerId);
    if (action === 'copy-layer') copyActiveLayer(layerId);
    if (action === 'paste-layer') pasteLayer();
    if (action === 'duplicate') duplicateTargetLayers(layerId);
    if (action === 'invert-image') await invertTargetLayerImage(layerId);
    if (action === 'delete') deleteTargetLayers(layerId);
    hideLayerContextMenu();
});

function setSelectToolFromMenu() {
    updateToolState('select');
    activeTool = 'select';
}

function executeMenuCommand(command) {
    const actionMap = {
        import: () => document.getElementById('file-input').click(),
        save: saveWorld,
        screenshot: exportScreenshot,
        undo,
        redo,
        replace: () => openMenu('clear-popup'),
        'delete-all': () => document.getElementById('delete-all-trigger').click(),
        reference: () => openMenu('ref-overlay-popup'),
        'custom-bg': () => openMenu('custom-bg-popup'),
        'img-blocks': () => openMenu('img2blocks-popup'),
        'img-world': () => openMenu('i2w-popup'),
        'new-layer': addLayer,
        'duplicate-layer': duplicateLayer,
        'delete-layer': deleteLayer,
        'layer-up': () => moveActiveLayer(1),
        'layer-down': () => moveActiveLayer(-1),
        backgrounds: () => openMenu('bg-popup'),
        'block-count': openBlockCounter,
        bucket: () => updateToolState('bucket'),
        shapes: () => updateToolState('shapes'),
        pick: () => updateToolState('pick'),
        grid: () => showGrid = !showGrid,
        navigate: () => toggleDockPanel('navigate'),
        inventory: () => toggleDockPanel('inventory'),
        layers: () => toggleDockPanel('layers'),
        history: () => toggleDockPanel('history'),
        settings: () => openMenu('settings-popup'),
        help: () => openMenu('help-popup')
    };
    const action = actionMap[command];
    if (action) action();
}

document.querySelectorAll('.menu-wrap').forEach(wrap => {
    const btn = wrap.querySelector('.menu-btn');
    btn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.menu-wrap').forEach(other => {
            if (other !== wrap) other.classList.remove('open');
        });
        wrap.classList.toggle('open');
    };
});
document.querySelectorAll('.dropdown-menu button').forEach(btn => {
    btn.onclick = (e) => {
        e.stopPropagation();
        executeMenuCommand(btn.dataset.command);
        document.querySelectorAll('.menu-wrap').forEach(wrap => wrap.classList.remove('open'));
    };
});
document.addEventListener('click', () => document.querySelectorAll('.menu-wrap').forEach(wrap => wrap.classList.remove('open')));

const zoomSlider = document.getElementById('zoom-slider');
const zoomLabel = document.getElementById('zoom-label');
function setZoom(nextScale) {
    const next = Math.min(Math.max(nextScale, 0.1), 3);
    const viewportRect = viewport.getBoundingClientRect();
    const centerX = viewportRect.left + viewportRect.width / 2;
    const centerY = viewportRect.top + viewportRect.height / 2;
    const beforeRect = canvas.getBoundingClientRect();
    const worldX = (centerX - beforeRect.left) / scale;
    const worldY = (centerY - beforeRect.top) / scale;
    scale = next;
    zoomSlider.value = Math.round(scale * 100);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    updateTransform();
    const afterRect = canvas.getBoundingClientRect();
    posX += centerX - (afterRect.left + worldX * scale);
    posY += centerY - (afterRect.top + worldY * scale);
    updateTransform();
}
zoomSlider.oninput = (e) => setZoom(parseInt(e.target.value, 10) / 100);
document.getElementById('zoom-out-btn').onclick = () => setZoom(scale - 0.1);
document.getElementById('zoom-in-btn').onclick = () => setZoom(scale + 0.1);

function updateNavigator() {
    const navCanvas = document.getElementById('navigator-canvas');
    if (!navCanvas) return;
    const nctx = navCanvas.getContext('2d');
    nctx.clearRect(0, 0, navCanvas.width, navCanvas.height);
    nctx.fillStyle = '#050505';
    nctx.fillRect(0, 0, navCanvas.width, navCanvas.height);
    if (customBgDataUrl) {
        const customBgImg = getImg(customBgDataUrl);
        if (customBgImg.complete && customBgImg.naturalWidth > 0) {
            nctx.drawImage(customBgImg, 0, 0, navCanvas.width, navCanvas.height);
        }
    } else if (activeAtmosphere) {
        const bgImg = getImg(`textures/orbs/${activeAtmosphere}`);
        if (bgImg.complete && bgImg.naturalWidth > 0) {
            nctx.drawImage(bgImg, 0, 0, navCanvas.width, navCanvas.height);
        }
    }
    nctx.drawImage(canvas, 0, 0, navCanvas.width, navCanvas.height);
    zoomSlider.value = Math.round(scale * 100);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    requestAnimationFrame(updateNavigator);
}
requestAnimationFrame(updateNavigator);

renderLayerPanel();
renderHistoryPanel();

function saveWorld() {
    const data = JSON.stringify(captureEditorState());
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'world.json'; a.click();
    recordHistorySnapshot('Save');
}
const saveBtn = document.getElementById('save-btn');
if (saveBtn) saveBtn.onclick = saveWorld;

const importBtn = document.getElementById('import-btn');
if (importBtn) importBtn.onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = (e) => {
    const reader = new FileReader();
    reader.onload = () => {
        const d = JSON.parse(reader.result);
        restoreEditorState(d);
        // --- Legacy migration: old saves stored water in bgData or fgData.
        //    Move those water blocks to the dedicated water layer.
        for (let x = 0; x < GRID_X; x++) {
            for (let y = 0; y < GRID_Y; y++) {
                if (isWaterBlock(bgData[x][y])) {
                    waterData[x][y] = bgData[x][y];
                    bgData[x][y] = null;
                }
                if (isWaterBlock(fgData[x][y])) {
                    waterData[x][y] = fgData[x][y];
                    fgData[x][y] = null;
                }
            }
        }
        syncActiveLayerRefs();
        renderLayerPanel();
        recordHistorySnapshot('Import');
    };
    reader.readAsText(e.target.files[0]);
};

viewport.onmousedown = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);

    if(e.button === 1 || activeTool === 'move') {
        isPanning = true;
        return;
    }

    if (activeTool === 'pick') {
        const visibleData = composeVisibleLayers();
        const picked = visibleData.fg[x][y] || visibleData.bg[x][y];
        if (picked) {
            let targetSlot = getNextHotbarSlot();

            hotbar[targetSlot] = JSON.parse(JSON.stringify(picked));
            const slotEl = document.querySelector(`.slot[data-slot="${targetSlot}"]`);
            if (slotEl) slotEl.innerHTML = `<img src="${picked.texture}">`;

            selectSlot(targetSlot);
        }
        return;
    }

    saveHistory();
    if(activeTool === 'bucket') {
        if(e.button === 0) {
            if(!bucketBlock) openMenu('bucket-popup');
            else floodFill(x,y,bucketBlock);
        } else if (e.button === 2) {
            floodFill(x,y,null);
        }
    }
    else if(activeTool === 'shapes') {
        if(!shapeBlock) openMenu('shapes-popup');
        else { shapeStart = {x, y}; shapePreviewEnd = {x, y}; isDrawing = true; }
    }
    else {
        isDrawing = true;
        handlePlace(e);
    }
};

const coordsDisplay = document.getElementById('coords-display');

window.onmousemove = (e) => {
    // Existing Panning Logic
    if (isPanning) {
        posX += e.movementX;
        posY += e.movementY;
        updateTransform();
    } else if (isDrawing && activeTool !== 'shapes') {
        handlePlace(e);
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const mouseY = Math.floor(((e.clientY - rect.top) / scale) / TILE);

    if (mouseX >= 0 && mouseX < GRID_X && mouseY >= 0 && mouseY < GRID_Y) {
        coordsDisplay.innerText = `X: ${mouseX}, Y: ${mouseY}`;
        document.getElementById('nav-x').innerText = mouseX;
        document.getElementById('nav-y').innerText = mouseY;
        coordsDisplay.style.color = "#3abdc2";
        if (isDrawing && activeTool === 'shapes' && shapeStart) {
            shapePreviewEnd = { x: mouseX, y: mouseY };
        }
    } else {
        coordsDisplay.style.color = "#ff4444";
    }
};

window.onmouseup = (e) => {
    if(activeTool === 'shapes' && shapeStart) {
        const rect = canvas.getBoundingClientRect();
        const x2 = Math.floor(((e.clientX - rect.left) / scale) / TILE);
        const y2 = Math.floor(((e.clientY - rect.top) / scale) / TILE);
        drawShape(shapeStart.x, shapeStart.y, x2, y2);
    }
    isPanning = false; isDrawing = false; shapeStart = null; shapePreviewEnd = null;
};

viewport.onwheel = (e) => { e.preventDefault(); scale = Math.min(Math.max(scale + (e.deltaY < 0 ? 0.1 : -0.1), 0.1), 5); updateTransform(); };

function handlePlace(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);

    if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return;

    if (e.buttons === 1) {
        const b = hotbar[activeSlot];
        if (!b) return;
        placeBlockAt(x, y, b);
    }
    else if (e.buttons === 2) {
        if (isProtectedTile(x, y)) return;
        if (activeLayerLocked()) return;
        clearActiveArrangeRegion();
        fgData[x][y] = null;
        bgData[x][y] = null;
        waterData[x][y] = null;
        scheduleHistorySnapshot('Erase');
    }
}

function floodFill(x, y, block) {
    if (block) ensureActiveLayer();
    clearActiveArrangeRegion();
    const layer = (block && isWaterBlock(block)) ? waterData : ((block && usesBackgroundLayer(block)) ? bgData : fgData);
    const target = layer[x][y]?.name || null;
    if(block && target === block.name) return;
    const stack = [[x, y]];
    while(stack.length) {
        const [cx, cy] = stack.pop();
        if(cx<0 || cx>=GRID_X || cy<0 || cy>=GRID_Y || (layer[cx][cy]?.name || null) !== target) continue;
        if (isProtectedTile(cx, cy)) continue;
        if (block) placeBlockAt(cx, cy, block);
        else {
            layer[cx][cy] = null;
            scheduleHistorySnapshot('Fill Erase');
        }
        stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
    }
}

function forEachShapeTile(x1, y1, x2, y2, callback) {
    const type = document.getElementById('shape-type').value;
    const fill = document.getElementById('shape-fill').checked;
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    for(let x = minX; x <= maxX; x++) {
        for(let y = minY; y <= maxY; y++) {
            if(x<0 || x>=GRID_X || y<0 || y>=GRID_Y) continue;
            let inside = false;
            if(type === 'rect') inside = fill ? true : (x===minX || x===maxX || y===minY || y===maxY);
            else if(type === 'circle') {
                const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
                const d = Math.pow((x - cx) / (rx || 1), 2) + Math.pow((y - cy) / (ry || 1), 2);
                inside = fill ? d <= 1 : (d <= 1 && d >= 0.7);
            }
            if(inside) callback(x, y);
        }
    }
}

function drawShape(x1, y1, x2, y2) {
    ensureActiveLayer();
    forEachShapeTile(x1, y1, x2, y2, (x, y) => placeBlockAt(x, y, shapeBlock));
}

const SHADOW_OFFSET = 8;  // px offset to bottom-right
const PROP_SHADOW_OFFSET_X = 4;  // props sit closer horizontally
const PROP_SHADOW_OFFSET_Y = 6;  // and a little lower vertically
const SHADOW_ALPHA  = 0.35; // translucency of shadow

function isDisplayCaseBlock(block) {
    const label = `${block?.name || ''} ${block?.fileName || ''}`.toLowerCase();
    return label.includes('display case');
}

function shouldCastShadow(block) {
    return !!block && !isWaterBlock(block) && !isDisplayCaseBlock(block);
}

function hasWaterAt(x, y) {
    if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return false;
    return !!(waterData[x][y] || isWaterBlock(fgData[x][y]) || isWaterBlock(bgData[x][y]));
}

function getShadowSilhouette(tex) {
    if (!tex || !tex.complete || tex.naturalWidth === 0) return null;
    const cacheKey = tex.src;
    let oc = silhouetteCache[cacheKey];
    if (oc) return oc;
    oc = document.createElement('canvas');
    oc.width = TILE;
    oc.height = TILE;
    const oc2 = oc.getContext('2d');
    oc2.drawImage(tex, 0, 0, TILE, TILE);
    oc2.globalCompositeOperation = 'source-in';
    oc2.fillStyle = 'black';
    oc2.fillRect(0, 0, TILE, TILE);
    silhouetteCache[cacheKey] = oc;
    return oc;
}

let renderLoopActive = false;

function render(time) {
    renderLoopActive = true;
    const editingFgData = fgData;
    const editingBgData = bgData;
    const editingWaterData = waterData;
    const useLayerRenderCache = true;
    syncActiveLayerRefs();
    editorLayers.forEach(layer => {
        if (useLayerRenderCache && layer.visible && layer.generated && !layer.renderCache) {
            layer.renderCache = buildLayerRenderCache(layer);
        }
    });
    const compositeData = composeVisibleLayers({ skipCached: useLayerRenderCache });
    fgData = compositeData.fg;
    bgData = compositeData.bg;
    waterData = compositeData.water;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (useLayerRenderCache) {
        editorLayers.forEach(layer => {
            if (layer.visible && layer.renderCache) ctx.drawImage(layer.renderCache, 0, 0);
        });
    }
    const glowAlpha = (Math.sin(time * 0.002) + 1) / 2;

    // --- Pass 1: draw background blocks (walls only, not water) ---
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = bgData[x][y];
            if (!block || isWaterBlock(block)) continue;
            const baseTex = getBlockTexture(x, y, block);
            if (!baseTex) continue;
            ctx.drawImage(baseTex, x * TILE, y * TILE, TILE, TILE);
        }
    }

    // --- Pass 1b: draw prop shadows before props so each shadow sits behind its object ---
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = fgData[x][y];
            if (!block || block.type !== 'prop') continue;
            drawBlockShadow(x, y, block);
        }
    }

    // --- Pass 1c: draw props AND platforms BEFORE water so they appear behind water ---
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = fgData[x][y];
            if (!block || isWaterBlock(block) || block.type !== 'prop') continue;
            drawFgBlock(x, y, block);
        }
    }

    // --- Pass 1d: water overlay above background and props ---
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = waterData[x][y] || (isWaterBlock(fgData[x][y]) ? fgData[x][y] : null) || (isWaterBlock(bgData[x][y]) ? bgData[x][y] : null);
            if (!block) continue;
            const baseTex = getBlockTexture(x, y, block);
            if (!baseTex) continue;
            ctx.drawImage(baseTex, x * TILE, y * TILE, TILE, TILE);
        }
    }

    // --- Pass 2: draw foreground shadows as black translucent texture duplicates ---
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = fgData[x][y];
            if (!block || block.type === 'prop') continue;
            drawBlockShadow(x, y, block);
        }
    }

    function drawBlockShadow(x, y, block) {
        if (!shouldCastShadow(block)) return;
        if (hasWaterAt(x, y)) return;
        const tex = getBlockTexture(x, y, block);
        const silhouette = getShadowSilhouette(tex);
        if (!silhouette) return;
        const offsetX = block.type === 'prop' ? PROP_SHADOW_OFFSET_X : SHADOW_OFFSET;
        const offsetY = block.type === 'prop' ? PROP_SHADOW_OFFSET_Y : SHADOW_OFFSET;
        const px = x * TILE + offsetX;
        const py = y * TILE + offsetY;
        const minBx = Math.floor(px / TILE);
        const maxBx = Math.floor((px + TILE - 1) / TILE);
        const minBy = Math.floor(py / TILE);
        const maxBy = Math.floor((py + TILE - 1) / TILE);
        for (let bx = minBx; bx <= maxBx; bx++) {
            for (let by = minBy; by <= maxBy; by++) {
                if (bx < 0 || bx >= GRID_X || by < 0 || by >= GRID_Y) continue;
                if (!bgData[bx][by] || isWaterBlock(bgData[bx][by]) || hasWaterAt(bx, by)) continue;
                const clipX = Math.max(px, bx * TILE);
                const clipY = Math.max(py, by * TILE);
                const clipW = Math.min(px + TILE, bx * TILE + TILE) - clipX;
                const clipH = Math.min(py + TILE, by * TILE + TILE) - clipY;
                if (clipW <= 0 || clipH <= 0) continue;
                ctx.save();
                ctx.globalAlpha = SHADOW_ALPHA;
                ctx.beginPath();
                ctx.rect(clipX, clipY, clipW, clipH);
                ctx.clip();
                ctx.drawImage(silhouette, px, py, TILE, TILE);
                ctx.restore();
            }
        }
    }

    // Helper: draw a single fg block and its optional glow layer.
    function drawFgBlock(x, y, block) {
        const baseTex = getBlockTexture(x, y, block);
        if (!baseTex) return;
        ctx.drawImage(baseTex, x * TILE, y * TILE, TILE, TILE);
        const glowName = block.fileName.replace('.png', '_Glow.png');
        const glowKey = `${block.folder}/${glowName}`;
        if (glowTextureExistsCache[glowKey] === undefined) {
            glowTextureExistsCache[glowKey] = ASSET_LIST.some(a => a.file === glowName && a.folder === block.folder);
        }
        const hasGlow = glowTextureExistsCache[glowKey];
        if (hasGlow) {
            const glowTex = getImg(`${BASE_PATH}${block.folder}/${glowName}`);
            if (glowTex && glowTex.complete) {
                ctx.save();
                ctx.globalAlpha = glowAlpha;
                ctx.drawImage(glowTex, x * TILE, y * TILE, TILE, TILE);
                ctx.restore();
            }
        }
    }

    // --- Pass 3a: draw solid (non-prop, non-water) fg blocks ---
    //   Props and platforms were already drawn in Pass 1b (behind water).
    //   Draw order:  bg walls ->props ->platforms ->water ->solid blocks
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = fgData[x][y];
            if (!block || isWaterBlock(block) || block.type === 'prop') continue;
            drawFgBlock(x, y, block);
        }
    }

    // Permanent world floor: not part of user layers and cannot be edited.
    for (let x = 0; x < GRID_X; x++) {
        PROTECTED_ROWS.forEach(y => {
            const block = protectedFgData[x][y];
            if (block) drawFgBlock(x, y, block);
        });
    }

    if (showGrid) {
        ctx.strokeStyle = appSettings.gridColor || '#dc2828';
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        for (let i = 0; i <= GRID_X; i++) {
            ctx.beginPath(); ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, canvas.height); ctx.stroke();
        }
        for (let i = 0; i <= GRID_Y; i++) {
            ctx.beginPath(); ctx.moveTo(0, i * TILE); ctx.lineTo(canvas.width, i * TILE); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
    }

    fgData = editingFgData;
    bgData = editingBgData;
    waterData = editingWaterData;
    requestAnimationFrame(render);
}

function drawCanvas() {
    if (renderLoopActive) return;
    renderLoopActive = true;
    requestAnimationFrame(render);
}

const pickBtn = document.getElementById('pick-btn');
if (pickBtn) {
    pickBtn.onclick = () => updateToolState('pick');
}

window.onkeydown = (e) => {
    if (e.defaultPrevented) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key >= '0' && e.key <= '9') {
        selectSlot(parseInt(e.key));
        return;
    }

    if (handleSettingsKeybind(e)) return;
};

function exportScreenshot() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    const drawBlocks = () => {
        const editingFgData = fgData;
        const editingBgData = bgData;
        const editingWaterData = waterData;
        const compositeData = composeVisibleLayers();
        fgData = compositeData.fg;
        bgData = compositeData.bg;
        waterData = compositeData.water;
        for (let x = 0; x < GRID_X; x++) {
            for (let y = 0; y < GRID_Y; y++) {
                if (bgData[x][y] && !isWaterBlock(bgData[x][y])) {
                    const tex = getBlockTexture(x, y, bgData[x][y]);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
                if (fgData[x][y] && !isWaterBlock(fgData[x][y])) {
                    const tex = getBlockTexture(x, y, fgData[x][y]);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
                const water = waterData[x][y] || (isWaterBlock(fgData[x][y]) ? fgData[x][y] : null) || (isWaterBlock(bgData[x][y]) ? bgData[x][y] : null);
                if (water) {
                    const tex = getBlockTexture(x, y, water);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
            }
        }
        for (let x = 0; x < GRID_X; x++) {
            PROTECTED_ROWS.forEach(y => {
                if (protectedFgData[x][y]) {
                    const tex = getBlockTexture(x, y, protectedFgData[x][y]);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
            });
        }
        const floorStartY = Math.min(...PROTECTED_ROWS) * TILE;
        const floorHeight = tempCanvas.height - floorStartY;
        if (floorHeight > 0) {
            tempCtx.drawImage(canvas, 0, floorStartY, canvas.width, floorHeight, 0, floorStartY, canvas.width, floorHeight);
        }
        fgData = editingFgData;
        bgData = editingBgData;
        waterData = editingWaterData;
        const link = document.createElement('a');
        link.download = `PW_World_Export_${Date.now()}.png`;
        link.href = tempCanvas.toDataURL("image/png");
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    if (customBgDataUrl) {
        const bgImg = new Image();
        bgImg.onload = () => { tempCtx.drawImage(bgImg, 0, 0, tempCanvas.width, tempCanvas.height); drawBlocks(); };
        bgImg.src = customBgDataUrl;
    } else if (activeAtmosphere) {
        const bgImg = getImg(`textures/orbs/${activeAtmosphere}`);
        if (bgImg && bgImg.complete) {
            tempCtx.drawImage(bgImg, 0, 0, tempCanvas.width, tempCanvas.height);
        } else {
            tempCtx.fillStyle = "#1a1a1a";
            tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        }
        drawBlocks();
    } else {
        tempCtx.fillStyle = "#000";
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        drawBlocks();
    }
}
const screenshotBtn = document.getElementById('screenshot-btn');
if (screenshotBtn) screenshotBtn.onclick = exportScreenshot;

document.querySelectorAll('.slot').forEach(s => {
    s.onclick = () => selectSlot(parseInt(s.dataset.slot));
});

autoLoadAssets();
updateTransform();
render();

// ============================================================
// FEATURE: Selection Tool  (select, move, copy, paste)
// ============================================================
(function () {
    // --- State ---
    const selCanvas = document.getElementById('selectionCanvas');
    const selCtx    = selCanvas.getContext('2d');

    // selection rect in tile coords
    let sel = null;          // { x, y, w, h }  -confirmed selection
    let selDrag = null;      // { x1,y1,x2,y2 } -rubber-band being drawn
    let lassoPath = null;    // [{x,y}] tile path for lasso selection
    let clipboard = null;    // { fg:[][],  bg:[][] } wxh arrays

    // move-drag state
    let isMoveDragging = false;
    let isBoxDragging = false;
    let moveStart = null;    // { tileX, tileY } tile under cursor when drag began
    let movePreview = null;  // { dx, dy }  -offset during live drag
    let boxMoveStart = null;
    // Blocks lifted out of fgData/bgData during a move so they don't ghost
    let liftedFg = null;
    let liftedBg = null;
    let liftedFrom = null;   // original {x,y} of the lifted region
    let isResizeDragging = false;
    let resizeStart = null;
    let resizePreview = null;
    let resizeSource = null;
    let resizeHandle = null;
    let isRotateDragging = false;
    let rotateStart = null;
    let rotateSource = null;
    let rotatePreview = null;
    let arrangeHoverRect = null;
    let arrangeHoverLayerId = null;
    let arrangeSelectedLayerIds = new Set();
    let liftedArrangeLayers = null;
    getArrangePanelSelectionIds = () => arrangeSelectedLayerIds;

    // --- Helpers ---
    function normRect(r) {
        const x = Math.min(r.x1, r.x2);
        const y = Math.min(r.y1, r.y2);
        const w = Math.abs(r.x2 - r.x1) + 1;
        const h = Math.abs(r.y2 - r.y1) + 1;
        return { x, y, w, h };
    }

    function insideSel(tx, ty) {
        if (!sel) return false;
        return tx >= sel.x && tx < sel.x + sel.w && ty >= sel.y && ty < sel.y + sel.h;
    }

    function getResizeHandleAt(tx, ty) {
        if (!sel || activeTool !== 'arrange') return null;
        const corners = [
            { name: 'tl', x: sel.x, y: sel.y },
            { name: 'tr', x: sel.x + sel.w - 1, y: sel.y },
            { name: 'bl', x: sel.x, y: sel.y + sel.h - 1 },
            { name: 'br', x: sel.x + sel.w - 1, y: sel.y + sel.h - 1 }
        ];
        const hit = corners.find(c => Math.abs(tx - c.x) <= 1 && Math.abs(ty - c.y) <= 1);
        return hit ? hit.name : null;
    }

    function getRotateHandleAt(tx, ty) {
        if (!sel || activeTool !== 'arrange') return false;
        const hx = sel.x + Math.floor(sel.w / 2);
        const hy = sel.y - 2;
        return Math.abs(tx - hx) <= 1 && Math.abs(ty - hy) <= 1;
    }

    function copyRegion(x, y, w, h) {
        const fg = [], bg = [];
        for (let dx = 0; dx < w; dx++) {
            fg[dx] = []; bg[dx] = [];
            for (let dy = 0; dy < h; dy++) {
                const wx = x + dx, wy = y + dy;
                fg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y) ? JSON.parse(JSON.stringify(fgData[wx][wy])) : null;
                bg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y) ? JSON.parse(JSON.stringify(bgData[wx][wy])) : null;
            }
        }
        return { fg, bg, w, h };
    }

    function cellHasData(data, dx, dy) {
        return !!(data.fg[dx][dy] || data.bg[dx][dy]);
    }

    function isInsideRect(x, y, r) {
        return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }

    function sameRect(a, b) {
        return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    }

    function rectsIntersect(a, b) {
        return !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function unionRects(rects) {
        const valid = rects.filter(Boolean);
        if (!valid.length) return null;
        const minX = Math.min(...valid.map(r => r.x));
        const minY = Math.min(...valid.map(r => r.y));
        const maxX = Math.max(...valid.map(r => r.x + r.w - 1));
        const maxY = Math.max(...valid.map(r => r.y + r.h - 1));
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function hasDraggedSelectionBox() {
        return !!selDrag && (selDrag.x1 !== selDrag.x2 || selDrag.y1 !== selDrag.y2);
    }

    function addLassoPoint(tile) {
        if (!lassoPath) lassoPath = [];
        const x = Math.max(0, Math.min(GRID_X - 1, tile.x));
        const y = Math.max(0, Math.min(GRID_Y - 1, tile.y));
        const last = lassoPath[lassoPath.length - 1];
        if (!last || last.x !== x || last.y !== y) lassoPath.push({ x, y });
    }

    function lassoBounds() {
        if (!lassoPath || lassoPath.length < 2) return null;
        const minX = Math.min(...lassoPath.map(p => p.x));
        const minY = Math.min(...lassoPath.map(p => p.y));
        const maxX = Math.max(...lassoPath.map(p => p.x));
        const maxY = Math.max(...lassoPath.map(p => p.y));
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function arrangeSelectedLayers() {
        return [...arrangeSelectedLayerIds]
            .map(id => editorLayers.find(layer => layer.id === id))
            .filter(Boolean);
    }

    function syncArrangePanelSelection(render = true) {
        if (render) renderLayerPanel();
    }

    function updateArrangeSelectionBounds() {
        const layers = arrangeSelectedLayers();
        arrangeSelectedLayerIds = new Set(layers.map(layer => layer.id));
        sel = unionRects(layers.map(layer => getLayerContentBounds(layer)));
        syncArrangePanelSelection();
        return sel;
    }

    function setArrangeLayerSelection(layers, activeId = null) {
        const validLayers = layers.filter(Boolean);
        arrangeSelectedLayerIds = new Set(validLayers.map(layer => layer.id));
        syncArrangePanelSelection(false);
        const targetId = activeId || validLayers[validLayers.length - 1]?.id;
        if (targetId && layerExists(targetId)) setActiveLayer(targetId);
        arrangeHoverRect = null;
        return updateArrangeSelectionBounds();
    }

    function addArrangeLayerSelection(layer) {
        if (!layer) return null;
        arrangeSelectedLayerIds.add(layer.id);
        setActiveLayer(layer.id);
        arrangeHoverRect = null;
        return updateArrangeSelectionBounds();
    }

    function toggleArrangeLayerSelection(layerId) {
        const layer = editorLayers.find(item => item.id === layerId);
        if (!layer) return null;
        if (arrangeSelectedLayerIds.has(layer.id)) {
            arrangeSelectedLayerIds.delete(layer.id);
            if (activeLayerId === layer.id) {
                const nextId = [...arrangeSelectedLayerIds].pop();
                if (nextId) setActiveLayer(nextId);
            }
        } else {
            arrangeSelectedLayerIds.add(layer.id);
            setActiveLayer(layer.id);
        }
        arrangeHoverRect = null;
        return updateArrangeSelectionBounds();
    }

    function selectArrangeLayer(layerId) {
        const layer = editorLayers.find(item => item.id === layerId);
        if (!layer) return null;
        return setArrangeLayerSelection([layer], layer.id);
    }

    function selectArrangeLayersInRect(rect) {
        const hits = editorLayers.filter(layer => {
            if (!layer.visible) return false;
            const bounds = getLayerContentBounds(layer);
            return bounds && rectsIntersect(bounds, rect);
        });
        return setArrangeLayerSelection(hits);
    }

    function deleteArrangeSelectedLayers() {
        const ids = new Set(arrangeSelectedLayers().map(layer => layer.id));
        if (!ids.size) return false;
        saveHistory('Delete Layers');
        window.selectionActions?.deselect();
        editorLayers = editorLayers.filter(layer => !ids.has(layer.id));
        const nextLayer = editorLayers[Math.min(editorLayers.length - 1, 0)] || null;
        if (nextLayer) {
            activeLayerId = nextLayer.id;
            selectedLayerId = nextLayer.id;
            layerDeleteTargetId = nextLayer.id;
            fgData = nextLayer.fg;
            bgData = nextLayer.bg;
        } else {
            activeLayerId = null;
            selectedLayerId = null;
            layerDeleteTargetId = null;
            fgData = makeGrid();
            bgData = makeGrid();
        }
        arrangeSelectedLayerIds.clear();
        arrangePanelSelectionIds.clear();
        sel = null;
        renderLayerPanel();
        return true;
    }

    function isMultiArrangeSelection() {
        return activeTool === 'arrange' && arrangeSelectedLayerIds.size > 1;
    }

    function arrangeSelectionLocked() {
        return arrangeSelectedLayers().some(layer => layer.locked);
    }

    function copyLayerRegion(layer, x, y, w, h) {
        const fg = [], bg = [];
        for (let dx = 0; dx < w; dx++) {
            fg[dx] = []; bg[dx] = [];
            for (let dy = 0; dy < h; dy++) {
                const wx = x + dx, wy = y + dy;
                fg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y && layer.fg[wx][wy]) ? JSON.parse(JSON.stringify(layer.fg[wx][wy])) : null;
                bg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y && layer.bg[wx][wy]) ? JSON.parse(JSON.stringify(layer.bg[wx][wy])) : null;
            }
        }
        return { fg, bg, w, h };
    }

    function getLayerMoveSource(layer, bounds) {
        if (layer.arrangeRegion && layer.arrangeRegion.x === bounds.x && layer.arrangeRegion.y === bounds.y && layer.arrangeRegion.w === bounds.w && layer.arrangeRegion.h === bounds.h) {
            return cloneArrangeRegion(layer.arrangeRegion);
        }
        return copyLayerRegion(layer, bounds.x, bounds.y, bounds.w, bounds.h);
    }

    function canPlaceRegion(data, destX, destY, sourceRect = null) {
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                if (!cellHasData(data, dx, dy)) continue;
                const wx = destX + dx, wy = destY + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) return false;
                if (isProtectedTile(wx, wy)) return false;
                if (isInsideRect(wx, wy, sourceRect)) continue;
                if (data.fg[dx][dy] && fgData[wx][wy]) return false;
                if (data.bg[dx][dy] && bgData[wx][wy]) return false;
            }
        }
        return true;
    }

    function canPlaceArrangeRegion(data, destX, destY, sourceRect = null) {
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                if (!cellHasData(data, dx, dy)) continue;
                const wx = destX + dx, wy = destY + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) return false;
                if (isInsideRect(wx, wy, sourceRect)) continue;
                if (data.fg[dx][dy] && fgData[wx][wy]) return false;
                if (data.bg[dx][dy] && bgData[wx][wy]) return false;
            }
        }
        return true;
    }

    function canPlaceLiftedArrangeLayers(dx, dy) {
        if (!liftedArrangeLayers) return false;
        for (const item of liftedArrangeLayers) {
            const layer = editorLayers.find(entry => entry.id === item.layerId);
            if (!layer) return false;
            for (let x = 0; x < item.data.w; x++) {
                for (let y = 0; y < item.data.h; y++) {
                    if (!cellHasData(item.data, x, y)) continue;
                    const wx = item.x + dx + x;
                    const wy = item.y + dy + y;
                    if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                    if (isProtectedTile(wx, wy)) return false;
                    if (item.data.fg[x][y] && layer.fg[wx][wy]) return false;
                    if (item.data.bg[x][y] && layer.bg[wx][wy]) return false;
                }
            }
        }
        return true;
    }

    function makeMultiArrangeSource(bounds) {
        if (!liftedArrangeLayers || !bounds) return null;
        return {
            multi: true,
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
            layers: liftedArrangeLayers.map(item => ({
                layerId: item.layerId,
                x: item.x,
                y: item.y,
                relX: item.x - bounds.x,
                relY: item.y - bounds.y,
                data: cloneArrangeRegion(item.data)
            }))
        };
    }

    function scaleMultiArrangeSource(source, target) {
        if (!source?.multi || !target) return [];
        const sx = target.w / Math.max(1, source.w);
        const sy = target.h / Math.max(1, source.h);
        return source.layers.map(item => {
            const w = Math.max(1, Math.round(item.data.w * sx));
            const h = Math.max(1, Math.round(item.data.h * sy));
            return {
                layerId: item.layerId,
                x: target.x + Math.round(item.relX * sx),
                y: target.y + Math.round(item.relY * sy),
                data: scaleRegionData(item.data, w, h)
            };
        });
    }

    function rotateMultiArrangeSource(source, turns) {
        if (!source?.multi || !rotateStart) return null;
        turns = ((turns % 4) + 4) % 4;
        const groupW = turns % 2 ? source.h : source.w;
        const groupH = turns % 2 ? source.w : source.h;
        const cx = rotateStart.x + rotateStart.w / 2;
        const cy = rotateStart.y + rotateStart.h / 2;
        const groupX = Math.round(cx - groupW / 2);
        const groupY = Math.round(cy - groupH / 2);
        const layers = source.layers.map(item => {
            const rotated = rotateRegionData(item.data, turns);
            let relX = item.relX;
            let relY = item.relY;
            if (turns === 1) {
                relX = source.h - (item.relY + item.data.h);
                relY = item.relX;
            } else if (turns === 2) {
                relX = source.w - (item.relX + item.data.w);
                relY = source.h - (item.relY + item.data.h);
            } else if (turns === 3) {
                relX = item.relY;
                relY = source.w - (item.relX + item.data.w);
            }
            return {
                layerId: item.layerId,
                x: groupX + relX,
                y: groupY + relY,
                data: rotated
            };
        });
        return { multi: true, x: groupX, y: groupY, w: groupW, h: groupH, layers, turns };
    }

    function canPlaceArrangeItems(items) {
        if (!items?.length) return false;
        for (const item of items) {
            const layer = editorLayers.find(entry => entry.id === item.layerId);
            if (!layer) return false;
            for (let x = 0; x < item.data.w; x++) {
                for (let y = 0; y < item.data.h; y++) {
                    if (!cellHasData(item.data, x, y)) continue;
                    const wx = item.x + x;
                    const wy = item.y + y;
                    if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                    if (isProtectedTile(wx, wy)) return false;
                    if (item.data.fg[x][y] && layer.fg[wx][wy]) return false;
                    if (item.data.bg[x][y] && layer.bg[wx][wy]) return false;
                }
            }
        }
        return true;
    }

    function dropArrangeItems(items, label = 'Arrange Layers') {
        if (!items?.length) return false;
        let changed = false;
        items.forEach(item => {
            const layer = editorLayers.find(entry => entry.id === item.layerId);
            if (!layer) return;
            for (let x = 0; x < item.data.w; x++) {
                for (let y = 0; y < item.data.h; y++) {
                    const wx = item.x + x;
                    const wy = item.y + y;
                    if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                    if (isProtectedTile(wx, wy)) continue;
                    if (item.data.fg[x][y]) {
                        layer.fg[wx][wy] = item.data.fg[x][y];
                        changed = true;
                    }
                    if (item.data.bg[x][y]) {
                        layer.bg[wx][wy] = item.data.bg[x][y];
                        changed = true;
                    }
                }
            }
            layer.arrangeRegion = {
                x: item.x,
                y: item.y,
                w: item.data.w,
                h: item.data.h,
                fg: cloneGrid(item.data.fg),
                bg: cloneGrid(item.data.bg)
            };
            layer.resizeOriginal = cloneArrangeRegion(layer.arrangeRegion);
            invalidateLayerRenderCache(layer);
        });
        liftedArrangeLayers = null;
        liftedFrom = null;
        updateArrangeSelectionBounds();
        syncActiveLayerRefs();
        if (changed) scheduleHistorySnapshot(label);
        return changed;
    }

    function canPasteSelectionLayer(data, destX, destY) {
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                if (!cellHasData(data, dx, dy)) continue;
                const wx = destX + dx, wy = destY + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) return false;
                if (isProtectedTile(wx, wy)) return false;
            }
        }
        return true;
    }

    function clampRegionPos(x, y, w, h) {
        return {
            x: Math.max(0, Math.min(GRID_X - w, x)),
            y: Math.max(0, Math.min(GRID_Y - h, y))
        };
    }

    function scaleRegionData(data, newW, newH) {
        const fg = [], bg = [];
        newW = Math.max(1, Math.round(newW));
        newH = Math.max(1, Math.round(newH));
        for (let dx = 0; dx < newW; dx++) {
            fg[dx] = []; bg[dx] = [];
            const sx = Math.min(data.w - 1, Math.floor(dx * data.w / newW));
            for (let dy = 0; dy < newH; dy++) {
                const sy = Math.min(data.h - 1, Math.floor(dy * data.h / newH));
                fg[dx][dy] = data.fg[sx][sy] ? JSON.parse(JSON.stringify(data.fg[sx][sy])) : null;
                bg[dx][dy] = data.bg[sx][sy] ? JSON.parse(JSON.stringify(data.bg[sx][sy])) : null;
            }
        }
        return { fg, bg, w: newW, h: newH };
    }

    function rotateRegionData(data, turns = 1) {
        turns = ((turns % 4) + 4) % 4;
        let out = {
            fg: cloneGrid(data.fg),
            bg: cloneGrid(data.bg),
            w: data.w,
            h: data.h
        };
        for (let i = 0; i < turns; i++) {
            const fg = [], bg = [];
            for (let x = 0; x < out.h; x++) {
                fg[x] = []; bg[x] = [];
                for (let y = 0; y < out.w; y++) {
                    fg[x][y] = out.fg[y][out.h - 1 - x] ? JSON.parse(JSON.stringify(out.fg[y][out.h - 1 - x])) : null;
                    bg[x][y] = out.bg[y][out.h - 1 - x] ? JSON.parse(JSON.stringify(out.bg[y][out.h - 1 - x])) : null;
                }
            }
            out = { fg, bg, w: out.h, h: out.w };
        }
        return out;
    }

    function getRotateTurns(t) {
        if (!rotateStart) return 0;
        const cx = rotateStart.x + rotateStart.w / 2;
        const cy = rotateStart.y + rotateStart.h / 2;
        const startAngle = -Math.PI / 2;
        const angle = Math.atan2(t.y - cy, t.x - cx);
        return ((Math.round((angle - startAngle) / (Math.PI / 2)) % 4) + 4) % 4;
    }

    function getRotatedRect(source, turns) {
        if (!rotateStart) return null;
        const rotated = rotateRegionData(source, turns);
        const cx = rotateStart.x + rotateStart.w / 2;
        const cy = rotateStart.y + rotateStart.h / 2;
        return {
            x: Math.round(cx - rotated.w / 2),
            y: Math.round(cy - rotated.h / 2),
            w: rotated.w,
            h: rotated.h,
            data: rotated,
            turns
        };
    }

    function getResizePreviewRect(t) {
        if (!resizeStart || !resizeHandle) return null;
        const left0 = resizeStart.x;
        const top0 = resizeStart.y;
        const right0 = resizeStart.x + resizeStart.w - 1;
        const bottom0 = resizeStart.y + resizeStart.h - 1;
        let left = left0, top = top0, right = right0, bottom = bottom0;

        if (resizeHandle.includes('l')) left = Math.min(t.x, right0);
        if (resizeHandle.includes('r')) right = Math.max(t.x, left0);
        if (resizeHandle.includes('t')) top = Math.min(t.y, bottom0);
        if (resizeHandle.includes('b')) bottom = Math.max(t.y, top0);

        return {
            x: left,
            y: top,
            w: Math.max(1, right - left + 1),
            h: Math.max(1, bottom - top + 1)
        };
    }

    function getAspectLockedResizeRect(rect) {
        if (!resizeStart || !resizeSource || !resizeHandle || !rect) return rect;
        const ratio = resizeSource.w / Math.max(1, resizeSource.h);
        let w = rect.w;
        let h = rect.h;
        if (w / Math.max(1, h) > ratio) w = Math.max(1, Math.round(h * ratio));
        else h = Math.max(1, Math.round(w / ratio));

        const right0 = resizeStart.x + resizeStart.w - 1;
        const bottom0 = resizeStart.y + resizeStart.h - 1;
        let x = rect.x;
        let y = rect.y;
        if (resizeHandle.includes('l')) x = right0 - w + 1;
        else x = resizeStart.x;
        if (resizeHandle.includes('t')) y = bottom0 - h + 1;
        else y = resizeStart.y;
        return { x, y, w, h };
    }

    function captureOriginalResizeSource(layer, bounds) {
        if (!layer) return null;
        const existing = layer.resizeOriginal;
        if (existing && existing.fg && existing.bg) return cloneArrangeRegion(existing);
        const region = layer.arrangeRegion && layer.arrangeRegion.x === bounds.x && layer.arrangeRegion.y === bounds.y && layer.arrangeRegion.w === bounds.w && layer.arrangeRegion.h === bounds.h
            ? cloneArrangeRegion(layer.arrangeRegion)
            : { ...copyRegion(bounds.x, bounds.y, bounds.w, bounds.h), x: bounds.x, y: bounds.y };
        layer.resizeOriginal = cloneArrangeRegion(region);
        return cloneArrangeRegion(region);
    }

    function buildRegionPreviewCache(data) {
        if (!data || !data.w || !data.h) return null;
        const cache = document.createElement('canvas');
        cache.width = data.w * TILE;
        cache.height = data.h * TILE;
        const cacheCtx = cache.getContext('2d');
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                const bg = data.bg?.[dx]?.[dy];
                const fg = data.fg?.[dx]?.[dy];
                const water = data.water?.[dx]?.[dy];
                [bg, water, fg].forEach(block => {
                    if (!block) return;
                    const tex = getStaticBlockTexture(block);
                    if (tex && tex.complete && tex.naturalWidth > 0) {
                        cacheCtx.drawImage(tex, dx * TILE, dy * TILE, TILE, TILE);
                    }
                });
            }
        }
        return cache;
    }

    function drawRegionPreview(data, drawX, drawY, alpha = 0.65) {
        if (!data) return;
        if (!data._previewCache) data._previewCache = buildRegionPreviewCache(data);
        if (!data._previewCache) return;
        selCtx.save();
        selCtx.globalAlpha = alpha;
        selCtx.drawImage(data._previewCache, drawX * TILE, drawY * TILE);
        selCtx.restore();
    }

    function drawSelectionBox(rect, tint = true) {
        if (!rect) return;
        selCtx.save();
        if (tint) {
            selCtx.fillStyle = 'rgba(58,189,194,0.12)';
            selCtx.fillRect(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
        }
        const t = Date.now() / 80;
        selCtx.strokeStyle = '#3abdc2';
        selCtx.lineWidth = 2.5;
        if (activeTool !== 'arrange') {
            selCtx.setLineDash([8, 5]);
            selCtx.lineDashOffset = -t;
        }
        selCtx.strokeRect(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
        selCtx.setLineDash([]);
        selCtx.fillStyle = '#3abdc2';
        const H = 6;
        [[0,0],[rect.w,0],[0,rect.h],[rect.w,rect.h]].forEach(([ox,oy]) => {
            selCtx.fillRect((rect.x + ox) * TILE - H/2, (rect.y + oy) * TILE - H/2, H, H);
        });
        if (activeTool === 'arrange') {
            const hx = (rect.x + rect.w / 2) * TILE;
            const hy = (rect.y - 1.5) * TILE;
            selCtx.strokeStyle = '#3abdc2';
            selCtx.lineWidth = 2;
            selCtx.beginPath();
            selCtx.moveTo((rect.x + rect.w / 2) * TILE, rect.y * TILE);
            selCtx.lineTo(hx, hy);
            selCtx.stroke();
            selCtx.beginPath();
            selCtx.arc(hx, hy, 5, 0, Math.PI * 2);
            selCtx.fill();
        }
        selCtx.restore();
    }

    function drawArrangeHoverBox(rect) {
        if (!rect) return;
        selCtx.save();
        const t = Date.now() / 90;
        const px = rect.x * TILE - 3;
        const py = rect.y * TILE - 3;
        const pw = rect.w * TILE + 6;
        const ph = rect.h * TILE + 6;
        selCtx.fillStyle = 'rgba(255, 159, 26, 0.08)';
        selCtx.fillRect(px, py, pw, ph);
        selCtx.strokeStyle = '#ff9f1a';
        selCtx.lineWidth = 3.5;
        selCtx.strokeRect(px, py, pw, ph);
        selCtx.setLineDash([]);
        selCtx.restore();
    }

    function pasteRegion(data, destX, destY) {
        ensureActiveLayer();
        let changed = false;
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                const wx = destX + dx, wy = destY + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;
                if (data.fg[dx][dy]) {
                    fgData[wx][wy] = JSON.parse(JSON.stringify(data.fg[dx][dy]));
                    changed = true;
                }
                if (data.bg[dx][dy]) {
                    bgData[wx][wy] = JSON.parse(JSON.stringify(data.bg[dx][dy]));
                    changed = true;
                }
            }
        }
        if (changed) scheduleHistorySnapshot('Paste');
    }

    function deleteRegion(x, y, w, h) {
        let changed = false;
        for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
                const wx = x + dx, wy = y + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;
                if (fgData[wx][wy] || bgData[wx][wy]) changed = true;
                fgData[wx][wy] = null;
                bgData[wx][wy] = null;
            }
        }
        if (changed) scheduleHistorySnapshot('Delete');
    }

    function liftSelection() {
        if (!sel) return;
        if (isMultiArrangeSelection()) {
            liftedArrangeLayers = [];
            arrangeSelectedLayers().forEach(layer => {
                const bounds = getLayerContentBounds(layer);
                if (!bounds || layer.locked) return;
                const data = getLayerMoveSource(layer, bounds);
                liftedArrangeLayers.push({ layerId: layer.id, x: bounds.x, y: bounds.y, data });
                for (let dx = 0; dx < bounds.w; dx++) {
                    for (let dy = 0; dy < bounds.h; dy++) {
                        const wx = bounds.x + dx, wy = bounds.y + dy;
                        if (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y && !isProtectedTile(wx, wy)) {
                            layer.fg[wx][wy] = null;
                            layer.bg[wx][wy] = null;
                        }
                    }
                }
                layer.arrangeRegion = null;
                layer.resizeOriginal = null;
                invalidateLayerRenderCache(layer);
            });
            liftedFrom = { x: sel.x, y: sel.y };
            return;
        }
        const layer = activeLayer();
        const region = layer?.arrangeRegion;
        if (activeTool === 'arrange' && region && region.x === sel.x && region.y === sel.y && region.w === sel.w && region.h === sel.h) {
            liftedFg = cloneGrid(region.fg);
            liftedBg = cloneGrid(region.bg);
            for (let dx = 0; dx < sel.w; dx++) {
                for (let dy = 0; dy < sel.h; dy++) {
                    const wx = sel.x + dx, wy = sel.y + dy;
                    if (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y && !isProtectedTile(wx, wy)) {
                        fgData[wx][wy] = null;
                        bgData[wx][wy] = null;
                    }
                }
            }
            invalidateLayerRenderCache(layer);
            liftedFrom = { x: sel.x, y: sel.y };
            return;
        }

        liftedFg = [];
        liftedBg = [];
        for (let dx = 0; dx < sel.w; dx++) {
            liftedFg[dx] = []; liftedBg[dx] = [];
            for (let dy = 0; dy < sel.h; dy++) {
                const wx = sel.x + dx, wy = sel.y + dy;
                liftedFg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y) ? JSON.parse(JSON.stringify(fgData[wx][wy])) : null;
                liftedBg[dx][dy] = (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y) ? JSON.parse(JSON.stringify(bgData[wx][wy])) : null;
                if (isProtectedTile(wx, wy)) {
                    liftedFg[dx][dy] = null;
                    liftedBg[dx][dy] = null;
                    continue;
                }
                if (wx >= 0 && wx < GRID_X && wy >= 0 && wy < GRID_Y) {
                    fgData[wx][wy] = null;
                    bgData[wx][wy] = null;
                }
            }
        }
        invalidateLayerRenderCache(layer);
        liftedFrom = { x: sel.x, y: sel.y };
    }

    function dropLifted(dx, dy, preserveArrangeRegion = false) {
        if (liftedArrangeLayers) {
            let changed = false;
            liftedArrangeLayers.forEach(item => {
                const layer = editorLayers.find(entry => entry.id === item.layerId);
                if (!layer) return;
                const destX = item.x + dx;
                const destY = item.y + dy;
                for (let x = 0; x < item.data.w; x++) {
                    for (let y = 0; y < item.data.h; y++) {
                        const wx = destX + x, wy = destY + y;
                        if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                        if (isProtectedTile(wx, wy)) continue;
                        if (item.data.fg[x][y]) {
                            layer.fg[wx][wy] = item.data.fg[x][y];
                            changed = true;
                        }
                        if (item.data.bg[x][y]) {
                            layer.bg[wx][wy] = item.data.bg[x][y];
                            changed = true;
                        }
                    }
                }
                if (preserveArrangeRegion) {
                    layer.arrangeRegion = {
                        x: destX,
                        y: destY,
                        w: item.data.w,
                        h: item.data.h,
                        fg: cloneGrid(item.data.fg),
                        bg: cloneGrid(item.data.bg)
                    };
                }
                invalidateLayerRenderCache(layer);
            });
            liftedArrangeLayers = null;
            liftedFrom = null;
            updateArrangeSelectionBounds();
            syncActiveLayerRefs();
            if (changed) scheduleHistorySnapshot('Move');
            return;
        }
        if (!liftedFg) return;
        let changed = false;
        const destX = sel.x + dx;
        const destY = sel.y + dy;
        const layer = activeLayer();
        if (preserveArrangeRegion && layer) {
            layer.arrangeRegion = {
                x: destX,
                y: destY,
                w: liftedFg.length,
                h: liftedFg[0]?.length || 0,
                fg: cloneGrid(liftedFg),
                bg: cloneGrid(liftedBg)
            };
            changed = true;
        } else if (layer) {
            layer.arrangeRegion = null;
            layer.resizeOriginal = null;
        }
        for (let x = 0; x < liftedFg.length; x++) {
            for (let y = 0; y < liftedFg[0].length; y++) {
                const wx = destX + x, wy = destY + y;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;
                if (liftedFg[x][y]) {
                    fgData[wx][wy] = liftedFg[x][y];
                    changed = true;
                }
                if (liftedBg[x][y]) {
                    bgData[wx][wy] = liftedBg[x][y];
                    changed = true;
                }
            }
        }
        liftedFg = null; liftedBg = null; liftedFrom = null;
        invalidateLayerRenderCache(layer);
        syncActiveLayerRefs();
        if (changed) scheduleHistorySnapshot('Move');
    }

    function cancelLift() {
        if (liftedArrangeLayers) {
            liftedArrangeLayers.forEach(item => {
                const layer = editorLayers.find(entry => entry.id === item.layerId);
                if (!layer) return;
                for (let dx = 0; dx < item.data.w; dx++) {
                    for (let dy = 0; dy < item.data.h; dy++) {
                        const wx = item.x + dx, wy = item.y + dy;
                        if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                        if (isProtectedTile(wx, wy)) continue;
                        layer.fg[wx][wy] = item.data.fg[dx][dy];
                        layer.bg[wx][wy] = item.data.bg[dx][dy];
                    }
                }
                invalidateLayerRenderCache(layer);
            });
            liftedArrangeLayers = null;
            liftedFrom = null;
            updateArrangeSelectionBounds();
            syncActiveLayerRefs();
            return;
        }
        // put blocks back where they came from
        if (!liftedFg || !liftedFrom) return;
        for (let dx = 0; dx < liftedFg.length; dx++) {
            for (let dy = 0; dy < liftedFg[0].length; dy++) {
                const wx = liftedFrom.x + dx, wy = liftedFrom.y + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;
                fgData[wx][wy] = liftedFg[dx][dy];
                bgData[wx][wy] = liftedBg[dx][dy];
            }
        }
        liftedFg = null; liftedBg = null; liftedFrom = null;
        invalidateLayerRenderCache(activeLayer());
    }

    // --- Canvas coord helpers ---
    function toTile(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: Math.floor(((clientX - rect.left) / scale) / TILE),
            y: Math.floor(((clientY - rect.top)  / scale) / TILE)
        };
    }

    function drawShapePreview() {
        if (activeTool !== 'shapes' || !isDrawing || !shapeStart || !shapePreviewEnd || !shapeBlock) return;
        const minX = Math.min(shapeStart.x, shapePreviewEnd.x);
        const minY = Math.min(shapeStart.y, shapePreviewEnd.y);
        const maxX = Math.max(shapeStart.x, shapePreviewEnd.x);
        const maxY = Math.max(shapeStart.y, shapePreviewEnd.y);
        const tex = getImg(shapeBlock.texture);
        selCtx.save();
        selCtx.globalAlpha = 0.55;
        forEachShapeTile(shapeStart.x, shapeStart.y, shapePreviewEnd.x, shapePreviewEnd.y, (x, y) => {
            if (tex && tex.complete && tex.naturalWidth > 0) {
                selCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
            } else {
                selCtx.fillStyle = '#3abdc2';
                selCtx.fillRect(x * TILE, y * TILE, TILE, TILE);
            }
        });
        selCtx.globalAlpha = 1;
        selCtx.strokeStyle = '#ffd166';
        selCtx.lineWidth = 2.5;
        selCtx.strokeRect(minX * TILE, minY * TILE, (maxX - minX + 1) * TILE, (maxY - minY + 1) * TILE);
        selCtx.restore();
    }

    // --- Draw selection overlay ---
    function drawSelection() {
        selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);
        drawShapePreview();

        // Rubber-band in progress
        if (selDrag && hasDraggedSelectionBox() && (activeTool === 'select' || activeTool === 'arrange')) {
            const r = normRect(selDrag);
            selCtx.save();
            selCtx.strokeStyle = activeTool === 'arrange' ? '#3abdc2' : 'rgba(58,189,194,0.9)';
            selCtx.lineWidth = 2;
            if (activeTool !== 'arrange') selCtx.setLineDash([6, 4]);
            selCtx.strokeRect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
            selCtx.fillStyle = 'rgba(58,189,194,0.08)';
            selCtx.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
            selCtx.restore();
        }

        if (lassoPath && lassoPath.length && activeTool === 'lasso') {
            selCtx.save();
            selCtx.strokeStyle = '#ffd166';
            selCtx.lineWidth = 2.5;
            selCtx.fillStyle = 'rgba(255, 209, 102, 0.08)';
            selCtx.beginPath();
            lassoPath.forEach((point, index) => {
                const px = (point.x + 0.5) * TILE;
                const py = (point.y + 0.5) * TILE;
                if (index === 0) selCtx.moveTo(px, py);
                else selCtx.lineTo(px, py);
            });
            if (lassoPath.length > 2) {
                selCtx.closePath();
                selCtx.fill();
            }
            selCtx.stroke();
            selCtx.restore();
        }

        // Confirmed box selection.
        if (sel && activeTool !== 'arrange') {
            let drawX = sel.x, drawY = sel.y;
            if (movePreview) { drawX += movePreview.dx; drawY += movePreview.dy; }

            drawSelectionBox({ x: drawX, y: drawY, w: sel.w, h: sel.h });

            // Clipboard paste preview
            selCtx.save();
            if (isPastingMode && clipboard) {
                selCtx.globalAlpha = 0.45;
                for (let dx = 0; dx < clipboard.w; dx++) {
                    for (let dy = 0; dy < clipboard.h; dy++) {
                        const wx = pastePreviewPos.x + dx, wy = pastePreviewPos.y + dy;
                        if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                        const blk = clipboard.fg[dx][dy] || clipboard.bg[dx][dy];
                        if (!blk) continue;
                        const tex = getImg(blk.texture);
                        if (tex && tex.complete && tex.naturalWidth > 0) {
                            selCtx.drawImage(tex, wx * TILE, wy * TILE, TILE, TILE);
                        }
                    }
                }
                selCtx.globalAlpha = 1;
            }

            selCtx.restore();
        }

        if (activeTool === 'arrange' && rotatePreview && rotateSource) {
            if (rotatePreview.multi) {
                rotatePreview.layers.forEach(item => drawRegionPreview(item.data, item.x, item.y));
            } else {
                drawRegionPreview(rotatePreview.data, rotatePreview.x, rotatePreview.y);
            }
            drawSelectionBox({ x: rotatePreview.x, y: rotatePreview.y, w: rotatePreview.w, h: rotatePreview.h }, false);
        } else if (activeTool === 'arrange' && resizePreview && resizeSource) {
            if (resizeSource.multi) {
                scaleMultiArrangeSource(resizeSource, resizePreview).forEach(item => drawRegionPreview(item.data, item.x, item.y));
                drawSelectionBox({ x: resizePreview.x, y: resizePreview.y, w: resizePreview.w, h: resizePreview.h }, false);
            } else {
                const preview = scaleRegionData(resizeSource, resizePreview.w, resizePreview.h);
                drawRegionPreview(preview, resizePreview.x, resizePreview.y);
                drawSelectionBox({ x: resizePreview.x, y: resizePreview.y, w: preview.w, h: preview.h }, false);
            }
        } else if (activeTool === 'arrange' && movePreview && liftedArrangeLayers && sel) {
            liftedArrangeLayers.forEach(item => {
                drawRegionPreview(item.data, item.x + movePreview.dx, item.y + movePreview.dy);
            });
            drawSelectionBox({ x: sel.x + movePreview.dx, y: sel.y + movePreview.dy, w: sel.w, h: sel.h }, false);
        } else if (activeTool === 'arrange' && movePreview && liftedFg && sel) {
            const drawX = sel.x + movePreview.dx;
            const drawY = sel.y + movePreview.dy;
            drawRegionPreview({ fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h }, drawX, drawY);
            drawSelectionBox({ x: drawX, y: drawY, w: sel.w, h: sel.h }, false);
        } else if (activeTool === 'arrange' && sel) {
            drawSelectionBox(sel, false);
        }

        if (activeTool === 'arrange' && arrangeHoverRect && !arrangeSelectedLayerIds.has(arrangeHoverLayerId) && !selDrag && !isMoveDragging && !isResizeDragging && !isRotateDragging) {
            drawArrangeHoverBox(arrangeHoverRect);
        }

        requestAnimationFrame(drawSelection);
    }
    requestAnimationFrame(drawSelection);

    // Keep selCanvas transform in sync with worldCanvas
    function syncSelTransform() {
        selCanvas.style.transform = `translate(-50%, -50%) translate3d(${posX}px, ${posY}px, 0) scale(${scale})`;
        requestAnimationFrame(syncSelTransform);
    }
    requestAnimationFrame(syncSelTransform);

    // --- updateToolState patch ---
    const _origUpdateToolState = updateToolState;
    window.updateToolState = function(tool) {
        _origUpdateToolState(tool);
        const btn = document.getElementById('select-btn');
        if (btn) btn.classList.toggle('active-tool', tool === 'select');
        const arrangeBtn = document.getElementById('arrange-btn');
        if (arrangeBtn) arrangeBtn.classList.toggle('active-tool', tool === 'arrange');
        const sideBtn = document.getElementById('side-select-btn');
        if (sideBtn) sideBtn.classList.toggle('active', tool === 'select');
    };

    // --- Toolbar buttons ---
    const selToolbar  = document.getElementById('sel-toolbar');
    const selMoveHint = document.getElementById('sel-move-hint');
    const selCopyBtn  = document.getElementById('sel-copy-btn');
    const selPasteBtn = document.getElementById('sel-paste-btn');
    const selGroupBtn = document.getElementById('sel-group-btn');
    const selDeleteBtn = document.getElementById('sel-delete-btn');
    const selDeselectBtn = document.getElementById('sel-deselect-btn');
    const sideSelectBtn = document.getElementById('side-select-btn');
    const sideCopyBtn = document.getElementById('side-copy-btn');
    const sidePasteBtn = document.getElementById('side-paste-btn');
    const sideDeleteBtn = document.getElementById('side-delete-btn');
    const sideGroupBtn = document.getElementById('side-group-btn');
    const groupList = document.getElementById('group-list');

    let isPastingMode = false;
    let pastePreviewPos = { x: 0, y: 0 };
    let selectionGroups = [];

    if (selMoveHint) selMoveHint.textContent = 'Move';
    if (selCopyBtn) selCopyBtn.textContent = 'Copy';
    if (selPasteBtn) selPasteBtn.textContent = 'Paste';
    if (selDeleteBtn) selDeleteBtn.textContent = 'Delete';
    if (selDeselectBtn) selDeselectBtn.textContent = 'Deselect';

    function showSelToolbar() {}
    function hideSelToolbar() { if (selToolbar) selToolbar.classList.add('hidden'); }

    function setSelectTool() {
        updateToolState('select');
        activeTool = 'select';
        if (sideSelectBtn) sideSelectBtn.classList.add('active');
    }

    function setLassoTool() {
        document.querySelectorAll('.slot').forEach(s => s.classList.remove('active'));
        updateToolState('lasso');
        activeTool = 'lasso';
    }

    function setArrangeToolLocal() {
        updateToolState('arrange');
        activeTool = 'arrange';
        refreshArrangeSelectionBoundsFromPanel?.();
    }

    function selectLayerContents(layerId = activeLayerId, mode = 'select') {
        const layer = editorLayers.find(item => item.id === layerId);
        if (!layer) return;
        setActiveLayer(layer.id);
        const bounds = getLayerContentBounds(layer);
        if (!bounds) {
            deselect();
            if (mode === 'arrange') setArrangeToolLocal();
            else setSelectTool();
            return;
        }
        sel = bounds;
        if (mode === 'arrange') {
            arrangeSelectedLayerIds = new Set([layer.id]);
            syncArrangePanelSelection(false);
        }
        selDrag = null;
        isPastingMode = false;
        movePreview = null;
        if (mode === 'arrange') setArrangeToolLocal();
        else setSelectTool();
        showSelToolbar();
        updatePasteButtons();
    }

    function updatePasteButtons() {
        if (selPasteBtn) selPasteBtn.style.display = clipboard ? '' : 'none';
        if (sidePasteBtn) sidePasteBtn.classList.toggle('active', isPastingMode);
    }

    function renderGroups() {
        if (!groupList) return;
        groupList.innerHTML = '';
        if (!selectionGroups.length) {
            groupList.innerHTML = '<div class="empty-groups">Select blocks, then create a group.</div>';
            return;
        }
        selectionGroups.forEach((group) => {
            const row = document.createElement('div');
            row.className = 'group-chip';
            const label = document.createElement('span');
            label.textContent = `${group.name} (${group.w}x${group.h})`;
            const use = document.createElement('button');
            use.textContent = 'Use';
            use.onclick = () => {
                clipboard = copyRegion(group.x, group.y, group.w, group.h);
                sel = { x: group.x, y: group.y, w: group.w, h: group.h };
                isPastingMode = true;
                pastePreviewPos = { x: group.x, y: group.y };
                selPasteBtn.textContent = 'Click to paste';
                showSelToolbar();
                setSelectTool();
                updatePasteButtons();
            };
            row.appendChild(label);
            row.appendChild(use);
            groupList.appendChild(row);
        });
    }

    function copySelection() {
        if (!sel) return;
        clipboard = copyRegion(sel.x, sel.y, sel.w, sel.h);
        updatePasteButtons();
        if (selCopyBtn) {
            selCopyBtn.textContent = 'Copied!';
            setTimeout(() => selCopyBtn.textContent = 'Copy', 1200);
        }
    }

    function startPasteMode() {
        if (!clipboard) return;
        isPastingMode = true;
        if (selPasteBtn) selPasteBtn.textContent = 'Click to paste';
        updatePasteButtons();
        setSelectTool();
    }

    function pasteSelectionAsNewLayer(data, destX, destY) {
        if (!data) return;
        saveHistory('Paste Selection Layer');
        syncActiveLayerRefs();
        const layer = {
            id: layerSeq++,
            name: `Selection ${editorLayers.length + 1}`,
            fg: makeGrid(),
            bg: makeGrid(),
            visible: true,
            locked: false
        };
        for (let dx = 0; dx < data.w; dx++) {
            for (let dy = 0; dy < data.h; dy++) {
                const wx = destX + dx, wy = destY + dy;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;
                if (data.fg[dx][dy]) layer.fg[wx][wy] = JSON.parse(JSON.stringify(data.fg[dx][dy]));
                if (data.bg[dx][dy]) layer.bg[wx][wy] = JSON.parse(JSON.stringify(data.bg[dx][dy]));
            }
        }
        const activeIndex = editorLayers.findIndex(item => item.id === activeLayerId);
        editorLayers.splice(activeIndex + 1, 0, layer);
        setActiveLayer(layer.id);
        scheduleHistorySnapshot('Paste Selection Layer');
    }

    function deleteSelection() {
        if (!sel || activeLayerLocked()) return;
        saveHistory();
        clearActiveArrangeRegion();
        deleteRegion(sel.x, sel.y, sel.w, sel.h);
        deselect();
    }

    function createGroupFromSelection() {
        if (!sel) return;
        selectionGroups.push({ name: `Group ${selectionGroups.length + 1}`, x: sel.x, y: sel.y, w: sel.w, h: sel.h });
        clipboard = copyRegion(sel.x, sel.y, sel.w, sel.h);
        renderGroups();
        updatePasteButtons();
    }

    function deselect(options = {}) {
        const preserveLayerSelection = !!options.preserveLayerSelection;
        if (isMoveDragging || isResizeDragging || isRotateDragging) cancelLift();
        sel = null; selDrag = null;
        lassoPath = null;
        arrangeHoverRect = null;
        arrangeHoverLayerId = null;
        if (!preserveLayerSelection) {
            arrangeSelectedLayerIds.clear();
            arrangePanelSelectionIds.clear();
        }
        isMoveDragging = false; isBoxDragging = false; moveStart = null; movePreview = null; boxMoveStart = null;
        isResizeDragging = false; resizeStart = null; resizePreview = null; resizeSource = null; resizeHandle = null;
        isRotateDragging = false; rotateStart = null; rotateSource = null; rotatePreview = null;
        isPastingMode = false;
        hideSelToolbar();
        updatePasteButtons();
        renderLayerPanel();
    }

    if (selCopyBtn) selCopyBtn.onclick = copySelection;
    if (selPasteBtn) selPasteBtn.onclick = startPasteMode;
    if (selGroupBtn) selGroupBtn.onclick = createGroupFromSelection;
    if (selDeleteBtn) selDeleteBtn.onclick = deleteSelection;
    if (sideSelectBtn) sideSelectBtn.onclick = setSelectTool;
    if (sideCopyBtn) sideCopyBtn.onclick = copySelection;
    if (sidePasteBtn) sidePasteBtn.onclick = startPasteMode;
    if (sideDeleteBtn) sideDeleteBtn.onclick = deleteSelection;
    if (sideGroupBtn) sideGroupBtn.onclick = createGroupFromSelection;

    window.selectionActions = {
        copy: copySelection,
        paste: startPasteMode,
        deselect,
        delete: deleteSelection,
        selectTool: setSelectTool,
        selectLayerContents,
        selectArrangeLayer,
        selectArrangeLayers: setArrangeLayerSelection,
        toggleArrangeLayerSelection
    };
    selectArrangeLayerFromPanel = selectArrangeLayer;
    toggleArrangeLayerSelectionFromPanel = toggleArrangeLayerSelection;
    deleteArrangeSelectedLayersFromPanel = deleteArrangeSelectedLayers;
    refreshArrangeSelectionBoundsFromPanel = updateArrangeSelectionBounds;
    getArrangeSelectionCount = () => arrangeSelectedLayerIds.size;

    if (selDeselectBtn) selDeselectBtn.onclick = deselect;
    renderGroups();

    const selectBtn = document.getElementById('select-btn');
    if (selectBtn) {
        selectBtn.onclick = () => {
            if (activeTool === 'select') { deselect(); updateToolState('move'); }
            else setSelectTool();
        };
    }

    // --- Viewport mouse events ---
    // We intercept viewport mousedown/mousemove/mouseup for the select tool.
    // The existing handlers already check activeTool, so we just need to
    // hook in at the right points.

    const origMousedown = viewport.onmousedown;
    viewport.addEventListener('contextmenu', (e) => {
        if (activeTool !== 'arrange' || !sel) return;
        const t = toTile(e.clientX, e.clientY);
        if (!insideSel(t.x, t.y)) return;
        e.preventDefault();
        e.stopPropagation();
        const targetLayerId = arrangeSelectedLayerIds.has(activeLayerId) ? activeLayerId : [...arrangeSelectedLayerIds][0];
        if (targetLayerId) showArrangeContextMenu(e.clientX, e.clientY, targetLayerId);
    });

    viewport.onmousedown = function(e) {
        if (activeTool !== 'select' && activeTool !== 'lasso' && activeTool !== 'arrange') { origMousedown && origMousedown.call(this, e); return; }
        if (e.button !== 0) return;
        layerPanelHasFocus = false;

        const t = toTile(e.clientX, e.clientY);

        if (activeTool === 'lasso') {
            deselect();
            lassoPath = [];
            addLassoPoint(t);
            return;
        }

        if (activeTool === 'select' && sel && insideSel(t.x, t.y) && !isPastingMode) {
            isBoxDragging = true;
            boxMoveStart = { tileX: t.x, tileY: t.y, x: sel.x, y: sel.y };
            viewport.style.cursor = 'move';
            return;
        }

        if (activeTool === 'arrange') {
            if (getRotateHandleAt(t.x, t.y) && sel && !arrangeSelectionLocked()) {
                saveHistory();
                const startBounds = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                liftSelection();
                rotateStart = startBounds;
                rotateSource = isMultiArrangeSelection() ? makeMultiArrangeSource(startBounds) : { fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h };
                rotatePreview = rotateSource?.multi ? rotateMultiArrangeSource(rotateSource, 0) : getRotatedRect(rotateSource, 0);
                isRotateDragging = true;
                viewport.style.cursor = 'grab';
                return;
            }

            const handle = getResizeHandleAt(t.x, t.y);
            if (handle && sel && !arrangeSelectionLocked()) {
                saveHistory();
                const startBounds = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                const originalSource = isMultiArrangeSelection() ? null : captureOriginalResizeSource(activeLayer(), sel);
                liftSelection();
                resizeHandle = handle;
                resizeStart = startBounds;
                resizeSource = isMultiArrangeSelection() ? makeMultiArrangeSource(startBounds) : (originalSource || { fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h });
                resizePreview = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                isResizeDragging = true;
                viewport.style.cursor = 'nwse-resize';
                return;
            }

            const hitLayer = findTopLayerAtTile(t.x, t.y);
            arrangeLayerHasFocus = !!hitLayer;
            if (!hitLayer) {
                deselect();
                selDrag = { x1: t.x, y1: t.y, x2: t.x, y2: t.y };
                return;
            }
            const bounds = getLayerContentBounds(hitLayer);
            if (!bounds || !isInsideRect(t.x, t.y, bounds)) {
                deselect();
                selDrag = { x1: t.x, y1: t.y, x2: t.x, y2: t.y };
                return;
            }
            if (e.shiftKey) {
                addArrangeLayerSelection(hitLayer);
                return;
            }
            if (!arrangeSelectedLayerIds.has(hitLayer.id)) {
                setArrangeLayerSelection([hitLayer], hitLayer.id);
            } else if (hitLayer.id !== activeLayerId) {
                setActiveLayer(hitLayer.id);
            }
            if (arrangeSelectionLocked()) return;
            arrangeHoverRect = null;
            saveHistory();
            isMoveDragging = true;
            moveStart = t;
            movePreview = { dx: 0, dy: 0 };
            liftSelection();
            viewport.style.cursor = 'grabbing';
            return;
        }

        // Paste mode: click places the clipboard
        if (activeTool === 'select' && isPastingMode && clipboard) {
            const dest = clampRegionPos(t.x, t.y, clipboard.w, clipboard.h);
            if (!canPasteSelectionLayer(clipboard, dest.x, dest.y)) {
                viewport.style.cursor = 'not-allowed';
                return;
            }
            pasteSelectionAsNewLayer(clipboard, dest.x, dest.y);
            isPastingMode = false;
            sel = { x: dest.x, y: dest.y, w: clipboard.w, h: clipboard.h };
            if (selPasteBtn) selPasteBtn.textContent = 'Paste';
            updatePasteButtons();
            return;
        }

        // Select is only a rubber-band box. Arrange keeps the current layer selection.
        deselect();
        selDrag = { x1: t.x, y1: t.y, x2: t.x, y2: t.y };
    };

    const origMousemove = window.onmousemove;
    window.onmousemove = function(e) {
        if (activeTool !== 'select' && activeTool !== 'lasso' && activeTool !== 'arrange') { origMousemove && origMousemove.call(this, e); return; }

        // Update coords display (same as original)
        const rect = canvas.getBoundingClientRect();
        const mouseX = Math.floor(((e.clientX - rect.left) / scale) / TILE);
        const mouseY = Math.floor(((e.clientY - rect.top)  / scale) / TILE);
        if (mouseX >= 0 && mouseX < GRID_X && mouseY >= 0 && mouseY < GRID_Y) {
            coordsDisplay.innerText = `X: ${mouseX}, Y: ${mouseY}`;
            document.getElementById('nav-x').innerText = mouseX;
            document.getElementById('nav-y').innerText = mouseY;
            coordsDisplay.style.color = '#3abdc2';
        } else {
            coordsDisplay.style.color = '#ff4444';
        }

        if (isPanning) { posX += e.movementX; posY += e.movementY; updateTransform(); return; }

        if (activeTool === 'select' && isBoxDragging && sel && boxMoveStart) {
            const t = toTile(e.clientX, e.clientY);
            const next = clampRegionPos(boxMoveStart.x + t.x - boxMoveStart.tileX, boxMoveStart.y + t.y - boxMoveStart.tileY, sel.w, sel.h);
            sel.x = next.x;
            sel.y = next.y;
            viewport.style.cursor = 'move';
            return;
        }

        if (activeTool === 'lasso' && lassoPath) {
            addLassoPoint({ x: mouseX, y: mouseY });
            viewport.style.cursor = 'crosshair';
            return;
        }

        if (activeTool === 'arrange' && isMoveDragging && sel && moveStart) {
            const t = toTile(e.clientX, e.clientY);
            const dest = { x: sel.x + t.x - moveStart.x, y: sel.y + t.y - moveStart.y };
            movePreview = { dx: dest.x - sel.x, dy: dest.y - sel.y };
            const canPlace = liftedArrangeLayers
                ? canPlaceLiftedArrangeLayers(movePreview.dx, movePreview.dy)
                : canPlaceArrangeRegion({ fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h }, dest.x, dest.y, { x: sel.x, y: sel.y, w: sel.w, h: sel.h });
            viewport.style.cursor = canPlace ? 'grabbing' : 'not-allowed';
            return;
        }

        if (activeTool === 'arrange' && isResizeDragging && resizeStart && resizeSource) {
            const t = toTile(e.clientX, e.clientY);
            resizePreview = getResizePreviewRect(t);
            if (e.shiftKey) resizePreview = getAspectLockedResizeRect(resizePreview);
            const canPlace = resizeSource.multi
                ? canPlaceArrangeItems(scaleMultiArrangeSource(resizeSource, resizePreview))
                : canPlaceArrangeRegion(scaleRegionData(resizeSource, resizePreview.w, resizePreview.h), resizePreview.x, resizePreview.y);
            viewport.style.cursor = canPlace ? 'nwse-resize' : 'not-allowed';
            return;
        }

        if (activeTool === 'arrange' && isRotateDragging && rotateStart && rotateSource) {
            const t = toTile(e.clientX, e.clientY);
            rotatePreview = rotateSource.multi ? rotateMultiArrangeSource(rotateSource, getRotateTurns(t)) : getRotatedRect(rotateSource, getRotateTurns(t));
            const canPlace = rotatePreview?.multi
                ? canPlaceArrangeItems(rotatePreview.layers)
                : canPlaceArrangeRegion(rotatePreview.data, rotatePreview.x, rotatePreview.y);
            viewport.style.cursor = canPlace ? 'grabbing' : 'not-allowed';
            return;
        }

        if (activeTool === 'select' && selDrag) {
            const t = toTile(e.clientX, e.clientY);
            selDrag.x2 = Math.max(0, Math.min(GRID_X - 1, t.x));
            selDrag.y2 = Math.max(0, Math.min(GRID_Y - 1, t.y));
        }

        if (activeTool === 'arrange' && selDrag) {
            const t = toTile(e.clientX, e.clientY);
            selDrag.x2 = Math.max(0, Math.min(GRID_X - 1, t.x));
            selDrag.y2 = Math.max(0, Math.min(GRID_Y - 1, t.y));
        }

        if (activeTool === 'select' && isPastingMode && clipboard) {
            const t = toTile(e.clientX, e.clientY);
            pastePreviewPos = clampRegionPos(t.x, t.y, clipboard.w, clipboard.h);
            // reuse sel rect to show paste preview outline
            sel = { x: pastePreviewPos.x, y: pastePreviewPos.y, w: clipboard.w, h: clipboard.h };
            viewport.style.cursor = canPasteSelectionLayer(clipboard, pastePreviewPos.x, pastePreviewPos.y) ? 'copy' : 'not-allowed';
            return;
        }

        if (activeTool === 'arrange') {
            if (isMoveDragging || isResizeDragging || isRotateDragging) {
                arrangeHoverRect = null;
                arrangeHoverLayerId = null;
            } else if (selDrag) {
                arrangeHoverRect = null;
                arrangeHoverLayerId = null;
            } else {
                const hoverLayer = findTopLayerAtTile(mouseX, mouseY);
                const hoverBounds = hoverLayer ? getLayerContentBounds(hoverLayer) : null;
                const canHover = hoverLayer && !arrangeSelectedLayerIds.has(hoverLayer.id) && hoverBounds && isInsideRect(mouseX, mouseY, hoverBounds);
                arrangeHoverRect = canHover ? hoverBounds : null;
                arrangeHoverLayerId = canHover ? hoverLayer.id : null;
            }
        } else {
            arrangeHoverRect = null;
            arrangeHoverLayerId = null;
        }

        // Cursor feedback
        if (activeTool === 'select' && sel && insideSel(mouseX, mouseY) && !isPastingMode) {
            viewport.style.cursor = 'move';
        } else if (activeTool === 'arrange' && getRotateHandleAt(mouseX, mouseY)) {
            viewport.style.cursor = 'grab';
        } else if (activeTool === 'arrange' && getResizeHandleAt(mouseX, mouseY)) {
            viewport.style.cursor = 'nwse-resize';
        } else if (activeTool === 'arrange' && arrangeHoverRect) {
            viewport.style.cursor = 'grab';
        } else if (isPastingMode) {
            viewport.style.cursor = 'copy';
        } else {
            viewport.style.cursor = 'crosshair';
        }
    };

    const origMouseup = window.onmouseup;
    window.onmouseup = function(e) {
        if (activeTool !== 'select' && activeTool !== 'lasso' && activeTool !== 'arrange') { origMouseup && origMouseup.call(this, e); return; }

        if (activeTool === 'select' && isBoxDragging) {
            isBoxDragging = false;
            boxMoveStart = null;
            viewport.style.cursor = 'move';
            return;
        }

        if (activeTool === 'lasso' && lassoPath) {
            const bounds = lassoBounds();
            lassoPath = null;
            if (bounds) {
                sel = bounds;
                showSelToolbar();
            } else {
                sel = null;
                hideSelToolbar();
            }
            viewport.style.cursor = 'crosshair';
            return;
        }

        if (activeTool === 'arrange' && isMoveDragging && movePreview) {
            // Commit the move
            const dx = movePreview.dx, dy = movePreview.dy;
            const canPlace = liftedArrangeLayers
                ? canPlaceLiftedArrangeLayers(dx, dy)
                : canPlaceArrangeRegion({ fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h }, sel.x + dx, sel.y + dy, { x: sel.x, y: sel.y, w: sel.w, h: sel.h });
            if (!canPlace) {
                cancelLift();
                isMoveDragging = false; moveStart = null; movePreview = null;
                viewport.style.cursor = 'grab';
                showSelToolbar();
                return;
            }
            dropLifted(dx, dy, true);
            if (isMultiArrangeSelection()) updateArrangeSelectionBounds();
            else sel = getLayerContentBounds(activeLayer());
            isMoveDragging = false; moveStart = null; movePreview = null;
            viewport.style.cursor = 'grab';
            return;
        }

        if (activeTool === 'arrange' && isResizeDragging && resizePreview && resizeSource && resizeStart) {
            if (resizeSource.multi) {
                const items = scaleMultiArrangeSource(resizeSource, resizePreview);
                if (!canPlaceArrangeItems(items)) {
                    cancelLift();
                    updateArrangeSelectionBounds();
                    isResizeDragging = false; resizeStart = null; resizePreview = null; resizeSource = null; resizeHandle = null;
                    viewport.style.cursor = 'grab';
                    return;
                }
                dropArrangeItems(items, 'Resize Layers');
                isResizeDragging = false; resizeStart = null; resizePreview = null; resizeSource = null; resizeHandle = null;
                viewport.style.cursor = 'grab';
                return;
            }
            const scaled = scaleRegionData(resizeSource, resizePreview.w, resizePreview.h);
            if (!canPlaceArrangeRegion(scaled, resizePreview.x, resizePreview.y)) {
                cancelLift();
                sel = getLayerContentBounds(activeLayer());
                isResizeDragging = false; resizeStart = null; resizePreview = null; resizeSource = null; resizeHandle = null;
                viewport.style.cursor = 'grab';
                return;
            }
            sel = { x: resizePreview.x, y: resizePreview.y, w: scaled.w, h: scaled.h };
            liftedFg = scaled.fg;
            liftedBg = scaled.bg;
            dropLifted(0, 0, true);
            sel = getLayerContentBounds(activeLayer());
            isResizeDragging = false; resizeStart = null; resizePreview = null; resizeSource = null; resizeHandle = null;
            viewport.style.cursor = 'grab';
            return;
        }

        if (activeTool === 'arrange' && isRotateDragging && rotatePreview && rotateSource && rotateStart) {
            if (rotateSource.multi) {
                if (!canPlaceArrangeItems(rotatePreview.layers)) {
                    cancelLift();
                    updateArrangeSelectionBounds();
                    isRotateDragging = false; rotateStart = null; rotateSource = null; rotatePreview = null;
                    viewport.style.cursor = 'grab';
                    return;
                }
                dropArrangeItems(rotatePreview.layers, 'Rotate Layers');
                isRotateDragging = false; rotateStart = null; rotateSource = null; rotatePreview = null;
                viewport.style.cursor = 'grab';
                return;
            }
            if (!canPlaceArrangeRegion(rotatePreview.data, rotatePreview.x, rotatePreview.y)) {
                cancelLift();
                sel = getLayerContentBounds(activeLayer());
                isRotateDragging = false; rotateStart = null; rotateSource = null; rotatePreview = null;
                viewport.style.cursor = 'grab';
                return;
            }
            sel = { x: rotatePreview.x, y: rotatePreview.y, w: rotatePreview.w, h: rotatePreview.h };
            liftedFg = rotatePreview.data.fg;
            liftedBg = rotatePreview.data.bg;
            dropLifted(0, 0, true);
            const layer = activeLayer();
            if (layer) layer.resizeOriginal = cloneArrangeRegion(layer.arrangeRegion);
            sel = getLayerContentBounds(activeLayer());
            isRotateDragging = false; rotateStart = null; rotateSource = null; rotatePreview = null;
            viewport.style.cursor = 'grab';
            return;
        }

        if (activeTool === 'select' && selDrag) {
            if (!hasDraggedSelectionBox()) {
                selDrag = null;
                sel = null;
                hideSelToolbar();
                viewport.style.cursor = 'crosshair';
                return;
            }
            sel = normRect(selDrag);
            selDrag = null;
            if (sel.w > 0 && sel.h > 0) showSelToolbar();
            else sel = null;
        }

        if (activeTool === 'arrange' && selDrag) {
            const box = normRect(selDrag);
            selDrag = null;
            const picked = selectArrangeLayersInRect(box);
            if (!picked) deselect();
            viewport.style.cursor = picked ? 'grab' : 'crosshair';
            return;
        }
    };

    // Middle mouse pan still works in select mode (handled by existing panning flag)
    // We re-patch isPanning check so middle button still works
    const origVpDown = viewport.onmousedown;
    // Middle-button pan in select mode
    viewport.addEventListener('mousedown', (e) => {
        if ((activeTool === 'select' || activeTool === 'lasso' || activeTool === 'arrange') && e.button === 1) {
            isPanning = true;
        }
    });
    window.addEventListener('mouseup', (e) => {
        if (e.button === 1) isPanning = false;
    });

    // --- Keyboard shortcuts ---
    const origKeydown = window.onkeydown;
    window.onkeydown = function(e) {
        if (e.defaultPrevented) return;
        // Let normal shortcuts run if not in select mode
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { origKeydown && origKeydown.call(this, e); return; }
        const deleteKey = e.key === 'Delete' || e.key === 'Backspace' || e.keyCode === 46 || e.keyCode === 8;

        // Selection shortcut removed.

        if (activeTool === 'select' || activeTool === 'lasso' || activeTool === 'arrange') {
            if (e.key === 'Escape') { e.preventDefault(); deselect(); return; }
            if (activeTool === 'arrange' && (e.ctrlKey || e.metaKey)) {
                const key = e.key.toLowerCase();
                if (key === 'x') { e.preventDefault(); cutTargetLayers(activeLayerId); return; }
                if (key === 'c') { e.preventDefault(); copyActiveLayer(activeLayerId); return; }
                if (key === 'v') { e.preventDefault(); pasteLayer(); return; }
                if (key === 'd') { e.preventDefault(); duplicateTargetLayers(activeLayerId); return; }
            }

            if ((activeTool === 'select' || activeTool === 'lasso') && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel) {
                e.preventDefault();
                copySelection();
                return;
            }

            if ((activeTool === 'select' || activeTool === 'lasso') && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipboard) {
                e.preventDefault();
                const target = sel || { x: pastePreviewPos.x, y: pastePreviewPos.y };
                pasteSelectionAsNewLayer(clipboard, target.x, target.y);
                return;
            }

            if ((activeTool === 'select' || activeTool === 'lasso') && deleteKey && sel) {
                e.preventDefault();
                deleteSelection();
                return;
            }

            if (activeTool === 'arrange' && deleteKey && arrangeSelectedLayerIds.size) {
                e.preventDefault();
                deleteArrangeSelectedLayers();
                return;
            }

            if (activeTool === 'arrange' && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
                if (!sel) sel = getLayerContentBounds(activeLayer());
                if (!sel) return;
                e.preventDefault();
                saveHistory();
                liftSelection();
                const ddx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                const ddy = e.key === 'ArrowUp'   ? -1 : e.key === 'ArrowDown'  ? 1 : 0;
                const canPlace = liftedArrangeLayers
                    ? canPlaceLiftedArrangeLayers(ddx, ddy)
                    : canPlaceArrangeRegion({ fg: liftedFg, bg: liftedBg, w: sel.w, h: sel.h }, sel.x + ddx, sel.y + ddy, { x: sel.x, y: sel.y, w: sel.w, h: sel.h });
                if (!canPlace) {
                    cancelLift();
                    return;
                }
                dropLifted(ddx, ddy, true);
                sel = getLayerContentBounds(activeLayer());
                if (isMultiArrangeSelection()) updateArrangeSelectionBounds();
                return;
            }
        }

        const layerDeleteFocused = layerPanelHasFocus || arrangeLayerHasFocus || !!e.target.closest?.('#layer-list, #layer-context-menu');
        if (layerDeleteFocused && deleteKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            if (getArrangeSelectionCount() > 1 && deleteArrangeSelectedLayersFromPanel) {
                deleteArrangeSelectedLayersFromPanel();
                return;
            }
            deleteLayer(layerDeleteTargetId || selectedLayerId);
            return;
        }

        origKeydown && origKeydown.call(this, e);
    };
})();

// ============================================================
// FEATURE: Reference Image Overlay
// ============================================================
let refImg = null;
let refOverlayImg = null;

const refOverlayLayer = (() => {
    const layer = document.createElement('div');
    layer.id = 'ref-overlay-layer';
    layer.style.cssText = `position:absolute;top:50%;left:50%;width:${canvas.width}px;height:${canvas.height}px;pointer-events:none;z-index:10;transform-origin:top left;overflow:hidden;`;
    viewport.appendChild(layer);
    return layer;
})();

const refOverlayEl = (() => {
    const el = document.createElement('img');
    el.id = 'ref-overlay-img';
    el.style.cssText = `position:absolute;top:0;left:0;width:${canvas.width}px;height:${canvas.height}px;pointer-events:none;transform-origin:top left;max-width:none;max-height:none;object-fit:fill;`;
    refOverlayLayer.appendChild(el);
    return el;
})();

function updateRefOverlay() {
    refOverlayLayer.style.transform = `translate(-50%, -50%) translate(${posX}px, ${posY}px) scale(${scale})`;
    if (!refImg) { refOverlayLayer.style.display = 'none'; return; }
    const visible = document.getElementById('ref-visible').checked;
    const opacity = document.getElementById('ref-opacity').value / 100;
    const sc = document.getElementById('ref-scale').value / 100;
    const ox = parseInt(document.getElementById('ref-offset-x').value);
    const oy = parseInt(document.getElementById('ref-offset-y').value);
    refOverlayEl.src = refImg;
    refOverlayLayer.style.display = visible ? 'block' : 'none';
    refOverlayLayer.style.opacity = opacity;
    refOverlayEl.style.transform = `translate(${ox}px, ${oy}px) scale(${sc})`;
}

// Hook into updateTransform to also update overlay
const _origUpdateTransform = updateTransform;
// We override by patching after the fact
setInterval(updateRefOverlay, 50);
updateRefOverlay();

const refOverlayBtn = document.getElementById('ref-overlay-btn');
if (refOverlayBtn) refOverlayBtn.onclick = () => openMenu('ref-overlay-popup');
document.getElementById('ref-upload-btn').onclick = () => document.getElementById('ref-overlay-input').click();
document.getElementById('ref-overlay-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        refImg = ev.target.result;
        refOverlayEl.src = refImg;
        document.getElementById('ref-controls').classList.remove('hidden');
        updateRefOverlay();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

document.getElementById('ref-opacity').oninput = (e) => {
    document.getElementById('ref-opacity-val').innerText = e.target.value + '%';
    updateRefOverlay();
};
document.getElementById('ref-scale').oninput = (e) => {
    document.getElementById('ref-scale-val').innerText = e.target.value + '%';
    updateRefOverlay();
};
document.getElementById('ref-offset-x').oninput = updateRefOverlay;
document.getElementById('ref-offset-y').oninput = updateRefOverlay;
document.getElementById('ref-visible').onchange = updateRefOverlay;
document.getElementById('ref-clear-btn').onclick = () => {
    refImg = null;
    refOverlayEl.src = '';
    refOverlayLayer.style.display = 'none';
    document.getElementById('ref-controls').classList.add('hidden');
};

// ============================================================
// FEATURE: Custom Background
// ============================================================
const customBgBtn = document.getElementById('custom-bg-btn');
if (customBgBtn) customBgBtn.onclick = () => openMenu('custom-bg-popup');
function applyCustomBackground(dataUrl, recordHistory = true) {
    if (!dataUrl) return;
    if (recordHistory) saveHistory();
    customBgDataUrl = dataUrl;
    activeAtmosphere = null;
    canvas.style.backgroundImage = `url("${customBgDataUrl}")`;
    canvas.style.backgroundSize = '100% 100%';
    const thumb = document.getElementById('custom-bg-thumb');
    const preview = document.getElementById('custom-bg-preview');
    if (thumb) thumb.src = customBgDataUrl;
    if (preview) preview.classList.remove('hidden');
}

document.getElementById('custom-bg-upload-btn')?.addEventListener('click', () => document.getElementById('custom-bg-input')?.click());
document.getElementById('custom-bg-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        applyCustomBackground(ev.target.result, true);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});
document.getElementById('custom-bg-apply-btn')?.addEventListener('click', () => {
    if (!customBgDataUrl) return;
    applyCustomBackground(customBgDataUrl, true);
    closeAll();
});
document.getElementById('custom-bg-remove-btn')?.addEventListener('click', () => {
    saveHistory();
    customBgDataUrl = null;
    canvas.style.backgroundImage = 'none';
    canvas.style.backgroundSize = 'cover';
    document.getElementById('custom-bg-preview').classList.add('hidden');
});



// ============================================================
// FEATURE: Image to Blocks Converter (Enhanced with Depth & Shading)
// ============================================================
let i2bImgData = null;
let i2bImgEl = null;
const RECENT_IMAGE_KEY = 'pwworldeditor_recent_images_v1';
const RECENT_IMAGE_LIMIT = 6;
const RECENT_IMAGE_MAX_CHARS = 2200000;
let recentImages = [];

function loadRecentImages() {
    try {
        const stored = JSON.parse(localStorage.getItem(RECENT_IMAGE_KEY) || '[]');
        recentImages = Array.isArray(stored) ? stored.filter(img => img && img.data) : [];
    } catch (e) {
        recentImages = [];
    }
}

function saveRecentImages() {
    try {
        localStorage.setItem(RECENT_IMAGE_KEY, JSON.stringify(recentImages));
    } catch (e) {
        const smaller = recentImages.filter(img => (img.data || '').length <= RECENT_IMAGE_MAX_CHARS).slice(0, 3);
        try { localStorage.setItem(RECENT_IMAGE_KEY, JSON.stringify(smaller)); } catch (err) {}
    }
}

function addRecentImage(name, data) {
    if (!data) return;
    const label = (name || `Image ${new Date().toLocaleTimeString()}`).split(/[\\/]/).pop();
    recentImages = recentImages.filter(img => img.data !== data);
    recentImages.unshift({
        name: label,
        data,
        savedAt: Date.now()
    });
    recentImages = recentImages.slice(0, RECENT_IMAGE_LIMIT);
    saveRecentImages();
    renderRecentImagePickers();
}

function renderRecentImagePickers() {
    const pickerIds = [
        ['img2blocks-recent-select', 'img2blocks-recent-thumb'],
        ['i2w-rep-recent-select', 'i2w-rep-recent-thumb'],
        ['i2w-gen-recent-select', 'i2w-gen-recent-thumb']
    ];
    for (const [id, thumbId] of pickerIds) {
        const select = document.getElementById(id);
        if (!select) continue;
        select.innerHTML = '';
        if (!recentImages.length) {
            select.innerHTML = '<option value="">No recent images</option>';
            select.disabled = true;
            updateRecentImageThumb(id, thumbId);
            continue;
        }
        select.disabled = false;
        recentImages.forEach((img, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            const name = img.name || `Recent image ${index + 1}`;
            option.textContent = name.length > 34 ? `${name.slice(0, 18)}...${name.slice(-12)}` : name;
            option.title = name;
            select.appendChild(option);
        });
        updateRecentImageThumb(id, thumbId);
        select.onchange = () => updateRecentImageThumb(id, thumbId);
    }
}

function getSelectedRecentImage(selectId) {
    const select = document.getElementById(selectId);
    if (!select || select.value === '') return null;
    return recentImages[parseInt(select.value, 10)] || null;
}

function updateRecentImageThumb(selectId, thumbId) {
    const thumb = document.getElementById(thumbId);
    if (!thumb) return;
    const recent = getSelectedRecentImage(selectId);
    if (!recent) {
        thumb.innerHTML = '<span>No</span>';
        return;
    }
    thumb.innerHTML = `<img src="${recent.data}" alt="" title="${recent.name || ''}" style="width:100%;height:100%;object-fit:cover;display:block;">`;
}

const img2BlocksBtn = document.getElementById('img2blocks-btn');
if (img2BlocksBtn) img2BlocksBtn.onclick = () => openMenu('img2blocks-popup');
document.getElementById('img2blocks-upload-btn').onclick = () => document.getElementById('img2blocks-input').click();
loadRecentImages();
renderRecentImagePickers();
function autoSizeImg2BlocksFields() {
    if (!i2bImgData) return;
    const sizeProbe = new Image();
    sizeProbe.onload = () => {
        const doFlip = document.getElementById('i2b-flip').checked;
        const imgW = doFlip ? sizeProbe.height : sizeProbe.width;
        const imgH = doFlip ? sizeProbe.width : sizeProbe.height;
        const fit = Math.min(GRID_X / imgW, GRID_Y / imgH, 1);
        const tileW = Math.max(1, Math.min(GRID_X, Math.round(imgW * fit)));
        const tileH = Math.max(1, Math.min(GRID_Y, Math.round(imgH * fit)));
        document.getElementById('i2b-w').value = tileW;
        document.getElementById('i2b-h').value = tileH;
        document.getElementById('i2b-x').value = Math.max(0, Math.floor((GRID_X - tileW) / 2));
        document.getElementById('i2b-y').value = 0;
        document.getElementById('i2b-status').innerText = `Image loaded. Auto size: ${tileW} x ${tileH} tiles.`;
    };
    sizeProbe.src = i2bImgData;
}
function setImg2BlocksImage(data, name, remember = true) {
    i2bImgData = data;
    const preview = document.getElementById('i2b-preview');
    preview.innerHTML = `<img src="${i2bImgData}" title="${name || ''}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #444;">`;
    document.getElementById('img2blocks-controls').classList.remove('hidden');
    autoSizeImg2BlocksFields();
    if (remember) addRecentImage(name, data);
}
document.getElementById('img2blocks-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        setImg2BlocksImage(ev.target.result, file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};
document.getElementById('img2blocks-recent-use-btn')?.addEventListener('click', () => {
    const recent = getSelectedRecentImage('img2blocks-recent-select');
    if (!recent) return;
    setImg2BlocksImage(recent.data, recent.name, false);
});
document.getElementById('i2b-flip').onchange = autoSizeImg2BlocksFields;

const generationLocks = {};
let img2BlocksSection = 'pixel';
function setImg2BlocksSection(section) {
    img2BlocksSection = section === 'world' ? 'world' : 'pixel';
    document.getElementById('i2b-variety').value = img2BlocksSection === 'pixel' ? '1' : '2';
    document.querySelectorAll('.i2b-pixel-controls').forEach(el => el.classList.toggle('hidden', img2BlocksSection !== 'pixel'));
    document.querySelectorAll('.i2b-world-controls').forEach(el => el.classList.toggle('hidden', img2BlocksSection !== 'world'));
    document.getElementById('i2b-section-pixel')?.classList.toggle('highlight', img2BlocksSection === 'pixel');
    document.getElementById('i2b-section-world')?.classList.toggle('highlight', img2BlocksSection === 'world');
    const label = document.getElementById('i2b-section-label');
    if (label) label.innerText = img2BlocksSection === 'pixel' ? 'Pixel Art' : 'World Asset';
    const btn = document.getElementById('img2blocks-convert-btn');
    if (btn && !generationLocks.img2blocks) {
        btn.innerText = img2BlocksSection === 'pixel' ? 'Convert to Pixel Art' : 'Build World Asset';
        btn.dataset.originalText = btn.innerText;
    }
}
document.getElementById('i2b-section-pixel')?.addEventListener('click', () => setImg2BlocksSection('pixel'));
document.getElementById('i2b-section-world')?.addEventListener('click', () => setImg2BlocksSection('world'));
setImg2BlocksSection('pixel');

// ---
// SHARED: Sample average color from a block texture
// ---
function sampleBlockColor(block) {
    return new Promise((resolve) => {
        const img = imgCache[block.texture] || (() => {
            const i = new Image(); i.src = block.texture; return i;
        })();
        const doSample = () => {
            try {
                const c = document.createElement('canvas');
                c.width = 4; c.height = 4;
                const cx = c.getContext('2d');
                cx.drawImage(img, 0, 0, 4, 4);
                const d = cx.getImageData(0, 0, 4, 4).data;
                let r=0, g=0, b=0, count=0;
                for (let i=0; i<d.length; i+=4) {
                    if (d[i+3] > 64) { r+=d[i]; g+=d[i+1]; b+=d[i+2]; count++; }
                }
                if (count === 0) { resolve(null); return; }
                const avgR = Math.round(r/count);
                const avgG = Math.round(g/count);
                const avgB = Math.round(b/count);
                const lum = 0.299*avgR + 0.587*avgG + 0.114*avgB;
                resolve({ r: avgR, g: avgG, b: avgB, lum, block });
            } catch(e) { resolve(null); }
        };
        if (img.complete && img.naturalWidth > 0) doSample();
        else { img.onload = doSample; img.onerror = () => resolve(null); }
    });
}

// ---
// SHARED: Closest color match (perceptual, weighted)
// ---
function findClosestBlock(r, g, b, palette) {
    let best = null, bestDist = Infinity;
    for (const entry of palette) {
        const dr = r - entry.r, dg = g - entry.g, db = b - entry.b;
        const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
        if (dist < bestDist) { bestDist = dist; best = entry; }
    }
    return best;
}

function beginGenerationLock(key, buttonId, busyText) {
    if (generationLocks[key]) return null;
    const btn = document.getElementById(buttonId);
    generationLocks[key] = true;
    if (btn) {
        btn.dataset.originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = busyText;
        btn.classList.add('is-generating');
    }
    return () => {
        generationLocks[key] = false;
        if (btn) {
            btn.disabled = false;
            btn.innerText = btn.dataset.originalText || btn.innerText;
            btn.classList.remove('is-generating');
        }
    };
}

function isGreyLeanAssetName(block) {
    const name = ((block && (block.fileName || block.name || block.label)) || '').toLowerCase();
    return name.includes('grey')
        || name.includes('gray')
        || name.includes('moon raker')
        || name.includes('moonraker')
        || name.includes('moon racker')
        || name.includes('moonracker')
        || name.includes('moon rock')
        || name.includes('moon soil')
        || name.includes('soilblockgrey')
        || name.includes('amethyst smoke')
        || name.includes('salt box');
}

// ---
// SHARED: Sample image into pixel canvas + collect pixel data
// ---
function sampleImageToCanvas(tempImg, outW, outH, doFlip) {
    const offscreen = document.createElement('canvas');
    offscreen.width = outW; offscreen.height = outH;
    const offCtx = offscreen.getContext('2d');
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';
    if (doFlip) {
        offCtx.save();
        offCtx.translate(outW, 0);
        offCtx.rotate(Math.PI / 2);
        offCtx.drawImage(tempImg, 0, 0, outH, outW);
        offCtx.restore();
    } else {
        offCtx.drawImage(tempImg, 0, 0, outW, outH);
    }
    return cleanSampledPixels(offCtx.getImageData(0, 0, outW, outH).data, outW, outH);
}

// Remove isolated resampling speckles without changing established colour or
// depth behavior. Pixels are replaced only when the surrounding area is highly
// consistent and the center pixel is a clear outlier.
function cleanSampledPixels(pixelData, width, height) {
    const source = new Uint8ClampedArray(pixelData);
    const cleaned = new Uint8ClampedArray(pixelData);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = (y * width + x) * 4;
            if (source[center + 3] < 64) continue;

            let count = 0, r = 0, g = 0, b = 0;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0) continue;
                    const ni = ((y + oy) * width + x + ox) * 4;
                    if (source[ni + 3] < 64) continue;
                    r += source[ni]; g += source[ni + 1]; b += source[ni + 2];
                    count++;
                }
            }
            if (count < 6) continue;
            r /= count; g /= count; b /= count;

            let variance = 0;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0) continue;
                    const ni = ((y + oy) * width + x + ox) * 4;
                    if (source[ni + 3] < 64) continue;
                    const dr = source[ni] - r, dg = source[ni + 1] - g, db = source[ni + 2] - b;
                    variance += dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                }
            }
            variance /= count;
            const dr = source[center] - r, dg = source[center + 1] - g, db = source[center + 2] - b;
            const centerDist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
            if (variance < 550 && centerDist > 2200) {
                cleaned[center] = Math.round(r);
                cleaned[center + 1] = Math.round(g);
                cleaned[center + 2] = Math.round(b);
            }
        }
    }
    return cleaned;
}

// ---
// SHARED: Batch block color sampler
// ---
function batchSampleBlocks(candidateBlocks, statusEl, label, callback) {
    const BATCH = 50;
    const results = [];
    let idx = 0;
    function processBatch() {
        const slice = candidateBlocks.slice(idx, idx + BATCH);
        idx += BATCH;
        Promise.all(slice.map(sampleBlockColor)).then(batch => {
            batch.forEach(r => { if (r) results.push(r); });
            if (idx < candidateBlocks.length) {
                statusEl.innerText = `${label} ${Math.min(idx, candidateBlocks.length)}/${candidateBlocks.length}`;
                setTimeout(processBatch, 0);
            } else {
                callback(results);
            }
        });
    }
    processBatch();
}

// ---
// SHARED: Detect if image is monochrome / ink art (B&W manga, line art, etc.)
// Returns true when the image has very low color saturation on average,
// meaning it is essentially grayscale and should be treated as ink art.
// ---
function detectMonochrome(pixelData, outW, outH) {
    let totalSat = 0, count = 0, strongColor = 0, warmAccent = 0;
    for (let i = 0; i < outW * outH; i++) {
        const pi = i * 4;
        if (pixelData[pi+3] < 64) continue;
        const r = pixelData[pi] / 255, g = pixelData[pi+1] / 255, b = pixelData[pi+2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const span = max - min;
        const sat = max > 0 ? span / max : 0;
        totalSat += span;
        if (sat > 0.24 && max > 0.22) strongColor++;
        if (r > g + 0.08 && g > b + 0.04 && sat > 0.20 && max > 0.20) warmAccent++;
        count++;
    }
    if (count === 0) return false;
    // Average saturation below 0.08 is grayscale only when there are no meaningful accent colors.
    return (totalSat / count) < 0.08
        && (strongColor / count) < 0.004
        && (warmAccent / count) < 0.002;
}

// ---
// MODE 1a: INK ART MODE -for B&W manga, line art, halftone art.
// Dark pixels = ink = place block. Light pixels = paper = leave empty.
// Uses a 4-tier ink density system so halftones and gradients render faithfully:
//   Tier 0 (solid ink, darkFactor >=0.72): darkest block (Black or near-black)
//   Tier 1 (dark tone, >=0.45):            dark-grey block
//   Tier 2 (halftone, >=0.22):             mid-grey block
//   Tier 3 (near-white, < 0.22):           leave empty (paper)
// The Sobel edge map is used to boost ink lines -edges always get at least Tier 1
// regardless of raw luminance, so fine hair lines and contour strokes are never lost.
// ---
function runInkArtMode(pixelData, outW, outH, startX, startY, statusEl, onComplete = null) {
    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return b.fileName.startsWith('Pixel Block');
    });

    if (candidateBlocks.length === 0) {
        statusEl.innerText = 'Error: No Pixel Blocks found!';
        if (onComplete) onComplete();
        return;
    }

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling pixel blocks (ink art)...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: Could not sample pixel block colors.'; if (onComplete) onComplete(); return; }

        statusEl.innerText = `Placing ink art blocks with ${palette.length} colors...`;
        beginGeneratedLayer('Img to Blocks', 'Image to Blocks');

        // --- Build luminance map ---
        const lumMap = new Float32Array(outW * outH);
        for (let i = 0; i < outW * outH; i++) {
            const pi = i * 4;
            if (pixelData[pi+3] < 64) { lumMap[i] = -1; continue; }
            lumMap[i] = 0.299*pixelData[pi] + 0.587*pixelData[pi+1] + 0.114*pixelData[pi+2];
        }
        let minLum = 255, maxLum = 0;
        for (let i = 0; i < lumMap.length; i++) {
            if (lumMap[i] < 0) continue;
            if (lumMap[i] < minLum) minLum = lumMap[i];
            if (lumMap[i] > maxLum) maxLum = lumMap[i];
        }
        let lumRange = Math.max(maxLum - minLum, 1);
        let opaqueCount = 0, transparentCount = 0;
        for (let i = 0; i < outW * outH; i++) {
            const a = pixelData[i * 4 + 3];
            if (a < 64) transparentCount++;
            else opaqueCount++;
        }
        const preserveLightShape = transparentCount > opaqueCount * 0.12;

        // --- Sobel edge map -critical for preserving ink strokes ---
        const edgeMap = new Float32Array(outW * outH);
        for (let ty = 1; ty < outH-1; ty++) {
            for (let tx = 1; tx < outW-1; tx++) {
                const idx = ty*outW+tx;
                if (lumMap[idx] < 0) continue;
                const tl=lumMap[(ty-1)*outW+(tx-1)], t=lumMap[(ty-1)*outW+tx], tr2=lumMap[(ty-1)*outW+(tx+1)];
                const ml=lumMap[ty*outW+(tx-1)], mr=lumMap[ty*outW+(tx+1)];
                const bl=lumMap[(ty+1)*outW+(tx-1)], b2=lumMap[(ty+1)*outW+tx], br=lumMap[(ty+1)*outW+(tx+1)];
                const gx = -tl - 2*ml - bl + tr2 + 2*mr + br;
                const gy = -tl - 2*t  - tr2 + bl + 2*b2 + br;
                edgeMap[idx] = Math.sqrt(gx*gx + gy*gy);
            }
        }
        let maxEdge = 1;
        for (let i = 0; i < edgeMap.length; i++) if (edgeMap[i] > maxEdge) maxEdge = edgeMap[i];
        for (let i = 0; i < edgeMap.length; i++) edgeMap[i] /= maxEdge;

        // --- Build ink density tiers targeting B&W blocks ---
        // Target luminances for each tier: solid black ->dark grey ->mid grey ->white fill
        const INK_TARGETS = [
            { r: 20,  g: 20,  b: 20  },  // Tier 0: solid ink
            { r: 70,  g: 70,  b: 70  },  // Tier 1: dark tone
            { r: 150, g: 150, b: 150 },  // Tier 2: halftone/grey
            { r: 242, g: 242, b: 242 },  // Tier 3: white fill for transparent-object art
        ];
        const tierCache = [{}, {}, {}, {}];
        function getInkBlock(tier) {
            const t = INK_TARGETS[tier];
            const key = tier;
            if (tierCache[tier][key] !== undefined) return tierCache[tier][key];
            const best = findClosestBlock(t.r, t.g, t.b, palette);
            tierCache[tier][key] = best ? best.block : null;
            return tierCache[tier][key];
        }
        // Pre-compute the tier blocks once
        const tierBlocks = [getInkBlock(0), getInkBlock(1), getInkBlock(2), getInkBlock(3)];

        let placed = 0;
        (async () => {
        for (let ty = 0; ty < outH; ty++) {
            if (ty % 2 === 0) {
                statusEl.innerText = `Placing ink art... row ${ty+1}/${outH} (${placed} placed)`;
                await yieldFrame();
            }
            for (let tx = 0; tx < outW; tx++) {
                const pi = (ty * outW + tx) * 4;
                const a = pixelData[pi+3];
                if (a < 64) continue;

                const idx = ty * outW + tx;
                const lum = lumMap[idx];
                if (lum < 0) continue;

                // inkDensity: 0 = pure white (paper), 1 = pure black (solid ink)
                const inkDensity = 1.0 - (lum - minLum) / lumRange;
                const edgeStr = edgeMap[idx];

                // Edges always get elevated by at least 0.25 so ink strokes are never lost
                const effectiveDensity = Math.min(1.0, inkDensity + edgeStr * 0.25);

                let tier;
                if      (effectiveDensity >= 0.72) tier = 0;  // solid ink ->darkest block
                else if (effectiveDensity >= 0.45) tier = 1;  // dark tone
                else if (effectiveDensity >= 0.22) tier = 2;  // halftone
                else if (preserveLightShape)       tier = 3;  // white object fill
                else continue; // paper-like scan: leave near-white paper empty

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;

                const block = tierBlocks[tier];
                if (block) {
                    fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                    placed++;
                }
            }
            if (ty % 6 === 0) drawCanvas();
        }
        drawCanvas();
        finishGeneratedLayer('Image to Blocks');
        statusEl.innerText = `Done: Ink art done! ${placed} blocks placed${preserveLightShape ? ' with white fill preserved' : ' with paper left empty'}.`;
        if (onComplete) onComplete();
        })().catch(err => {
            console.error(err);
            statusEl.innerText = 'Error: Ink art generation failed.';
            if (onComplete) onComplete();
        });
    });
}

// ---
// MODE 1: PIXEL BLOCKS -shaded pixel art (color) or ink art (B&W auto-detect)
// Uses Pixel Blocks on FG only.
// Auto-detects monochrome/ink art and switches to runInkArtMode.
// For color images: shading via luminance+edge darkFactor, 3 tiers.
// ---
function runPixelBlocksMode(pixelData, outW, outH, startX, startY, statusEl, depthMode = 'blocks-base', outlineMode = false, onComplete = null) {
    // --- Auto-detect B&W / ink art and use the correct mode ---
    if (detectMonochrome(pixelData, outW, outH)) {
        statusEl.innerText = 'art detected -switching to ink art mode...';
        runInkArtMode(pixelData, outW, outH, startX, startY, statusEl, onComplete);
        return;
    }

    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return b.fileName.startsWith('Pixel Block');
    });
    const candidateBackgrounds = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return b.type === 'wall' && b.fileName.startsWith('PixelBackground');
    });

    if (candidateBlocks.length === 0) {
        statusEl.innerText = 'Error: No Pixel Blocks found!';
        if (onComplete) onComplete();
        return;
    }

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling pixel blocks...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: Could not sample pixel block colors.'; if (onComplete) onComplete(); return; }
        batchSampleBlocks(candidateBackgrounds, statusEl, 'Sampling pixel backgrounds...', (bgPalette) => {

        const backgroundBase = depthMode === 'background-base';
        const combinationMode = depthMode === 'combination';
        const modeLabel = backgroundBase
            ? 'background base with sparse block depth'
            : combinationMode
                ? 'combination depth with strong blocks/background mix'
                : 'block base with background depth';
        statusEl.innerText = `Placing ${modeLabel} using ${palette.length} fg colors and ${bgPalette.length} bg colors...`;
        beginGeneratedLayer('Img to Blocks', 'Image to Blocks');

        // --- Global luminance range ---
        const lumMap = new Float32Array(outW * outH);
        for (let i = 0; i < outW * outH; i++) {
            const pi = i * 4;
            if (pixelData[pi+3] < 64) { lumMap[i] = -1; continue; }
            lumMap[i] = 0.299*pixelData[pi] + 0.587*pixelData[pi+1] + 0.114*pixelData[pi+2];
        }
        let minLum = 255, maxLum = 0;
        for (let i = 0; i < lumMap.length; i++) {
            if (lumMap[i] < 0) continue;
            if (lumMap[i] < minLum) minLum = lumMap[i];
            if (lumMap[i] > maxLum) maxLum = lumMap[i];
        }
        if (minLum > maxLum) { minLum = 0; maxLum = 255; }
        const lumRange = Math.max(maxLum - minLum, 1);

        function analyzeImageColorIntent() {
            let count = 0, strongColor = 0, greyish = 0;
            const families = { red: 0, orange: 0, yellow: 0, green: 0, cyan: 0, blue: 0, mauve: 0 };
            for (let i = 0; i < outW * outH; i++) {
                const pi = i * 4;
                if (pixelData[pi+3] < 64) continue;
                const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2];
                const max = Math.max(r, g, b), min = Math.min(r, g, b);
                const sat = max > 0 ? (max - min) / max : 0;
                const lum = 0.299*r + 0.587*g + 0.114*b;
                count++;
                if (sat > 0.20 && lum > 22) {
                    strongColor++;
                    const fam = colorFamily(r, g, b);
                    if (families[fam] !== undefined) families[fam]++;
                }
                if (sat < 0.12 && lum > 24 && lum < 220) greyish++;
            }
            let dominantFamily = 'blue', best = -1;
            Object.entries(families).forEach(([family, total]) => {
                if (total > best) { best = total; dominantFamily = family; }
            });
            const strongRatio = count ? strongColor / count : 0;
            const greyRatio = count ? greyish / count : 0;
            return {
                colorful: strongRatio > 0.04 && strongRatio > greyRatio * 0.20,
                dominantFamily,
                greyRatio,
                strongRatio
            };
        }

        // --- Sobel edge map ---
        const edgeMap = new Float32Array(outW * outH);
        for (let ty = 1; ty < outH-1; ty++) {
            for (let tx = 1; tx < outW-1; tx++) {
                const idx = ty*outW+tx;
                if (lumMap[idx] < 0) continue;
                const tl=lumMap[(ty-1)*outW+(tx-1)], t=lumMap[(ty-1)*outW+tx], tr2=lumMap[(ty-1)*outW+(tx+1)];
                const ml=lumMap[ty*outW+(tx-1)], mr=lumMap[ty*outW+(tx+1)];
                const bl=lumMap[(ty+1)*outW+(tx-1)], b2=lumMap[(ty+1)*outW+tx], br=lumMap[(ty+1)*outW+(tx+1)];
                const gx = -tl - 2*ml - bl + tr2 + 2*mr + br;
                const gy = -tl - 2*t  - tr2 + bl + 2*b2 + br;
                edgeMap[idx] = Math.sqrt(gx*gx + gy*gy);
            }
        }
        let maxEdge = 1;
        for (let i = 0; i < edgeMap.length; i++) if (edgeMap[i] > maxEdge) maxEdge = edgeMap[i];
        for (let i = 0; i < edgeMap.length; i++) edgeMap[i] /= maxEdge;

        // --- Shade tiers: search for closest block to darkened color ---
        // Tier 0 (highlight): color x 1.0
        // Tier 1 (midtone):   color x 0.72
        // Tier 2 (shadow):    color x 0.48
        // Tier 3 (deep):      color x 0.30
        const SHADE_MULT = [1.0, 0.82, 0.64, 0.48];
        const BG_SHADE_MULT = SHADE_MULT;
        const shadeCache = {};
        const bgShadeCache = {};
        function getShadedBlock(r, g, b, tier) {
            const key = `${r>>2},${g>>2},${b>>2},${tier}`;
            if (shadeCache[key] !== undefined) return shadeCache[key];
            const m = SHADE_MULT[tier];
            const best = findClosestBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), palette);
            shadeCache[key] = best ? best.block : null;
            return shadeCache[key];
        }
        function colorFamily(r, g, b) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const mauveBias = r >= g + 6 && b >= g + 4 && Math.abs(r - b) <= 38;
            if (mauveBias && max - min >= 4) return 'mauve';
            if (max - min < 12) return 'neutral';
            if (b >= g + 8 && b >= r + 12) return 'blue';
            const rr = r / 255, gg = g / 255, bb = b / 255;
            const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
            const d = mx - mn;
            const sat = mx > 0 ? d / mx : 0;
            if (sat < 0.18) return 'neutral';
            let h = 0;
            if (d > 0) {
                if (mx === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
                else if (mx === gg) h = ((bb - rr) / d + 2) / 6;
                else h = ((rr - gg) / d + 4) / 6;
            }
            if (h < 0.045 || h >= 0.93) return 'red';
            if (h < 0.095) return 'orange';
            if (h < 0.18) return 'yellow';
            if (h < 0.42) return 'green';
            if (h < 0.58) return 'cyan';
            if (h < 0.72) return 'blue';
            return 'neutral';
        }
        const imageColorIntent = analyzeImageColorIntent();
        function mutedColorFamily(r, g, b) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max - min <= 3) return imageColorIntent.dominantFamily || 'blue';
            if (b >= r && b >= g) return (r >= g + 4) ? 'mauve' : 'blue';
            if (r >= g && r >= b) {
                if (b >= g + 4) return 'mauve';
                if (g >= b + 8) return 'orange';
                return 'red';
            }
            if (g >= r && g >= b) return b >= r + 4 ? 'cyan' : 'green';
            return imageColorIntent.dominantFamily || 'blue';
        }
        function useTrueGreyForPixel(r, g, b) {
            return isTrueGreyPixel(r, g, b);
        }
        function familyMatches(entry, family) {
            if (family === 'neutral') return neutralPaletteMatches(entry);
            const assetName = ((entry.block && (entry.block.fileName || entry.block.name)) || '').toLowerCase();
            const entryFamily = colorFamily(entry.r, entry.g, entry.b);
            if (isGreyLeanAssetName(entry.block)) return false;
            if (family === 'yellow') return entryFamily === 'yellow' || entryFamily === 'orange';
            if (family === 'green') return entryFamily === 'green' || entryFamily === 'cyan';
            if (family === 'cyan') {
                const brightMint = entryFamily === 'green' && entry.g >= entry.b && entry.r >= 90 && entry.g >= 165 && entry.b >= 135;
                return entryFamily === 'cyan' || entryFamily === 'blue' || brightMint;
            }
            if (family === 'mauve') {
                return assetName.includes('amethyst')
                    || assetName.includes('seance')
                    || assetName.includes('deluge')
                    || assetName.includes('brilliantrose')
                    || assetName.includes('brilliant rose')
                    || assetName.includes('classicrose')
                    || assetName.includes('classic rose')
                    || assetName.includes('moonraker')
                    || assetName.includes('moon raker')
                    || entryFamily === 'mauve';
            }
            return entryFamily === family;
        }
        function findClosestFamilyBlock(r, g, b, candidates, family) {
            let best = null, bestDist = Infinity;
            for (const entry of candidates) {
                if (!familyMatches(entry, family)) continue;
                const dr = r - entry.r, dg = g - entry.g, db = b - entry.b;
                const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                if (dist < bestDist) { bestDist = dist; best = entry; }
            }
            if (best) return best;
            const safeCandidates = candidates.filter(entry => !isGreyLeanAssetName(entry.block) && !neutralPaletteMatches(entry));
            return findClosestBlock(r, g, b, safeCandidates.length ? safeCandidates : candidates);
        }
        function isTrueGreyPixel(r, g, b) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const mouthMauve = r >= g + 6 && b >= g + 4 && Math.abs(r - b) <= 38;
            if (mouthMauve && max - min >= 4) return false;
            const sat = max > 0 ? (max - min) / max : 0;
            const warmSkin = r >= g + 12 && g >= b + 6 && (r - b) >= 28;
            // Preserve tinted greys without swallowing clearly warm skin colours.
            return !warmSkin && (max - min <= 22 || (sat <= 0.18 && max - min <= 42));
        }
        function neutralPaletteMatches(entry) {
            const max = Math.max(entry.r, entry.g, entry.b), min = Math.min(entry.r, entry.g, entry.b);
            const sat = max > 0 ? (max - min) / max : 0;
            return (max - min) <= 24 || sat <= 0.12;
        }
        function findClosestNeutralBlock(r, g, b, candidates) {
            let best = null, bestDist = Infinity;
            for (const entry of candidates) {
                if (!neutralPaletteMatches(entry)) continue;
                const dr = r - entry.r, dg = g - entry.g, db = b - entry.b;
                const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                if (dist < bestDist) { bestDist = dist; best = entry; }
            }
            return best || findClosestBlock(r, g, b, candidates);
        }
        function getFamilyShadedBlock(r, g, b, tier, family) {
            if (family === 'neutral') return getShadedBlock(r, g, b, tier);
            const key = `${r>>2},${g>>2},${b>>2},${tier},${family}`;
            if (shadeCache[key] !== undefined) return shadeCache[key];
            const familyShadeMult = family === 'yellow' ? [1.0, 0.74, 0.52, 0.38] : SHADE_MULT;
            const m = familyShadeMult[tier];
            const best = findClosestFamilyBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), palette, family);
            shadeCache[key] = best ? best.block : null;
            return shadeCache[key];
        }
        function getTrueGreyShadedBlock(r, g, b, tier) {
            const key = `grey:${r>>2},${g>>2},${b>>2},${tier}`;
            if (shadeCache[key] !== undefined) return shadeCache[key];
            const m = SHADE_MULT[tier];
            const best = findClosestNeutralBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), palette);
            shadeCache[key] = best ? best.block : null;
            return shadeCache[key];
        }
        function getShadedBackground(r, g, b, tier) {
            if (!bgPalette.length) return null;
            const key = `${r>>2},${g>>2},${b>>2},${tier}`;
            if (bgShadeCache[key] !== undefined) return bgShadeCache[key];
            const m = BG_SHADE_MULT[tier];
            const best = findClosestBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), bgPalette);
            bgShadeCache[key] = best ? best.block : null;
            return bgShadeCache[key];
        }
        function getTrueGreyShadedBackground(r, g, b, tier) {
            if (!bgPalette.length) return null;
            const key = `grey:${r>>2},${g>>2},${b>>2},${tier}`;
            if (bgShadeCache[key] !== undefined) return bgShadeCache[key];
            const m = BG_SHADE_MULT[tier];
            const best = findClosestNeutralBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), bgPalette);
            bgShadeCache[key] = best ? best.block : null;
            return bgShadeCache[key];
        }
        function getFamilyShadedBackground(r, g, b, tier, family) {
            if (!bgPalette.length) return null;
            if (family === 'neutral') return getShadedBackground(r, g, b, tier);
            const key = `${r>>2},${g>>2},${b>>2},${tier},${family}`;
            if (bgShadeCache[key] !== undefined) return bgShadeCache[key];
            const familyShadeMult = family === 'yellow' ? [1.0, 0.74, 0.52, 0.38] : BG_SHADE_MULT;
            const m = familyShadeMult[tier];
            const best = findClosestFamilyBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), bgPalette, family);
            bgShadeCache[key] = best ? best.block : null;
            return bgShadeCache[key];
        }
        const bgByPixelName = {};
        function pixelAssetKey(name) {
            return (name || '')
                .replace(/\.png$/i, '')
                .replace(/^Pixel\s*Block\s*-?\s*/i, '')
                .replace(/^PixelBackground/i, '')
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase();
        }
        for (const entry of bgPalette) {
            const key = pixelAssetKey(entry.block.fileName || entry.block.name);
            if (key) bgByPixelName[key] = entry.block;
        }
        function matchingPixelBackground(block, fallback) {
            if (!block) return fallback || null;
            const key = pixelAssetKey(block.fileName || block.name);
            return bgByPixelName[key] || fallback || null;
        }
        function pickOutlineBlock() {
            const preferred = ['black rock', 'black', 'valhalla', 'toledo', 'eden'];
            for (const namePart of preferred) {
                const found = palette.find(entry => {
                    const name = ((entry.block.fileName || entry.block.name) || '').toLowerCase();
                    return name.includes(namePart);
                });
                if (found) return found.block;
            }
            const best = findClosestBlock(18, 22, 24, palette);
            return best ? best.block : null;
        }
        function internalOutlineScore(tx, ty, r, g, b, lum, family) {
            let strongest = 0;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (Math.abs(ox) + Math.abs(oy) !== 1) continue;
                    const nx = tx + ox, ny = ty + oy;
                    if (nx < 0 || nx >= outW || ny < 0 || ny >= outH) continue;
                    const npi = (ny * outW + nx) * 4;
                    if (pixelData[npi+3] < 64) continue;
                    const nr = pixelData[npi], ng = pixelData[npi+1], nb = pixelData[npi+2];
                    const nLum = lumMap[ny * outW + nx];
                    if (nLum < 0) continue;
                    const nFamily = colorFamily(nr, ng, nb);
                    const dr = r - nr, dg = g - ng, db = b - nb;
                    const colorDiff = Math.sqrt(dr*dr*0.299 + dg*dg*0.587 + db*db*0.114);
                    const lumDiff = Math.abs(lum - nLum);
                    const darkerSide = lum <= nLum + 7;
                    const familyBreak = family !== nFamily && colorDiff > 18;
                    const formBreak = colorDiff > 30 || lumDiff > 24;
                    if ((familyBreak || formBreak) && darkerSide) {
                        strongest = Math.max(strongest, Math.min(1, (colorDiff * 0.018) + (lumDiff * 0.012)));
                    }
                }
            }
            return strongest;
        }

        let placed = 0, bgPlaced = 0;
        (async () => {
        for (let ty = 0; ty < outH; ty++) {
            if (ty % 2 === 0) {
                statusEl.innerText = `Placing ${modeLabel}... row ${ty+1}/${outH} (${placed} fg, ${bgPlaced} bg)`;
                await yieldFrame();
            }
            for (let tx = 0; tx < outW; tx++) {
                const pi = (ty * outW + tx) * 4;
                const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2], a = pixelData[pi+3];
                if (a < 64) continue;

                const idx = ty * outW + tx;
                const lum = lumMap[idx];
                if (lum < 0) continue;

                // darkFactor: 0 = brightest pixel in image, 1 = darkest
                const normLum = 1.0 - (lum - minLum) / lumRange;
                const edgeStr = edgeMap[idx];
                const darkFactor = normLum * 0.70 + edgeStr * 0.30;

                let shadeTier;
                if      (darkFactor < 0.25) shadeTier = 0;
                else if (darkFactor < 0.50) shadeTier = 1;
                else if (darkFactor < 0.75) shadeTier = 2;
                else                        shadeTier = 3;

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                if (isProtectedTile(wx, wy)) continue;

                const colorSpan = Math.max(r, g, b) - Math.min(r, g, b);
                const rawFamily = colorFamily(r, g, b);
                const trueGrey = useTrueGreyForPixel(r, g, b);
                const family = rawFamily;
                if (family === 'yellow' && shadeTier >= 2) {
                    let lighterNeighbors = 0, yellowNeighbors = 0;
                    for (let oy = -1; oy <= 1; oy++) {
                        for (let ox = -1; ox <= 1; ox++) {
                            if (ox === 0 && oy === 0) continue;
                            const nx = tx + ox, ny = ty + oy;
                            if (nx < 0 || nx >= outW || ny < 0 || ny >= outH) continue;
                            const npi = (ny * outW + nx) * 4;
                            if (pixelData[npi+3] < 64) continue;
                            const nr = pixelData[npi], ng = pixelData[npi+1], nb = pixelData[npi+2];
                            if (colorFamily(nr, ng, nb) !== 'yellow') continue;
                            yellowNeighbors++;
                            const nLum = lumMap[ny * outW + nx];
                            if (nLum > lum + 18) lighterNeighbors++;
                        }
                    }
                    if (yellowNeighbors >= 4 && lighterNeighbors >= 5) shadeTier--;
                }
                const hueSafe = family !== 'neutral' || colorSpan > 22;
                const baseTier = hueSafe ? Math.min(shadeTier, 2) : shadeTier;
                const insideEdge = internalOutlineScore(tx, ty, r, g, b, lum, family) > 0.50;
                const edgeOutline = (family === 'green' || family === 'cyan')
                    && (edgeStr > 0.42 || insideEdge)
                    && darkFactor > 0.24;
                const depthTier = edgeOutline ? 3 : Math.min(3, baseTier + 1);
                const block = trueGrey ? getTrueGreyShadedBlock(r, g, b, baseTier) : getFamilyShadedBlock(r, g, b, baseTier, family);
                const depthBlock = (shadeTier >= 2 || edgeOutline)
                    ? (trueGrey ? getTrueGreyShadedBlock(r, g, b, depthTier) : getFamilyShadedBlock(r, g, b, depthTier, family))
                    : null;
                const baseBgBlock = trueGrey
                    ? matchingPixelBackground(block, getTrueGreyShadedBackground(r, g, b, baseTier))
                    : matchingPixelBackground(block, getFamilyShadedBackground(r, g, b, baseTier, family));
                const depthBgBlock = (shadeTier >= 2 || edgeOutline)
                    ? (trueGrey
                        ? matchingPixelBackground(depthBlock, getTrueGreyShadedBackground(r, g, b, depthTier))
                        : matchingPixelBackground(depthBlock, getFamilyShadedBackground(r, g, b, depthTier, family)))
                    : null;
                if (backgroundBase) {
                    if (baseBgBlock) {
                        bgData[wx][wy] = JSON.parse(JSON.stringify(baseBgBlock));
                        bgPlaced++;
                    } else if (block) {
                        fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                        placed++;
                    }
                    if (depthBlock && (shadeTier >= 3 || edgeOutline)) {
                        fgData[wx][wy] = JSON.parse(JSON.stringify(depthBlock));
                        placed++;
                    }
                } else {
                    const useBackgroundDepth = !!depthBgBlock
                        && (combinationMode
                            ? (shadeTier >= 2 || edgeOutline)
                            : (shadeTier >= 3 || edgeOutline || (shadeTier >= 2 && darkFactor > 0.62 && edgeStr > 0.08)));
                    if (useBackgroundDepth) {
                        bgData[wx][wy] = JSON.parse(JSON.stringify(depthBgBlock));
                        bgPlaced++;
                    } else if (block) {
                        fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                        placed++;
                    }
                }
            }
            if (ty % 6 === 0) drawCanvas();
        }
        if (outlineMode) {
            const outlineBlock = pickOutlineBlock();
            if (outlineBlock) {
                let outlinePlaced = 0;
                for (let ty = 0; ty < outH; ty++) {
                    if (ty % 3 === 0) {
                        statusEl.innerText = `Outline mode... row ${ty+1}/${outH} (${outlinePlaced} outline)`;
                        await yieldFrame();
                    }
                    for (let tx = 0; tx < outW; tx++) {
                        const idx = ty * outW + tx;
                        const pi = idx * 4;
                        if (pixelData[pi+3] < 64) continue;
                        let touchesTransparent = false;
                        for (let oy = -1; oy <= 1 && !touchesTransparent; oy++) {
                            for (let ox = -1; ox <= 1; ox++) {
                                if (Math.abs(ox) + Math.abs(oy) !== 1) continue;
                                const nx = tx + ox, ny = ty + oy;
                                if (nx < 0 || nx >= outW || ny < 0 || ny >= outH) { touchesTransparent = true; break; }
                                const npi = (ny * outW + nx) * 4;
                                if (pixelData[npi+3] < 64) { touchesTransparent = true; break; }
                            }
                        }
                        const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2];
                        const lum = lumMap[idx];
                        const family = colorFamily(r, g, b);
                        const strongInternalEdge = (edgeMap[idx] > 0.58 && lum < 185)
                            || internalOutlineScore(tx, ty, r, g, b, lum, family) > 0.46;
                        if (!touchesTransparent && !strongInternalEdge) continue;
                        const wx = startX + tx, wy = startY + ty;
                        if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;
                        if (isProtectedTile(wx, wy)) continue;
                        fgData[wx][wy] = JSON.parse(JSON.stringify(outlineBlock));
                        outlinePlaced++;
                    }
                    if (ty % 8 === 0) drawCanvas();
                }
                placed += outlinePlaced;
                drawCanvas();
                finishGeneratedLayer('Image to Blocks');
                statusEl.innerText = `Done: Pixel art done! ${placed} fg blocks and ${bgPlaced} pixel backgrounds placed (${modeLabel}, outline ${outlinePlaced}).`;
                if (onComplete) onComplete();
            } else {
                drawCanvas();
                finishGeneratedLayer('Image to Blocks');
                statusEl.innerText = `Done: Pixel art done! ${placed} fg blocks and ${bgPlaced} pixel backgrounds placed (${modeLabel}).`;
                if (onComplete) onComplete();
            }
        } else {
            drawCanvas();
            finishGeneratedLayer('Image to Blocks');
            statusEl.innerText = `Done: Pixel art done! ${placed} fg blocks and ${bgPlaced} pixel backgrounds placed (${modeLabel}).`;
            if (onComplete) onComplete();
        }
        })().catch(err => {
            console.error(err);
            statusEl.innerText = 'Error: Pixel art generation failed.';
            if (onComplete) onComplete();
        });
        });
    });
}

// ---
// MODE 2-: HD ALL BLOCKS -pure color match, FG only
// No shading. Uses all/fg/wall block types for richer palette.
// ---
function runHDDepthMode(pixelData, outW, outH, startX, startY, blockSetFilter, statusEl, onComplete = null) {
    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return blockSetFilter(b);
    });

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling blocks...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: No blocks sampled.'; if (onComplete) onComplete(); return; }

        statusEl.innerText = `Placing blocks with ${palette.length} colors...`;
        beginGeneratedLayer('Img to Blocks HD', 'Image to Blocks');

        const colorCache = {};
        function hdColorFamily(r, g, b) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (r >= g + 6 && b >= g + 4 && Math.abs(r - b) <= 42 && max - min >= 4) return 'mauve';
            if (max - min < 10) return 'neutral';
            if (b >= g + 8 && b >= r + 12) return 'blue';
            const rr = r / 255, gg = g / 255, bb = b / 255;
            const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
            const d = mx - mn;
            const sat = mx > 0 ? d / mx : 0;
            if (sat < 0.14) return 'neutral';
            let h = 0;
            if (d > 0) {
                if (mx === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
                else if (mx === gg) h = ((bb - rr) / d + 2) / 6;
                else h = ((rr - gg) / d + 4) / 6;
            }
            if (h < 0.045 || h >= 0.93) return 'red';
            if (h < 0.095) return 'orange';
            if (h < 0.18) return 'yellow';
            if (h < 0.42) return 'green';
            if (h < 0.58) return 'cyan';
            if (h < 0.76) return 'blue';
            return 'mauve';
        }
        function hdMutedFamily(r, g, b, fallback = 'blue') {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max - min <= 3) return fallback;
            if (b >= r && b >= g) return (r >= g + 4) ? 'mauve' : 'blue';
            if (r >= g && r >= b) return b >= g + 4 ? 'mauve' : (g >= b + 8 ? 'orange' : 'red');
            if (g >= r && g >= b) return b >= r + 4 ? 'cyan' : 'green';
            return fallback;
        }
        function hdIsNeutralEntry(entry) {
            const max = Math.max(entry.r, entry.g, entry.b), min = Math.min(entry.r, entry.g, entry.b);
            const sat = max > 0 ? (max - min) / max : 0;
            return (max - min) <= 26 || sat <= 0.13;
        }
        function hdIsGreyLeanEntry(entry) {
            if (isGreyLeanAssetName(entry.block)) return true;
            const max = Math.max(entry.r, entry.g, entry.b), min = Math.min(entry.r, entry.g, entry.b);
            const sat = max > 0 ? (max - min) / max : 0;
            const lum = 0.299*entry.r + 0.587*entry.g + 0.114*entry.b;
            return lum > 38 && lum < 214 && ((max - min) <= 34 || sat <= 0.18);
        }
        function hdAnalyzeImage() {
            let count = 0, strong = 0, greyish = 0;
            const families = { red:0, orange:0, yellow:0, green:0, cyan:0, blue:0, mauve:0 };
            for (let i = 0; i < outW * outH; i++) {
                const pi = i * 4;
                if (pixelData[pi+3] < 64) continue;
                const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2];
                const max = Math.max(r, g, b), min = Math.min(r, g, b);
                const sat = max > 0 ? (max - min) / max : 0;
                const lum = 0.299*r + 0.587*g + 0.114*b;
                count++;
                if (sat > 0.16 && lum > 20) {
                    strong++;
                    const fam = hdColorFamily(r, g, b);
                    if (families[fam] !== undefined) families[fam]++;
                }
                if (sat < 0.12 && lum > 24 && lum < 220) greyish++;
            }
            let dominantFamily = 'blue', best = -1;
            Object.entries(families).forEach(([family, total]) => {
                if (total > best) { best = total; dominantFamily = family; }
            });
            const strongRatio = count ? strong / count : 0;
            const greyRatio = count ? greyish / count : 0;
            return { colorful: strongRatio > 0.04 && strongRatio > greyRatio * 0.20, dominantFamily };
        }
        const hdIntent = hdAnalyzeImage();
        function hdFamilyMatches(entry, family) {
            const entryFamily = hdColorFamily(entry.r, entry.g, entry.b);
            if (family === 'yellow') return entryFamily === 'yellow' || entryFamily === 'orange';
            if (family === 'cyan') return entryFamily === 'cyan' || entryFamily === 'blue';
            if (family === 'mauve') return entryFamily === 'mauve' || entryFamily === 'blue';
            if (family === 'green') return entryFamily === 'green' || entryFamily === 'cyan';
            return entryFamily === family;
        }
        function findClosestColorSafeBlock(r, g, b) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const lum = 0.299*r + 0.587*g + 0.114*b;
            const span = max - min;
            const sat = max > 0 ? span / max : 0;
            const sourceGrey = (span <= 18 || (sat <= 0.10 && span <= 30))
                && lum > 18
                && !(g >= r + 8 && g >= b + 4)
                && !(b >= r + 10 || (b >= g + 10 && r >= g - 4))
                && !(r >= g + 10 && b >= g + 8);
            if (sourceGrey) return findClosestBlock(r, g, b, palette);
            const rawFamily = hdColorFamily(r, g, b);
            const family = rawFamily === 'neutral' ? hdMutedFamily(r, g, b, hdIntent.dominantFamily) : rawFamily;
            let best = null, bestDist = Infinity;
            for (const entry of palette) {
                if (hdIsGreyLeanEntry(entry)) continue;
                if (!hdFamilyMatches(entry, family)) continue;
                const dr = r - entry.r, dg = g - entry.g, db = b - entry.b;
                const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                if (dist < bestDist) { bestDist = dist; best = entry; }
            }
            if (best) return best;
            const nonNeutral = palette.filter(entry => !hdIsGreyLeanEntry(entry));
            return findClosestBlock(r, g, b, nonNeutral.length ? nonNeutral : palette);
        }
        let placed = 0;

        (async () => {
        for (let ty = 0; ty < outH; ty++) {
            if (ty % 2 === 0) {
                statusEl.innerText = `Placing HD blocks... row ${ty+1}/${outH} (${placed} placed)`;
                await yieldFrame();
            }
            for (let tx = 0; tx < outW; tx++) {
                const pi = (ty * outW + tx) * 4;
                const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2], a = pixelData[pi+3];
                if (a < 64) continue;

                const key = `${r>>2},${g>>2},${b>>2}`;
                if (!colorCache[key]) {
                    const best = findClosestColorSafeBlock(r, g, b);
                    colorCache[key] = best ? best.block : null;
                }

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y || !colorCache[key]) continue;

                const block = colorCache[key];
                if (usesBackgroundLayer(block)) bgData[wx][wy] = JSON.parse(JSON.stringify(block));
                else if (isWaterBlock(block)) waterData[wx][wy] = JSON.parse(JSON.stringify(block));
                else fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                placed++;
            }
            if (ty % 6 === 0) drawCanvas();
        }
        drawCanvas();
        finishGeneratedLayer('Image to Blocks');
        statusEl.innerText = `Done: Done! Placed ${placed} blocks using ${palette.length} colors.`;
        if (onComplete) onComplete();
        })().catch(err => {
            console.error(err);
            statusEl.innerText = 'Error: HD image generation failed.';
            if (onComplete) onComplete();
        });
    });
}

function runWorldAssetMode(pixelData, outW, outH, startX, startY, statusEl, onComplete = null) {
    const cleanAsset = (b) => {
        if (!b || b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        if (b.fileName.startsWith('Pixel Block') || b.fileName.startsWith('PixelBackground')) return false;
        return true;
    };
    const solidBlocks = blockLibrary.filter(b => cleanAsset(b) && (b.folder === 'block' || b.type === 'block') && !isWaterBlock(b));
    const wallBlocks = blockLibrary.filter(b => cleanAsset(b) && (b.folder === 'background' || b.type === 'wall'));
    const propBlocks = blockLibrary.filter(b => cleanAsset(b) && b.type === 'prop');

    Promise.all([
        new Promise(resolve => batchSampleBlocks(solidBlocks, statusEl, 'Sampling world blocks...', resolve)),
        new Promise(resolve => batchSampleBlocks(wallBlocks, statusEl, 'Sampling world backgrounds...', resolve)),
        new Promise(resolve => batchSampleBlocks(propBlocks, statusEl, 'Sampling world props...', resolve))
    ]).then(([solidPalette, wallPalette, propPalette]) => {
        if (!solidPalette.length && !wallPalette.length && !propPalette.length) {
            statusEl.innerText = 'Error: No world asset blocks sampled.';
            if (onComplete) onComplete();
            return;
        }

        const depthMode = document.getElementById('i2b-world-depth')?.value || 'balanced';
        const detailDensity = parseInt(document.getElementById('i2b-world-detail')?.value || '2', 10);
        const fgThreshold = depthMode === 'heavy' ? 0.30 : depthMode === 'light' ? 0.52 : 0.40;
        const propThreshold = detailDensity === 3 ? 0.38 : detailDensity === 1 ? 0.62 : 0.50;
        const shadowOffset = depthMode === 'heavy' ? 2 : 1;

        statusEl.innerText = `Building world asset using ${solidPalette.length} blocks, ${wallPalette.length} backgrounds, ${propPalette.length} props...`;
        beginGeneratedLayer('World Asset', 'World Asset');

        const lumMap = new Float32Array(outW * outH);
        let minLum = 255, maxLum = 0;
        for (let i = 0; i < outW * outH; i++) {
            const pi = i * 4;
            if (pixelData[pi+3] < 64) { lumMap[i] = -1; continue; }
            const lum = 0.299*pixelData[pi] + 0.587*pixelData[pi+1] + 0.114*pixelData[pi+2];
            lumMap[i] = lum;
            minLum = Math.min(minLum, lum);
            maxLum = Math.max(maxLum, lum);
        }
        if (minLum > maxLum) { minLum = 0; maxLum = 255; }
        const lumRange = Math.max(1, maxLum - minLum);

        const edgeMap = new Float32Array(outW * outH);
        let maxEdge = 1;
        for (let ty = 1; ty < outH - 1; ty++) {
            for (let tx = 1; tx < outW - 1; tx++) {
                const idx = ty * outW + tx;
                if (lumMap[idx] < 0) continue;
                const l = lumMap[ty*outW + tx - 1], r = lumMap[ty*outW + tx + 1];
                const u = lumMap[(ty - 1)*outW + tx], d = lumMap[(ty + 1)*outW + tx];
                if (l < 0 || r < 0 || u < 0 || d < 0) { edgeMap[idx] = 1; continue; }
                const edge = Math.abs(l - r) + Math.abs(u - d);
                edgeMap[idx] = edge;
                maxEdge = Math.max(maxEdge, edge);
            }
        }
        for (let i = 0; i < edgeMap.length; i++) edgeMap[i] = Math.min(1, edgeMap[i] / maxEdge);

        const matchCache = {};
        function paletteMatch(palette, r, g, b, keyPrefix) {
            if (!palette.length) return null;
            const key = `${keyPrefix}:${r>>2},${g>>2},${b>>2}`;
            if (matchCache[key] !== undefined) return matchCache[key];
            const match = findClosestBlock(r, g, b, palette);
            matchCache[key] = match ? match.block : null;
            return matchCache[key];
        }
        function put(layer, wx, wy, block) {
            if (!block || wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y || isProtectedTile(wx, wy)) return 0;
            layer[wx][wy] = JSON.parse(JSON.stringify(block));
            return 1;
        }

        let fgPlaced = 0, bgPlaced = 0, propPlaced = 0;
        (async () => {
            for (let ty = 0; ty < outH; ty++) {
                if (ty % 2 === 0) {
                    statusEl.innerText = `Building world asset... row ${ty+1}/${outH} (${fgPlaced} blocks, ${bgPlaced} bg, ${propPlaced} props)`;
                    await yieldFrame();
                }
                for (let tx = 0; tx < outW; tx++) {
                    const pi = (ty * outW + tx) * 4;
                    const a = pixelData[pi+3];
                    if (a < 64) continue;
                    const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2];
                    const wx = startX + tx, wy = startY + ty;
                    if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y || isProtectedTile(wx, wy)) continue;

                    const lum = lumMap[ty * outW + tx];
                    const shade = 1 - ((lum - minLum) / lumRange);
                    const edge = edgeMap[ty * outW + tx];
                    const structural = shade > fgThreshold || edge > 0.46 || a < 220;
                    const detail = edge > propThreshold && propPalette.length && ((tx + ty) % (detailDensity === 3 ? 2 : 3) === 0);

                    const bgBlock = paletteMatch(wallPalette, Math.round(r * 0.72), Math.round(g * 0.72), Math.round(b * 0.78), 'bg');
                    bgPlaced += put(bgData, wx, wy, bgBlock);

                    if (structural && wallPalette.length && solidPalette.length) {
                        const shadowBg = paletteMatch(wallPalette, Math.round(r * 0.45), Math.round(g * 0.45), Math.round(b * 0.50), 'shadow');
                        bgPlaced += put(bgData, wx + shadowOffset, wy + shadowOffset, shadowBg);
                    }

                    if (structural && solidPalette.length) {
                        const block = paletteMatch(solidPalette, Math.round(r * (shade > 0.65 ? 0.62 : 0.88)), Math.round(g * (shade > 0.65 ? 0.62 : 0.88)), Math.round(b * (shade > 0.65 ? 0.62 : 0.88)), 'fg');
                        fgPlaced += put(fgData, wx, wy, block);
                    }

                    if (detail) {
                        const prop = paletteMatch(propPalette, r, g, b, 'prop');
                        propPlaced += put(fgData, wx, wy, prop);
                    }
                }
                if (ty % 6 === 0) drawCanvas();
            }
            drawCanvas();
            finishGeneratedLayer('World Asset');
            statusEl.innerText = `Done: World asset built! ${fgPlaced} blocks, ${bgPlaced} backgrounds, ${propPlaced} props.`;
            if (onComplete) onComplete();
        })().catch(err => {
            console.error(err);
            statusEl.innerText = 'Error: World asset generation failed.';
            if (onComplete) onComplete();
        });
    }).catch(err => {
        console.error(err);
        statusEl.innerText = 'Error: Could not sample world asset palettes.';
        if (onComplete) onComplete();
    });
}

// ---
// MAIN CONVERT BUTTON
// ---
document.getElementById('img2blocks-convert-btn').onclick = () => {
    if (!i2bImgData) { alert('Please upload an image first.'); return; }
    const releaseGeneration = beginGenerationLock('img2blocks', 'img2blocks-convert-btn', 'Generating...');
    if (!releaseGeneration) return;

    const startX = parseInt(document.getElementById('i2b-x').value);
    const startY = parseInt(document.getElementById('i2b-y').value);
    const tileW = parseInt(document.getElementById('i2b-w').value);
    const tileH = parseInt(document.getElementById('i2b-h').value);
    const pixelDepthMode = document.getElementById('i2b-pixel-depth-mode')?.value || 'blocks-base';
    const outlineMode = document.getElementById('i2b-outline-mode')?.checked || false;
    const doFlip = document.getElementById('i2b-flip').checked;

    const outW = tileW;
    const outH = tileH;

    const statusEl = document.getElementById('i2b-status');
    statusEl.innerText = 'Loading image...';

    const tempImg = new Image();
    tempImg.onload = () => {
        let pixelData;
        try {
            pixelData = sampleImageToCanvas(tempImg, outW, outH, doFlip);
        } catch (err) {
            console.error(err);
            statusEl.innerText = 'Error: Could not read image pixels.';
            releaseGeneration();
            return;
        }

        if (img2BlocksSection === 'pixel') {
            // --- MODE 1: Clean pixel art (pixel blocks only, FG layer) ---
            statusEl.innerText = 'Pixel art mode: sampling pixel blocks...';
            runPixelBlocksMode(pixelData, outW, outH, startX, startY, statusEl, pixelDepthMode, outlineMode, releaseGeneration);
        } else {
            statusEl.innerText = 'World asset mode: sampling world blocks...';
            runWorldAssetMode(pixelData, outW, outH, startX, startY, statusEl, releaseGeneration);
        }
    };
    tempImg.onerror = () => {
        statusEl.innerText = 'Error: Failed to load image.';
        releaseGeneration();
    };
    tempImg.src = i2bImgData;
};

// ============================================================
// FEATURE: Image to World (i2w)
// ============================================================

bindings['i2w-btn'] = 'i2w-popup';
const i2wBtn = document.getElementById('i2w-btn');
if (i2wBtn) i2wBtn.onclick = () => openMenu('i2w-popup');

// --- Tab switching ---
let i2wActiveTab = 'replicate';
function i2wSetTab(tab) {
    i2wActiveTab = tab;
    const rep = document.getElementById('i2w-panel-replicate');
    const gen = document.getElementById('i2w-panel-generate');
    const tabRep = document.getElementById('i2w-tab-replicate');
    const tabGen = document.getElementById('i2w-tab-generate');
    if (tab === 'replicate') {
        rep.classList.remove('hidden'); gen.classList.add('hidden');
        tabRep.style.cssText += ';background:linear-gradient(135deg,#0a2a1a,#0d3b22);border:2px solid #22c55e;color:#4ade80;';
        tabGen.style.cssText += ';background:#1a1a1a;border:1px solid #444;color:#aaa;';
    } else {
        gen.classList.remove('hidden'); rep.classList.add('hidden');
        tabGen.style.cssText += ';background:linear-gradient(135deg,#1c1200,#2a1c00);border:2px solid #f59e0b;color:#fbbf24;';
        tabRep.style.cssText += ';background:#1a1a1a;border:1px solid #444;color:#aaa;';
    }
}
document.getElementById('i2w-tab-replicate').onclick = () => i2wSetTab('replicate');
document.getElementById('i2w-tab-generate').onclick = () => i2wSetTab('generate');

// --- Depth label updater ---
document.getElementById('i2w-gen-depth').oninput = (e) => {
    const labels = [
        'only -foreground blocks, sky background',
        '-terrain + walls + props',
        'Full depth -terrain + walls + props + water + details'
    ];
    document.getElementById('i2w-gen-depth-label').innerText = labels[parseInt(e.target.value) - 1];
};

// --- Tolerance label ---
document.getElementById('i2w-rep-tolerance').oninput = (e) => {
    document.getElementById('i2w-rep-tol-val').innerText = e.target.value;
};

// ---
// REPLICATE MODE: upload handling
// ---
let i2wRepImgData = null;
document.getElementById('i2w-replicate-upload-btn').onclick = () => document.getElementById('i2w-input').click();

// We need a second hidden file input for the generate mode
const i2wGenInput = document.createElement('input');
i2wGenInput.type = 'file'; i2wGenInput.accept = 'image/*'; i2wGenInput.className = 'hidden';
document.body.appendChild(i2wGenInput);
document.getElementById('i2w-gen-upload-btn').onclick = () => i2wGenInput.click();

let i2wGenImgData = null;

function setI2wRepImage(data, name, remember = true) {
    i2wRepImgData = data;
    const preview = document.getElementById('i2w-rep-preview');
    preview.innerHTML = `<img src="${i2wRepImgData}" title="${name || ''}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #22c55e;">`;
    document.getElementById('i2w-replicate-controls').classList.remove('hidden');
    document.getElementById('i2w-rep-status').innerText = 'Screenshot loaded. Configure and replicate!';
    if (remember) addRecentImage(name, data);
}

function setI2wGenImage(data, name, remember = true) {
    i2wGenImgData = data;
    const preview = document.getElementById('i2w-gen-preview');
    preview.innerHTML = `<img src="${i2wGenImgData}" title="${name || ''}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #f59e0b;">`;
    document.getElementById('i2w-gen-controls').classList.remove('hidden');
    document.getElementById('i2w-gen-status').innerText = 'Image loaded. Configure and generate!';
    if (remember) addRecentImage(name, data);
}

document.getElementById('i2w-input').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        setI2wRepImage(ev.target.result, file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};
document.getElementById('i2w-rep-recent-use-btn')?.addEventListener('click', () => {
    const recent = getSelectedRecentImage('i2w-rep-recent-select');
    if (!recent) return;
    setI2wRepImage(recent.data, recent.name, false);
});

i2wGenInput.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        setI2wGenImage(ev.target.result, file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};
document.getElementById('i2w-gen-recent-use-btn')?.addEventListener('click', () => {
    const recent = getSelectedRecentImage('i2w-gen-recent-select');
    if (!recent) return;
    setI2wGenImage(recent.data, recent.name, false);
});

// ---
// REPLICATE MODE: core logic
// Match each tile region of the screenshot to the closest block by color
// ---
// REPLICATE MODE -pixel fingerprint matching
// Each known texture is rendered to a small canvas and stored as a flat
// pixel array (fingerprint). When the user uploads a screenshot, each
// tile region is extracted, scaled to the same fingerprint size, and
// compared by mean-squared-error to every known texture. The closest
// match (below a threshold) wins; everything else is skipped.
// ---

const FINGER_SIZE = 8; // fingerprint resolution (8x8 = 64 values x 3 channels)
const replicateFingerprints = {}; // texture path ->Uint8Array (rgb, length 8*8*3)

// Render a texture image into an 8x8 RGB fingerprint
function buildFingerprint(img) {
    const c = document.createElement('canvas');
    c.width = FINGER_SIZE; c.height = FINGER_SIZE;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0, FINGER_SIZE, FINGER_SIZE);
    const d = cx.getImageData(0, 0, FINGER_SIZE, FINGER_SIZE).data;
    const fp = new Uint8Array(FINGER_SIZE * FINGER_SIZE * 3);
    let j = 0;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i+3] / 255;
        fp[j++] = Math.round(d[i]   * a);
        fp[j++] = Math.round(d[i+1] * a);
        fp[j++] = Math.round(d[i+2] * a);
    }
    return fp;
}

// Extract an 8x8 fingerprint from a region of a canvas context
function extractRegionFingerprint(ctx, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = FINGER_SIZE; c.height = FINGER_SIZE;
    const cx = c.getContext('2d');
    cx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, FINGER_SIZE, FINGER_SIZE);
    const d = cx.getImageData(0, 0, FINGER_SIZE, FINGER_SIZE).data;
    const fp = new Uint8Array(FINGER_SIZE * FINGER_SIZE * 3);
    let j = 0;
    for (let i = 0; i < d.length; i += 4) {
        fp[j++] = d[i]; fp[j++] = d[i+1]; fp[j++] = d[i+2];
    }
    return fp;
}

// Mean squared error between two fingerprints (lower = more similar)
function fingerprintMSE(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return sum / a.length;
}

// Pre-build all fingerprints from the already-loaded imgCache
// Returns { fgEntries: [{block, fp}], bgEntries: [{block, fp}] }
function buildFingerprintLibrary(includeBg) {
    const fgEntries = [], bgEntries = [];
    for (const block of blockLibrary) {
        const img = imgCache[block.texture];
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        let fp;
        try { fp = buildFingerprint(img); } catch(e) { continue; }
        const entry = { block, fp };
        if (block.type === 'wall') {
            if (includeBg) bgEntries.push(entry);
        } else {
            fgEntries.push(entry);
        }
    }
    return { fgEntries, bgEntries };
}

// Find the best-matching entry by MSE; returns null if best MSE > threshold
function findBestFingerprint(regionFp, entries, threshold) {
    let bestEntry = null, bestMSE = Infinity;
    for (const e of entries) {
        const mse = fingerprintMSE(regionFp, e.fp);
        if (mse < bestMSE) { bestMSE = mse; bestEntry = e; }
    }
    return bestMSE <= threshold ? bestEntry : null;
}

document.getElementById('i2w-replicate-btn').onclick = () => {
    if (!i2wRepImgData) { alert('Upload a screenshot first.'); return; }
    const releaseGeneration = beginGenerationLock('i2w-replicate', 'i2w-replicate-btn', 'Replicating...');
    if (!releaseGeneration) return;

    const startX  = parseInt(document.getElementById('i2w-rep-x').value) || 0;
    const startY  = parseInt(document.getElementById('i2w-rep-y').value) || 0;
    const tileW   = parseInt(document.getElementById('i2w-rep-w').value) || 40;
    const tileH   = parseInt(document.getElementById('i2w-rep-h').value) || 30;
    const matchBg = document.getElementById('i2w-rep-bg').checked;
    const statusEl = document.getElementById('i2w-rep-status');
    const btn      = document.getElementById('i2w-replicate-btn');

    // Tolerance slider: map 10-20 range to MSE threshold
    // Low slider value = strict (low MSE allowed), high = loose (high MSE)
    const toleranceSlider = parseInt(document.getElementById('i2w-rep-tolerance').value) || 45;
    // MSE threshold: slider 10->00, 45->000, 120->2000
    const mseThreshold = Math.round((toleranceSlider / 10) ** 2.2 * 120);

    btn.innerText = 'Building fingerprints...';
    statusEl.style.color = '#4ade80';
    statusEl.innerText = 'Fingerprinting block library...';

    // Use setTimeout to let UI update before heavy work
    setTimeout(() => {
        try {
        const { fgEntries, bgEntries } = buildFingerprintLibrary(matchBg);
        statusEl.innerText = `Library ready: ${fgEntries.length} fg, ${bgEntries.length} bg. Scanning screenshot...`;

        const img = new Image();
        img.onload = () => {
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = img.width; srcCanvas.height = img.height;
            const srcCtx = srcCanvas.getContext('2d');
            srcCtx.drawImage(img, 0, 0);

            // Each tile in the screenshot occupies (img.width/tileW) x (img.height/tileH) pixels
            const tilePixW = img.width  / tileW;
            const tilePixH = img.height / tileH;

            beginGeneratedLayer('Img to World Replicate', 'Image to World');
            let placed = 0, skipped = 0;

            for (let ty = 0; ty < tileH; ty++) {
                for (let tx = 0; tx < tileW; tx++) {
                    const wx = startX + tx, wy = startY + ty;
                    if (wx >= GRID_X || wy >= GRID_Y) continue;

                    const srcX = Math.round(tx * tilePixW);
                    const srcY = Math.round(ty * tilePixH);
                    const srcW = Math.max(1, Math.round(tilePixW));
                    const srcH = Math.max(1, Math.round(tilePixH));

                    // --- FG pass: compare against all foreground block fingerprints ---
                    const fgFp = extractRegionFingerprint(srcCtx, srcX, srcY, srcW, srcH);
                    const fgMatch = findBestFingerprint(fgFp, fgEntries, mseThreshold);
                    if (isProtectedTile(wx, wy)) continue;
                    if (fgMatch) {
                        const blk = fgMatch.block;
                        fgData[wx][wy] = { name: blk.name, texture: blk.texture, type: blk.type, fileName: blk.fileName };
                        placed++;
                    } else {
                        fgData[wx][wy] = null;
                        skipped++;
                    }

                    // --- BG pass (optional) ---
                    if (matchBg && bgEntries.length > 0) {
                        // For background, use a slightly looser threshold -                        // background walls are often partially obscured by fg blocks
                        const bgMatch = findBestFingerprint(fgFp, bgEntries, mseThreshold * 1.5);
                        if (bgMatch) {
                            const blk = bgMatch.block;
                            bgData[wx][wy] = { name: blk.name, texture: blk.texture, type: blk.type, fileName: blk.fileName };
                            placed++;
                        }
                    }
                }
                // Progress update every row
                if (ty % 5 === 0) {
                    statusEl.innerText = `Scanning... row ${ty+1}/${tileH} (${placed} placed so far)`;
                }
            }

            drawCanvas();
            finishGeneratedLayer('Image to World');
            statusEl.style.color = '#4ade80';
            statusEl.innerText = `Done: Done! ${placed} blocks placed, ${skipped} tiles skipped (no match).`;
            releaseGeneration();
        };
        img.onerror = () => {
            statusEl.style.color = '#f87171';
            statusEl.innerText = 'Failed: Failed to load screenshot image.';
            releaseGeneration();
        };
        img.src = i2wRepImgData;
        } catch (err) {
            console.error(err);
            statusEl.style.color = '#f87171';
            statusEl.innerText = 'Failed: Replicate generation failed.';
            releaseGeneration();
        }
    }, 50);
};

// ---
// GENERATE MODE: Build a functional world from any image
// Analyses image structure (sky/ground/underground layers, dominant colors,
// brightness bands) and maps regions to appropriate block types with depth.
// Runs row-by-row with async yield to keep the UI responsive.
// ---

// Place a fg or bg block entry from a palette match result
function placeBlock(palette, r, g, b, wx, wy, layer) {
    if (isProtectedTile(wx, wy)) return 0;
    const match = findClosestBlock(r, g, b, palette);
    if (!match) return 0;
    const blk = match.block;
    const entry = { name: blk.name || blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.fileName || blk.file };
    if (layer === 'fg') fgData[wx][wy] = entry;
    else bgData[wx][wy] = entry;
    return 1;
}

document.getElementById('i2w-gen-btn').onclick = async () => {
    if (!i2wGenImgData) { alert('Upload an image first.'); return; }
    const releaseGeneration = beginGenerationLock('i2w-generate', 'i2w-gen-btn', 'Generating...');
    if (!releaseGeneration) return;

    const statusEl = document.getElementById('i2w-gen-status');
    const btn      = document.getElementById('i2w-gen-btn');

    try {
    const startX  = parseInt(document.getElementById('i2w-gen-x').value) || 0;
    const startY  = parseInt(document.getElementById('i2w-gen-y').value) || 0;
    const tileW   = parseInt(document.getElementById('i2w-gen-w').value) || 40;
    const tileH   = parseInt(document.getElementById('i2w-gen-h').value) || 30;
    const depth   = parseInt(document.getElementById('i2w-gen-depth').value) || 2;
    const replace = document.getElementById('i2w-gen-replace').checked;

    btn.innerText = 'Analysing image...';
    statusEl.style.color = '#fbbf24';
    statusEl.innerText = 'Building block palettes...';

    // --- Build palettes ---
    const blockTypes = ['block', 'wall', 'prop', 'water'];
    const paletteResults = await Promise.all(blockTypes.map(type => {
        const blocks = blockLibrary.filter(b => b.type === type || (!b.type && type === 'block'));
        return Promise.all(blocks.map(b => sampleBlockColor(b))).then(res => res.filter(Boolean));
    }));
    const [solidPalette, wallPalette, propPalette, waterPalette] = paletteResults;

    statusEl.innerText = 'Parsing image structure...';
    await yieldFrame();

    // --- Load image into canvas ---
    const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = i2wGenImgData;
    });

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = img.width; srcCanvas.height = img.height;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0);

    // --- Sample each tile region into tileColors[ty][tx] ---
    const tileColors = [];
    for (let ty = 0; ty < tileH; ty++) {
        tileColors[ty] = [];
        for (let tx = 0; tx < tileW; tx++) {
            const srcX = Math.floor((tx / tileW) * img.width);
            const srcY = Math.floor((ty / tileH) * img.height);
            const srcW = Math.max(1, Math.floor(img.width  / tileW));
            const srcH = Math.max(1, Math.floor(img.height / tileH));
            const px = srcCtx.getImageData(srcX, srcY, srcW, srcH).data;
            let r=0, g=0, b=0, cnt=0;
            for (let i=0; i<px.length; i+=4) {
                if (px[i+3] > 64) { r+=px[i]; g+=px[i+1]; b+=px[i+2]; cnt++; }
            }
            if (cnt === 0) { tileColors[ty][tx] = { r:0,g:0,b:0,lum:0,sat:0,empty:true }; continue; }
            r=Math.round(r/cnt); g=Math.round(g/cnt); b=Math.round(b/cnt);
            const lum = 0.299*r + 0.587*g + 0.114*b;
            const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
            const sat = mx === 0 ? 0 : (mx-mn)/mx;
            tileColors[ty][tx] = { r, g, b, lum, sat };
        }
    }

    // --- Detect horizon (sky/ground boundary) ---
    const rowLum = tileColors.map(row => {
        const valid = row.filter(t => !t.empty);
        return valid.length ? valid.reduce((s,t) => s+t.lum, 0) / valid.length : 0;
    });
    const globalMaxLum = Math.max(...rowLum);
    let horizonY = Math.floor(tileH * 0.35);
    for (let ty = 0; ty < tileH; ty++) {
        if (rowLum[ty] < globalMaxLum * 0.65) { horizonY = ty; break; }
    }
    const undergroundStartY = Math.min(tileH - 1, horizonY + Math.floor((tileH - horizonY) * 0.5));

    // --- Water zone detection: column-based region analysis ---
    // A tile is "blue-water" if its blue channel dominates.
    // We then flood-fill contiguous blue regions so that creatures
    // (jellyfish, pufferfish etc.) that sit inside a water column
    // are treated as water tiles even if they aren't blue themselves.
    const isRawWater = (tc) => !tc.empty && tc.b > tc.r * 1.15 && tc.b > tc.g * 1.05 && tc.lum > 30;

    // Build a 2D boolean grid of water zones via flood-fill from raw-water seeds
    const waterZone = Array.from({length: tileH}, () => new Uint8Array(tileW));
    const visited   = Array.from({length: tileH}, () => new Uint8Array(tileW));
    const queue = [];
    for (let ty = 0; ty < tileH; ty++)
        for (let tx = 0; tx < tileW; tx++)
            if (isRawWater(tileColors[ty][tx])) { waterZone[ty][tx] = 1; queue.push([ty,tx]); }

    // BFS expand: a non-blue neighbour inside the water region is still water
    // (catches the creature tiles that interrupt the blue fill)
    while (queue.length) {
        const [ty, tx] = queue.shift();
        const neighbors = [[ty-1,tx],[ty+1,tx],[ty,tx-1],[ty,tx+1]];
        for (const [ny, nx] of neighbors) {
            if (ny < 0 || ny >= tileH || nx < 0 || nx >= tileW) continue;
            if (visited[ny][nx]) continue;
            visited[ny][nx] = 1;
            const ntc = tileColors[ny][nx];
            if (ntc.empty) continue;
            // Expand if: raw water, OR surrounded enough by water (creature tile inside pool)
            // Heuristic: allow expansion if neighbour lum > 30 (not pitch-black rock)
            //            and it isn't obviously a bright sky/surface tile
            if (isRawWater(ntc) || (!ntc.empty && ntc.lum > 25 && ntc.lum < 220 && waterZone[ty][tx])) {
                waterZone[ny][nx] = 1;
                queue.push([ny, nx]);
            }
        }
    }

    // --- Atmosphere: pick background by color-distance from sky region ---
    // Each background has a known average color (sampled from its orb texture).
    // We average the top ~25% of the image (the sky band) and find the closest match.
    {
        const BGS = [
            { file: 'Alien.png',     r:70,  g:37,  b:86  },
            { file: 'Candy.png',     r:225, g:168, b:224 },
            { file: 'Cemetery.png',  r:8,   g:27,  b:37  },
            { file: 'City.png',      r:28,  g:28,  b:40  },
            { file: 'Forest.png',    r:30,  g:118, b:137 },
            { file: 'Night.png',     r:10,  g:40,  b:49  },
            { file: 'Sand.png',      r:181, g:188, b:186 },
            { file: 'Star.png',      r:0,   g:14,  b:23  },
            { file: 'SummerSky.png', r:134, g:204, b:232 },
            { file: 'Winter.png',    r:155, g:206, b:233 },
        ];
        // Sample sky region: top 25% of image rows, all columns
        const skyDepth = Math.max(1, Math.floor(tileH * 0.25));
        let sr=0, sg=0, sb=0, sc=0;
        for (let ty=0; ty < skyDepth; ty++) {
            for (let tx=0; tx < tileW; tx++) {
                const t = tileColors[ty][tx];
                if (!t.empty) { sr+=t.r; sg+=t.g; sb+=t.b; sc++; }
            }
        }
        if (sc > 0) {
            sr=Math.round(sr/sc); sg=Math.round(sg/sc); sb=Math.round(sb/sc);
            let bestBg = null, bestDist = Infinity;
            for (const bg of BGS) {
                const dr=sr-bg.r, dg=sg-bg.g, db=sb-bg.b;
                const dist = dr*dr + dg*dg + db*db;
                if (dist < bestDist) { bestDist = dist; bestBg = bg; }
            }
            if (bestBg) setBackground(bestBg.file);
        }
    }

    beginGeneratedLayer('Img to World Generate', 'Image to World');
    let placed = 0;

    // --- Main placement loop -yield every row to avoid UI freeze ---
    for (let ty = 0; ty < tileH; ty++) {
        // Yield every row so the browser stays responsive
        await yieldFrame();
        statusEl.innerText = `Placing blocks... row ${ty+1}/${tileH} (${placed} placed)`;

        for (let tx = 0; tx < tileW; tx++) {
            const tc = tileColors[ty][tx];
            if (tc.empty) continue;
            const wx = startX + tx, wy = startY + ty;
            if (wx >= GRID_X || wy >= GRID_Y) continue;
            if (isProtectedTile(wx, wy)) continue;
            if (!replace && (fgData[wx][wy] || bgData[wx][wy])) continue;

            const isSkyBand     = ty < horizonY;
            const isSurface     = ty >= horizonY && ty < horizonY + 3;
            const isMidground   = ty >= horizonY + 3 && ty < undergroundStartY;
            const isUnderground = ty >= undergroundStartY;
            // Use flood-fill zone map -catches creatures inside water too
            const inWater = !!waterZone[ty][tx];

            // --- SKY ---
            if (isSkyBand) {
                if (tc.lum <= 200 || tc.sat >= 0.15) {
                    if (depth >= 2) placed += placeBlock(wallPalette, tc.r, tc.g, tc.b, wx, wy, 'bg');
                }
                continue;
            }

            // --- WATER ZONE (including creatures inside water) ---
            if (inWater && depth >= 2 && waterPalette.length > 0) {
                // Always lay a water fg block for the zone
                placed += placeBlock(waterPalette, tc.r, tc.g, tc.b, wx, wy, 'fg');
                // Add a water-tinted wall behind
                if (wallPalette.length > 0)
                    placed += placeBlock(wallPalette, Math.round(tc.r*0.5), Math.round(tc.g*0.6), Math.round(tc.b*0.9), wx, wy, 'bg');
                continue;
            }

            // --- SURFACE ---
            if (isSurface) {
                placed += placeBlock(solidPalette, tc.r, tc.g, tc.b, wx, wy, 'fg');
                if (depth >= 2)
                    placed += placeBlock(wallPalette, Math.round(tc.r*0.7), Math.round(tc.g*0.7), Math.round(tc.b*0.7), wx, wy, 'bg');
                continue;
            }

            // --- MIDGROUND ---
            if (isMidground) {
                if (tc.lum > 140) {
                    if (depth >= 2) placed += placeBlock(wallPalette, tc.r, tc.g, tc.b, wx, wy, 'bg');
                    if (depth >= 3 && Math.random() < 0.08)
                        placed += placeBlock(propPalette, tc.r, tc.g, tc.b, wx, wy, 'fg');
                } else {
                    placed += placeBlock(solidPalette, tc.r, tc.g, tc.b, wx, wy, 'fg');
                    if (depth >= 2)
                        placed += placeBlock(wallPalette, Math.round(tc.r*0.6), Math.round(tc.g*0.6), Math.round(tc.b*0.6), wx, wy, 'bg');
                }
                continue;
            }

            // --- UNDERGROUND ---
            if (isUnderground) {
                if (depth >= 2)
                    placed += placeBlock(wallPalette, Math.round(tc.r*0.5), Math.round(tc.g*0.5), Math.round(tc.b*0.5), wx, wy, 'bg');
                if (tc.lum < 100)
                    placed += placeBlock(solidPalette, tc.r, tc.g, tc.b, wx, wy, 'fg');
            }
        }

        // Redraw every 5 rows so the user can watch it build
        if (ty % 5 === 0) drawCanvas();
    }

    drawCanvas();
    finishGeneratedLayer('Image to World');
    statusEl.style.color = '#4ade80';
    statusEl.innerText = `Done: World generated! ${placed} blocks placed.`;
    releaseGeneration();
    } catch (err) {
        console.error(err);
        statusEl.style.color = '#f87171';
        statusEl.innerText = 'Failed: World generation failed.';
        releaseGeneration();
    }
};

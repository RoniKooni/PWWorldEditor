const GRID_X = 80, GRID_Y = 60, TILE = 32;
const BASE_PATH = 'textures/blocks/';

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

let fgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let bgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let history = [], redoStack = [];
let activeAtmosphere = null;

let activeTool = 'move', activeSlot = 0;
let hotbar = Array(10).fill(null);
let bucketBlock = null, shapeBlock = null;
let targetBlockForReplace = null;

let scale = 0.8, posX = 0, posY = 0;
let isPanning = false, isDrawing = false, showGrid = false;
let shapeStart = null;
const imgCache = {};
const silhouetteCache = {}; // key: texture src → black-silhouette canvas (for non-block shadows)

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
    });

    function generateDefaultFloor() {
        const findBlock = (filename) => blockLibrary.find(b => b.fileName === filename);

        const bedrock = findBlock('Bedrock.png');
        const lavaRock = findBlock('End Lava Rock.png');
        const lava = findBlock('End Lava.png');

        for (let x = 0; x < GRID_X; x++) {
            if (bedrock) fgData[x][57] = JSON.parse(JSON.stringify(bedrock));
            if (lavaRock) fgData[x][58] = JSON.parse(JSON.stringify(lavaRock));
            if (lava) fgData[x][59] = JSON.parse(JSON.stringify(lava));
        }
    }
}

function getBlockTexture(x, y, block) {
    if (!block) return null;
    if (block.fileName.includes('_0.png')) {
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
    const hasAlt = ASSET_LIST.some(a => a.file === altName && a.folder === block.folder);

    if (isTopExposed && hasAlt) {
        return getImg(`${BASE_PATH}${block.folder}/${altName}`);
    }

    return getImg(block.texture);
}

function saveHistory() {
    if (history.length > 50) history.shift();
    history.push({ fg: JSON.parse(JSON.stringify(fgData)), bg: JSON.parse(JSON.stringify(bgData)), atm: activeAtmosphere });
    redoStack = []; // any new action clears redo
}

function undo() {
    if (history.length > 0) {
        redoStack.push({ fg: JSON.parse(JSON.stringify(fgData)), bg: JSON.parse(JSON.stringify(bgData)), atm: activeAtmosphere });
        const state = history.pop();
        fgData = state.fg; bgData = state.bg; setBackground(state.atm);
    }
}

function redo() {
    if (redoStack.length > 0) {
        history.push({ fg: JSON.parse(JSON.stringify(fgData)), bg: JSON.parse(JSON.stringify(bgData)), atm: activeAtmosphere });
        const state = redoStack.pop();
        fgData = state.fg; bgData = state.bg; setBackground(state.atm);
    }
}

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
    return !!block && (block.type === 'wall' || isWaterBlock(block));
}

function placeBlockAt(x, y, block) {
    if (!block || x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return;

    // Water behaves like a background layer so foreground blocks/platforms can sit above it.
    if (usesBackgroundLayer(block)) {
        bgData[x][y] = cloneBlock(block);

        // Clean up older saves/worlds where water may already exist in the foreground.
        if (isWaterBlock(block) && isWaterBlock(fgData[x][y])) {
            fgData[x][y] = null;
        }
        return;
    }

    // If this cell has old foreground water, move it behind the new foreground block.
    if (isWaterBlock(fgData[x][y])) {
        bgData[x][y] = cloneBlock(fgData[x][y]);
    }

    fgData[x][y] = cloneBlock(block);
}

function setBackground(bgFile) {
    activeAtmosphere = bgFile;
    canvas.style.backgroundImage = bgFile ? `url("textures/orbs/${bgFile}")` : 'none';
    if (typeof customBgDataUrl !== 'undefined' && customBgDataUrl && bgFile) {
        customBgDataUrl = null;
        const el = document.getElementById('custom-bg-preview');
        if (el) el.classList.add('hidden');
    }
}

function updateTransform() { canvas.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`; }

// ── Inventory state ──
let invFilterFolder = 'all'; // current folder filter for main inventory
// Per-button cached data for fast filtering (avoids DOM reads on every keystroke)
// invBtnData[i] = { el, nameLower, folder } for the main inventory list
let invBtnData = [];

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

        // ── Main inventory button ──
        const invBtn = document.createElement('div');
        invBtn.className = 'block-btn';
        invBtn.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;
        // Hide if image fails to load (catches textures missing at runtime)

        invBtn.onclick = () => {
            let targetSlot = hotbar.findIndex((slot, idx) => idx > 0 && slot === null);
            if (targetSlot === -1) targetSlot = activeSlot === 0 ? 1 : activeSlot;
            hotbar[targetSlot] = b;
            document.querySelectorAll('.slot')[targetSlot].innerHTML = `<img src="${b.texture}">`;
            selectSlot(targetSlot);
            closeAll();
        };
        invFrag.appendChild(invBtn);
        invBtnData.push({ el: invBtn, nameLower, folder: b.folder });

        // ── Bucket / Shapes buttons ──
        const makeSimpleBtn = (callback) => {
            const btn = document.createElement('div');
            btn.className = 'block-btn';
            btn.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;

            btn.onclick = () => callback(b);
            return btn;
        };
        if (bucketList) bucketFrag.appendChild(makeSimpleBtn(block => { bucketBlock = block; updateToolState('bucket'); closeAll(); }));
        if (shapesList) shapesFrag.appendChild(makeSimpleBtn(block => { shapeBlock = block; updateToolState('shapes'); closeAll(); }));

        // ── Replace suggestions button ──
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

    // ── Background list ──
    backgroundLibrary.forEach(bg => {
        const btn = document.createElement('div');
        btn.className = 'block-btn';
        const iconSrc = bg.file ? `textures/orbs/${bg.file}` : bg.icon;
        btn.innerHTML = `<img src="${iconSrc}"><span>${bg.name}</span>`;
        btn.onclick = () => { saveHistory(); setBackground(bg.file); closeAll(); };
        bgList.appendChild(btn);
    });

    // ── Filter tab buttons ──
    document.querySelectorAll('.inv-filter-btn').forEach(btn => {
        btn.onclick = () => {
            invFilterFolder = btn.dataset.filter;
            document.querySelectorAll('.inv-filter-btn').forEach(b => b.classList.remove('highlight'));
            btn.classList.add('highlight');
            applyInvFilter(document.getElementById('inv-search').value);
        };
    });
}

// Fast inventory filter — reads pre-cached data, never touches innerText or querySelectorAll
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
    activeTool = tool;
    document.getElementById('bucket-btn').classList.toggle('active-tool', tool === 'bucket');
    document.getElementById('shapes-btn').classList.toggle('active-tool', tool === 'shapes');
    document.getElementById('pick-btn').classList.toggle('active-tool', tool === 'pick');

    const display = document.getElementById('block-name');
    const formatDisplay = (txt) => txt ? txt.toUpperCase() : "NONE";

    if (tool === 'pick') display.innerText = "PICK BLOCK";
    else if (tool === 'bucket') display.innerHTML = `BUCKET (${formatDisplay(bucketBlock?.name)})`;
    else if (tool === 'shapes') display.innerHTML = `SHAPES (${formatDisplay(shapeBlock?.name)})`;
    else if (tool === 'move') display.innerText = "MOVE";
    else {
        const block = hotbar[activeSlot];
        display.innerText = block ? `BLOCK: ${formatDisplay(block.name)}` : "EMPTY SLOT";
    }

    if(tool !== 'hotbar') {
        document.querySelectorAll('.slot').forEach(s => s.classList.remove('active'));
    }
}

function selectSlot(i) {
    activeSlot = i;
    if (i === 0) updateToolState('move');
    else updateToolState('hotbar');
    document.querySelectorAll('.slot').forEach((s, idx) => s.classList.toggle('active', idx === i));
}

function openMenu(id) { closeAll(); document.getElementById(id).classList.remove('hidden'); document.getElementById('overlay').classList.remove('hidden'); }
function closeAll() { document.querySelectorAll('.menu-popup, #overlay, .suggestions-list').forEach(el => el.classList.add('hidden')); }

window.addEventListener('contextmenu', (e) => e.preventDefault());

const bindings = { 'inv-toggle': 'inventory-popup', 'bg-ui-btn': 'bg-popup', 'clear-menu-btn': 'clear-popup', 'help-btn': 'help-popup', 'ref-overlay-btn': 'ref-overlay-popup', 'custom-bg-btn': 'custom-bg-popup', 'img2blocks-btn': 'img2blocks-popup' };
Object.keys(bindings).forEach(id => { const el = document.getElementById(id); if(el) el.onclick = () => openMenu(bindings[id]); });

// ── Block Counter ──
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
        list.innerHTML = '<div style="color:#555;font-size:13px;padding:20px;text-align:center;grid-column:1/-1;">No blocks placed yet.</div>';
        return;
    }

    entries.forEach(([name, data]) => {
        const total = data.fg + data.bg;
        const card = document.createElement('div');
        card.style.cssText = 'background:#1c1c1c;border:1px solid #333;border-radius:8px;padding:10px;display:flex;align-items:center;gap:10px;';
        const texture = data.block.texture || '';
        card.innerHTML = `
            <img src="${texture}" style="width:32px;height:32px;image-rendering:pixelated;flex-shrink:0;">
            <div style="flex:1;min-width:0;">
                <div style="font-size:11px;color:#eee;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${name}">${name}</div>
                <div style="font-size:13px;color:#fff;font-weight:700;margin-top:2px;">× ${total}</div>
                ${data.fg > 0 && data.bg > 0 ? `<div style="font-size:10px;color:#888;margin-top:1px;"><span style="color:#3abdc2;">FG:${data.fg}</span> <span style="color:#f0a040;">BG:${data.bg}</span></div>` : 
                  data.fg > 0 ? `<div style="font-size:10px;color:#3abdc2;margin-top:1px;">Foreground</div>` :
                  `<div style="font-size:10px;color:#f0a040;margin-top:1px;">Background</div>`}
            </div>`;
        list.appendChild(card);
    });
}

document.getElementById('block-counter-btn').onclick = () => {
    openMenu('block-counter-popup');
    bcActiveFilter = 'all';
    renderBlockCounter('all', '');
    document.getElementById('block-counter-search').value = '';
    document.getElementById('bc-filter-all').classList.add('highlight');
    document.getElementById('bc-filter-fg').classList.remove('highlight');
    document.getElementById('bc-filter-bg').classList.remove('highlight');
};

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
            if(fgData[x][y] && fgData[x][y].name === targetBlockForReplace.name) fgData[x][y] = JSON.parse(JSON.stringify(newBlock));
            if(bgData[x][y] && bgData[x][y].name === targetBlockForReplace.name) bgData[x][y] = JSON.parse(JSON.stringify(newBlock));
        }
    }
    closeAll();
};

document.getElementById('delete-all-trigger').onclick = () => {
    if(confirm("Delete EVERYTHING?")) {
        saveHistory();
        // Preserve the default floor rows (57-59) before wiping
        const savedFloor = {};
        for (let x = 0; x < GRID_X; x++) {
            savedFloor[x] = {};
            for (const row of [57, 58, 59]) {
                savedFloor[x][row] = fgData[x][row] ? JSON.parse(JSON.stringify(fgData[x][row])) : null;
            }
        }
        fgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
        bgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
        // Restore floor rows
        for (let x = 0; x < GRID_X; x++) {
            for (const row of [57, 58, 59]) {
                if (savedFloor[x][row]) fgData[x][row] = savedFloor[x][row];
            }
        }
        closeAll();
    }
};

document.querySelectorAll('.close-btn-fancy').forEach(b => b.onclick = closeAll);
document.getElementById('overlay').onclick = closeAll;
document.getElementById('grid-toggle').onclick = () => showGrid = !showGrid;

document.getElementById('save-btn').onclick = () => {
    const data = JSON.stringify({ fg: fgData, bg: bgData, atm: activeAtmosphere });
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'world.json'; a.click();
};

document.getElementById('import-btn').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = (e) => {
    const reader = new FileReader();
    reader.onload = () => { const d = JSON.parse(reader.result); fgData = d.fg; bgData = d.bg; setBackground(d.atm); };
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
        const picked = fgData[x][y] || bgData[x][y];
        if (picked) {
            let targetSlot = hotbar.findIndex((slot, idx) => idx > 0 && slot === null);
            if (targetSlot === -1) targetSlot = activeSlot === 0 ? 1 : activeSlot;

            hotbar[targetSlot] = JSON.parse(JSON.stringify(picked));
            const slotElements = document.querySelectorAll('.slot');
            slotElements[targetSlot].innerHTML = `<img src="${picked.texture}">`;

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
        else { shapeStart = {x, y}; isDrawing = true; }
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
        coordsDisplay.style.color = "#3abdc2";
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
    isPanning = false; isDrawing = false; shapeStart = null;
};

viewport.onwheel = (e) => { e.preventDefault(); scale = Math.min(Math.max(scale + (e.deltaY < 0 ? 0.1 : -0.1), 0.1), 5); updateTransform(); };

function handlePlace(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);

    if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return;

    if (e.buttons === 1) {
        const b = hotbar[activeSlot];
        if (!b || activeSlot === 0) return;
        placeBlockAt(x, y, b);
    }
    else if (e.buttons === 2) {
        fgData[x][y] = null;
        bgData[x][y] = null;
    }
}

function floodFill(x, y, block) {
    const layer = (block && usesBackgroundLayer(block)) ? bgData : fgData;
    const target = layer[x][y]?.name || null;
    if(block && target === block.name) return;
    const stack = [[x, y]];
    while(stack.length) {
        const [cx, cy] = stack.pop();
        if(cx<0 || cx>=GRID_X || cy<0 || cy>=GRID_Y || (layer[cx][cy]?.name || null) !== target) continue;
        if (block) placeBlockAt(cx, cy, block);
        else layer[cx][cy] = null;
        stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
    }
}

function drawShape(x1, y1, x2, y2) {
    const type = document.getElementById('shape-type').value;
    const fill = document.getElementById('shape-fill').checked;
    const layer = usesBackgroundLayer(shapeBlock) ? bgData : fgData;
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
            if(inside) placeBlockAt(x, y, shapeBlock);
        }
    }
}

const SHADOW_OFFSET = 8;  // px offset to bottom-right
const SHADOW_ALPHA  = 0.35; // translucency of shadow

function render(time) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const glowAlpha = (Math.sin(time * 0.002) + 1) / 2;

    // ── Pass 1: draw background blocks ──
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = bgData[x][y];
            if (!block) continue;
            const baseTex = getBlockTexture(x, y, block);
            if (!baseTex) continue;
            ctx.drawImage(baseTex, x * TILE, y * TILE, TILE, TILE);
        }
    }

    // ── Pass 2: draw fg block shadows — only on top of bg cells ──
    // • Solid square shadow  → for 'block' type (opaque square tiles)
    // • Image-shaped shadow  → for everything else (props, water, etc.)
    //   Uses the block's own texture drawn in black + SHADOW_ALPHA transparency.
    ctx.save();
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const fgBlock = fgData[x][y];
            if (!fgBlock) continue; // no fg block here, no shadow

            const px = x * TILE + SHADOW_OFFSET;
            const py = y * TILE + SHADOW_OFFSET;

            // Gather bg cells that the shadow rectangle overlaps
            const x0 = x, x1 = x + 1;
            const y0 = y, y1 = y + 1;

            // ── Square shadow (block type) ──
            if (fgBlock.type === 'block') {
                ctx.fillStyle = 'rgba(0,0,0,' + SHADOW_ALPHA + ')';
                for (let bx = x0; bx <= x1; bx++) {
                    for (let by = y0; by <= y1; by++) {
                        if (bx < 0 || bx >= GRID_X || by < 0 || by >= GRID_Y) continue;
                        if (!bgData[bx][by]) continue;

                        const tileLeft   = bx * TILE;
                        const tileTop    = by * TILE;
                        const tileRight  = tileLeft + TILE;
                        const tileBottom = tileTop  + TILE;

                        const clipX = Math.max(px, tileLeft);
                        const clipY = Math.max(py, tileTop);
                        const clipW = Math.min(px + TILE, tileRight)  - clipX;
                        const clipH = Math.min(py + TILE, tileBottom) - clipY;

                        if (clipW > 0 && clipH > 0) {
                            ctx.fillRect(clipX, clipY, clipW, clipH);
                        }
                    }
                }
            } else {
                // ── Image-shaped shadow (prop, water, etc.) ──
                const tex = getBlockTexture(x, y, fgBlock);
                if (!tex || !tex.complete || tex.naturalWidth === 0) continue;

                // Check that at least one bg cell exists under the shadow
                let hasBg = false;
                for (let bx = x0; bx <= x1 && !hasBg; bx++) {
                    for (let by = y0; by <= y1 && !hasBg; by++) {
                        if (bx >= 0 && bx < GRID_X && by >= 0 && by < GRID_Y && bgData[bx][by]) hasBg = true;
                    }
                }
                if (!hasBg) continue;

                // Build a black silhouette of the texture using an offscreen canvas (cached)
                const cacheKey = tex.src;
                let oc = silhouetteCache[cacheKey];
                if (!oc) {
                    oc = document.createElement('canvas');
                    oc.width  = TILE;
                    oc.height = TILE;
                    const oc2 = oc.getContext('2d');
                    oc2.drawImage(tex, 0, 0, TILE, TILE);
                    oc2.globalCompositeOperation = 'source-in';
                    oc2.fillStyle = 'black';
                    oc2.fillRect(0, 0, TILE, TILE);
                    silhouetteCache[cacheKey] = oc;
                }

                // Draw the silhouette at the shadow offset, clipped to bg tiles
                for (let bx = x0; bx <= x1; bx++) {
                    for (let by = y0; by <= y1; by++) {
                        if (bx < 0 || bx >= GRID_X || by < 0 || by >= GRID_Y) continue;
                        if (!bgData[bx][by]) continue;

                        const tileLeft   = bx * TILE;
                        const tileTop    = by * TILE;
                        const tileRight  = tileLeft + TILE;
                        const tileBottom = tileTop  + TILE;

                        const clipX = Math.max(px, tileLeft);
                        const clipY = Math.max(py, tileTop);
                        const clipW = Math.min(px + TILE, tileRight)  - clipX;
                        const clipH = Math.min(py + TILE, tileBottom) - clipY;

                        if (clipW > 0 && clipH > 0) {
                            ctx.save();
                            ctx.globalAlpha = SHADOW_ALPHA;
                            // Clip to just the overlapping region so shadow doesn't bleed
                            ctx.beginPath();
                            ctx.rect(clipX, clipY, clipW, clipH);
                            ctx.clip();
                            ctx.drawImage(oc, px, py, TILE, TILE);
                            ctx.restore();
                        }
                    }
                }
            }
        }
    }
    ctx.restore();

    // ── Pass 3: draw fg blocks (and their glows) on top ──
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            const block = fgData[x][y];
            if (!block) continue;

            const baseTex = getBlockTexture(x, y, block);
            if (!baseTex) continue;

            ctx.drawImage(baseTex, x * TILE, y * TILE, TILE, TILE);

            const glowName = block.fileName.replace('.png', '_Glow.png');
            const hasGlow = ASSET_LIST.some(a => a.file === glowName && a.folder === block.folder);

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
    }

    if (showGrid) {
        ctx.strokeStyle = "rgba(220, 40, 40, 0.55)";
        ctx.lineWidth = 1.5;
        for (let i = 0; i <= GRID_X; i++) {
            ctx.beginPath(); ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, canvas.height); ctx.stroke();
        }
        for (let i = 0; i <= GRID_Y; i++) {
            ctx.beginPath(); ctx.moveTo(0, i * TILE); ctx.lineTo(canvas.width, i * TILE); ctx.stroke();
        }
        ctx.lineWidth = 1;
    }

    requestAnimationFrame(render);
}

function drawCanvas() {
    requestAnimationFrame(render);
}

const pickBtn = document.getElementById('pick-btn');
if (pickBtn) {
    pickBtn.onclick = () => updateToolState('pick');
}

window.onkeydown = (e) => {
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

    const key = e.key.toLowerCase();

    if (key === 'f') updateToolState('bucket');
    if (key === 's') updateToolState('shapes');
    if (key === 'k') updateToolState('pick');
    if (key === 'm') selectSlot(0);

    if (e.key >= '1' && e.key <= '9') {
        selectSlot(parseInt(e.key));
    }
    if (e.key === '0') {
        selectSlot(0);
    }
};

document.getElementById('screenshot-btn').onclick = () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    const drawBlocks = () => {
        for (let x = 0; x < GRID_X; x++) {
            for (let y = 0; y < GRID_Y; y++) {
                if (bgData[x][y]) {
                    const tex = getBlockTexture(x, y, bgData[x][y]);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
                if (fgData[x][y]) {
                    const tex = getBlockTexture(x, y, fgData[x][y]);
                    if (tex) tempCtx.drawImage(tex, x * TILE, y * TILE, TILE, TILE);
                }
            }
        }
        const link = document.createElement('a');
        link.download = `PW_World_Export_${Date.now()}.png`;
        link.href = tempCanvas.toDataURL("image/png");
        link.click();
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
};

document.querySelectorAll('.slot').forEach(s => {
    s.onclick = () => selectSlot(parseInt(s.dataset.slot));
});

autoLoadAssets();
updateTransform();
render();

// ============================================================
// FEATURE: Reference Image Overlay
// ============================================================
let refImg = null;
let refOverlayImg = null;

const refOverlayEl = (() => {
    const el = document.createElement('img');
    el.id = 'ref-overlay-img';
    el.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10;transform-origin:top left;';
    viewport.appendChild(el);
    return el;
})();

function updateRefOverlay() {
    if (!refImg) { refOverlayEl.style.display = 'none'; return; }
    const visible = document.getElementById('ref-visible').checked;
    const opacity = document.getElementById('ref-opacity').value / 100;
    const sc = document.getElementById('ref-scale').value / 100;
    const ox = parseInt(document.getElementById('ref-offset-x').value);
    const oy = parseInt(document.getElementById('ref-offset-y').value);
    refOverlayEl.src = refImg;
    refOverlayEl.style.display = visible ? 'block' : 'none';
    refOverlayEl.style.opacity = opacity;
    // Position relative to canvas inside viewport (canvas has its own transform)
    refOverlayEl.style.transform = `translate(${posX + ox * scale}px, ${posY + oy * scale}px) scale(${scale * sc})`;
}

// Hook into updateTransform to also update overlay
const _origUpdateTransform = updateTransform;
// We override by patching after the fact
setInterval(updateRefOverlay, 50);

document.getElementById('ref-overlay-btn').onclick = () => openMenu('ref-overlay-popup');
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
    refOverlayEl.style.display = 'none';
    document.getElementById('ref-controls').classList.add('hidden');
};

// ============================================================
// FEATURE: Custom Background
// ============================================================
let customBgDataUrl = null;

document.getElementById('custom-bg-btn').onclick = () => openMenu('custom-bg-popup');
document.getElementById('custom-bg-upload-btn').onclick = () => document.getElementById('custom-bg-input').click();
document.getElementById('custom-bg-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        customBgDataUrl = ev.target.result;
        document.getElementById('custom-bg-thumb').src = customBgDataUrl;
        document.getElementById('custom-bg-preview').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};
document.getElementById('custom-bg-apply-btn').onclick = () => {
    if (!customBgDataUrl) return;
    saveHistory();
    // Set canvas background to custom image
    canvas.style.backgroundImage = `url("${customBgDataUrl}")`;
    canvas.style.backgroundSize = '100% 100%';
    // Store so undo/screenshot still works
    activeAtmosphere = null; // clear orb bg since we're using custom
    closeAll();
};
document.getElementById('custom-bg-remove-btn').onclick = () => {
    customBgDataUrl = null;
    canvas.style.backgroundImage = 'none';
    document.getElementById('custom-bg-preview').classList.add('hidden');
};



// ============================================================
// FEATURE: Image to Blocks Converter (Enhanced with Depth & Shading)
// ============================================================
let i2bImgData = null;
let i2bImgEl = null;

document.getElementById('img2blocks-btn').onclick = () => openMenu('img2blocks-popup');
document.getElementById('img2blocks-upload-btn').onclick = () => document.getElementById('img2blocks-input').click();
document.getElementById('img2blocks-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        i2bImgData = ev.target.result;
        const preview = document.getElementById('i2b-preview');
        preview.innerHTML = `<img src="${i2bImgData}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #444;">`;
        document.getElementById('img2blocks-controls').classList.remove('hidden');
        document.getElementById('i2b-status').innerText = 'Image loaded. Configure settings and convert!';
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

// Variety slider label updater
document.getElementById('i2b-variety').oninput = (e) => {
    const labels = [
        '🟦 Pixel blocks only — clean pixel art mode',
        '🟧 HD Depth Art — FG+BG layers + 3-tier shading',
        '🔶 HD Depth Art + wall tiles (richer palette)',
        '🌈 HD Depth Art — everything inc. props & water'
    ];
    document.getElementById('i2b-variety-label').innerText = labels[parseInt(e.target.value) - 1];
};

// ─────────────────────────────────────────────
// SHARED: Sample average color from a block texture
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// SHARED: Closest color match (perceptual, weighted)
// ─────────────────────────────────────────────
function findClosestBlock(r, g, b, palette) {
    let best = null, bestDist = Infinity;
    for (const entry of palette) {
        const dr = r - entry.r, dg = g - entry.g, db = b - entry.b;
        const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
        if (dist < bestDist) { bestDist = dist; best = entry; }
    }
    return best;
}

// ─────────────────────────────────────────────
// SHARED: Sample image into pixel canvas + collect pixel data
// ─────────────────────────────────────────────
function sampleImageToCanvas(tempImg, outW, outH, doFlip) {
    const offscreen = document.createElement('canvas');
    offscreen.width = outW; offscreen.height = outH;
    const offCtx = offscreen.getContext('2d');
    if (doFlip) {
        offCtx.save();
        offCtx.translate(outW, 0);
        offCtx.rotate(Math.PI / 2);
        offCtx.drawImage(tempImg, 0, 0, outH, outW);
        offCtx.restore();
    } else {
        offCtx.drawImage(tempImg, 0, 0, outW, outH);
    }
    return offCtx.getImageData(0, 0, outW, outH).data;
}

// ─────────────────────────────────────────────
// SHARED: Batch block color sampler
// ─────────────────────────────────────────────
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
                statusEl.innerText = `⏳ ${label} ${Math.min(idx, candidateBlocks.length)}/${candidateBlocks.length}`;
                setTimeout(processBatch, 0);
            } else {
                callback(results);
            }
        });
    }
    processBatch();
}

// ─────────────────────────────────────────────
// SHARED: Detect if image is monochrome / ink art (B&W manga, line art, etc.)
// Returns true when the image has very low color saturation on average,
// meaning it is essentially grayscale and should be treated as ink art.
// ─────────────────────────────────────────────
function detectMonochrome(pixelData, outW, outH) {
    let totalSat = 0, count = 0;
    for (let i = 0; i < outW * outH; i++) {
        const pi = i * 4;
        if (pixelData[pi+3] < 64) continue;
        const r = pixelData[pi] / 255, g = pixelData[pi+1] / 255, b = pixelData[pi+2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        totalSat += (max - min);
        count++;
    }
    if (count === 0) return false;
    // Average saturation below 0.08 = effectively grayscale
    return (totalSat / count) < 0.08;
}

// ─────────────────────────────────────────────
// MODE 1a: INK ART MODE — for B&W manga, line art, halftone art.
// Dark pixels = ink = place block. Light pixels = paper = leave empty.
// Uses a 4-tier ink density system so halftones and gradients render faithfully:
//   Tier 0 (solid ink, darkFactor ≥ 0.72): darkest block (Black or near-black)
//   Tier 1 (dark tone, ≥ 0.45):            dark-grey block
//   Tier 2 (halftone, ≥ 0.22):             mid-grey block
//   Tier 3 (near-white, < 0.22):           leave empty (paper)
// The Sobel edge map is used to boost ink lines — edges always get at least Tier 1
// regardless of raw luminance, so fine hair lines and contour strokes are never lost.
// ─────────────────────────────────────────────
function runInkArtMode(pixelData, outW, outH, startX, startY, statusEl) {
    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return b.fileName.startsWith('Pixel Block');
    });

    if (candidateBlocks.length === 0) {
        statusEl.innerText = 'Error: No Pixel Blocks found!';
        return;
    }

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling pixel blocks (ink art)...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: Could not sample pixel block colors.'; return; }

        statusEl.innerText = `⚡ Placing ink art blocks with ${palette.length} colors...`;
        saveHistory();

        // ── Build luminance map ──
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
        const lumRange = Math.max(maxLum - minLum, 1);

        // ── Sobel edge map — critical for preserving ink strokes ──
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

        // ── Build ink density tiers targeting B&W blocks ──
        // Target luminances for each tier: solid black → dark grey → mid grey
        const INK_TARGETS = [
            { r: 20,  g: 20,  b: 20  },  // Tier 0: solid ink
            { r: 70,  g: 70,  b: 70  },  // Tier 1: dark tone
            { r: 150, g: 150, b: 150 },  // Tier 2: halftone/grey
        ];
        const tierCache = [{}, {}, {}];
        function getInkBlock(tier) {
            const t = INK_TARGETS[tier];
            const key = tier;
            if (tierCache[tier][key] !== undefined) return tierCache[tier][key];
            const best = findClosestBlock(t.r, t.g, t.b, palette);
            tierCache[tier][key] = best ? best.block : null;
            return tierCache[tier][key];
        }
        // Pre-compute the three tier blocks once
        const tierBlocks = [getInkBlock(0), getInkBlock(1), getInkBlock(2)];

        let placed = 0;
        for (let ty = 0; ty < outH; ty++) {
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

                // Skip near-white (paper) pixels — this is the correct direction for ink art
                if (effectiveDensity < 0.22) continue;

                let tier;
                if      (effectiveDensity >= 0.72) tier = 0;  // solid ink → darkest block
                else if (effectiveDensity >= 0.45) tier = 1;  // dark tone
                else                               tier = 2;  // halftone

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;

                const block = tierBlocks[tier];
                if (block) {
                    fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                    placed++;
                }
            }
        }
        statusEl.innerText = `✅ Ink art done! ${placed} blocks placed with 4-tier ink density.`;
    });
}

// ─────────────────────────────────────────────
// MODE 1: PIXEL BLOCKS — shaded pixel art (color) or ink art (B&W auto-detect)
// Uses Pixel Blocks on FG only.
// Auto-detects monochrome/ink art and switches to runInkArtMode.
// For color images: shading via luminance+edge darkFactor, 3 tiers.
// ─────────────────────────────────────────────
function runPixelBlocksMode(pixelData, outW, outH, startX, startY, statusEl) {
    // ── Auto-detect B&W / ink art and use the correct mode ──
    if (detectMonochrome(pixelData, outW, outH)) {
        statusEl.innerText = '🖋️ Ink art detected — switching to ink art mode...';
        runInkArtMode(pixelData, outW, outH, startX, startY, statusEl);
        return;
    }

    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return b.fileName.startsWith('Pixel Block');
    });

    if (candidateBlocks.length === 0) {
        statusEl.innerText = 'Error: No Pixel Blocks found!';
        return;
    }

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling pixel blocks...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: Could not sample pixel block colors.'; return; }

        statusEl.innerText = `⚡ Placing shaded pixel blocks with ${palette.length} colors...`;
        saveHistory();

        // ── Global luminance range ──
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
        const lumRange = Math.max(maxLum - minLum, 1);

        // ── Sobel edge map ──
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

        // ── Shade tiers: search for closest block to darkened color ──
        // Tier 0 (highlight): color × 1.0
        // Tier 1 (midtone):   color × 0.72
        // Tier 2 (shadow):    color × 0.48
        // Tier 3 (deep):      skip FG entirely (leave empty)
        const SHADE_MULT = [1.0, 0.72, 0.48];
        const shadeCache = {};
        function getShadedBlock(r, g, b, tier) {
            const key = `${r>>2},${g>>2},${b>>2},${tier}`;
            if (shadeCache[key] !== undefined) return shadeCache[key];
            const m = SHADE_MULT[tier];
            const best = findClosestBlock(Math.round(r*m), Math.round(g*m), Math.round(b*m), palette);
            shadeCache[key] = best ? best.block : null;
            return shadeCache[key];
        }

        let placed = 0;
        for (let ty = 0; ty < outH; ty++) {
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

                // Tier 3 = leave empty (natural gap = depth)
                if (darkFactor >= 0.75) continue;

                let shadeTier;
                if      (darkFactor < 0.25) shadeTier = 0;
                else if (darkFactor < 0.50) shadeTier = 1;
                else                        shadeTier = 2;

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;

                const block = getShadedBlock(r, g, b, shadeTier);
                if (block) {
                    fgData[wx][wy] = JSON.parse(JSON.stringify(block));
                    placed++;
                }
            }
        }
        statusEl.innerText = `✅ Pixel art done! ${placed} blocks placed with 3-tier shading.`;
    });
}

// ─────────────────────────────────────────────
// MODE 2–4: HD ALL BLOCKS — pure color match, FG only
// No shading. Uses all/fg/wall block types for richer palette.
// ─────────────────────────────────────────────
function runHDDepthMode(pixelData, outW, outH, startX, startY, blockSetFilter, statusEl) {
    const candidateBlocks = blockLibrary.filter(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return false;
        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== '0') return false;
        return blockSetFilter(b);
    });

    batchSampleBlocks(candidateBlocks, statusEl, 'Sampling blocks...', (palette) => {
        if (palette.length === 0) { statusEl.innerText = 'Error: No blocks sampled.'; return; }

        statusEl.innerText = `⚡ Placing blocks with ${palette.length} colors...`;
        saveHistory();

        const colorCache = {};
        let placed = 0;

        for (let ty = 0; ty < outH; ty++) {
            for (let tx = 0; tx < outW; tx++) {
                const pi = (ty * outW + tx) * 4;
                const r = pixelData[pi], g = pixelData[pi+1], b = pixelData[pi+2], a = pixelData[pi+3];
                if (a < 64) continue;

                const key = `${r>>2},${g>>2},${b>>2}`;
                if (!colorCache[key]) {
                    const best = findClosestBlock(r, g, b, palette);
                    colorCache[key] = best ? best.block : null;
                }

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y || !colorCache[key]) continue;

                const block = colorCache[key];
                placeBlockAt(wx, wy, block);
                placed++;
            }
        }
        statusEl.innerText = `✅ Done! Placed ${placed} blocks using ${palette.length} colors.`;
    });
}

// ─────────────────────────────────────────────
// MAIN CONVERT BUTTON
// ─────────────────────────────────────────────
document.getElementById('img2blocks-convert-btn').onclick = () => {
    if (!i2bImgData) { alert('Please upload an image first.'); return; }

    const startX = parseInt(document.getElementById('i2b-x').value);
    const startY = parseInt(document.getElementById('i2b-y').value);
    const tileW = parseInt(document.getElementById('i2b-w').value);
    const tileH = parseInt(document.getElementById('i2b-h').value);
    const variety = parseInt(document.getElementById('i2b-variety').value) || 1;
    const doFlip = document.getElementById('i2b-flip').checked;

    const outW = doFlip ? tileH : tileW;
    const outH = doFlip ? tileW : tileH;

    const statusEl = document.getElementById('i2b-status');
    statusEl.innerText = '⏳ Loading image...';

    const tempImg = new Image();
    tempImg.onload = () => {
        const pixelData = sampleImageToCanvas(tempImg, outW, outH, doFlip);

        if (variety === 1) {
            // ── MODE 1: Clean pixel art (pixel blocks only, FG layer) ──
            statusEl.innerText = '⏳ Pixel art mode: sampling pixel blocks...';
            runPixelBlocksMode(pixelData, outW, outH, startX, startY, statusEl);
        } else {
            // ── MODE 2–4: HD Depth Art (dual-layer + 3-tier shading) ──
            statusEl.innerText = '⏳ HD mode: sampling block palette...';

            const isPixelBlock = (b) => b.fileName.startsWith('Pixel Block');
            const isBlockFolder = (b) => b.folder === 'block';
            const isWallFolder  = (b) => b.folder === 'background';

            let blockSetFilter;
            if (variety === 2) blockSetFilter = (b) => isPixelBlock(b) || isBlockFolder(b);
            else if (variety === 3) blockSetFilter = (b) => isPixelBlock(b) || isBlockFolder(b) || isWallFolder(b);
            else blockSetFilter = () => true;

            runHDDepthMode(pixelData, outW, outH, startX, startY, blockSetFilter, statusEl);
        }
    };
    tempImg.src = i2bImgData;
};


// ============================================================
// FEATURE: Image to World (i2w)
// ============================================================

bindings['i2w-btn'] = 'i2w-popup';
document.getElementById('i2w-btn').onclick = () => openMenu('i2w-popup');

// ─── Tab switching ───
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

// ─── Depth label updater ───
document.getElementById('i2w-gen-depth').oninput = (e) => {
    const labels = [
        '🏔️ Terrain only — foreground blocks, sky background',
        '🏗️ Balanced — terrain + walls + props',
        '🌆 Full depth — terrain + walls + props + water + details'
    ];
    document.getElementById('i2w-gen-depth-label').innerText = labels[parseInt(e.target.value) - 1];
};

// ─── Tolerance label ───
document.getElementById('i2w-rep-tolerance').oninput = (e) => {
    document.getElementById('i2w-rep-tol-val').innerText = e.target.value;
};

// ─────────────────────────────────────────────
// REPLICATE MODE: upload handling
// ─────────────────────────────────────────────
let i2wRepImgData = null;
document.getElementById('i2w-replicate-upload-btn').onclick = () => document.getElementById('i2w-input').click();

// We need a second hidden file input for the generate mode
const i2wGenInput = document.createElement('input');
i2wGenInput.type = 'file'; i2wGenInput.accept = 'image/*'; i2wGenInput.className = 'hidden';
document.body.appendChild(i2wGenInput);
document.getElementById('i2w-gen-upload-btn').onclick = () => i2wGenInput.click();

let i2wGenImgData = null;

document.getElementById('i2w-input').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        i2wRepImgData = ev.target.result;
        const preview = document.getElementById('i2w-rep-preview');
        preview.innerHTML = `<img src="${i2wRepImgData}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #22c55e;">`;
        document.getElementById('i2w-replicate-controls').classList.remove('hidden');
        document.getElementById('i2w-rep-status').innerText = 'Screenshot loaded. Configure and replicate!';
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

i2wGenInput.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        i2wGenImgData = ev.target.result;
        const preview = document.getElementById('i2w-gen-preview');
        preview.innerHTML = `<img src="${i2wGenImgData}" style="max-width:100%;max-height:100px;border-radius:4px;border:1px solid #f59e0b;">`;
        document.getElementById('i2w-gen-controls').classList.remove('hidden');
        document.getElementById('i2w-gen-status').innerText = 'Image loaded. Configure and generate!';
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

// ─────────────────────────────────────────────
// REPLICATE MODE: core logic
// Match each tile region of the screenshot to the closest block by color
// ─────────────────────────────────────────────

// Build palette for replication: samples ALL blocks (fg and bg)
function buildReplicatePalette(includeBg, callback) {
    const fgBlocks = ASSET_LIST.filter(b => b.type === 'block' || !b.type);
    const bgBlocks = includeBg ? ASSET_LIST.filter(b => b.type === 'wall') : [];
    const allBlocks = [...fgBlocks, ...bgBlocks];
    
    // Deduplicate by texture path
    const seen = new Set();
    const unique = allBlocks.filter(b => {
        const key = b.texture || `${b.folder}/${b.file}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });

    const promises = unique.map(b => sampleBlockColor(b));
    Promise.all(promises).then(results => {
        const fgPalette = results.filter(r => r && (r.block.type === 'block' || !r.block.type));
        const bgPalette = includeBg ? results.filter(r => r && r.block.type === 'wall') : [];
        callback(fgPalette, bgPalette);
    });
}

document.getElementById('i2w-replicate-btn').onclick = () => {
    if (!i2wRepImgData) { alert('Upload a screenshot first.'); return; }

    const startX   = parseInt(document.getElementById('i2w-rep-x').value) || 0;
    const startY   = parseInt(document.getElementById('i2w-rep-y').value) || 0;
    const tileW    = parseInt(document.getElementById('i2w-rep-w').value) || 40;
    const tileH    = parseInt(document.getElementById('i2w-rep-h').value) || 30;
    const tolerance = parseInt(document.getElementById('i2w-rep-tolerance').value) || 45;
    const matchBg  = document.getElementById('i2w-rep-bg').checked;
    const statusEl = document.getElementById('i2w-rep-status');
    const btn      = document.getElementById('i2w-replicate-btn');

    btn.disabled = true; btn.innerText = '⏳ Sampling blocks...';
    statusEl.style.color = '#4ade80';
    statusEl.innerText = 'Building block palette...';

    buildReplicatePalette(matchBg, (fgPalette, bgPalette) => {
        statusEl.innerText = `Palette ready (${fgPalette.length} fg, ${bgPalette.length} bg). Analysing image...`;

        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            saveHistory();
            let placed = 0, skipped = 0;

            for (let ty = 0; ty < tileH; ty++) {
                for (let tx = 0; tx < tileW; tx++) {
                    // Sample a region of the source image corresponding to this tile
                    const srcX = Math.floor((tx / tileW) * img.width);
                    const srcY = Math.floor((ty / tileH) * img.height);
                    const srcW = Math.max(1, Math.floor(img.width / tileW));
                    const srcH = Math.max(1, Math.floor(img.height / tileH));

                    // Average the pixel color in the region
                    const pixData = ctx.getImageData(srcX, srcY, srcW, srcH).data;
                    let r=0, g=0, b=0, count=0;
                    for (let i=0; i<pixData.length; i+=4) {
                        if (pixData[i+3] > 64) { r+=pixData[i]; g+=pixData[i+1]; b+=pixData[i+2]; count++; }
                    }
                    if (count === 0) { skipped++; continue; }
                    r = Math.round(r/count); g = Math.round(g/count); b = Math.round(b/count);

                    const wx = startX + tx, wy = startY + ty;
                    if (wx >= GRID_X || wy >= GRID_Y) continue;

                    // Determine if this is a bright/sky region (no block needed)
                    const lum = 0.299*r + 0.587*g + 0.114*b;

                    // FG block: find closest match in fg palette
                    const fgMatch = findClosestBlock(r, g, b, fgPalette);
                    if (fgMatch) {
                        // Calculate color distance for the FG match
                        const dr = r - fgMatch.r, dg = g - fgMatch.g, db = b - fgMatch.b;
                        const dist = Math.sqrt(2*dr*dr + 4*dg*dg + 3*db*db);
                        if (dist <= tolerance) {
                            const blk = fgMatch.block;
                            fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                            placed++;
                        } else {
                            // Distance too far — skip (block doesn't exist)
                            fgData[wx][wy] = null;
                            skipped++;
                        }
                    }

                    // BG wall matching (sample the same region but with looser match)
                    if (matchBg && bgPalette.length > 0) {
                        const bgMatch = findClosestBlock(r, g, b, bgPalette);
                        if (bgMatch) {
                            const dr = r - bgMatch.r, dg = g - bgMatch.g, db = b - bgMatch.b;
                            const dist = Math.sqrt(2*dr*dr + 4*dg*dg + 3*db*db);
                            if (dist <= tolerance * 1.3) {
                                const blk = bgMatch.block;
                                bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                        }
                    }
                }
            }

            drawCanvas();
            statusEl.style.color = '#4ade80';
            statusEl.innerText = `✅ Done! ${placed} blocks placed, ${skipped} skipped (no match).`;
            btn.disabled = false; btn.innerText = '📷 Replicate World';
        };
        img.src = i2wRepImgData;
    });
};

// ─────────────────────────────────────────────
// GENERATE MODE: Build a functional world from any image
// Analyses image structure (sky/ground/underground layers, dominant colors,
// brightness bands) and maps regions to appropriate block types with depth
// ─────────────────────────────────────────────

document.getElementById('i2w-gen-btn').onclick = () => {
    if (!i2wGenImgData) { alert('Upload an image first.'); return; }

    const startX   = parseInt(document.getElementById('i2w-gen-x').value) || 0;
    const startY   = parseInt(document.getElementById('i2w-gen-y').value) || 0;
    const tileW    = parseInt(document.getElementById('i2w-gen-w').value) || 40;
    const tileH    = parseInt(document.getElementById('i2w-gen-h').value) || 30;
    const depth    = parseInt(document.getElementById('i2w-gen-depth').value) || 2;
    const replace  = document.getElementById('i2w-gen-replace').checked;
    const statusEl = document.getElementById('i2w-gen-status');
    const btn      = document.getElementById('i2w-gen-btn');

    btn.disabled = true; btn.innerText = '⏳ Analysing image...';
    statusEl.style.color = '#fbbf24';
    statusEl.innerText = 'Building block palettes...';

    // Build separate palettes by block type
    const blockTypes = ['block', 'wall', 'prop', 'water'];
    const palettePromises = blockTypes.map(type => {
        const blocks = ASSET_LIST.filter(b => (b.type || 'block') === type);
        return Promise.all(blocks.map(b => sampleBlockColor(b))).then(res => res.filter(Boolean));
    });

    Promise.all(palettePromises).then(([solidPalette, wallPalette, propPalette, waterPalette]) => {
        statusEl.innerText = 'Parsing image structure...';

        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // ── Analyse the image in tile-sized regions ──
            // For each tile we compute: avg color, luminance, saturation, vertical position
            const tileColors = [];
            for (let ty = 0; ty < tileH; ty++) {
                tileColors[ty] = [];
                for (let tx = 0; tx < tileW; tx++) {
                    const srcX = Math.floor((tx / tileW) * img.width);
                    const srcY = Math.floor((ty / tileH) * img.height);
                    const srcW = Math.max(1, Math.floor(img.width / tileW));
                    const srcH = Math.max(1, Math.floor(img.height / tileH));

                    const pixData = ctx.getImageData(srcX, srcY, srcW, srcH).data;
                    let r=0, g=0, b=0, count=0;
                    for (let i=0; i<pixData.length; i+=4) {
                        if (pixData[i+3] > 64) { r+=pixData[i]; g+=pixData[i+1]; b+=pixData[i+2]; count++; }
                    }
                    if (count === 0) { tileColors[ty][tx] = { r:0, g:0, b:0, lum:0, sat:0, empty:true }; continue; }
                    r=Math.round(r/count); g=Math.round(g/count); b=Math.round(b/count);
                    const lum = 0.299*r + 0.587*g + 0.114*b;
                    const max = Math.max(r,g,b), min = Math.min(r,g,b);
                    const sat = max === 0 ? 0 : (max - min) / max;
                    tileColors[ty][tx] = { r, g, b, lum, sat };
                }
            }

            // ── Detect sky region: top band of high-luminance, low-saturation tiles ──
            // Find the lowest row where average luminance drops significantly
            const rowLum = tileColors.map(row => {
                const valid = row.filter(t => !t.empty);
                return valid.length ? valid.reduce((s,t) => s + t.lum, 0) / valid.length : 0;
            });
            const globalMaxLum = Math.max(...rowLum);
            // Horizon = first row that is significantly darker than the sky
            let horizonY = Math.floor(tileH * 0.35); // default
            for (let ty = 0; ty < tileH; ty++) {
                if (rowLum[ty] < globalMaxLum * 0.65) { horizonY = ty; break; }
            }

            // ── Detect underground: dark region below a mid-point ──
            const undergroundStartY = Math.min(tileH - 1, horizonY + Math.floor((tileH - horizonY) * 0.5));

            // ── Build the world ──
            saveHistory();
            let placed = 0;

            // Set sky atmosphere based on dominant sky color
            if (horizonY > 0) {
                const skyRow = tileColors[0];
                const avgSkyR = skyRow.reduce((s,t) => s+(t.r||0), 0) / skyRow.length;
                const avgSkyG = skyRow.reduce((s,t) => s+(t.g||0), 0) / skyRow.length;
                const avgSkyB = skyRow.reduce((s,t) => s+(t.b||0), 0) / skyRow.length;
                // Pick an atmosphere background based on sky color
                const isDusk  = avgSkyR > 180 && avgSkyG < 120;
                const isNight = avgSkyR < 80 && avgSkyG < 80 && avgSkyB < 100;
                const atmNames = backgroundLibrary.filter(b => b.file).map(b => b.name);
                let atmSearch = isNight ? 'night' : isDusk ? 'sunset' : 'sky';
                const atmMatch = backgroundLibrary.find(b => b.name && b.name.toLowerCase().includes(atmSearch) && b.file);
                if (atmMatch) setBackground(atmMatch.file);
            }

            for (let ty = 0; ty < tileH; ty++) {
                for (let tx = 0; tx < tileW; tx++) {
                    const tc = tileColors[ty][tx];
                    if (tc.empty) continue;
                    const wx = startX + tx, wy = startY + ty;
                    if (wx >= GRID_X || wy >= GRID_Y) continue;
                    if (!replace && (fgData[wx][wy] || bgData[wx][wy])) continue;

                    const normY = ty / tileH; // 0 = top, 1 = bottom
                    const isSkyBand    = ty < horizonY;
                    const isSurface    = ty >= horizonY && ty < horizonY + 3;
                    const isMidground  = ty >= horizonY + 3 && ty < undergroundStartY;
                    const isUnderground = ty >= undergroundStartY;
                    const isWater = tc.b > tc.r * 1.3 && tc.b > tc.g * 1.1 && tc.lum > 40;

                    // ── SKY BAND: no fg block, optional light bg wall for clouds ──
                    if (isSkyBand) {
                        // Very light sky areas = open sky; slightly textured = cloud/fog wall
                        if (tc.lum > 200 && tc.sat < 0.15) {
                            // Open sky — nothing
                        } else if (depth >= 2 && tc.lum > 150) {
                            // Subtle sky wall
                            const bgMatch = findClosestBlock(tc.r, tc.g, tc.b, wallPalette);
                            if (bgMatch) {
                                const blk = bgMatch.block;
                                bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                        }
                        continue;
                    }

                    // ── WATER detection ──
                    if (isWater && depth >= 2 && waterPalette.length > 0) {
                        const wMatch = findClosestBlock(tc.r, tc.g, tc.b, waterPalette);
                        if (wMatch) {
                            const blk = wMatch.block;
                            fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                            placed++;
                            continue;
                        }
                    }

                    // ── SURFACE LAYER: solid fg blocks matching terrain color ──
                    if (isSurface) {
                        const fgMatch = findClosestBlock(tc.r, tc.g, tc.b, solidPalette);
                        if (fgMatch) {
                            const blk = fgMatch.block;
                            fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                            placed++;
                        }
                        if (depth >= 2 && wallPalette.length > 0) {
                            const bgMatch = findClosestBlock(tc.r * 0.7, tc.g * 0.7, tc.b * 0.7, wallPalette);
                            if (bgMatch) {
                                const blk = bgMatch.block;
                                bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                        }
                        continue;
                    }

                    // ── MIDGROUND: blend fg and bg based on luminance ──
                    if (isMidground) {
                        // Bright areas = open space with walls behind; dark = solid blocks
                        if (tc.lum > 140) {
                            // Open midground with wall
                            if (depth >= 2 && wallPalette.length > 0) {
                                const bgMatch = findClosestBlock(tc.r, tc.g, tc.b, wallPalette);
                                if (bgMatch) {
                                    const blk = bgMatch.block;
                                    bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                    placed++;
                                }
                            }
                            // Depth 3: add props in open midground areas
                            if (depth >= 3 && propPalette.length > 0 && Math.random() < 0.08) {
                                const propMatch = findClosestBlock(tc.r, tc.g, tc.b, propPalette);
                                if (propMatch) {
                                    const blk = propMatch.block;
                                    fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                    placed++;
                                }
                            }
                        } else {
                            // Dense midground — solid block
                            const fgMatch = findClosestBlock(tc.r, tc.g, tc.b, solidPalette);
                            if (fgMatch) {
                                const blk = fgMatch.block;
                                fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                            if (depth >= 2 && wallPalette.length > 0) {
                                // Slightly darker tinted wall behind solid fg
                                const bgMatch = findClosestBlock(Math.round(tc.r*0.6), Math.round(tc.g*0.6), Math.round(tc.b*0.6), wallPalette);
                                if (bgMatch) {
                                    const blk = bgMatch.block;
                                    bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                    placed++;
                                }
                            }
                        }
                        continue;
                    }

                    // ── UNDERGROUND: darker, always has bg wall, fg for very dark areas ──
                    if (isUnderground) {
                        const darkR = Math.round(tc.r * 0.5), darkG = Math.round(tc.g * 0.5), darkB = Math.round(tc.b * 0.5);
                        if (depth >= 2 && wallPalette.length > 0) {
                            const bgMatch = findClosestBlock(darkR, darkG, darkB, wallPalette);
                            if (bgMatch) {
                                const blk = bgMatch.block;
                                bgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                        }
                        if (tc.lum < 100) {
                            // Dark enough = solid underground block
                            const fgMatch = findClosestBlock(tc.r, tc.g, tc.b, solidPalette);
                            if (fgMatch) {
                                const blk = fgMatch.block;
                                fgData[wx][wy] = { name: blk.label, texture: blk.texture || `textures/blocks/${blk.folder}/${blk.file}`, type: blk.type, fileName: blk.file };
                                placed++;
                            }
                        }
                    }
                }
            }

            drawCanvas();
            statusEl.style.color = '#4ade80';
            statusEl.innerText = `✅ World generated! ${placed} blocks placed.`;
            btn.disabled = false; btn.innerText = '🎨 Generate World from Image';
        };
        img.src = i2wGenImgData;
    });
};

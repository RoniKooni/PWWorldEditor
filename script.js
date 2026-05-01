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
let history = [];
let activeAtmosphere = null;

let activeTool = 'move', activeSlot = 0;
let hotbar = Array(10).fill(null);
let bucketBlock = null, shapeBlock = null;
let targetBlockForReplace = null;

let scale = 0.8, posX = 0, posY = 0;
let isPanning = false, isDrawing = false, showGrid = false;
let shapeStart = null;
const imgCache = {};

function autoLoadAssets() {
    if (typeof ASSET_LIST === 'undefined') {
        console.error("ASSET_LIST is missing");
        return;
    }
    blockLibrary = ASSET_LIST.map(asset => {
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
    generateDefaultFloor();
    initUI();
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
}

function undo() {
    if (history.length > 0) {
        const state = history.pop();
        fgData = state.fg; bgData = state.bg; setBackground(state.atm);
    }
}

function getImg(src) {
    if (!src) return null;
    if (!imgCache[src]) { imgCache[src] = new Image(); imgCache[src].src = src; }
    return imgCache[src];
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

function initUI() {
    const invList = document.getElementById('block-list');
    const bucketList = document.getElementById('block-list-bucket');
    const shapesList = document.getElementById('block-list-shapes');
    const bgList = document.getElementById('bg-list');
    const replaceSuggestions = document.getElementById('clear-suggestions');

    [invList, bucketList, shapesList, bgList, replaceSuggestions].forEach(l => { if(l) l.innerHTML = ''; });

    blockLibrary.forEach(b => {
        if (b.fileName.includes('_Alt') || b.fileName.includes('_Glow')) return;

        const frameMatch = b.fileName.match(/_(\d+)\.png$/);
        if (frameMatch && frameMatch[1] !== "0") return;

        const uiDisplayName = b.fileName
            .replace('_0.png', '')
            .replace('.png', '')
            .replace(/_/g, ' ');

        const createBtn = (container, callback) => {
            const btn = document.createElement('div');
            btn.className = 'block-btn';
            btn.innerHTML = `<img src="${b.texture}"><span>${uiDisplayName}</span>`;
            btn.onclick = () => callback(b);
            container.appendChild(btn);
        };

        createBtn(invList, (block) => {
            let targetSlot = hotbar.findIndex((slot, idx) => idx > 0 && slot === null);

            if (targetSlot === -1) {
                targetSlot = activeSlot === 0 ? 1 : activeSlot;
            }

            hotbar[targetSlot] = block;
            const slotElements = document.querySelectorAll('.slot');
            slotElements[targetSlot].innerHTML = `<img src="${block.texture}">`;

            selectSlot(targetSlot);
            closeAll();
        });

        if (bucketList) createBtn(bucketList, (block) => { bucketBlock = block; updateToolState('bucket'); closeAll(); });
        if (shapesList) createBtn(shapesList, (block) => { shapeBlock = block; updateToolState('shapes'); closeAll(); });

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
        replaceSuggestions.appendChild(suggest);
    });

    backgroundLibrary.forEach(bg => {
        const btn = document.createElement('div');
        btn.className = 'block-btn';
        const iconSrc = bg.file ? `textures/orbs/${bg.file}` : bg.icon;
        btn.innerHTML = `<img src="${iconSrc}"><span>${bg.name}</span>`;
        btn.onclick = () => { saveHistory(); setBackground(bg.file); closeAll(); };
        bgList.appendChild(btn);
    });
}

function filterList(listId, term) {
    const list = document.getElementById(listId);
    const btns = list.querySelectorAll('.block-btn');
    btns.forEach(b => {
        const match = b.innerText.toLowerCase().includes(term.toLowerCase());
        b.style.display = match ? 'flex' : 'none';
    });
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

document.getElementById('bucket-btn').onclick = () => {
    if (activeTool === 'bucket') openMenu('bucket-popup');
    else updateToolState('bucket');
};
document.getElementById('shapes-btn').onclick = () => {
    if (activeTool === 'shapes') openMenu('shapes-popup');
    else updateToolState('shapes');
};

document.getElementById('inv-search').oninput = (e) => filterList('block-list', e.target.value);
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
        fgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
        bgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
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
        if (b.type === 'wall') bgData[x][y] = JSON.parse(JSON.stringify(b));
        else fgData[x][y] = JSON.parse(JSON.stringify(b));
    }
    else if (e.buttons === 2) {
        fgData[x][y] = null;
        bgData[x][y] = null;
    }
}

function floodFill(x, y, block) {
    const layer = (block && block.type === 'wall') ? bgData : fgData;
    const target = layer[x][y]?.name || null;
    if(block && target === block.name) return;
    const stack = [[x, y]];
    while(stack.length) {
        const [cx, cy] = stack.pop();
        if(cx<0 || cx>=GRID_X || cy<0 || cy>=GRID_Y || (layer[cx][cy]?.name || null) !== target) continue;
        layer[cx][cy] = block ? JSON.parse(JSON.stringify(block)) : null;
        stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
    }
}

function drawShape(x1, y1, x2, y2) {
    const type = document.getElementById('shape-type').value;
    const fill = document.getElementById('shape-fill').checked;
    const layer = shapeBlock.type === 'wall' ? bgData : fgData;
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
            if(inside) layer[x][y] = JSON.parse(JSON.stringify(shapeBlock));
        }
    }
}

function render(time) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const glowAlpha = (Math.sin(time * 0.002) + 1) / 2;

    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            [bgData[x][y], fgData[x][y]].forEach(block => {
                if (!block) return;

                const baseTex = getBlockTexture(x, y, block);
                if (!baseTex) return;

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
            });
        }
    }

    if (showGrid) {
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        for (let i = 0; i <= GRID_X; i++) {
            ctx.beginPath(); ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, canvas.height); ctx.stroke();
        }
        for (let i = 0; i <= GRID_Y; i++) {
            ctx.beginPath(); ctx.moveTo(0, i * TILE); ctx.lineTo(canvas.width, i * TILE); ctx.stroke();
        }
    }

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
// MODE 1: PIXEL BLOCKS — shaded pixel art
// Uses Pixel Blocks on FG only.
// Shading: dark pixels in the image get darker pixel block variants.
// How: for each pixel, compute darkness 0-1 from absolute luminance,
// then search for the closest block to (color * darkenMultiplier).
// 4 tiers: highlight / midtone / shadow / deep shadow (skipped = empty).
// ─────────────────────────────────────────────
function runPixelBlocksMode(pixelData, outW, outH, startX, startY, statusEl) {
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

        statusEl.innerText = `⚡ Placing dithered pixel blocks with ${palette.length} colors...`;
        saveHistory();

        // ── Copy pixel data into float error-diffusion buffer ──
        // We work on R, G, B channels separately with accumulated error.
        // This is Floyd-Steinberg dithering — it spreads the color quantisation
        // error to neighbouring pixels so the overall colour average is preserved,
        // giving the mixed/painterly look seen in the reference image.
        const buf = new Float32Array(outW * outH * 3);
        for (let i = 0; i < outW * outH; i++) {
            const pi = i * 4;
            buf[i*3+0] = pixelData[pi+0];
            buf[i*3+1] = pixelData[pi+1];
            buf[i*3+2] = pixelData[pi+2];
        }

        const colorCache = {};
        function quantize(r, g, b) {
            // clamp
            r = Math.max(0, Math.min(255, Math.round(r)));
            g = Math.max(0, Math.min(255, Math.round(g)));
            b = Math.max(0, Math.min(255, Math.round(b)));
            const key = `${r>>1},${g>>1},${b>>1}`;
            if (colorCache[key]) return colorCache[key];
            const best = findClosestBlock(r, g, b, palette);
            colorCache[key] = best;
            return best;
        }

        let placed = 0;
        for (let ty = 0; ty < outH; ty++) {
            for (let tx = 0; tx < outW; tx++) {
                const pi = (ty * outW + tx) * 4;
                if (pixelData[pi+3] < 64) continue;

                const idx = ty * outW + tx;
                const r = buf[idx*3+0];
                const g = buf[idx*3+1];
                const b = buf[idx*3+2];

                // Find closest palette block to current (error-adjusted) color
                const match = quantize(r, g, b);
                if (!match) continue;

                // Quantisation error = what we wanted minus what we got
                const er = r - match.r;
                const eg = g - match.g;
                const eb = b - match.b;

                // Floyd-Steinberg error diffusion:
                //         X    7/16
                //   3/16  5/16  1/16
                const spread = (nx, ny, fr) => {
                    if (nx < 0 || nx >= outW || ny >= outH) return;
                    const ni = ny * outW + nx;
                    buf[ni*3+0] += er * fr;
                    buf[ni*3+1] += eg * fr;
                    buf[ni*3+2] += eb * fr;
                };
                spread(tx+1, ty,   7/16);
                spread(tx-1, ty+1, 3/16);
                spread(tx,   ty+1, 5/16);
                spread(tx+1, ty+1, 1/16);

                const wx = startX + tx, wy = startY + ty;
                if (wx < 0 || wx >= GRID_X || wy < 0 || wy >= GRID_Y) continue;

                fgData[wx][wy] = JSON.parse(JSON.stringify(match.block));
                placed++;
            }
        }
        statusEl.innerText = `✅ Done! ${placed} blocks placed with dithered shading.`;
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
                if (block.type === 'wall') bgData[wx][wy] = JSON.parse(JSON.stringify(block));
                else fgData[wx][wy] = JSON.parse(JSON.stringify(block));
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
// FEATURE: Block Counter
// ============================================================
document.getElementById('block-counter-btn').onclick = () => openMenu('block-counter-popup');

function runBlockCount() {
    const layer = document.getElementById('bc-layer').value;
    const stackSize = Math.max(1, parseInt(document.getElementById('bc-stack-size').value) || 200);

    // Tally all blocks
    const counts = {}; // name → { block, count }

    const tally = (data) => {
        for (let x = 0; x < GRID_X; x++) {
            for (let y = 0; y < GRID_Y; y++) {
                const b = data[x][y];
                if (!b) continue;
                const key = b.name;
                if (!counts[key]) counts[key] = { block: b, count: 0 };
                counts[key].count++;
            }
        }
    };

    if (layer === 'both' || layer === 'fg') tally(fgData);
    if (layer === 'both' || layer === 'bg') tally(bgData);

    const entries = Object.values(counts).sort((a, b) => b.count - a.count);
    const total = entries.reduce((s, e) => s + e.count, 0);
    const unique = entries.length;
    const totalStacks = entries.reduce((s, e) => s + Math.ceil(e.count / stackSize), 0);

    // Summary bar
    document.getElementById('bc-total').innerText = total.toLocaleString();
    document.getElementById('bc-unique').innerText = unique;
    document.getElementById('bc-stacks').innerText = totalStacks.toLocaleString();
    document.getElementById('bc-summary').style.display = 'block';
    document.getElementById('bc-search').style.display = 'block';

    // Render list
    renderBlockCountList(entries, stackSize);

    // Store for search
    document.getElementById('bc-search').dataset.entries = JSON.stringify(
        entries.map(e => ({ name: e.block.name, texture: e.block.texture, count: e.count }))
    );
    document.getElementById('bc-search').value = '';
}

function renderBlockCountList(entries, stackSize) {
    const list = document.getElementById('bc-list');
    if (entries.length === 0) {
        list.innerHTML = '<div style="color:#555;text-align:center;padding:20px;">No blocks found.</div>';
        return;
    }

    list.innerHTML = entries.map((e, i) => {
        const stacks = Math.floor(e.count / stackSize);
        const remainder = e.count % stackSize;
        const stackStr = stacks > 0
            ? `<span style="color:#c97aff;">${stacks} stack${stacks !== 1 ? 's' : ''}</span>${remainder > 0 ? ` + <span style="color:#aaa;">${remainder}</span>` : ''}`
            : `<span style="color:#aaa;">${remainder}</span>`;

        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:4px;background:${i%2===0?'#1a1a1a':'#151515'};margin-bottom:2px;">
            <img src="${e.block.texture}" style="width:28px;height:28px;image-rendering:pixelated;border-radius:3px;flex-shrink:0;">
            <div style="flex:1;min-width:0;">
                <div style="font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.block.name}</div>
                <div style="font-size:11px;margin-top:1px;">${stackStr}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
                <div style="font-size:13px;color:#3abdc2;font-weight:bold;">${e.count.toLocaleString()}</div>
                <div style="font-size:10px;color:#555;">blocks</div>
            </div>
        </div>`;
    }).join('');
}

document.getElementById('bc-count-btn').onclick = runBlockCount;

document.getElementById('bc-stack-size').oninput = () => {
    const stackSize = Math.max(1, parseInt(document.getElementById('bc-stack-size').value) || 200);
    const raw = document.getElementById('bc-search').dataset.entries;
    if (!raw) return;
    const entries = JSON.parse(raw).map(e => ({ block: { name: e.name, texture: e.texture }, count: e.count }));
    const totalStacks = entries.reduce((s, e) => s + Math.ceil(e.count / stackSize), 0);
    document.getElementById('bc-stacks').innerText = totalStacks.toLocaleString();
    const term = document.getElementById('bc-search').value.toLowerCase();
    const filtered = term ? entries.filter(e => e.block.name.toLowerCase().includes(term)) : entries;
    renderBlockCountList(filtered, stackSize);
};

document.getElementById('bc-search').oninput = (ev) => {
    const term = ev.target.value.toLowerCase();
    const stackSize = Math.max(1, parseInt(document.getElementById('bc-stack-size').value) || 200);
    const raw = ev.target.dataset.entries;
    if (!raw) return;
    const entries = JSON.parse(raw).map(e => ({ block: { name: e.name, texture: e.texture }, count: e.count }));
    const filtered = term ? entries.filter(e => e.block.name.toLowerCase().includes(term)) : entries;
    renderBlockCountList(filtered, stackSize);
};

document.getElementById('bc-copy-btn').onclick = () => {
    const raw = document.getElementById('bc-search').dataset.entries;
    if (!raw) { alert('Click "Count Blocks" first!'); return; }
    const stackSize = Math.max(1, parseInt(document.getElementById('bc-stack-size').value) || 200);
    const entries = JSON.parse(raw);
    const total = entries.reduce((s, e) => s + e.count, 0);
    const lines = [
        `Block Counter — Total: ${total.toLocaleString()} blocks (${entries.length} types)`,
        `Stack size: ${stackSize}`,
        ``,
        ...entries.map(e => {
            const stacks = Math.floor(e.count / stackSize);
            const rem = e.count % stackSize;
            const stackStr = stacks > 0 ? `${stacks}s${rem > 0 ? ` +${rem}` : ''}` : `${rem}`;
            return `${e.name}: ${e.count} (${stackStr})`;
        })
    ];
    navigator.clipboard.writeText(lines.join('\n'))
        .then(() => { document.getElementById('bc-copy-btn').innerText = '✅ Copied!'; setTimeout(() => document.getElementById('bc-copy-btn').innerText = '📋 Copy List', 2000); })
        .catch(() => alert('Copy failed — try manually.'));
};

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
// FEATURE: Image to Blocks Converter
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
        '🟦 Pixel blocks only (cleanest)',
        '🟧 + All foreground blocks',
        '🔶 + Background wall tiles',
        '🌈 Everything inc. props & water'
    ];
    document.getElementById('i2b-variety-label').innerText = labels[parseInt(e.target.value) - 1];
};

document.getElementById('img2blocks-convert-btn').onclick = () => {
    if (!i2bImgData) { alert('Please upload an image first.'); return; }

    const startX = parseInt(document.getElementById('i2b-x').value);
    const startY = parseInt(document.getElementById('i2b-y').value);
    const tileW = parseInt(document.getElementById('i2b-w').value);
    const tileH = parseInt(document.getElementById('i2b-h').value);
    const layerChoice = document.getElementById('i2b-layer').value;
    const variety = parseInt(document.getElementById('i2b-variety').value) || 1;
    const doFlip = document.getElementById('i2b-flip').checked;
    const doShading = document.getElementById('i2b-shading').checked;

    // Effective output dimensions after optional 90° rotation
    const outW = doFlip ? tileH : tileW;
    const outH = doFlip ? tileW : tileH;

    const statusEl = document.getElementById('i2b-status');
    statusEl.innerText = '⏳ Sampling all block colors... (this may take a moment)';

    // Sample image pixels
    const tempImg = new Image();
    tempImg.onload = () => {
        const offscreen = document.createElement('canvas');
        offscreen.width = outW;
        offscreen.height = outH;
        const offCtx = offscreen.getContext('2d');

        if (doFlip) {
            // Rotate 90° clockwise: translate to (outW, 0), rotate, then draw
            offCtx.save();
            offCtx.translate(outW, 0);
            offCtx.rotate(Math.PI / 2);
            offCtx.drawImage(tempImg, 0, 0, outH, outW);
            offCtx.restore();
        } else {
            offCtx.drawImage(tempImg, 0, 0, outW, outH);
        }
        const pixelData = offCtx.getImageData(0, 0, outW, outH).data;

        // VARIETY LEVELS:
        // 1 = Pixel Blocks only (flat solid color, cleanest look)
        // 2 = + basic solid color blocks (colored blocks, bricks, jewels)
        // 3 = + textured blocks (soil, stone, wood, metal, etc.)
        // 4 = everything (props, water, all types)
        // Filter helpers
        const isPixelBlock = (b) => b.fileName.startsWith('Pixel Block');
        const isBlockFolder = (b) => b.folder === 'block';
        const isPropFolder  = (b) => b.folder === 'prop';
        const isWallFolder  = (b) => b.folder === 'background';
        const isWaterFolder = (b) => b.folder === 'water';

        // Build candidate list based on variety
        // Level 1: only Pixel Blocks (43 flat solid colors — best color accuracy)
        // Level 2: Pixel Blocks + all foreground blocks (soil, stone, wood etc.)
        // Level 3: + background wall tiles
        // Level 4: everything including props and water
        const candidateBlocks = blockLibrary.filter(b => {
            if (b.fileName.includes('_Alt')) return false;
            if (b.fileName.includes('_Glow')) return false;
            const frameMatch = b.fileName.match(/_(\d+)\.png$/);
            if (frameMatch && frameMatch[1] !== '0') return false;

            if (variety === 1) return isPixelBlock(b);
            if (variety === 2) return isPixelBlock(b) || isBlockFolder(b);
            if (variety === 3) return isPixelBlock(b) || isBlockFolder(b) || isWallFolder(b);
            return true; // variety 4: everything
        });

        if (candidateBlocks.length === 0) {
            statusEl.innerText = 'Error: No blocks found for the selected layer!';
            return;
        }

        statusEl.innerText = `⏳ Variety level ${variety}: sampling ${candidateBlocks.length} blocks...`;

        // Sample average color of each block by drawing to a small canvas
        // Also capture luminance for shading system
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
                        // Average all 16 pixels, skip transparent ones
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

        // Sample in batches to avoid freezing the browser
        const BATCH = 50;
        const results = [];
        let idx = 0;

        function processBatch() {
            const slice = candidateBlocks.slice(idx, idx + BATCH);
            idx += BATCH;
            Promise.all(slice.map(sampleBlockColor)).then(batch => {
                batch.forEach(r => { if (r) results.push(r); });
                if (idx < candidateBlocks.length) {
                    statusEl.innerText = `⏳ Sampling blocks... ${Math.min(idx, candidateBlocks.length)}/${candidateBlocks.length}`;
                    setTimeout(processBatch, 0);
                } else {
                    doConvert(results);
                }
            });
        }

        function doConvert(palette) {
            if (palette.length === 0) {
                statusEl.innerText = 'Error: Could not sample any block colors.';
                return;
            }

            statusEl.innerText = `⚡ Converting with ${palette.length} block colors...`;

            saveHistory();
            const layer = layerChoice === 'bg' ? bgData : fgData;
            let placed = 0;

            // ── Pixel-art shading setup ──────────────────────────────────────────
            // When variety=1 and shading is on, group pixel blocks by hue family,
            // then for each tile pick the family member whose luminance best matches
            // the local pixel brightness with Bayer dithering for ordered-dither detail.
            const useShading = doShading && variety === 1 && palette.length > 1;

            // Build hue-family groups for shading
            let shadingFamilies = null;
            if (useShading) {
                const toHSL = (r,g,b) => {
                    r/=255; g/=255; b/=255;
                    const max=Math.max(r,g,b), min=Math.min(r,g,b), l=(max+min)/2;
                    if (max===min) return {h:0,s:0,l};
                    const d=max-min, s=d/(l>0.5?2-max-min:max+min);
                    let h=0;
                    if(max===r) h=(g-b)/d+(g<b?6:0);
                    else if(max===g) h=(b-r)/d+2;
                    else h=(r-g)/d+4;
                    return {h:h*60,s,l};
                };
                const families = {};
                for (const entry of palette) {
                    const {h,s,l} = toHSL(entry.r, entry.g, entry.b);
                    const bucket = s < 0.12 ? 'grey' : `h${Math.round(h/30)}`;
                    if (!families[bucket]) families[bucket] = [];
                    families[bucket].push({...entry, hsl:{h,s,l}});
                }
                for (const fam of Object.values(families)) {
                    fam.sort((a,b) => a.lum - b.lum);
                }
                shadingFamilies = families;
            }

            // Bayer 4×4 ordered dither matrix, scaled to ±30 luminance offset
            const bayer4 = [
                [ 0,  8,  2, 10],
                [12,  4, 14,  6],
                [ 3, 11,  1,  9],
                [15,  7, 13,  5]
            ];
            const bayerDither = (tx, ty) => (bayer4[ty % 4][tx % 4] / 15 - 0.5) * 60;

            // Color matching cache (quantize to nearest 8 to reduce lookups)
            const colorCache = {};

            for (let ty = 0; ty < outH; ty++) {
                for (let tx = 0; tx < outW; tx++) {
                    const pi = (ty * outW + tx) * 4;
                    const r = pixelData[pi];
                    const g = pixelData[pi+1];
                    const b = pixelData[pi+2];
                    const a = pixelData[pi+3];
                    if (a < 64) continue;

                    let best;

                    if (useShading && shadingFamilies) {
                        // Step 1: find nearest palette entry by color (hue/chroma match)
                        const key = `${r>>3},${g>>3},${b>>3}`;
                        let baseEntry = colorCache[key];
                        if (!baseEntry) {
                            let bestDist = Infinity;
                            for (const entry of palette) {
                                const dr = r-entry.r, dg = g-entry.g, db = b-entry.b;
                                const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                                if (dist < bestDist) { bestDist = dist; baseEntry = entry; }
                            }
                            colorCache[key] = baseEntry;
                        }
                        // Step 2: apply Bayer dither to pixel luminance
                        const pixLum = 0.299*r + 0.587*g + 0.114*b;
                        const ditheredLum = pixLum + bayerDither(tx, ty);
                        // Step 3: find which family the matched block belongs to
                        let chosenFamily = null;
                        for (const fam of Object.values(shadingFamilies)) {
                            if (fam.some(e => e.block === baseEntry.block)) {
                                chosenFamily = fam; break;
                            }
                        }
                        if (chosenFamily && chosenFamily.length > 1) {
                            let bestLumDiff = Infinity;
                            for (const entry of chosenFamily) {
                                const diff = Math.abs(entry.lum - ditheredLum);
                                if (diff < bestLumDiff) { bestLumDiff = diff; best = entry.block; }
                            }
                        } else {
                            best = baseEntry.block;
                        }
                    } else {
                        // Standard color matching (no shading)
                        const key = `${r>>3},${g>>3},${b>>3}`;
                        best = colorCache[key];
                        if (!best) {
                            let bestDist = Infinity;
                            for (const entry of palette) {
                                const dr = r-entry.r, dg = g-entry.g, db = b-entry.b;
                                const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
                                if (dist < bestDist) { bestDist = dist; best = entry.block; }
                            }
                            colorCache[key] = best;
                        }
                    }

                    const worldX = startX + tx;
                    const worldY = startY + ty;
                    if (worldX >= 0 && worldX < GRID_X && worldY >= 0 && worldY < GRID_Y && best) {
                        const blockCopy = JSON.parse(JSON.stringify(best));
                        layer[worldX][worldY] = blockCopy;
                        placed++;
                    }
                }
            }
            const shadingNote = useShading ? ' with pixel-art shading ✨' : '';
            statusEl.innerText = `✅ Done! Placed ${placed} blocks${shadingNote} using ${palette.length} colors.`;
        }

        processBatch();
    };
    tempImg.src = i2bImgData;
};

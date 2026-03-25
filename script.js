const blockLibrary = [
    { name: 'Water', type: 'water', texture: 'textures/blocks/Water.png' },
    { name: 'Prop Bed', type: 'prop', texture: 'textures/blocks/Bed.png' },
    { name: 'Soil', type: 'block', texture: 'textures/blocks/SoilBlock.png' },
    { name: 'Golden Skull', type: 'block', texture: 'textures/blocks/SkullBlockGolden.png' },
    { name: 'Cave Wall', type: 'wall', texture: 'textures/blocks/CaveWall.png' },
    { name: 'Bedrock', type: 'block', texture: 'textures/blocks/Bedrock.png' },
    { name: 'Granite', type: 'block', texture: 'textures/blocks/Granite.png' },
    { name: 'Soil Dark', type: 'block', texture: 'textures/blocks/SoilBlockDark.png' },
    { name: 'Soil Frosted', type: 'block', texture: 'textures/blocks/SoilBlockFrosted.png' }
];

const backgroundLibrary = [
    { name: 'None', file: null },
    { name: 'Alien', file: 'Alien.png' }, { name: 'Candy', file: 'Candy.png' },
    { name: 'Cemetery', file: 'Cemetery.png' }, { name: 'City', file: 'City.png' },
    { name: 'Forest', file: 'Forest.png' }, { name: 'Night', file: 'Night.png' },
    { name: 'Sand', file: 'Sand.png' }, { name: 'Star', file: 'Star.png' },
    { name: 'Summer Sky', file: 'SummerSky.png' }, { name: 'Winter', file: 'Winter.png' }
];

const canvas = document.getElementById('worldCanvas');
const ctx = canvas.getContext('2d');
const viewport = document.getElementById('viewport');
const GRID_X = 80, GRID_Y = 60, TILE = 32;

let fgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let bgData = Array(GRID_X).fill().map(() => Array(GRID_Y).fill(null));
let history = [];
let activeAtmosphere = null;

let activeTool = 'fist', activeSlot = 0;
let hotbar = Array(10).fill(null);
let bucketBlock = null, shapeBlock = null, shapeType = 'rect', shapeFill = true;
let targetBlockForReplace = null;

let scale = 0.8, posX = 0, posY = 0;
let isPanning = false, isDrawing = false, isSelecting = false, showGrid = true;
let selectionArea = null, shapeStart = null;
const imgCache = {};

function saveHistory() {
    if (history.length > 50) history.shift();
    history.push({ fg: JSON.parse(JSON.stringify(fgData)), bg: JSON.parse(JSON.stringify(bgData)), atm: activeAtmosphere });
}

function undo() {
    if (history.length > 0) {
        const state = history.pop();
        fgData = state.fg; bgData = state.bg;
        if (state.atm !== undefined) setBackground(state.atm);
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
}

function updateTransform() { canvas.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`; }

window.oncontextmenu = (e) => e.preventDefault();

viewport.onmousedown = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);

    // 1. Middle Click Panning
    if (e.button === 1) { isPanning = true; return; }

    // 2. Fist Logic (Slot 0)
    if (activeSlot === 0) {
        if (e.ctrlKey && e.button === 0) {
            selectionArea = { x1: x, y1: y, x2: x, y2: y };
            isSelecting = true;
        } else if (e.button === 0) {
            // Deselect when clicking anywhere with Fist without CTRL
            selectionArea = null;
            isPanning = true; // Still allow left-click panning with Fist
        }
        return;
    }

    // 3. Other Tools
    selectionArea = null; // Placing blocks or using tools clears selection
    if (activeTool === 'bucket' && bucketBlock) {
        saveHistory(); floodFill(x, y, bucketBlock);
    } else if (activeTool === 'shapes' && shapeBlock) {
        shapeStart = { x1: x, y1: y, x2: x, y2: y }; isDrawing = true;
    } else {
        saveHistory(); isDrawing = true; handlePlace(e);
    }
};

window.onmousemove = (e) => {
    if (isPanning) { posX += e.movementX; posY += e.movementY; updateTransform(); }
    else {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
        const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);
        if (isSelecting) { selectionArea.x2 = x; selectionArea.y2 = y; }
        else if (isDrawing) {
            if (activeTool === 'shapes') { shapeStart.x2 = x; shapeStart.y2 = y; }
            else handlePlace(e);
        }
    }
};

window.onmouseup = () => {
    if (activeTool === 'shapes' && shapeStart) { saveHistory(); drawFinalShape(); shapeStart = null; }
    isPanning = false; isDrawing = false; isSelecting = false;
};

viewport.onwheel = (e) => {
    e.preventDefault();
    scale = Math.min(Math.max(scale + (e.deltaY < 0 ? 0.1 : -0.1), 0.2), 4);
    updateTransform();
};

function handlePlace(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / scale) / TILE);
    const y = Math.floor(((e.clientY - rect.top) / scale) / TILE);
    if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y) return;

    if (e.buttons === 1) {
        const block = hotbar[activeSlot];
        if (!block) return;
        if (block.type === 'wall') bgData[x][y] = JSON.parse(JSON.stringify(block));
        else fgData[x][y] = JSON.parse(JSON.stringify(block));
    } else if (e.buttons === 2) {
        fgData[x][y] = null; bgData[x][y] = null;
    }
}

function floodFill(startX, startY, block) {
    if (startX < 0 || startX >= GRID_X || startY < 0 || startY >= GRID_Y) return;
    const isWall = block.type === 'wall';
    const targetLayer = isWall ? bgData : fgData;
    const targetBlock = targetLayer[startX][startY];
    const targetName = targetBlock ? targetBlock.name : null;
    if (targetName === block.name) return;

    const stack = [[startX, startY]];
    const visited = new Set();
    while(stack.length > 0) {
        const [x, y] = stack.pop();
        const key = `${x},${y}`;
        if (x < 0 || x >= GRID_X || y < 0 || y >= GRID_Y || visited.has(key)) continue;
        const currentBlock = targetLayer[x][y];
        const currentName = currentBlock ? currentBlock.name : null;
        if (currentName === targetName) {
            visited.add(key);
            targetLayer[x][y] = JSON.parse(JSON.stringify(block));
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
    }
}

function drawFinalShape() {
    const x1 = Math.min(shapeStart.x1, shapeStart.x2), x2 = Math.max(shapeStart.x1, shapeStart.x2);
    const y1 = Math.min(shapeStart.y1, shapeStart.y2), y2 = Math.max(shapeStart.y1, shapeStart.y2);
    const w = x2 - x1, h = y2 - y1;
    for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
            let place = false;
            const px = (x - x1) / (w || 1), py = (y - y1) / (h || 1);
            if (shapeType === 'rect') place = shapeFill ? true : (x === x1 || x === x2 || y === y1 || y === y2);
            else if (shapeType === 'circle') {
                const dx = px - 0.5, dy = py - 0.5;
                const d = dx * dx + dy * dy;
                place = shapeFill ? d <= 0.25 : (d <= 0.25 && d >= 0.18);
            } else if (shapeType === 'triangle') {
                const inside = py >= (2 * Math.abs(px - 0.5));
                place = shapeFill ? inside : (inside && (y === y2 || Math.abs(py - 2 * Math.abs(px - 0.5)) < 0.1));
            } else if (shapeType === 'prism') {
                const d = Math.abs(px - 0.5) + Math.abs(py - 0.5);
                place = shapeFill ? d <= 0.5 : (Math.abs(d - 0.5) < 0.1);
            }
            if (place && x>=0 && x<GRID_X && y>=0 && y<GRID_Y) {
                if (shapeBlock.type === 'wall') bgData[x][y] = JSON.parse(JSON.stringify(shapeBlock));
                else fgData[x][y] = JSON.parse(JSON.stringify(shapeBlock));
            }
        }
    }
}

function moveSelection(dx, dy) {
    if (!selectionArea) return;
    saveHistory();
    const x1 = Math.min(selectionArea.x1, selectionArea.x2), x2 = Math.max(selectionArea.x1, selectionArea.x2);
    const y1 = Math.min(selectionArea.y1, selectionArea.y2), y2 = Math.max(selectionArea.y1, selectionArea.y2);
    let tempFG = [], tempBG = [];
    for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
            tempFG.push({ x: x + dx, y: y + dy, data: fgData[x][y] });
            tempBG.push({ x: x + dx, y: y + dy, data: bgData[x][y] });
            fgData[x][y] = null; bgData[x][y] = null;
        }
    }
    tempFG.forEach(item => { if (item.x >= 0 && item.x < GRID_X && item.y >= 0 && item.y < GRID_Y) fgData[item.x][item.y] = item.data; });
    tempBG.forEach(item => { if (item.x >= 0 && item.x < GRID_X && item.y >= 0 && item.y < GRID_Y) bgData[item.x][item.y] = item.data; });
    selectionArea.x1 += dx; selectionArea.x2 += dx; selectionArea.y1 += dy; selectionArea.y2 += dy;
}

window.onkeydown = (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (selectionArea) {
        let dx = 0, dy = 0;
        if (e.key === "ArrowLeft") dx = -1; if (e.key === "ArrowRight") dx = 1;
        if (e.key === "ArrowUp") dy = -1; if (e.key === "ArrowDown") dy = 1;
        if (dx !== 0 || dy !== 0) { e.preventDefault(); moveSelection(dx, dy); }
    }
};

function openMenu(id) { document.getElementById(id).classList.remove('hidden'); document.getElementById('overlay').classList.remove('hidden'); }
function closeAll() { document.querySelectorAll('.menu-popup, #overlay, #clear-suggestions').forEach(el => el.classList.add('hidden')); }
function selectSlot(i) {
    activeSlot = i; activeTool = 'fist';
    document.querySelectorAll('.slot').forEach((s, idx) => s.classList.toggle('active', idx === i));
    document.getElementById('block-name').innerText = i===0 ? "Fist" : (hotbar[i]?.name || "Empty");
}

document.getElementById('inv-toggle').onclick = () => openMenu('inventory-popup');
document.getElementById('bg-ui-btn').onclick = () => openMenu('bg-popup');
document.getElementById('bucket-btn').onclick = () => openMenu('bucket-popup');
document.getElementById('shapes-btn').onclick = () => openMenu('shapes-popup');
document.getElementById('clear-menu-btn').onclick = () => openMenu('clear-popup');
document.getElementById('help-btn').onclick = () => openMenu('help-popup');
document.getElementById('grid-toggle').onclick = () => showGrid = !showGrid;
document.getElementById('overlay').onclick = closeAll;
document.querySelectorAll('.close-btn-fancy').forEach(b => b.onclick = closeAll);

document.getElementById('save-btn').onclick = () => {
    const pkg = { atm: activeAtmosphere, fg: fgData, bg: bgData };
    const blob = new Blob([JSON.stringify(pkg)], { type: "application/json" });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = "world.json"; a.click();
};
document.getElementById('import-btn').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { try { const d = JSON.parse(ev.target.result); fgData = d.fg; bgData = d.bg; setBackground(d.atm); } catch(err){alert("Invalid File");} };
    reader.readAsText(file);
};

document.getElementById('clear-search').oninput = (e) => {
    const term = e.target.value.toLowerCase();
    const sugg = document.getElementById('clear-suggestions');
    sugg.innerHTML = '';
    if(!term) { sugg.classList.add('hidden'); return; }
    const matches = blockLibrary.filter(b => b.name.toLowerCase().includes(term));
    matches.forEach(m => {
        const div = document.createElement('div'); div.className = 'suggestion-item';
        div.innerHTML = `<img src="${m.texture}" style="width:20px"> ${m.name}`;
        div.onclick = () => {
            targetBlockForReplace = m;
            document.getElementById('clear-search').value = m.name;
            document.getElementById('replace-desc').innerText = `Replace all ${m.name} with held block?`;
            document.getElementById('replace-controls').classList.remove('hidden');
            sugg.classList.add('hidden');
        };
        sugg.appendChild(div);
    });
    sugg.classList.toggle('hidden', matches.length === 0);
};

document.getElementById('confirm-replace').onclick = () => {
    if (!targetBlockForReplace) return;
    saveHistory();
    const held = hotbar[activeSlot];
    for(let x=0; x<GRID_X; x++) for(let y=0; y<GRID_Y; y++) {
        if(fgData[x][y]?.name === targetBlockForReplace.name) fgData[x][y] = held ? JSON.parse(JSON.stringify(held)) : null;
        if(bgData[x][y]?.name === targetBlockForReplace.name) bgData[x][y] = held ? JSON.parse(JSON.stringify(held)) : null;
    }
    closeAll();
};

document.getElementById('delete-all-trigger').onclick = () => { if(confirm("Wipe everything?")){ saveHistory(); fgData=Array(GRID_X).fill().map(()=>Array(GRID_Y).fill(null)); bgData=Array(GRID_X).fill().map(()=>Array(GRID_Y).fill(null)); setBackground(null); closeAll(); } };
document.getElementById('shape-type').onchange = (e) => shapeType = e.target.value;
document.getElementById('shape-fill').onchange = (e) => shapeFill = e.target.checked;

blockLibrary.forEach(b => {
    const createBtn = (container, callback) => {
        const btn = document.createElement('div'); btn.className = 'block-btn';
        btn.innerHTML = `<img src="${b.texture}"><span>${b.name}</span>`;
        btn.onclick = () => { callback(b); closeAll(); };
        container.appendChild(btn);
    };
    createBtn(document.getElementById('block-list'), (b) => { for(let i=1; i<10; i++) if(!hotbar[i]){ hotbar[i]=b; document.querySelectorAll('.slot')[i].innerHTML=`<img src="${b.texture}">`; selectSlot(i); break; } });
    createBtn(document.getElementById('block-list-bucket'), (b) => { bucketBlock = b; activeTool = 'bucket'; document.getElementById('block-name').innerText = "Bucket ("+b.name+")"; });
    createBtn(document.getElementById('block-list-shapes'), (b) => { shapeBlock = b; activeTool = 'shapes'; document.getElementById('block-name').innerText = "Shapes ("+b.name+")"; });
});

backgroundLibrary.forEach(bg => {
    const btn = document.createElement('div'); btn.className = 'block-btn';
    const icon = bg.file ? `<img src="textures/orbs/${bg.file}" style="width:40px;height:40px;">` : `<div class="bg-none-icon">X</div>`;
    btn.innerHTML = `${icon}<span>${bg.name}</span>`;
    btn.onclick = () => { saveHistory(); setBackground(bg.file); closeAll(); };
    document.getElementById('bg-list').appendChild(btn);
});

function renderLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for(let x=0; x<GRID_X; x++) {
        for(let y=0; y<GRID_Y; y++){
            const bgB = bgData[x][y]; if(bgB) ctx.drawImage(getImg(bgB.texture), x*TILE, y*TILE, TILE, TILE);
            const fgB = fgData[x][y]; if(fgB) ctx.drawImage(getImg(fgB.texture), x*TILE, y*TILE, TILE, TILE);
        }
    }
    if(showGrid) {
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        for(let x=0; x<=GRID_X; x++) { ctx.beginPath(); ctx.moveTo(x*TILE,0); ctx.lineTo(x*TILE,canvas.height); ctx.stroke(); }
        for(let y=0; y<=GRID_Y; y++) { ctx.beginPath(); ctx.moveTo(0,y*TILE); ctx.lineTo(canvas.width,y*TILE); ctx.stroke(); }
    }
    if(selectionArea) { ctx.strokeStyle = "#3abdc2"; ctx.lineWidth = 2; ctx.strokeRect(Math.min(selectionArea.x1, selectionArea.x2)*TILE, Math.min(selectionArea.y1, selectionArea.y2)*TILE, (Math.abs(selectionArea.x2-selectionArea.x1)+1)*TILE, (Math.abs(selectionArea.y2-selectionArea.y1)+1)*TILE); }
    if(shapeStart) { ctx.strokeStyle = "white"; ctx.lineWidth = 1; ctx.strokeRect(Math.min(shapeStart.x1, shapeStart.x2)*TILE, Math.min(shapeStart.y1, shapeStart.y2)*TILE, (Math.abs(shapeStart.x2-shapeStart.x1)+1)*TILE, (Math.abs(shapeStart.y2-shapeStart.y1)+1)*TILE); }
    requestAnimationFrame(renderLoop);
}

document.querySelectorAll('.slot').forEach(s => s.onclick = () => selectSlot(parseInt(s.dataset.slot)));
updateTransform();
requestAnimationFrame(renderLoop);
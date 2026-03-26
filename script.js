// world size
const GRID_X = 80, GRID_Y = 60, TILE = 32;
const BASE_PATH = 'textures/blocks/';

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
let isPanning = false, isDrawing = false, showGrid = true;
let shapeStart = null;
const imgCache = {};

function autoLoadAssets() {
    if (typeof ASSET_LIST === 'undefined') {
        console.error("ASSET_LIST is missing");
        return;
    }
    blockLibrary = ASSET_LIST.map(asset => ({
        name: asset.label || asset.file.replace('.png', '').replace(/_/g, ' '),
        fileName: asset.file,
        type: asset.folder === 'background' ? 'wall' : (asset.folder === 'water' ? 'water' : (asset.folder === 'prop' ? 'prop' : 'block')),
        texture: `${BASE_PATH}${asset.folder}/${asset.file}`,
        folder: asset.folder
    }));
    initUI();
}

function getBlockTexture(x, y, block) {
    if (!block) return null;
    const altName = block.fileName.replace('.png', '_Alt.png');//alt block check, basically used for soils when they have this grass texture on top
    const isTopExposed = y === 0 || (fgData[x][y-1] === null || fgData[x][y-1]?.type === 'prop');
    const hasAlt = ASSET_LIST.some(a => a.file === altName);
    return (isTopExposed && hasAlt) ? getImg(`${BASE_PATH}${block.folder}/${altName}`) : getImg(block.texture);
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
        if(b.fileName.includes('_Alt')) return;
        const createBtn = (container, callback) => {
            const btn = document.createElement('div');
            btn.className = 'block-btn';
            btn.innerHTML = `<img src="${b.texture}"><span>${b.name}</span>`;
            btn.onclick = () => callback(b);
            container.appendChild(btn);
        };

        createBtn(invList, (block) => {
            for(let i=1; i<10; i++) {
                if(!hotbar[i]) {
                    hotbar[i] = block;
                    document.querySelectorAll('.slot')[i].innerHTML = `<img src="${block.texture}">`;
                    selectSlot(i); break;
                }
            }
            closeAll();
        });

        createBtn(bucketList, (block) => { bucketBlock = block; updateToolState('bucket'); closeAll(); });
        createBtn(shapesList, (block) => { shapeBlock = block; updateToolState('shapes'); closeAll(); });

        const suggest = document.createElement('div');
        suggest.className = 'block-btn';
        suggest.innerHTML = `<img src="${b.texture}"><span>${b.name}</span>`;
        suggest.onclick = () => {
            targetBlockForReplace = b;
            document.getElementById('clear-search').value = b.name;
            document.getElementById('replace-desc').innerText = `Replacing all "${b.name}" with your active hotbar block.`;
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

    const display = document.getElementById('block-name');

    if (tool === 'bucket') {
        const bName = bucketBlock ? bucketBlock.name : "None";
        const bImg = bucketBlock ? `<img src="${bucketBlock.texture}" style="width:14px;height:14px;vertical-align:middle;margin-left:5px;">` : "";
        display.innerHTML = `BUCKET (${bName})${bImg}`;
    } else if (tool === 'shapes') {
        const sName = shapeBlock ? shapeBlock.name : "None";
        const sImg = shapeBlock ? `<img src="${shapeBlock.texture}" style="width:14px;height:14px;vertical-align:middle;margin-left:5px;">` : "";
        display.innerHTML = `SHAPES (${sName})${sImg}`;
    } else if (tool === 'move') {
        display.innerText = "MOVE";
    } else {
        const block = hotbar[activeSlot];
        display.innerText = block ? `BLOCK: ${block.name}` : "EMPTY SLOT";
    }

    if(tool !== 'hotbar') document.querySelectorAll('.slot').forEach(s => s.classList.remove('active'));
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

const bindings = { 'inv-toggle': 'inventory-popup', 'bg-ui-btn': 'bg-popup', 'clear-menu-btn': 'clear-popup', 'help-btn': 'help-popup' };
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

window.onmousemove = (e) => {
    if (isPanning) {
        posX += e.movementX;
        posY += e.movementY;
        updateTransform();
    } else if (isDrawing && activeTool !== 'shapes') {
        handlePlace(e);
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
        if (!b) return;
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

function render() {
    ctx.clearRect(0,0, canvas.width, canvas.height);
    for(let x=0; x<GRID_X; x++) {
        for(let y=0; y<GRID_Y; y++) {
            if(bgData[x][y]) ctx.drawImage(getBlockTexture(x, y, bgData[x][y]), x*TILE, y*TILE, TILE, TILE);
            if(fgData[x][y]) ctx.drawImage(getBlockTexture(x, y, fgData[x][y]), x*TILE, y*TILE, TILE, TILE);
        }
    }
    if(showGrid) {
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        for(let i=0; i<=GRID_X; i++) { ctx.beginPath(); ctx.moveTo(i*TILE,0); ctx.lineTo(i*TILE,canvas.height); ctx.stroke(); }
        for(let i=0; i<=GRID_Y; i++) { ctx.beginPath(); ctx.moveTo(0,i*TILE); ctx.lineTo(canvas.width,i*TILE); ctx.stroke(); }
    }
    requestAnimationFrame(render);
}

window.onkeydown = (e) => { if(e.ctrlKey && e.key === 'z') undo(); };
autoLoadAssets();
document.querySelectorAll('.slot').forEach(s => s.onclick = () => selectSlot(parseInt(s.dataset.slot)));
updateTransform();
render();
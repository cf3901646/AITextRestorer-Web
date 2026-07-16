/* AITextRestorer Web - 核心逻辑 */
let cvReady = false, imgOrig = null, imgOpt = null;
let canvasAligned = null, maskCanvas = null, maskCtx = null;
let maskHistory = [], toolMode = 'draw', brushSize = 22, featherSize = 8;
let zoomScale = 1.0, zoomFitRatio = 1.0, zoomRatio = 1.0;
let isPainting = false, lastPX = 0, lastPY = 0;
let blocks = [], activeBlockIdx = -1, resizingHandle = null;
let dragStartRect = null, dragStartX = 0, dragStartY = 0;
const canvas = document.getElementById('editor-canvas');
const ctx = canvas.getContext('2d');

document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    setupCapsule();
    // 页面DOM加载完成时，立刻主动检查一次OpenCV是否已经就绪
    checkOpenCVStatus();
});

function checkOpenCVStatus() {
    if (cvReady) return;
    if (window.cvReadyState || (typeof cv !== 'undefined' && cv.Mat)) {
        cvReady = true;
        document.getElementById('status-dot').className = 'status-dot ready';
        document.getElementById('status-text').textContent = 'AI 算法引擎就绪';
        setStatus('OpenCV 引擎载入完毕。');
    }
}

document.addEventListener('opencv-ready', () => {
    checkOpenCVStatus();
});

document.addEventListener('opencv-failed', () => {
    document.getElementById('status-dot').className = 'status-dot failed';
    document.getElementById('status-text').textContent = '引擎加载失败（基础功能可用）';
    setStatus('OpenCV 加载失败，板块自动配准不可用，涂抹和导出仍正常工作。');
});

setTimeout(() => {
    checkOpenCVStatus();
    if (!cvReady) document.dispatchEvent(new Event('opencv-failed'));
}, 25000);


function setStatus(m) { document.getElementById('status-msg').textContent = m; }
function showModal(t, b) {
    document.getElementById('modal-title').textContent = t;
    document.getElementById('modal-body').textContent = b;
    document.getElementById('alert-modal').classList.add('show');
}
function closeModal() { document.getElementById('alert-modal').classList.remove('show'); }

function setupCapsule() {
    const btns = document.querySelectorAll('.capsule-btn');
    const slider = document.getElementById('capsule-slider');
    btns.forEach((btn, i) => btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        slider.style.left = `calc(${i * 33.33}% + 3px)`;
        toolMode = btn.dataset.mode;
        canvas.style.cursor = toolMode === 'block' ? 'crosshair' : 'default';
        render();
    }));
}

function bindUI() {
    document.getElementById('load-orig').addEventListener('change', e => loadImg(e, true));
    document.getElementById('load-opt').addEventListener('change', e => loadImg(e, false));
    document.getElementById('slider-brush').addEventListener('input', e => {
        brushSize = +e.target.value;
        document.getElementById('brush-val').textContent = brushSize + ' px';
    });
    document.getElementById('slider-feather').addEventListener('input', e => {
        featherSize = +e.target.value;
        document.getElementById('feather-val').textContent = featherSize + ' px';
    });
    document.getElementById('slider-feather').addEventListener('change', () => render());
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-clear').addEventListener('click', clearMask);
    document.getElementById('btn-save').addEventListener('click', saveResult);
    const cmp = document.getElementById('btn-compare');
    cmp.addEventListener('mousedown', () => { cmp._hold = true; render(true); });
    cmp.addEventListener('mouseup', () => { cmp._hold = false; render(); });
    cmp.addEventListener('mouseleave', () => { if (cmp._hold) { cmp._hold = false; render(); } });
    document.getElementById('zoom-in').addEventListener('click', () => adjZoom(15));
    document.getElementById('zoom-out').addEventListener('click', () => adjZoom(-15));
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); adjZoom(e.deltaY < 0 ? 10 : -10); } }, { passive: false });
    window.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); } });
}

function loadImg(e, isOrig) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
        const img = new Image();
        img.onload = () => {
            if (isOrig) { imgOrig = img; document.getElementById('label-orig').classList.add('loaded'); }
            else { imgOpt = img; document.getElementById('label-opt').classList.add('loaded'); }
            document.getElementById('file-status').textContent =
                (imgOrig ? '✓ 原图已载入' : '') + (imgOrig && imgOpt ? ' | ' : '') + (imgOpt ? '✓ AI图已载入' : '');
            if (imgOrig && imgOpt) initEditor();
        };
        img.src = ev.target.result;
    };
    r.readAsDataURL(f);
}

function initEditor() {
    const w = imgOpt.naturalWidth, h = imgOpt.naturalHeight;
    canvasAligned = document.createElement('canvas');
    canvasAligned.width = w; canvasAligned.height = h;
    canvasAligned.getContext('2d').drawImage(imgOrig, 0, 0, w, h);
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d');
    maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, w, h);
    maskHistory = []; blocks = []; activeBlockIdx = -1;
    document.getElementById('btn-clear').disabled = false;
    document.getElementById('btn-save').disabled = false;
    document.getElementById('btn-compare').disabled = false;
    document.getElementById('welcome-overlay').classList.add('hidden');
    canvas.classList.add('visible');
    updateBlockUI();
    resetZoom();
    setStatus('两张图片已载入，可以开始涂抹还原文字。');
}

function resetZoom() {
    if (!imgOpt) return;
    const holder = document.getElementById('canvas-holder');
    zoomFitRatio = Math.min(holder.clientWidth / imgOpt.naturalWidth, holder.clientHeight / imgOpt.naturalHeight) * 0.92;
    zoomScale = 1.0; applyZoom();
}
function applyZoom() {
    zoomRatio = zoomFitRatio * zoomScale;
    document.getElementById('zoom-lbl').textContent = Math.round(zoomScale * 100) + '%';
    if (!imgOpt) return;
    const w = Math.round(imgOpt.naturalWidth * zoomRatio);
    const h = Math.round(imgOpt.naturalHeight * zoomRatio);
    canvas.width = w; canvas.height = h;
    canvas.style.position = 'absolute';
    const holder = document.getElementById('canvas-holder');
    canvas.style.left = ((holder.clientWidth - w) / 2) + 'px';
    canvas.style.top = ((holder.clientHeight - h) / 2) + 'px';
    render();
}
function adjZoom(s) { if (!imgOpt) return; zoomScale = Math.max(0.1, Math.min(5, zoomScale + s / 100)); applyZoom(); }

function render(compare) {
    if (!imgOpt) return;
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    const cmpBtn = document.getElementById('btn-compare');
    if (compare || cmpBtn._hold) { ctx.drawImage(canvasAligned, 0, 0, cw, ch); return; }
    ctx.drawImage(imgOpt, 0, 0, cw, ch);
    if (maskHistory.length > 0) {
        const tmp = document.createElement('canvas'); tmp.width = cw; tmp.height = ch;
        const tc = tmp.getContext('2d');
        tc.drawImage(canvasAligned, 0, 0, cw, ch);
        tc.globalCompositeOperation = 'destination-in';
        if (featherSize > 0) tc.filter = `blur(${Math.round(featherSize * zoomRatio)}px)`;
        tc.drawImage(maskCanvas, 0, 0, cw, ch);
        tc.filter = 'none';
        ctx.drawImage(tmp, 0, 0);
    }
    if (toolMode === 'block') drawBlocks();
}

function coords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoomRatio, y: (e.clientY - r.top) / zoomRatio };
}

function onDown(e) {
    if (!imgOpt) return;
    const c = coords(e);
    if (toolMode === 'block') {
        const hit = hitHandle(e.clientX, e.clientY);
        if (hit.idx >= 0) {
            activeBlockIdx = hit.idx; resizingHandle = hit.h;
            dragStartRect = [...blocks[hit.idx].rect]; dragStartX = c.x; dragStartY = c.y;
            updateBlockUI(); render();
        } else {
            activeBlockIdx = -1; resizingHandle = null;
            isPainting = true; dragStartX = c.x; dragStartY = c.y;
        }
    } else {
        saveHist(); isPainting = true; lastPX = c.x; lastPY = c.y;
        paint(c.x, c.y, true);
    }
}
function onMove(e) {
    if (!imgOpt) return;
    const c = coords(e);
    if (toolMode === 'block') {
        if (resizingHandle) { dragBlock(c.x, c.y); render(); }
        else if (isPainting) {
            render();
            ctx.save(); ctx.strokeStyle = '#30D158'; ctx.lineWidth = 2; ctx.setLineDash([4,4]);
            ctx.strokeRect(dragStartX*zoomRatio, dragStartY*zoomRatio, (c.x-dragStartX)*zoomRatio, (c.y-dragStartY)*zoomRatio);
            ctx.restore();
        }
    } else if (isPainting) {
        paint(c.x, c.y, false); lastPX = c.x; lastPY = c.y; render();
        const r = canvas.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) {
            ctx.save(); ctx.strokeStyle = toolMode==='draw'?'#00ff66':'#ff3333'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(c.x*zoomRatio, c.y*zoomRatio, brushSize*zoomRatio/2, 0, Math.PI*2); ctx.stroke(); ctx.restore();
        }
    }
}
function onUp(e) {
    if (!isPainting && !resizingHandle) return;
    const c = coords(e);
    if (toolMode === 'block') {
        if (resizingHandle) {
            if (cvReady) alignBlock(activeBlockIdx);
            resizingHandle = null;
        } else if (isPainting) {
            const bx = Math.min(dragStartX,c.x), by = Math.min(dragStartY,c.y);
            const bw = Math.abs(c.x-dragStartX), bh = Math.abs(c.y-dragStartY);
            if (bw > 8 && bh > 8) {
                blocks.push({ rect: [Math.round(bx),Math.round(by),Math.round(bw),Math.round(bh)], label: `板块 ${blocks.length+1}`, alignStatus: 'pending' });
                activeBlockIdx = blocks.length - 1;
                if (cvReady) alignBlock(activeBlockIdx);
                else { blocks[activeBlockIdx].alignStatus = 'failed'; setStatus('OpenCV 未就绪，板块自动配准不可用。'); }
            }
            updateBlockUI();
        }
    }
    isPainting = false; render();
}

function paint(x, y, start) {
    if (!maskCtx) return;
    maskCtx.save(); maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = brushSize;
    maskCtx.strokeStyle = toolMode === 'draw' ? '#fff' : '#000';
    maskCtx.beginPath();
    if (start) { maskCtx.moveTo(x, y); maskCtx.lineTo(x, y); }
    else { maskCtx.moveTo(lastPX, lastPY); maskCtx.lineTo(x, y); }
    maskCtx.stroke(); maskCtx.restore();
}

function saveHist() {
    if (!maskCanvas) return;
    const t = document.createElement('canvas'); t.width = maskCanvas.width; t.height = maskCanvas.height;
    t.getContext('2d').drawImage(maskCanvas, 0, 0);
    maskHistory.push(t); if (maskHistory.length > 15) maskHistory.shift();
    document.getElementById('btn-undo').disabled = false;
}
function undo() {
    if (!maskHistory.length) return;
    const p = maskHistory.pop();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(p, 0, 0);
    document.getElementById('btn-undo').disabled = maskHistory.length === 0;
    render(); setStatus('已撤销。');
}
function clearMask() {
    if (!maskCanvas) return; saveHist();
    maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    render(); setStatus('已重置涂抹。');
}

/* 板块相关 */
function hitHandle(cx, cy) {
    const holder = document.getElementById('canvas-holder');
    const cr = canvas.getBoundingClientRect();
    for (let i = 0; i < blocks.length; i++) {
        const [x,y,w,h] = blocks[i].rect;
        const x1 = x*zoomRatio+cr.left, y1 = y*zoomRatio+cr.top;
        const x2 = (x+w)*zoomRatio+cr.left, y2 = (y+h)*zoomRatio+cr.top;
        const pts = {nw:[x1,y1],n:[(x1+x2)/2,y1],ne:[x2,y1],e:[x2,(y1+y2)/2],se:[x2,y2],s:[(x1+x2)/2,y2],sw:[x1,y2],w:[x1,(y1+y2)/2]};
        for (const [k,[hx,hy]] of Object.entries(pts)) if (Math.abs(cx-hx)<=8&&Math.abs(cy-hy)<=8) return {idx:i,h:k};
        if (cx>=x1&&cx<=x2&&cy>=y1&&cy<=y2) return {idx:i,h:'move'};
    }
    return {idx:-1,h:null};
}
function dragBlock(cx, cy) {
    const b = blocks[activeBlockIdx], dx = cx-dragStartX, dy = cy-dragStartY;
    const [sx,sy,sw,sh] = dragStartRect;
    if (resizingHandle==='move') { b.rect = [Math.round(sx+dx),Math.round(sy+dy),sw,sh]; return; }
    let nx=sx,ny=sy,nw=sw,nh=sh;
    if (resizingHandle.includes('w')) { nx=Math.min(sx+dx,sx+sw-10); nw=sx+sw-nx; }
    if (resizingHandle.includes('e')) nw=Math.max(10,sw+dx);
    if (resizingHandle.includes('n')) { ny=Math.min(sy+dy,sy+sh-10); nh=sy+sh-ny; }
    if (resizingHandle.includes('s')) nh=Math.max(10,sh+dy);
    b.rect = [Math.round(nx),Math.round(ny),Math.round(nw),Math.round(nh)];
}
function drawBlocks() {
    blocks.forEach((b, i) => {
        const [x,y,w,h] = b.rect, cur = i===activeBlockIdx;
        const color = b.alignStatus==='success' ? (cur?'#30D158':'#248A3D') : (cur?'#FF453A':'#B22222');
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = cur?2:1.2;
        if (!cur) ctx.setLineDash([3,3]);
        ctx.strokeRect(x*zoomRatio,y*zoomRatio,w*zoomRatio,h*zoomRatio);
        ctx.fillStyle = color; ctx.font = 'bold 11px Inter,sans-serif';
        ctx.fillText(b.label, x*zoomRatio+4, y*zoomRatio+14);
        if (cur) {
            const pts = [[x,y],[x+w/2,y],[x+w,y],[x+w,y+h/2],[x+w,y+h],[x+w/2,y+h],[x,y+h],[x,y+h/2]];
            pts.forEach(([px,py])=>{ ctx.beginPath(); ctx.arc(px*zoomRatio,py*zoomRatio,4.5,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke(); });
        }
        ctx.restore();
    });
}
function updateBlockUI() {
    const el = document.getElementById('block-list');
    if (!blocks.length) { el.innerHTML = '<div class="placeholder-text">无活跃板块。<br>在「文字板块」模式下于画布中拉框创建。</div>'; return; }
    el.innerHTML = '';
    blocks.forEach((b, i) => {
        const d = document.createElement('div');
        d.className = `block-card ${i===activeBlockIdx?'active':''} ${b.alignStatus}`;
        d.innerHTML = `<div class="block-card-info"><span class="block-card-title">${b.label} ${b.alignStatus==='success'?'✓':'✗'}</span><span class="block-card-size">${b.rect[2]}×${b.rect[3]}</span></div><button class="block-card-del">✕</button>`;
        d.addEventListener('click', e => { if (e.target.classList.contains('block-card-del')) { blocks.splice(i,1); blocks.forEach((bb,j)=>bb.label=`板块 ${j+1}`); activeBlockIdx=-1; updateBlockUI(); render(); } else { activeBlockIdx=i; updateBlockUI(); render(); } });
        el.appendChild(d);
    });
}

/* OpenCV 板块配准 */
function alignBlock(idx) {
    if (!cvReady||idx<0) return;
    const b = blocks[idx], [x,y,w,h] = b.rect;
    const sx = imgOrig.naturalWidth/imgOpt.naturalWidth, sy = imgOrig.naturalHeight/imgOpt.naturalHeight;
    try {
        const optC = document.createElement('canvas'); optC.width=w; optC.height=h;
        optC.getContext('2d').drawImage(imgOpt,x,y,w,h,0,0,w,h);
        const mOpt = cv.imread(optC), mOptG = new cv.Mat();
        cv.cvtColor(mOpt, mOptG, cv.COLOR_RGBA2GRAY);
        const xO=Math.round(x*sx),yO=Math.round(y*sy),wO=Math.round(w*sx),hO=Math.round(h*sy);
        const pad=70, ssx=Math.max(0,xO-pad), ssy=Math.max(0,yO-pad);
        const eex=Math.min(imgOrig.naturalWidth,xO+wO+pad), eey=Math.min(imgOrig.naturalHeight,yO+hO+pad);
        const sW=eex-ssx, sH=eey-ssy, tW=Math.round(sW/sx), tH=Math.round(sH/sy);
        const sC = document.createElement('canvas'); sC.width=sW; sC.height=sH;
        sC.getContext('2d').drawImage(imgOrig,ssx,ssy,sW,sH,0,0,sW,sH);
        const rC = document.createElement('canvas'); rC.width=tW; rC.height=tH;
        rC.getContext('2d').drawImage(sC,0,0,tW,tH);
        const mS = cv.imread(rC), mSG = new cv.Mat();
        cv.cvtColor(mS, mSG, cv.COLOR_RGBA2GRAY);
        let ok = false;
        if (tW>=w && tH>=h) {
            const res = new cv.Mat();
            cv.matchTemplate(mSG, mOptG, res, cv.TM_CCOEFF_NORMED);
            const mm = cv.minMaxLoc(res); res.delete();
            if (mm.maxVal > 0.35) {
                const mx = ssx/sx+mm.maxLoc.x, my = ssy/sy+mm.maxLoc.y;
                canvasAligned.getContext('2d').drawImage(imgOrig, Math.round(mx*sx), Math.round(my*sy), wO, hO, x, y, w, h);
                ok = true;
            }
        }
        if (!ok) canvasAligned.getContext('2d').drawImage(imgOrig, xO, yO, wO, hO, x, y, w, h);
        b.alignStatus = ok ? 'success' : 'failed';
        mOpt.delete(); mOptG.delete(); mS.delete(); mSG.delete();
        setStatus(`${b.label} ${ok?'配准成功':'配准失败，使用物理对齐'}`);
    } catch(e) { console.error(e); b.alignStatus = 'failed'; }
    updateBlockUI(); render();
}

/* 导出 */
function saveResult() {
    if (!imgOpt) return;
    const w=imgOpt.naturalWidth, h=imgOpt.naturalHeight;
    const out = document.createElement('canvas'); out.width=w; out.height=h;
    const oc = out.getContext('2d');
    oc.drawImage(imgOpt, 0, 0);
    if (maskHistory.length > 0) {
        const tmp = document.createElement('canvas'); tmp.width=w; tmp.height=h;
        const tc = tmp.getContext('2d');
        tc.drawImage(canvasAligned, 0, 0);
        tc.globalCompositeOperation = 'destination-in';
        if (featherSize > 0) tc.filter = `blur(${featherSize}px)`;
        tc.drawImage(maskCanvas, 0, 0); tc.filter = 'none';
        oc.drawImage(tmp, 0, 0);
    }
    out.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `AITextRestorer_${Date.now()}.png`; a.click();
        setStatus('图片导出成功！');
    }, 'image/png');
}

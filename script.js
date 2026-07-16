/* AITextRestorer Web - 核心逻辑 (高清无损版) */
let cvReady = false, imgOrig = null, imgOpt = null;
let canvasAligned = null, maskCanvas = null, maskCtx = null;
let maskHistory = [], toolMode = 'draw', brushSize = 22, featherSize = 8;
let zoomScale = 1.0, zoomFitRatio = 1.0;
let isPainting = false, lastPX = 0, lastPY = 0;
let blocks = [], activeBlockIdx = -1, resizingHandle = null;
let dragStartRect = null, dragStartX = 0, dragStartY = 0;

const canvas = document.getElementById('editor-canvas');
const ctx = canvas.getContext('2d');

document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    setupCapsule();
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

document.addEventListener('opencv-ready', checkOpenCVStatus);
document.addEventListener('opencv-failed', () => {
    document.getElementById('status-dot').className = 'status-dot failed';
    document.getElementById('status-text').textContent = '引擎加载失败（基础功能可用）';
    setStatus('OpenCV 加载失败，板块自动配准不可用，但涂抹和导出正常工作。');
});

setTimeout(() => {
    checkOpenCVStatus();
    if (!cvReady) document.dispatchEvent(new Event('opencv-failed'));
}, 25000);

function setStatus(m) { document.getElementById('status-msg').textContent = m; }

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
        render(); // 刷新画笔粗细预览
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
    
    canvas.addEventListener('wheel', e => {
        if (e.ctrlKey) {
            e.preventDefault();
            adjZoom(e.deltaY < 0 ? 10 : -10);
        }
    }, { passive: false });
    
    window.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
        }
    });
}

function loadImg(e, isOrig) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
        const img = new Image();
        img.onload = () => {
            if (isOrig) { 
                imgOrig = img; 
                document.getElementById('label-orig').classList.add('loaded'); 
            } else { 
                imgOpt = img; 
                document.getElementById('label-opt').classList.add('loaded'); 
            }
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
    
    // 初始化无损对齐底片与离屏掩膜
    canvasAligned = document.createElement('canvas');
    canvasAligned.width = w; canvasAligned.height = h;
    canvasAligned.getContext('2d').drawImage(imgOrig, 0, 0, w, h);
    
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, w, h); // 默认全透明
    
    maskHistory = []; blocks = []; activeBlockIdx = -1;
    
    document.getElementById('btn-clear').disabled = false;
    document.getElementById('btn-save').disabled = false;
    document.getElementById('btn-compare').disabled = false;
    document.getElementById('welcome-overlay').classList.add('hidden');
    
    canvas.classList.add('visible');
    updateBlockUI();
    resetZoom();
    setStatus('图片已载入。使用笔刷在错乱文字上涂抹进行高清无损还原。');
}

function resetZoom() {
    if (!imgOpt) return;
    const holder = document.getElementById('canvas-holder');
    // 计算适应屏幕的大小
    zoomFitRatio = Math.min(holder.clientWidth / imgOpt.naturalWidth, holder.clientHeight / imgOpt.naturalHeight) * 0.92;
    zoomScale = 1.0;
    applyZoom();
}

function applyZoom() {
    if (!imgOpt) return;
    const zoomRatio = zoomFitRatio * zoomScale;
    document.getElementById('zoom-lbl').textContent = Math.round(zoomScale * 100) + '%';
    
    // 关键修正：Canvas 物理分辨率必须永远保持为原图大小（高清无糊）
    canvas.width = imgOpt.naturalWidth;
    canvas.height = imgOpt.naturalHeight;
    
    // 使用 CSS 缩放显示，保证高分屏下文字与线条绝对清晰
    const dw = Math.round(imgOpt.naturalWidth * zoomRatio);
    const dh = Math.round(imgOpt.naturalHeight * zoomRatio);
    canvas.style.width = dw + 'px';
    canvas.style.height = dh + 'px';
    
    // 居中定位
    canvas.style.position = 'absolute';
    const holder = document.getElementById('canvas-holder');
    canvas.style.left = ((holder.clientWidth - dw) / 2) + 'px';
    canvas.style.top = ((holder.clientHeight - dh) / 2) + 'px';
    
    render();
}

function adjZoom(s) {
    if (!imgOpt) return;
    zoomScale = Math.max(0.1, Math.min(6, zoomScale + s / 100));
    applyZoom();
}

// 统一的原图坐标转换
function coords(e) {
    const r = canvas.getBoundingClientRect();
    return {
        x: ((e.clientX - r.left) / r.width) * canvas.width,
        y: ((e.clientY - r.top) / r.height) * canvas.height
    };
}

function render(compare) {
    if (!imgOpt) return;
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    
    const cmpBtn = document.getElementById('btn-compare');
    if (compare || cmpBtn._hold) {
        ctx.drawImage(canvasAligned, 0, 0, cw, ch);
        return;
    }
    
    // 1. 绘制底层（AI图）
    ctx.drawImage(imgOpt, 0, 0, cw, ch);
    
    // 2. 局部混合高保真对齐原图
    const tmp = document.createElement('canvas');
    tmp.width = cw; tmp.height = ch;
    const tc = tmp.getContext('2d');
    
    tc.drawImage(canvasAligned, 0, 0, cw, ch);
    tc.globalCompositeOperation = 'destination-in';
    
    if (featherSize > 0) {
        tc.filter = `blur(${featherSize}px)`; // 在大图分辨率下直接做羽化，边缘毫无马赛克
    }
    tc.drawImage(maskCanvas, 0, 0, cw, ch);
    tc.filter = 'none';
    
    ctx.drawImage(tmp, 0, 0);
    
    // 3. 绘制板块选框
    if (toolMode === 'block') drawBlocks();
}

function onDown(e) {
    if (!imgOpt) return;
    const c = coords(e);
    if (toolMode === 'block') {
        const hit = hitHandle(e.clientX, e.clientY);
        if (hit.idx >= 0) {
            activeBlockIdx = hit.idx;
            resizingHandle = hit.h;
            dragStartRect = [...blocks[hit.idx].rect];
            dragStartX = c.x;
            dragStartY = c.y;
            updateBlockUI();
            render();
        } else {
            activeBlockIdx = -1;
            resizingHandle = null;
            isPainting = true;
            dragStartX = c.x;
            dragStartY = c.y;
        }
    } else {
        saveHist();
        isPainting = true;
        lastPX = c.x;
        lastPY = c.y;
        paint(c.x, c.y, true);
        render();
    }
}

function onMove(e) {
    if (!imgOpt) return;
    const c = coords(e);
    
    if (toolMode === 'block') {
        if (resizingHandle) {
            dragBlock(c.x, c.y);
            render();
        } else if (isPainting) {
            render();
            // 在大图坐标系绘制选框（不乘以 zoomRatio）
            ctx.save();
            ctx.strokeStyle = '#30D158';
            ctx.lineWidth = Math.max(1.5, 2 / (zoomScale * zoomFitRatio)); // 线宽自适应
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(dragStartX, dragStartY, c.x - dragStartX, c.y - dragStartY);
            ctx.restore();
        }
    } else if (isPainting) {
        paint(c.x, c.y, false);
        lastPX = c.x;
        lastPY = c.y;
        render();
        drawBrushCursor(c.x, c.y);
    } else {
        // 未绘画状态下的画笔悬浮预览
        const r = canvas.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            render();
            drawBrushCursor(c.x, c.y);
        }
    }
}

function drawBrushCursor(x, y) {
    ctx.save();
    ctx.strokeStyle = toolMode === 'draw' ? '#30D158' : '#FF453A';
    ctx.lineWidth = Math.max(1, 1.5 / (zoomScale * zoomFitRatio));
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function onUp(e) {
    if (!isPainting && !resizingHandle) return;
    const c = coords(e);
    
    if (toolMode === 'block') {
        if (resizingHandle) {
            if (cvReady) alignBlock(activeBlockIdx);
            resizingHandle = null;
        } else if (isPainting) {
            const bx = Math.min(dragStartX, c.x), by = Math.min(dragStartY, c.y);
            const bw = Math.abs(c.x - dragStartX), bh = Math.abs(c.y - dragStartY);
            if (bw > 8 && bh > 8) {
                blocks.push({
                    rect: [Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh)],
                    label: `板块 ${blocks.length + 1}`,
                    alignStatus: 'pending'
                });
                activeBlockIdx = blocks.length - 1;
                if (cvReady) alignBlock(activeBlockIdx);
                else {
                    blocks[activeBlockIdx].alignStatus = 'failed';
                    setStatus('OpenCV 未就绪，板块使用物理映射对齐。');
                }
            }
            updateBlockUI();
        }
    }
    isPainting = false;
    render();
}

function paint(x, y, start) {
    if (!maskCtx) return;
    maskCtx.save();
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = brushSize;
    
    if (toolMode === 'draw') {
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
    } else if (toolMode === 'erase') {
        maskCtx.globalCompositeOperation = 'destination-out';
        maskCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
    }
    
    maskCtx.beginPath();
    if (start) {
        maskCtx.moveTo(x, y);
        maskCtx.lineTo(x, y);
    } else {
        maskCtx.moveTo(lastPX, lastPY);
        maskCtx.lineTo(x, y);
    }
    maskCtx.stroke();
    maskCtx.restore();
}

function saveHist() {
    if (!maskCanvas) return;
    const t = document.createElement('canvas'); t.width = maskCanvas.width; t.height = maskCanvas.height;
    t.getContext('2d').drawImage(maskCanvas, 0, 0);
    maskHistory.push(t);
    if (maskHistory.length > 20) maskHistory.shift();
    document.getElementById('btn-undo').disabled = false;
}

function undo() {
    if (!maskHistory.length) return;
    const p = maskHistory.pop();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(p, 0, 0);
    document.getElementById('btn-undo').disabled = maskHistory.length === 0;
    render();
    setStatus('已撤销涂抹。');
}

function clearMask() {
    if (!maskCanvas) return;
    saveHist();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    render();
    setStatus('已重置所有涂抹区域。');
}

/* 物理与自动配准判定 */
function hitHandle(cx, cy) {
    const cr = canvas.getBoundingClientRect();
    const scaleX = cr.width / canvas.width;
    const scaleY = cr.height / canvas.height;
    
    for (let i = 0; i < blocks.length; i++) {
        const [x, y, w, h] = blocks[i].rect;
        const x1 = x * scaleX + cr.left, y1 = y * scaleY + cr.top;
        const x2 = (x + w) * scaleX + cr.left, y2 = (y + h) * scaleY + cr.top;
        
        // 八方向手柄检测
        const hRad = 8; // 点击感应半径
        const pts = {
            nw: [x1, y1],
            n: [(x1 + x2) / 2, y1],
            ne: [x2, y1],
            e: [x2, (y1 + y2) / 2],
            se: [x2, y2],
            s: [(x1 + x2) / 2, y2],
            sw: [x1, y2],
            w: [x1, (y1 + y2) / 2]
        };
        for (const [k, [hx, hy]] of Object.entries(pts)) {
            if (Math.abs(cx - hx) <= hRad && Math.abs(cy - hy) <= hRad) return { idx: i, h: k };
        }
        // 框内移动检测
        if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) return { idx: i, h: 'move' };
    }
    return { idx: -1, h: null };
}

function dragBlock(cx, cy) {
    const b = blocks[activeBlockIdx], dx = cx - dragStartX, dy = cy - dragStartY;
    const [sx, sy, sw, sh] = dragStartRect;
    
    if (resizingHandle === 'move') {
        b.rect = [Math.round(sx + dx), Math.round(sy + dy), sw, sh];
        return;
    }
    
    let nx = sx, ny = sy, nw = sw, nh = sh;
    if (resizingHandle.includes('w')) { nx = Math.min(sx + dx, sx + sw - 10); nw = sx + sw - nx; }
    if (resizingHandle.includes('e')) nw = Math.max(10, sw + dx);
    if (resizingHandle.includes('n')) { ny = Math.min(sy + dy, sy + sh - 10); nh = sy + sh - ny; }
    if (resizingHandle.includes('s')) nh = Math.max(10, sh + dy);
    
    b.rect = [Math.round(nx), Math.round(ny), Math.round(nw), Math.round(nh)];
}

function drawBlocks() {
    const scaleFactor = zoomScale * zoomFitRatio;
    blocks.forEach((b, i) => {
        const [x, y, w, h] = b.rect, cur = i === activeBlockIdx;
        const color = b.alignStatus === 'success' ? (cur ? '#30D158' : '#248A3D') : (cur ? '#FF453A' : '#B22222');
        
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = cur ? Math.max(2, 3 / scaleFactor) : Math.max(1, 1.5 / scaleFactor);
        if (!cur) ctx.setLineDash([4, 4]);
        
        // 直接在物理分辨率上画框
        ctx.strokeRect(x, y, w, h);
        
        // 绘制文字标贴，字号自适应
        const fs = Math.max(12, 14 / scaleFactor);
        ctx.fillStyle = color;
        ctx.font = `bold ${fs}px Inter, sans-serif`;
        ctx.fillText(b.label, x + 5, y + fs + 4);
        
        // 绘制控制点手柄
        if (cur) {
            const hRadius = Math.max(4.5, 6 / scaleFactor);
            const pts = [
                [x, y], [x + w / 2, y], [x + w, y],
                [x + w, y + h / 2], [x + w, y + h],
                [x + w / 2, y + h], [x, y + h], [x, y + h / 2]
            ];
            pts.forEach(([px, py]) => {
                ctx.beginPath();
                ctx.arc(px, py, hRadius, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = Math.max(1.5, 2 / scaleFactor);
                ctx.stroke();
            });
        }
        ctx.restore();
    });
}

function updateBlockUI() {
    const el = document.getElementById('block-list');
    if (!blocks.length) {
        el.innerHTML = '<div class="placeholder-text">无活跃板块。<br>在「文字板块」模式下于画布中拉框创建。</div>';
        return;
    }
    el.innerHTML = '';
    blocks.forEach((b, i) => {
        const d = document.createElement('div');
        d.className = `block-card ${i === activeBlockIdx ? 'active' : ''} ${b.alignStatus}`;
        d.innerHTML = `<div class="block-card-info"><span class="block-card-title">${b.label} ${b.alignStatus === 'success' ? '✓' : '✗'}</span><span class="block-card-size">${b.rect[2]}×${b.rect[3]}</span></div><button class="block-card-del">✕</button>`;
        
        d.addEventListener('click', e => {
            if (e.target.classList.contains('block-card-del')) {
                blocks.splice(i, 1);
                blocks.forEach((bb, j) => bb.label = `板块 ${j + 1}`);
                activeBlockIdx = -1;
                updateBlockUI();
                render();
            } else {
                activeBlockIdx = i;
                updateBlockUI();
                render();
            }
        });
        el.appendChild(d);
    });
}

/* 基于 OpenCV.js 的智能板块配准对齐 */
function alignBlock(idx) {
    if (idx < 0 || idx >= blocks.length) return;
    const b = blocks[idx], [x, y, w, h] = b.rect;
    
    // 计算原图与AI图的几何分辨率缩放因子
    const sx = imgOrig.naturalWidth / imgOpt.naturalWidth;
    const sy = imgOrig.naturalHeight / imgOpt.naturalHeight;
    const xO = Math.round(x * sx), yO = Math.round(y * sy);
    const wO = Math.round(w * sx), hO = Math.round(h * sy);
    
    let ok = false;
    if (cvReady) {
        let mOpt = null, mOptG = null, mS = null, mSG = null;
        try {
            // 1. 裁剪优化图（AI图）目标子图
            const optC = document.createElement('canvas'); optC.width = w; optC.height = h;
            optC.getContext('2d').drawImage(imgOpt, x, y, w, h, 0, 0, w, h);
            mOpt = cv.imread(optC); mOptG = new cv.Mat();
            cv.cvtColor(mOpt, mOptG, cv.COLOR_RGBA2GRAY);
            
            // 2. 确定原图在大图分辨率下的对应映射搜索区（外扩 pad 边界，支持大平移容错）
            const pad = 90; 
            const ssx = Math.max(0, xO - pad), ssy = Math.max(0, yO - pad);
            const eex = Math.min(imgOrig.naturalWidth, xO + wO + pad), eey = Math.min(imgOrig.naturalHeight, yO + hO + pad);
            
            const sW = eex - ssx, sH = eey - ssy;
            const tW = Math.round(sW / sx), tH = Math.round(sH / sy);
            
            // 3. 裁剪并缩放原图局部搜索区
            const sC = document.createElement('canvas'); sC.width = sW; sC.height = sH;
            sC.getContext('2d').drawImage(imgOrig, ssx, ssy, sW, sH, 0, 0, sW, sH);
            
            const rC = document.createElement('canvas'); rC.width = tW; rC.height = tH;
            rC.getContext('2d').drawImage(sC, 0, 0, tW, tH);
            
            mS = cv.imread(rC); mSG = new cv.Mat();
            cv.cvtColor(mS, mSG, cv.COLOR_RGBA2GRAY);
            
            if (tW >= w && tH >= h) {
                const res = new cv.Mat();
                cv.matchTemplate(mSG, mOptG, res, cv.TM_CCOEFF_NORMED);
                const mm = cv.minMaxLoc(res);
                res.delete();
                
                // 匹配置信度阈值判定
                if (mm.maxVal > 0.38) {
                    const mx = ssx / sx + mm.maxLoc.x;
                    const my = ssy / sy + mm.maxLoc.y;
                    
                    // 进行色彩与风格自适应混合传递 (Reinhard色彩算法)，贴回对齐底片
                    const patchOrigCanvas = document.createElement('canvas');
                    patchOrigCanvas.width = w; patchOrigCanvas.height = h;
                    patchOrigCanvas.getContext('2d').drawImage(imgOrig, Math.round(mx * sx), Math.round(my * sy), wO, hO, 0, 0, w, h);
                    
                    const patchOptCanvas = document.createElement('canvas');
                    patchOptCanvas.width = w; patchOptCanvas.height = h;
                    patchOptCanvas.getContext('2d').drawImage(imgOpt, x, y, w, h, 0, 0, w, h);
                    
                    // 执行自适应通道均衡色彩风格传递，无痕融合
                    const alignedPatchData = colorTransfer(patchOrigCanvas, patchOptCanvas);
                    canvasAligned.getContext('2d').putImageData(alignedPatchData, x, y);
                    ok = true;
                }
            }
        } catch (err) {
            console.error("OpenCV align failed, fallback to physical alignment:", err);
        } finally {
            // 释放 OpenCV 内存
            if (mOpt) mOpt.delete();
            if (mOptG) mOptG.delete();
            if (mS) mS.delete();
            if (mSG) mSG.delete();
        }
    }
    
    // 物理直接对齐贴回：不论是 OpenCV 匹配未达标还是 OpenCV.js 未就绪/报错，都进行兜底绘制
    if (!ok) {
        canvasAligned.getContext('2d').drawImage(imgOrig, xO, yO, wO, hO, x, y, w, h);
    }
    
    // 自动将该板块对应矩形填充为已涂抹（白色），立刻在画布呈现对齐结果，无需用户二次笔刷涂抹
    if (maskCtx) {
        maskCtx.save();
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.fillStyle = 'rgba(255, 255, 255, 1)';
        maskCtx.fillRect(x, y, w, h);
        maskCtx.restore();
        saveHist();
    }
    
    b.alignStatus = ok ? 'success' : 'failed';
    setStatus(ok ? `${b.label} 自动配准成功并完成色彩自适应` : `${b.label} 特征匹配未达标，已自动以物理对齐替代`);
    updateBlockUI();
    render();
}

/* RGB <-> CIE LAB 空间 Reinhard 自适应色彩平衡传递 */
function colorTransfer(srcCanvas, refCanvas) {
    const sCtx = srcCanvas.getContext('2d'), rCtx = refCanvas.getContext('2d');
    const w = srcCanvas.width, h = srcCanvas.height;
    
    const sData = sCtx.getImageData(0, 0, w, h), rData = rCtx.getImageData(0, 0, w, h);
    const sp = sData.data, rp = rData.data, len = sp.length;
    
    // 转为 LAB 并计算均值、标准差
    let sLAB = [], rLAB = [];
    let sSum = [0,0,0], rSum = [0,0,0];
    
    for (let i = 0; i < len; i += 4) {
        const slab = rgb2lab(sp[i], sp[i+1], sp[i+2]);
        const rlab = rgb2lab(rp[i], rp[i+1], rp[i+2]);
        sLAB.push(slab); rLAB.push(rlab);
        sSum[0] += slab[0]; sSum[1] += slab[1]; sSum[2] += slab[2];
        rSum[0] += rlab[0]; rSum[1] += rlab[1]; rSum[2] += rlab[2];
    }
    
    const N = len / 4;
    const sMean = [sSum[0]/N, sSum[1]/N, sSum[2]/N];
    const rMean = [rSum[0]/N, rSum[1]/N, rSum[2]/N];
    
    let sVar = [0,0,0], rVar = [0,0,0];
    for (let i = 0; i < N; i++) {
        sVar[0] += Math.pow(sLAB[i][0] - sMean[0], 2);
        sVar[1] += Math.pow(sLAB[i][1] - sMean[1], 2);
        sVar[2] += Math.pow(sLAB[i][2] - sMean[2], 2);
        
        rVar[0] += Math.pow(rLAB[i][0] - rMean[0], 2);
        rVar[1] += Math.pow(rLAB[i][1] - rMean[1], 2);
        rVar[2] += Math.pow(rLAB[i][2] - rMean[2], 2);
    }
    
    const sStd = [Math.sqrt(sVar[0]/N)+1e-5, Math.sqrt(sVar[1]/N)+1e-5, Math.sqrt(sVar[2]/N)+1e-5];
    const rStd = [Math.sqrt(rVar[0]/N)+1e-5, Math.sqrt(rVar[1]/N)+1e-5, Math.sqrt(rVar[2]/N)+1e-5];
    
    // 映射通道并转回 RGB
    for (let i = 0; i < N; i++) {
        let l = ((sLAB[i][0] - sMean[0]) * (rStd[0] / sStd[0])) + rMean[0];
        let a = ((sLAB[i][1] - sMean[1]) * (rStd[1] / sStd[1])) + rMean[1];
        let b = ((sLAB[i][2] - sMean[2]) * (rStd[2] / sStd[2])) + rMean[2];
        
        const rgb = lab2rgb(l, a, b);
        const idx = i * 4;
        sp[idx] = Math.max(0, Math.min(255, rgb[0]));
        sp[idx+1] = Math.max(0, Math.min(255, rgb[1]));
        sp[idx+2] = Math.max(0, Math.min(255, rgb[2]));
    }
    return sData;
}

function rgb2lab(r, g, b) {
    let r_ = r/255, g_ = g/255, b_ = b/255;
    r_ = (r_ > 0.04045) ? Math.pow((r_ + 0.055) / 1.055, 2.4) : r_ / 12.92;
    g_ = (g_ > 0.04045) ? Math.pow((g_ + 0.055) / 1.055, 2.4) : g_ / 12.92;
    b_ = (b_ > 0.04045) ? Math.pow((b_ + 0.055) / 1.055, 2.4) : b_ / 12.92;
    
    const x = (r_ * 0.4124 + g_ * 0.3576 + b_ * 0.1805) * 100 / 95.047;
    const y = (r_ * 0.2126 + g_ * 0.7152 + b_ * 0.0722) * 100 / 100.00;
    const z = (r_ * 0.0193 + g_ * 0.1192 + b_ * 0.9505) * 100 / 108.883;
    
    const fx = (x > 0.008856) ? Math.pow(x, 1/3) : (7.787 * x) + 16/116;
    const fy = (y > 0.008856) ? Math.pow(y, 1/3) : (7.787 * y) + 16/116;
    const fz = (z > 0.008856) ? Math.pow(z, 1/3) : (7.787 * z) + 16/116;
    
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function lab2rgb(l, a, b) {
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    
    const x = 95.047 * ((Math.pow(fx, 3) > 0.008856) ? Math.pow(fx, 3) : (fx - 16/116) / 7.787);
    const y = 100.00 * ((Math.pow(fy, 3) > 0.008856) ? Math.pow(fy, 3) : (fy - 16/116) / 7.787);
    const z = 108.883 * ((Math.pow(fz, 3) > 0.008856) ? Math.pow(fz, 3) : (fz - 16/116) / 7.787);
    
    const x_ = x / 100, y_ = y / 100, z_ = z / 100;
    let r = x_ * 3.2406 + y_ * -1.5372 + z_ * -0.4986;
    let g = x_ * -0.9689 + y_ * 1.8758 + z_ * 0.0415;
    let b_ = x_ * 0.0557 + y_ * -0.2040 + z_ * 1.0570;
    
    r = (r > 0.0031308) ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = (g > 0.0031308) ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b_ = (b_ > 0.0031308) ? 1.055 * Math.pow(b_, 1 / 2.4) - 0.055 : 12.92 * b_;
    
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b_ * 255)];
}

/* 无损导出 */
function saveResult() {
    if (!imgOpt) return;
    const w = imgOpt.naturalWidth, h = imgOpt.naturalHeight;
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const oc = out.getContext('2d');
    
    oc.drawImage(imgOpt, 0, 0);
    
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    tc.drawImage(canvasAligned, 0, 0);
    tc.globalCompositeOperation = 'destination-in';
    
    if (featherSize > 0) {
        tc.filter = `blur(${featherSize}px)`;
    }
    tc.drawImage(maskCanvas, 0, 0);
    tc.filter = 'none';
    
    oc.drawImage(tmp, 0, 0);
    
    out.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `AITextRestorer_Web_${Date.now()}.png`;
        a.click();
        setStatus('无损高清图片导出成功！');
    }, 'image/png');
}

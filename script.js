/* ----------------------------------------------------
   AITextRestorer - Core JS Frontend Engine
   ---------------------------------------------------- */

// 1. 全局状态
let cvReady = false;
let imgOrig = null;     // 原始低清图 (HTML Image)
let imgOpt = null;      // AI优化后图 (HTML Image)

// 离屏及对齐画布
let canvasAligned = null; // 存储对齐后高清原图 (HTML Canvas)
let maskCanvas = null;    // 存储大图分辨率的Mask (HTML Canvas, 纯黑白)
let maskCtx = null;
let maskHistory = [];
const maxHistory = 15;

// 界面参数
let toolMode = 'draw';  // 'draw', 'erase', 'block'
let brushSize = 22;
let featherSize = 8;
let zoomScale = 1.0;
let zoomFitRatio = 1.0;
let zoomRatio = 1.0;
let offsetX = 0;
let offsetY = 0;
let showCompare = false;

// 画笔状态
let isPainting = false;
let lastPaintX = 0;
let lastPaintY = 0;

// 板块管理器数据
let blocks = []; // { rect: [x, y, w, h], label: '板块 1', alignStatus: 'pending' }
let activeBlockIdx = -1;
let resizingHandle = null; // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'
let dragStartRect = null;
let dragStartX = 0;
let dragStartY = 0;

// 画布元素
const editorCanvas = document.getElementById('editor-canvas');
const ctx = editorCanvas.getContext('2d');

/* ----------------------------------------------------
   2. 初始化与事件绑定
   ---------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
    bindUIEvents();
    setupCapsuleAnimation();
});

// OpenCV.js 引擎加载就绪事件
document.addEventListener('opencv-ready', () => {
    cvReady = true;
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    
    statusDot.classList.remove('pulsing');
    statusDot.classList.add('ready');
    statusText.textContent = "AI 算法引擎就绪";
    updateStatus("算法引擎载入完毕，请导入原始照片和优化照片。");

    // 启用导入按钮
    document.getElementById('load-orig').disabled = false;
    document.getElementById('load-opt').disabled = false;
});

function updateStatus(msg) {
    document.getElementById('status-msg').textContent = `状态：${msg}`;
}

function showModal(title, message) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = message;
    document.getElementById('alert-modal').classList.add('show');
}

function closeModal() {
    document.getElementById('alert-modal').classList.remove('show');
}

// 胶囊导航背景滑动动画
function setupCapsuleAnimation() {
    const btns = document.querySelectorAll('.capsule-btn');
    const slider = document.getElementById('capsule-slider');
    
    btns.forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            slider.style.left = `calc(${idx * 33.33}% + 2px)`;
            
            toolMode = btn.dataset.mode;
            if (toolMode === 'block') {
                editorCanvas.style.cursor = 'crosshair';
                updateStatus("板块模式：在画布上框选以新建文字对齐板块，或调整已有板块。");
            } else {
                editorCanvas.style.cursor = 'default';
                updateStatus(toolMode === 'draw' ? "笔刷模式：涂抹以恢复原图中的清晰文字。" : "橡皮模式：擦除已还原区域。");
            }
            renderCanvas();
        });
    });
}

function bindUIEvents() {
    // 导入事件
    document.getElementById('load-orig').addEventListener('change', (e) => loadImage(e, true));
    document.getElementById('load-opt').addEventListener('change', (e) => loadImage(e, false));

    // 滑动条事件
    const brushSlider = document.getElementById('slider-brush');
    brushSlider.addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value);
        document.getElementById('brush-val').textContent = `${brushSize} px`;
    });

    const featherSlider = document.getElementById('slider-feather');
    featherSlider.addEventListener('input', (e) => {
        featherSize = parseInt(e.target.value);
        document.getElementById('feather-val').textContent = `${featherSize} px`;
    });
    featherSlider.addEventListener('change', () => {
        renderCanvas();
    });

    // 撤销与清除
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-clear').addEventListener('click', clearMask);
    document.getElementById('btn-save').addEventListener('click', saveResult);

    // 对比事件
    const compareBtn = document.getElementById('btn-compare');
    compareBtn.addEventListener('mousedown', () => { showCompare = true; renderCanvas(); });
    compareBtn.addEventListener('mouseup', () => { showCompare = false; renderCanvas(); });
    compareBtn.addEventListener('mouseleave', () => { if(showCompare) { showCompare = false; renderCanvas(); } });
    
    // 移动端对比
    compareBtn.addEventListener('touchstart', (e) => { e.preventDefault(); showCompare = true; renderCanvas(); });
    compareBtn.addEventListener('touchend', (e) => { e.preventDefault(); showCompare = false; renderCanvas(); });

    // 缩放按钮
    document.getElementById('zoom-in').addEventListener('click', () => adjustZoom(10));
    document.getElementById('zoom-out').addEventListener('click', () => adjustZoom(-10));

    // 键盘快捷键
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            undo();
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteActiveBlock();
        }
    });

    // 画布鼠标/触摸交互
    editorCanvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // 滚轮缩放 (Ctrl + 滚轮)
    editorCanvas.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const step = e.deltaY < 0 ? 10 : -10;
            adjustZoom(step);
        }
    }, { passive: false });
}

/* ----------------------------------------------------
   3. 图像加载与基础对齐
   ---------------------------------------------------- */
function loadImage(e, isOrig) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            if (isOrig) {
                imgOrig = img;
                updateStatus(`已载入原图: ${file.name}`);
            } else {
                imgOpt = img;
                updateStatus(`已载入优化图: ${file.name}`);
            }
            onImagesChanged();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

function onImagesChanged() {
    if (!imgOrig || !imgOpt) return;

    // 初始化对齐画布和掩膜画布尺寸为 AI 优化图大小
    const w = imgOpt.naturalWidth;
    const h = imgOpt.naturalHeight;

    canvasAligned = document.createElement('canvas');
    canvasAligned.width = w;
    canvasAligned.height = h;
    const alignCtx = canvasAligned.getContext('2d');
    
    // 基础拉伸拼合
    alignCtx.drawImage(imgOrig, 0, 0, w, h);

    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d');
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(0, 0, w, h);

    maskHistory = [];
    blocks = [];
    activeBlockIdx = -1;

    // 启用按钮
    document.getElementById('btn-clear').disabled = false;
    document.getElementById('btn-save').disabled = false;
    document.getElementById('btn-compare').disabled = false;
    
    updateBlockListUI();
    resetZoom();
}

function resetZoom() {
    if (!imgOpt) return;
    const container = editorCanvas.parentNode;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const imgW = imgOpt.naturalWidth;
    const imgH = imgOpt.naturalHeight;

    zoomFitRatio = Math.min(cw / imgW, ch / imgH);
    zoomScale = 1.0;
    updateZoomRatio();
}

function updateZoomRatio() {
    zoomRatio = zoomFitRatio * zoomScale;
    document.getElementById('zoom-lbl').textContent = `${Math.round(zoomScale * 100)}%`;
    
    if (imgOpt) {
        const w = Math.round(imgOpt.naturalWidth * zoomRatio);
        const h = Math.round(imgOpt.naturalHeight * zoomRatio);
        editorCanvas.width = w;
        editorCanvas.height = h;
        
        const container = editorCanvas.parentNode;
        offsetX = (container.clientWidth - w) / 2;
        offsetY = (container.clientHeight - h) / 2;
        
        editorCanvas.style.position = 'absolute';
        editorCanvas.style.left = `${offsetX}px`;
        editorCanvas.style.top = `${offsetY}px`;
    }
    renderCanvas();
}

function adjustZoom(stepVal) {
    if (!imgOpt) return;
    let val = Math.round(zoomScale * 100) + stepVal;
    val = Math.max(10, Math.min(500, val));
    zoomScale = val / 100;
    updateZoomRatio();
}

/* ----------------------------------------------------
   4. 核心 Canvas 渲染与涂抹融合
   ---------------------------------------------------- */
function renderCanvas() {
    if (!imgOpt) {
        ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
        return;
    }

    const cw = editorCanvas.width;
    const ch = editorCanvas.height;

    // 1. 清除画布
    ctx.clearRect(0, 0, cw, ch);

    // 2. 对比视图模式下，仅绘制对齐图底图，不绘制融合效果
    if (showCompare) {
        ctx.drawImage(canvasAligned, 0, 0, cw, ch);
        return;
    }

    // 3. 绘制 AI 优化后的高清底图
    ctx.drawImage(imgOpt, 0, 0, cw, ch);

    // 4. 判断 Mask 是否有涂抹，如果有，进行透明度羽化融合
    const isMaskEmpty = checkMaskEmpty();
    if (!isMaskEmpty) {
        // 创建临时画布用于合成
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cw;
        tempCanvas.height = ch;
        const tempCtx = tempCanvas.getContext('2d');

        // 第一步：在临时画布绘制对齐的原图
        tempCtx.drawImage(canvasAligned, 0, 0, cw, ch);

        // 第二步：使用 destination-in 应用带羽化的模糊 Mask
        tempCtx.globalCompositeOperation = 'destination-in';
        
        if (featherSize > 0) {
            // Web 端超高效率的 CSS GPU 模糊滤镜代替大图 GaussianBlur 运算，帧率拉满
            const blurVal = Math.round(featherSize * zoomRatio);
            tempCtx.filter = `blur(${blurVal}px)`;
        }
        tempCtx.drawImage(maskCanvas, 0, 0, cw, ch);
        tempCtx.filter = 'none';

        // 第三步：将混合结果绘制回主画布
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(tempCanvas, 0, 0);
    }

    // 5. 绘制板块高亮选区与拉伸控制点
    if (toolMode === 'block') {
        drawBlocksOutline();
    }
}

function checkMaskEmpty() {
    if (!maskCanvas) return true;
    // 快速检测：用离屏检测，或者为了性能直接记录绘制动作
    return maskHistory.length === 0;
}

/* ----------------------------------------------------
   5. 鼠标与触摸交互逻辑 (涂抹与拉框)
   ---------------------------------------------------- */
function getCanvasCoords(e) {
    const rect = editorCanvas.getBoundingClientRect();
    let clientX = e.clientX;
    let clientY = e.clientY;
    
    // 支持 Touch 事件
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    }
    
    return {
        x: (clientX - rect.left) / zoomRatio,
        y: (clientY - rect.top) / zoomRatio
    };
}

function onMouseDown(e) {
    if (!imgOpt) return;
    const coords = getCanvasCoords(e);
    
    if (toolMode === 'block') {
        // 检测是否点中了板块的手柄
        const hit = getHandleUnderMouse(e.clientX, e.clientY);
        if (hit.blockIdx !== -1) {
            activeBlockIdx = hit.blockIdx;
            resizingHandle = hit.handle;
            dragStartRect = [...blocks[activeBlockIdx].rect];
            dragStartX = coords.x;
            dragStartY = coords.y;
            updateBlockListUI();
            renderCanvas();
        } else {
            // 点击空白拉出选区
            activeBlockIdx = -1;
            resizingHandle = null;
            isPainting = true;
            dragStartX = coords.x;
            dragStartY = coords.y;
            lastPaintX = coords.x;
            lastPaintY = coords.y;
        }
    } else {
        // 画笔/橡皮模式
        saveToHistory();
        isPainting = true;
        lastPaintX = coords.x;
        lastPaintY = coords.y;
        paintOnMask(coords.x, coords.y, true);
    }
}

function onMouseMove(e) {
    if (!imgOpt) return;
    
    // 如果窗口缩放或者不是当前画布的操作，忽略
    const rect = editorCanvas.getBoundingClientRect();
    const coords = getCanvasCoords(e);

    if (toolMode === 'block') {
        if (resizingHandle) {
            // 拖动已有板块的手柄
            updateBlockCoordsByDrag(coords.x, coords.y);
            renderCanvas();
        } else if (isPainting) {
            // 拉出新板块选区
            renderCanvas();
            // 绘制临时的绿色拉框虚线
            ctx.save();
            ctx.strokeStyle = '#30D158';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(
                dragStartX * zoomRatio, 
                dragStartY * zoomRatio, 
                (coords.x - dragStartX) * zoomRatio, 
                (coords.y - dragStartY) * zoomRatio
            );
            ctx.restore();
        } else {
            // 悬停检测鼠标形状
            const hit = getHandleUnderMouse(e.clientX, e.clientY);
            if (hit.blockIdx !== -1) {
                if (hit.handle === 'move') {
                    editorCanvas.style.cursor = 'move';
                } else if (['nw', 'se'].includes(hit.handle)) {
                    editorCanvas.style.cursor = 'nwse-resize';
                } else if (['ne', 'sw'].includes(hit.handle)) {
                    editorCanvas.style.cursor = 'nesw-resize';
                } else if (['n', 's'].includes(hit.handle)) {
                    editorCanvas.style.cursor = 'ns-resize';
                } else if (['e', 'w'].includes(hit.handle)) {
                    editorCanvas.style.cursor = 'ew-resize';
                }
            } else {
                editorCanvas.style.cursor = 'crosshair';
            }
        }
    } else {
        if (isPainting) {
            paintOnMask(coords.x, coords.y, false);
            lastPaintX = coords.x;
            lastPaintY = coords.y;
        }
        // 浮动绘制画笔指示圈
        renderCanvas();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            ctx.save();
            ctx.strokeStyle = toolMode === 'draw' ? '#00ff66' : '#ff3333';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(coords.x * zoomRatio, coords.y * zoomRatio, (brushSize * zoomRatio) / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }
}

function onMouseUp(e) {
    if (!isPainting && !resizingHandle) return;
    
    const coords = getCanvasCoords(e);

    if (toolMode === 'block') {
        if (resizingHandle) {
            // 拖拽手柄结束：重新计算该板块对齐
            updateStatus(`正在重新对齐板块 '${blocks[activeBlockIdx].label}'...`);
            computeSingleBlockAlignment(activeBlockIdx);
            resizingHandle = null;
            renderCanvas();
        } else if (isPainting) {
            // 拉选框结束，新建板块
            const bx = Math.min(dragStartX, coords.x);
            const by = Math.min(dragStartY, coords.y);
            const bw = Math.abs(coords.x - dragStartX);
            const bh = Math.abs(coords.y - dragStartY);

            if (bw > 8 && bh > 8) {
                const newIdx = blocks.length;
                blocks.push({
                    rect: [Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh)],
                    label: `板块 ${newIdx + 1}`,
                    alignStatus: 'pending'
                });
                activeBlockIdx = newIdx;
                updateStatus(`成功创建新板块，正在自动配准...`);
                computeSingleBlockAlignment(newIdx);
            } else {
                updateStatus("选区太小，未创建板块。");
            }
            updateBlockListUI();
            renderCanvas();
        }
    }
    
    isPainting = false;
}

/* ----------------------------------------------------
   6. 笔刷涂抹底层实现
   ---------------------------------------------------- */
function paintOnMask(curX, curY, isStart) {
    if (!maskCanvas) return;

    maskCtx.save();
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = brushSize;
    // 涂抹为白（255），擦除为黑（0）
    maskCtx.strokeStyle = toolMode === 'draw' ? '#ffffff' : '#000000';

    maskCtx.beginPath();
    if (isStart) {
        maskCtx.moveTo(curX, curY);
        maskCtx.lineTo(curX, curY);
    } else {
        maskCtx.moveTo(lastPaintX, lastPaintY);
        maskCtx.lineTo(curX, curY);
    }
    maskCtx.stroke();
    maskCtx.restore();
}

/* ----------------------------------------------------
   7. 撤销历史与重置
   ---------------------------------------------------- */
function saveToHistory() {
    if (!maskCanvas) return;
    
    // 保存当前 Mask 状态快照
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = maskCanvas.width;
    tempCanvas.height = maskCanvas.height;
    tempCanvas.getContext('2d').drawImage(maskCanvas, 0, 0);
    
    maskHistory.push(tempCanvas);
    if (maskHistory.length > maxHistory) {
        maskHistory.shift();
    }
    document.getElementById('btn-undo').disabled = false;
}

function undo() {
    if (maskHistory.length === 0) return;

    const prevMask = maskHistory.pop();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(prevMask, 0, 0);

    if (maskHistory.length === 0) {
        document.getElementById('btn-undo').disabled = true;
    }
    renderCanvas();
    updateStatus("已撤销上一步涂抹。");
}

function clearMask() {
    if (!maskCanvas) return;
    saveToHistory();
    
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    
    renderCanvas();
    updateStatus("已重置所有涂抹还原区域。");
}

/* ----------------------------------------------------
   8. 板块大小及手柄判定
   ---------------------------------------------------- */
function getHandleUnderMouse(clientX, clientY) {
    for (let idx = 0; idx < blocks.length; idx++) {
        const [x, y, w, h] = blocks[idx].rect;
        
        // 映射到当前的 Canvas 坐标
        const cx1 = x * zoomRatio + offsetX + editorCanvas.parentNode.getBoundingClientRect().left;
        const cy1 = y * zoomRatio + offsetY + editorCanvas.parentNode.getBoundingClientRect().top;
        const cx2 = (x + w) * zoomRatio + offsetX + editorCanvas.parentNode.getBoundingClientRect().left;
        const cy2 = (y + h) * zoomRatio + offsetY + editorCanvas.parentNode.getBoundingClientRect().top;

        const handles = {
            nw: [cx1, cy1],
            n: [(cx1 + cx2) / 2, cy1],
            ne: [cx2, cy1],
            e: [cx2, (cy1 + cy2) / 2],
            se: [cx2, cy2],
            s: [(cx1 + cx2) / 2, cy2],
            sw: [cx1, cy2],
            w: [cx1, (cy1 + cy2) / 2]
        };

        // 8 像素感知范围
        for (const [key, [hx, hy]] of Object.entries(handles)) {
            if (Math.abs(clientX - hx) <= 8 && Math.abs(clientY - hy) <= 8) {
                return { blockIdx: idx, handle: key };
            }
        }

        // 移动判定
        if (clientX >= cx1 && clientX <= cx2 && clientY >= cy1 && clientY <= cy2) {
            return { blockIdx: idx, handle: 'move' };
        }
    }
    return { blockIdx: -1, handle: null };
}

function updateBlockCoordsByDrag(curX, curY) {
    const block = blocks[activeBlockIdx];
    const dx = curX - dragStartX;
    const dy = curY - dragStartY;
    const [sx, sy, sw, sh] = dragStartRect;

    const imgW = imgOpt.naturalWidth;
    const imgH = imgOpt.naturalHeight;

    if (resizingHandle === 'move') {
        let nx = sx + dx;
        let ny = sy + dy;
        nx = Math.max(0, Math.min(nx, imgW - sw));
        ny = Math.max(0, Math.min(ny, imgH - sh));
        block.rect = [Math.round(nx), Math.round(ny), sw, sh];
    } else {
        let ex = sx + sw;
        let ey = sy + sh;
        let newX = sx;
        let newY = sy;
        let newW = sw;
        let newH = sh;

        if (resizingHandle.includes('w')) {
            newX = Math.min(sx + dx, ex - 10);
            newW = ex - newX;
        }
        if (resizingHandle.includes('e')) {
            const possibleEx = Math.max(ex + dx, sx + 10);
            newW = possibleEx - sx;
        }
        if (resizingHandle.includes('n')) {
            newY = Math.min(sy + dy, ey - 10);
            newH = ey - newY;
        }
        if (resizingHandle.includes('s')) {
            const possibleEy = Math.max(ey + dy, sy + 10);
            newH = possibleEy - sy;
        }

        block.rect = [
            Math.max(0, Math.round(newX)),
            Math.max(0, Math.round(newY)),
            Math.min(imgW - newX, Math.round(newW)),
            Math.min(imgH - newY, Math.round(newH))
        ];
    }
}

function selectBlock(idx) {
    activeBlockIdx = idx;
    updateBlockListUI();
    renderCanvas();
}

function deleteActiveBlock() {
    if (activeBlockIdx !== -1) {
        deleteBlockByIdx(activeBlockIdx);
    }
}

function deleteBlockByIdx(idx) {
    const label = blocks[idx].label;
    blocks.splice(idx, 1);
    
    // 整理编号
    blocks.forEach((b, i) => {
        b.label = `板块 ${i + 1}`;
    });

    if (activeBlockIdx === idx) {
        activeBlockIdx = -1;
    } else if (activeBlockIdx > idx) {
        activeBlockIdx--;
    }

    updateStatus(`已移除板块: ${label}`);
    updateBlockListUI();
    recomputeAllLocalBlocks();
    renderCanvas();
}

function updateBlockListUI() {
    const listContainer = document.getElementById('block-list');
    listContainer.innerHTML = '';

    if (blocks.length === 0) {
        listContainer.innerHTML = `<div class="placeholder-text">无活跃板块。请在“文字板块”模式下在右侧画布中拉框创建。</div>`;
        return;
    }

    blocks.forEach((block, idx) => {
        const isCurrent = idx === activeBlockIdx;
        const card = document.createElement('div');
        card.className = `block-card ${isCurrent ? 'active' : ''} ${block.alignStatus}`;
        
        card.innerHTML = `
            <div class="block-card-info">
                <span class="block-card-title">${block.label} ${block.alignStatus === 'success' ? '✓' : '✗'}</span>
                <span class="block-card-size">尺寸: ${block.rect[2]}x${block.rect[3]}</span>
            </div>
            <button class="block-card-del">✕</button>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('block-card-del')) {
                e.stopPropagation();
                deleteBlockByIdx(idx);
            } else {
                selectBlock(idx);
            }
        });

        listContainer.appendChild(card);
    });
}

function drawBlocksOutline() {
    blocks.forEach((block, idx) => {
        const [x, y, w, h] = block.rect;
        const isCurrent = idx === activeBlockIdx;
        
        const cx1 = x * zoomRatio;
        const cy1 = y * zoomRatio;
        const cx2 = (x + w) * zoomRatio;
        const cy2 = (y + h) * zoomRatio;

        ctx.save();
        // 根据状态呈现红色或绿色指示线
        let outlineColor = '#0A84FF';
        if (block.alignStatus === 'success') outlineColor = isCurrent ? '#30D158' : '#248A3D';
        if (block.alignStatus === 'failed') outlineColor = isCurrent ? '#FF453A' : '#B22222';

        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = isCurrent ? 2 : 1.2;
        if (!isCurrent) {
            ctx.setLineDash([3, 3]);
        }
        ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);

        // 标签文字
        ctx.fillStyle = outlineColor;
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillText(`${block.label} [${block.alignStatus === 'success' ? '对齐成功' : '对齐失败/手动微调'}]`, cx1 + 6, cy1 + 16);

        // 如果被选中，画 8 个拉伸小圆手柄
        if (isCurrent) {
            ctx.fillStyle = outlineColor;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;

            const handles = [
                [cx1, cy1],
                [(cx1 + cx2) / 2, cy1],
                [cx2, cy1],
                [cx2, (cy1 + cy2) / 2],
                [cx2, cy2],
                [(cx1 + cx2) / 2, cy2],
                [cx1, cy2],
                [cx1, (cy1 + cy2) / 2]
            ];

            handles.forEach(([hx, hy]) => {
                ctx.beginPath();
                ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            });
        }
        ctx.restore();
    });
}

/* ----------------------------------------------------
   9. OpenCV.js 局部与全局特征匹配对齐核心算法
   ---------------------------------------------------- */
function recomputeAllLocalBlocks() {
    if (!imgOrig || !imgOpt) return;
    
    // 重置对齐底图
    const alignCtx = canvasAligned.getContext('2d');
    alignCtx.drawImage(imgOrig, 0, 0, canvasAligned.width, canvasAligned.height);

    // 重新叠算每个有效板块
    blocks.forEach((block, idx) => {
        computeSingleBlockAlignment(idx);
    });
}

function computeSingleBlockAlignment(idx) {
    if (!cvReady || idx < 0 || idx >= blocks.length) return;

    const block = blocks[idx];
    const [x, y, w, h] = block.rect;

    const scaleX = imgOrig.naturalWidth / imgOpt.naturalWidth;
    const scaleY = imgOrig.naturalHeight / imgOpt.naturalHeight;

    const xOrig = Math.round(x * scaleX);
    const yOrig = Math.round(y * scaleY);
    const wOrig = Math.round(w * scaleX);
    const hOrig = Math.round(h * scaleY);

    // 搜索扩大范围
    const padX = Math.round(70 * scaleX);
    const padY = Math.round(70 * scaleY);

    const sx = Math.max(0, xOrig - padX);
    const sy = Math.max(0, yOrig - padY);
    const ex = Math.min(imgOrig.naturalWidth, xOrig + wOrig + padX);
    const ey = Math.min(imgOrig.naturalHeight, yOrig + hOrig + padY);

    if (ex <= sx || ey <= sy) {
        block.alignStatus = 'failed';
        return;
    }

    try {
        // 1. 抓取 AI 优化图切片
        const canvasOptPatch = document.createElement('canvas');
        canvasOptPatch.width = w;
        canvasOptPatch.height = h;
        const optPatchCtx = canvasOptPatch.getContext('2d');
        optPatchCtx.drawImage(imgOpt, x, y, w, h, 0, 0, w, h);
        
        let matOptPatch = cv.imread(canvasOptPatch);
        let matOptPatchGray = new cv.Mat();
        cv.cvtColor(matOptPatch, matOptPatchGray, cv.COLOR_RGBA2GRAY);

        // 2. 抓取原图搜索切片并缩放到同尺度空间
        const searchW = ex - sx;
        const searchH = ey - sy;
        
        const canvasSearchPatch = document.createElement('canvas');
        canvasSearchPatch.width = searchW;
        canvasSearchPatch.height = searchH;
        canvasSearchPatch.getContext('2d').drawImage(imgOrig, sx, sy, searchW, searchH, 0, 0, searchW, searchH);

        const targetSearchW = Math.round(searchW / scaleX);
        const targetSearchH = Math.round(searchH / scaleY);
        
        const canvasSearchRescaled = document.createElement('canvas');
        canvasSearchRescaled.width = targetSearchW;
        canvasSearchRescaled.height = targetSearchH;
        const searchRescaledCtx = canvasSearchRescaled.getContext('2d');
        searchRescaledCtx.drawImage(canvasSearchPatch, 0, 0, targetSearchW, targetSearchH);

        let matSearchRescaled = cv.imread(canvasSearchRescaled);
        let matSearchRescaledGray = new cv.Mat();
        cv.cvtColor(matSearchRescaled, matSearchRescaledGray, cv.COLOR_RGBA2GRAY);

        let matchSuccess = false;
        let alignedPatchCanvas = document.createElement('canvas');
        alignedPatchCanvas.width = w;
        alignedPatchCanvas.height = h;
        let alignedPatchCtx = alignedPatchCanvas.getContext('2d');

        // 算法A：优先模板匹配
        if (targetSearchW >= w && targetSearchH >= h) {
            let res = new cv.Mat();
            cv.matchTemplate(matSearchRescaledGray, matOptPatchGray, res, cv.TM_CCOEFF_NORMED);
            let minMax = cv.minMaxLoc(res);
            let maxVal = minMax.maxVal;
            let maxLoc = minMax.maxLoc;

            res.delete();

            if (maxVal > 0.38) {
                const bestXOpt = maxLoc.x;
                const bestYOpt = maxLoc.y;

                const sxOpt = sx / scaleX;
                const syOpt = sy / scaleY;

                const matchXOpt = sxOpt + bestXOpt;
                const matchYOpt = syOpt + bestYOpt;

                // 计算仿射拉伸配准
                let srcTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
                    matchXOpt, matchYOpt,
                    matchXOpt + w, matchYOpt,
                    matchXOpt, matchYOpt + h
                ]);
                let dstTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
                    x, y,
                    x + w, y,
                    x, y + h
                ]);

                let M = cv.getAffineTransform(srcTri, dstTri);
                
                // 将原图大图裁切局部进行仿射变换并画到临时画布
                let matStretched = cv.imread(canvasAligned);
                let matWarped = new cv.Mat();
                cv.warpAffine(matStretched, matWarped, M, new cv.Size(canvasAligned.width, canvasAligned.height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
                
                cv.imshow(alignedPatchCanvas, matWarped.roi(new cv.Rect(x, y, w, h)));

                matStretched.delete();
                matWarped.delete();
                M.delete();
                srcTri.delete();
                dstTri.delete();

                matchSuccess = true;
            }
        }

        // 算法B：模板未中，使用高精特征匹配(ORB)
        if (!matchSuccess) {
            let orb = new cv.ORB();
            let kp1 = new cv.KeyPointVector();
            let kp2 = new cv.KeyPointVector();
            let des1 = new cv.Mat();
            let des2 = new cv.Mat();

            orb.detectAndCompute(matSearchRescaledGray, new cv.Mat(), kp1, des1);
            orb.detectAndCompute(matOptPatchGray, new cv.Mat(), kp2, des2);

            if (!des1.empty() && !des2.empty()) {
                let matcher = new cv.BFMatcher(cv.NORM_HAMMING, true);
                let matches = new cv.DMatchVector();
                matcher.match(des1, des2, matches);

                if (matches.size() >= 4) {
                    let pts1 = [];
                    let pts2 = [];
                    for (let i = 0; i < matches.size(); i++) {
                        let m = matches.get(i);
                        pts1.push(kp1.get(m.queryIdx).pt.x);
                        pts1.push(kp1.get(m.queryIdx).pt.y);
                        pts2.push(kp2.get(m.trainIdx).pt.x);
                        pts2.push(kp2.get(m.trainIdx).pt.y);
                    }

                    let matPts1 = cv.matFromArray(pts1.length / 2, 1, cv.CV_32FC2, pts1);
                    let matPts2 = cv.matFromArray(pts2.length / 2, 1, cv.CV_32FC2, pts2);

                    let hMat = cv.findHomography(matPts1, matPts2, cv.RANSAC, 3.0);

                    if (!hMat.empty()) {
                        const sxOpt = sx / scaleX;
                        const syOpt = sy / scaleY;

                        // 转换齐次坐标矩阵
                        let hMatData = hMat.data64F;
                        let H = mathMatrixMultiply(x, y, sxOpt, syOpt, hMatData);

                        let cvH = cv.matFromArray(3, 3, cv.CV_64F, H);
                        let matStretched = cv.imread(canvasAligned);
                        let matWarped = new cv.Mat();

                        cv.warpPerspective(matStretched, matWarped, cvH, new cv.Size(canvasAligned.width, canvasAligned.height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
                        cv.imshow(alignedPatchCanvas, matWarped.roi(new cv.Rect(x, y, w, h)));

                        matStretched.delete();
                        matWarped.delete();
                        cvH.delete();
                        hMat.delete();
                        matPts1.delete();
                        matPts2.delete();
                        
                        matchSuccess = true;
                    }
                }
                matches.delete();
                matcher.delete();
            }

            orb.delete();
            kp1.delete();
            kp2.delete();
            des1.delete();
            des2.delete();
        }

        // 垃圾清理
        matOptPatch.delete();
        matOptPatchGray.delete();
        matSearchRescaled.delete();
        matSearchRescaledGray.delete();

        // 3. 兜底与色彩迁移
        if (!matchSuccess) {
            // 直接物理还原
            alignedPatchCtx.drawImage(imgOrig, xOrig, yOrig, wOrig, hOrig, 0, 0, w, h);
            block.alignStatus = 'failed';
        } else {
            block.alignStatus = 'success';
        }

        // 执行 Reinhard 色彩迁移算法
        applyReinhardColorTransfer(alignedPatchCanvas, canvasOptPatch);

        // 覆盖回对齐大图
        const alignCtx = canvasAligned.getContext('2d');
        alignCtx.drawImage(alignedPatchCanvas, x, y);
        updateStatus(`板块 '${block.label}' ${matchSuccess ? '配准成功且已适配色彩' : '未寻找到特征，使用物理位置兜底'}`);

    } catch (err) {
        console.error("Block align crash:", err);
        block.alignStatus = 'failed';
    }
}

// 矩阵辅助相乘 (H_global = T_dst @ h_mat @ T_src)
function mathMatrixMultiply(x, y, sx_opt, sy_opt, h) {
    let t_dst = [
        1, 0, x,
        0, 1, y,
        0, 0, 1
    ];
    let t_src = [
        1, 0, -sx_opt,
        0, 1, -sy_opt,
        0, 0, 1
    ];

    // 中间计算 temp = h_mat @ T_src
    let temp = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let val = 0;
            for (let k = 0; k < 3; k++) {
                val += h[i * 3 + k] * t_src[k * 3 + j];
            }
            temp[i * 3 + j] = val;
        }
    }

    // 最终计算 res = T_dst @ temp
    let res = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let val = 0;
            for (let k = 0; k < 3; k++) {
                val += t_dst[i * 3 + k] * temp[k * 3 + j];
            }
            res[i * 3 + j] = val;
        }
    }
    return res;
}

/* ----------------------------------------------------
   10. Reinhard 颜色与亮度自动迁移算法 (纯 JS 实现)
   ---------------------------------------------------- */
function applyReinhardColorTransfer(srcCanvas, tgtCanvas) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    
    const srcCtx = srcCanvas.getContext('2d');
    const tgtCtx = tgtCanvas.getContext('2d');
    
    const srcImgData = srcCtx.getImageData(0, 0, w, h);
    const tgtImgData = tgtCtx.getImageData(0, 0, w, h);
    
    const srcPix = srcImgData.data;
    const tgtPix = tgtImgData.data;
    const len = srcPix.length;

    // 建立 LAB 矩阵
    let srcLab = new Float32Array(len / 4 * 3);
    let tgtLab = new Float32Array(len / 4 * 3);

    let l_mean_src = 0, a_mean_src = 0, b_mean_src = 0;
    let l_mean_tgt = 0, a_mean_tgt = 0, b_mean_tgt = 0;

    let count = len / 4;

    for (let i = 0, j = 0; i < len; i += 4, j += 3) {
        let labS = rgbToLab(srcPix[i], srcPix[i+1], srcPix[i+2]);
        srcLab[j] = labS[0];
        srcLab[j+1] = labS[1];
        srcLab[j+2] = labS[2];

        l_mean_src += labS[0];
        a_mean_src += labS[1];
        b_mean_src += labS[2];

        let labT = rgbToLab(tgtPix[i], tgtPix[i+1], tgtPix[i+2]);
        tgtLab[j] = labT[0];
        tgtLab[j+1] = labT[1];
        tgtLab[j+2] = labT[2];

        l_mean_tgt += labT[0];
        a_mean_tgt += labT[1];
        b_mean_tgt += labT[2];
    }

    l_mean_src /= count; a_mean_src /= count; b_mean_src /= count;
    l_mean_tgt /= count; a_mean_tgt /= count; b_mean_tgt /= count;

    // 计算标准差
    let l_std_src = 0, a_std_src = 0, b_std_src = 0;
    let l_std_tgt = 0, a_std_tgt = 0, b_std_tgt = 0;

    for (let j = 0; j < srcLab.length; j += 3) {
        l_std_src += Math.pow(srcLab[j] - l_mean_src, 2);
        a_std_src += Math.pow(srcLab[j+1] - a_mean_src, 2);
        b_std_src += Math.pow(srcLab[j+2] - b_mean_src, 2);

        l_std_tgt += Math.pow(tgtLab[j] - l_mean_tgt, 2);
        a_std_tgt += Math.pow(tgtLab[j+1] - a_mean_tgt, 2);
        b_std_tgt += Math.pow(tgtLab[j+2] - b_mean_tgt, 2);
    }

    l_std_src = Math.sqrt(l_std_src / count);
    a_std_src = Math.sqrt(a_std_src / count);
    b_std_src = Math.sqrt(b_std_src / count);

    l_std_tgt = Math.sqrt(l_std_tgt / count);
    a_std_tgt = Math.sqrt(a_std_tgt / count);
    b_std_tgt = Math.sqrt(b_std_tgt / count);

    const eps = 1e-5;
    l_std_src = Math.max(l_std_src, eps);
    a_std_src = Math.max(a_std_src, eps);
    b_std_src = Math.max(b_std_src, eps);

    // 颜色系数传输重算
    for (let i = 0, j = 0; i < len; i += 4, j += 3) {
        let n_l = (srcLab[j] - l_mean_src) * (l_std_tgt / l_std_src) + l_mean_tgt;
        let n_a = (srcLab[j+1] - a_mean_src) * (a_std_tgt / a_std_src) + a_mean_tgt;
        let n_b = (srcLab[j+2] - b_mean_src) * (b_std_tgt / b_std_src) + b_mean_tgt;

        n_l = Math.max(0, Math.min(100, n_l));
        n_a = Math.max(-128, Math.min(127, n_a));
        n_b = Math.max(-128, Math.min(127, n_b));

        let rgb = labToRgb(n_l, n_a, n_b);
        srcPix[i] = rgb[0];
        srcPix[i+1] = rgb[1];
        srcPix[i+2] = rgb[2];
    }

    srcCtx.putImageData(srcImgData, 0, 0);
}

// RGB <-> LAB 色彩空间算法公式
function rgbToLab(r, g, b) {
    let var_R = r / 255;
    let var_G = g / 255;
    let var_B = b / 255;

    if (var_R > 0.04045) var_R = Math.pow((var_R + 0.055) / 1.055, 2.4);
    else var_R = var_R / 12.92;
    if (var_G > 0.04045) var_G = Math.pow((var_G + 0.055) / 1.055, 2.4);
    else var_G = var_G / 12.92;
    if (var_B > 0.04045) var_B = Math.pow((var_B + 0.055) / 1.055, 2.4);
    else var_B = var_B / 12.92;

    var_R = var_R * 100;
    var_G = var_G * 100;
    var_B = var_B * 100;

    let X = var_R * 0.4124 + var_G * 0.3576 + var_B * 0.1805;
    let Y = var_R * 0.2126 + var_G * 0.7152 + var_B * 0.0722;
    let Z = var_R * 0.0193 + var_G * 0.1192 + var_B * 0.9505;

    let var_X = X / 95.047;
    let var_Y = Y / 100.000;
    let var_Z = Z / 108.883;

    if (var_X > 0.008856) var_X = Math.pow(var_X, 1/3);
    else var_X = (7.787 * var_X) + (16 / 116);
    if (var_Y > 0.008856) var_Y = Math.pow(var_Y, 1/3);
    else var_Y = (7.787 * var_Y) + (16 / 116);
    if (var_Z > 0.008856) var_Z = Math.pow(var_Z, 1/3);
    else var_Z = (7.787 * var_Z) + (16 / 116);

    let L = (116 * var_Y) - 16;
    let a = 500 * (var_X - var_Y);
    let b = 200 * (var_Y - var_Z);
    return [L, a, b];
}

function labToRgb(L, a, b) {
    let var_Y = (L + 16) / 116;
    let var_X = a / 500 + var_Y;
    let var_Z = var_Y - b / 200;

    if (Math.pow(var_Y, 3) > 0.008856) var_Y = Math.pow(var_Y, 3);
    else var_Y = (var_Y - 16 / 116) / 7.787;
    if (Math.pow(var_X, 3) > 0.008856) var_X = Math.pow(var_X, 3);
    else var_X = (var_X - 16 / 116) / 7.787;
    if (Math.pow(var_Z, 3) > 0.008856) var_Z = Math.pow(var_Z, 3);
    else var_Z = (var_Z - 16 / 116) / 7.787;

    let X = var_X * 95.047;
    let Y = var_Y * 100.000;
    let Z = var_Z * 108.883;

    X = X / 100;
    Y = Y / 100;
    Z = Z / 100;

    let var_R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
    let var_G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
    let var_B = X * 0.0557 + Y * -0.2040 + Z * 1.0570;

    if (var_R > 0.0031308) var_R = 1.055 * Math.pow(var_R, 1 / 2.4) - 0.055;
    else var_R = 12.92 * var_R;
    if (var_G > 0.0031308) var_G = 1.055 * Math.pow(var_G, 1 / 2.4) - 0.055;
    else var_G = 12.92 * var_G;
    if (var_B > 0.0031308) var_B = 1.055 * Math.pow(var_B, 1 / 2.4) - 0.055;
    else var_B = 12.92 * var_B;

    let r = Math.max(0, Math.min(255, Math.round(var_R * 255)));
    let g = Math.max(0, Math.min(255, Math.round(var_G * 255)));
    let b = Math.max(0, Math.min(255, Math.round(var_B * 255)));
    return [r, g, b];
}

/* ----------------------------------------------------
   11. 保存与无损导出图像
   ---------------------------------------------------- */
function saveResult() {
    if (!imgOpt) return;

    updateStatus("正在以高画质无损导出合成图像...");

    const w = imgOpt.naturalWidth;
    const h = imgOpt.naturalHeight;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');

    // 1. 先将 AI 增强高清大图作为底图写入
    outCtx.drawImage(imgOpt, 0, 0);

    // 2. 如果有 Mask 掩膜，进行高质量混合
    const isMaskEmpty = checkMaskEmpty();
    if (!isMaskEmpty) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = w;
        tempCanvas.height = h;
        const tempCtx = tempCanvas.getContext('2d');

        // 第一步：写入对齐原图
        tempCtx.drawImage(canvasAligned, 0, 0);

        // 第二步：使用 destination-in 应用带羽化的模糊大 Mask
        tempCtx.globalCompositeOperation = 'destination-in';
        if (featherSize > 0) {
            tempCtx.filter = `blur(${featherSize}px)`;
        }
        tempCtx.drawImage(maskCanvas, 0, 0);
        tempCtx.filter = 'none';

        // 第三步：混合回出图层
        outCtx.globalCompositeOperation = 'source-over';
        outCtx.drawImage(tempCanvas, 0, 0);
    }

    // 3. 转化为 Blob 无损下载
    outCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `AITextRestorer_Result_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
        updateStatus("无损图像保存导出成功！");
    }, 'image/png');
}

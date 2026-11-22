/* 阅读页面内的标注引擎（与 Python 版 ANNOT_JS 同源）。
   通过 postMessage 与主界面通信，页号随页面注入，保证跨页标注不错页。*/
(function () {
  // 注意：翻页用 doc.open()/write() 重写 iframe，contentWindow 不变、window.ReaderAnnot
  // 会残留。若仍用 window.ReaderAnnot 作守卫，第二页起整个脚本会提前 return，
  // 点击/滚动监听器全部丢失 —— 大型 EPUB 拆分出的「上一页/下一页」链接从此点不动。
  // 改为 document 级守卫：每次 doc.open() 都会换新 document，标记自然清零，保证每页都重新绑定。
  if (document.__mrAnnotReady) return;
  document.__mrAnnotReady = true;
  var NS = 'http://www.w3.org/2000/svg';
  var st = { tool: 'select', color: '#E53935', width: 2, anns: [], drag: null, seq: 0, preview: null };
  var PAGE = 0;

  function paper() { return document.querySelector('.paper'); }
  function svgEl() { return document.getElementById('__annot_svg'); }
  function zoom() {
    var p = paper(); if (!p) return 1;
    // 书的样式表可能给 html/body 也加了 zoom/transform，单纯读 .paper 的 zoom 会漏掉
    // 祖先缩放，导致标注整体偏移（越大越明显）。这里改用「视觉尺寸 ÷ 布局尺寸」
    // 实测真实缩放，覆盖所有祖先缩放；量不到时再退回 CSS zoom。
    var pr = p.getBoundingClientRect();
    var layout = p.offsetWidth;
    if (layout > 0) {
      var z = pr.width / layout;
      if (isFinite(z) && z > 0.05 && z < 100) return z;
    }
    var z2 = parseFloat(getComputedStyle(p).zoom);
    return (isNaN(z2) || z2 <= 0) ? 1 : z2;
  }
  function pt(ev) { var p = paper(); if (!p) return { x: 0, y: 0 }; var r = p.getBoundingClientRect(), z = zoom(); return { x: (ev.clientX - r.left) / z, y: (ev.clientY - r.top) / z }; }
  function ensure() {
    var p = paper(); if (!p) return null;
    var ov = document.getElementById('__annot_overlay'); if (ov) return ov;
    ov = document.createElement('div'); ov.id = '__annot_overlay';
    ov.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    var s = document.createElementNS(NS, 'svg'); s.id = '__annot_svg';
    s.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;';
    // 书的样式表里常有 `.paper svg { max-height:90vh !important; height:auto !important; }`
    // 这类规则会把标注画布的盒子压成 150px 高，坐标系随之内缩 —— 高亮就会整体偏上。
    // 必须用 !important 顶回去，标注层永远铺满整张纸。
    [['width', '100%'], ['height', '100%'], ['max-width', 'none'], ['max-height', 'none'],
     ['margin', '0'], ['display', 'block']].forEach(function (kv) {
      s.style.setProperty(kv[0], kv[1], 'important');
    });
    ov.appendChild(s); p.appendChild(ov); return ov;
  }
  function mk(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); e.style.pointerEvents = 'none'; return e; }
  function headPts(a, b, sz) {
    var dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy); if (l < 1) return '';
    var ux = dx / l, uy = dy / l, px = -uy, py = ux;
    var p1 = { x: b.x - ux * sz + px * sz * 0.45, y: b.y - uy * sz + py * sz * 0.45 };
    var p2 = { x: b.x - ux * sz - px * sz * 0.45, y: b.y - uy * sz - py * sz * 0.45 };
    return [b, p1, p2].map(function (q) { return q.x + ',' + q.y; }).join(' ');
  }
  function draw(a) {
    var s = svgEl(); if (!s) return;
    var g = document.createElementNS(NS, 'g'); g.setAttribute('data-ann', a.id);
    if (a.kind === 'highlight' || a.kind === 'underline') {
      for (var i = 0; i < a.data.length; i++) {
        var r = a.data[i];
        if (a.kind === 'highlight') g.appendChild(mk('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.color, 'fill-opacity': '0.35' }));
        else g.appendChild(mk('line', { x1: r.x, y1: r.y + r.h, x2: r.x + r.w, y2: r.y + r.h, stroke: a.color, 'stroke-width': a.width }));
      }
    } else {
      var d = a.data;
      if (a.kind === 'rect') g.appendChild(mk('rect', { x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), width: Math.abs(d.x2 - d.x1), height: Math.abs(d.y2 - d.y1), fill: 'none', stroke: a.color, 'stroke-width': a.width }));
      else if (a.kind === 'line') g.appendChild(mk('line', { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, stroke: a.color, 'stroke-width': a.width }));
      else if (a.kind === 'arrow') {
        g.appendChild(mk('line', { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, stroke: a.color, 'stroke-width': a.width }));
        g.appendChild(mk('polygon', { points: headPts({ x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 }, Math.max(10, a.width * 5)), fill: a.color }));
      }
    }
    s.appendChild(g);
  }
  function clear() { st.anns = []; st.seq = 0; lastRange = null; var s = svgEl(); if (s) { while (s.firstChild) s.removeChild(s.firstChild); } }
  function snapshot() {
    return st.anns.map(function (a) {
      return { kind: a.kind, color: a.color, width: a.width, data: a.data, q: a.q || null };
    });
  }

  // ---- 文本锚点：把标注钉在「全文第几个字符」上，而不是钉在绝对坐标上 ----
  // 字号/行距/字体/窗口一变，文字立刻重排，死坐标必然整体跑偏（旧版矩形框跑到下面
  // 很远就是这个原因）。所以所有标注都记一份锚点：
  //   高亮/下划线  q = {s,e,t}                —— 字符区间 + 引文
  //   矩形/直线/箭头 q = {s,t,dx,dy,fs}        —— 锚点字符 + 相对该行框的偏移 + 创建时字号
  // 恢复时按当前排版重新定位锚点，再叠加偏移；字号变化时形状按比例缩放。
  var mapCache = null;
  function textMap() {
    var p = paper(); if (!p) return null;
    var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
    var nodes = [], parts = [], textLen = 0, n, byNode = new WeakMap();
    while ((n = w.nextNode())) {
      var v = n.nodeValue; if (!v) continue;
      var entry = { n: n, s: textLen, len: v.length };
      nodes.push(entry); byNode.set(n, entry); parts.push(v); textLen += v.length;
    }
    // 大 EPUB 不能用 text += v / flat += c：反复复制整段字符串会退化成 O(n²)。
    // 数组最后一次性 join，节点下标同时放入 WeakMap，后续定位不再线性扫全页。
    var text = parts.join('');
    var flatParts = [], flatIdx = [], c;
    for (var i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0') continue;
      flatParts.push(c); flatIdx.push(i);
    }
    return { nodes: nodes, text: text, flat: flatParts.join(''), flatIdx: flatIdx, byNode: byNode };
  }
  // 一整页有几十万字符，恢复几十条标注时不能每条都重建一次映射表
  function getMap() { if (!mapCache) mapCache = textMap(); return mapCache; }
  // 点击父窗口工具条按钮的瞬间，iframe 可能短暂丢焦；个别内核会把选区清掉，
  // 导致“先选字、再点高亮”落空。这里始终记住最近一次有效选区作回退。
  var lastRange = null;
  document.addEventListener('selectionchange', function () {
    var s = window.getSelection();
    if (s && s.rangeCount && !s.isCollapsed) {
      try { lastRange = s.getRangeAt(0).cloneRange(); } catch (e) { lastRange = null; }
    }
  });
  function dropMap() { mapCache = null; }
  function curFont() { var p = paper(); if (!p) return 16; var v = parseFloat(getComputedStyle(p).fontSize); return v > 0 ? v : 16; }
  function locate(map, idx) {
    // 二分定位文本节点；大文件可能有几万个文本节点，不能每个锚点都倒序全扫。
    var lo = 0, hi = map.nodes.length - 1, best = -1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1, e = map.nodes[m];
      if (e.s <= idx) { best = m; lo = m + 1; } else hi = m - 1;
    }
    if (best < 0) return null;
    var found = map.nodes[best];
    return { n: found.n, o: Math.min(idx - found.s, found.n.nodeValue.length) };
  }
  function rangeByIndex(map, s, e) {
    var a = locate(map, s), b = locate(map, e);
    if (!a || !b) return null;
    var r = document.createRange();
    try { r.setStart(a.n, a.o); r.setEnd(b.n, b.o); } catch (err) { return null; }
    return r;
  }
  /** 中文、拉丁字母和数字常由不同字体回退渲染，Range 会返回同一行里
   *  高度/基线不同的多个矩形。直接逐个画半透明高亮会在交叠处反复叠色，
   *  下划线也会一上一下。这里先按视觉行合框，再合并水平相交的区段。 */
  function normalizeClientRects(rects) {
    var src = [];
    for (var i = 0; i < rects.length; i++) {
      var q = rects[i];
      if (q.width < 0.5 || q.height < 0.5) continue;
      src.push({ l: q.left, t: q.top, r: q.right, b: q.bottom });
    }
    src.sort(function (a, b) { return a.t - b.t || a.l - b.l; });
    var lines = [];
    for (var j = 0; j < src.length; j++) {
      var q0 = src[j], line = lines.length ? lines[lines.length - 1] : null;
      var cy = (q0.t + q0.b) / 2, same = false;
      if (line) {
        var overlap = Math.min(q0.b, line.b) - Math.max(q0.t, line.t);
        var minH = Math.max(1, Math.min(q0.b - q0.t, line.b - line.t));
        same = Math.abs(cy - line.cy) <= Math.max(2, minH * 0.45) || overlap / minH > 0.42;
      }
      if (!same) {
        line = { t: q0.t, b: q0.b, cy: cy, boxes: [] };
        lines.push(line);
      } else {
        line.t = Math.min(line.t, q0.t); line.b = Math.max(line.b, q0.b);
        line.cy = (line.t + line.b) / 2;
      }
      line.boxes.push(q0);
    }
    var out = [];
    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k], boxes = ln.boxes.sort(function (a, b) { return a.l - b.l; });
      var intervals = [];
      for (var m = 0; m < boxes.length; m++) {
        var b0 = boxes[m], last = intervals.length ? intervals[intervals.length - 1] : null;
        if (last && b0.l <= last.r + 1.25) last.r = Math.max(last.r, b0.r);
        else intervals.push({ l: b0.l, r: b0.r });
      }
      for (var n = 0; n < intervals.length; n++) {
        var iv = intervals[n];
        out.push({ left: iv.l, top: ln.t, right: iv.r, bottom: ln.b,
                   width: iv.r - iv.l, height: ln.b - ln.t });
      }
    }
    return out;
  }
  function rectsOfRange(r) {
    var p = paper(); if (!p) return null;
    var pr = p.getBoundingClientRect(), z = zoom(), out = [];
    var rc = normalizeClientRects(r.getClientRects());
    for (var i = 0; i < rc.length; i++) {
      var q = rc[i];
      out.push({ x: (q.left - pr.left) / z, y: (q.top - pr.top) / z, w: q.width / z, h: q.height / z });
    }
    return out.length ? out : null;
  }
  function selInfo() {
    var sel = window.getSelection();
    var range = null;
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      range = sel.getRangeAt(0);
    } else if (lastRange) {
      range = lastRange;                       // 选区被父窗口按钮点击清掉时用上次的
    } else {
      return null;
    }
    var text = range.toString();
    var p = paper(); if (!p) return null;
    var rects = rectsOfRange(range);
    if (!rects) return null;
    var q = null;
    try {
      var map = getMap();
      var s0 = indexOfNodeOffset(map, range.startContainer, range.startOffset, false);
      var e0 = indexOfNodeOffset(map, range.endContainer, range.endOffset, true);
      // 引文直接从映射表切，保证和下标一致（Range.toString() 会带块级换行，对不上）
      if (s0 >= 0 && e0 > s0) q = { s: s0, e: e0, t: map.text.slice(s0, Math.min(e0, s0 + 120)) };
    } catch (e) { q = null; }
    return { rects: rects, q: q };
  }
  function edgeText(node, last) {
    if (!node) return null;
    if (node.nodeType === 3) return node.nodeValue ? node : null;
    if (node.nodeType !== 1) return null;
    var cs = node.childNodes;
    for (var i = last ? cs.length - 1 : 0; last ? i >= 0 : i < cs.length; i += last ? -1 : 1) {
      var found = edgeText(cs[i], last); if (found) return found;
    }
    return null;
  }
  function indexOfNodeOffset(map, node, off, isEnd) {
    if (node && node.nodeType === 3) {
      var direct = map.byNode && map.byNode.get(node);
      return direct ? direct.s + off : -1;
    }
    if (!node || node.nodeType !== 1) return -1;
    // 整段选择时浏览器常把边界记成「元素 + 子节点序号」，而不是文本节点。
    // 归一到边界后的首个/前的最后一个文本节点，避免大书跨段选择直接丢锚点。
    var cs = node.childNodes, t, entry;
    if (!isEnd) {
      for (var i = off; i < cs.length; i++) {
        t = edgeText(cs[i], false);
        if (t) { entry = map.byNode.get(t); if (entry) return entry.s; }
      }
    }
    for (var j = Math.min(off, cs.length) - 1; j >= 0; j--) {
      t = edgeText(cs[j], true);
      if (t) { entry = map.byNode.get(t); if (entry) return entry.s + t.nodeValue.length; }
    }
    if (isEnd) {
      for (var k = off; k < cs.length; k++) {
        t = edgeText(cs[k], false);
        if (t) { entry = map.byNode.get(t); if (entry) return entry.s; }
      }
    }
    return -1;
  }
  /** 某个字符所在行框的 paper 相对坐标 —— 形状标注的锚点基准 */
  function rectOfIndex(map, idx) {
    var a = locate(map, idx); if (!a) return null;
    var len = a.n.nodeValue.length; if (len <= 0) return null;
    var o = Math.min(Math.max(a.o, 0), len - 1);
    var r = document.createRange();
    try { r.setStart(a.n, o); r.setEnd(a.n, Math.min(o + 1, len)); } catch (e) { return null; }
    var p = paper(); if (!p) return null;
    var pr = p.getBoundingClientRect(), z = zoom();
    var rc = r.getBoundingClientRect();
    if (!rc || (rc.width === 0 && rc.height === 0)) return null;
    return { x: (rc.left - pr.left) / z, y: (rc.top - pr.top) / z, w: rc.width / z, h: rc.height / z };
  }
  /** 原文下标 → 去空白文本中的下标（二分） */
  function flatIndexOf(map, s) {
    var a = map.flatIdx, lo = 0, hi = a.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < s) lo = m + 1; else hi = m; }
    return lo;
  }
  /** 用引文 + 近似下标找锚点。
   *  关键：在「去空白」文本里搜索，并取离期望位置最近的那次出现。
   *  佛经/经书这类书同一句话会重复几十次，只取首次出现必然钉错地方；
   *  而旧版存的下标是按 Range.toString() 算的（每个块级边界多一个换行），
   *  越往后偏得越多 —— 这正是「高亮比文字高一行」的成因。 */
  function findIndex(map, q) {
    var t = q.t || '';
    var s = Math.max(0, q.s || 0);
    if (!t) return s <= map.text.length ? { idx: s, len: 0 } : null;
    var qt = t.replace(/[\s\u00a0]+/g, '');
    if (!qt) return s <= map.text.length ? { idx: s, len: 0 } : null;
    var guess = flatIndexOf(map, s), best = -1, bestD = Infinity, from = 0, tries = 0;
    while (tries++ < 400) {
      var hit = map.flat.indexOf(qt, from);
      if (hit < 0) break;
      var d = Math.abs(hit - guess);
      if (d < bestD) { bestD = d; best = hit; if (d === 0) break; }
      from = hit + 1;
    }
    if (best < 0) return s <= map.text.length ? { idx: s, len: Math.min(t.length, map.text.length - s) } : null;
    var a = map.flatIdx[best];
    var b = map.flatIdx[Math.min(best + qt.length - 1, map.flatIdx.length - 1)];
    return { idx: a, len: Math.max(1, b - a + 1) };
  }
  function caretAt(x, y) {
    var p = paper(); if (!p) return null;
    var pr = p.getBoundingClientRect(), z = zoom();
    var cx = pr.left + x * z, cy = pr.top + y * z;
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(cx, cy);
    if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(cx, cy);
      if (cp && cp.offsetNode) {
        var r = document.createRange(); r.setStart(cp.offsetNode, cp.offset); r.collapse(true); return r;
      }
    }
    return null;
  }
  /** 取锚点前必须临时关掉标注层的命中测试：矩形工具下 overlay 是 pointer-events:auto，
   *  caretRangeFromPoint 会命中 overlay 自身而拿不到文字（这是"锚点存不上"的根因）。 */
  function anchorAt(px, py) {
    var ov = document.getElementById('__annot_overlay');
    var oldPE = ov ? ov.style.pointerEvents : null;
    if (ov) ov.style.pointerEvents = 'none';
    try { return anchorAtRaw(px, py); }
    finally { if (ov) ov.style.pointerEvents = oldPE; }
  }
  function anchorAtRaw(px, py) {
    var cr = caretAt(px, py);
    if (!cr) return null;
    var node = cr.startContainer;
    if (!node) return null;
    if (node.nodeType !== 3) {
      var c = node.firstChild;
      node = (c && c.nodeType === 3) ? c : null;
    }
    if (!node || !node.nodeValue) return null;
    var map = getMap();
    var idx = indexOfNodeOffset(map, node, cr.startOffset);
    if (idx < 0) return null;
    var raw = node.nodeValue.substr(cr.startOffset, 60);
    if (!raw || !raw.replace(/\s/g, '')) raw = node.nodeValue.slice(0, cr.startOffset).slice(-60);
    if (!raw || !raw.replace(/\s/g, '')) return null;
    var base = rectOfIndex(map, idx);
    if (!base) return null;
    return { s: idx, t: raw.substr(0, 60), fs: curFont(), bx: base.x, by: base.y };
  }
  /** 为形状标注取锚点：框内文字 + 相对该行框的偏移。
   *  优先取框中心（一定压在正文上），再退到四角；锚点落在框外就换下一个候选点，
   *  免得把框钉到隔壁段落上。 */
  function anchorFor(ox, oy, L, T, R, B) {
    var pts = [
      [(L + R) / 2, (T + B) / 2],
      [L + 4, T + 4],
      [L + 4, T + Math.min(24, Math.max(6, (B - T) / 2))],
      [Math.min(R - 4, L + 24), T + 4],
    ];
    for (var i = 0; i < pts.length; i++) {
      var a = anchorAt(pts[i][0], pts[i][1]);
      if (!a) continue;
      var inside = a.by >= T - 8 && a.by <= B + 8 && a.bx >= L - 12 && a.bx <= R + 12;
      if (!inside && i === 0) continue;       // 中心点没压住文字，换角点再试
      var cx = (L + R) / 2, cy = (T + B) / 2;
      return { s: a.s, t: a.t, fs: a.fs,
               dx: Math.round((ox - a.bx) * 10) / 10, dy: Math.round((oy - a.by) * 10) / 10,
               mx: Math.round((cx - a.bx) * 10) / 10, my: Math.round((cy - a.by) * 10) / 10 };
    }
    return null;
  }
  /** 高亮/下划线：按锚点重新计算每一行的矩形 */
  function relocate(a) {
    if (!a.q || !a.q.t) return null;
    var map = getMap(); if (!map || !map.text) return null;
    var f = findIndex(map, a.q);
    if (!f) return null;
    var end = f.idx + (f.len || 1);
    if (a.q.e != null && a.q.s != null) end = f.idx + Math.max(f.len || 1, (a.q.e - a.q.s) | 0);
    var r = rangeByIndex(map, f.idx, Math.min(end, map.text.length));
    if (!r) return null;
    return rectsOfRange(r);
  }
  /** 矩形/直线/箭头：锚点行框 + 记录时的偏移，字号变了按比例缩放 */
  function relocateShape(a) {
    var q = a.q; if (!q || !q.t) return null;
    var map = getMap(); if (!map || !map.text) return null;
    var f = findIndex(map, q);
    if (!f) return null;
    var base = rectOfIndex(map, f.idx);
    if (!base) return null;
    // 尺寸不跟着字号缩放：用户画多大就是多大，只让位置跟随锚点字符。
    // 早期按比例缩放的版本会把框撑到纸外，反而更不像"框住这一段"。
    var k = 1;
    var d = a.data || {};
    var ox = base.x + (q.dx || 0) * k, oy = base.y + (q.dy || 0) * k;
    if (a.kind === 'rect') {
      if (typeof d.x1 !== 'number') return null;
      var w = (d.x2 - d.x1) * k, h = (d.y2 - d.y1) * k;
      // 矩形按「框中心」对齐锚点字符：字号变了也左右均匀套住文字，不会整体歪到一侧
      var cx = base.x + (q.mx || 0) * k, cy = base.y + (q.my || 0) * k;
      return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
    }
    if (typeof d.x1 !== 'number') return null;
    return { x1: ox, y1: oy, x2: ox + (d.x2 - d.x1) * k, y2: oy + (d.y2 - d.y1) * k };
  }

  function notify() { parent.postMessage({ type: '__ANN__', page: PAGE, list: snapshot() }, '*'); }
  function add(a) { a.id = 'a' + (++st.seq) + '_' + Date.now(); st.anns.push(a); draw(a); notify(); }
  function commitSel(kind, color) {
    if (color) st.color = color;
    var info = selInfo();
    if (!info || !info.rects) return false;
    add({ kind: kind, color: st.color, width: st.width, data: info.rects, q: info.q });
    lastRange = null;                          // 已消费，避免重复点高亮又贴一次
    try { window.getSelection().removeAllRanges(); } catch (e) { }
    return true;
  }
  function mkPreview(tool, a, b) {
    var s = svgEl(); if (!s) return null;
    var g = document.createElementNS(NS, 'g');
    g.setAttribute('stroke', st.color); g.setAttribute('stroke-width', st.width);
    g.setAttribute('stroke-dasharray', '5,4'); g.setAttribute('fill', 'none'); g.style.pointerEvents = 'none';
    if (tool === 'rect' || tool === 'screenshot') {
      var r0 = mk('rect', {});
      if (tool === 'screenshot') {               // 截图预览用玫红虚线框（对齐 Python 版）
        g.setAttribute('stroke', '#FF4081'); g.setAttribute('stroke-width', '1.5');
        r0.setAttribute('fill', 'rgba(255,64,129,0.16)');
      }
      g.appendChild(r0);
    }
    else if (tool === 'line' || tool === 'arrow') { g.appendChild(mk('line', {})); if (tool === 'arrow') { var h = mk('polygon', {}); h.setAttribute('fill', st.color); g.appendChild(h); } }
    s.appendChild(g); updPreview(g, tool, a, b); return g;
  }
  function updPreview(g, tool, a, b) {
    if (!g) return;
    if (tool === 'rect' || tool === 'screenshot') {
      var r = g.firstChild;
      r.setAttribute('x', Math.min(a.x, b.x)); r.setAttribute('y', Math.min(a.y, b.y));
      r.setAttribute('width', Math.abs(b.x - a.x)); r.setAttribute('height', Math.abs(b.y - a.y));
    } else if (tool === 'line' || tool === 'arrow') {
      var l = g.firstChild;
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
      if (tool === 'arrow') { var h = g.childNodes[1]; if (h) h.setAttribute('points', headPts(a, b, Math.max(10, st.width * 5))); }
    }
  }
  function rmPreview() { if (st.preview && st.preview.parentNode) st.preview.parentNode.removeChild(st.preview); st.preview = null; }

  /** 把视口内 (clientX, clientY, w, h) 这块矩形栅格化成 PNG。
   *  用 <foreignObject> 复刻纸张内容并按偏移裁剪 —— 只栅格化选中的小矩形，
   *  不必把整张（可能十几万像素高）纸全画出来，避免 canvas 尺寸爆掉。 */
  function bookStyles() {
    var css = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      try {
        var rules = document.styleSheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) css.push(rules[j].cssText);
      } catch (e) { /* 跨域样式表不可读时保留纸张内联样式 */ }
    }
    return css.join('\n');
  }
  function svgImage(svg) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url;
      try {
        var xml = new XMLSerializer().serializeToString(svg);
        url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
      } catch (e) { reject(e); return; }
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('SVG rasterize failed')); };
      img.src = url;
    });
  }
  function captureRegion(clientX, clientY, w, h) {
    return new Promise(function (resolve) {
      var p = paper(); if (!p || w < 2 || h < 2) return resolve(null);
      var pr = p.getBoundingClientRect();
      var clone = p.cloneNode(true);
      var ov = clone.querySelector('#__annot_overlay');
      if (ov) ov.remove();                        // 第一层只画纸张，标注稍后单独合成
      var style = document.createElement('style');
      style.textContent = bookStyles();           // 克隆体离开原页面后仍保留书籍排版
      clone.insertBefore(style, clone.firstChild);
      clone.style.setProperty('position', 'absolute', 'important');
      clone.style.setProperty('margin', '0', 'important');
      clone.style.setProperty('box-shadow', 'none', 'important');
      clone.style.setProperty('left', (-(clientX - pr.left)) + 'px', 'important');
      clone.style.setProperty('top', (-(clientY - pr.top)) + 'px', 'important');

      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:' + w + 'px;height:' + h + 'px;overflow:hidden;';
      wrap.appendChild(clone);
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('xmlns', NS);
      var fo = document.createElementNS(NS, 'foreignObject');
      fo.setAttribute('width', w); fo.setAttribute('height', h);
      var host = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      host.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      host.appendChild(wrap); fo.appendChild(host); svg.appendChild(fo);

      var dpr = window.devicePixelRatio || 1;
      svgImage(svg).then(function (img) {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var live = svgEl();
        if (!live || !live.children.length) { resolve(canvas.toDataURL('image/png')); return; }

        // 第二层把当前标注 SVG 按 paper 坐标系裁剪后叠加，不能再像旧版那样删掉。
        var ann = live.cloneNode(true);
        var lw = Math.max(1, p.offsetWidth || pr.width), lh = Math.max(1, p.offsetHeight || pr.height);
        ann.setAttribute('xmlns', NS); ann.setAttribute('width', lw); ann.setAttribute('height', lh);
        ann.setAttribute('viewBox', '0 0 ' + lw + ' ' + lh);
        ann.style.cssText = 'display:block;overflow:visible;pointer-events:none;';
        ann.style.setProperty('width', lw + 'px', 'important');
        ann.style.setProperty('height', lh + 'px', 'important');
        svgImage(ann).then(function (annImg) {
          var sx = (clientX - pr.left) / pr.width * lw, sy = (clientY - pr.top) / pr.height * lh;
          var sw = w / pr.width * lw, sh = h / pr.height * lh;
          ctx.drawImage(annImg, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        }).catch(function () { resolve(canvas.toDataURL('image/png')); });
      }).catch(function () { resolve(null); });
    });
  }
  function onDown(ev) {
    if (ev.button !== 0) return; ev.preventDefault(); ev.stopPropagation();
    st.drag = { start: pt(ev), cur: pt(ev) }; rmPreview();
    st.preview = mkPreview(st.tool, st.drag.start, st.drag.cur);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }
  function onMove(ev) { if (!st.drag) return; ev.preventDefault(); st.drag.cur = pt(ev); updPreview(st.preview, st.tool, st.drag.start, st.drag.cur); }
  function onUp(ev) {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (!st.drag) return;
    var a = st.drag.start, b = pt(ev); st.drag = null; rmPreview();
    if (Math.hypot(b.x - a.x, b.y - a.y) < 4) return;
    if (st.tool === 'screenshot') {
      // 自由矩形截图：把拖出的这块区域栅格化成 PNG，交回主界面保存/复制
      var L = Math.min(a.x, b.x), T = Math.min(a.y, b.y);
      var R = Math.max(a.x, b.x), B = Math.max(a.y, b.y);
      var p = paper(); if (!p) return;
      var pr = p.getBoundingClientRect(), z = zoom();
      var cx = pr.left + L * z, cy = pr.top + T * z;
      var cw = (R - L) * z, ch = (B - T) * z;
      if (cw < 5 || ch < 5) return;
      captureRegion(cx, cy, cw, ch).then(function (dataUrl) {
        parent.postMessage({ type: '__SHOT__', page: PAGE, dataUrl: dataUrl }, '*');
      });
      return;
    }
    // 形状标注同样要锚点：只存死坐标的话，换个字号或换台机器打开就整体跑偏
    var L = Math.min(a.x, b.x), T = Math.min(a.y, b.y);
    var R = Math.max(a.x, b.x), B = Math.max(a.y, b.y);
    add({ kind: st.tool, color: st.color, width: st.width,
          data: { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
          q: anchorFor(a.x, a.y, L, T, R, B) });
  }

  window.ReaderAnnot = {
    setTool: function (tool, color, width) {
      st.tool = tool || 'select'; if (color) st.color = color; if (width) st.width = width;
      var ov = ensure(); if (!ov) return;
      var shape = (st.tool === 'line' || st.tool === 'arrow' || st.tool === 'rect' || st.tool === 'screenshot');
      ov.style.pointerEvents = shape ? 'auto' : 'none';
      ov.style.cursor = shape ? 'crosshair' : 'default';
      document.body.style.userSelect = shape ? 'none' : '';
      ov.onmousedown = shape ? onDown : null;
    },
    annotateSelection: function (kind, color) { return commitSel(kind, color); },
    undo: function () {
      if (!st.anns.length) return;
      var a = st.anns.pop();
      var el = document.querySelector('[data-ann="' + a.id + '"]');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      notify();
    },
    clearAll: function () { clear(); notify(); },
    setPage: function (n) { PAGE = parseInt(n, 10) || 0; },
    dump: function () { return { page: PAGE, list: snapshot(), count: st.anns.length }; },
    restore: function (list) {
      clear();
      dropMap();                        // 换了 DOM，字符映射表必须重建
      (list || []).forEach(function (a) {
        if (!a || !a.kind) return;
        var o = { kind: a.kind, color: a.color || '#FDD835', width: a.width || 2, data: a.data, q: a.q || null };
        if (a.kind === 'highlight' || a.kind === 'underline') {
          // 优先按文本锚点重新定位：字号/窗口变了也贴得住原文
          var rects = relocate(o);
          if (rects) o.data = rects;
          if (!Array.isArray(o.data)) return;
        } else {
          if (!o.data || typeof o.data.x1 !== 'number') return;
          var pos = relocateShape(o);   // 矩形/线/箭头：锚点 + 偏移，旧坐标只作兜底
          if (pos) o.data = pos;
        }
        o.id = 'r' + (++st.seq) + '_' + Date.now(); st.anns.push(o); draw(o);
      });
    },
    /** 字号/行距/字体/缩放一变，文字重排 → 全部标注重新锚定重画，并把新坐标回传保存。
     *  对应 Python 版 apply_format 之后重新 restore 的时序。 */
    relayout: function () {
      dropMap();
      var svg = svgEl();
      if (svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
      st.anns.forEach(function (a) {
        if (a.kind === 'highlight' || a.kind === 'underline') {
          var r = relocate(a); if (r) a.data = r;
        } else {
          var pos = relocateShape(a); if (pos) a.data = pos;
        }
        draw(a);
      });
      notify();
      return snapshot();
    },
    scrollToAnchor: function (id) { return jumpToAnchor(id); },
    scrollToPercent: function (pct) {
      var total = document.documentElement.scrollHeight - window.innerHeight;
      // 边界值无条件滚动：doc.open()/write() 重写 iframe 后，部分内核（WebView2）
      // 会保留旧页面的 scrollY，导致「下一页」加载完停在底部而非首页。
      // 这里 0 就强制回顶部、100 就强制到底部，不依赖 total>0 的判断。
      if (pct <= 0) { window.scrollTo(0, 0); return; }
      if (pct >= 100) { window.scrollTo(0, Math.max(0, total)); return; }
      if (total > 0) window.scrollTo(0, pct * total / 100);
    },
    applyStyle: function (font, size, spacing, zoomVal) {
      var p = paper(); if (!p) return;
      p.style.fontSize = size + 'px'; p.style.fontFamily = font; p.style.lineHeight = String(spacing);
      p.style.zoom = zoomVal;
      dropMap();                        // 排版变了，字符映射表失效
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.nodeType === 1 && el.tagName !== 'A') { el = el.parentNode; }
    if (!el || el.nodeType !== 1 || el.tagName !== 'A') return;
    var href = el.getAttribute('href') || '';
    if (!href) return;
    if (/^javascript:/i.test(href)) { e.preventDefault(); return; }
    if (href.indexOf('epub://') === 0) {
      e.preventDefault();
      parent.postMessage({ type: '__NAV__', href: href, page: PAGE }, '*');
      return;
    }
    if (/^https?:/i.test(href)) {
      e.preventDefault();
      parent.postMessage({ type: '__EXTERNAL__', href: href }, '*');
      return;
    }
    if (href.charAt(0) === '#') {
      var id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (err) { /* 保留原样 */ }
      if (!id) { e.preventDefault(); window.scrollTo(0, 0); return; }
      // 找到锚点才接管；找不到就放行浏览器原生的 hash 跳转，避免“点了没反应”
      if (findAnchor(id)) { e.preventDefault(); jumpToAnchor(id); }
      return;
    }
    // 其余任何相对链接（跨文件 .xhtml/.html、未重写的原始路径等）都交给父窗口解析，
    // 避免浏览器在 iframe 里直接导航到一个不存在的相对地址而“点了没反应”。
    e.preventDefault();
    parent.postMessage({ type: '__NAV__', href: href, page: PAGE }, '*');
  }, true);

  window.addEventListener('scroll', function () {
    var total = document.documentElement.scrollHeight - window.innerHeight;
    var pct = total > 0 ? Math.round(window.scrollY / total * 100) : 100;
    parent.postMessage({ type: '__PROGRESS__', pct: pct }, '*');
  }, { passive: true });

  // ---- 目录/链接跳转 ----
  // 不用 scrollIntoView：它在 data-URI 图片解码之前执行时，文档高度还偏小，
  // 滚动量会被 maxScroll 截断，等图片撑开页面后目标就落到屏幕外（"点了没反应"）。
  // 这里直接算目标位置，并在短周期内多次校正；图片每次 load 完成也再校一次。
  var anchorId = null, anchorTimers = [];
  function findAnchor(id) {
    // 锚点可能是「章锚点」chap_5_sec；若该具体锚点未被后端保留（不在 preservable 集合里），
    // 后端只生成 chap_5（章包装 div）。这里回退到章节点，保证链接仍然能落到目标章。
    var ids = [id];
    var m = /^(chap_\d+)_.+$/.exec(id);
    if (m) ids.push(m[1]);
    for (var k = 0; k < ids.length; k++) {
      var cur = ids[k];
      var el = document.getElementById(cur) || document.getElementsByName(cur)[0];
      if (el) return el;
      try {
        var d = decodeURIComponent(cur);
        if (d !== cur) el = document.getElementById(d) || document.getElementsByName(d)[0];
      } catch (e) { /* 保留原样 */ }
      if (el) return el;
    }
    return null;
  }
  function jumpToAnchor(id) {
    anchorId = id;
    anchorTimers.forEach(clearTimeout); anchorTimers = [];
    var run = function () {
      if (!anchorId) return false;
      var el = findAnchor(anchorId);
      if (!el) return false;
      var top = el.getBoundingClientRect().top;
      var y = Math.max(0, window.scrollY + top - 8);
      if (Math.abs(y - window.scrollY) > 1) window.scrollTo(0, y);
      // 目标在页面靠尾部时滚不到顶，给个短促的描边提示，让用户知道"已经到了"
      try {
        el.style.setProperty('outline', '2px solid rgba(255,201,74,.9)', 'important');
        el.style.setProperty('outline-offset', '3px', 'important');
        setTimeout(function () { el.style.setProperty('outline', 'none', 'important'); }, 1400);
      } catch (e) { /* 忽略 */ }
      return true;
    };
    if (!run()) return false;
    [40, 150, 400, 900, 1800].forEach(function (d) { anchorTimers.push(setTimeout(run, d)); });
    return true;
  }
  function watchImages() {
    var p = paper(); if (!p) return;
    var imgs = p.getElementsByTagName('img');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].__mrWatch) continue;
      imgs[i].__mrWatch = 1;
      imgs[i].addEventListener('load', function () { if (anchorId) jumpToAnchor(anchorId); });
    }
  }
  // 用户自己滚动就放弃兜底校正，别跟用户抢滚动条
  window.addEventListener('wheel', function () { anchorId = null; anchorTimers.forEach(clearTimeout); anchorTimers = []; }, { passive: true });
  window.addEventListener('touchstart', function () { anchorId = null; }, { passive: true });

  // ---- 排版自愈 ----
  // 字体（微软雅黑等）或图片晚一步就绪时，文字会重排；标注是按时排版算的坐标，
  // 重排后就整体偏移。这里在字体就绪、窗口尺寸变化、页面 load 之后再复算一次。
  var fixTimer = null;
  function softRelayout() {
    if (!st.anns.length) return;
    clearTimeout(fixTimer);
    fixTimer = setTimeout(function () {
      dropMap();
      var svg = svgEl();
      if (svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
      st.anns.forEach(function (a) {
        if (a.kind === 'highlight' || a.kind === 'underline') {
          var r = relocate(a); if (r) a.data = r;
        } else {
          var pos = relocateShape(a); if (pos) a.data = pos;
        }
        draw(a);
      });
      notify();
    }, 120);
  }
  window.addEventListener('resize', softRelayout);
  window.addEventListener('load', function () { watchImages(); softRelayout(); });

  function boot() {
    ensure(); watchImages();
    try {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { softRelayout(); });
    } catch (e) { /* 老内核没有 FontFaceSet */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

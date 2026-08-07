/* ============================================================
   차트 — 외부 라이브러리 없이 SVG를 직접 그린다.
   (yeju·kihoon·SOMIN이 모두 이 방식이었고, 의존성 0이라 배포가 단순하다)
   ============================================================ */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    return node;
  };

  const fmtMan = (n) => Math.round(n).toLocaleString("ko-KR");
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;

  /* ---------- 툴팁 ---------- */
  const tip = () => document.getElementById("tooltip");
  function bindTip(node, html) {
    node.addEventListener("pointerenter", (e) => {
      const t = tip();
      t.innerHTML = html;
      t.hidden = false;
      moveTip(e);
    });
    node.addEventListener("pointermove", moveTip);
    node.addEventListener("pointerleave", () => { tip().hidden = true; });
  }
  function moveTip(e) {
    const t = tip();
    t.style.left = e.clientX + "px";
    t.style.top = (e.clientY - 10) + "px";
  }

  /* ---------- 세로 막대 (연봉 비교) ---------- */
  function barChart(mount, bars) {
    const W = 620, H = 214, padT = 28, padB = 40, padX = 20;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    const max = Math.max(...bars.map((b) => b.value), 1) * 1.16;
    const plotH = H - padT - padB;
    const slot = (W - padX * 2) / bars.length;
    const barW = Math.min(96, slot * 0.5);

    // 기준선
    svg.appendChild(el("line", { x1: padX, y1: H - padB, x2: W - padX, y2: H - padB, class: "axis-line" }));

    bars.forEach((b, i) => {
      const h = Math.max(2, (b.value / max) * plotH);
      const cx = padX + slot * i + slot / 2;
      const x = cx - barW / 2;
      const y = H - padB - h;

      const rect = el("rect", {
        x, y, width: barW, height: h, rx: 7, fill: b.color,
      });
      bindTip(rect, `<b>${b.label}</b><br>${fmtMan(b.value)}만원`);
      svg.appendChild(rect);

      const val = el("text", { x: cx, y: y - 9, "text-anchor": "middle", class: "bar-value" });
      val.textContent = `${fmtMan(b.value)}만`;
      svg.appendChild(val);

      const lab = el("text", { x: cx, y: H - padB + 19, "text-anchor": "middle", class: "axis-text" });
      lab.textContent = b.label;
      svg.appendChild(lab);

      if (b.sub) {
        const sub = el("text", { x: cx, y: H - padB + 34, "text-anchor": "middle", class: "axis-text" });
        sub.textContent = b.sub;
        sub.setAttribute("fill", b.subColor || "currentColor");
        svg.appendChild(sub);
      }
    });

    mount.replaceChildren(svg);
  }

  /* ---------- 가로 막대 (시나리오 비교) ---------- */
  function hBarChart(mount, rows, unit = "만원") {
    const W = 620, rowH = 44, padL = 92, padR = 74, padT = 10;
    const H = padT + rows.length * rowH + 10;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    const max = Math.max(...rows.map((r) => r.value), 1) * 1.05;
    const trackW = W - padL - padR;

    rows.forEach((r, i) => {
      const y = padT + i * rowH + 8;
      const w = Math.max(3, (r.value / max) * trackW);

      const lab = el("text", { x: padL - 12, y: y + 15, "text-anchor": "end", class: "axis-text" });
      lab.textContent = r.label;
      svg.appendChild(lab);

      svg.appendChild(el("rect", {
        x: padL, y, width: trackW, height: 21, rx: 6, fill: "var(--surface-sunk)",
      }));
      const bar = el("rect", { x: padL, y, width: w, height: 21, rx: 6, fill: r.color });
      bindTip(bar, `<b>${r.label}</b><br>${fmtMan(r.value)}${unit}${r.note ? "<br>" + r.note : ""}`);
      svg.appendChild(bar);

      const val = el("text", { x: padL + trackW + 8, y: y + 15, class: "bar-value" });
      val.textContent = `${fmtMan(r.value)}${unit}`;
      svg.appendChild(val);
    });

    mount.replaceChildren(svg);
  }

  /* ---------- 라인 차트 (성장 곡선 / 타임머신) ---------- */
  function lineChart(mount, opts) {
    const {
      series,           // [{ id, label, color, points:[{x,y,meta}], dashed }]
      yFormat = (v) => fmtMan(v),
      xLabels = [],     // [{ at, text }]  at = x값
      target = null,    // { value, label }
      yZeroBase = false,
    } = opts;

    const W = 720, H = 320, padL = 58, padR = 16, padT = 18, padB = 34;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const all = series.flatMap((s) => s.points);
    if (!all.length) { mount.replaceChildren(svg); return; }

    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    if (target) ys.push(target.value);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    let yMin = yZeroBase ? 0 : Math.min(...ys), yMax = Math.max(...ys);
    const padY = (yMax - yMin) * 0.08 || 1;
    yMax += padY;
    if (!yZeroBase) yMin -= padY;

    const sx = (x) => padL + (xMax === xMin ? 0.5 : (x - xMin) / (xMax - xMin)) * plotW;
    const sy = (y) => padT + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH;

    // 가로 격자 + y축 라벨
    const TICKS = 4;
    for (let i = 0; i <= TICKS; i++) {
      const v = yMin + ((yMax - yMin) / TICKS) * i;
      const y = sy(v);
      svg.appendChild(el("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "grid-line" }));
      const t = el("text", { x: padL - 9, y: y + 4, "text-anchor": "end", class: "axis-text" });
      t.textContent = yFormat(v);
      svg.appendChild(t);
    }

    // x축 라벨
    xLabels.forEach((l) => {
      const t = el("text", { x: sx(l.at), y: H - padB + 19, "text-anchor": "middle", class: "axis-text" });
      t.textContent = l.text;
      svg.appendChild(t);
    });

    // 목표선
    if (target) {
      const y = sy(target.value);
      svg.appendChild(el("line", {
        x1: padL, y1: y, x2: W - padR, y2: y,
        stroke: "var(--good)", "stroke-width": 1.5, "stroke-dasharray": "5 4",
      }));
      const t = el("text", { x: W - padR, y: y - 7, "text-anchor": "end", class: "series-label" });
      t.setAttribute("fill", "var(--good-text)");
      t.textContent = target.label;
      svg.appendChild(t);
    }

    // 시리즈
    series.forEach((s) => {
      if (!s.points.length) return;
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(" ");
      svg.appendChild(el("path", {
        d, fill: "none", stroke: s.color, "stroke-width": s.dashed ? 1.6 : 2.2,
        "stroke-dasharray": s.dashed ? "5 4" : null,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));

      // 마지막 점 강조
      const last = s.points[s.points.length - 1];
      const dot = el("circle", { cx: sx(last.x), cy: sy(last.y), r: 3.6, fill: s.color });
      bindTip(dot, `<b>${s.label}</b><br>${yFormat(last.y)}`);
      svg.appendChild(dot);
    });

    // 마우스 위치 기준 값 표시용 투명 오버레이
    const hover = el("rect", {
      x: padL, y: padT, width: plotW, height: plotH, fill: "transparent",
    });
    hover.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const xVal = xMin + ((px - padL) / plotW) * (xMax - xMin);
      const parts = series.map((s) => {
        let best = null, bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p.x - xVal);
          if (d < bestD) { bestD = d; best = p; }
        }
        return best ? `<span style="color:${s.color}">■</span> ${s.label} ${yFormat(best.y)}` : "";
      }).filter(Boolean);
      const near = series[0].points.reduce((a, p) =>
        Math.abs(p.x - xVal) < Math.abs(a.x - xVal) ? p : a, series[0].points[0]);
      const t = tip();
      t.innerHTML = `<b>${near.meta || ""}</b><br>${parts.join("<br>")}`;
      t.hidden = false;
      moveTip(e);
    });
    hover.addEventListener("pointerleave", () => { tip().hidden = true; });
    svg.appendChild(hover);

    mount.replaceChildren(svg);
  }

  /* ---------- 기여도 분해 (내 물가) ----------
     각 품목이 내 물가를 몇 %p 밀어올렸는지 보여준다.
     막대 길이 = 지출비중 × 그 품목의 물가상승률                        */
  function contributionChart(mount, rows, opts = {}) {
    const { officialRate = null, personalRate = null } = opts;
    const W = 680, rowH = 22, padL = 128, padR = 92, padT = 22, padB = 6;
    const H = padT + rows.length * rowH + padB;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });

    const maxC = Math.max(...rows.map((r) => Math.abs(r.contribution)), 0.05);
    const trackW = W - padL - padR;
    const zeroX = padL + (rows.some((r) => r.contribution < 0) ? trackW * 0.16 : 0);
    const scale = (rows.some((r) => r.contribution < 0) ? trackW * 0.84 : trackW) / maxC;

    // 0 기준선
    svg.appendChild(el("line", {
      x1: zeroX, y1: padT - 6, x2: zeroX, y2: H - padB, class: "axis-line",
    }));
    const zt = el("text", { x: zeroX, y: padT - 12, "text-anchor": "middle", class: "axis-text" });
    zt.textContent = "0%p";
    svg.appendChild(zt);

    rows.forEach((r, i) => {
      const y = padT + i * rowH;
      const w = Math.abs(r.contribution) * scale;
      const x = r.contribution >= 0 ? zeroX : zeroX - w;
      const positive = r.contribution >= 0;

      const lab = el("text", { x: padL - 10, y: y + 15, "text-anchor": "end", class: "axis-text" });
      lab.textContent = r.name;
      svg.appendChild(lab);

      const bar = el("rect", {
        x, y: y + 4, width: Math.max(w, 1.5), height: 17, rx: 4,
        fill: positive ? r.color : "var(--series-1)",
        opacity: r.weight > 0 ? 1 : 0.25,
      });
      bindTip(bar,
        `<b>${r.name}</b><br>` +
        `지출 비중 ${(r.weight * 100).toFixed(1)}% (${fmtMan(r.amount)}만원)<br>` +
        `이 품목 물가 ${r.rate >= 0 ? "+" : ""}${r.rate.toFixed(2)}%<br>` +
        `→ 내 물가에 <b>${r.contribution >= 0 ? "+" : ""}${r.contribution.toFixed(2)}%p</b> 기여`);
      svg.appendChild(bar);

      const val = el("text", {
        x: positive ? x + w + 8 : x - 8, y: y + 17,
        "text-anchor": positive ? "start" : "end", class: "bar-value",
      });
      val.textContent = `${r.contribution >= 0 ? "+" : ""}${r.contribution.toFixed(2)}%p`;
      svg.appendChild(val);
    });

    mount.replaceChildren(svg);
  }

  global.Charts = { barChart, hBarChart, lineChart, contributionChart, fmtMan, pct };
})(window);

/* ============================================================
   진입 애니메이션 (v20 항목2) — 카드가 화면에 나타날 때(스와이프/전환)
   그래프·숫자가 0.5~1초 안에 짧게 채워지는 연출. 외부 라이브러리 없이
   requestAnimationFrame으로 직접 구현한다 — CLAUDE.md가 빌드 도구·
   외부 의존성 추가를 금지해서, 이미 쓰는 SVG/CSS 위에서 처리한다.
   차트는 charts.js가 값이 바뀔 때마다(입력값 수정 등) 다시 그리므로,
   애니메이션을 차트 생성 시점에 바로 재생하면 카드가 아직 화면 밖에
   있을 때(다른 카드가 활성) 다 끝나버린다 — 그래서 charts.js는
   "숨긴 시작 상태"만 만들어 두고, 실제 재생은 카드 전환 훅
   (setupCardDeck의 syncUI → playCardEntrance)이 그 카드에 들어올
   때마다 새로 트리거한다. */
(function (global) {
  "use strict";

  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  function animateValue(duration, onFrame, onDone) {
    if (reduceMotion()) { onFrame(1); if (onDone) onDone(); return; }
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      onFrame(easeOutCubic(t));
      if (t < 1) requestAnimationFrame(tick);
      else if (onDone) onDone();
    }
    requestAnimationFrame(tick);
  }

  // 이미 최종 텍스트가 렌더링된 엘리먼트를 받아, 그 안의 숫자만 뽑아
  // 0→최종값으로 카운트업한다. 접두/접미 텍스트("만원", "%", "+" 등)는
  // 그대로 두고 숫자만 다시 그린다 — 렌더 함수마다 애니메이션을 따로
  // 배선할 필요 없이, 이미 만들어진 문구를 "되감아 재생"하는 방식이다.
  function countUpText(el, opts = {}) {
    if (!el) return;
    const { duration = 700 } = opts;
    const raw = el.textContent;
    const m = raw.match(/-?[\d,]+(\.\d+)?/);
    if (!m) return;
    const numStr = m[0];
    const finalNum = parseFloat(numStr.replace(/,/g, ""));
    if (!Number.isFinite(finalNum)) return;
    const decimals = numStr.includes(".") ? numStr.split(".")[1].length : 0;
    const prefix = raw.slice(0, m.index);
    const suffix = raw.slice(m.index + numStr.length);
    const useComma = numStr.includes(",");
    const fmt = (n) => {
      const fixed = n.toFixed(decimals);
      if (!useComma) return fixed;
      const [intPart, decPart] = fixed.split(".");
      const withComma = Number(intPart).toLocaleString("ko-KR");
      return decPart ? `${withComma}.${decPart}` : withComma;
    };
    if (reduceMotion()) { el.textContent = raw; return; }
    animateValue(duration, (p) => {
      el.textContent = `${prefix}${fmt(finalNum * p)}${suffix}`;
    }, () => { el.textContent = raw; });
  }

  // SVG 선그래프 path — stroke-dashoffset을 path 길이만큼 걸었다가
  // 0으로 줄이면 왼쪽부터 그려지는 것처럼 보인다.
  function drawLine(path, opts = {}) {
    if (!path) return;
    const { duration = 800 } = opts;
    let length;
    try { length = path.getTotalLength(); } catch { return; }
    if (!length) return;
    path.style.transition = "none";
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    path.getBoundingClientRect(); // 강제 리플로우 — transition 없이 적용된 시작 상태를 먼저 확정
    if (reduceMotion()) { path.style.strokeDashoffset = "0"; return; }
    path.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(.22,.61,.36,1)`;
    requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
  }

  // SVG 막대(rect) — 이미 그려진 최종 x/y/width/height는 그대로 두고
  // transform:scale만 0→1로 키운다(레이아웃을 다시 계산할 필요가 없어
  // 가볍다). axis="y"는 세로 막대(아래에서 위로), "x"는 가로 막대
  // (origin 방향에서부터) 자라난다.
  function growBar(rect, opts = {}) {
    if (!rect) return;
    const { duration = 600, axis = "y", origin, delay = 0 } = opts;
    const finalOrigin = origin || (axis === "y" ? "bottom" : "left");
    rect.style.transformBox = "fill-box";
    rect.style.transformOrigin = finalOrigin;
    rect.style.transition = "none";
    rect.style.transform = axis === "y" ? "scaleY(0)" : "scaleX(0)";
    rect.getBoundingClientRect();
    if (reduceMotion()) { rect.style.transform = "none"; return; }
    rect.style.transition = `transform ${duration}ms cubic-bezier(.22,.61,.36,1) ${delay}ms`;
    requestAnimationFrame(() => { rect.style.transform = axis === "y" ? "scaleY(1)" : "scaleX(1)"; });
  }

  // 도넛/스코어 링(conic-gradient) — stops(각 구간의 최종 색·시작·끝 %)를
  // progress(0~1)로 스케일해서 매 프레임 background를 다시 계산한다.
  // 예: stops=[{color:"#f00", from:0, to:32}], progress=0.5면
  // "0~16%만 채워진" 중간 상태의 conic-gradient를 만든다.
  function growDonut(el, stops, opts = {}) {
    if (!el) return;
    const { duration = 700, baseColor = "var(--surface-sunk)" } = opts;
    const build = (p) => {
      const segs = stops.map((s) => `${s.color} ${(s.from * p).toFixed(2)}% ${(s.to * p).toFixed(2)}%`);
      return `conic-gradient(${segs.join(",")}, ${baseColor} 0)`;
    };
    if (reduceMotion()) { el.style.background = build(1); return; }
    el.style.background = build(0);
    animateValue(duration, (p) => { el.style.background = build(p); });
  }

  // 카드(.deck-card) 하나에 들어있는 애니메이션 대상을 전부 찾아
  // 재생한다. charts.js가 심어둔 data-anim 마커, app.js가 심어둔
  // data-donut-stops를 읽는다.
  function playCardEntrance(container) {
    if (!container) return;
    container.querySelectorAll('[data-anim="bar-y"]').forEach((el, i) => growBar(el, { axis: "y", delay: i * 35 }));
    container.querySelectorAll('[data-anim="bar-x"]').forEach((el, i) =>
      growBar(el, { axis: "x", origin: el.dataset.animOrigin || "left", delay: i * 35 }));
    container.querySelectorAll('[data-anim="line"]').forEach((el) => drawLine(el));
    container.querySelectorAll('[data-donut-stops]').forEach((el) => {
      let stops;
      try { stops = JSON.parse(el.dataset.donutStops); } catch { return; }
      growDonut(el, stops, { baseColor: el.dataset.donutBase || "var(--surface-sunk)" });
    });
    // .score-num처럼 숫자 바깥에 "점" 같은 형제 텍스트가 같이 있는
    // 래퍼가 아니라, 숫자만 담긴 가장 안쪽 엘리먼트만 골라야 한다 —
    // 래퍼의 textContent를 통째로 바꾸면 그 안의 자식 엘리먼트(예:
    // #scoreNum)가 같이 지워진다.
    container.querySelectorAll(".stat .v, .price-compare-value, .scenario-rate b, #scoreNum")
      .forEach((el) => countUpText(el));
  }

  global.Animate = { countUpText, drawLine, growBar, growDonut, playCardEntrance, reduceMotion };
})(window);

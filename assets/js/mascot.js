/* ============================================================
   마스코트 캐릭터 (v22 "닥터" 컨셉) — 표정만으로 친근함을 표현하는
   간단한 벡터(SVG) 캐릭터. 실제 일러스트가 준비되기 전까지 쓰는
   자리표시자라서, 포즈 이름(greet/good/reassure)만으로 호출하고
   나중에 이 파일 하나만 실제 일러스트로 바꿔 끼우면 되게 컴포넌트를
   분리했다(호출부는 Mascot.svg(pose)만 알면 된다). 외부 라이브러리·
   이미지 파일 없이 인라인 SVG라 다양한 크기에서도 안 깨진다.
   ============================================================ */
(function (global) {
  "use strict";

  // 포즈 3종 — 눈·입 모양만 바꿔서 표정을 표현한다.
  // greet: 카드 진입 시 기본 인사("어디 한번 볼까요?")
  // good: 물가를 이기는 케이스(B) — 활짝 웃는 얼굴
  // reassure: 물가를 못 이기는 케이스(A) — 눈을 살짝 접고 안심시키는 얼굴(걱정 표정 아님)
  const FACES = {
    greet: {
      eyes: '<circle cx="38" cy="52" r="3.4" fill="var(--text-primary)"/><circle cx="62" cy="52" r="3.4" fill="var(--text-primary)"/>',
      mouth: '<path d="M42 64q8 7 16 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    },
    good: {
      eyes: '<path d="M33 51q5-5 10 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M57 51q5-5 10 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
      mouth: '<path d="M40 62q10 11 20 0" stroke="var(--text-primary)" stroke-width="2.8" fill="none" stroke-linecap="round"/>',
    },
    reassure: {
      eyes: '<path d="M34 53q4-3 8 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M58 53q4-3 8 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
      mouth: '<path d="M43 65q7 4 14 0" stroke="var(--text-primary)" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    },
  };

  // 말풍선에 곁들일 기본 코멘트 — 호출부에서 필요하면 자체 문구로
  // 덮어써도 된다(예: 케이스 A/B에 맞춘 진단 소견).
  const DEFAULT_LINES = {
    greet: "어디 한번 볼까요?",
    good: "차근차근 살펴봤어요, 잘하고 계세요!",
    reassure: "괜찮아요, 처방을 같이 볼게요.",
  };

  function svg(pose = "greet", opts = {}) {
    const { size = 96, className = "" } = opts;
    const face = FACES[pose] || FACES.greet;
    return `
      <svg class="mascot-svg ${className}" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="연봉닥터 캐릭터" style="overflow:visible">
        <!-- 몸통 -->
        <circle cx="50" cy="55" r="38" fill="var(--brand-soft)" stroke="var(--brand)" stroke-width="3"/>
        <!-- 볼 -->
        <circle cx="28" cy="60" r="5" fill="var(--brand)" opacity=".35"/>
        <circle cx="72" cy="60" r="5" fill="var(--brand)" opacity=".35"/>
        <!-- 얼굴 -->
        ${face.eyes}
        ${face.mouth}
      </svg>`;
  }

  function bubbleHtml(pose, text) {
    const line = text || DEFAULT_LINES[pose] || DEFAULT_LINES.greet;
    return `<p class="mascot-bubble">${line}</p>`;
  }

  global.Mascot = { svg, bubbleHtml, DEFAULT_LINES };
})(window);

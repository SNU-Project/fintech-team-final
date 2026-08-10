/* ============================================================
   생활 유형별 지출 시작값

   국가데이터처 「2025년 4분기 및 연간(지출) 가계동향조사」
   표 1.8 '전국가구 가구원수별 가계수지'의 월평균 소비지출을
   만 원 단위로 옮겼다. 공표표가 천 원 단위로 반올림되어 있어
   세부 항목 합계와 표의 총액은 0.1만 원 정도 다를 수 있다.

   ── 이 값만 수동으로 갱신한다 ──

   자동화를 시도했다가 접었다. KOSIS OpenAPI(통계표 DT_1L9U105)는
   국내에서 10회 중 10회, 평균 0.09초로 잘 응답한다. 그런데 파이프라인이
   도는 GitHub Actions 러너(해외 IP)에서는 절반 이상 타임아웃이 났다.
   재시도로 억지로 뚫을 수는 있지만, 분기에 한 번 바뀌는 36개 숫자를
   위해 불안정한 단계를 주 1회 워크플로에 넣는 건 손해라고 판단했다.

   꼭 자동화한다면 Vercel 함수를 서울(icn1) 지역에 두고 그걸 경유해
   호출하면 된다. 국내에서 부르는 셈이라 막히지 않는다.

   ── 새 분기가 나오면 (5분) ──

   1. kosis.kr 에서 통계표 DT_1L9U105
      '가구원수별 가구당 월평균 가계수지 (전국,1인이상)' 를 연다
   2. 최신 분기의 1인·2인·4인 가구 열을 본다
   3. 아래 spending의 12개 품목 숫자를 만 원 단위로 바꾼다
   4. updated 와 source.label 을 새 분기로 고친다 (화면에 그대로 표시된다)
   ============================================================ */
(function (global) {
  "use strict";

  global.Personas = {
    // 화면에 그대로 노출한다. 1년 뒤에 열어도 언제 기준인지 보이게 하려는 것.
    updated: "2025년 4분기",
    source: {
      label: "국가데이터처 가계동향조사 · 2025년 4분기",
      table: "표 1.8 전국가구 가구원수별 가계수지",
      url: "https://mods.go.kr/board.es?act=view&bid=214&list_no=443727&mid=a10301040400",
    },
    profiles: {
      solo: {
        label: "혼자 생활비를 관리해요",
        short: "1인 생활",
        basis: "1인 가구 평균",
        spending: {
          food: 25.3, alcohol: 3.4, clothing: 9.7, housing: 31.9,
          household: 5.8, health: 14.0, transport: 19.9, comm: 10.3,
          leisure: 10.5, education: 1.7, dining: 32.2, misc: 15.3,
        },
      },
      couple: {
        label: "둘이 생활비를 함께 써요",
        short: "2인 생활",
        basis: "2인 가구 평균",
        spending: {
          food: 52.0, alcohol: 3.5, clothing: 14.4, housing: 32.4,
          household: 12.3, health: 25.0, transport: 36.1, comm: 14.6,
          leisure: 16.8, education: 4.0, dining: 39.8, misc: 25.9,
        },
      },
      family: {
        label: "가족과 목표를 준비해요",
        short: "가족 생활",
        basis: "4인 가구 평균",
        spending: {
          food: 71.8, alcohol: 4.4, clothing: 32.5, housing: 42.0,
          household: 19.0, health: 31.3, transport: 55.9, comm: 28.1,
          leisure: 31.3, education: 65.2, dining: 78.1, misc: 36.6,
        },
      },
    },
  };
})(window);

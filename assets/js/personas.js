/* ============================================================
   생활 유형별 지출 시작값

   국가데이터처 「2025년 4분기 및 연간(지출) 가계동향조사」
   표 1.8 '전국가구 가구원수별 가계수지'의 월평균 소비지출을
   만 원 단위로 옮겼다. 공표표가 천 원 단위로 반올림되어 있어
   세부 항목 합계와 표의 총액은 0.1만 원 정도 다를 수 있다.
   ============================================================ */
(function (global) {
  "use strict";

  global.Personas = {
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

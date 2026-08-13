// 멤버 타입 토글: 통합회원 라벨 이벤트 모드 여부
export const isLabelFixedMode = true;
// 의사 필터: 전체 버튼 고정 여부 (true: 전체버튼 고정, false: 전체 외 버튼과 함께 이동)
export const FIX_ALL = false;
// 의사 필터: 페이지당 표시 개수
export const PAGE_SIZE_DOCTOR_FILTER = 5;
// 의사 필터: 전체 버튼 아이템 정의
export const ALL_BUTTON_ITEM = {value: 'ALL', label: '전체', type: 'ALL'};
// 스케줄러: 주별|일별 변경 시 기준 날짜 옵션. true: 오늘 기준  false: 선택 날짜 기준
export const IS_RESET_TO_TODAY = true;
// 예약 팝업: 날짜 포맷
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
// 예약 팝업: 시간 포맷
export const DEFAULT_TIME_FORMAT = 'HH:mm';
// 예약 팝업: 로컬 날짜-시간 포맷
export const DEFAULT_LOCAL_DATE_TIME = 'YYYY-MM-DDTHH:mm:ss';
// 예약 팝업: 시간 간격 옵션(분)
export const STEP_MIN = 30;
// 예약 팝업: 종료 시간 고정/특수 옵션 처리 여부
export const IS_END_TIME_FIX = true;
// 예약 팝업: 고객 검색 디바운스(ms)
export const PATIENT_SEARCH_DEBOUNCE_MS = 100;
// 예약 팝업: 의사 추가 목록 페이지 크기 (담당의사 라디오 한 줄 노출 수)
// 3 — 4보다 항목당 폭이 넓어 비공개/휴무 뱃지 + 페이저 화살표가 여유롭게 표시됨.
export const PAGE_SIZE_DOCTOR_ADD_FILTER = 3;
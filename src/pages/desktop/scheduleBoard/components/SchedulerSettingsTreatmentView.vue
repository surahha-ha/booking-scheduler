<script setup>
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import dayjs from 'dayjs';
import {getSiteWorkHours, getStaffWorkHours, getTeams, getTreatmentSettings} from '@/api/siteApi';
import {useHolidayStore} from '@/stores/holidayStore';
import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue';
import UiDoctorFilter from '@/components/ui/UiDoctorFilter.vue';
import CellMorePopover from './CellMorePopover.vue';

const holidayStore = useHolidayStore();

const DAY_TYPE_ITEMS = [
  {value: 'WORK', label: '진료일'},
  {value: 'OFF', label: '휴무일'},
];

const PERIOD_TYPE_ITEMS = [
  {value: 'YEAR', label: '년'},
  {value: 'MONTH', label: '월'},
];

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_WINDOW_SIZE = 12;

/* 셀당 표시 최대 entry — 초과 시 "더보기" 트리거 (Settings 탭과 동일 정책) */
const CELL_ENTRY_VISIBLE_MAX = 5;

/* 팀/담당자 — GET /book/v2/site/teams 응답({staffId, staffName})을 템플릿이 쓰는 {id, name} shape 으로 매핑 */
const doctorTeams = ref([]);

/* ===== 운영일정 설정에서 가져오는 상태 (Settings 탭과 같은 스토리지 형태) =====
 * weekdayOffs       — Map<weekday, Set<RecurringOption>>           반복 휴무 규칙
 * dateOverrides     — Map<'YYYY-MM-DD', 'WORK'|'OFF'>              특정 날짜 override
 * workingHoursByOwner          — Map<'STAFF:<id>', Map<weekday, Range>>    요일별 운영시간(단일 구간)
 * workingHoursOverridesByOwner — Map<'STAFF:<id>', Map<dateKey, Range|null>>  날짜별 운영시간 지정
 *
 * Range = {start:'HH:MM', end:'HH:MM'}.
 * ★weekly·override 모두 값이 null 이어도 키를 넣는다 — "키가 있고 값이 null" = 휴무로 정함이라
 * "정한 적 없음"(키 없음)과 반드시 구분해야 한다. 미설정은 사업장 운영시간을 따르기 때문이다.
 */
const weekdayOffs = ref(new Map());
const dateOverrides = ref(new Map());
const workingHoursByOwner = ref(new Map());
const workingHoursOverridesByOwner = ref(new Map());

/* 사업장 요일별 운영시간 — Map<weekday, Range>. 원천은 사업장 설정.
 * 운영시간을 정하지 않은 담당자가 따르게 되는 값이라 이 화면도 함께 조회한다
 * (설정 화면과 같은 표기를 내려면 필요하다). 조회 실패·미등록이면 비어 있고,
 * 그때 미설정 담당자는 "휴무"이 아니라 "운영시간 없음"이다. */
const institutionWeeklyDayMap = ref(new Map());

/* 운영일정 설정의 "공휴일 포함" 토글값 (읽기 전용 반영) — true 일 때만 캘린더에 공휴일 표시 */
const includePublicHolidays = ref(true);

/* 상태 */
const selectedDayType = ref('WORK');
const selectedPeriodType = ref('MONTH');
const monthOffset = ref(0);
const selectedMonthKey = ref(dayjs().format('YYYY-MM'));
/* 팀/담당자 필터 — 예약장부(SchedulerSearchFilter)와 같은 UI(팀 셀렉트 + UiDoctorFilter).
 * ★선택 상태는 이 화면 것이다. 예약장부의 useSchedulerFilterStore 를 쓰지 않는다 —
 * 공유하면 한쪽에서 담당자를 걸러낸 것이 다른 화면 목록까지 바꾼다.
 *
 * 팀은 하나만 고른다(예약장부와 동일). null 은 "전체" 그룹 = 팀이 설정된 담당자 전원.
 * 담당자 선택은 UiDoctorFilter 규약을 따라 **빈 배열 = 전체 선택** 이다 — 아무도 안 고른 상태가 아니다. */
const selectedTeamId = ref(null);
const selectedDoctorIds = ref([]);

/* 고른 팀의 담당자. selectedTeamId=null 은 "전체" — 팀이 설정된 담당자를 모두 모은다.
 * 한 사람이 여러 팀에 속할 수 있어 id 기준으로 중복을 없애고, 팀 순서(SORT_ORD)를 유지한다. */
const visibleDoctors = computed(() => {
  if (selectedTeamId.value == null) {
    const byId = new Map();
    for (const team of doctorTeams.value) {
      for (const doc of team.doctors) {
        if (!byId.has(doc.id)) byId.set(doc.id, doc);
      }
    }
    return [...byId.values()];
  }
  const team = doctorTeams.value.find(t => t.id === selectedTeamId.value);
  return team?.doctors ?? [];
});

const doctorButtons = computed(() =>
    visibleDoctors.value.map(d => ({value: d.id, label: d.name}))
);

/* 그 담당자를 화면에 그릴 것인가 — 빈 배열(전체)이면 고른 팀의 전원이 대상이다. */
function isDoctorSelected(doctorId) {
  if (selectedDoctorIds.value.length === 0) return true;
  return selectedDoctorIds.value.includes(doctorId);
}

/* 팀을 바꾸면 담당자 선택은 전체로 되돌린다 — 다른 팀의 선택이 남으면
 * "아무도 안 보이는" 상태가 되기 때문이다(UiDoctorFilter 의 normalize 와 같은 취지). */
function onTeamChange(e) {
  const v = e.target.value;
  selectedTeamId.value = v === '' ? null : Number(v);
  selectedDoctorIds.value = [];
}

/* ===== 변환 헬퍼 (Settings 탭과 동일 시맨틱) ===== */

/* "0900" → "09:00" */
function hmmToHHMM(hmm) {
  if (!hmm || hmm.length !== 4) return null;
  return `${hmm.slice(0, 2)}:${hmm.slice(2, 4)}`;
}

/* 시작·종료 "HHmm" 짝 → Range | null. 한쪽이라도 비면 null(= 진료 안 함). */
function toRange(strtHm, endHm) {
  const s = hmmToHHMM(strtHm);
  const e = hmmToHHMM(endHm);
  return s && e ? {start: s, end: e} : null;
}

/* 의료인주간(B) 한 요일 row → Range | null.
 * 진료는 시작~종료 단일 구간이다. USE_YN 계열 필드는 없어졌고, 시작·종료가 null 이면 그 요일 휴무이다. */
function staffRowToRange(row) {
  return toRange(row.staffOpenHm, row.staffCloseHm);
}

/* 지정일자(C) override row → Range | null (*Dsnt* 필드).
 * 행이 있으면서 시작·종료가 null → 그 날짜만 휴무. (행 자체가 없으면 = 지정 없음 → 요일 패턴을 따른다) */
function overrideRowToRange(ov) {
  return toRange(ov.overrideOpenHm, ov.overrideCloseHm);
}

/* 담당자 times[](정한 요일 행만) → Map<weekday, Range|null>.
 * ★행이 있다는 것 자체가 "그 요일을 정했다"는 뜻이므로 range 가 null 이어도 키를 남긴다 —
 * 버리면 명시적 휴무가 미설정으로 강등돼 사업장 값을 따르게 된다.
 *   키 없음 = 미설정 / 키 + null = 휴무 / 키 + Range = 진료
 * override 가 쓰던 규약과 같고, 설정 화면(timesToDayMap)과도 같다. */
function timesToDayMap(times) {
  const m = new Map();
  for (const row of times ?? []) {
    m.set(row.dayCd, staffRowToRange(row));
  }
  return m;
}

/* recurring off 판정 — weekday 규칙 × occurrence (n번째 요일) */
function isRecurringOff(date) {
  const options = weekdayOffs.value.get(date.day());
  if (!options || options.size === 0) return false;
  if (options.has('WEEKLY')) return true;
  const occurrence = Math.ceil(date.date() / 7);
  return options.has(`MONTHLY_${occurrence}`);
}

/* 그 날짜 한 직원의 표시 상태 — 설정 화면(formatInstitutionEntries)과 같은 cascade 다.
 *   일자 지정 → (없으면) 요일 설정 → (미설정이면) 사업장 운영시간 → (그것도 모르면) 알 수 없음
 * 앞의 두 단계는 "행이 있으면 그것이 답"이라 has() 로 판정한다. 값이 null 이어도(휴무) 답이므로
 * 뒤 단계로 넘기지 않는다 — 넘기면 쉬기로 정한 요일에 기관 운영시간이 덮여버린다.
 *
 * state:
 *   'WORK'    진료 — range 있음
 *   'OFF'     휴무로 정함 (일자 지정 null 또는 요일 설정 null)
 *   'UNKNOWN' 미설정인데 기관 운영시간도 모름 — 휴무가 아니라 "알 수 없음"이다
 */
function resolveDisplay(ownerKey, dateKey, weekday) {
  const byDate = workingHoursOverridesByOwner.value.get(ownerKey);
  if (byDate?.has(dateKey)) {
    const range = byDate.get(dateKey);
    return {range, state: range ? 'WORK' : 'OFF'};
  }

  const dayMap = workingHoursByOwner.value.get(ownerKey);
  if (dayMap?.has(weekday)) {
    const range = dayMap.get(weekday);
    return {range, state: range ? 'WORK' : 'OFF'};
  }

  // 미설정 → 사업장 운영시간을 따른다 (설정 화면이 보여주는 것과 같은 값)
  const institution = institutionWeeklyDayMap.value.get(weekday) ?? null;
  return {range: institution, state: institution ? 'WORK' : 'UNKNOWN'};
}

/* 진료 단일 구간 → "09:00 ~ 18:00" */
function formatRange(range) {
  return range ? `${range.start} ~ ${range.end}` : null;
}

/* ===== Hydration ===== */

async function hydrateTeams() {
  try {
    const res = await getTeams();
    const body = res?.data ?? res;
    const teams = (body?.payload?.teams ?? []).map(team => ({
      id     : team.id,
      name   : team.name,
      doctors: (team.doctors ?? []).map(d => ({id: d.staffId, name: d.staffName})),
    }));
    doctorTeams.value = teams;
    /* 기본은 "전체" 그룹(selectedTeamId=null) — 이 화면은 일정 전체를 조망하는 곳이라
     * 특정 팀부터 보여주면 나머지 담당자가 없는 것처럼 보인다. */
  } catch (e) {
    console.error('[운영일정 보기 > 팀 조회] 실패', e);
  }
}

async function hydrateTreatmentSettings() {
  try {
    const res = await getTreatmentSettings();
    const body = res?.data ?? res;
    const payload = body?.payload;
    if (!payload) return;

    const wMap = new Map();
    for (const rule of payload.recurringOffRules ?? []) {
      const optionKey = rule.repeatTy === 'WEEKLY' ? 'WEEKLY' : `MONTHLY_${rule.monthlyNth}`;
      if (!wMap.has(rule.dayCd)) wMap.set(rule.dayCd, new Set());
      wMap.get(rule.dayCd).add(optionKey);
    }
    weekdayOffs.value = wMap;

    const oMap = new Map();
    for (const d of payload.offDates ?? []) oMap.set(d, 'OFF');
    for (const d of payload.workDates ?? []) oMap.set(d, 'WORK');
    dateOverrides.value = oMap;

    if (typeof payload.holidayClosedYn === 'boolean') {
      includePublicHolidays.value = payload.holidayClosedYn;
    }
  } catch (e) {
    console.error('[운영일정 보기 > 설정 조회] 실패', e);
  }
}

/* 사업장 요일별 운영시간(site, 원천 사업장 설정) — 미설정 담당자가 따르게 되는 값.
 * 실패하면 비운 채로 둔다: 저장이 없는 조회 전용 화면이라 막을 사고가 없고,
 * 그 상태의 미설정 직원은 resolveDisplay 가 UNKNOWN 으로 판정해 "운영시간 없음"이 된다.
 * 진료 구간(work)만 쓴다 — 휴게(lunch/dinner)는 이 화면이 표시하지 않는다. */
async function hydrateInstitutionHours() {
  try {
    const res = await getSiteWorkHours();
    const body = res?.data ?? res;
    const rows = body?.payload?.site;
    if (!Array.isArray(rows)) return;

    const next = new Map();
    for (const row of rows) {
      const w = row.dayCd;
      if (w == null || w < 0 || w > 6) continue;
      const range = toRange(row.openHm, row.closeHm);
      if (range) next.set(w, range);
    }
    institutionWeeklyDayMap.value = next;
  } catch (e) {
    console.error('[운영일정 보기 > 사업장 운영시간 조회] 실패', e);
  }
}

async function hydrateWorkingHours() {
  try {
    /* 담당자(staff) 운영시간·오버라이드. 사업장(site)은 원천이 사업장 설정라 별도 조회다(hydrateInstitutionHours). */
    const res = await getStaffWorkHours();
    const body = res?.data ?? res;
    const payload = body?.payload;
    if (!payload) return;

    const weeklyNext = new Map();
    for (const staff of payload.staff ?? []) {
      weeklyNext.set(`STAFF:${staff.staffId}`, timesToDayMap(staff.times));
    }
    workingHoursByOwner.value = weeklyNext;

    const overrideNext = new Map();
    for (const ov of payload.overrides ?? []) {
      const key = `STAFF:${ov.staffId}`;
      const dayMap = overrideNext.get(key) ?? new Map();
      /* 지정일자(C) 는 weekday 무관 — 그 날짜의 시작·종료(Dsnt)만 본다.
       * 값이 null 이어도 키는 넣는다(= 그 날짜만 휴무). */
      dayMap.set(ov.date, overrideRowToRange(ov));
      overrideNext.set(key, dayMap);
    }
    workingHoursOverridesByOwner.value = overrideNext;
  } catch (e) {
    console.error('[운영일정 보기 > 운영시간 조회] 실패', e);
  }
}

/* ===== 캘린더 셀 계산 =====
 * dayType 필터:
 *  - WORK 모드: 진료 구간 있는 직원만 entry 생성 (그 날짜 휴무/effective range=null 직원 skip)
 *  - OFF  모드: 진료 구간 없는 직원만 entry 생성 (cell이 OFF거나 effective range=null)
 * 결과 entries 는 selected 직원만 포함 */
function buildCellEntries(weekday, isOff, dateKey) {
  const isWorkMode = selectedDayType.value === 'WORK';
  const entries = [];
  for (const doc of visibleDoctors.value) {
    if (!isDoctorSelected(doc.id)) continue;
    const {range, state} = resolveDisplay(`STAFF:${doc.id}`, dateKey, weekday);
    const docIsOff = isOff || state !== 'WORK';
    if (isWorkMode) {
      if (docIsOff) continue;
      entries.push({staffId: doc.id, name: doc.name, time: formatRange(range), isOff: false});
    } else {
      if (!docIsOff) continue;
      /* 셀 자체가 휴무일(공휴일·반복휴무)이면 그것이 이유다. 그게 아니면서 기관 운영시간도
       * 모르는 미설정 직원만 "운영시간 없음" — 쉬기로 한 것과 모르는 것은 다르다.
       * 괄호 표기는 설정 화면(formatInstitutionEntries)과 맞춘 것이다 — 진료 시간이 들어갈
       * 자리에 시간이 아닌 사유가 오므로, 두 화면 모두 괄호로 구분한다. */
      const time = (!isOff && state === 'UNKNOWN') ? '(운영시간 없음)' : '(휴무)';
      entries.push({staffId: doc.id, name: doc.name, time, isOff: true});
    }
  }
  return entries;
}

/* 선택된 직원이 그 날짜에 '전원 휴무'인지 판정.
 * 병원 단위 isOff(공휴일·반복휴무·override) 또는 모든 선택 직원의 effective range 가 없으면 true.
 * 선택 직원이 0명이면 isOff(공휴일/병원휴무) 여부로만 판단. */
function isAllStaffOff(weekday, isOff, dateKey) {
  let total = 0;
  let off = 0;
  for (const doc of visibleDoctors.value) {
    if (!isDoctorSelected(doc.id)) continue;
    total += 1;
    const {state} = resolveDisplay(`STAFF:${doc.id}`, dateKey, weekday);
    if (isOff || state !== 'WORK') off += 1;
  }
  return isOff || (total > 0 && off === total);
}

/* 한 달 캘린더 셀.
 * detailed=true: entries[] 채움 (Month 뷰)
 * detailed=false: hasMatch 만 채움 (Year 미니 뷰 — entry 개별 표시는 공간 부족) */
function buildMonthCells(monthDate, detailed) {
  const startOfMonth = monthDate.startOf('month');
  const endOfMonth = monthDate.endOf('month');
  const gridStart = startOfMonth.subtract(startOfMonth.day(), 'day');
  const gridEnd = endOfMonth.add(6 - endOfMonth.day(), 'day');

  const cells = [];
  let cursor = gridStart;
  while (cursor.isBefore(gridEnd) || cursor.isSame(gridEnd, 'day')) {
    const isCurrentMonth = cursor.month() === startOfMonth.month();
    const key = cursor.format('YYYY-MM-DD');
    const override = dateOverrides.value.get(key);

    /* 국가 공휴일 — 토글 ON + 현재 달 셀만 빨간날 표기(휴무 라벨은 isOff 가 담당). */
    const isHoliday = isCurrentMonth && includePublicHolidays.value && holidayStore.isHoliday(key);

    /* 공휴일은 휴무일(반복)·특정일자(override) 로직에서 제외 → '공휴일' 체크박스로만 결정(ON=휴무, OFF=진료). */
    const isOff = isCurrentMonth && (
        holidayStore.isHoliday(key)
            ? includePublicHolidays.value
            : (override === 'OFF' || (override !== 'WORK' && isRecurringOff(cursor)))
    );

    const entries = isCurrentMonth ? buildCellEntries(cursor.day(), isOff, key) : [];
    const hasMatch = entries.length > 0;

    /* 현재 dayType 필터에 맞지 않는 셀 — 회색 배경으로 dim.
     * 선택 직원이 있으면 그 직원 기준(hasMatch)으로 판정 → 담당자 필터가 캘린더에 반영됨.
     *  - WORK 모드: 선택 직원이 아무도 진료 안 하는 날이 mismatch
     *  - OFF  모드: 선택 직원이 아무도 휴무 아닌 날이 mismatch
     * 표시 대상 담당자가 0명(팀 미선택/빈 팀)이면 병원 단위(isOff)로 폴백 (전체 dim 방지). */
    const hasSelection = visibleDoctors.value.length > 0;
    const isMismatch = isCurrentMonth && (
        hasSelection
            ? !hasMatch
            : (selectedDayType.value === 'WORK' ? isOff : !isOff)
    );

    /* 선택 직원 전원 휴무 여부 — OFF 월 뷰 배경(#f5f5f5 / #fff) 결정용 */
    const allOff = isCurrentMonth && isAllStaffOff(cursor.day(), isOff, key);

    cells.push({
      key,
      dayNumber: cursor.date(),
      weekday  : cursor.day(),
      isCurrentMonth,
      isOff,
      isMismatch,
      allOff,
      isHoliday,
      entries  : detailed ? entries : null,
      hasMatch,
    });
    cursor = cursor.add(1, 'day');
  }
  return cells;
}

/* MONTH 뷰: 선택된 월 1개의 상세 캘린더 */
const calendarCells = computed(() =>
    buildMonthCells(dayjs(`${selectedMonthKey.value}-01`), true)
);

/* YEAR 뷰: 선택된 연도의 12개월 미니 캘린더 */
const yearMonths = computed(() => {
  const year = dayjs(`${selectedMonthKey.value}-01`).year();
  return Array.from({length: 12}, (_, i) => {
    const monthDate = dayjs(`${year}-${String(i + 1).padStart(2, '0')}-01`);
    return {
      key  : monthDate.format('YYYY-MM'),
      label: `${i + 1}월`,
      cells: buildMonthCells(monthDate, false),
    };
  });
});

/* 선택 월이 속한 연도의 공휴일 보장 — 이미 로드된 연도는 no-op */
watch(
    () => dayjs(`${selectedMonthKey.value}-01`).year(),
    (y) => holidayStore.ensureYears([y]),
    {immediate: true},
);

/* 표시할 12개월 (1월 앞에는 연도 라벨 추가) */
const visibleMonths = computed(() => {
  const items = [];
  const start = dayjs().add(monthOffset.value, 'month').startOf('month');
  for (let i = 0; i < MONTH_WINDOW_SIZE; i++) {
    const d = start.add(i, 'month');
    if (d.month() === 0) {
      items.push({key: `Y${d.year()}`, label: String(d.year()), isYear: true});
    }
    items.push({key: d.format('YYYY-MM'), label: `${d.month() + 1}월`, isYear: false});
  }
  return items;
});

function prevMonth() { monthOffset.value -= 1; }
function nextMonth() { monthOffset.value += 1; }
function selectMonth(key) { selectedMonthKey.value = key; }

const selectedYear = computed(() => dayjs(`${selectedMonthKey.value}-01`).year());

function prevYear() {
  selectedMonthKey.value = dayjs(`${selectedMonthKey.value}-01`).subtract(1, 'year').format('YYYY-MM');
}
function nextYear() {
  selectedMonthKey.value = dayjs(`${selectedMonthKey.value}-01`).add(1, 'year').format('YYYY-MM');
}

/* ===== 셀 더보기 popover (조회 전용 — 편집 기능 없음, Settings 탭과 다른 점) ===== */
const cellMorePopover = ref({
  open     : false,
  top      : 0,
  left     : 0,
  dayNumber: 0,
  isOff    : false,
  entries  : [],
});

function openCellMore(event, cell) {
  event.stopPropagation();
  const cellEl = event.currentTarget.closest('.schedulerTreatmentView__cell');
  if (!cellEl) return;
  const rect = cellEl.getBoundingClientRect();
  cellMorePopover.value = {
    open     : true,
    top      : rect.top,
    left     : rect.left,
    dayNumber: cell.dayNumber,
    isOff    : cell.isOff,
    entries  : cell.entries,
  };
}

function closeCellMore() {
  if (!cellMorePopover.value.open) return;
  cellMorePopover.value = {...cellMorePopover.value, open: false};
}

/* fixed 위치 popover — 외부 클릭/스크롤/리사이즈로 떠다님 방지 */
function handleDocumentClick() {
  if (cellMorePopover.value.open) closeCellMore();
}
function handleScrollOrResize() {
  if (cellMorePopover.value.open) closeCellMore();
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick);
  window.addEventListener('scroll', handleScrollOrResize, true);
  window.addEventListener('resize', handleScrollOrResize);
  Promise.all([
    hydrateTeams(),
    hydrateTreatmentSettings(),
    hydrateInstitutionHours(),
    hydrateWorkingHours(),
  ]);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick);
  window.removeEventListener('scroll', handleScrollOrResize, true);
  window.removeEventListener('resize', handleScrollOrResize);
});
</script>

<template>
  <div class="schedulerTreatmentView">
    <div class="schedulerTreatmentView__filters">
      <UiSegmentedControl
          v-model="selectedDayType"
          :items="DAY_TYPE_ITEMS"
      />

      <UiSegmentedControl
          v-model="selectedPeriodType"
          :items="PERIOD_TYPE_ITEMS"
      />

      <div
          v-if="selectedPeriodType === 'MONTH'"
          class="schedulerTreatmentView__monthNav"
      >
        <button
            aria-label="이전"
            class="schedulerTreatmentView__arrow"
            type="button"
            @click="prevMonth"
        />

        <div class="schedulerTreatmentView__months">
          <button
              v-for="m in visibleMonths"
              :key="m.key"
              :class="{
                'is-year'  : m.isYear,
                'is-active': !m.isYear && selectedMonthKey === m.key,
              }"
              :disabled="m.isYear"
              class="schedulerTreatmentView__month"
              type="button"
              @click="!m.isYear && selectMonth(m.key)"
          >
            {{ m.label }}
          </button>
        </div>

        <button
            aria-label="다음"
            class="schedulerTreatmentView__arrow schedulerTreatmentView__arrow--next"
            type="button"
            @click="nextMonth"
        />
      </div>

      <div
          v-else
          class="schedulerTreatmentView__yearNav"
      >
        <button
            aria-label="이전 년"
            class="schedulerTreatmentView__arrow"
            type="button"
            @click="prevYear"
        />

        <span class="schedulerTreatmentView__year">{{ selectedYear }}</span>

        <button
            aria-label="다음 년"
            class="schedulerTreatmentView__arrow schedulerTreatmentView__arrow--next"
            type="button"
            @click="nextYear"
        />
      </div>

      <!-- 진료 팀 + 담당자 — 예약장부(SchedulerSearchFilter)와 같은 구성.
           선택 상태만 이 화면 것이다(예약장부와 연동되지 않는다). -->
      <div class="schedulerTreatmentView__doctorGroup">
        <select
            class="schedulerTreatmentView__teamSelect"
            :value="selectedTeamId ?? ''"
            @change="onTeamChange"
        >
          <option value="">전체</option>
          <option v-for="t in doctorTeams" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>

        <UiDoctorFilter
            :button-items="doctorButtons"
            :model-value="selectedDoctorIds"
            @update:model-value="selectedDoctorIds = $event"
        />
      </div>
    </div>

    <div class="schedulerTreatmentView__calendar">
      <!-- 월 뷰: 선택된 한 달 상세 -->
      <template v-if="selectedPeriodType === 'MONTH'">
        <div class="schedulerTreatmentView__calendarHeader">
          <div
              v-for="(label, idx) in WEEKDAY_LABELS"
              :key="label"
              :class="{
                'is-sunday'  : idx === 0,
                'is-saturday': idx === 6,
              }"
              class="schedulerTreatmentView__weekday"
          >
            {{ label }}
          </div>
        </div>

        <div class="schedulerTreatmentView__calendarGrid">
          <div
              v-for="cell in calendarCells"
              :key="cell.key"
              :class="{
                'is-other'   : !cell.isCurrentMonth,
                'is-sunday'  : cell.weekday === 0,
                'is-saturday': cell.weekday === 6,
                'is-off'     : selectedDayType !== 'OFF' && cell.isOff,
                'is-mismatch': cell.isMismatch,
                'is-all-off' : selectedDayType === 'OFF' && cell.allOff,
              }"
              class="schedulerTreatmentView__cell"
          >
            <template v-if="cell.isCurrentMonth">
              <!-- 헤더 구성은 설정 화면(__monthCellHeader)과 같다: 날짜 → 휴무 -->
              <div class="schedulerTreatmentView__cellHeader">
                <span class="schedulerTreatmentView__cellDate">{{ cell.dayNumber }}</span>
                <span
                    v-if="cell.isOff"
                    class="schedulerTreatmentView__offLabel"
                >휴무</span>
              </div>

              <div
                  v-if="cell.entries && cell.entries.length"
                  class="schedulerTreatmentView__cellList"
              >
                <div
                    v-for="(entry, i) in cell.entries.slice(0, CELL_ENTRY_VISIBLE_MAX)"
                    :key="i"
                    :class="{ 'is-off': entry.isOff }"
                    class="schedulerTreatmentView__appt"
                >
                  <span class="schedulerTreatmentView__apptDoctor">{{ entry.name }}</span>
                  <span class="schedulerTreatmentView__apptTime">{{ entry.time }}</span>
                </div>
                <button
                    v-if="cell.entries.length > CELL_ENTRY_VISIBLE_MAX"
                    class="schedulerTreatmentView__cellMore"
                    type="button"
                    @click.stop="openCellMore($event, cell)"
                >+{{ cell.entries.length - CELL_ENTRY_VISIBLE_MAX }} 더보기</button>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- 년 뷰: 12개월 미니 캘린더 그리드 -->
      <div
          v-else
          class="schedulerTreatmentView__yearGrid"
      >
        <div
            v-for="m in yearMonths"
            :key="m.key"
            class="schedulerTreatmentView__miniMonth"
        >
          <div class="schedulerTreatmentView__miniMonthLabel">{{ m.label }}</div>

          <div class="schedulerTreatmentView__miniMonthGrid">
            <div
                v-for="cell in m.cells"
                :key="cell.key"
                :class="{
                  'is-sunday'  : cell.weekday === 0,
                  'is-saturday': cell.weekday === 6,
                  'is-holiday' : cell.isHoliday,
                  'is-off'     : selectedDayType === 'WORK' && cell.isOff,
                  'is-other'   : !cell.isCurrentMonth,
                  'is-mismatch': cell.isMismatch,
                }"
                class="schedulerTreatmentView__miniDay"
            >
              <template v-if="cell.isCurrentMonth">{{ cell.dayNumber }}</template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 셀 더보기 popover (entries 가 CELL_ENTRY_VISIBLE_MAX 초과 시) -->
    <CellMorePopover
        :open="cellMorePopover.open"
        :top="cellMorePopover.top"
        :left="cellMorePopover.left"
        :day-number="cellMorePopover.dayNumber"
        :is-off="cellMorePopover.isOff"
        @close="closeCellMore"
    >
      <div
          v-for="(entry, i) in cellMorePopover.entries"
          :key="i"
          :class="{ 'is-off': entry.isOff }"
          class="schedulerTreatmentView__appt"
      >
        <span class="schedulerTreatmentView__apptDoctor">{{ entry.name }}</span>
        <span class="schedulerTreatmentView__apptTime">{{ entry.time }}</span>
      </div>
    </CellMorePopover>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.schedulerTreatmentView {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;

  &__filters {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 12px;
    overflow-x: auto;
  }

  &__monthNav,
  &__yearNav {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }

  &__year {
    min-width: 48px;
    text-align: center;
    font-size: $font-size-14;
    font-weight: $font-weight-bold;
    color: $color-text-black;
  }

  &__arrow {
    width: 20px;
    height: 20px;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 0;
    flex: 0 0 auto;

    font-size: 0;
    color: transparent;

    --arrow-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");

    background-image: var(--arrow-icon);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 20px 20px;

    &--next {
      transform: rotate(180deg);
    }

    &:hover {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    }
  }

  &__months {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  &__month {
    height: 24px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: $radius-2;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-segment;
    white-space: nowrap;

    &.is-year {
      color: $color-text-default;
      cursor: default;
    }

    &.is-active {
      background: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }
  }

  /* 진료 팀 셀렉트 + 의사 필터 묶음 — 예약장부(scheduleSearchFilter__doctorGroup)와 같은 값. */
  &__doctorGroup {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  &__teamSelect {
    height: 28px;
    padding: 0 6px;
    border: 1px solid #bbb;
    background: #fff;
    font-size: 13px;
    cursor: pointer;
  }

  /* ---------- Calendar ---------- */
  &__calendar {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    border-top: 1px solid $color-border-light;
    border-left: 1px solid $color-border-light;
  }

  &__calendarHeader {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    background: $color-bg-scheduler-header;
    border-bottom: 1px solid $color-border-light;
  }

  &__weekday {
    padding: 6px 8px;
    text-align: center;
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;
    border-right: 1px solid $color-border-light;

    &.is-sunday {
      color: $color-danger;
    }

    &.is-saturday {
      color: $color-now;
    }
  }

  &__calendarGrid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: minmax(90px, 1fr);
    flex: 1;
    overflow-y: auto;
  }

  /* 셀 조판은 설정 화면(__monthCell)과 같은 값을 쓴다 — 같은 달력을 두 탭에서 보는 것이므로. */
  &__cell {
    padding: 6px 8px;
    border-right: 1px solid $color-border-light;
    border-bottom: 1px solid $color-border-light;
    overflow: hidden;
    background: #fff;

    &.is-other {
      background: $color-surface-alt;
    }

    /* 휴무일 — 설정 화면과 같은 회색. 빨강 배경은 쓰지 않는다(휴무는 뱃지로 알린다). */
    &.is-off {
      background: #f5f5f5;
    }

    /* 현재 dayType 필터에 맞지 않는 셀 — is-off 보다 뒤에 두어 빨강 배경 override */
    &.is-mismatch {
      background: #f5f5f5;
    }

    /* 휴무일(OFF) 월 뷰 — 선택 직원 전원 휴무/공휴일이면 #f5f5f5, 한 명이라도 진료하면 #fff(기본) */
    &.is-all-off {
      background: #f5f5f5;
    }
  }

  &__cellHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  &__cellDate {
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;

    .is-sunday & {
      color: $color-danger;
    }

    .is-saturday & {
      color: $color-now;
    }
  }

  /* 휴무 뱃지 — 설정 화면(__offLabel)과 같이 테두리 없는 빨간 글씨. */
  &__offLabel {
    font-size: $font-size-12;
    font-weight: $font-weight-bold;
    color: $color-danger;
  }

  /* 셀 직원 목록 — 설정 화면(__monthCellEntries / __monthCellEntry)과 같은 조판.
   * 두 화면이 같은 데이터를 보여주므로 표기도 같아야 한다. 편집이 없어 마크업은 button 이 아니라
   * div/span 이지만, 글자 크기·행간·간격·색은 설정 화면을 따른다. */
  &__cellList {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    overflow: hidden;
  }

  &__appt {
    display: flex;
    gap: 4px;
    font-size: $font-size-12;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    /* 휴무·운영시간 없음 — 설정 화면의 .is-off 와 같이 줄 전체를 흐리게 한다.
     * (시간 자리만 빨갛게 칠하지 않는다 — 설정 화면과 색이 갈렸던 원인) */
    &.is-off {
      .schedulerTreatmentView__apptDoctor,
      .schedulerTreatmentView__apptTime {
        color: $color-text-muted;
      }
    }
  }

  &__apptDoctor,
  &__apptTime {
    color: $color-text-default;
  }

  &__cellMore {
    align-self: flex-start;
    margin-top: 2px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-now;
    text-decoration: underline;

    &:hover {
      color: darken(#256AF5, 10%);
    }
  }

  /* ---------- Year View (12 mini calendars) ---------- */
  &__yearGrid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 1fr;
    gap: 8px;
    padding: 8px;
    background: $color-border-light;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  &__miniMonth {
    display: flex;
    flex-direction: column;
    border: 1px solid $color-border-light;
    background: #fff;
  }

  &__miniMonthLabel {
    text-align: center;
    padding: 4px 0;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
    border-bottom: 1px solid $color-border-light;
  }

  &__miniMonthGrid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    flex: 1;
    padding: 4px;
    gap: 2px 0;
  }

  &__miniDay {
    text-align: center;
    font-size: $font-size-12;
    color: $color-text-default;
    line-height: 1.4;

    &.is-sunday {
      color: $color-danger;
    }

    &.is-saturday {
      color: $color-now;
    }

    &.is-holiday {
      color: $color-danger;
    }

    /* 사업장 단위 휴무일 — 배경 없이 폰트만 강조 (년 뷰는 배경색 통일) */
    &.is-off {
      color: $color-danger;
      font-weight: $font-weight-bold;
    }

    &.is-other {
      color: $color-text-muted;
      opacity: 0.4;
    }

    /* 현재 dayType 필터에 맞지 않는 날 — 폰트 흐리게 (배경 변경 없음) */
    &.is-mismatch {
      color: $color-text-muted;
      font-weight: normal;
      opacity: 0.5;
    }
  }
}
</style>

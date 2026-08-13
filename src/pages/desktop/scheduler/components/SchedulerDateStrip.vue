<template>
  <div aria-label="날짜 선택" class="scheduleDateStrip" role="group">
    <!-- [오늘] -->
    <button class="scheduleDateStrip__today" type="button" @click="emit('go-today')">오늘</button>

    <!-- 노란 < -->
    <button aria-label="이전 월 표시" class="scheduleDateStrip__monthNav" type="button" @click="emit('expand-prev-month')">
      <span aria-hidden="true" class="scheduleDateStrip__monthNavIcon" />
    </button>

    <template v-if="mode === 'rolling'">
      <!-- 왼쪽 바깥 월 버튼 -->
      <button
        v-for="m in leftMonthButtons"
        :key="'lm-' + m.yearMonth"
        class="scheduleDateStrip__monthCell"
        type="button"
        @click="emit('expand-month', m.yearMonth)"
      >{{ m.label }}</button>

      <!-- 연두 < -->
      <button aria-label="이전 날짜 보기" class="scheduleDateStrip__dayNav" type="button" @click="emit('shift-prev')">
        <span aria-hidden="true" class="scheduleDateStrip__dayNavIcon" />
      </button>

      <!-- 30일 strip -->
      <template v-for="cell in stripDayCells" :key="cell.date">
        <span v-if="cell.monthSeparator" aria-hidden="true" class="scheduleDateStrip__monthSep">{{ cell.monthLabel }}</span>
        <button
          :aria-current="cell.isToday ? 'date' : undefined"
          :aria-label="`${cell.date} 선택`"
          :aria-pressed="cell.date === selectedDate"
          class="scheduleDateStrip__dayCell"
          :class="dayCellClass(cell)"
          :disabled="isDateDisabled(cell.date)"
          type="button"
          @click="!isDateDisabled(cell.date) && emit('select-date', cell.date)"
        >{{ cell.dayOfMonth }}</button>
      </template>

      <!-- 연두 > (진료 화면 + 오늘이면 숨김) -->
      <button v-show="!isNextDisabled" aria-label="다음 날짜 보기" class="scheduleDateStrip__dayNav scheduleDateStrip__dayNav--next" type="button" @click="emit('shift-next')">
        <span aria-hidden="true" class="scheduleDateStrip__dayNavIcon" />
      </button>

      <!-- 오른쪽 바깥 월 버튼 -->
      <button
        v-for="m in rightMonthButtons"
        :key="'rm-' + m.yearMonth"
        class="scheduleDateStrip__monthCell"
        type="button"
        @click="emit('expand-month', m.yearMonth)"
      >{{ m.label }}</button>
    </template>

    <template v-else-if="mode === 'monthExpanded'">
      <!-- 확장 왼쪽 월 -->
      <button
        v-for="m in expandedLeftMonths"
        :key="'elm-' + m.yearMonth"
        class="scheduleDateStrip__monthCell"
        type="button"
        @click="emit('expand-month', m.yearMonth)"
      >{{ m.label }}</button>

      <!-- 확장 월 전체 날짜 -->
      <template v-for="cell in expandedDayCells" :key="cell.date">
        <span v-if="cell.monthSeparator" aria-hidden="true" class="scheduleDateStrip__monthSep">{{ cell.monthLabel }}</span>
        <button
          :aria-current="cell.isToday ? 'date' : undefined"
          :aria-label="`${cell.date} 선택`"
          :aria-pressed="cell.date === selectedDate"
          class="scheduleDateStrip__dayCell"
          :class="dayCellClass(cell)"
          type="button"
          @click="emit('select-date', cell.date)"
        >{{ cell.dayOfMonth }}</button>
      </template>

      <!-- 확장 오른쪽 월 -->
      <button
        v-for="m in expandedRightMonths"
        :key="'erm-' + m.yearMonth"
        class="scheduleDateStrip__monthCell"
        type="button"
        @click="emit('expand-month', m.yearMonth)"
      >{{ m.label }}</button>
    </template>

    <!-- 노란 > (진료 화면: 오늘 이후 이동 불가이면 숨김) -->
    <button v-show="!isNextDisabled" aria-label="다음 월 표시" class="scheduleDateStrip__monthNav scheduleDateStrip__monthNav--next" type="button" @click="emit('expand-next-month')">
      <span aria-hidden="true" class="scheduleDateStrip__monthNavIcon" />
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import dayjs from 'dayjs'

const MONTH_LABELS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']
const MONTH_RANGE = 12
// 명세 9-1: 진료 줄달력 좌측 월 버튼 = strip 시작월 + 이전 2개월 = 3개
const PAST_MONTH_BUTTON_COUNT = 3

const props = defineProps({
  selectedDate: { type: String, required: true },
  stripWindowStart: { type: String, required: true },
  mode: { type: String, default: 'rolling' },
  expandedMonth: { type: String, default: null },
  headerWindowDays: { type: Number, default: 30 },
  maxDate: { type: String, default: null },
})

const emit = defineEmits([
  'go-today', 'shift-prev', 'shift-next',
  'expand-prev-month', 'expand-next-month',
  'select-date', 'expand-month',
])

const todayStr = dayjs().format('YYYY-MM-DD')

// ═══════════════════════════════════════════════════════════
// rolling 모드: 3개 영역 계산
// ═══════════════════════════════════════════════════════════

// strip day cells (30일)
const stripDayCells = computed(() => {
  const base = dayjs(props.stripWindowStart)
  const cells = []
  let prevMonth = -1

  for (let i = 0; i < props.headerWindowDays; i++) {
    const d = base.add(i, 'day')
    const month = d.month()
    const cell = {
      date: d.format('YYYY-MM-DD'),
      dayOfMonth: d.date(),
      dayOfWeek: d.day(),
      isToday: d.format('YYYY-MM-DD') === todayStr,
      monthSeparator: false,
      monthLabel: null,
    }

    // 월 경계에서 separator 삽입 (첫 셀이 아닌 경우만)
    if (month !== prevMonth && i > 0) {
      cell.monthSeparator = true
      cell.monthLabel = MONTH_LABELS[month]
    }
    prevMonth = month
    cells.push(cell)
  }
  return cells
})

// 왼쪽 바깥 월 버튼
// 예약 화면: strip 시작일이 속한 월 1개
// 진료 화면: strip 이전 월을 여러 개 (최대 MONTH_RANGE개)
const leftMonthButtons = computed(() => {
  const stripStart = dayjs(props.stripWindowStart)

  if (!props.maxDate) {
    // 예약 화면: 1개만
    const month = stripStart.startOf('month')
    return [{
      yearMonth: month.format('YYYY-MM'),
      label: MONTH_LABELS[month.month()],
    }]
  }

  // 진료 화면: strip에 포함된 월을 제외하고, strip 직전부터 역순 수집
  // 결과: 가장 오래된 월(왼쪽) → strip에 가까운 월(오른쪽)
  // 예: 오늘 4/14, strip 3/16~4/14 → strip에 3월,4월 포함
  //     → 왼쪽 mm월: 5월 6월 7월 ... 1월 2월 (12개, 3월/4월 제외)
  const stripMonths = new Set()
  for (let i = 0; i < props.headerWindowDays; i++) {
    stripMonths.add(stripStart.add(i, 'day').format('YYYY-MM'))
  }

  // strip에 완전히 포함된 월만 제외 (시작 월은 일부만 포함이므로 mm월에 표시)
  // strip 시작 월 = 일부 포함 → mm월에 포함
  // strip 중간/끝 월 = 완전 포함 → mm월에서 제외
  const stripStartMonth = stripStart.format('YYYY-MM')
  const fullyIncludedMonths = new Set()
  for (const ym of stripMonths) {
    if (ym !== stripStartMonth) fullyIncludedMonths.add(ym)
  }

  // 명세 9-1: 시작월 + 이전 2개월 = 3개 (미래 fullyIncluded 월은 역순 수집에서 안 걸림)
  const maxCount = PAST_MONTH_BUTTON_COUNT

  // strip 시작 월부터 역순으로 수집 (시작 월 포함)
  const collected = []
  let cursor = stripStart.startOf('month')

  while (collected.length < maxCount) {
    const ym = cursor.format('YYYY-MM')
    if (!fullyIncludedMonths.has(ym)) {
      collected.push({
        yearMonth: ym,
        label: MONTH_LABELS[cursor.month()],
      })
    }
    cursor = cursor.subtract(1, 'month')
  }

  return collected.reverse()
})

// 오른쪽 바깥 월 버튼: strip이 걸치지 않는 다음 월들
// strip 시작월 기준 12개월 뒤까지 (strip에 포함된 월은 제외)
const rightMonthButtons = computed(() => {
  const stripStart = dayjs(props.stripWindowStart)
  const stripEnd = stripStart.add(props.headerWindowDays - 1, 'day')

  // strip이 걸치는 월 set
  const stripMonths = new Set()
  for (let i = 0; i < props.headerWindowDays; i++) {
    stripMonths.add(stripStart.add(i, 'day').format('YYYY-MM'))
  }

  const result = []
  let cursor = stripEnd.add(1, 'day').startOf('month')
  const limit = stripStart.add(MONTH_RANGE, 'month')

  // 선택한 날짜의 월 포함 이후는 표시 안 함
  const selectedMonth = props.maxDate ? dayjs(props.selectedDate).format('YYYY-MM') : null

  while (cursor.isBefore(limit, 'month')) {
    const ym = cursor.format('YYYY-MM')
    // maxDate가 있으면 해당 월 포함 이후는 표시 안 함
    if (selectedMonth && ym >= selectedMonth) break
    if (!stripMonths.has(ym)) {
      result.push({
        yearMonth: ym,
        label: MONTH_LABELS[cursor.month()],
      })
    }
    cursor = cursor.add(1, 'month')
  }

  return result
})

// ═══════════════════════════════════════════════════════════
// monthExpanded 모드
// ═══════════════════════════════════════════════════════════

const expandedDayCells = computed(() => {
  if (!props.expandedMonth) return []
  const monthStart = dayjs(props.expandedMonth + '-01')
  const daysInMonth = monthStart.daysInMonth()
  const cells = []

  cells.push({
    date: monthStart.format('YYYY-MM-DD'),
    dayOfMonth: monthStart.date(),
    dayOfWeek: monthStart.day(),
    isToday: monthStart.format('YYYY-MM-DD') === todayStr,
    monthSeparator: true,
    monthLabel: MONTH_LABELS[monthStart.month()],
  })

  for (let i = 1; i < daysInMonth; i++) {
    const d = monthStart.add(i, 'day')
    cells.push({
      date: d.format('YYYY-MM-DD'),
      dayOfMonth: d.date(),
      dayOfWeek: d.day(),
      isToday: d.format('YYYY-MM-DD') === todayStr,
      monthSeparator: false,
      monthLabel: null,
    })
  }
  return cells
})

const expandedLeftMonths = computed(() => {
  if (!props.expandedMonth) return []
  const base = dayjs(props.expandedMonth + '-01')
  const result = []
  let cursor = base.subtract(1, 'month')
  const limit = base.subtract(MONTH_RANGE, 'month')
  while (cursor.isSame(limit, 'month') || cursor.isAfter(limit, 'month')) {
    result.unshift({
      yearMonth: cursor.format('YYYY-MM'),
      label: MONTH_LABELS[cursor.month()],
    })
    cursor = cursor.subtract(1, 'month')
  }
  return result
})

const expandedRightMonths = computed(() => {
  if (!props.expandedMonth) return []
  const base = dayjs(props.expandedMonth + '-01')
  const result = []
  let cursor = base.add(1, 'month')
  const limit = base.add(MONTH_RANGE, 'month')
  while (cursor.isBefore(limit, 'month') || cursor.isSame(limit, 'month')) {
    result.push({
      yearMonth: cursor.format('YYYY-MM'),
      label: MONTH_LABELS[cursor.month()],
    })
    cursor = cursor.add(1, 'month')
  }
  return result
})

// ═══════════════════════════════════════════════════════════
// 공통
// ═══════════════════════════════════════════════════════════

function isDateDisabled(date) {
  if (!props.maxDate) return false
  return date > props.maxDate
}

// 진료 화면: maxDate가 strip 안에 포함되면 다음 월 이동 버튼 숨김
const isNextDisabled = computed(() => {
  if (!props.maxDate) return false
  const stripEnd = dayjs(props.stripWindowStart).add(props.headerWindowDays - 1, 'day').format('YYYY-MM-DD')
  return props.maxDate <= stripEnd
})

function dayCellClass(cell) {
  return {
    'is-selected': cell.date === props.selectedDate,
    'is-today': cell.isToday,
    'is-weekend-sat': cell.dayOfWeek === 6,
    'is-weekend-sun': cell.dayOfWeek === 0,
    'is-disabled': isDateDisabled(cell.date),
  }
}
</script>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleDateStrip {
  display: flex;
  align-items: center;
  flex: 1;
  height: 36px;
  padding: 0 6px;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;

}

/* 오늘 버튼 */
.scheduleDateStrip__today {
  flex-shrink: 0;
  height: 24px;
  padding: 0 12px;
  margin-right: 4px;
  border: 1px solid #a5a5a5;
  border-radius: $radius-4;
  background: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  &:hover {
    background: #f2f2f2;
  }

}

/* 월 네비 chevron — 중립 회색(V1 톤) */
.scheduleDateStrip__monthNav {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: 1px solid #a5a5a5;
  border-radius: $radius-4;
  background: #fff;
  color: #555;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background: #f2f2f2;
  }

  &Icon {
    width: 20px;
    height: 20px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23565656' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E") center / 20px 20px no-repeat;
  }

  &--next &Icon {
    transform: rotate(180deg);
  }
}

/* strip 좌우 shift chevron — 중립 회색 */
.scheduleDateStrip__dayNav {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 0;
  background: $color-surface;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover {
    background: #e6e6e6;
  }

  &Icon {
    width: 20px;
    height: 20px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23565656' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E") center / 20px 20px no-repeat;
  }

  &--next &Icon {
    transform: rotate(180deg);
  }
}

/* 월 축약 라벨 (5월, 6월...) — 중립 회색 */
.scheduleDateStrip__monthCell {
  flex-shrink: 0;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: $color-text-black;
  font-size: 14px;
  font-weight: $font-weight-bold;
  cursor: pointer;
  &:hover {
    color: #333;
    text-decoration: underline;
  }
}

/* 월 구분선 */
.scheduleDateStrip__monthSep {
  flex-shrink: 0;
  padding: 0 2px;
  color: $color-text-black;
  font-size: $font-size-14;
  font-weight: $font-weight-bold;
}

/* 날짜 셀 — 폭은 숫자 내용에 맞춰 좁게(1자리=타이트), 원형 하이라이트는 ::before 고정원 오버레이.
   강조 셀만 z 올려(이웃 위) 원이 잘리지 않게. → 숫자 간격 좁음 + 원은 항상 동그라미. */
.scheduleDateStrip__dayCell {
  position: relative;
  flex-shrink: 0;
  min-width: 20px;
  height: 28px;
  padding: 0 3px;
  border: none;
  background: transparent;
  font-size: $font-size-12;
  font-weight: $font-weight-semibold;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $color-text-black;

  /* 고정 26px 원(셀 폭 무관). 기본 투명 → hover/오늘/선택 시 채움/테두리. */
  &::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 20px;
    height: 20px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    z-index: -1;
  }

  &:hover {
    z-index: 1;

    &::before {
      background: #f5f5f5;
    }
  }

  &.is-today {
    z-index: 1;
    font-weight: 700;
    color: var(--scheduler-brand, #{$color-primary});
  }
  /* 당일 미선택(화면정의서 9-1): 원형 테두리만(채우기 없음). */
  &.is-today:not(.is-selected)::before {
    box-shadow: inset 0 0 0 1px var(--scheduler-brand, #{$color-primary});
  }
  &.is-selected {
    z-index: 1;
    color: #fff;
    font-weight: 700;
    &::before {
      background: var(--scheduler-brand, #{$color-primary});
    }
  }

  &.is-weekend-sat {
    color: #4B75FF;

    &.is-selected {
      color: #fff;
    }
  }

  &.is-weekend-sun {
    color: #F03823;

    &.is-selected {
      color: #fff;
    }
  }
  &.is-disabled {
    opacity: 0.3;
    cursor: not-allowed;
    pointer-events: none;
  }
}
</style>

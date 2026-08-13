<template>
  <!--
    SchedulerHeader: 다중 행 헤더
    - depth별 row (날짜 > 의사)
    - 날짜 행: < > 항상 표시 (±1일)
    - 의사 행: < > 조건부 (canPrevDoctor / canNextDoctor)
    - 의사 1명이면 doctor 행 제거
  -->
  <div class="scheduler-header">
    <div
      v-for="(row, rowIdx) in headerRows"
      :key="rowIdx"
      class="header-row"
      :class="getRowType(row)"
    >
      <!-- depth별 row -->

      <!-- 날짜 행: 왼쪽 < 버튼 -->
      <button
        v-if="isDateRow(row) && canPrevDay"
        class="header-nav header-nav--left"
        @click="emit('prev-day')"
      >‹</button>

      <!-- 의사 행: 왼쪽 < 버튼 (첫 번째 의사가 아닐 때만) -->
      <button
        v-if="isDoctorRow(row) && canPrevDoctor"
        class="header-nav header-nav--left"
        @click="emit('prev-doctor')"
      >‹</button>

      <!-- 셀들 -->
      <div
        v-for="node in row"
        :key="node.key"
        class="header-cell"
        :class="getCellClass(node)"
        :style="{ width: getCellWidth(node) + 'px', minWidth: getCellWidth(node) + 'px' }"
      >
        <span class="header-label">{{ node.label }}</span>

        <!-- 비공개(openYn='N') 담당자 뱃지 — isPrivate 전달 시만 렌더. 휴무 뱃지와 공존. -->
        <span
          v-if="node.isPrivate"
          class="header-badge header-badge--private"
        >비공개</span>

        <!-- 공휴일 휴무 (날짜 행, 빨강) — holidayLabel 전달 시만 렌더 -->
        <span
          v-if="node.holidayLabel"
          class="header-holiday"
        >{{ node.holidayLabel }}</span>

        <!-- 휴무/휴무 뱃지 -->
        <span
          v-if="showBadge(node)"
          class="header-badge"
          :class="getBadgeClass(node)"
        >
          {{ getBadgeText(node) }}
        </span>
      </div>

      <!-- 날짜 행: 오른쪽 > 버튼 -->
      <button
        v-show="isDateRow(row) && canNextDay"
        class="header-nav header-nav--right"
        @click="emit('next-day')"
      >›</button>

      <!-- 의사 행: 오른쪽 > 버튼 (마지막 의사가 아닐 때만) -->
      <button
        v-if="isDoctorRow(row) && canNextDoctor"
        class="header-nav header-nav--right"
        @click="emit('next-doctor')"
      >›</button>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref } from 'vue'
import dayjs from 'dayjs'
import { flattenHeaderByDepth } from '@/scheduler-engine/schedulerHeaderBuilder'

const props = defineProps({
  headerTree: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
  closedDayMap: { type: Object, default: () => ({}) },
  canPrevDoctor: { type: Boolean, default: false },
  canNextDoctor: { type: Boolean, default: false },
  canNextDay: { type: Boolean, default: true },
  // 날짜축 이전 페이징 가능 여부. 기본 true = 무조건 표시.
  canPrevDay: { type: Boolean, default: true },
  // 의사 1명이어도 doctor 행 유지(이름 표기 + 페이징 < > 노출). 기본 false = 1명이면 제거.
  // 한 페이지에 1명만 표시될 때 의사행째 사라져 < > 까지 갇히는 것 방지용.
  keepDoctorRow: { type: Boolean, default: false },
})

const emit = defineEmits(['prev-day', 'next-day', 'prev-doctor', 'next-doctor'])

// 오늘 판정 — nowTick(페이지 provide, 30초 주기) 기준이라 자정을 넘겨도 갱신된다.
// 좌/우 경계선은 여기서 그리지 않는다 — 헤더·본문에 나눠 그리면 행 구분선마다 끊겨 보인다.
// 보드 전체를 관통하는 단일 overlay(SchedulerV3Page `.v3-today-edge`)가 담당.
const nowTick = inject('nowTick', ref(Date.now()))
const todayStr = computed(() => dayjs(nowTick.value).format('YYYY-MM-DD'))

// headerTree → depth별 row 배열
const headerRows = computed(() => {
  if (!props.headerTree.length) return []
  const rows = flattenHeaderByDepth(props.headerTree)

  // 의사 1명이면 doctor 행 제거 (단 keepDoctorRow 면 1명이어도 유지 — 이름 표기 + 페이징 < > 노출)
  if (!props.keepDoctorRow && rows.length >= 2) {
    const lastRow = rows[rows.length - 1]
    const uniqueResources = new Set(lastRow.map(n => n.leafMeta?.resourceId).filter(Boolean))
    if (uniqueResources.size <= 1) {
      return rows.slice(0, -1)
    }
  }

  return rows
})

// ── row 타입 판정 ──
function isDateRow(row) {
  return row?.[0]?.type === 'date'
}

function isDoctorRow(row) {
  return row?.[0]?.type === 'doctor'
}

function getRowType(row) {
  if (isDateRow(row)) return 'header-row--date'
  if (isDoctorRow(row)) return 'header-row--doctor'
  return ''
}

// ── 셀 폭 ──
function getCellWidth(node) {
  if (!node.colSpan || !props.columns.length) return 0
  // leaf의 widthPx를 colSpan만큼 합산
  const leafIndex = props.columns.findIndex(c => c.key === node.key)
  if (leafIndex >= 0) return props.columns[leafIndex].widthPx

  // non-leaf: colSpan 범위의 columns widthPx 합산
  let width = 0
  let found = false
  let count = 0
  for (const col of props.columns) {
    if (!found && col.key.startsWith(node.key.split('_')[0])) {
      found = true
    }
    if (found) {
      width += col.widthPx
      count++
      if (count >= node.colSpan) break
    }
  }
  return width || 100
}

// ── 셀 class ──
function getCellClass(node) {
  // leaf(의사 행): doctor/hospital closed 모두 반영
  if (node.leafMeta) {
    const closed = props.closedDayMap[node.key]
    return {
      'is-hospital-closed': closed?.hospitalClosed,
      'is-doctor-closed': closed?.doctorClosed,
    }
  }
  // 날짜 행(non-leaf): 사업장 전체 휴무 + 오늘 강조
  if (node.type === 'date') {
    return {
      'is-hospital-closed': isDateHospitalClosed(node),
      'is-today': (node.date || node.key) === todayStr.value,
    }
  }
  return {}
}

// 날짜(non-leaf) 노드의 사업장 전체 휴무 여부 — 그 날짜 첫 column의 hospitalClosed 검사
// 참고: schedulerHeaderBuilder의 date 노드는 key=d.date (YYYY-MM-DD)이고 date 필드는 없음
//       따라서 node.key를 날짜로 사용
function isDateHospitalClosed(node) {
  const nodeDate = node.date || node.key
  const dateColumn = props.columns.find(c => c.date === nodeDate)
  if (!dateColumn) return false
  const closed = props.closedDayMap[dateColumn.key]
  return !!closed?.hospitalClosed
}

// ── 뱃지 ──
function showBadge(node) {
  // 의사(leaf): doctor 휴무 또는 hospital 휴무
  if (node.leafMeta) {
    const closed = props.closedDayMap[node.key]
    return !!(closed?.hospitalClosed || closed?.doctorClosed)
  }
  // 날짜 행: 사업장 전체 휴무 시만 '휴무' 뱃지
  // if (node.type === 'date') {
  //   return isDateHospitalClosed(node)
  // }
  return false
}

function getBadgeClass(node) {
  if (node.leafMeta) {
    const closed = props.closedDayMap[node.key]
    if (closed?.hospitalClosed) return 'header-badge--hospital'
    if (closed?.doctorClosed) return 'header-badge--doctor'
    return ''
  }
  if (node.type === 'date' && isDateHospitalClosed(node)) {
    return 'header-badge--hospital'
  }
  return ''
}

function getBadgeText(node) {
  if (node.leafMeta) {
    const closed = props.closedDayMap[node.key]
    // 사업장 전체 휴무도 '휴무'으로 통일 표기 (사용자 결정)
    if (closed?.hospitalClosed) return '휴무'
    if (closed?.doctorClosed) return '휴무'
    return ''
  }
  if (node.type === 'date' && isDateHospitalClosed(node)) {
    return '휴무'
  }
  return ''
}
</script>

<style lang="scss" scoped>
.scheduler-header {
  display: flex;
  flex-direction: column;
}

.header-row {
  display: flex;
  align-items: stretch;
  position: relative;

  &:not(:last-child) {
    border-bottom: 1px solid var(--scheduler-border, #d0d0d0);
  }
}

/* 의사/날짜 페이징 < > — absolute overlay(header cell이 0px부터 그려져 body column과 정렬 일치). */
.header-nav {
  flex-shrink: 0;
  width: 32px;
  padding: 0;
  line-height: 1;
  border: none;
  border-radius: 2px;
  background: #111;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  position: absolute; // 부모(.header-row)=position:relative 기준 overlay
  top: 0;
  bottom: 0;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35),
              inset 0 -1px 0 rgba(0, 0, 0, 0.15);
  transition: background-color 0.15s ease, transform 0.1s ease;
  font-size: 20px;
  font-weight: 800;
  user-select: none;

  &:hover {
    background: var(--scheduler-grabber, #8F94A3);
  }

  &:active {
    transform: scale(0.96);
  }

  &--left {
    left: 0;
  }

  &--right {
    right: 0;
  }
}

.header-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 4px;
  box-sizing: border-box;
  border-right: 1px solid var(--scheduler-border, #d0d0d0);
  font-size: 14px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &.is-hospital-closed {
    background: #f0f0f0;
    color: #bbb;
  }

  &.is-doctor-closed {
    background: #d9d9d9;
    color: #999;
  }

  /* 오늘 날짜 셀 — 브랜드 색 강조. 휴무 회색(is-hospital-closed)보다 뒤에 둬 오늘 식별이 우선한다. */
  &.is-today {
    background: var(--scheduler-brand, #2F6FED);
    color: #fff;
  }
}

.header-label {
  display: inline-block;
  max-width: calc(100% - 80px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;    
}

/* 공휴일 휴무 — 빨간색 강조(캘린더 관례). 날짜 행에서만 노출(holidayLabel 은 date 노드만 채워짐). */
.header-holiday {
  flex-shrink: 0;
  color: #d32f2f;
  font-weight: 700;
}

/* 오늘이 공휴일이면 브랜드 배경 위 빨강이 안 읽힌다 — 흰색으로 반전 */
.header-cell.is-today .header-holiday {
  color: #fff;
}

/* 휴무/휴무 뱃지 — pill, #111 bg, 11px bold */
.header-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  height: 18px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;

  &--hospital {
    background: #111;
    color: #fff;
  }

  &--doctor {
    background: #fff3e0;
    color: #e65100;
  }

  /* 비공개(openYn='N') 담당자 — 중립 회색 */
  &--private {
    background: #eee;
    color: #888;
    font-weight: 600;
  }
}
</style>

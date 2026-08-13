<template>
  <!--
    SchedulerGrid: body 영역의 배경 그리드.
    - 상태별 셀 클래스 (closed, lunch, dinner, blocked, past, now, zebra)
    - 빈 셀 hover: +추가 (isBlockedCell이 false인 셀만)
    - 클릭 → 예약 생성: isDisabled/isPastSlot이 아니면 허용(soft blocked 도 클릭 가능)
  -->
  <div class="scheduler-grid">
    <div
      v-for="band in bandInfos"
      :key="band.startMinute"
      class="grid-row"
      :style="{ height: band.heightPx + 'px' }"
    >
      <div
        v-for="col in columns"
        :key="col.key"
        class="grid-cell"
        :class="getCellClass(col, band)"
        :style="{ width: col.widthPx + 'px' }"
        :title="canClickToAdd(col, band) ? `우클릭하여 ${addLabel}` : ''"
        @click="onCellClick($event, col, band)"
        @contextmenu.prevent="onCellContextMenu($event, col, band)"
      >
        <!-- 차단 라벨 (점심시간/저녁시간/차단시간) -->
        <span v-if="showBlockLabel(col, band)" class="grid-cell__badge">
          {{ getBlockLabel(col, band) }}
        </span>

        <!-- hover overlay (+추가): 빈 셀(카드 없는 영역)에만 — 카드 있는 셀에선 카드에 가려 어색하므로 비표시. -->
        <div
          v-if="canShowEmptyAdd(col, band)"
          class="grid-cell__hover-overlay"
          :class="{ 'is-reschedule': reschedule?.active?.value }"
        >
          <span class="grid-cell__add-icon">+</span>
          <span v-if="!reschedule?.active?.value" class="grid-cell__add-text">추가</span>
          <!-- 우클릭 예약추가 발견성 힌트 (빈 셀 hover 시) -->
          <span v-if="!reschedule?.active?.value" class="grid-cell__add-hint">· 우클릭</span>
        </div>
      </div>
    </div>

    <!-- 우클릭 예약추가 context menu — body teleport(셀 overflow 클립 회피), 마우스 좌표 fixed. -->
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="cell-context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
        @mousedown.stop
        @contextmenu.prevent
      >
        <button
          class="cell-context-menu__item"
          type="button"
          :disabled="!contextMenu.canAdd"
          @click="onContextAdd"
        >
          {{ addLabel }}
        </button>
        <div v-if="contextMenu.reason" class="cell-context-menu__reason">
          {{ contextMenu.reason }}
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import { storeToRefs } from 'pinia'

const filterStore = useSchedulerFilterStore()
const { dataType } = storeToRefs(filterStore)

const props = defineProps({
  columns: { type: Array, default: () => [] },
  bandInfos: { type: Array, default: () => [] },
  closedDayMap: { type: Object, default: () => ({}) },
  bandRowCountMap: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['cell-click'])

const getBlockedReason = inject('getBlockedReason', null)
const nowTick = inject('nowTick', ref(Date.now()))
const interactionLock = inject('schedulerInteractionLock', null)
// 예약 변경(reschedule) 모드 — provide 없으면 기존 동작 그대로(사이드이펙트 0).
const reschedule = inject('schedulerReschedule', null)
// ⋮ popover 상태 — 카드 popover 가 열리면 우클릭 context menu 를 닫아 동시 표시 방지.
const popover = inject('schedulerPopover', null)

// ═══════════════════════════════════════════════════════════
// 셀 상태 판정 — getBlockedReason → reason 기반 정밀 분류
// ═══════════════════════════════════════════════════════════

/**
 * getBlockedReason 반환값 정책:
 *   blocked: true  + reason: 'closedDate'|'closedWeekday'|'outsideHours' → 강제 차단
 *   blocked: false + reason: 'lunch'|'dinner'|'blockedTime'             → soft 차단 (UI 표시만, 클릭 가능)
 *   blocked: false + reason: 'none'                                     → 정상 셀
 * reason === 'none'이면 null 반환, 그 외는 모두 유효한 reason.
 */
function getReason(col, slot) {
  if (!getBlockedReason) return null
  if (!slot || slot.startMinute == null) return null
  const date = dayjs(col.date)
    .hour(Math.floor(slot.startMinute / 60))
    .minute(slot.startMinute % 60)
    .second(0)
    .toDate()
  const result = getBlockedReason(date, col.resourceId)
  const reason = result?.reason ?? null
  if (!reason || reason === 'none') return null
  return reason
}

// ── 판정 함수 ──

function isClosed(col, slot) {
  const r = getReason(col, slot)
  // closedDate/closedWeekday는 blocked:true로 반환됨
  return r === 'closedDate' || r === 'closedWeekday'
}


function isOutsideHours(col, slot) {
  return getReason(col, slot) === 'outsideHours'
}

function isLunch(col, slot) {
  return getReason(col, slot) === 'lunch'
}

function isDinner(col, slot) {
  return getReason(col, slot) === 'dinner'
}

function isBlockedTime(col, slot) {
  return getReason(col, slot) === 'blockedTime'
}

/** isSoftBlocked = lunch || dinner || blockedTime || outsideHours */
function isSoftBlocked(col, slot) {
  return isLunch(col, slot) || isDinner(col, slot) || isBlockedTime(col, slot) || isOutsideHours(col, slot)
}

function isTodayCol(col) {
  return dayjs(col.date).isSame(dayjs(), 'day')
}

/** isPastSlot = slotEnd <= now (해당 날짜 기준) */
function isPastSlot(col, slot) {
  if (!isTodayCol(col)) {
    return dayjs(col.date).isBefore(dayjs(), 'day')
  }
  const slotEndMs = dayjs().startOf('day').add(slot.endMinute, 'minute').valueOf()
  return slotEndMs <= nowTick.value
}

/** isNowSlot = slotStart <= now < slotEnd (오늘만) */
function isNowSlot(col, slot) {
  if (!isTodayCol(col)) return false
  const now = nowTick.value
  const slotStartMs = dayjs().startOf('day').add(slot.startMinute, 'minute').valueOf()
  const slotEndMs = dayjs().startOf('day').add(slot.endMinute, 'minute').valueOf()
  return slotStartMs <= now && now < slotEndMs
}

/**
 * isTreatment = !isNowSlot && dataType === 'TREATMENT'
 * ⚠️ 단순 모드 체크가 아님! now슬롯이면 false
 */
function isTreatment(col, slot) {
  return !isNowSlot(col, slot) && dataType.value === 'TREATMENT'
}

/** isDisabled = isTreatment || isClosed */
function isDisabled(col, slot) {
  return isTreatment(col, slot) || isClosed(col, slot)
}

/** isBlockedCell = lunch || dinner || blockedTime || closed || past || disabled (outsideHours 제외) */
function isBlockedCell(col, slot) {
  return isLunch(col, slot) ||
    isDinner(col, slot) ||
    isBlockedTime(col, slot) ||
    // isOutsideHours(col, slot) ||  // 의도적으로 제외
    isClosed(col, slot) ||
    isPastSlot(col, slot) ||
    isDisabled(col, slot)
}

/** 해당 column × band에 예약이 있는지 */
function hasCellAppointments(col, band) {
  const rows = props.bandRowCountMap[col.key]
  if (!rows) return false
  return (rows[band.bandIndex] ?? 0) > 0
}

/** canShowEmptyAdd = !hasAppointments && !isBlockedCell */
function canShowEmptyAdd(col, band) {
  // 변경 모드: lock 은 reschedule 자신이므로 무시. 빈 셀 + 휴무/과거 아닌 셀에 이동 가능 "+" 표시
  // (시간외 등 soft-blocked 도 노출 → 클릭 시 handleDrop validate 가 경고 처리, drag 와 동일 규칙).
  if (reschedule?.active?.value) {
    return !hasCellAppointments(col, band) && !isDisabled(col, band) && !isPastSlot(col, band)
  }
  if (interactionLock?.isLocked?.value) return false
  if (hasCellAppointments(col, band)) return false
  return !isBlockedCell(col, band)
}

/** 클릭 추가 가능 = !isDisabled && !isPastSlot */
function canClickToAdd(col, slot) {
  // 변경 모드: lock 무시(자기 자신), 빈 셀 + 휴무/과거 아닌 셀만 클릭 허용(점유 셀=드래그로 겹침 처리).
  if (reschedule?.active?.value) {
    return !hasCellAppointments(col, slot) && !isDisabled(col, slot) && !isPastSlot(col, slot)
  }
  // drag/resize/create 등 인터랙션 중에는 추가 hover overlay 숨김 (lock 정합성)
  if (interactionLock?.isLocked?.value) return false
  if (isDisabled(col, slot)) return false
  if (isPastSlot(col, slot)) return false
  return true
}

function showBlockLabel(col, slot) {
  const r = getReason(col, slot)
  if (!r) return false
  if (isClosed(col, slot)) return false
  if (isOutsideHours(col, slot)) return false
  return isSoftBlocked(col, slot)
}

function getBlockLabel(col, slot) {
  const r = getReason(col, slot)
  if (r === 'lunch') return '휴게시간1'
  if (r === 'dinner') return '휴게시간2'
  if (r === 'blockedTime') return '차단시간'
  return ''
}

function onCellClick(ev, col, slot) {
  if (ev.target?.closest?.('.appointment-card')) return
  if (!canClickToAdd(col, slot)) return

  emit('cell-click', {
    columnKey: col.key,
    date: col.date,
    resourceId: col.resourceId,
    resourceLabel: col.resourceLabel,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
  })
}

// ═══════════════════════════════════════════════════════════
// 우클릭 예약추가 context menu — 빈 셀(추가 가능)만, cell-click 재사용
// ═══════════════════════════════════════════════════════════

const contextMenu = ref(null) // { x, y, col, band } | null

// 예약/진료 장부에 따른 추가 액션 라벨.
const addLabel = computed(() => (dataType.value === 'TREATMENT' ? '진료 추가' : '예약 추가'))

// 추가 불가 사유 — 메뉴 disabled 항목 아래 작게 표시(왜 안 되는지 전달).
function disabledReason(col, slot) {
  if (isClosed(col, slot)) return '휴무일'
  if (isPastSlot(col, slot)) return '지난 시간'
  // 방문 장부는 현재 시각(now) 슬롯만 등록 가능 → 아직 안 온 시각은 '영구 불가'가 아니라 시각 대기.
  if (dataType.value === 'TREATMENT') return '아직 진료 시간 전'
  return '예약할 수 없는 시간' // 예약장부 — 휴무/과거 외 예외(lock 등), 실제 거의 발생 안 함
}

function onCellContextMenu(ev, col, slot) {
  if (ev.target?.closest?.('.appointment-card')) return
  if (reschedule?.active?.value) return // 변경 모드 중엔 비활성
  const canAdd = canClickToAdd(col, slot)
  // 화면 끝 보정 — 메뉴가 우/하단 가장자리에서 잘리지 않도록 좌/위로 당김.
  const MENU_W = 150
  const MENU_H = 70
  const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - MENU_W - 8))
  const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - MENU_H - 8))
  // 메뉴는 항상 노출(일관 UX) — 추가 불가 셀은 항목을 disabled + 사유 로 표시(무반응·기본메뉴 대신).
  contextMenu.value = { x, y, col, band: slot, canAdd, reason: canAdd ? '' : disabledReason(col, slot) }
}

function closeContextMenu() {
  contextMenu.value = null
}

function onContextAdd() {
  const ctx = contextMenu.value
  if (!ctx || !ctx.canAdd) return // disabled 방어
  emit('cell-click', {
    columnKey: ctx.col.key,
    date: ctx.col.date,
    resourceId: ctx.col.resourceId,
    resourceLabel: ctx.col.resourceLabel,
    startMinute: ctx.band.startMinute,
    endMinute: ctx.band.endMinute,
  })
  closeContextMenu()
}

// 메뉴 열리면 외부 클릭/스크롤 시 닫기(메뉴 내부는 @mousedown.stop 으로 유지).
watch(contextMenu, (v) => {
  if (v) {
    document.addEventListener('mousedown', closeContextMenu)
    window.addEventListener('scroll', closeContextMenu, true)
  } else {
    document.removeEventListener('mousedown', closeContextMenu)
    window.removeEventListener('scroll', closeContextMenu, true)
  }
})

// ⋮ popover 가 열리면 context menu 닫기 — 동시 표시 방지(반대 방향: AppointmentCard.onCardContextMenu 의 popover.close()).
watch(() => popover?.isOpen?.value, (open) => {
  if (open) closeContextMenu()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeContextMenu)
  window.removeEventListener('scroll', closeContextMenu, true)
})

// ═══════════════════════════════════════════════════════════
// 셀 클래스
// ═══════════════════════════════════════════════════════════

function getCellClass(col, slot) {
  const closed = isClosed(col, slot)
  const outside = isOutsideHours(col, slot)
  const lunch = isLunch(col, slot)
  const dinner = isDinner(col, slot)
  const blocked = isBlockedTime(col, slot)
  const past = isPastSlot(col, slot)
  const now = isNowSlot(col, slot)
  const treatment = isTreatment(col, slot)
  const disabled = isDisabled(col, slot)
  const softBlocked = isSoftBlocked(col, slot)

  return {
    'is-closed': closed,
    'is-outside': outside,
    'is-lunch': lunch,
    'is-dinner': dinner,
    'is-blocked': blocked,
    'is-past': past && !closed,
    'is-disabled': (!treatment && disabled) || (past && !closed && softBlocked),
    'is-now': now,
    'is-zebra': !lunch && !dinner && !blocked && !outside && !closed && !past && !now,
    // 클릭/추가 가능 상태
    'is-clickable': canClickToAdd(col, slot),
    'is-empty-add': canShowEmptyAdd(col, slot),
    'is-has-appt': hasCellAppointments(col, slot) && canClickToAdd(col, slot),
  }
}
</script>

<style lang="scss" scoped>
/* ═══════════════════════════════════════════════════════════
 * 셀 배경 토큰
 * ═══════════════════════════════════════════════════════════ */
$cell-bg-lunch: var(--scheduler-cell-disabled, #EBEBEB);
$cell-bg-dinner: var(--scheduler-cell-disabled, #EBEBEB);
$cell-bg-blocked: var(--scheduler-cell-disabled, #EBEBEB);
$cell-bg-closed: var(--scheduler-cell-disabled, #EBEBEB);
$cell-bg-past: var(--scheduler-cell-disabled, #EBEBEB);
$cell-bg-now: rgba(37, 106, 245, 0.08);
$cell-bg-stripe-odd: var(--scheduler-stripe-odd, #ffffff);
$cell-bg-stripe-even: var(--scheduler-stripe-even, #f5f6f8);

.scheduler-grid {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  // pointer-events를 개별 셀에서 제어
  pointer-events: none;
}

.grid-row {
  display: flex;
  box-sizing: border-box;
  border-bottom: 1px solid var(--scheduler-border-light, #f0f0f0);

  &:nth-child(even) > .grid-cell.is-zebra {
    background: $cell-bg-stripe-even;
  }
}

/* ═══════════════════════════════════════════════════════════
 * 셀 기본
 * ═══════════════════════════════════════════════════════════ */
.grid-cell {
  flex-shrink: 0;
  box-sizing: border-box;
  border-right: 1px solid var(--scheduler-border-light, #f0f0f0);
  position: relative;
  /* 모든 셀이 우클릭(context menu)을 수신 — 추가 불가 셀도 메뉴를 disabled 로 표시하기 위함.
     좌클릭은 canClickToAdd 가드로, hover +추가는 is-empty-add 클래스로 기존 동작 유지(none 이면 우클릭이 셀에 안 닿아 브라우저 기본 메뉴가 뜸). */
  pointer-events: auto;

  /* ── 상태별 배경 ── */
  &.is-closed { background: $cell-bg-closed; }
  &.is-outside { background: $cell-bg-closed; }
  &.is-lunch { background: $cell-bg-lunch; }
  &.is-dinner { background: $cell-bg-dinner; }
  &.is-blocked { background: $cell-bg-blocked; }
  &.is-past { background: $cell-bg-past; }
  &.is-now { background: $cell-bg-now; }

  &.is-disabled {
    background: $cell-bg-closed;
  }

  /* 일반 셀 기본 배경 (흰색) */
  &.is-zebra {
    background: $cell-bg-stripe-odd;
  }

  /* 클릭 가능 셀 (soft blocked 포함) — cursor 만 (pointer-events 는 .grid-cell 에서 일괄 auto) */
  &.is-clickable {
    cursor: pointer;
  }

  /* 빈 셀 hover (+추가 표시, blocked 제외) — zebra보다 우선 */
  &.is-empty-add:hover,
  &.is-empty-add.is-zebra:hover {
    background: rgba(255, 170, 60, 0.28) !important;
    outline: 1px solid rgba(255, 150, 40, 0.7);
    outline-offset: -1px;

    .grid-cell__hover-overlay {
      opacity: 1;
      visibility: visible;
    }
  }

  /* 예약이 있는 band: hover 시 테두리 + +추가 표시 */
  &.is-has-appt:hover {
    outline: 1px dashed rgba(255, 150, 40, 0.8);
    outline-offset: -1px;

    .grid-cell__hover-overlay {
      opacity: 1;
      visibility: visible;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
 * 차단 라벨 (점심시간 등)
 * ═══════════════════════════════════════════════════════════ */
.grid-cell__badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 14px;
  color: #999;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

/* ═══════════════════════════════════════════════════════════
 * 빈 셀 hover overlay (+추가)
 * 카드 없는 빈 영역에만 표시(Grid는 AppointmentLayer 아래라 카드 위엔 안 그려짐).
 * ═══════════════════════════════════════════════════════════ */
.grid-cell__hover-overlay {
  position: absolute;
  inset: 0;
  /* grid 셀 내부 배경/badge 위. AppointmentLayer(z5)보다 아래라 멀티밴드 관통 카드는 안 가림. */
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  visibility: hidden;
  transition: opacity 120ms ease, visibility 120ms ease;
  pointer-events: none;
}

/* 예약 변경 모드 빈 슬롯 hover — 주황 점선 박스 + "+"(화면정의서 13-6 ③). */
.grid-cell__hover-overlay.is-reschedule {
  inset: 2px;
  border: 1.5px dashed var(--scheduler-brand, #2F6FED);
  border-radius: 3px;
  background: rgba(235, 97, 0, 0.06);
}
.grid-cell__hover-overlay.is-reschedule .grid-cell__add-icon {
  font-size: 22px;
  font-weight: 700;
}

.grid-cell__add-icon {
  font-size: 18px;
  font-weight: 500;
  color: var(--scheduler-brand, #2F6FED);
  line-height: 1;
}

.grid-cell__add-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--scheduler-brand, #2F6FED);
}

/* 우클릭 예약추가 발견성 힌트 — '+추가' 옆 작은 보조 표기 */
.grid-cell__add-hint {
  font-size: 11px;
  font-weight: 500;
  color: rgba(235, 97, 0, 0.65);
  white-space: nowrap;
}

/* ═══════════════════════════════════════════════════════════
 * 우클릭 예약추가 context menu (body teleport, fixed)
 * ═══════════════════════════════════════════════════════════ */
.cell-context-menu {
  position: fixed;
  z-index: 60000;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 4px 16px 2px rgba(0, 0, 0, 0.18);
  padding: 4px;
  min-width: 110px;
}

.cell-context-menu__item {
  width: 100%;
  border: none;
  background: transparent;
  padding: 7px 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--scheduler-brand, #2F6FED);
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;

  &:hover:not(:disabled) {
    background: rgba(235, 97, 0, 0.08);
  }

  /* 추가 불가 셀(휴무/과거/lock) — 메뉴는 뜨되 회색 비활성 */
  &:disabled {
    color: #bbb;
    cursor: not-allowed;
  }
}

/* 추가 불가 사유 (disabled 항목 아래 작은 회색 안내) */
.cell-context-menu__reason {
  padding: 0 12px 4px;
  font-size: 11px;
  color: #aaa;
  white-space: nowrap;
}
</style>

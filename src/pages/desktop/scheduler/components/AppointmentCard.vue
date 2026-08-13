<template>
  <!--
    card-wrapper:
    - mouseenter/mouseleave → hover 제어
    - mousedown → drag 시작 (resize handle에서 stopPropagation되므로 여기까지 오면 drag)
    - :class로 hover/drag/resize 상태에 따른 스타일 분기
  -->
  <div
    ref="cardEl"
    class="appointment-card"
    :class="[
      statusContainerClass,
      {
        'is-hovered': isHovered,
        'is-dragging': isDragTarget,
        'is-resizing': isResizeTarget,
        'is-invalid': isInvalidPreview,
        'is-popover-open': isPopoverOpen,
        'is-search-highlighted': isSearchHighlighted,
        'is-reschedule-target': isRescheduleTarget,
        'is-layered': rect.isLayered,
      },
    ]"
    :style="cardStyle"
    :title="isAppointmentMode ? '우클릭하여 예약 추가' : '우클릭하여 진료 추가'"
    @mouseenter="onCardEnter"
    @mouseleave="onCardLeave"
    @mousedown="onCardMouseDown"
    @contextmenu="onCardContextMenu"
  >
    <!-- ── resize top handle ── -->
    <div
      class="resize-handle resize-handle--top"
      @mousedown="onResizeTop"
    />

    <!-- ── card body (1행: 고객명, 2행: 전화번호 | 메모) ── -->
    <div class="card-body">
      <div class="card-row card-row--primary">
        <span class="card-patient" :class="{ 'is-join': appointment.isJoinMember }">
          {{ appointment.patientName }}
        </span>
        <!-- 종료시각(~ HH:mm) — 고객명 뒤. 긴/짧은 예약 겹침 구분용(예약·진료 공통). 이름보다 우선 보존. -->
        <span v-if="endTimeLabel" class="card-end-time">~ {{ endTimeLabel }}</span>
        <span v-if="appointment.isExternalSync" class="card-external-badge">EXT</span>
        <span v-if="isRegisteredToday" class="card-today-badge">당일</span>
      </div>
      <!-- 기존 레이아웃(V2 backward compat): 전화 | 메모 -->
      <div v-if="useLegacyLayout" class="card-row card-row--secondary">
        <span v-if="appointment.patientPhone" class="card-phone">{{ phoneLast4 }}</span>
        <span v-if="appointment.patientPhone && appointment.memo" class="card-divider">|</span>
        <span v-if="appointment.memo" class="card-memo">{{ appointment.memo }}</span>
      </div>
      <!-- displayInfo 동적: 선택 표시정보를 ' | ' 로 이은 단일 블록. rowHeightLevel=정보 줄 수(-webkit-line-clamp). -->
      <!-- memo(서비스 내용)는 표시정보 옵션이 아니므로 카드 본문에 표기하지 않음(화면정의서 기준). -->
      <template v-else>
        <div
          v-if="secondaryParts.length"
          ref="infoBlockEl"
          class="card-info-block"
          :style="{ '-webkit-line-clamp': infoLineClamp }"
          @mouseenter="onInfoEnter"
          @mouseleave="onInfoLeave"
        >{{ infoText }}</div>
      </template>
    </div>

    <!-- ── resize bottom handle ── -->
    <div
      class="resize-handle resize-handle--bottom"
      @mousedown="onResizeBottom"
    />

    <!--
      quick action 버튼:
      - hover 중 + showQuickAction = true 일 때만 노출
      - mouseenter/mouseleave → hover leave delay 제어
      - click → popover toggle
      - DOM 트리상 card-wrapper 내부 → mouseleave card 발생 안 함
    -->
    <!-- 진료화면 퀵 액션: [접수] 또는 [완료] -->
    <button
      v-if="isHovered && showQuickAction && quickActionLabel"
      class="quick-action-state-btn"
      :class="quickActionBtnClass"
      @mouseenter="hover.onQuickActionEnter()"
      @mouseleave="hover.onQuickActionLeave()"
      @mousedown.stop
      @click.stop="handleQuickAction"
    >
      {{ quickActionLabel }}
    </button>

    <!-- hover 주황 테두리 — .v3-qa-portal 로 teleport. 카드 자체 border 는 z 높은 인접 카드에
         잘려 뜨문뜨문 보임 → 포털 z(전 카드 위)에 투명 박스+테두리만 얹어 온전히 표시. 마우스 비차단. -->
    <Teleport to=".v3-qa-portal">
      <div
        v-if="isHovered && !isDragTarget && !isResizeTarget"
        class="appointment-hover-border"
        :style="hoverBorderStyle"
      />
    </Teleport>

    <!-- ⋮ 버튼 — .v3-qa-portal(보드 좌표) 로 teleport → 카드 stacking context 밖+모든 카드 위라
         겹친(floating) 카드에 안 가림. absolute(보드 기준)+rect 좌표 라 스크롤 정상(fixed 아님). -->
    <Teleport to=".v3-qa-portal">
      <div
        v-if="isHovered && showQuickAction || isPopoverOpen"
        class="quick-action-wrapper"
        :style="quickActionStyle"
      >
        <button
          ref="quickActionBtnEl"
          class="quick-action-btn"
          @mouseenter="hover.onQuickActionEnter()"
          @mouseleave="hover.onQuickActionLeave()"
          @mousedown.stop
          @click.stop="onQuickActionClick"
        >
          <span class="quick-action-icon">⋮</span>
        </button>
      </div>
    </Teleport>

    <!-- popover: ⋮ 메뉴 — 별도 Teleport(body) fixed (레이어링 카드 안 가림) -->
    <Teleport to="body">
      <div
        v-if="isPopoverOpen"
        ref="popoverPanelEl"
        class="appointment-popover"
        :style="popoverStyle"
        @mousedown.stop
      >
        <div class="popover-menu">
          <button
            v-for="btn in dotMenuButtons"
            :key="btn.value"
            :disabled="btn.disabled"
            class="popover-menu__item"
            @mousedown.stop
            @click.stop="handleDotAction(btn.value)"
          >
            {{ btn.displayLabel }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- 카드 표시정보 말줄임 시 전체내용 툴팁 — body 로 teleport(카드 overflow:hidden 클립 회피). -->
    <Teleport to="body">
      <div
        v-if="infoTooltipOpen"
        class="appt-info-tooltip"
        :style="infoTooltipStyle"
      >{{ infoText }}</div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, inject, onBeforeUnmount } from 'vue'
import dayjs from 'dayjs'
import { storeToRefs } from 'pinia'
import { useDialog } from '@/lib/useDialog'
import { useBookStore } from '@/stores/bookStore'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import { buildCardMenu, toApiState } from '../appointmentCardMenu'

// ── props / emits ──
const props = defineProps({
  appointment: { type: Object, required: true },
  rect: { type: Object, required: true },
  columnKey: { type: String, required: true },
  displayTier: { type: String, default: 'standard' },
  // 표시정보 순서. null = 기존 하드코딩 레이아웃(전화|메모), 배열 = displayInfo 동적 렌더.
  displayInfo: { type: Array, default: null },
  // 카드 높이 단계(1~5) = 정보 표시 줄 수(-webkit-line-clamp).
  rowHeightLevel: { type: Number, default: 3 },
  // 예약 시간단위(분). 종료시각은 예약 길이가 이 값보다 클 때만 표기(딱 1칸 예약은 종료시각 자명 → 숨김).
  cellDuration: { type: Number, default: 30 },
})

// displayInfo 동적 렌더 — null 이면 기존 레이아웃(전화|메모) 유지.
const useLegacyLayout = computed(() => props.displayInfo == null)
const secondaryParts = computed(() => {
  const codes = props.displayInfo ?? []
  const a = props.appointment
  const out = []
  for (const code of codes) {
    if (code === 'NAME') continue // 고객명은 항상 primary 행
    let v = ''
    if (code === 'BIRTH') v = a.birth ?? ''
    else if (code === 'AGE') v = a.age ? `${a.age}세` : ''
    else if (code === 'GENDER') v = a.gender ?? ''
    else if (code === 'TREATMENT') {
      // 서비스 항목 = 등록된 서비스 항목 선택값(treatmentCategory) + 서비스 내용(memo) 함께 표기.
      // 둘 다 nullable(각각 단독/둘다/없음 허용) → 존재하는 것만 공백으로 이어 붙임.
      v = [a.treatmentCategory ?? '', a.memo ?? ''].filter(Boolean).join(' ')
    }
    else if (code === 'PHONE') {
      const digits = (a.patientPhone ?? '').replace(/\D/g, '')
      v = digits.length >= 4 ? digits.slice(-4) : (a.patientPhone ?? '')
    }
    if (v) out.push(v) // 빈값(비회원 birth/age/gender 등) 스킵
  }
  return out
})

// 선택 표시정보를 ' | ' 로 이은 단일 텍스트. -webkit-box 안에서 자연 줄바꿈.
const infoText = computed(() => secondaryParts.value.join(' | '))

// 정보 표시 줄 수 = 카드 높이 단계(1~5). 카드 px 높이(50+15×(N-1))와 정합.
const infoLineClamp = computed(() => {
  const n = Number(props.rowHeightLevel) || 3
  return Math.max(1, Math.min(5, Math.trunc(n)))
})

// ── 표시정보 툴팁(말줄임 시 전체내용) — body teleport + fixed 좌표 ──
const infoBlockEl = ref(null)
const infoTooltipOpen = ref(false)
const infoTooltipStyle = ref({})
function onInfoEnter() {
  const el = infoBlockEl.value
  if (!el) return
  // 실제로 말줄임(clamp)된 경우에만 노출 — 다 보이는 카드엔 불필요한 툴팁 억제.
  if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return
  const r = el.getBoundingClientRect()
  const TOOLTIP_MAX_W = 300
  // 가로: 블록 좌측 기준, 뷰포트 우측 넘치면 보정. 세로: 블록 위(공간 부족 시 아래).
  const left = Math.min(Math.max(8, r.left), window.innerWidth - TOOLTIP_MAX_W - 8)
  const placeBelow = r.top < 120
  infoTooltipStyle.value = placeBelow
    ? { position: 'fixed', top: `${Math.round(r.bottom + 6)}px`, left: `${Math.round(left)}px`, maxWidth: `${TOOLTIP_MAX_W}px` }
    : { position: 'fixed', bottom: `${Math.round(window.innerHeight - r.top + 6)}px`, left: `${Math.round(left)}px`, maxWidth: `${TOOLTIP_MAX_W}px` }
  infoTooltipOpen.value = true
}
function onInfoLeave() {
  infoTooltipOpen.value = false
}

const emit = defineEmits(['edit', 'delete', 'status-change', 'callback'])

// ── inject ──
const hover = inject('schedulerHover')
const popover = inject('schedulerPopover')
const drag = inject('schedulerDrag')
const resize = inject('schedulerResize')
// 검색 드롭다운 pick 하이라이트 — optional: provide 없는 페이지는 항상 비활성.
const searchHighlight = inject('schedulerSearchHighlight', null)
// 예약 변경(reschedule) 모드 — provide 없으면 ⋮"변경"은 기존 emit('edit')(팝업) 유지.
const reschedule = inject('schedulerReschedule', null)

// ── refs ──
const cardEl = ref(null)
const quickActionBtnEl = ref(null)
const popoverPanelEl = ref(null)

// ── 파생 상태 ──
const isHovered = computed(() =>
  hover.hoveredId.value === props.appointment.id
)

const showQuickAction = computed(() =>
  isHovered.value && hover.showQuickAction.value
)

const isDragTarget = computed(() =>
  drag.dragState.value?.appointmentId === props.appointment.id
)

const isResizeTarget = computed(() =>
  resize.resizeState.value?.appointmentId === props.appointment.id
)

const isInvalidPreview = computed(() => {
  if (isDragTarget.value) return !drag.dragState.value?.isValid
  if (isResizeTarget.value) return !resize.resizeState.value?.isValid
  return false
})

const isPopoverOpen = computed(() =>
  popover.openedId.value === props.appointment.id
)

const isSearchHighlighted = computed(() =>
  !!searchHighlight
  && searchHighlight.highlightedId.value != null
  && String(searchHighlight.highlightedId.value) === String(props.appointment.id)
)

// 예약 변경 모드에서 선택된(이동 대상) 카드 — 주황 테두리 하이라이트(화면정의서 13-6 ②).
const isRescheduleTarget = computed(() =>
  !!reschedule
  && reschedule.targetId.value != null
  && String(reschedule.targetId.value) === String(props.appointment.id)
)

// '당일' 뱃지 — 진료 화면에서만, 예약 등록일(createdAt)이 오늘이면 표시(고객명 line 우측).
const isRegisteredToday = computed(() => {
  if (isAppointmentMode.value) return false // 진료 화면 전용
  const reg = props.appointment.createdAt
  return !!reg && dayjs(reg).isSame(dayjs(), 'day')
})

// ── 카드 스타일 (layout rect 기반) ──
const cardStyle = computed(() => {
  // hover/popover 시 z-index 안 올림(겹친 카드 순서 유지). ⋮ popover 는 Teleport(body)로 최상위 표시.
  return {
    position: 'absolute',
    top: `${props.rect.top}px`,
    left: `${props.rect.left}px`,
    width: `${props.rect.width}px`,
    height: `${props.rect.height}px`,
    // 검색 하이라이트는 z 를 올리지 않음(테두리만). 단 예약 변경 대상 카드는 선택 테두리가 아래 카드에 가리지
    // 않도록 z 를 최상위로 올린다(사용자 요청). 인라인 style 이라 CSS 클래스보다 우선 적용됨.
    zIndex: isRescheduleTarget.value ? 60001 : (props.rect.zIndex ?? 1),
  }
})

// ⋮ popover 위치 — Teleport(body) 후 fixed 좌표. trigger(⋮ 버튼) 기준 좌상단, 왼쪽으로 펼침.
const popoverStyle = computed(() => {
  const rect = popover.popoverState.value?.anchorRect
  if (!rect) return {}
  return {
    position: 'fixed',
    top: `${rect.top}px`,
    right: `${window.innerWidth - rect.left}px`,
    zIndex: 60000,
  }
})

// ⋮ 버튼 위치 — .v3-qa-portal(보드 좌표) 로 teleport 후 카드 rect 기준 absolute. 카드 우측 변 24px.
// 보드 좌표(rect.top/left)라 스크롤 따라옴(fixed 아님). 포털 z 가 모든 카드 위 → 겹친 카드에 안 가림.
const quickActionStyle = computed(() => {
  const r = props.rect
  return {
    position: 'absolute',
    top: `${r.top}px`,
    left: `${r.left + r.width - 24}px`,
    width: '24px',
    height: `${r.height}px`,
  }
})

// hover 테두리 오버레이 위치 — ⋮ 와 같은 .v3-qa-portal(보드 좌표) 기준 카드 rect 전체.
const hoverBorderStyle = computed(() => {
  const r = props.rect
  return {
    position: 'absolute',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  }
})

// ── 시간 라벨 ──
function formatMinute(m) {
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${h}:${String(min).padStart(2, '0')}`
}

// 종료시각 라벨('~ HH:mm' 의 HH:mm) — 시도 0-패딩(formatMinute 의 '9:30' 과 달리 '09:30')으로 표기 통일.
// 예약 길이가 시간단위(cellDuration)보다 큰 경우(여러 칸)에만 표기 → 딱 1칸 예약은 종료시각 자명하므로 숨김.
const endTimeLabel = computed(() => {
  const { startMinute, endMinute } = props.appointment
  if (endMinute == null || !Number.isFinite(endMinute)) return ''
  if (endMinute - startMinute <= props.cellDuration) return ''
  const h = Math.floor(endMinute / 60)
  const min = endMinute % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
})


// 전화번호 뒤 4자리
const phoneLast4 = computed(() => {
  const phone = props.appointment.patientPhone ?? ''
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : digits
})

// 상태 클래스(is-waiting/is-done/is-undone/is-cancel) → 카드 컨테이너 클래스
const STATUS_CLASS_MAP = {
  'is-done': 'status-done',
  'is-undone': 'status-undone',
  'is-cancel': 'status-cancel',
  'is-receipt': 'status-receipt',
}

const statusContainerClass = computed(() => {
  const v1Class = props.appointment.statusClass
  return STATUS_CLASS_MAP[v1Class] ?? ''
})


// ═══════════════════════════════════════════════════════════
// 이벤트 핸들러
// ═══════════════════════════════════════════════════════════

function onCardEnter(e) {
  hover.onCardEnter(props.appointment.id, e.currentTarget)
  // 다른 appointment의 popover가 열려 있으면 닫기
  if (popover.isOpen.value && popover.openedId.value !== props.appointment.id) {
    popover.close()
  }
}

function onCardLeave() {
  hover.onCardLeave()
}

// 카드 위 우클릭 → 아래 grid-cell 로 위임(셀 예약추가 메뉴 재사용). 카드가 칸을 채워 빈 strip 우클릭이 어려운 경우.
//   elementsFromPoint(복수)로 같은 좌표의 요소 스택에서 grid-cell 을 직접 찾는다 —
//   레이어링(겹친) 카드에서 단수 elementFromPoint 가 아래 base 카드를 가리켜 위임이 끊기던 문제 방지.
function onCardContextMenu(e) {
  e.preventDefault()
  // ⋮ popover 가 열려 있으면 닫는다 — grid 우클릭 메뉴와 동시 표시 방지(반대 방향은 SchedulerGrid 가 popover 열림 watch).
  popover.close()
  const cell = document.elementsFromPoint(e.clientX, e.clientY).find(el => el.classList.contains('grid-cell'))
  cell?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY }))
}

function onCardMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  drag.startDrag(e, {
    appointmentId: props.appointment.id,
    columnKey: props.columnKey,
    startMinute: props.appointment.startMinute,
    endMinute: props.appointment.endMinute,
    rect: { ...props.rect },
  })
}

function onResizeTop(e) {
  if (e.button !== 0) return
  e.preventDefault()
  resize.startResize(e, {
    appointmentId: props.appointment.id,
    columnKey: props.columnKey,
    startMinute: props.appointment.startMinute,
    endMinute: props.appointment.endMinute,
    direction: 'top',
    rect: { ...props.rect },
  })
  // startResize 내부에서 e.stopPropagation() 처리됨
  // → card-wrapper의 mousedown (drag) 까지 전파 안 됨
}

function onResizeBottom(e) {
  if (e.button !== 0) return
  e.preventDefault()
  resize.startResize(e, {
    appointmentId: props.appointment.id,
    columnKey: props.columnKey,
    startMinute: props.appointment.startMinute,
    endMinute: props.appointment.endMinute,
    direction: 'bottom',
    rect: { ...props.rect },
  })
}

function onQuickActionClick(e) {
  popover.toggle(props.appointment.id, e.currentTarget)
}

// ═══════════════════════════════════════════════════════════
// Dot Menu + Hover Quick Action
// 예약화면: ⋮ → 변경/취소/삭제
// 진료화면: ⋮ → 완료/미이행/취소/초기화/삭제
//           hover 퀵액션 → 상태 00: [접수], 05: [완료]
// ═══════════════════════════════════════════════════════════

const dialog = useDialog()
const bookStore = useBookStore()
const schedulerFilterStore = useSchedulerFilterStore()
const { dataType: selectedDataType } = storeToRefs(schedulerFilterStore)

const isAppointmentMode = computed(() => selectedDataType.value === 'APPOINTMENT')
const dataTypeLabel = computed(() => isAppointmentMode.value ? '예약' : '진료')

// ── Popover ⋮ 메뉴 ──

// 항목 구성은 appointmentCardMenu.ts 가 소유한다(화면 × 상태 분기).
const dotMenuButtons = computed(() =>
  buildCardMenu(selectedDataType.value, props.appointment.status)
)

async function handleDotAction(value) {
  if (!value) return
  const { id, patientName } = props.appointment
  const timeRange = `${formatMinute(props.appointment.startMinute)}~${formatMinute(props.appointment.endMinute)}`

  popover.close()

  if (value === 'EDIT') {
    // ⋮"변경" → reschedule 모드 진입(화면정의서 13-6). reschedule 없으면 기존 ReservationPopup(EDIT).
    if (reschedule) {
      reschedule.begin(id)
    } else {
      emit('edit', id)
    }
    return
  }

  if (value === 'DELETE') {
    const josa = isAppointmentMode.value ? '을' : '를'
    const text = `${patientName}님의 ${dataTypeLabel.value}(${timeRange})${josa} 삭제하시겠습니까?`
    const ok = await dialog.confirm(text, { title: `${dataTypeLabel.value} 삭제` })
    if (!ok) return
    const response = await bookStore.removeAppointment(id)
    emit('callback', response)
    return
  }

  // COMPLETE / NOSHOW / CANCEL / RESTORE → 상태 변경 (RESTORE 는 default_ = 00 복원)
  const response = await bookStore.modifyAppointmentState(id, toApiState(value))
  emit('callback', response)
}

// ── Hover 퀵 액션 버튼 ── 진료화면에서만 표시(예약화면은 ⋮만).

const quickActionLabel = computed(() => {
  if (isAppointmentMode.value) return null
  const status = props.appointment.status
  if (status === '00') return '접수'
  if (status === '05') return '완료'
  return null
})

const quickActionBtnClass = computed(() => {
  const status = props.appointment.status
  if (status === '00') return 'btn-receipt'
  if (status === '05') return 'btn-complete'
  return ''
})

async function handleQuickAction() {
  const { id } = props.appointment
  const status = props.appointment.status

  if (status === '00') {
    // 접수: 상태 05(접수대기) → waiting
    const response = await bookStore.modifyAppointmentState(id, 'waiting')
    emit('callback', response)
  } else if (status === '05') {
    // 완료: 예약이행(complete)
    const response = await bookStore.modifyAppointmentState(id, 'complete')
    emit('callback', response)
  }
}

// ── popover panel element 등록 ──
watch(popoverPanelEl, (el) => {
  popover.setPopoverElement(el)
})

onBeforeUnmount(() => {
  if (popover.openedId.value === props.appointment.id) {
    popover.close()
  }
  if (hover.hoveredId.value === props.appointment.id) {
    hover.clearHover()
  }
})
</script>

<style lang="scss" scoped>
/* ═══════════════════════════════════════════════════════════
 * 상태별 색상 토큰
 * ═══════════════════════════════════════════════════════════ */
$bg-default: var(--scheduler-card-waiting-bg, #E3F2FD);
$bg-done: var(--scheduler-card-done-bg, rgba(46, 125, 50, 0.14));
$bg-undone: var(--scheduler-card-undone-bg, #fff0f0);
$bg-cancel: var(--scheduler-card-cancel-bg, #f5f5f5);

$border-default: var(--scheduler-card-waiting-border, #BBDEFB);
$border-done: var(--scheduler-card-done-border, rgba(46, 125, 50, 0.3));
$border-undone: var(--scheduler-card-undone-border, rgba(229, 57, 53, 0.3));
$border-cancel: var(--scheduler-card-cancel-border, #d0d0d0);

/* ═══════════════════════════════════════════════════════════
 * 카드 컨테이너
 * ═══════════════════════════════════════════════════════════ */
.appointment-card {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  cursor: pointer;
  z-index: 1;
  user-select: none;

  /* popover 열림 시 overflow visible (popover가 카드 밖으로 나가도 보이도록) */
  &.is-popover-open {
    overflow: visible;
  }

  border: 1px solid $border-default;
  border-radius: 2px;
  background: $bg-default;

  transition: box-shadow 120ms ease, filter 120ms ease;

  /* 상태 우선순위 (낮→높): 기본 → hover → active → resizing → dragging → invalid. */

  /* hover: dragging/resizing 아닐 때만. z 안 올림, box-sizing:border-box 라 크기/위치 불변 — 테두리 색만 주황 강조. */
  &:hover:not(.is-dragging):not(.is-resizing),
  &.is-hovered:not(.is-dragging):not(.is-resizing) {
    border-width: 2px;
    border-color: var(--scheduler-card-hover-border, #FF9628);
  }

  /* 검색 드롭다운 pick 하이라이트: 오렌지 outline pulse 후 유지. z 안 올림(테두리만). */
  &.is-search-highlighted {
    outline: 2px solid var(--scheduler-highlight, #FF8C00);
    outline-offset: 1px;
    animation: searchHighlightPulse 0.8s ease-in-out 2;
  }

  /* 예약 변경 모드에서 선택된(이동 대상) 카드 — 주황 테두리(화면정의서 13-6 ②). */
  &.is-reschedule-target {
    outline: 2px solid var(--scheduler-brand, #2F6FED);
    outline-offset: 1px;
    z-index: 60001;
  }

  /* active: dragging이 아닐 때만 */
  &:active:not(.is-dragging):not(.is-resizing) {
    box-shadow: inset 0 0 0 1px rgba(143, 148, 163, 1),
                inset 0 2px 4px rgba(0, 0, 0, 0.28);
    transform: translateY(1px);
  }

  /* dragging: 원본 카드 반투명 */
  &.is-dragging {
    opacity: 0.4;
    cursor: grabbing;
    box-shadow: none;
    filter: none;
  }

  /* resizing: 원본 카드 반투명 (preview가 별도 표시) */
  &.is-resizing {
    opacity: 0.4;
    box-shadow: none;
    filter: none;
  }

  /* invalid: 최우선 (dragging/resizing보다 위) */
  &.is-invalid {
    border-color: #e53935 !important;
    box-shadow: 0 0 0 2px rgba(229, 57, 53, 0.3) !important;
  }

  /* ── 상태별 컨테이너 스타일 ── */
  &.status-done {
    border-color: $border-done;
    background: $bg-done;
  }

  &.status-undone {
    border-color: $border-undone;
    background: $bg-undone;
  }

  &.status-cancel {
    border-color: $border-cancel;
    background: $bg-cancel;
    opacity: 0.85;
  }

  /* 접수대기(05): 오렌지 계열 */
  &.status-receipt {
    border-color: var(--scheduler-card-receipt-border, rgba(245, 124, 0, 0.3));
    background: var(--scheduler-card-receipt-bg, #FFF3E0);
  }

  /* layering(긴 예약 위 얹힌 짧은 예약, level>0 floating) — 약한 그림자로 '위에 떠 있음' 입체감.
     dragging/resizing 은 box-shadow:none 이 위에서 덮어 그림자 제거됨(정상). */
  &.is-layered {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
}

/* ═══════════════════════════════════════════════════════════
 * Card Body
 * ═══════════════════════════════════════════════════════════ */
.card-body {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  padding: 2px 6px;
  box-sizing: border-box;
  overflow: hidden;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  min-height: 0;
}

.card-row--secondary {
  margin-top: 1px;
}

/* displayInfo 단일 블록 — 선택 항목을 ' | ' 로 이어 자연 줄바꿈, -webkit-line-clamp(동적)=N줄까지 표시 후 말줄임.
   카드 height(엔진 고정 50+15×(N-1))와 줄 수가 정합. */
.card-info-block {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  margin-top: 1px;
  font-size: 12px;
  color: #666;
  font-weight: 400;
  line-height: 1.25; /* 12px × 1.25 = 15px/줄 → 카드 px높이(레벨당 +15)와 정합 */
  white-space: normal;
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;

  /* 취소 카드: 정보블록(전화 포함)도 취소선+회색. */
  .status-cancel & {
    text-decoration: line-through;
    color: var(--scheduler-status-cancel, #999);
  }
}

/* 표시정보 말줄임 시 전체내용 툴팁 — body teleport. 줄바꿈 허용(nowrap 아님) + max-width 폭 제한. 위치는 인라인 :style(fixed). */
.appt-info-tooltip {
  position: fixed;
  z-index: 100000;
  background: rgba(33, 33, 33, 0.92);
  color: #fff;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
  white-space: normal;
  word-break: break-word;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  animation: apptInfoTooltipFade 0.12s ease;
}

@keyframes apptInfoTooltipFade {
  from { opacity: 0; }
  to { opacity: 1; }
}


/* ═══════════════════════════════════════════════════════════
 * 고객명
 * ═══════════════════════════════════════════════════════════ */
.card-patient {
  font-size: 14px;
  font-weight: 700;
  color: #000;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  /* grow 안 함(flex:1 폐지) — 남는 폭을 먹지 않아 EXT/당일 뱃지가 이름 바로 옆에 붙음.
     우측 끝은 hover 액션(접수/⋮) 전용 영역으로 분리 → 뱃지·버튼 겹침 해소. */
  flex: 0 1 auto;

  &.is-join {
    color: var(--scheduler-brand, #2F6FED);
  }

  .status-cancel & {
    text-decoration: line-through;
    color: #999;
  }

  .status-undone & {
    color: #c62828;
  }
}

/* 종료시각 (고객명 뒤 '~ HH:mm') — 긴/짧은 예약 겹침 구분. 회색·작게, flex-shrink:0 으로 이름보다 우선 보존. */
.card-end-time {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 400;
  color: #888;
  white-space: nowrap;

  /* 취소 카드: 고객명과 동일하게 취소선+회색. */
  .status-cancel & {
    text-decoration: line-through;
    color: #aaa;
  }
}

/* ═══════════════════════════════════════════════════════════
 * EXT 뱃지 (외부 시스템 연동 예약)
 * ═══════════════════════════════════════════════════════════ */
.card-external-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 15px;
  padding: 0 4px;
  border-radius: 2px;
  background-color: var(--scheduler-external, #5B6CB8);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

/* '당일' 뱃지 — 예약 등록일이 오늘인 예약 (고객명 line 우측) */
.card-today-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 15px;
  padding: 0 4px;
  border-radius: 2px;
  background-color: var(--scheduler-brand, #2F6FED);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

/* 메모 (고객명 옆) */
.card-memo {
  font-size: 12px;
  color: #666;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 전화번호 + 메모 (legacy 레이아웃) */
.card-phone {
  font-size: 12px;
  color: #999;
  font-weight: 400;
  flex-shrink: 0;

  /* 취소 카드: 전화번호도 취소선. */
  .status-cancel & {
    text-decoration: line-through;
  }
}

.card-divider {
  color: #ccc;
  font-size: 11px;
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════
 * Resize Handle
 * ═══════════════════════════════════════════════════════════ */
/* Resize handle: hover 시 #111 계열로 표시 */
.resize-handle {
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  cursor: ns-resize;
  z-index: 3;
  background: transparent;

  &--top { top: 0; }
  &--bottom { bottom: 0; }

  &:hover {
    background: rgba(17, 17, 17, 0.4);
  }
}

/* hover 테두리 오버레이 — 포털(.v3-qa-portal)에 teleport, 투명 박스+2px 주황 테두리만.
   카드 자체 border 가 z 높은 인접 카드에 잘리는 문제 회피(전 카드 위). 마우스 비차단. */
.appointment-hover-border {
  box-sizing: border-box;
  border: 2px solid var(--scheduler-card-hover-border, #FF9628);
  border-radius: 2px;
  pointer-events: none;
}

/* ═══════════════════════════════════════════════════════════
 * Quick Action 버튼 (⋮)
 * ═══════════════════════════════════════════════════════════ */
/* ⋮ 버튼 + popover wrapper */
/* ⋮ wrapper — .v3-qa-portal 로 teleport, 위치/크기는 인라인 quickActionStyle(보드좌표 absolute).
   포털이 pointer-events:none 이므로 wrapper 는 auto 로 복구해 클릭 가능. */
.quick-action-wrapper {
  pointer-events: auto;
}

/* ⋮ 버튼: wrapper 내부 전체 크기 */
.quick-action-btn {
  width: 100%;
  height: 100%;
  border: none;
  border-left: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;

  &:hover {
    background: rgba(255, 255, 255, 0.85);
    border-left-color: rgba(0, 0, 0, 0.12);
  }
}

.quick-action-icon {
  font-size: 16px;
  font-weight: 700;
  color: #333;
  line-height: 1;
}

/* 진료 퀵 액션 상태 버튼 ([접수] / [완료]) — 고객명 라인 맨 오른쪽(⋮ 버튼 왼쪽). */
.quick-action-state-btn {
  position: absolute;
  top: 2px;
  right: 28px;
  height: 18px;
  border: none;
  border-radius: 2px;
  background: var(--scheduler-grabber, #8F94A3);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 8px;
  white-space: nowrap;
  z-index: 4;

  /* 접수 버튼: 파란색 */
  &.btn-receipt {
    background: #256AF5;
    &:hover { background: #1a5ad4; }
  }

  /* 완료 버튼: 기본 뱃지 색상 */
  &.btn-complete {
    background: #2e7d32;
    &:hover { background: #256b29; }
  }

  &:hover {
    filter: brightness(0.95);
  }
}

/* ═══════════════════════════════════════════════════════════
 * Dot Menu Popover
 * ═══════════════════════════════════════════════════════════ */
/* popover: 카드 안쪽 우상단 (⋮ 버튼 옆) */
.appointment-popover {
  position: absolute;
  top: 0;
  right: 24px;
  z-index: 60000;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 0;
  box-shadow: 0 4px 16px 2px rgba(0, 0, 0, 0.24);
  padding: 4px;
  min-width: 90px;
}

.popover-menu {
  display: flex;
  flex-direction: column;
}

/* 메뉴 아이템 — #999, hover #000, separator, 마지막(삭제) 빨간색 */
.popover-menu__item {
  width: 100%;
  border: none;
  background: transparent;
  padding: 6px 10px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  color: #999;

  & + & {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
  }

  &:hover:not(:disabled) {
    color: #000;
  }

  /* 마지막 아이템 (삭제) 빨간색 */
  &:last-child {
    color: #e53935;
    &:hover:not(:disabled) { color: #c62828; }
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

/* 검색 하이라이트 pulse — outline 점멸 2회 후 유지 */
@keyframes searchHighlightPulse {
  0%, 100% { outline-color: var(--scheduler-highlight, #FF8C00); }
  50% { outline-color: rgba(255, 140, 0, 0.25); }
}
</style>

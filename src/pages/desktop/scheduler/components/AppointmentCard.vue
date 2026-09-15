<template>
  <!--
    card-wrapper:
    - mouseenter/mouseleave → hover 제어
    - mousedown → drag 시작 (resize handle에서 stopPropagation되므로 여기까지 오면 drag)
    - :class로 hover/drag/resize 상태에 따른 스타일 분기
  -->
  <div
    ref="cardEl"
    :data-appointment-id="appointment.id"
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
        'is-layer-base': rect.isLayerBase,
        'is-long-card': rect.isLongCard,
      },
    ]"
    :style="cardStyle"
    :title="isAppointmentMode ? '우클릭하여 예약 추가' : '우클릭하여 운영 추가'"
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
        <!-- 종료시각(~ HH:mm) — 고객명 뒤. 긴/짧은 예약 겹침 구분용(예약·방문 공통). 이름보다 우선 보존. -->
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
    <!-- 방문 화면 퀵 액션: [대기] 또는 [완료] -->
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
        <!-- 화면에 보이는 것이 문자 ⋮ 뿐이라 보조기기에는 이름 없는 버튼으로 읽힌다 →
             aria-label 로 무엇을 여는 버튼인지, aria-expanded 로 지금 열려 있는지를 밝힌다.
             아이콘 자체는 aria-hidden — 라벨과 겹쳐 "⋮ 예약 메뉴 열기" 로 두 번 읽히지 않게 한다. -->
        <button
          ref="quickActionBtnEl"
          :aria-expanded="isPopoverOpen"
          :aria-label="`${dataTypeLabel} 메뉴 열기`"
          aria-haspopup="menu"
          class="quick-action-btn"
          @mouseenter="hover.onQuickActionEnter()"
          @mouseleave="hover.onQuickActionLeave()"
          @mousedown.stop
          @click.stop="onQuickActionClick"
        >
          <span
            aria-hidden="true"
            class="quick-action-icon"
          >⋮</span>
        </button>
      </div>
    </Teleport>

    <!-- 리사이즈 핸들 포털 사본 — 밑바탕(isLayerBase) 카드 전용. 꼬리 위에 float 카드가 얹히면(z 10 > base 0)
         카드 안의 하단 핸들이 float 밑에 깔려 좌측 들여쓰기 폭만 남는다 → hover 중 같은 자리에 포털(전 카드 위)
         사본을 띄워 전폭에서 잡히게 한다. mousedown 은 카드 안 핸들과 같은 함수(startResize 는 핸들 DOM 무관).
         밑바탕이 아닌 카드는 자기 핸들이 안 가려지므로 제외 — 전 카드에 켜면 e2e 의 핸들 좌표 클릭을 포털이 가로챈다. -->
    <Teleport to=".v3-qa-portal">
      <template v-if="showPortalResizeHandles">
        <div
          class="resize-handle-portal resize-handle-portal--top"
          :style="portalHandleStyle('top')"
          @mouseenter="hover.onQuickActionEnter()"
          @mouseleave="hover.onQuickActionLeave()"
          @mousedown="onResizeTop"
        />
        <div
          class="resize-handle-portal resize-handle-portal--bottom"
          :style="portalHandleStyle('bottom')"
          @mouseenter="hover.onQuickActionEnter()"
          @mouseleave="hover.onQuickActionLeave()"
          @mousedown="onResizeBottom"
        />
      </template>
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
        ref="infoTooltipEl"
        class="appt-info-tooltip"
        :style="infoTooltipStyle"
      >{{ infoText }}</div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, inject, nextTick, onBeforeUnmount } from 'vue'
import dayjs from 'dayjs'
import { storeToRefs } from 'pinia'
import { useDialog } from '@/lib/useDialog'
import { useBookStore } from '@/stores/bookStore'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import { buildCardMenu, toApiState } from '../appointmentCardMenu'
import { toDisplayStatus, toStatusClassName } from '@/utils/schedulerSearchFilterUtils'
import { clampFlyoutPos } from '@/utils/popoverPlacementUtils'

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
      // 둘 다 nullable(각각 단독/둘다/없음 허용) → 존재하는 것만 쉼표로 이어 붙인다.
      // 공백으로 이으면 '점검 > 정기 점검 기본진단' 처럼 선택값과 직접입력이 한 덩어리로 읽힌다.
      v = [a.treatmentCategory ?? '', a.memo ?? ''].filter(Boolean).join(', ')
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
const infoTooltipEl = ref(null)
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
  // 여러 줄로 늘어난 툴팁은 임계값(r.top < 120)만으로는 위쪽이 잘리는지 알 수 없다 — 실측해서 넘치면 아래로 돌린다.
  settleInfoTooltip(r, TOOLTIP_MAX_W)
  // fixed 좌표라 스크롤·리사이즈에 따라오지 못한다. 카드는 움직이는데 툴팁만 남아 무관한 예약을 덮으므로 닫는다.
  window.addEventListener('scroll', onInfoLeave, { passive: true, capture: true })
  window.addEventListener('resize', onInfoLeave)
}
async function settleInfoTooltip(anchorRect, maxWidth) {
  await nextTick()
  const tip = infoTooltipEl.value
  if (!tip || !infoTooltipOpen.value) return
  const box = tip.getBoundingClientRect()
  if (!box.height) return // 크기를 못 재면(테스트 stub 등) 임시 배치를 그대로 둔다
  if (box.top >= 8) return // 위쪽이 잘리지 않았다 — 그대로
  // bottom 기준을 top 기준으로 갈아끼운다(두 값이 함께 남으면 높이가 늘어난다)
  infoTooltipStyle.value = {
    position: 'fixed',
    top: `${Math.round(anchorRect.bottom + 6)}px`,
    left: infoTooltipStyle.value.left,
    maxWidth: `${maxWidth}px`,
  }
}
function onInfoLeave() {
  infoTooltipOpen.value = false
  window.removeEventListener('scroll', onInfoLeave, true)
  window.removeEventListener('resize', onInfoLeave)
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

// '당일' 뱃지 — 방문 화면에서만, **방문장부에서 등록한 건**(isTreatmentRegistered) 중 예약 등록일(createdAt)이
// 오늘이면 표시(고객명 line 우측). 예약장부에서 등록한 건은 방문 화면에 보여도 뱃지를 붙이지 않는다.
const isRegisteredToday = computed(() => {
  if (isAppointmentMode.value) return false // 방문 화면 전용
  if (!props.appointment.isTreatmentRegistered) return false // 예약장부 등록건 제외
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
    // 밑바탕 좌측 마커 농도 — 층수(layerDepth)만큼 연해지는 계단. 들여쓰기 계단과 같은 방향으로
    // '누가 맨 아래인가'를 읽히게 한다. 하한 0.3: 연한 상태색(취소 회색 등)이 배경에 묻히지 않는 최소값.
    '--layer-marker-opacity': String(Math.max(0.3, 1 - (props.rect.layerDepth ?? 0) * 0.3)),
  }
})

// ⋮ popover 위치 — Teleport(body) 후 fixed 좌표. trigger(⋮ 버튼) 기준 좌상단, 왼쪽으로 펼침.
// 트리거 좌표 그대로 펼치면 화면 하단 카드에서 메뉴 아래쪽(초기화·삭제)이 잘린다 → 렌더 후 실측해 접는다.
// 측정 전 임시 배치는 종전과 같은 우측 정렬(right)이고, 접고 나면 실좌표(left)로 바뀐다.
const popoverSettled = ref(null)
const popoverStyle = computed(() => {
  const rect = popover.popoverState.value?.anchorRect
  if (!rect) return {}
  if (popoverSettled.value) {
    return {
      position: 'fixed',
      top: `${popoverSettled.value.top}px`,
      left: `${popoverSettled.value.left}px`,
      // CSS 의 right:24px 를 끄지 않으면 left 와 함께 걸려 팝오버가 가로로 늘어난다.
      right: 'auto',
      zIndex: 60000,
    }
  }
  return {
    position: 'fixed',
    top: `${rect.top}px`,
    right: `${window.innerWidth - rect.left}px`,
    zIndex: 60000,
  }
})

// 열릴 때마다 실측 → 뷰포트 안으로. 크기를 못 재면(테스트 stub 등) 임시 배치를 그대로 둔다.
watch(isPopoverOpen, async (open) => {
  popoverSettled.value = null
  if (!open) return
  await nextTick()
  const el = popoverPanelEl.value
  const rect = popover.popoverState.value?.anchorRect
  if (!el || !rect) return
  const box = el.getBoundingClientRect()
  if (!box.width || !box.height) return
  popoverSettled.value = clampFlyoutPos(rect, box.width, box.height)
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

// 리사이즈 핸들 포털 사본 — 밑바탕(isLayerBase) 카드가 hover 중이고 드래그/리사이즈 대상이 아닐 때만.
// 밑바탕 카드의 꼬리(endBand row 0) 위에 float(z 10)이 얹히면 카드 안 하단 핸들(3px)이 들여쓰기 폭(10px)만 남고
// 가려진다. 카드 z 를 올리는 대신(hover z-lift 금지 정책) ⋮ 버튼과 같은 포털에 핸들 사본을 띄운다.
const PORTAL_HANDLE_PX = 3
const showPortalResizeHandles = computed(() =>
  isHovered.value && !!props.rect.isLayerBase && !isDragTarget.value && !isResizeTarget.value,
)
function portalHandleStyle(edge) {
  const r = props.rect
  return {
    position: 'absolute',
    top: `${edge === 'top' ? r.top : r.top + r.height - PORTAL_HANDLE_PX}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${PORTAL_HANDLE_PX}px`,
  }
}

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

// 예약 화면은 예약(00)·취소(03)만 상태 색으로 구분한다 — 완료·미이행·대기 건은 예약(00)처럼 그린다.
// 실제 status 는 그대로 두고(⋮ 메뉴·퀵액션 판정용) 표시 클래스만 바꾼다. 규칙 SSOT = toDisplayStatus.
const statusContainerClass = computed(() => {
  const displayStatus = toDisplayStatus(props.appointment.status, selectedDataType.value)
  const v1Class = displayStatus === props.appointment.status
    ? props.appointment.statusClass
    : toStatusClassName(displayStatus)
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
  // 어느 카드가 나갔는지 함께 넘긴다 — 겹친 카드에서 이탈이 다음 카드 진입보다 늦게 와도 hover 가 꺼지지 않게.
  hover.onCardLeave(props.appointment.id)
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
// 방문 화면: ⋮ → 대기/완료/미이행/취소/초기화/삭제
//           hover 퀵액션 → 상태 00: [대기], 05: [완료]
// ═══════════════════════════════════════════════════════════

const dialog = useDialog()
const bookStore = useBookStore()
const schedulerFilterStore = useSchedulerFilterStore()
const { dataType: selectedDataType } = storeToRefs(schedulerFilterStore)

const isAppointmentMode = computed(() => selectedDataType.value === 'APPOINTMENT')
const dataTypeLabel = computed(() => isAppointmentMode.value ? '예약' : '방문')

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

// ── Hover 퀵 액션 버튼 ── 방문 화면에서만 표시(예약화면은 ⋮만).

const quickActionLabel = computed(() => {
  if (isAppointmentMode.value) return null
  const status = props.appointment.status
  if (status === '00') return '대기'
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
    // 대기: 상태 05 → waiting
    const response = await bookStore.modifyAppointmentState(id, 'waiting')
    emit('callback', response)
  } else if (status === '05') {
    // 완료: 예약이행(complete)
    const response = await bookStore.modifyAppointmentState(id, 'complete')
    emit('callback', response)
  }
}

// ── popover panel element 등록 ──
// 자기 id 를 함께 넘긴다 — 슬롯이 전역 하나라, 다른 카드로 옮겨 열릴 때 이 카드의 해제(null)가
// 뒤늦게 도착해 새 카드의 패널을 덮지 않도록 composable 이 주인을 가린다.
watch(popoverPanelEl, (el) => {
  popover.setPopoverElement(el, props.appointment.id)
})

onBeforeUnmount(() => {
  if (popover.openedId.value === props.appointment.id) {
    popover.close()
  }
  if (hover.hoveredId.value === props.appointment.id) {
    hover.clearHover()
  }
  onInfoLeave() // 툴팁이 열린 채 카드가 사라지면 window 리스너가 남는다
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

/* 레이어링 밑바탕 카드 좌측 마커 — 상태별(색 SSOT = scss/schedule/v3/_tokens.scss). */
$marker-done: var(--scheduler-layer-marker-done, #4D9151);
$marker-undone: var(--scheduler-layer-marker-undone, #E95753);
$marker-cancel: var(--scheduler-layer-marker-cancel, #A8A8A8);
$marker-receipt: var(--scheduler-layer-marker-receipt, #90BE5E);

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

  /* ── 상태별 컨테이너 스타일 ──
     --card-layer-marker: is-long-card 좌측 마커 색(상태별). ::before 가 상속받는다.
     상태 클래스가 없는 00 예약완료는 ::before 의 fallback(파랑)이 그대로 쓰인다. */
  &.status-done {
    border-color: $border-done;
    background: $bg-done;
    --card-layer-marker: #{$marker-done};
  }

  &.status-undone {
    border-color: $border-undone;
    background: $bg-undone;
    --card-layer-marker: #{$marker-undone};
  }

  &.status-cancel {
    border-color: $border-cancel;
    background: $bg-cancel;
    opacity: 0.85;
    --card-layer-marker: #{$marker-cancel};
  }

  /* 대기(05) */
  &.status-receipt {
    border-color: var(--scheduler-card-receipt-border, rgba(245, 124, 0, 0.3));
    background: var(--scheduler-card-receipt-bg, #FFF3E0);
    --card-layer-marker: #{$marker-receipt};
  }

  /* layering(긴 예약 위 얹힌 짧은 예약, level>0 floating) — 약한 그림자로 '위에 떠 있음' 입체감.
     ⭐그림자는 오른쪽·아래로만(offset-x 1px, spread −1px). x-offset 0 이면 왼쪽으로도 퍼져
     좌측 마커 바깥에 어두운 띠가 깔리고, 같은 4px 마커가 index0 보다 굵어 보인다.
     dragging/resizing 은 box-shadow:none 이 위에서 덮어 그림자 제거됨(정상). */
  &.is-layered {
    box-shadow: 1px 1px 3px -1px rgba(0, 0, 0, 0.22);
  }

  /* 가려진 긴 예약 — 좌측 세로 바. 화면정의서 「1. 긴 예약 건 표기」의 파란 세로선이다.
     조건은 둘을 **함께** 만족할 때다:
       ① 긴 예약인가 — isLongCard = '다른 예약의 행을 지나쳐 내려갔나'.
          ⭐밴드를 넘는가로 판정하지 말 것: band 가 cellDuration 단위라 10분 그리드에서 전 카드에 붙는다.
       ② 그 위에 얹힌 카드가 있어 가려졌나 — isLayerBase.
     ②가 빠지면 아무에게도 가려지지 않은 긴 예약까지 바가 붙어, 바가 '아래에 가려진 것이 있다'는
     신호가 아니라 '길다'는 사실만 말하게 된다(mock 9/17 실측: 바 65장 중 26장이 그런 경우였다).
     (isLayerBase 는 리사이즈 핸들 포털 조건으로도 계속 쓰인다 — 그쪽은 이 바와 별개다.)
     border-left 가 아니라 ::before 인 이유: hover(border-width:2px)·is-invalid(!important)·
     status-* 가 모두 border-color/width 를 덮어써서 마커가 지워지기 때문.
     색은 상태별 --card-layer-marker(위 status-* 에서 지정), 미지정(00 예약완료)이면 파랑 base. */
  &.is-long-card.is-layer-base::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--card-layer-marker, var(--scheduler-layer-base-marker, #1D95E7));
    /* 층수별 농도 계단(index0=1.0 → 깊을수록 연함, 하한 0.3) — 값은 cardStyle 이 layerDepth 로 산출.
       고정 0.58(is-layer-nested 일괄)이던 것을 깊이 비례로 대체 — 중간층 2개(index1·index2)가
       같은 농도로 나와 동일 마커가 중복돼 보이던 문제. */
    opacity: var(--layer-marker-opacity, 1);
    pointer-events: none;
    z-index: 2; /* card-body 위, resize-handle(3) 아래 */
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
/* z 는 ⋮ popover(60000) 바로 아래 — 읽기용 툴팁이 조작하는 메뉴를 덮으면 안 된다. */
.appt-info-tooltip {
  position: fixed;
  z-index: 59999;
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
     우측 끝은 hover 액션(대기/⋮) 전용 영역으로 분리 → 뱃지·버튼 겹침 해소. */
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

/* 리사이즈 핸들 포털 사본 — 위치/크기는 인라인 portalHandleStyle(보드좌표 absolute). 포털이 pointer-events:none
   이므로 auto 로 복구. 모양은 카드 안 .resize-handle 과 동일(투명, hover 시 어두운 띠). 클래스명을 .resize-handle
   과 다르게 둔 이유: e2e 가 `.resize-handle--bottom` 을 카드 안에서 찾는데 같은 클래스가 포털에도 있으면 중복 매치. */
.resize-handle-portal {
  pointer-events: auto;
  cursor: ns-resize;
  background: transparent;

  &:hover {
    background: rgba(17, 17, 17, 0.4);
  }
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

/* 방문 퀵 액션 상태 버튼 ([대기] / [완료]) — 고객명 라인 맨 오른쪽(⋮ 버튼 왼쪽). */
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

  /* 대기 버튼: 파란색 */
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

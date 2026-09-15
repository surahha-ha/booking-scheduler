/**
 * 스케줄러 Resize Composable
 *
 * 책임:
 *   - 예약 카드 resize(시간 늘리기/줄이기) 상태 머신 관리
 *   - top handle → startMinute 변경, bottom handle → endMinute 변경
 *   - hitTest(Y축만) + snap 기반 minute 계산
 *   - minDuration / maxDuration 제약 적용
 *   - resize 확정 시 콜백 발행
 *   - interactionLock 획득/해제
 *
 * 하지 않는 것:
 *   - DOM 이벤트 직접 바인딩 (handle 컴포넌트가 startResize 호출)
 *   - store 직접 수정 (onResize 콜백으로 위임)
 *   - column(날짜/리소스) 변경 (resize는 시간 축만)
 *
 * 핵심 정책:
 *   - top handle: endMinute 고정(anchor), startMinute만 변경
 *   - bottom handle: startMinute 고정(anchor), endMinute만 변경
 *   - 움직이는 끝은 등록/수정과 같은 예약 단위(STEP_MIN=30분) 그리드에만 놓인다.
 *     Shift 세밀 snap 은 resize 에 적용하지 않는다 — 등록/수정으로는 만들 수 없는 시각이 생긴다.
 *   - duration은 minDuration(=예약 단위) 이상, maxDuration 이하.
 *     최소 미만으로 끌면 그리드에 맞춘 최소 크기로 붙잡고 invalid(빨간 점선) 표시 → 확정하지 않는다.
 *   - preview는 항상 같은 column 내에서만 표시
 */

import { ref, readonly, type Ref, type DeepReadonly } from 'vue'
import { hitTest, minuteToBandTopPx, minuteRangeToBandHeight, isValidMinute } from '@/scheduler-engine/schedulerHitTest'
import {
  snapMinute, DEFAULT_SNAP_CONFIG, clampEndToDay, floorToStep, ceilToStep, DAY_MINUTES, LAST_MINUTE_OF_DAY,
} from '@/scheduler-engine/schedulerSnapGrid'
import { STEP_MIN } from '@/constants/componentConstants'
import type {
  FlatColumn,
  BandCompatible,
  ResizeState,
  ResizeDirection,
  AppointmentRect,
  SnapConfig,
} from '@/scheduler-engine/types/scheduler.types'
import type { UseSchedulerInteractionLockReturn, LockHandle } from './useSchedulerInteractionLock'

/** auto scroll 핸들 — 구 useSchedulerAutoScroll(MR-Swap 으로 제거)의 옵셔널 인터페이스만 로컬 보존.
 *  V3 는 autoScroll 을 넘기지 않아 `autoScroll?.` 호출이 no-op 이다. */
interface AutoScrollHandle {
  update(_clientX: number, _clientY: number): void
  setOnTick(_cb: ((_clientX: number, _clientY: number) => void) | null): void
  stop(): void
}

// ═══════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════

/** resize 시작에 필요한 예약 정보 */
export interface ResizeStartInfo {
  appointmentId: string
  columnKey: string
  startMinute: number
  endMinute: number
  direction: ResizeDirection
  /** 기존 배치 rect (preview 초기값) */
  rect: AppointmentRect
}

/** resize 확정 시 전달되는 결과 */
export interface ResizeResult {
  appointmentId: string
  columnKey: string
  newStartMinute: number
  newEndMinute: number
}

/** 유효성 검증 함수 타입 */
export type ResizeValidateFn = (
  _appointmentId: string,
  _columnKey: string,
  _startMinute: number,
  _endMinute: number,
) => { isValid: boolean; reason?: string }

// ═══════════════════════════════════════════════════════════
// 시간 범위 계산 (순수 함수 — DOM/Vue 무관, 단위 테스트 대상)
// ═══════════════════════════════════════════════════════════

/** 최소 시간 미만으로 끌었을 때 preview 에 붙는 사유 */
export const RESIZE_UNDER_MIN_REASON = `예약 시간은 ${STEP_MIN}분 미만으로 줄일 수 없습니다.`

export interface ResizeRangeLimits {
  /** 예약 단위(분) — 움직이는 끝이 놓일 그리드 */
  step: number
  minDuration: number
  maxDuration: number
}

export interface ResizeRange {
  startMinute: number
  endMinute: number
  /** 사용자가 최소 시간보다 짧게 끌었다 → 붙잡아 두되 invalid 로 표시 */
  isUnderMin: boolean
}

/**
 * anchor(고정 끝) + snap 된 마우스 minute → 확정할 시간 범위.
 *
 * 움직이는 끝은 항상 step 그리드 위에 놓는다. 최소/최대 제약으로 붙잡을 때도
 * `anchor ± minDuration` 을 그대로 쓰지 않고 그리드에 맞춘다 —
 * 그렇지 않으면 anchor 가 그리드 밖인 예약(외부 유입분)에서 등록/수정으로는
 * 고를 수 없는 시각이 만들어진다.
 */
export function resolveResizeRange(
  anchorMinute: number,
  snappedMinute: number,
  direction: ResizeDirection,
  limits: ResizeRangeLimits,
): ResizeRange {
  const { step, minDuration, maxDuration } = limits

  if (direction === 'top') {
    // end 고정 → start 만 이동. 위로 갈수록 길어진다.
    // 종료 23:59 는 자정(24:00)의 표기다 — 글자 그대로 세면 23:30~23:59 예약이 최소 시간 미달이 되어
    // 핸들을 놓기만 해도 시작이 한 칸 당겨진다.
    const endAsMinute = anchorMinute >= LAST_MINUTE_OF_DAY ? DAY_MINUTES : anchorMinute
    const latestStart = floorToStep(endAsMinute - minDuration, step)   // 최소 시간을 지키는 가장 늦은 start
    const earliestStart = ceilToStep(endAsMinute - maxDuration, step)  // 최대 시간을 지키는 가장 이른 start
    const isUnderMin = snappedMinute > latestStart
    const startMinute = Math.max(earliestStart, Math.min(snappedMinute, latestStart))
    return { startMinute, endMinute: anchorMinute, isUnderMin }
  }

  // bottom: start 고정 → end 만 이동. 아래로 갈수록 길어진다.
  const earliestEnd = ceilToStep(anchorMinute + minDuration, step)
  const latestEnd = floorToStep(anchorMinute + maxDuration, step)
  const isUnderMin = snappedMinute < earliestEnd
  // 자정(1440)에 닿으면 드롭과 같은 하루 끝 규칙으로 23:59 또는 마지막 칸으로 닫는다.
  const endMinute = clampEndToDay(anchorMinute, Math.min(latestEnd, Math.max(snappedMinute, earliestEnd)), step)
  return { startMinute: anchorMinute, endMinute, isUnderMin }
}

// ═══════════════════════════════════════════════════════════
// 입력 옵션
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerResizeOptions {
  /** body 스크롤 컨테이너 (좌표 변환용) */
  bodyEl: Ref<HTMLElement | null>
  /** 현재 column 배열 (preview rect의 left/width 참조) */
  columns: Ref<FlatColumn[]>
  /** 현재 bandInfos (hitTest + preview 계산) */
  bandInfos: Ref<BandCompatible[]>
  /** interactionLock composable */
  interactionLock: UseSchedulerInteractionLockReturn
  /** auto scroll 핸들 (미제공 시 auto scroll 비활성 — V3 는 미제공) */
  autoScroll?: AutoScrollHandle
  /** snap 설정 (미제공 시 기본값) */
  snapConfig?: SnapConfig
  /** 최소 예약 시간 (분, 기본 = 등록/수정 예약 단위 STEP_MIN) */
  minDuration?: number
  /** 최대 예약 시간 (분, 기본 480 = 8시간) */
  maxDuration?: number
  /** 유효성 검증 (미제공 시 항상 valid) */
  validate?: ResizeValidateFn
  /** resize 확정 콜백 */
  onResize: (_result: ResizeResult) => void
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerResizeReturn {
  /** 현재 resize 상태 (null이면 idle) */
  resizeState: DeepReadonly<Ref<ResizeState | null>>
  /** resize 진행 중 여부 */
  isResizing: Readonly<Ref<boolean>>
  /**
   * resize 시작. handle 컴포넌트의 mousedown에서 호출.
   * lock 획득 실패 시 false 반환.
   */
  startResize: (_e: MouseEvent, _info: ResizeStartInfo) => boolean
  /** resize 강제 취소 (ESC 등) */
  cancelResize: () => void
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerResize(
  options: UseSchedulerResizeOptions
): UseSchedulerResizeReturn {

  const {
    bodyEl,
    bandInfos,
    interactionLock,
    autoScroll,
    snapConfig = DEFAULT_SNAP_CONFIG,
    minDuration = STEP_MIN,
    maxDuration = 480,
    validate,
    onResize,
  } = options

  // ── 상태 ──
  const _resizeState = ref<ResizeState | null>(null)
  const _isResizing = ref(false)

  // ── 내부 변수 ──
  let _lockHandle: LockHandle | null = null
  let _anchorMinute = 0     // 고정 끝 minute
  let _columnKey = ''        // resize 대상 column (불변)

  // 움직이는 끝이 놓일 그리드 = 예약 단위. Shift 세밀 snap 은 쓰지 않는다(등록/수정과 단위 통일).
  const gridStep = snapConfig.intervalMinutes > 0 ? snapConfig.intervalMinutes : STEP_MIN

  // ═══════════════════════════════════════════════════════════
  // 좌표 변환
  // ═══════════════════════════════════════════════════════════

  function clientToBodyLocalY(clientY: number): number | null {
    const body = bodyEl.value
    if (!body) return null
    const rect = body.getBoundingClientRect()
    return clientY - rect.top + body.scrollTop
  }

  // ═══════════════════════════════════════════════════════════
  // Resize Start
  // ═══════════════════════════════════════════════════════════

  function startResize(e: MouseEvent, info: ResizeStartInfo): boolean {
    const handle = interactionLock.acquire('resize', {
      appointmentId: info.appointmentId,
      meta: { direction: info.direction },
    })
    if (!handle) return false

    _lockHandle = handle
    _columnKey = info.columnKey
    document.body.classList.add('is-resizing-active')

    // anchor: 고정 끝
    _anchorMinute = info.direction === 'top'
      ? info.endMinute    // top handle → end 고정
      : info.startMinute  // bottom handle → start 고정

    _resizeState.value = {
      appointmentId: info.appointmentId,
      direction: info.direction,
      columnKey: info.columnKey,
      originStartMinute: info.startMinute,
      originEndMinute: info.endMinute,
      currentStartMinute: info.startMinute,
      currentEndMinute: info.endMinute,
      previewRect: { ...info.rect },
      isValid: true,
      invalidReason: undefined,
      minDuration,
      maxDuration,
      isNoChange: true, // 시작 직후엔 origin과 동일
    }

    _isResizing.value = true

    // auto scroll tick 콜백 등록 (scroll 중 preview 재계산, Y만 사용)
    autoScroll?.setOnTick((_lastClientX, lastClientY) => {
      updatePreviewFromClientY(lastClientY)
    })

    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeEnd)
    document.addEventListener('keydown', onKeyDown)

    // mousedown이 drag로 전파되지 않도록
    e.stopPropagation()
    e.preventDefault()

    return true
  }

  // ═══════════════════════════════════════════════════════════
  // Preview 재계산 (mousemove + auto scroll tick 공용)
  // ═══════════════════════════════════════════════════════════

  /**
   * clientY 기준으로 hitTest(Y) → snap → validate → preview 업데이트.
   * onResizeMove와 autoScroll onTick 양쪽에서 호출된다.
   */
  function updatePreviewFromClientY(clientY: number): void {
    if (!_resizeState.value) return

    const bodyY = clientToBodyLocalY(clientY)
    if (bodyY === null) return

    // resize는 Y축만 사용 — hitTest에 columns 빈 배열, subColIndex 불변
    const hit = hitTest({
      mouseX: 0,
      mouseY: bodyY,
      columns: [],
      bandInfos: bandInfos.value,
    })

    if (!isValidMinute(hit.minute)) return

    const snappedMinute = snapMinute(hit.minute, snapConfig)

    const { startMinute: newStart, endMinute: newEnd, isUnderMin } = resolveResizeRange(
      _anchorMinute,
      snappedMinute,
      _resizeState.value.direction,
      { step: gridStep, minDuration, maxDuration },
    )

    let isValid = true
    let invalidReason: string | undefined

    if (validate) {
      const result = validate(
        _resizeState.value.appointmentId,
        _columnKey,
        newStart,
        newEnd,
      )
      isValid = result.isValid
      invalidReason = result.reason
    }

    // 최소 시간 미만은 저장 불가 — 검증 결과보다 우선한다(빨간 점선 + 확정 차단).
    if (isUnderMin) {
      isValid = false
      invalidReason = RESIZE_UNDER_MIN_REASON
    }

    const topPx = minuteToBandTopPx(newStart, bandInfos.value)
    const heightPx = minuteRangeToBandHeight(newStart, newEnd, bandInfos.value)

    // subColIndex / rowIndex / zIndex / left / width는 spread로 기존 값 유지
    // resize는 column/sub-column 변경 없이 시간만 변경
    const previewRect: AppointmentRect = {
      ..._resizeState.value.previewRect,
      top: topPx,
      height: heightPx,
      // left/width는 기존 카드 값 유지 (sub-column 폭)
    }

    // origin과 동일 시간 = 데이터 변경 없음 → preview 회색 표기 (drag와 동일 정책)
    // 단 최소 시간 미만으로 끌어 붙잡힌 것이면 회색이 아니라 빨강이어야 한다
    // (이미 최소 크기인 카드를 더 줄이면 붙잡힌 값이 origin 과 같아진다).
    const isNoChange =
      !isUnderMin &&
      newStart === _resizeState.value.originStartMinute &&
      newEnd === _resizeState.value.originEndMinute

    _resizeState.value = {
      ..._resizeState.value,
      currentStartMinute: newStart,
      currentEndMinute: newEnd,
      previewRect,
      isValid,
      invalidReason,
      isNoChange,
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Resize Move
  // ═══════════════════════════════════════════════════════════

  function onResizeMove(e: MouseEvent): void {
    if (!_resizeState.value) return

    updatePreviewFromClientY(e.clientY)

    // auto scroll: edge zone 감지 (세로만)
    autoScroll?.update(e.clientX, e.clientY)
  }

  // ═══════════════════════════════════════════════════════════
  // Resize End
  // ═══════════════════════════════════════════════════════════

  function onResizeEnd(_e: MouseEvent): void {
    const state = _resizeState.value
    if (!state) {
      cleanup()
      return
    }

    if (state.isValid && hasTimeChanged(state)) {
      onResize({
        appointmentId: state.appointmentId,
        columnKey: state.columnKey,
        newStartMinute: state.currentStartMinute,
        newEndMinute: state.currentEndMinute,
      })
    }

    cleanup()
  }

  // ═══════════════════════════════════════════════════════════
  // Cancel / Cleanup
  // ═══════════════════════════════════════════════════════════

  function cancelResize(): void {
    cleanup()
  }

  function cleanup(): void {
    document.body.classList.remove('is-resizing-active')
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    document.removeEventListener('keydown', onKeyDown)

    _resizeState.value = null
    _isResizing.value = false
    _anchorMinute = 0
    _columnKey = ''

    // auto scroll 중단 + 콜백 해제
    autoScroll?.stop()
    autoScroll?.setOnTick(null)

    _lockHandle?.unlock()
    _lockHandle = null
  }

  // ═══════════════════════════════════════════════════════════
  // 키보드 처리
  // ═══════════════════════════════════════════════════════════

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') cancelResize()
  }

  // ═══════════════════════════════════════════════════════════
  // 유틸
  // ═══════════════════════════════════════════════════════════

  function hasTimeChanged(state: ResizeState): boolean {
    return (
      state.currentStartMinute !== state.originStartMinute ||
      state.currentEndMinute !== state.originEndMinute
    )
  }

  return {
    resizeState: readonly(_resizeState),
    isResizing: readonly(_isResizing),
    startResize,
    cancelResize,
  }
}

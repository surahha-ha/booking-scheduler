import { computed, readonly, ref } from 'vue'
import type { ComputedRef, DeepReadonly, Ref } from 'vue'

/**
 * 예약 변경(reschedule) 모드 — V3 전용 페이지-로컬 상태머신 (화면정의서 13-6/13-7).
 *
 * ⋮ "변경" 클릭 → begin(id): 카드 select + "변경중" 배너 + interactionLock('reschedule') 점유.
 * 빈 슬롯 클릭 → pickSlot(cell): 원 예약 duration 유지하여 DragDropResult 생성 → onCommit(기존 handleDrop 재사용).
 * 배너 X / ESC → cancel: API 미호출 원복.
 *
 * 공유 컴포넌트(AppointmentCard/SchedulerGrid)는 inject('schedulerReschedule', null) 로 가산 소비 →
 * V2(provide 없음)는 null 이라 기존 동작 유지(사이드이펙트 0).
 *
 * commit 은 신규 API 없이 기존 drag drop 경로(dragResultAdapter→bookStore.modifyAppointment→triggerSearch)를 재사용한다.
 */

/** 변경 대상 슬롯 좌표(SchedulerGrid cell-click payload). */
export interface RescheduleSlot {
  columnKey: string
  date: string
  resourceId: string
  startMinute: number
  endMinute: number
}

/** commit 시 onCommit 으로 넘기는 결과 — 기존 DragDropResult 와 동일 형태. */
export interface RescheduleResult {
  appointmentId: string
  fromColumnKey: string
  toColumnKey: string
  toDate: string
  toResourceId: string
  newStartMinute: number
  newEndMinute: number
  toSubColIndex: number
}

interface RescheduleState {
  appointmentId: string
  fromColumnKey: string
  startMinute: number
  endMinute: number
}

interface LockHandle {
  unlock: () => void
}

interface RescheduleDeps {
  /** interactionLock.acquire('reschedule') 로 다른 인터랙션 차단. */
  acquireLock: () => LockHandle | null
  /** id → 원 예약(시작/종료분·컬럼키) 조회. duration 보존·취소 원복용. */
  getOrigin: (_appointmentId: string) => RescheduleState | null
  /** 빈 슬롯 선택 시 실제 저장 — 기존 handleDrop 재사용. */
  onCommit: (_result: RescheduleResult) => void | Promise<void>
}

export interface UseSchedulerRescheduleReturn {
  active: ComputedRef<boolean>
  targetId: DeepReadonly<Ref<string | null>>
  begin: (_appointmentId: string) => void
  pickSlot: (_slot: RescheduleSlot) => void
  cancel: () => void
}

export function useSchedulerReschedule(deps: RescheduleDeps): UseSchedulerRescheduleReturn {
  const state = ref<RescheduleState | null>(null)
  let lockHandle: LockHandle | null = null

  const active = computed(() => state.value != null)
  const targetId = computed(() => state.value?.appointmentId ?? null)

  function begin(appointmentId: string) {
    if (state.value) cancel() // 진행 중이던 변경은 정리 후 새로 시작
    const origin = deps.getOrigin(appointmentId)
    if (!origin) return
    lockHandle = deps.acquireLock()
    if (!lockHandle) return // 다른 인터랙션 진행 중 → 진입 취소
    state.value = origin
  }

  function pickSlot(slot: RescheduleSlot) {
    const cur = state.value
    if (!cur) return
    // 원 예약 길이(duration) 유지 — 슬롯 endMinute 가 아니라 원 duration 으로 종료 계산.
    const duration = Math.max(0, cur.endMinute - cur.startMinute)
    const newStartMinute = slot.startMinute
    const newEndMinute = newStartMinute + duration
    const result: RescheduleResult = {
      appointmentId: cur.appointmentId,
      fromColumnKey: cur.fromColumnKey,
      toColumnKey: slot.columnKey,
      toDate: slot.date,
      toResourceId: slot.resourceId,
      newStartMinute,
      newEndMinute,
      toSubColIndex: 0,
    }
    // 먼저 모드 종료(배너/lock 해제) 후 저장 — 저장 리프레시 동안 변경 UI 잔존 방지.
    cancel()
    void deps.onCommit(result)
  }

  function cancel() {
    state.value = null
    if (lockHandle) {
      lockHandle.unlock()
      lockHandle = null
    }
  }

  return {
    active,
    targetId: readonly(targetId) as DeepReadonly<Ref<string | null>>,
    begin,
    pickSlot,
    cancel,
  }
}

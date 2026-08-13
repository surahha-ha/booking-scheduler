/**
 * Appointment Card ⋮ Menu
 *
 * 카드 ⋮ popover 메뉴의 "무엇이 보이고 무엇이 활성인가"를 한곳에서 정의한다.
 * AppointmentCard.vue 는 이 결과를 렌더링만 하고, 항목을 직접 나열하지 않는다.
 *
 * 분기축은 화면(dataType: 예약/진료) + 예약 상태 코드다.
 * 실제 동작(dialog 확인, store 호출)은 부수효과라 AppointmentCard 에 남는다.
 */

import type { DataType } from '@/constants/schedulerSearchFilter'

export type CardMenuAction = 'EDIT' | 'COMPLETE' | 'NOSHOW' | 'CANCEL' | 'RESTORE' | 'DELETE'

/** 상태 변경 API 로 나가는 액션. EDIT(팝업)·DELETE(삭제 API)는 경로가 달라 제외한다. */
export type CardStateAction = Exclude<CardMenuAction, 'EDIT' | 'DELETE'>

export interface CardMenuButton {
  value: CardMenuAction
  displayLabel: string
  /** true 면 항목을 숨기지 않고 비활성으로 노출한다(메뉴 위치 고정). */
  disabled?: boolean
}

/** 초기화는 상태를 00 으로 되돌리는 동작이라, 이미 00 이면 할 일이 없다. */
function isRestoreDisabled(status: string): boolean {
  return status === '00'
}

/** 초기화는 예약·진료 공통. 취소·미이행·완료·접수대기 건을 되살리는 유일한 경로다. */
function restoreButton(status: string): CardMenuButton {
  return { value: 'RESTORE', displayLabel: '초기화', disabled: isRestoreDisabled(status) }
}

export function buildCardMenu(dataType: DataType, status: string): CardMenuButton[] {
  if (dataType === 'APPOINTMENT') {
    return [
      { value: 'EDIT', displayLabel: '변경' },
      { value: 'CANCEL', displayLabel: '예약 취소' },
      restoreButton(status),
      { value: 'DELETE', displayLabel: '예약 삭제' },
    ]
  }
  return [
    { value: 'COMPLETE', displayLabel: '완료' },
    { value: 'NOSHOW', displayLabel: '미이행' },
    { value: 'CANCEL', displayLabel: '예약 취소' },
    restoreButton(status),
    { value: 'DELETE', displayLabel: '진료 삭제' },
  ]
}

/**
 * 메뉴 액션 → bookStore.modifyAppointmentState 의 API state.
 * RESTORE 만 이름이 어긋난다 — 초기화(00 복원)의 API state 는 `default_` 다.
 */
export function toApiState(action: CardStateAction): string {
  return action === 'RESTORE' ? 'default_' : action.toLowerCase()
}

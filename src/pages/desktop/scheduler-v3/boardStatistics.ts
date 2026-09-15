/**
 * 화면 통계 — 상태 칩·회원 토글 옆 숫자를 "지금 화면에 그려진 칸의 예약"에서 센다.
 *
 * BE 집계(/statistics/*)를 쓰지 않는 이유: 조회 창은 화면보다 길고(예약 0건 가정 일수) 페이지 경계 칸은
 * 담당자 일부만 보여, 어떤 파라미터를 보내도 SQL 의 모수와 화면의 카드는 같아질 수 없었다.
 * 여기서는 엔진이 카드를 놓는 칸 키(unitKeyOf)와 같은 규칙으로 예약을 고르므로 카드 수와 숫자가 정의상 같다.
 *
 * 상태 필터(filterByStatus)도 같은 자리에서 한다 — 목록은 모든 상태를 받고 화면에서 거른다. 거르는 기준과
 * 세는 기준이 둘 다 toDisplayStatus(카드가 보이는 상태)라, 예약장부에서 완료·미이행·대기는
 * '예약' 칩에 들어가고 '예약' 필터로도 보인다(카드가 '예약'으로 그려지는 것과 한 규칙).
 */

import { type ApptSource, unitKeyOf } from '@/scheduler-engine/redesign/runLayoutAdapter'
import { toDisplayStatus, toStatusCodes, toStatusLabel } from '@/utils/schedulerSearchFilterUtils'
import { isIntegratedMember } from '@/utils/memberRules'
import {
  APPOINTMENT_STATUS_TYPE,
  type AppointmentStatusType,
  type DataType,
  STATUS_TOTAL_LABEL,
  TREATMENT_STATUS_TYPE,
  type TreatmentStatusType,
} from '@/constants/schedulerSearchFilter'

type StatusKey = AppointmentStatusType | TreatmentStatusType

/** 집계·필터가 보는 예약 필드 — bookStore 의 SchedulerAppointment 가 이 형태를 만족한다. */
export type CountableAppointment = ApptSource & {
  status?: string
  memberYn?: string
  memberNo?: number | null
}

export type BoardStatistics = {
  /** {칩 라벨: 건수} + 전체(STATUS_TOTAL_LABEL). 칩이 없는 상태는 전체에만 든다. */
  state: Record<string, number>
  /** 통합회원 여부 — 카드의 회원 뱃지와 같은 규칙(isIntegratedMember). */
  member: Record<'Y' | 'N', number>
}

/** 상태 필터 적용. 빈 선택 = 전체. 판정은 카드가 보이는 상태(toDisplayStatus)다. */
export function filterByStatus<T extends { status?: string }>(
  appts: T[],
  statusKeys: StatusKey[],
  dataType: DataType,
): T[] {
  const codes = new Set(toStatusCodes(statusKeys))
  if (codes.size === 0) return appts
  return appts.filter(a => codes.has(toDisplayStatus(a.status, dataType)))
}

/** 그 장부의 모든 칩을 0 으로 깐 상태 맵 — 칸에 예약이 없어도 칩은 0 을 보여야 한다. */
function emptyStateMap(dataType: DataType): Record<string, number> {
  const labels = dataType === 'TREATMENT' ? TREATMENT_STATUS_TYPE : APPOINTMENT_STATUS_TYPE
  const out: Record<string, number> = { [STATUS_TOTAL_LABEL]: 0 }
  for (const label of Object.values(labels)) out[label] = 0
  return out
}

/**
 * 화면에 그려진 칸(visibleUnitKeys = 페이지 컬럼의 unit.key)에 속한 예약을 상태·회원별로 센다.
 * appts 는 상태 필터를 거치지 않은 전체 목록 — 필터로 숨긴 상태도 같은 칸의 건수로 보여 준다.
 */
export function countBoardStatistics(
  appts: CountableAppointment[],
  visibleUnitKeys: Iterable<string>,
  dataType: DataType,
): BoardStatistics {
  const visible = new Set(visibleUnitKeys)
  const state = emptyStateMap(dataType)
  const member: Record<'Y' | 'N', number> = { Y: 0, N: 0 }

  for (const a of appts) {
    if (!visible.has(unitKeyOf(a))) continue
    state[STATUS_TOTAL_LABEL] += 1
    const label = toStatusLabel(toDisplayStatus(a.status, dataType), dataType)
    if (label) state[label] += 1
    member[isIntegratedMember(a) ? 'Y' : 'N'] += 1
  }
  return { state, member }
}

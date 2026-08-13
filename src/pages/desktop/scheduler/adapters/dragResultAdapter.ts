/**
 * Drag/Resize Result Adapter
 *
 * V2 DragDropResult / ResizeResult → V1 BookItemRequest 변환.
 *
 * 방향: V2 → V1 (쓰기 전용, API 호출용)
 * 원본 SchedulerAppointment의 데이터를 기반으로
 * 변경된 시간/의사 정보만 덮어쓴다.
 */

import dayjs from 'dayjs'
import type { BookItemRequest } from '@/api/bookApi'
import type { SchedulerAppointment } from '@/stores/bookStore'
import type { DragDropResult } from '../composables/useSchedulerDrag'
import type { ResizeResult } from '../composables/useSchedulerResize'

// ═══════════════════════════════════════════════════════════
// minute → ISO datetime 변환
// ═══════════════════════════════════════════════════════════

/**
 * date("2026-03-30") + minute(870) → "2026-03-30T14:30:00"
 */
function minuteToISODateTime(date: string, minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

// ═══════════════════════════════════════════════════════════
// 공통: 원본에서 불변 필드 복사
// ═══════════════════════════════════════════════════════════

/**
 * V1 SchedulerAppointment에서 변경되지 않는 고객 정보를 복사.
 *
 * V1 ReservationPopup은 customerRefId를 null | number로 전달한다.
 * BookItemRequest 타입 정의는 string이지만 실제 런타임 값과 다르므로,
 * 원본 raw 값을 그대로 보존하여 V1 동작과 일치시킨다.
 */
function copyPatientFields(original: SchedulerAppointment): Pick<
  BookItemRequest,
  'memberNo' | 'patientName' | 'patientPhone' | 'customerRefId' | 'memo'
> {
  return {
    memberNo: original.memberNo,
    patientName: original.patientName ?? '',
    patientPhone: original.patientPhone ?? '',
    // V1은 null | number를 보냄. raw에서 원본 customerId를 그대로 사용.
    customerRefId: (original.customerRefId || null) as unknown as string,
    memo: original.memo ?? '',
  }
}

// ═══════════════════════════════════════════════════════════
// Drag Drop → BookItemRequest
// ═══════════════════════════════════════════════════════════

/**
 * 의사 이름 → 의사 이름 조회 (fallback용)
 */
export type DoctorNameResolver = (doctorName: string) => string

/**
 * V2 DragDropResult + V1 원본 → V1 BookItemRequest
 *
 * drag로 변경되는 필드: 날짜, 시작/종료 시간, 의사
 * 나머지(고객, 메모 등)는 원본에서 복사
 * state는 포함하지 않음 (V1 일반 modify와 동일, 상태 변경은 별도 API)
 *
 * @returns BookItemRequest 또는 null (resourceId 변환 실패 시)
 */
/**
 * V1 구조: externalStaffNo에 의사 이름(문자열)을 보냄.
 * 서버가 이름 → SNO 변환을 내부 처리함.
 * 따라서 V2에서도 toResourceId(의사 이름)를 그대로 전달.
 */
export function dragResultToBookItemRequest(
  result: DragDropResult,
  original: SchedulerAppointment,
  resolveDoctorName: DoctorNameResolver,
): BookItemRequest | null {
  const doctorName = resolveDoctorName(result.toResourceId) || original.doctorName || ''

  return {
    ...copyPatientFields(original),
    startDate: minuteToISODateTime(result.toDate, result.newStartMinute),
    endDate: minuteToISODateTime(result.toDate, result.newEndMinute),
    externalStaffNo: doctorName as unknown as number, // V1 호환: 서버가 이름→SNO 변환
    doctorName,
  }
}

// ═══════════════════════════════════════════════════════════
// Resize → BookItemRequest
// ═══════════════════════════════════════════════════════════

/**
 * V2 ResizeResult + V1 원본 → V1 BookItemRequest
 *
 * resize로 변경되는 필드: 시작/종료 시간만
 * 날짜, 의사, 고객 정보는 모두 원본 유지
 * state는 포함하지 않음 (V1 일반 modify와 동일)
 *
 * @returns BookItemRequest 또는 null (resourceId 변환 실패 시)
 */
export function resizeResultToBookItemRequest(
  result: ResizeResult,
  original: SchedulerAppointment,
): BookItemRequest | null {
  const date = dayjs(original.startDateTime).format('YYYY-MM-DD')
  const doctorName = original.doctorName ?? ''

  return {
    ...copyPatientFields(original),
    startDate: minuteToISODateTime(date, result.newStartMinute),
    endDate: minuteToISODateTime(date, result.newEndMinute),
    externalStaffNo: doctorName as unknown as number, // V1 호환: 서버가 이름→SNO 변환
    doctorName,
  }
}

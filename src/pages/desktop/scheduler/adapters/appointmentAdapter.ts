/**
 * Appointment Adapter
 *
 * V1 SchedulerAppointment (bookStore) → V2 scheduler engine 입력 형태 변환.
 *
 * V2 컴포넌트와 engine은 V1 타입을 직접 import하지 않는다.
 * 이 adapter가 경계에서 변환하므로, V1 API 구조 변경 시 여기만 수정하면 된다.
 *
 * 변환 방향: V1 → V2 (읽기 전용, 표시/배치용)
 * 역방향(V2 → V1)은 dragResultAdapter에서 처리한다.
 */

import dayjs from 'dayjs'
import type { SchedulerAppointment } from '@/stores/bookStore'

// ═══════════════════════════════════════════════════════════
// V2 engine용 appointment 타입
// ═══════════════════════════════════════════════════════════

/**
 * V2 scheduler engine / 컴포넌트가 사용하는 예약 데이터.
 * V1 SchedulerAppointment의 정보를 engine 친화적 형태로 가공한 것.
 */
export interface EngineAppointment {
  id: string
  /** headerBuilder의 leaf key와 동일한 형식: "${date}_${resourceId}" */
  columnKey: string
  date: string                    // "2026-03-30"
  resourceId: string              // doctorId
  startMinute: number             // 0~1439 (하루 기준 분)
  endMinute: number
  patientName: string             // V1 uiPatient (포맷 포함)
  doctorName: string
  doctorInitial: string           // V1 uiDoctor1
  treatmentCategory: string       // 서비스 항목명 (V1 uiTreatment, 미지정 '')
  memo: string
  status: string                  // 상태 코드 ('00', '02', '03')
  statusClass: string             // V1 uiStatusClass
  isJoinMember: boolean           // V1 uiJoin
  patientPhone: string
  isExternalSync: boolean             // 외부 시스템 연동 여부 — 'EXT' 뱃지 표시
  createdAt?: Date              // 예약 등록일시 — '당일'(오늘 등록) 뱃지 판정
  // 카드 표시정보(displayInfo) — 통합회원만 birth/age/gender, 비회원 빈값
  birth: string                   // 생년월일 표시(V1 uiBirth)
  age: string                     // 만나이(V1 uiAge)
  gender: string                  // 성별 라벨(V1 uiGender)
  /** V1 원본 참조. drag/resize 결과 → API 호출 시 필요. */
  _v1Raw: SchedulerAppointment
}

// ═══════════════════════════════════════════════════════════
// 변환 함수
// ═══════════════════════════════════════════════════════════

/**
 * Date → 하루 기준 분(minute) 변환
 * 예: 14:30 → 870
 */
function dateToMinute(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * Date → "YYYY-MM-DD" 문자열
 */
function dateToDateString(d: Date): string {
  return dayjs(d).format('YYYY-MM-DD')
}

/**
 * V1 SchedulerAppointment → V2 EngineAppointment 단건 변환
 */
export function toEngineAppointment(appt: SchedulerAppointment): EngineAppointment {
  const date = dateToDateString(appt.startDateTime)
  // V1은 doctorName으로 그룹핑 (VERTICAL_GROUP_ID = 'doctorName')
  // Doctor.id도 이름이므로 resourceId = doctorName
  const resourceId = appt.doctorName ?? ''

  return {
    id: appt.id,
    columnKey: `${date}_${resourceId}`,
    date,
    resourceId,
    startMinute: dateToMinute(appt.startDateTime),
    endMinute: dateToMinute(appt.endDateTime),
    patientName: appt.patientName ?? '예약',
    doctorName: appt.doctorName ?? '',
    doctorInitial: appt.uiDoctor1 ?? '',
    treatmentCategory: appt.uiTreatment ?? '',
    memo: appt.memo ?? '',
    status: appt.status ?? '',
    statusClass: appt.uiStatusClass ?? '',
    isJoinMember: appt.uiJoin ?? false,
    patientPhone: appt.patientPhone ?? '',
    isExternalSync: appt.isExternalSync ?? false,
    createdAt: appt.createdAt,
    birth: appt.uiBirth ?? '',
    age: appt.uiAge ?? '',
    gender: appt.uiGender ?? '',
    _v1Raw: appt,
  }
}

/**
 * V1 SchedulerAppointment[] → V2 EngineAppointment[] 배열 변환
 *
 * 삭제 표시(delYn === 'Y')된 항목은 제외한다.
 */
export function toEngineAppointments(appts: SchedulerAppointment[]): EngineAppointment[] {
  const result: EngineAppointment[] = []

  for (const appt of appts) {
    if (appt.delYn === 'Y') continue
    result.push(toEngineAppointment(appt))
  }

  return result
}

/**
 * EngineAppointment[]를 date + resourceId 기준으로 그룹핑.
 * columnKey("2026-03-30_doctor-123") 기준으로 그룹핑한다.
 */
export function groupByColumn(
  appts: EngineAppointment[]
): Map<string, EngineAppointment[]> {
  const map = new Map<string, EngineAppointment[]>()

  for (const appt of appts) {
    const key = `${appt.date}_${appt.resourceId}`
    const list = map.get(key)
    if (list) {
      list.push(appt)
    } else {
      map.set(key, [appt])
    }
  }

  return map
}

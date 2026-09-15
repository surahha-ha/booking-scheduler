// 이동·길이조절 요청이 서비스 항목을 그대로 실어 보내는지 검증.
//
// 서버(BookLockService.modifyWithLock)는 서비스 항목이 없는 수정 요청을 '해제'로 읽는다.
// 그래서 어댑터가 이 두 필드를 빠뜨리면 예약을 한 칸 옮기는 것만으로 서비스 항목이 지워진다.
import { describe, expect, it } from 'vitest'
import {
  dragResultToBookItemRequest,
  resizeResultToBookItemRequest,
} from '@/pages/desktop/scheduler/adapters/dragResultAdapter'

const original: any = {
  id: '1',
  patientName: '홍길동',
  patientPhone: '01012345678',
  customerRefId: null,
  memberNo: null,
  memo: '설치 상담',
  doctorName: '최교영',
  startDateTime: new Date('2026-06-22T10:30:00'),
  endDateTime: new Date('2026-06-22T11:00:00'),
  serviceGroupId: 10,
  serviceItemId: 101,
}

const dropResult: any = {
  appointmentId: '1',
  toDate: '2026-06-22',
  toResourceId: '최교영',
  toColumnKey: 'c1',
  newStartMinute: 840,
  newEndMinute: 870,
}

const resizeResult: any = {
  appointmentId: '1',
  columnKey: 'c1',
  newStartMinute: 630,
  newEndMinute: 720,
}

describe('dragResultAdapter — 서비스 항목 보존', () => {
  it('이동 요청에 서비스 항목이 원본 그대로 실린다', () => {
    const req = dragResultToBookItemRequest(dropResult, original, (n: string) => n)
    expect(req?.serviceGroupId).toBe(10)
    expect(req?.serviceItemId).toBe(101)
  })

  it('길이조절 요청에 서비스 항목이 원본 그대로 실린다', () => {
    const req = resizeResultToBookItemRequest(resizeResult, original)
    expect(req?.serviceGroupId).toBe(10)
    expect(req?.serviceItemId).toBe(101)
  })

  it('서비스 항목이 없는 예약은 null 로 실린다 — undefined 로 빠지지 않는다', () => {
    const noItem = { ...original, serviceGroupId: undefined, serviceItemId: undefined }
    const req = dragResultToBookItemRequest(dropResult, noItem, (n: string) => n)
    expect(req).toHaveProperty('serviceGroupId', null)
    expect(req).toHaveProperty('serviceItemId', null)
  })
})

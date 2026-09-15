import { describe, expect, it, vi } from 'vitest'
import dayjs from 'dayjs'
import { useSchedulerRules } from '../useSchedulerRules'

// staffStore 는 모듈 로드 시 useApi() 를 호출하는 api 모듈들을 import 한다 → 전부 stub.
// 여기서 쓰는 것은 원천 행 → DailySchedule 변환(institutionRowToDailySchedule) 하나뿐이다.
vi.mock('@/api/staffApi', () => ({ getDoctors: vi.fn(), syncDoctors: vi.fn() }))
vi.mock('@/api/siteApi', () => ({
  getSiteWorkHours: vi.fn(),
  getStaffWorkHours: vi.fn(),
  getTeams: vi.fn(),
  getTreatmentSettings: vi.fn(),
}))
vi.mock('@/api/publicHolidayApi', () => ({ fetchPublicHolidays: vi.fn(async () => []) }))
vi.mock('notivue', () => ({ push: { error: vi.fn(), success: vi.fn() } }))
import { institutionRowToDailySchedule } from '@/stores/staffStore'

/**
 * STEP8 — 공휴일 운영시간이 예약검증에 반영되는지 (2026-07-28).
 *
 * 배경: 공휴일 운영은 원래 사업장 설정이 공휴일마다 일자 행을 전개해 주는 데 얹혀 동작했다.
 * 전용 테이블(공휴일 운영시간 테이블)로 바뀌며 전개가 사라져, 공휴일에 요일 시간이 적용되거나
 * 매주 휴무 요일과 겹치면 예약이 막히는 상태였다. 이 파일이 그 회귀를 고정한다.
 *
 * 규칙: 공휴일 ∧ ¬휴무(holidayOpenDates) 이면
 *   - **담당자 설정이 우선** — 그 담당자가 그 요일을 정해 뒀으면(운영든 휴무가든) 그것을 쓴다
 *     (2026-07-29 정정. 이전엔 기관 공휴일 시간이 무조건 이겼다 — 평상시 우선순위를 공휴일이라고
 *      뒤집을 이유가 없다는 판단)
 *   - 담당자 **미설정** 요일일 때만 사업장 공휴일 운영시간(holiday)을 쓴다
 *   - 둘 다 미설정이면 **휴무**(2026-08-03 정정. 이전엔 시간 제한 없이 운영였다).
 *     공휴일 운영시간은 시작·종료시분이 NOT NULL 이라 미설정 = 운영시간을 정하지 않았다는 뜻이고,
 *     서버 운영시간 판정 도 같은 규칙이다.
 *     ★임시운영 지정일(holidayWorkDates)은 축이 달라 종전대로 종일 허용한다 — 일자별 시작·종료는
 *      nullable 이고 설정 화면에 일자별 시간 입력이 없다
 *   - **사업장** 요일 휴무(closedWeekdays)·요일 dayOffYn 은 무시한다. 담당자 휴무는 무시하지 않는다
 * ⚠️ 타임라인 밴드(layoutPipeline.resolveUnitHours)도 같은 규칙을 써야 한다 — 한쪽만 고치면
 *    "밴드는 열려 있는데 클릭하면 운영종료" 가 된다.
 */

const HOLIDAY = '2026-01-01'
const WEEKDAY_OF_HOLIDAY = dayjs(HOLIDAY).day()
const PLAIN_DAY = '2026-01-08' // 같은 요일의 평범한 날 (공휴일 아님)

// 기관: 7요일 09:00~18:00, 휴게시간1 13:00~14:00
function makeHospitalWeekly() {
  const daily = {
    dayOffYn: 'N' as const,
    open: { start: '09:00', end: '18:00' },
    breaks: [{ start: '13:00', end: '14:00', type: 'LUNCH' }],
    blocks: null,
  }
  const weekly: Record<number, typeof daily> = {}
  for (let wd = 0; wd <= 6; wd++) weekly[wd] = daily
  return weekly
}

// 기관 공휴일 운영시간: 10:00~15:00, 휴게 12:00~12:30
const HOLIDAY_DAILY = {
  dayOffYn: 'N' as const,
  open: { start: '10:00', end: '15:00' },
  breaks: [{ start: '12:00', end: '12:30', type: 'LUNCH' }],
  blocks: null,
}

/* 세 담당자가 담당자 3상태를 모두 덮는다 — 공휴일 분기가 이 셋을 다르게 다뤄야 한다.
 *   kim  = 그 요일 09:00~17:00 운영 (정함)
 *   park = 그 요일 미설정 (weekly 에 키 없음) → 기관 공휴일 시간을 따른다
 *   lee  = 그 요일 명시적 휴무 (null) → 공휴일이어도 쉰다 */
function makeDoctorRules() {
  return {
    kim: {
      weekly: {
        [WEEKDAY_OF_HOLIDAY]: {
          dayOffYn: 'N' as const,
          open: { start: '09:00', end: '17:00' },
          breaks: null,
          blocks: null,
        },
      },
    },
    park: { weekly: {} },
    lee: { weekly: { [WEEKDAY_OF_HOLIDAY]: null } },
  }
}

function setup(hospitalOverrides: Record<string, unknown> = {}) {
  return useSchedulerRules({
    hospitalRules: {
      closedDates: new Set<string>(),
      closedWeekdays: new Set<number>(),
      holidayWorkDates: new Set<string>(),
      holidayOpenDates: new Set<string>([HOLIDAY]),
      /* 운영시간 소스는 "그 날이 공휴일인가"로 가른다(isPublicHolidayDate) — 기관이 그 공휴일에
       * 문을 여는지(holidayOpenDates)와는 별개 축이다. staffStore 가 실제로 채워 보내는 값이다. */
      publicHolidayDates: new Set<string>([HOLIDAY]),
      weekly: makeHospitalWeekly(),
      holiday: HOLIDAY_DAILY,
      ...hospitalOverrides,
    } as any,
    doctorRules: makeDoctorRules() as any,
    blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
    selectedDoctors: new Set(['kim']),
    cellDuration: 30,
    doctorsRef: [
      { id: 'kim', text: '김담당' },
      { id: 'park', text: '박담당' },
      { id: 'lee', text: '이담당' },
    ],
    options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
  })
}

describe('useSchedulerRules — 공휴일 운영시간', () => {
  it('담당자 미설정: 기관 공휴일 운영시간이 적용된다 (09:30 은 운영 전, 11:00 은 통과)', () => {
    const { getBlockedReason } = setup()
    const early = getBlockedReason(`${HOLIDAY}T09:30:00`, 'park')
    expect(early.blocked).toBe(true)
    expect(early.reason).toBe('outsideHours')

    const inside = getBlockedReason(`${HOLIDAY}T11:00:00`, 'park')
    expect(inside.blocked).toBe(false)
    expect(inside.reason).toBe('none')
  })

  it('담당자 미설정: 기관 공휴일 종료(15:00) 밖인 16:00 은 차단된다', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`${HOLIDAY}T16:00:00`, 'park')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('outsideHours')
  })

  it('★담당자가 정한 요일이면 공휴일에도 담당자 시간이 이긴다 — 16:00 통과', () => {
    // 기관 공휴일 시간(~15:00)보다 담당자 시간(~17:00)이 우선. 평상시 우선순위와 같다.
    const { getBlockedReason } = setup()
    expect(getBlockedReason(`${HOLIDAY}T16:00:00`, 'kim').blocked).toBe(false)
    // 담당자 시작(09:00) 전은 여전히 차단 — 기관 공휴일 시간(10:00)을 끌어다 쓰지 않는다.
    expect(getBlockedReason(`${HOLIDAY}T08:00:00`, 'kim').blocked).toBe(true)
  })

  it('★담당자가 그 요일을 휴무로 정했으면 공휴일에도 쉰다', () => {
    // 기관이 "공휴일에 운영한다"고 정해도 그 담당자를 출근시킬 수는 없다.
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`${HOLIDAY}T11:00:00`, 'lee')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('outsideHours')
  })

  it('공휴일 운영시간의 휴게는 그대로 휴게로 표시된다 (12:00, 담당자 미설정)', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`${HOLIDAY}T12:00:00`, 'park')
    expect(r.reason).toBe('lunch')
    expect(r.range).toEqual({ start: '12:00', end: '12:30' })
  })

  /* ★휴게는 운영시간과 갈린다 — 휴게는 사업장만 소유하므로, 담당자 운영시간을 쓰는 날에도
   * 휴게는 그 날짜의 기관 값(공휴일 휴게)이다. 담당자 daily 에 실려 오는 휴게는 staffStore 가
   * 병합한 요일별 값이라, 그대로 두면 공휴일 휴게 설정이 사실상 항상 무시된다
   * (담당자가 평일 요일을 정해 두는 것이 보통이므로). dev:mock 눈검증에서 발견. */
  it('★담당자가 정한 요일이어도 휴게는 공휴일 휴게를 쓴다 (12:00 차단)', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`${HOLIDAY}T12:00:00`, 'kim')
    expect(r.reason).toBe('lunch')
    expect(r.range).toEqual({ start: '12:00', end: '12:30' })
  })

  it('★담당자가 정한 요일이면 요일별 휴게(13:00~14:00)는 공휴일에 따라오지 않는다', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`${HOLIDAY}T13:00:00`, 'kim')
    expect(r.blocked).toBe(false)
    expect(r.reason).toBe('none')
  })

  it('★담당자 daily 에 요일 휴게가 병합돼 있어도 공휴일엔 공휴일 휴게로 교체된다', () => {
    // staffStore 산출물의 실제 모양 — 담당자 daily 에 기관 요일 휴게(13~14)가 실려 온다.
    const { getBlockedReason } = useSchedulerRules({
      hospitalRules: {
        closedDates: new Set<string>(),
        closedWeekdays: new Set<number>(),
        holidayWorkDates: new Set<string>(),
        holidayOpenDates: new Set<string>([HOLIDAY]),
        publicHolidayDates: new Set<string>([HOLIDAY]),
        weekly: makeHospitalWeekly(),
        holiday: HOLIDAY_DAILY,
      } as any,
      doctorRules: {
        kim: {
          weekly: {
            [WEEKDAY_OF_HOLIDAY]: {
              dayOffYn: 'N' as const,
              open: { start: '09:00', end: '17:00' },
              breaks: [{ start: '13:00', end: '14:00', type: 'LUNCH' }],
              blocks: null,
            },
          },
        },
      } as any,
      blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
      selectedDoctors: new Set(['kim']),
      cellDuration: 30,
      doctorsRef: [{ id: 'kim', text: '김담당' }],
      options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
    } as any)

    expect(getBlockedReason(`${HOLIDAY}T12:00:00`, 'kim').reason).toBe('lunch')
    expect(getBlockedReason(`${HOLIDAY}T13:00:00`, 'kim').blocked).toBe(false)
    // 공휴일이 아닌 같은 요일은 그대로 요일 휴게다(회귀 가드).
    expect(getBlockedReason(`${PLAIN_DAY}T13:00:00`, 'kim').reason).toBe('lunch')
  })

  it('공휴일 시간이 미설정이면 담당자 휴게는 건드리지 않는다 (요일 휴게 유지)', () => {
    const { getBlockedReason } = setup({ holiday: null })
    // holiday 가 없으면 교체할 근거가 없다 — kim 은 breaks:null 이라 12:00 도 열려 있다.
    expect(getBlockedReason(`${HOLIDAY}T12:00:00`, 'kim').blocked).toBe(false)
  })

  /* 규약 — 사업장 공휴일 시간이 없으면 **사업장 요일 시간 → 09:00~18:00** 으로 내려간다.
   * 종전에는 종일운영(daily=undefined)로 마감했는데, 설정·보기 화면과 타임라인 밴드는 요일 시간을
   * 그려서 "화면은 09~18 인데 보드는 종일 열림"이 됐다. 네 계층의 폴백을 하나로 맞춘 결과다.
   * (임시운영 지정일도 예외 없음 — 아래 케이스 A.) */
  // 기대값 출처: 정책 결정(네 계층 폴백 통일). 종전 "종일운영" 단언은 예약검증만의 동작을 굳힌 것이었다.
  it('★공휴일 운영 + 공휴일 시간 미설정 → 사업장 요일 시간으로 내려간다 (20:00 은 막힌다)', () => {
    const { getBlockedReason } = setup({ holiday: null })

    // 20:00 = 기관 요일 시간(09~18) 밖 → 운영종료
    const late = getBlockedReason(`${HOLIDAY}T20:00:00`, 'park')
    expect(late.blocked, '요일 시간 밖은 막힌다').toBe(true)
    expect(late.reason).toBe('outsideHours')

    // 요일 시간 안은 그대로 열린다 — 공휴일에 운영하기로 한 의도는 유지된다.
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked).toBe(false)
  })

  /* 휴게 행만 있는 공휴일 시간(시작·종료 없음)은 원천 변환기가 **미설정(undefined)** 으로 읽는다 —
   * BE 의 "전체구간 공백" 검사와 같은 기준으로, 휴게만으로는 운영시간을 정한 것이 아니다.
   * 그래서 바로 위 케이스와 같은 답이다: 기관 요일 시간으로 내려간다(20:00 은 막힌다).
   * 종전 테스트는 {open:null, breaks:[…]} 모양을 손으로 만들어 "종일운영" 를 단언했는데, 그 모양은
   * staffStore 가 만들지 않는 죽은 모양이라 규칙의 죽은 분기를 규범처럼 봉인하고 있었다(감사 §2-8).
   * 기대값 출처: 정책 결정(2026-09-02 네 계층 폴백 통일 157cbb9) + 실물 변환기 계약. */
  it('★공휴일 시간이 휴게 행만 있으면 원천이 미설정으로 읽어 기관 요일 시간으로 내려간다', () => {
    const holiday = institutionRowToDailySchedule({
      openHm: null, closeHm: null,
      lunchStartHm: '1200', lunchEndHm: '1300',
      dinnerStartHm: null, dinnerEndHm: null,
    })
    expect(holiday, '휴게만으로는 운영시간을 정한 것이 아니다 — 미설정').toBeUndefined()

    const { getBlockedReason } = setup({ holiday })
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').blocked, '요일 시간(09~18) 밖은 막힌다').toBe(true)
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked).toBe(false)
  })

  /* 2026-09-02 — 공휴일 축은 담당자 자기 값(HOLIDAY_OPEN_YN)이다. 기관이 그 공휴일에 쉬어도 'Y' 인
   * 담당자는 그날 운영하고, 그 시간은 **기관 공휴일 운영시간**이다.
   * 종전에는 시간 소스를 기관 기준(holidayOpenDates)으로만 갈라, 그런 담당자의 시간이 공휴일 시간을
   * 건너뛰고 기관 요일 시간(09~18)으로 떨어졌다 — 설정·보기 화면(공휴일 시간)과 답이 갈렸다.
   * 기관이 공휴일 휴무가면 그 날짜는 closedDates 에 담기지만, 출처가 일자 지정도 반복 휴무도 아니므로
   * 담당자에게 상속되지 않는다(inheritsHospitalClosedDate). */
  it('★기관이 공휴일 휴무가어도 그날 운영하는 담당자에겐 기관 공휴일 운영시간이 적용된다', () => {
    /* setup() 의 doctorRules 는 weekly 만 있어 휴무 집합을 기관에서 빌려 쓴다(fallback).
     * 여기서는 staffStore 산출물처럼 담당자가 자기 휴무 집합을 갖는 실제 모양으로 구성한다. */
    const { getBlockedReason } = useSchedulerRules({
      hospitalRules: {
        closedDates: new Set<string>([HOLIDAY]),     // 기관은 그 공휴일에 쉰다
        closedWeekdays: new Set<number>(),
        designatedOffDates: new Set<string>(),       // 일자 지정도
        recurringClosedDates: new Set<string>(),     // 반복 휴무도 아닌 = 공휴일 사유
        holidayWorkDates: new Set<string>(),
        holidayOpenDates: new Set<string>(),
        publicHolidayDates: new Set<string>([HOLIDAY]),
        weekly: makeHospitalWeekly(),
        holiday: HOLIDAY_DAILY,
      } as any,
      doctorRules: {
        // 공휴일에 운영('Y')하는 담당자 — 자기 휴무 집합은 비어 있다.
        park: {
          weekly: {},
          closedDates: new Set<string>(),
          closedWeekdays: new Set<number>(),
          inheritsHospitalDateOff: true,
          inheritsHospitalWeekdayOff: true,
        },
      } as any,
      blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
      selectedDoctors: new Set(['park']),
      cellDuration: 30,
      doctorsRef: [{ id: 'park', text: '박담당' }],
      options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
    } as any)

    // 기관 공휴일 시간 10:00~15:00 이 적용된다 — 요일 시간(09~18)이 아니다.
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked, '공휴일 시간 안').toBe(false)
    expect(getBlockedReason(`${HOLIDAY}T16:00:00`, 'park').reason, '공휴일 시간 밖').toBe('outsideHours')
    // 요일 시간에만 있는 09:30 은 막힌다 — 요일 축으로 떨어지지 않았다는 뜻이다.
    expect(getBlockedReason(`${HOLIDAY}T09:30:00`, 'park').reason).toBe('outsideHours')
  })

  it('★공휴일 시간이 미설정이어도 담당자가 그 요일을 정해 뒀으면 운영한다 (담당자 우선 회귀 가드)', () => {
    // 휴무 판정은 "담당자도 미설정"일 때만이다. 담당자 우선 규칙을 덮어쓰면 안 된다.
    const { getBlockedReason } = setup({ holiday: null })
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'kim').blocked).toBe(false)
  })

  /* 케이스 A — 임시운영 지정일. 규약 갱신으로 **예외가 없어졌다.**
   *
   * 종전에는 "일자별 시작·종료시분이 nullable 이라 시간 없는 운영 지정이 정상 상태이고 설정 화면에
   * 일자별 시간 입력이 없다"는 이유로 이 날만 종일운영을 유지했다. 그런데 그 사이 서버가 저장 시점에
   * **같은 규칙으로** 시간을 채우게 됐다 — 그 요일 사업장 운영시간 → 없으면 "0900"~"1800".
   * 그 값이 dateTimes 로 내려와 dailyByDate 로 들어오고, 여기서 가장 먼저 쓰인다(아래 두 번째 단언).
   * 그래서 "시간을 모르는 임시운영 지정일"이라는 전제가 사라졌고, 예외를 남기면 도달하지 않는 분기만 늘어난다. */
  it('★임시운영 지정일도 같은 폴백을 쓴다 — 예외 없음 (케이스 A 갱신)', () => {
    const { getBlockedReason } = setup({
      holiday: null,
      holidayWorkDates: new Set<string>([HOLIDAY]),
    })
    // 기관 요일 시간(09~18)으로 내려간다 — 종일운영이 아니다.
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked, '요일 시간 안').toBe(false)
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').reason, '요일 시간 밖').toBe('outsideHours')
  })

  it('★임시운영 지정일에 저장된 시각(dateTimes)이 있으면 그것이 가장 먼저다', () => {
    /* BE 가 채워 보내는 실제 상태 — 이 값이 있으면 공휴일·요일 어느 것도 보지 않는다.
     * 케이스 A 가 지키려던 것("임시운영 지정 기능이 죽지 않는다")은 이 계약이 보장한다. */
    const { getBlockedReason } = setup({
      holiday: null,
      holidayWorkDates: new Set<string>([HOLIDAY]),
      dailyByDate: {
        [HOLIDAY]: { dayOffYn: 'N', open: { start: '13:00', end: '21:00' }, breaks: null, blocks: null },
      },
    })
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').blocked, '지정 시각 안').toBe(false)
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').reason, '지정 시각 밖').toBe('outsideHours')
  })

  it('공휴일이 매주 휴무 요일과 겹쳐도 운영한다 (기관 요일휴무 무시)', () => {
    const { getBlockedReason } = setup({
      closedWeekdays: new Set([WEEKDAY_OF_HOLIDAY]),
    })
    const r = getBlockedReason(`${HOLIDAY}T11:00:00`, 'park')
    expect(r.blocked).toBe(false)

    // 같은 요일이라도 공휴일이 아닌 날은 그대로 요일 휴무이다.
    const plain = getBlockedReason(`${PLAIN_DAY}T11:00:00`, 'park')
    expect(plain.blocked).toBe(true)
    expect(plain.reason).toBe('closedWeekday')
  })

  it('공휴일 휴무(holidayOpenDates 에 없고 closedDates 에 있음) → 휴무일로 차단', () => {
    const { getBlockedReason } = setup({
      holidayOpenDates: new Set<string>(),
      closedDates: new Set([HOLIDAY]),
    })
    const r = getBlockedReason(`${HOLIDAY}T11:00:00`, 'kim')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('closedDate')
  })

  it('공휴일이 아닌 날은 기존 동작 그대로 — 담당자 시간 우선, 기관 점심 fallback (회귀 가드)', () => {
    const { getBlockedReason } = setup()
    // 담당자 시간 09~17 → 16:00 통과
    expect(getBlockedReason(`${PLAIN_DAY}T16:00:00`, 'kim').blocked).toBe(false)
    // 공휴일 휴게(12:00)는 평일에 영향 없음
    expect(getBlockedReason(`${PLAIN_DAY}T12:00:00`, 'kim').reason).toBe('none')
  })

  it('헤더 휴무 판정: 공휴일 운영일은 휴무가 아니다 (요일휴무와 겹쳐도)', () => {
    const { isHospitalClosedDayForHeader, isClosedDayForHeader } = setup({
      closedWeekdays: new Set([WEEKDAY_OF_HOLIDAY]),
    })
    expect(isHospitalClosedDayForHeader(`${HOLIDAY}T00:00:00`)).toBe(false)
    expect(isClosedDayForHeader(`${HOLIDAY}T00:00:00`, 'park')).toBe(false)
    // 같은 요일의 평범한 날은 휴무
    expect(isHospitalClosedDayForHeader(`${PLAIN_DAY}T00:00:00`)).toBe(true)
  })

  it('★헤더 휴무 판정: 담당자가 휴무로 정한 요일은 공휴일이어도 휴무로 뜬다', () => {
    const { isClosedDayForHeader } = setup()
    expect(isClosedDayForHeader(`${HOLIDAY}T00:00:00`, 'lee')).toBe(true)
  })

  /**
   * ★예약 차단(pickReason)과 헤더 휴무 배지(isClosedDayForHeader)는 **항상 같은 답**이어야 한다.
   * 한쪽만 고치면 "컬럼은 멀쩡해 보이는데 어느 칸도 못 누르는" 화면이 된다 —
   * 사용자는 왜 막혔는지 알 수 없다. 이 절이 두 함수의 정합을 고정한다.
   */
  it('★공휴일 시간 미설정 → 휴무 배지는 켜지지 않는다 (막히는 것은 시간 밖일 뿐 휴무가 아니다)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup({ holiday: null })

    // 요일 시간(09~18) 안은 열린다 — 그날은 휴무가 아니다.
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked, '요일 시간 안').toBe(false)
    // 20:00 은 시간 밖이라 막히지만 사유는 운영종료이지 휴무가 아니다.
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').reason, '시간 밖 사유').toBe('outsideHours')
    expect(isClosedDayForHeader(HOLIDAY, 'park'), '헤더 휴무 배지').toBe(false)
  })

  it('★담당자가 그 요일을 정해 뒀으면 배지도 뜨지 않는다 (담당자 우선 정합)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup({ holiday: null })

    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'kim').blocked).toBe(false)
    expect(isClosedDayForHeader(HOLIDAY, 'kim')).toBe(false)
  })

  it('★공휴일 시간이 설정돼 있으면 배지가 뜨지 않는다 (회귀 가드)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup()

    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked).toBe(false)
    expect(isClosedDayForHeader(HOLIDAY, 'park')).toBe(false)
  })

  it('★임시운영 지정일은 휴무 배지가 뜨지 않는다 (시간 밖은 막혀도 휴무는 아니다)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup({
      holiday: null,
      holidayWorkDates: new Set<string>([HOLIDAY]),
    })

    // 기관 요일 시간(09~18) 안은 열린다 — 그날은 운영일이다.
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'park').blocked, '요일 시간 안').toBe(false)
    // 20:00 은 시간 밖이라 막히지만 사유는 운영종료이지 휴무가 아니다.
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').reason, '시간 밖 사유').toBe('outsideHours')
    expect(isClosedDayForHeader(HOLIDAY, 'park'), '헤더 휴무 배지').toBe(false)
  })

  /**
   * ★일자별 지정 시간(dailyByDate) — 지정일자에 **실제로 저장된** 사업장 운영시간.
   *
   * 종전에는 FE 가 이 값을 받지 못해 그 날짜를 요일 시간(또는 아무것도 없으면 종일)으로 추정했다.
   * 그래서 저장된 시간(예: 10:00~14:00) 밖 예약을 받아 사업장 설정·운영중 표시와 갈렸다.
   * 우선순위는 **일자별 > 공휴일 > 요일** — BE 운영중 판정과 같은 순서다.
   *
   * ★WORK_DATE 는 PLAIN_DAY(공휴일 아닌 같은 요일)를 쓴다 — 담당자 규칙이 그 요일에 걸려 있어야
   *   "담당자 우선"까지 함께 검증된다. 그리고 15:00 이 판별 시각이다:
   *   요일 시간(09~18) 안이지만 일자별(10~14) 밖이라, 둘 중 무엇이 적용됐는지 갈린다.
   */
  const WORK_DATE = PLAIN_DAY
  const DATE_DAILY = {
    dayOffYn: 'N' as const,
    open: { start: '10:00', end: '14:00' },
    breaks: [{ start: '12:00', end: '12:30', type: 'LUNCH' }],
    blocks: null,
  }

  function setupWorkDate(extra: Record<string, unknown> = {}) {
    return setup({
      holidayWorkDates: new Set<string>([WORK_DATE]),
      dailyByDate: { [WORK_DATE]: DATE_DAILY },
      ...extra,
    })
  }

  it('★지정일자는 저장된 그 날짜 시간으로 판정한다 (요일 시간으로 내려가지 않는다)', () => {
    const { getBlockedReason } = setupWorkDate()

    expect(getBlockedReason(`${WORK_DATE}T11:00:00`, 'park').blocked, '일자별 10~14 안').toBe(false)
    expect(getBlockedReason(`${WORK_DATE}T15:00:00`, 'park').blocked, '일자별 밖(요일 09~18 안)').toBe(true)
  })

  it('지정일자의 휴게도 그 날짜 값을 쓴다', () => {
    const { getBlockedReason } = setupWorkDate()

    const r = getBlockedReason(`${WORK_DATE}T12:00:00`, 'park')
    expect(r.reason).toBe('lunch')
    expect(r.range).toEqual({ start: '12:00', end: '12:30' })
  })

  it('★지정일자에도 담당자가 그 요일을 정해 뒀으면 담당자 시간이 이긴다', () => {
    // 평상시·공휴일과 같은 우선순위(담당자 > 기관). kim = 그 요일 09:00~17:00
    const { getBlockedReason } = setupWorkDate()

    expect(getBlockedReason(`${WORK_DATE}T16:00:00`, 'kim').blocked, '일자별 14:00 밖이지만 담당자 17:00 안').toBe(false)
    // 휴게는 사업장만 소유하므로 담당자 시간을 써도 그 날짜 휴게를 쓴다.
    expect(getBlockedReason(`${WORK_DATE}T12:00:00`, 'kim').reason).toBe('lunch')
  })

  it('★지정일자는 담당자가 휴무로 정한 요일을 덮지 못한다 — 자기 매주 휴무 > 사업장 상속 (§3-1-1)', () => {
    // lee = 그 요일 명시 휴무. 사업장이 그날을 임시운영으로 지정해도 그 담당자는 쉰다 — 휴무일 탭 뷰어와 같은 답.
    // (2026-08-28 정정 — 종전에는 기관 지정이 담당자 휴무를 덮어, 뷰어는 휴무인데 보드만 열렸다.)
    const { getBlockedReason, isClosedDayForHeader } = setupWorkDate()

    const r = getBlockedReason(`${WORK_DATE}T11:00:00`, 'lee')
    expect(r.blocked, '기관 지정일자 시간 안이지만 담당자 휴무').toBe(true)
    expect(r.source).toBe('doctor')
    expect(isClosedDayForHeader(WORK_DATE, 'lee')).toBe(true)
  })

  it('★예약 차단과 헤더 배지가 갈리지 않는다 (dailyByDate 경로)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setupWorkDate()

    expect(getBlockedReason(`${WORK_DATE}T11:00:00`, 'park').blocked).toBe(false)
    expect(isClosedDayForHeader(WORK_DATE, 'park'), '운영하는 날이라 배지 없음').toBe(false)
  })

  it('dailyByDate 에 없는 날짜는 종전대로 요일 시간으로 판정한다 (회귀 가드)', () => {
    const { getBlockedReason } = setup({
      holidayWorkDates: new Set<string>([WORK_DATE]),
      dailyByDate: {},
    })

    expect(getBlockedReason(`${WORK_DATE}T15:00:00`, 'park').blocked, '요일 09~18 안이라 열린다').toBe(false)
  })
})

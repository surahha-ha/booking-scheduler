import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { useSchedulerRules } from '../useSchedulerRules'

/**
 * STEP8 — 공휴일 운영시간이 예약검증에 반영되는지 (2026-07-28).
 *
 * 배경: 공휴일 진료는 원래 사업장 설정이 공휴일마다 일자 행을 전개해 주는 데 얹혀 동작했다.
 * 전용 테이블(공휴일 운영시간 테이블)로 바뀌며 전개가 사라져, 공휴일에 요일 시간이 적용되거나
 * 매주 휴무 요일과 겹치면 예약이 막히는 상태였다. 이 파일이 그 회귀를 고정한다.
 *
 * 규칙: 공휴일 ∧ ¬휴무(holidayOpenDates) 이면
 *   - **담당자 설정이 우선** — 그 의사가 그 요일을 정해 뒀으면(진료든 휴무가든) 그것을 쓴다
 *     (2026-07-29 정정. 이전엔 기관 공휴일 시간이 무조건 이겼다 — 평상시 우선순위를 공휴일이라고
 *      뒤집을 이유가 없다는 판단)
 *   - 담당자 **미설정** 요일일 때만 사업장 공휴일 운영시간(holiday)을 쓴다
 *   - 둘 다 미설정이면 **휴무**(2026-08-03 정정. 이전엔 시간 제한 없이 진료였다).
 *     공휴일 운영시간은 시작·종료시분이 NOT NULL 이라 미설정 = 운영시간을 정하지 않았다는 뜻이고,
 *     서버 운영시간 판정 도 같은 규칙이다.
 *     ★임시진료 지정일(holidayWorkDates)은 축이 달라 종전대로 종일 허용한다 — 일자별 시작·종료는
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

/* 세 의사가 담당자 3상태를 모두 덮는다 — 공휴일 분기가 이 셋을 다르게 다뤄야 한다.
 *   kim  = 그 요일 09:00~17:00 진료 (정함)
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
      weekly: makeHospitalWeekly(),
      holiday: HOLIDAY_DAILY,
      ...hospitalOverrides,
    } as any,
    doctorRules: makeDoctorRules() as any,
    blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
    selectedDoctors: new Set(['kim']),
    cellDuration: 30,
    doctorsRef: [
      { id: 'kim', text: '김의사' },
      { id: 'park', text: '박의사' },
      { id: 'lee', text: '이의사' },
    ],
    options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
  })
}

describe('useSchedulerRules — 공휴일 운영시간', () => {
  it('담당자 미설정: 기관 공휴일 운영시간이 적용된다 (09:30 은 진료 전, 11:00 은 통과)', () => {
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
    // 기관 공휴일 시간(~15:00)보다 의사 시간(~17:00)이 우선. 평상시 우선순위와 같다.
    const { getBlockedReason } = setup()
    expect(getBlockedReason(`${HOLIDAY}T16:00:00`, 'kim').blocked).toBe(false)
    // 의사 시작(09:00) 전은 여전히 차단 — 기관 공휴일 시간(10:00)을 끌어다 쓰지 않는다.
    expect(getBlockedReason(`${HOLIDAY}T08:00:00`, 'kim').blocked).toBe(true)
  })

  it('★담당자가 그 요일을 휴무로 정했으면 공휴일에도 쉰다', () => {
    // 기관이 "공휴일에 진료한다"고 정해도 그 의사를 출근시킬 수는 없다.
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
      doctorsRef: [{ id: 'kim', text: '김의사' }],
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

  it('공휴일 진료 + 공휴일 시간 미설정 → 그날은 종일진료 (요일 시간 밖 20:00 도 열린다)', () => {
    /* 공휴일에 진료하기로 했으면 시간을 안 정했어도 진료다 — 진료 의도를 시간 미입력이 뒤집지 않는다.
     * 서버 운영시간 판정 의 3) 분기와 같은 규칙(사업장 설정도 같은 규칙으로 전환 예정).
     * ★20:00 은 기관 요일 시간(09~18) 밖이다 — 요일 축으로 폴백했다면 막히므로,
     *   이 시각이라야 종일진료 규칙만 통과로 갈린다. */
    const { getBlockedReason } = setup({ holiday: null })
    const r = getBlockedReason(`${HOLIDAY}T20:00:00`, 'park')
    expect(r.blocked).toBe(false)
    expect(r.reason).toBe('none')
  })

  it('공휴일 시간이 휴게 행만 있으면(전체구간 없음) 미설정과 같이 종일진료', () => {
    // BE 의 "전체구간 공백" 검사와 같은 기준 — 휴게만으로는 운영시간을 정한 것이 아니다.
    const { getBlockedReason } = setup({
      holiday: { dayOffYn: 'N', open: null, breaks: [{ start: '12:00', end: '13:00', type: 'LUNCH' }], blocks: null },
    })
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').blocked).toBe(false)
  })

  it('★공휴일 시간이 미설정이어도 담당자가 그 요일을 정해 뒀으면 진료한다 (담당자 우선 회귀 가드)', () => {
    // 휴무 판정은 "담당자도 미설정"일 때만이다. 담당자 우선 규칙을 덮어쓰면 안 된다.
    const { getBlockedReason } = setup({ holiday: null })
    expect(getBlockedReason(`${HOLIDAY}T11:00:00`, 'kim').blocked).toBe(false)
  })

  it('★임시진료 지정일(holidayWorkDates)은 공휴일 시간이 없어도 종일 허용 (케이스 A 회귀 가드)', () => {
    /* 일자별 운영시간의 시작·종료시분은 nullable 이라 "시간 없는 진료 지정"이 정상 상태이고,
     * 설정 화면에는 일자별 시간 입력 자체가 없다. 공휴일 규칙을 여기까지 넓히면
     * 임시진료 지정 기능이 통째로 죽는다 — 원천 확인 전까지 종전 거동을 유지한다. */
    const { getBlockedReason } = setup({
      holiday: null,
      holidayWorkDates: new Set<string>([HOLIDAY]),
    })
    const r = getBlockedReason(`${HOLIDAY}T20:00:00`, 'park')
    expect(r.blocked).toBe(false)
    expect(r.reason).toBe('none')
  })

  it('공휴일이 매주 휴무 요일과 겹쳐도 진료한다 (기관 요일휴무 무시)', () => {
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

  it('공휴일이 아닌 날은 기존 동작 그대로 — 의사 시간 우선, 기관 점심 fallback (회귀 가드)', () => {
    const { getBlockedReason } = setup()
    // 의사 시간 09~17 → 16:00 통과
    expect(getBlockedReason(`${PLAIN_DAY}T16:00:00`, 'kim').blocked).toBe(false)
    // 공휴일 휴게(12:00)는 평일에 영향 없음
    expect(getBlockedReason(`${PLAIN_DAY}T12:00:00`, 'kim').reason).toBe('none')
  })

  it('헤더 휴무 판정: 공휴일 진료일은 휴무가 아니다 (요일휴무와 겹쳐도)', () => {
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
  it('★공휴일 시간 미설정 → 예약 차단도 휴무 배지도 켜지지 않는다 (종일진료)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup({ holiday: null })

    // 20:00 = 기관 요일 시간(09~18) 밖. 요일 축으로 폴백했다면 차단됐을 시각이다.
    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').blocked, '예약 차단').toBe(false)
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

  it('★임시진료 지정일은 배지도 예약도 열려 있다 (케이스 A 는 별개 축)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup({
      holiday: null,
      holidayWorkDates: new Set<string>([HOLIDAY]),
    })

    expect(getBlockedReason(`${HOLIDAY}T20:00:00`, 'park').blocked).toBe(false)
    expect(isClosedDayForHeader(HOLIDAY, 'park')).toBe(false)
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

  it('★지정일자는 담당자가 휴무로 정한 요일도 덮는다 — 단 종일이 아니라 그 날짜 시간으로', () => {
    // lee = 그 요일 명시 휴무. 날짜를 콕 집어 진료로 지정한 것이 더 구체적이라 이긴다.
    const { getBlockedReason } = setupWorkDate()

    expect(getBlockedReason(`${WORK_DATE}T11:00:00`, 'lee').blocked, '덮어서 열린다').toBe(false)
    expect(getBlockedReason(`${WORK_DATE}T15:00:00`, 'lee').blocked, '덮되 종일은 아니다').toBe(true)
  })

  it('★예약 차단과 헤더 배지가 갈리지 않는다 (dailyByDate 경로)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setupWorkDate()

    expect(getBlockedReason(`${WORK_DATE}T11:00:00`, 'park').blocked).toBe(false)
    expect(isClosedDayForHeader(WORK_DATE, 'park'), '진료하는 날이라 배지 없음').toBe(false)
  })

  it('dailyByDate 에 없는 날짜는 종전대로 요일 시간으로 판정한다 (회귀 가드)', () => {
    const { getBlockedReason } = setup({
      holidayWorkDates: new Set<string>([WORK_DATE]),
      dailyByDate: {},
    })

    expect(getBlockedReason(`${WORK_DATE}T15:00:00`, 'park').blocked, '요일 09~18 안이라 열린다').toBe(false)
  })
})

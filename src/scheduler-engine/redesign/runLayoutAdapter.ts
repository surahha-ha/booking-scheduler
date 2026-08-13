/**
 * V2 스케줄러 엔진 재설계 — store/api shape → RunLayoutInput adapter (격리 모듈, 라이브 미배선)
 *
 * 설계 기준: src/scheduler-engine/REDESIGN.md + 의사 식별자 결정(2026-06-01).
 * 핵심 결정:
 *  - 의사 그룹핑 키 = **이름**(안정 ID 부재 — 예약은 STAFF_NAME만, 외부 순번/로컬 STAFF_ID 모두 churn).
 *  - 팀 선택 = **이름 필터 오버레이**(팀 멤버 이름집합으로 컬럼 필터, 컬럼식별자만 staffId, 미매칭 예약 숨김).
 *  - 조인 키는 `resolveDoctorKey()` 단일함수로 추상화 → 미래 안정 ID 전환 시 한 곳만 교체.
 *  - 운영시간: AS-IS = 기관 weekly(open 단일범위)를 휴게로 split, TO-BE = 담당자별 WorkHours(오전/오후/야간) 직매핑.
 *
 * 본 모듈은 어떤 컴포넌트에도 연결되어 있지 않다(안전판). 단위테스트로만 검증.
 */

import type { CardInput } from './layoutCore'
import type {
  DoctorInput,
  EnvInput,
  ReservationSettingsInput,
  SessionRange,
  UnitHours,
  ViewStateInput,
} from './layoutTypes'
import type { RunLayoutInput } from './layoutPipeline'

// ════════════════════════════════════════════════════════════
// 입력 shape (store/api 실제 형태 미러)
// ════════════════════════════════════════════════════════════

/** bookStore Appointment 의 필요 부분. */
export interface ApptSource {
  id: string
  startDateTime: Date
  endDateTime: Date
  /** 안정 키 (현재) */
  doctorName: string
  /** 미래 안정 ID (현재 phantom='' — resolveDoctorKey 가 폴백) */
  doctorId?: string
}

/** staffStore Doctor — id 가 곧 이름(현재). */
export interface DoctorSource {
  id: string
  text: string
  staffId?: number
}

/** siteApi DoctorTeam. */
export interface TeamSource {
  id: number
  name: string
  doctors: { staffId: number, staffName: string }[]
}

/** staffStore DailySchedule (시간 "HH:MM"). */
export interface DailyScheduleSource {
  open?: { start: string, end: string } | null
  breaks?: { start: string, end: string, type: 'LUNCH' | 'DINNER' | 'CLOSED' }[] | null
  dayOffYn?: 'Y' | 'N'
}
export type WeeklySource = Partial<Record<number, DailyScheduleSource>>

/** siteApi WorkHoursRow (B: 의료인주간, 시간 "HHmm", staff* 접두).
 *  진료는 시작~종료 단일 구간. 휴게는 담당자가 갖지 않고 같은 요일의 기관 휴게를 따른다. */
export interface WorkHoursRowSource {
  dayCd: number
  staffOpenHm: string | null
  staffCloseHm: string | null
}

/** 그룹핑 모드 — 셀렉트박스 '전체'(name) vs 특정 팀(team). */
export type GroupingMode =
  | { kind: 'name' }
  | { kind: 'team', team: TeamSource }

export interface BuildRunLayoutInputParams {
  mode: GroupingMode
  settings: ReservationSettingsInput
  viewState: ViewStateInput
  env: EnvInput
  /** name 모드 의사 소스 (staffStore.doctors) */
  doctors: DoctorSource[]
  appts: ApptSource[]
  /** AS-IS 기관 weekly 운영시간 */
  weekly?: WeeklySource
  /** 기관 공휴일 운영시간(요일 축 없는 한 세트). holidayDates 인 날의 밴드 소스. */
  holiday?: DailyScheduleSource | null
  /** 날짜 → 그 날짜에 저장된 사업장 운영시간 (staffStore.hospitalRules.dailyByDate). */
  dailyByDate?: Record<string, DailyScheduleSource>
  /** 공휴일이면서 진료하는 날 "YYYY-MM-DD" (staffStore.hospitalRules.holidayOpenDates). */
  holidayDates?: string[]
  /**
   * name 모드 담당자별 요일 운영시간(기관 휴게 얹힌 weekly). key = unit.doctorId(=replaceDoctorName(이름)).
   * 있으면 엔진 hoursByDoctor 를 채워 타임라인 밴드가 예약검증(getBlockedReason, DOCTOR_FIRST)과 같은
   * "담당자 우선 + 기관 fallback" 소스를 쓰게 한다. 미전달 시 {} — 현행(기관 단독) 그대로.
   */
  doctorWeeklyById?: Record<string, WeeklySource>
  /** TO-BE 담당자별 운영시간. key = String(staffId) */
  workHoursByStaffId?: Record<string, WorkHoursRowSource[]>
  /** horizon 제어 (옵션) */
  horizonDays?: number
}

// ════════════════════════════════════════════════════════════
// 시간/날짜 변환 유틸 (순수)
// ════════════════════════════════════════════════════════════

/** "HH:MM" → 0:00 기준 분. 불량 시 null. */
export function colonHmToMin(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** "HHmm" → 0:00 기준 분. 불량 시 null. */
export function hhmmToMin(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^(\d{2})(\d{2})$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Date → 'YYYY-MM-DD' (로컬). */
export function dateToYmd(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

/** Date → 0:00 기준 분 (로컬). */
export function dateToMinOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

// ════════════════════════════════════════════════════════════
// 조인 키 추상화 — 미래 안정 ID 전환 시 이 한 함수만 교체
// ════════════════════════════════════════════════════════════

/** 현재: 이름. 미래: appt.doctorId(안정 ID) 우선, 없으면 이름 폴백. */
export function resolveDoctorKey(appt: ApptSource): string {
  return appt.doctorId && appt.doctorId.length > 0 ? appt.doctorId : appt.doctorName
}

// ════════════════════════════════════════════════════════════
// 운영시간 변환
// ════════════════════════════════════════════════════════════

type BreakMin = { start: number, end: number, type: 'LUNCH' | 'DINNER' | 'CLOSED' }

/** 운영시간(open)에서 휴게를 빼 세션들을 도출하고, 점심/저녁 라벨을 붙인다. 기관·담당자 공통. */
function openMinusBreaksToUnitHours(openStart: number, openEnd: number, breaks: BreakMin[]): UnitHours {
  if (openEnd <= openStart) return {}
  const sorted = [...breaks].sort((a, b) => a.start - b.start)

  const sessions: SessionRange[] = []
  let cursor = openStart
  for (const b of sorted) {
    const bs = Math.max(openStart, b.start)
    const be = Math.min(openEnd, b.end)
    if (be <= cursor) continue
    if (bs > cursor) sessions.push({ start: cursor, end: bs })
    cursor = Math.max(cursor, be)
  }
  if (cursor < openEnd) sessions.push({ start: cursor, end: openEnd })

  const h: UnitHours = {}
  const slots: (keyof UnitHours)[] = ['morning', 'afternoon', 'night']
  sessions.slice(0, 3).forEach((s, i) => { h[slots[i]] = s })

  // CLOSED 는 점심/저녁 라벨 대상 아님(=운영종료) → lunch/dinner 에서 제외됨(find by type).
  const lunch = sorted.find(b => b.type === 'LUNCH')
  const dinner = sorted.find(b => b.type === 'DINNER')
  if (lunch) h.lunch = { start: lunch.start, end: lunch.end }
  if (dinner) h.dinner = { start: dinner.start, end: dinner.end }
  return h
}

/** DailySchedule 의 휴게("HH:MM") → 분 단위. 불량 구간은 버린다. */
function breaksToMin(day: DailyScheduleSource | undefined): BreakMin[] {
  return (day?.breaks ?? [])
    .map(b => ({ start: colonHmToMin(b.start), end: colonHmToMin(b.end), type: b.type }))
    .filter((b): b is BreakMin => b.start != null && b.end != null && b.end > b.start)
}

/** 기관 weekly: open 단일범위를 lunch/dinner 휴게로 split → 세션 + 휴게 라벨. */
export function dailyScheduleToUnitHours(day: DailyScheduleSource | undefined): UnitHours {
  if (!day || !day.open) return {}
  const openStart = colonHmToMin(day.open.start)
  const openEnd = colonHmToMin(day.open.end)
  if (openStart == null || openEnd == null) return {}

  return openMinusBreaksToUnitHours(openStart, openEnd, breaksToMin(day))
}

/**
 * 담당자 WorkHoursRow(시작~종료 단일구간) → UnitHours.
 * 담당자는 휴게를 소유하지 않으므로 **같은 요일의 기관 휴게**(institutionDay)를 빼서 세션을 나눈다
 * — 의사 컬럼에도 점심/저녁 음영이 그려진다.
 */
export function workRowToUnitHours(
  row: WorkHoursRowSource | undefined,
  institutionDay?: DailyScheduleSource,
): UnitHours {
  if (!row) return {}
  const openStart = hhmmToMin(row.staffOpenHm)
  const openEnd = hhmmToMin(row.staffCloseHm)
  if (openStart == null || openEnd == null) return {}

  return openMinusBreaksToUnitHours(openStart, openEnd, breaksToMin(institutionDay))
}

// ════════════════════════════════════════════════════════════
// buildRunLayoutInput — store/api → RunLayoutInput
// ════════════════════════════════════════════════════════════

function apptToCard(appt: ApptSource): CardInput {
  const startMin = dateToMinOfDay(appt.startDateTime)
  const endMin = dateToMinOfDay(appt.endDateTime)
  return { id: appt.id, startMin, endMin: Math.max(endMin, startMin + 1) }
}

export function buildRunLayoutInput(params: BuildRunLayoutInputParams): RunLayoutInput {
  const { mode } = params

  let doctors: DoctorInput[]
  let apptsByUnitKey: Record<string, CardInput[]>
  let hoursByDoctor: Record<string, Record<number, UnitHours>> = {}
  const hoursByWeekday: Record<number, UnitHours> = weeklyToHours(params.weekly)

  if (mode.kind === 'name') {
    // ── '전체' = 이름 기반 ──
    doctors = params.doctors.map(d => ({ id: d.id, name: d.text }))
    apptsByUnitKey = groupAppts(params.appts, appt => resolveDoctorKey(appt))
    // 담당자별 요일 운영시간 주입(경계형): 있으면 hoursByDoctor 채움 → 엔진 fallback(담당자 우선 → 기관)
    // 이 켜지고, 미전달(undefined)이면 {} 로 현행(기관 단독 밴드) 바이트 동일.
    hoursByDoctor = params.doctorWeeklyById
      ? mapValues(params.doctorWeeklyById, weeklyToHours)
      : {}
  } else {
    // ── 특정 팀 = 이름 필터 + staffId 컬럼 식별자 ──
    const team = mode.team
    doctors = team.doctors.map(m => ({ id: String(m.staffId), name: m.staffName }))
    // 이름 → 멤버 id 매핑 (이름-브릿지). 동명이인은 첫 멤버로.
    const nameToId = new Map<string, string>()
    for (const m of team.doctors) {
      if (!nameToId.has(m.staffName)) nameToId.set(m.staffName, String(m.staffId))
    }
    // 멤버 이름과 매칭되는 예약만 (미매칭 제외)
    apptsByUnitKey = groupAppts(
      params.appts.filter(a => nameToId.has(a.doctorName)),
      appt => nameToId.get(appt.doctorName)!,
    )
    // 담당자별·요일별 운영시간 (TO-BE). 휴게는 기관(weekly) 것을 얹는다.
    hoursByDoctor = params.workHoursByStaffId
      ? mapValues(params.workHoursByStaffId, rows => weekRowsToWeekdayHours(rows, params.weekly))
      : {}
  }

  return {
    settings: params.settings,
    site: {
      hoursByDoctor,
      hoursByWeekday,
      // 공휴일은 요일 축이 없어 hoursByWeekday 에 섞을 수 없다 — 날짜 목록과 함께 별도로 넘긴다.
      dateHours: mapValues(params.dailyByDate ?? {}, d => dailyScheduleToUnitHours(d)),
      holidayHours: dailyScheduleToUnitHours(params.holiday ?? undefined),
      holidayDates: params.holidayDates ?? [],
      closed: {},
    },
    viewState: params.viewState,
    filter: {},
    env: params.env,
    doctors,
    apptsByUnitKey,
    horizonDays: params.horizonDays,
  }
}

/** 예약을 `${date}__${doctorKey}` 로 그룹핑. */
function groupAppts(appts: ApptSource[], keyOf: (_a: ApptSource) => string): Record<string, CardInput[]> {
  const out: Record<string, CardInput[]> = {}
  for (const a of appts) {
    const unitKey = `${dateToYmd(a.startDateTime)}__${keyOf(a)}`
    if (!out[unitKey]) out[unitKey] = []
    out[unitKey].push(apptToCard(a))
  }
  return out
}

function weeklyToHours(weekly: WeeklySource | undefined): Record<number, UnitHours> {
  const out: Record<number, UnitHours> = {}
  if (!weekly) return out
  for (const k of Object.keys(weekly)) {
    const wd = Number(k)
    out[wd] = dailyScheduleToUnitHours(weekly[wd])
  }
  return out
}

/** 담당자 운영시간 rows(요일별) → weekday(0~6) → UnitHours. 휴게는 같은 요일의 기관 값을 쓴다. */
function weekRowsToWeekdayHours(
  rows: WorkHoursRowSource[],
  weekly: WeeklySource | undefined,
): Record<number, UnitHours> {
  const out: Record<number, UnitHours> = {}
  for (const r of rows) out[r.dayCd] = workRowToUnitHours(r, weekly?.[r.dayCd])
  return out
}

function mapValues<T, U>(obj: Record<string, T>, fn: (_v: T) => U): Record<string, U> {
  const out: Record<string, U> = {}
  for (const k of Object.keys(obj)) out[k] = fn(obj[k])
  return out
}

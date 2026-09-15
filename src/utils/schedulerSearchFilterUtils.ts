import dayjs from 'dayjs';
import {
    APPOINTMENT_STATUS_TYPE,
    AppointmentStatusType,
    TREATMENT_STATUS_TYPE,
    TreatmentStatusType,
    DataType,
    MemberType,
    ViewMode,
} from '@/constants/schedulerSearchFilter';

// DataType -> API type
const DATA_TYPE_TO_API: Record<DataType, string> = {
    APPOINTMENT: 'reservation',
    TREATMENT: 'treatment',
};

// ViewMode -> API dateType
const VIEW_MODE_TO_API: Record<ViewMode, string> = {
    WEEK: 'weekly',
    DAY: 'daily',
};

// MemberType -> API isMember
const MEMBER_TYPE_TO_API: Record<MemberType, boolean> = {
    Y: true,
    N: false,
};

// Status -> API code (예약 + 진료 필터 키 모두 포함)
const STATUS_TO_API: Record<AppointmentStatusType | TreatmentStatusType, string> = {
    APPOINTMENT: '00',
    CANCEL: '03',
    WAITING: '05',
    COMPLETE: '01',
    UNDONE: '02',
};

/**
 * 스케줄러의 시작일을 ViewMode 에 따라 Api Parameter startDate, endDate로 변경
 * @param periodDate
 * @param viewMode
 */
export function toPeriodRange(periodDate: Date, viewMode: ViewMode) {
    const base = dayjs(periodDate);

    if (viewMode === 'WEEK') {
        const start = base.startOf('week').startOf('day');
        return {startDate: start.toDate(), endDate: start.add(6, 'day').toDate()};
    }

    const start = base.startOf('day');
    return {startDate: start.toDate(), endDate: start.toDate()};
}

/**
 * 스케줄러의 DataType value 를 Api Parameter type value 로 변경
 * @param dataType
 */
export function toType(dataType: DataType) {
    return DATA_TYPE_TO_API[dataType];
}

/**
 * 스케줄러의 viewMode value 를 Api Parameter  dateType value 로 변경
 * @param viewMode
 */
export function toDateType(viewMode: ViewMode) {
    return VIEW_MODE_TO_API[viewMode];
}

/**
 * 스케줄러의 memberType value 를 Api Parameter isMember value 로 변경
 * @param memberType
 */
export function toIsMember(memberType: MemberType) {
    return MEMBER_TYPE_TO_API[memberType];
}

/**
 * 스케줄러의 appointmentStatusType value 를 Api Parameter status value 로 변경
 * @param appointmentStatusType
 */
/** 상태 필터 키 → 상태 코드 목록. 빈 배열 = 전체(거르지 않음). */
export function toStatusCodes(statusKeys: (AppointmentStatusType | TreatmentStatusType)[]): string[] {
    const uniq = Array.from(new Set(statusKeys));
    return uniq.map(s => STATUS_TO_API[s]).filter(Boolean);
}

/**
 * 표시 상태 코드 → 그 장부의 상태 칩 라벨('예약'·'취소'·'접수대기'…). 칩이 없는 코드는 null.
 * 화면 통계가 카드를 칩별로 세는 키 — 칩 라벨과 통계 키가 같은 상수(APPOINTMENT/TREATMENT_STATUS_TYPE)에서 나온다.
 */
export function toStatusLabel(displayStatus: string, dataType: DataType): string | null {
    const labels: Record<string, string> = dataType === 'TREATMENT' ? TREATMENT_STATUS_TYPE : APPOINTMENT_STATUS_TYPE;
    const key = (Object.keys(labels) as (AppointmentStatusType | TreatmentStatusType)[])
        .find(k => STATUS_TO_API[k] === displayStatus);
    return key ? labels[key] : null;
}

/** 예약 화면이 상태로 구분해 보여주는 코드. 그 외(진료완료·미이행·접수대기)는 예약(00)처럼 그린다. */
const APPOINTMENT_DISPLAY_STATUSES = new Set(['00', '03']);

/**
 * 화면에 표시할 상태 코드.
 * 예약 화면(APPOINTMENT)은 예약(00)·취소(03)만 색/라벨로 구분하고, 나머지 상태는 예약(00)으로 표기한다.
 * 진료 화면(TREATMENT)은 실제 상태를 그대로 쓴다. 데이터(실제 status)는 바꾸지 않는다 — 표시 전용.
 */
export function toDisplayStatus(status: string | undefined, dataType: DataType): string {
    const s = status ?? '';
    if (dataType === 'APPOINTMENT' && !APPOINTMENT_DISPLAY_STATUSES.has(s)) {
        return '00';
    }
    return s;
}

export function toStatusClassName(status: string) {
    switch (status) {
        case '01':
            return 'is-done';
        case '02':
            return 'is-undone';
        case '03':
            return 'is-cancel';
        case '05':
            return 'is-receipt';
        default:
            return 'is-waiting';
    }
}

export function datePickerYearRange(start: number, end: number) {
    const y = dayjs().year();
    return [y - start, y + end];
}

/** 진료 팀 표시 필터용 의사 소스 (식별자 d.id = 이름). */
export interface VisibleDoctorSource {
    id: string;
    text: string;
}
interface TeamSource {
    name: string;
    doctors: { staffName: string }[];
}

/**
 * 의사 이름 키 정규화 — 특수문자·숫자 제거(staffStore replaceDoctorName 과 동일) + 공백 압축 + trim.
 * 의사 id(담당자명 정규화)와 팀멤버 staffName(raw)을 같은 기준으로 비교하기 위함.
 * ⚠️ 숫자가 제거되므로 팀명 비교에는 쓰면 안 된다('1담당 팀'/'2담당 팀'이 '담당 팀'으로 충돌). → normalizeTeamName 사용.
 */
export function normalizeName(s: string | null | undefined): string {
    return (s ?? '').replace(/[^가-힣a-zA-Z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 팀명 키 정규화 — 공백 압축 + trim 만(숫자·문자 보존).
 * 팀명은 숫자로만 구분되는 경우('1담당 팀'/'2담당 팀')가 흔해 의사용 normalizeName(숫자 제거)을 쓰면
 * 서로 다른 팀이 같은 키로 붕괴 → 첫 팀만 매칭되는 버그. 팀명은 셀렉트 옵션값(t.name)과 동일 출처라 보존 비교.
 */
export function normalizeTeamName(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 진료 팀 표시 필터 (이름 키 통일 — 팀 = 표시 오버레이, 데이터 KEY 아님).
 * 팀 id 도 저장마다 재발급(deactivate+insert)되어 불안정 → 팀명을 안정 키로 사용.
 * - teamName=null/''(미지정) → 담당자 − 모든 팀멤버 이름 (담당자 기본 순서 유지)
 * - teamName=특정팀 → 그 팀멤버를 **팀 설정 순서(SORT_ORD)** 대로 반환
 *     (team.doctors 는 BE 가 ORDER BY SORT_ORD 로 내려줌 → 검색필터·예약팝업·보드 헤더가 동일 순서).
 *     ⚠️ 담당자 배열 순서가 아니라 team.doctors 순서를 따라야 "담당자 순서 변경"이 화면에 반영됨.
 * 팀명은 normalizeTeamName(숫자 보존), 의사 이름은 normalizeName(숫자 제거)으로 매칭. 팀 변경은 예약 데이터에 무영향.
 */
export function resolveVisibleDoctors<T extends VisibleDoctorSource>(
    teamName: string | null,
    doctors: T[],
    teams: TeamSource[],
): T[] {
    if (teamName != null && teamName !== '') {
        const target = normalizeTeamName(teamName);
        const team = teams.find(t => normalizeTeamName(t.name) === target);
        // 팀멤버 SORT_ORD 순서(team.doctors) 대로 담당자 객체를 매핑. 담당자 목록에 없는 멤버는 제외.
        const byKey = new Map(doctors.map(d => [normalizeName(d.id), d]));
        return (team?.doctors ?? [])
            .map(d => byKey.get(normalizeName(d.staffName)))
            .filter((d): d is T => !!d);
    }
    // t.doctors 널가드(line 134 와 대칭) — BE 팀 응답에 doctors 누락 팀(빈 팀/재등록 과도기) 유입 대비.
    const teamMemberNames = new Set(teams.flatMap(t => (t.doctors ?? []).map(d => normalizeName(d.staffName))));
    return doctors.filter(d => !teamMemberNames.has(normalizeName(d.id)));
}

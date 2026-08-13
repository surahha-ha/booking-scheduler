// ============================================================================
// 운영일정 설정 API
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';

const baseUrl = '/api/booking/v2/schedule';
const api = useApi();

export type ApiResponse<T> = {
    code: string;
    message?: string;
    status?: string;
    payload?: T;
};

export type RecurringOffRule = {
    dayCd: number;                      // 0(일) ~ 6(토)
    repeatTy: 'WEEKLY' | 'MONTHLY';
    monthlyNth: number | null;           // WEEKLY=null, MONTHLY=1~5
};

export type Team = {
    id: number;
    name: string;
    doctorIds: number[];                // staffId 배열
};

/* 운영일정 보기 — 팀/소속 담당자 조회 응답 (구성원은 staffId/staffName 그대로 노출) */
export type DoctorTeamMember = {
    staffId: number;
    staffName: string;
};

export type DoctorTeam = {
    id: number;
    name: string;
    doctors: DoctorTeamMember[];
};

/* 운영시간 — 담당자 1명의 요일 1행 (staff 조회 응답 & save 요청 본문 공용 항목).
 * ★행이 있다는 것 자체가 "그 요일을 정했다"는 뜻이다. 요청·응답 모두 7개 요일을 채우지 않는다:
 *   행 없음 = 미설정 (아직 정하지 않음 → 사업장 운영시간을 따른다)
 *   행 + 시작·종료  = 진료
 *   행 + null      = 휴무 (명시적으로 쉬기로 정함)
 * 7행으로 채우면 앞의 두 상태가 같은 모양이 되어 "안 정한 요일"이 "휴무"으로 굳는다.
 * WorkHoursOverride(일자 지정)가 쓰던 규약과 같다. */
export type WorkHoursRow = {
    dayCd: number;                      // 0=일 ~ 6=토
    staffOpenHm: string | null;      // "HHmm" (예 "0900"), 휴무가면 null
    staffCloseHm: string | null;
};

/* 특정 날짜 × 특정 담당자 지정 — weekly 반복을 덮어쓰는 단일 날짜 설정.
 * 시작/종료 null → 그 날짜만 휴무 (정상 case) */
export type WorkHoursOverride = {
    staffId: number;
    date: string;                       // "YYYY-MM-DD"
    overrideOpenHm: string | null;
    overrideCloseHm: string | null;
};

/* 사업장(site) 운영시간 — 요일 1행. 조회 응답과 저장 요청에 함께 쓴다.
 * 원천은 사업장 설정. 진료 시작~종료 단일 구간 안에서 휴게(점심·저녁)를 비운다.
 * 진료하지 않는 요일은 시작/종료 시분이 null 이며, 저장 시엔 recurringOffRules 로 휴무를 표현한다.
 * ⚠️ site(사업장, 사업장 설정 원천)와 staff(담당자, 자체DB)는 한 글자 차이다 — 혼동 금지. */
export type SiteDayHours = {
    dayCd: number;                      // 0=일 ~ 6=토
    openHm: string | null;
    closeHm: string | null;
    lunchStartHm: string | null;
    lunchEndHm: string | null;
    dinnerStartHm: string | null;
    dinnerEndHm: string | null;
};

/* 사업장(site) 공휴일 운영시간 — 사업장당 한 세트. 요일 축이 없어 모든 공휴일에 공통 적용된다.
 * 원천은 사업장 설정 공휴일 운영시간 테이블.
 * ⚠️ 공휴일에 쉬는지는 여기가 아니라 holidayClosedYn 이 갖는다 — 이 타입은 "진료한다면 몇 시부터"만 담는다.
 * 휴무로 바꿔도 값은 보존된다(다시 진료로 되돌렸을 때 살아 있어야 한다). */
export type SiteHolidayHours = {
    openHm: string | null;
    closeHm: string | null;
    lunchStartHm: string | null;
    lunchEndHm: string | null;
    dinnerStartHm: string | null;
    dinnerEndHm: string | null;
};

/* 사업장(site) 운영시간 + 운영일정 규칙 strict 번들 — 설정 화면 편집 baseline.
 * GET /book/v2/site/work-hours/site. 원천은 사업장 설정.
 * 운영시간(site)과 휴무 규칙을 한 응답으로 strict 하게 내려, FE 는 이 조회 성공을 저장 게이트로 삼는다
 * — 조회 실패(ApiResponse.code=failed) 시 저장을 차단한다(전체 치환 저장이 사업장 데이터를 통삭제하지 않게).
 * 미설정 거래처는 code=succeed + site=[] + 빈 규칙(장애와 명확히 구분). */
export type SiteWorkHoursResponse = {
    site: SiteDayHours[];                // 진료하는 요일 행만. 휴무 요일은 recurringOffRules 로 표현된다.
    holidayHours: SiteHolidayHours | null;      // 공휴일 운영시간. null = 미설정(공휴일 휴무와 다르다)
    dateTimes: SiteDateHours[];          // 지정일자의 그 날짜 운영시간 (workDates/offDates 는 날짜만 담는다)
    recurringOffRules: RecurringOffRule[];
    workDates: string[];                // "YYYY-MM-DD"
    offDates: string[];                 // "YYYY-MM-DD"
    holidayClosedYn: boolean;                    // 공휴일포함여부
};

/* 사업장 **일자별** 운영시간 — 지정일자(임시휴무/임시진료)의 그 날짜 시간. 원천은 사업장 설정.
 * ⚠️ 조회 전용이다. 저장 payload 에는 없다 — 이 앱에 일자별 시간 편집 UI 가 없고, 임시진료 지정일의
 *    시간은 BE 가 저장 시점에 채운다(그 요일 기관 운영시간 → 없으면 09:00~18:00).
 * 이 값이 없으면 FE 는 지정일을 "종일 열림"으로 추정할 수밖에 없어, 저장된 시간 밖 예약을 받아
 * 사업장 설정·운영중 표시와 갈린다. */
export type SiteDateHours = {
    date: string;                       // "YYYY-MM-DD"
    closed: boolean;                    // true = 임시휴무 (이때 시간은 의미 없음)
    openHm: string | null;
    closeHm: string | null;
    lunchStartHm: string | null;
    lunchEndHm: string | null;
    dinnerStartHm: string | null;
    dinnerEndHm: string | null;
};

/* 담당자(staff) 운영시간 + 일자 오버라이드 — GET /book/v2/site/work-hours/staff (자체 TB).
 * 사업장(site)은 별도 조회로 분리됐다(원천 사업장 설정, institution 안 섞임). */
export type StaffWorkHoursResponse = {
    staff: Array<{
        staffId: number;
        staffName: string;
        times: WorkHoursRow[];           // 정해진 요일 행만. 빈 배열 = 한 번도 정하지 않음(미설정)
    }>;
    overrides: WorkHoursOverride[];
};

export type WorkingHoursPayload = {
    /* 사업장 운영시간(site)은 여기 없다 — TreatmentSettingsPayload.site 로 함께 저장한다 */
    staff: Array<{
        staffId: number;
        /* 정한 요일 행만 보낸다. 빈 배열 = 미설정 유지(그 담당자의 행을 남기지 않는다).
         * 전체 치환이므로 여기 없는 요일은 저장 후 미설정이 된다. */
        times: WorkHoursRow[];
    }>;
    /* 캘린더 셀에서 직원별로 편집한 날짜 override 들 — weekly 보다 우선 */
    overrides: WorkHoursOverride[];
};

/* 조회 응답 — 서버는 항상 전체를 채워 내려준다. */
export type TreatmentSettingsPayload = {
    /* 사업장(site) 요일별 운영시간 — 진료하는 요일 행만. 원천은 사업장 설정이며,
     * BE 어댑터가 이 번들 1콜로 전체 치환 저장한다. 휴무 요일은 여기 넣지 말고 recurringOffRules 로. */
    site: SiteDayHours[];
    /* 공휴일 운영시간 — 요일별과 같이 전체 치환. null(미전송)이면 BE 가 baseline 을 보존하고,
     * 전 필드가 null 인 객체를 보내면 삭제된다(빈 목록으로 나간다). */
    holidayHours: SiteHolidayHours | null;
    recurringOffRules: RecurringOffRule[];
    workDates: string[];                // "YYYY-MM-DD"
    offDates: string[];                 // "YYYY-MM-DD"
    holidayClosedYn: boolean;                 // 공휴일포함여부(boolean — BE 가 Y/N 변환)
    teams: Team[];
    workingHours: WorkingHoursPayload;
};

/**
 * 저장 요청 — 원천별로 **파트 단위 전송**이다. 조회 타입과 달리 각 파트가 optional 이다.
 *
 * 필드를 생략(undefined)하면 BE 가 그 파트를 아예 실행하지 않는다(skipped).
 * 해당 원천의 조회에 실패해 baseline 을 못 읽었을 때 쓰는 경로다 —
 * 못 읽은 상태로 보내면 전체 치환이라 그 데이터가 통삭제된다.
 *
 * **빈 배열([])은 생략이 아니라 "전부 삭제"라는 정상 의도다.** undefined 와 반드시 구분할 것.
 *
 * 파트 묶음(함께 보내거나 함께 생략):
 *  - 사업장 파트 : site + recurringOffRules + workDates + offDates + holidayClosedYn
 *  - 자체 파트 : teams (+ workingHours — 팀 없이는 저장 불가. BE 가 요청 teams 로 대상 담당자를 거른다)
 */
export type TreatmentSettingsSavePayload = Partial<TreatmentSettingsPayload>;

/** 저장 파트별 결과. skipped = 전송하지 않아 실행되지 않음. */
export type SiteSavePartResult = 'succeed' | 'failed' | 'skipped';

/** 저장 응답 payload — 어느 원천이 실제로 저장됐는지. code=succeed 여도 skipped 가 섞일 수 있다. */
export type TreatmentSettingsSaveResult = {
    staff: SiteSavePartResult;
    site: SiteSavePartResult;
    /* 어느 파트가 저장/생략됐는지 서술한 문구 — 진단·로깅용.
     * 사용자에게 보이는 message 는 파트와 무관하게 "저장되었습니다." 로 통일돼 있다. */
    detail: string;
};

/**
 * 운영일정 보기 — 팀/소속 담당자 조회
 */
export function getTeams() {
    return api.get<ApiResponse<{ teams: DoctorTeam[] }>>(
        `${baseUrl}/teams`,
        withCredentialsUtils()
    );
}

/**
 * 사업장(site) 운영시간 + 운영일정 규칙 strict 조회 — 편집 baseline & 저장 게이트.
 *  - 원천은 사업장 설정. code=failed 면 저장을 차단해야 한다(전체 치환이 사업장 설정을 덮어쓰지 않게).
 *  - 미설정 거래처: code=succeed + site=[] + 빈 규칙.
 */
export function getSiteWorkHours() {
    return api.get<ApiResponse<SiteWorkHoursResponse>>(
        `${baseUrl}/work-hours/site`,
        withCredentialsUtils()
    );
}

/**
 * 담당자(staff) 운영시간 + 일자 오버라이드 조회 (자체 TB). institution 안 섞임.
 */
export function getStaffWorkHours() {
    return api.get<ApiResponse<StaffWorkHoursResponse>>(
        `${baseUrl}/work-hours/staff`,
        withCredentialsUtils()
    );
}

/**
 * 운영일정 설정 조회
 */
export function getTreatmentSettings() {
    return api.get<ApiResponse<TreatmentSettingsPayload>>(
        `${baseUrl}/settings`,
        withCredentialsUtils()
    );
}

/**
 * 운영일정 설정 저장 — 파트 단위. 생략한 파트는 BE 가 건드리지 않는다.
 * 응답 payload 의 {staff, site} 로 실제 저장된 파트를 확인할 것 (code 만 보면 skipped 를 놓친다).
 */
export function saveTreatmentSettings(payload: TreatmentSettingsSavePayload) {
    return api.post<ApiResponse<TreatmentSettingsSaveResult>>(
        `${baseUrl}/settings/save`,
        payload,
        withCredentialsUtils()
    );
}

/* 담당자 순서 변경 팝업 전용 요청 — 팀 내 구성원 정렬순서만 갱신한다.
 * orderedStaffIds = 표시 순서대로 나열한 STAFF_ID 배열. 배열 index 가 정렬순서(SORT_ORD)가 된다.
 * settings/save 와 달리 팀·담당자 운영시간·사업장(사업장 설정)을 건드리지 않아 passthrough 가 필요 없다. */
export type TeamMemberOrderPayload = {
    teams: Array<{
        teamId: number;
        orderedStaffIds: number[];       // 표시 순서대로 나열한 staffId
    }>;
};

/**
 * 담당자 순서 변경 팝업 전용 저장 — 팀 구성원 정렬순서(SORT_ORD)만 UPDATE.
 * 팀/운영시간/사업장 무관·전체 치환 아님. 응답은 code('succeed'|'failed') + message.
 */
export function reorderTeamMembers(payload: TeamMemberOrderPayload) {
    return api.post<ApiResponse<void>>(
        `${baseUrl}/teams/member-order`,
        payload,
        withCredentialsUtils()
    );
}

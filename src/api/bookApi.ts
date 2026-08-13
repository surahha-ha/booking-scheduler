// ============================================================================
// 약속장부 API
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';
import {httpBuildPathUtils} from '@/utils/httpBuildPathUtils';

// 공통 설정
const baseUrl = '/api/booking';
const api = useApi();

// 응답 타입
export type BookItem = {
    reservationId: number;
    tenantId: string;
    statusCode: string;
    startAt: string; // "2026-01-19T12:00:00"
    endAt: string;
    externalStaffNo: number;
    staffName: string;
    customerId: number;
    memberYn: string;
    memberNo?: number;
    customerPhone: string;
    customerName: string;
    delYn: 'Y' | 'N';
    memo: string;
    /** 서비스 항목 그룹 ID (직접입력 그룹은 항상 존재) */
    serviceGroupId?: number;
    /** 서비스 항목 ID (직접입력 그룹은 NULL) */
    serviceItemId?: number;
    /** 통합회원 생년월일 (memberYn=Y만, 비회원 null) — 'yyyy-MM-dd' */
    birthDate?: string | null;
    /** 통합회원 성별코드 (memberYn=Y만, 비회원 null) — M/F/U */
    sexDivisionCode?: string | null;
    /** 서비스 항목 그룹명 (BE LEFT JOIN, 미지정 null) */
    serviceGroupName?: string | null;
    /** 서비스 항목명 (BE LEFT JOIN, 미지정 null) */
    serviceItemName?: string | null;
    /** 예약 등록일시 — '당일'(오늘 등록) 뱃지 판정 */
    createdAt?: string;
    updatedAt?: string;
    updatedBy?: number;
    /** 외부 시스템 연동 여부 — 'Y'이면 외부 매핑 존재 */
    externalYn?: 'Y' | 'N';
};

export type BookDayGroupResponse = {
    dayCd: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
    dayNm: string;
    items?: BookItem[];
};

export type BookItemRequest = {
    memberNo?: number;
    startDate: string; // "2026-01-19T12:00:00"
    endDate: string; // "2026-01-19T12:00:00",
    externalStaffNo: number;
    doctorName: string;
    patientName: string;
    patientPhone: string;
    customerRefId: string;
    memo?: string;
    state?: string;
    /** 예약/진료 구분 ('reservation' | 'treatment') */
    type?: string;
    /** 서비스 항목 그룹 ID. null/undefined 시 BE 에서 직접입력 그룹으로 자동 매핑 */
    serviceGroupId?: number | null;
    /** 서비스 항목 ID. 직접입력 그룹 선택 시 null */
    serviceItemId?: number | null;
};

/** 검색 드롭다운용 — 전 기간 최근 N건 항목 */
export type BookRecentItem = {
    reservationId: number;
    statusCode: string;
    startAt: string; // "2026-01-19T12:00:00"
    endAt: string;
    staffName: string;
    customerName: string;
    customerPhone: string;
    memberYn: string;
    /** 회원정보 보강 — 통합회원만, 실패/비회원은 null */
    birthDate?: string | null;
    sexDivisionCode?: string | null;
};

export type MemberStatisticsResponse = {
    memberYn: string;
    cnt: number;
}

export type StateStatisticsResponse = {
    name: string;
    cnt: number;
}

export type ApiResponse<T> = {
    code: string; // succeed, failed
    message: string;
    status: string;
    payload: T;
};

/**
 * 국가 공휴일 1건 (병원 휴무일과 별개 — 빨간날 표시용).
 * 원천이 사업장 설정(/api/booking/v1/holidays)로 바뀌며 공휴일명은 사라졌다 — 사업장 설정은 날짜만 내려준다.
 */
export type HolidayItem = {
    date: string; // "2026-01-01"
};

/**
 * 장부 > 국가 공휴일 조회 (연도 단위)
 * 기관별 휴무일(staffApi.getHoliday)과 별개. 전역·읽기전용 표시용.
 */
export function getHolidays(year: number) {
    return api.get<ApiResponse<HolidayItem[]>>(`${baseUrl}/v1/holidays`, withCredentialsUtils({
        params: {year}
    }));
}

/**
 * 장부 > 조회
 * @param param
 */
export function get(params?: Record<string, any>) {
    return api.get<ApiResponse<BookDayGroupResponse[]>>(`${baseUrl}`, withCredentialsUtils({
        params
    }));
}

/**
 * 장부 > 최근 예약 검색 (검색 드롭다운)
 * 고객명/전화번호 keyword → 전 기간 최근 N건 내림차순.
 */
export function getRecent(params: { keyword: string; limit?: number; offset?: number; type?: string }) {
    return api.get<ApiResponse<BookRecentItem[]>>(`${baseUrl}/recent`, withCredentialsUtils({
        params
    }));
}

/**
 * 장부 > 추가
 * @param params
 */
export function add(params?: BookItemRequest) {
    return api.post<ApiResponse<any>>(`${baseUrl}/add`, params, withCredentialsUtils());
}

/**
 * 장부 > 수정
 * @param id
 * @param body
 */
export function modify(id: string, body?: BookItemRequest) {
    const path = httpBuildPathUtils('/:id', {id});
    const url = `${baseUrl}/modify${path}`;
    return api.put<ApiResponse<any>>(
        url,
        body,
        withCredentialsUtils()
    );
}

/**
 * 장부 > 삭제
 * @param id
 * @param type 화면 구분(reservation|treatment). 미전달 시 BE 가 기존 예약/진료 구분값을 유지한다.
 */
export function remove(id: string, type?: string) {
    const path = httpBuildPathUtils('/:id', {id});
    const url = `${baseUrl}${path}/delete`;
    return api.delete<ApiResponse<any>>(url, withCredentialsUtils(type ? {params: {type}} : undefined));
}

/**
 * 장부 > 회원 통계 조회
 */
export function getMemberStatistics(params?: Record<string, any>) {
    return api.get<ApiResponse<MemberStatisticsResponse>>(`${baseUrl}/statistics/member`, withCredentialsUtils({
        params
    }));
}

/**
 * 장부 > 상태 통계 조회
 */
export function getStateStatistics(params?: Record<string, any>) {
    return api.get<ApiResponse<StateStatisticsResponse>>(`${baseUrl}/statistics/state`, withCredentialsUtils({
        params
    }));
}

export type UnassignedReservationsResponse = {
    /** 미지정 예약/진료건 일괄 지정 가능 여부 */
    assignable: boolean;
};

/**
 * 장부 > 미지정 예약/진료건 지정 가능 여부 조회
 * 미지정 데이터 설정 버튼 노출 여부 판단에 사용한다.
 */
export function getUnassignedReservations() {
    return api.get<ApiResponse<UnassignedReservationsResponse>>(
        `${baseUrl}/v2/schedule/unassigned-reservations`,
        withCredentialsUtils()
    );
}

export type AssignUnassignedResponse = {
    /** 지정 처리된 건수 */
    updated: number;
};

/**
 * 장부 > 미지정 예약/진료건 일괄 지정
 * 담당자가 미지정된 예약/진료건을 선택한 담당자(staffId)으로 일괄 지정한다.
 * @param staffId 지정할 담당자 staff_id
 */
export function assignUnassigned(staffId: number) {
    return api.post<ApiResponse<AssignUnassignedResponse>>(
        `${baseUrl}/v2/schedule/assign-unassigned`,
        {staffId},
        withCredentialsUtils()
    );
}

/**
 * 장부 > 상태 변경
 * @param id
 * @param state
 * @param type 화면 구분(reservation|treatment). 미전달 시 BE 가 기존 예약/진료 구분값을 유지한다.
 */
export function updateStatus(id: string, state: string, type?: string) {
    const path = httpBuildPathUtils('/:id/:state', {id, state});
    const url = `${baseUrl}${path}`;
    return api.put<ApiResponse<any>>(
        url,
        undefined,
        withCredentialsUtils(type ? {params: {type}} : undefined)
    );
}

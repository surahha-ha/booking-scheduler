// ============================================================================
// 통합회원 API
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';

// 공통 설정
const baseUrl = '/api/booking/v1/staff';
const api = useApi();

// 응답 타입
export type DoctorItem = {
    externalStaffName: string;
    externalStaffNo: number;
}

export type DoctorPayload = {
    staffId: number;
    staffName: string;
    openYn: 'Y' | 'N';
}

/* 운영시간(사업장 site · 담당자 staff) 계약은 siteApi.ts 로 이관됐다.
 * - 조회: getSiteWorkHours / getStaffWorkHours (GET /book/v2/site/work-hours/{site,staff})
 * - 저장: saveTreatmentSettings (POST /book/v2/site/settings/save, site 필드 포함 번들 1콜)
 * 기존 이전 통합 조회 엔드포인트 은 삭제됐다. */

export type ApiResponse<T> = {
    code: string;
    message?: string;
    status?: string;
    payload?: T;
};

/**
 * 담당자 조회
 */
export function getDoctors() {
    return api.get<ApiResponse<DoctorPayload[]>>(`${baseUrl}`, withCredentialsUtils());
}

/**
 * 담당자 추가
 * @param params
 */
export function addDoctors(params?: string) {
    return api.post<ApiResponse<any>>(`${baseUrl}/add`, params, withCredentialsUtils({
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
        }
    }));
}

/**
 * 담당자 동기화 (외부 시스템 → 담당자 마스터 갱신)
 */
export function syncDoctors() {
    return api.post<ApiResponse<null>>(`${baseUrl}/sync`, null, withCredentialsUtils());
}

/**
 * 운영시간 > 의사별 조회
 */
export function getDoctorSchedule() {
    return null;
}

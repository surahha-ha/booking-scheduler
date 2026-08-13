// ============================================================================
// 고객 API
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';

// 공통 설정
const baseUrl = '/api/booking/v1/customers';
const api = useApi();

export type CustomerRecord = {
    memberYn?: boolean;
    customerId: string;
    customerName: string;
    customerPhone: string;
}

// 응답 타입
export type PatientItem = {
    name: string;
    phone?: string;
};

export type ApiResponse<T> = {
    code: string;
    message: string;
    status: string;
    payload: T;
};

/**
 * 고객 조회
 */
export function get(params?: Record<string, any>) {
    return api.get<ApiResponse<CustomerRecord>>(`${baseUrl}`, withCredentialsUtils({
        params
    }));
}

/**
 * 고객 추가
 */
export function add(params?: PatientItem) {
    return api.post<ApiResponse<any>>(`${baseUrl}/add`, params, withCredentialsUtils());
}

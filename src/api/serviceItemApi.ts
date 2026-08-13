// ============================================================================
// 서비스 항목 마스터 API (그룹 + 항목)
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';
import {httpBuildPathUtils} from '@/utils/httpBuildPathUtils';

import type {ApiResponse} from './bookApi';

const baseUrl = '/api/booking/service-items';
const api = useApi();

// ---------- 응답 타입 ----------

export type ServiceItem = {
    serviceItemId: number;
    serviceGroupId: number;
    serviceItemName: string;
    sortOrd?: number;
    useYn?: 'Y' | 'N';
};

export type ServiceGroupTree = {
    serviceGroupId: number;
    serviceGroupName: string;
    sortOrd?: number;
    items: ServiceItem[];
};

// ---------- 요청 타입 ----------

export type ServiceGroupCreateRequest = {
    serviceGroupName: string;
    sortOrd?: number;
};

export type ServiceGroupUpdateRequest = {
    serviceGroupName: string;
    sortOrd?: number;
};

export type ServiceItemCreateRequest = {
    serviceGroupId: number;
    serviceItemName: string;
    sortOrd?: number;
};

export type ServiceItemUpdateRequest = {
    serviceItemName: string;
    sortOrd?: number;
};

// ---------- 그룹 ----------

export function getGroups() {
    return api.get<ApiResponse<ServiceGroupTree[]>>(`${baseUrl}/groups`, withCredentialsUtils());
}

export function addGroup(body: ServiceGroupCreateRequest) {
    return api.post<ApiResponse<ServiceGroupTree>>(`${baseUrl}/groups`, body, withCredentialsUtils());
}

export function modifyGroup(id: number, body: ServiceGroupUpdateRequest) {
    const path = httpBuildPathUtils('/:id', {id: String(id)});
    return api.put<ApiResponse<any>>(`${baseUrl}/groups${path}`, body, withCredentialsUtils());
}

export function removeGroup(id: number) {
    const path = httpBuildPathUtils('/:id', {id: String(id)});
    return api.delete<ApiResponse<any>>(`${baseUrl}/groups${path}`, withCredentialsUtils());
}

// ---------- 항목 ----------

export function addItem(body: ServiceItemCreateRequest) {
    return api.post<ApiResponse<ServiceItem>>(`${baseUrl}/items`, body, withCredentialsUtils());
}

export function modifyItem(id: number, body: ServiceItemUpdateRequest) {
    const path = httpBuildPathUtils('/:id', {id: String(id)});
    return api.put<ApiResponse<any>>(`${baseUrl}/items${path}`, body, withCredentialsUtils());
}

export function removeItem(id: number) {
    const path = httpBuildPathUtils('/:id', {id: String(id)});
    return api.delete<ApiResponse<any>>(`${baseUrl}/items${path}`, withCredentialsUtils());
}

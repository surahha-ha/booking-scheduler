import {defineStore} from 'pinia';
import {ref} from 'vue';
import {add, type ApiResponse, type CustomerRecord, get} from '@/api/customerApi';

// 고객 store
export type Patient = {
    memberYn?: string;
    customerRefId: number;
    patientName: string;
    patientPhone: string;
}

export const useCustomerStore = defineStore('customerStore', () => {
    const patients = ref<Patient[]>([]);

    function unwrapBody<T>(res: any): ApiResponse<T> {
        return (res as any).data ?? res;
    }

    function mapCustomerRecord(it: CustomerRecord): Patient {
        return {
            memberYn: it.memberYn === true ? 'Y' : 'N',
            customerRefId: Number(it.customerId),
            patientName: it.customerName,
            patientPhone: it.customerPhone,
        };
    }

    // 고객 조회 및 매핑
    async function loadCustomer(
        params: Record<string, any> = {keyword: '', type: 'name'}
    ) {
        try {
            const res = await get(params);
            const body: ApiResponse<CustomerRecord[]> = unwrapBody<CustomerRecord[]>(res);

            const payload = Array.isArray(body?.payload) ? body.payload : [];
            patients.value = payload.map(mapCustomerRecord);
            return body;
        } catch (e) {
            console.error('[고객 > 조회] 실패', e);
            patients.value = [];
        }
    }

    async function addCustomer(params: CustomerRecord): Promise<Patient | null> {
        if (!params) return null;
        try {
            const res = await add(params);
            const body: ApiResponse<CustomerRecord> = unwrapBody<CustomerRecord>(res);
            console.log('[고객 > 추가] 성공', body);
            const data = body?.payload;
            if (!data) return null;
            return mapCustomerRecord(data);
        } catch (e) {
            console.error('[고객 > 추가] 실패', e);
            return null;
        }
    }

    return {
        patients,
        loadCustomer,
        addCustomer
    };
});

// ============================================================================
// 서비스 항목 마스터 store (그룹 + 항목)
// ----------------------------------------------------------------------------
// 의원별 서비스 항목 그룹/항목 마스터의 캐시.
// ReservationPopup 진입 시 또는 서비스 항목 설정 팝업에서 변경 발생 후 재조회.
// ============================================================================
import {defineStore} from 'pinia';
import {computed, ref} from 'vue';
import {
    addGroup as apiAddGroup,
    addItem as apiAddItem,
    getGroups as apiGetGroups,
    modifyGroup as apiModifyGroup,
    modifyItem as apiModifyItem,
    removeGroup as apiRemoveGroup,
    removeItem as apiRemoveItem,
    type ServiceGroupCreateRequest,
    type ServiceGroupTree,
    type ServiceGroupUpdateRequest,
    type ServiceItemCreateRequest,
    type ServiceItemUpdateRequest,
} from '@/api/serviceItemApi';

export const useServiceItemStore = defineStore('serviceItemStore', () => {
    const groups = ref<ServiceGroupTree[]>([]);
    const loaded = ref(false);
    const loading = ref(false);

    /** 사용자 그룹 전체. (직접입력 그룹 개념 제거 — 전부 일반 그룹) */
    const userGroups = computed<ServiceGroupTree[]>(() => groups.value);

    // 진행 중인 조회. 동시 호출자는 이 약속을 함께 기다린다.
    //  - 예약 팝업(TreatmentContentSelector)과 설정 팝업이 거의 동시에 load 를 부르는데,
    //    "로딩 중이면 즉시 반환"이면 뒤에 온 쪽이 빈 그룹으로 초기 선택을 실행해
    //    첫 그룹이 안 잡히고 저장이 비활성으로 고착된다(타이밍에 따라 간헐 재현).
    let inflight: Promise<void> | null = null;

    function load(force = false): Promise<void> {
        if (loaded.value && !force) return Promise.resolve();
        if (inflight) return inflight;
        loading.value = true;
        inflight = (async () => {
            try {
                const res = await apiGetGroups();
                groups.value = res?.data?.payload ?? [];
                loaded.value = true;
            } finally {
                loading.value = false;
                inflight = null;
            }
        })();
        return inflight;
    }

    function invalidate() {
        loaded.value = false;
    }

    // ---------- 그룹 ----------

    async function createGroup(body: ServiceGroupCreateRequest): Promise<ServiceGroupTree | undefined> {
        const res = await apiAddGroup(body);
        await load(true);
        const created = groups.value.find((g) => g.serviceGroupName === body.serviceGroupName);
        return created ?? res?.data?.payload;
    }

    async function updateGroup(id: number, body: ServiceGroupUpdateRequest) {
        await apiModifyGroup(id, body);
        const target = groups.value.find((g) => g.serviceGroupId === id);
        if (target) {
            target.serviceGroupName = body.serviceGroupName;
            if (body.sortOrd !== undefined) target.sortOrd = body.sortOrd;
        }
    }

    async function deleteGroup(id: number) {
        await apiRemoveGroup(id);
        groups.value = groups.value.filter((g) => g.serviceGroupId !== id);
    }

    // ---------- 항목 ----------
    // 항목 CRUD 후 항상 load(true) 강제 호출.
    // 1) BE 정렬(수정/등록 일시 DESC) 을 그대로 반영
    // 2) 응답 payload 누락/형태 불일치에도 reactivity 정합성 보장
    //    (저장 버튼 disabled → 항목 1개 추가 후에도 풀리지 않던 회귀 방지)

    async function createItem(body: ServiceItemCreateRequest): Promise<void> {
        await apiAddItem(body);
        await load(true);
    }

    async function updateItem(id: number, body: ServiceItemUpdateRequest) {
        await apiModifyItem(id, body);
        await load(true);
    }

    async function deleteItem(id: number) {
        await apiRemoveItem(id);
        await load(true);
    }

    return {
        // state
        groups,
        loaded,
        loading,
        // computed
        userGroups,
        // actions
        load,
        invalidate,
        createGroup,
        updateGroup,
        deleteGroup,
        createItem,
        updateItem,
        deleteItem,
    };
});

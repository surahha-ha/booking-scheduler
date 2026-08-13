// src/composables/useQueryString.ts
import {storeToRefs} from 'pinia';
import {watch} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import type {DataType, ViewMode} from '@/constants/schedulerSearchFilter';

const QK = {
    dataType: 'dataType', // APPOINTMENT | TREATMENT
    viewMode: 'viewMode', // WEEK | DAY
} as const;

function asString(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
    return undefined;
}

export function useQueryString() {
    const route = useRoute();
    const router = useRouter();

    const filterStore = useSchedulerFilterStore();
    const {viewMode, dataType} = storeToRefs(filterStore);

    // 무한루프 방지 플래그
    let syncingFromRoute = false;
    let syncingToRoute = false;

    // ---------------------------
    // 1) route.query -> store
    // ---------------------------
    function applyRouteToStore() {
        const q = route.query;

        const nextDataType = asString(q[QK.dataType]) as DataType | undefined;
        const nextViewMode = asString(q[QK.viewMode]) as ViewMode | undefined;

        if (!nextDataType && !nextViewMode) return;

        syncingFromRoute = true;
        try {
            if (nextDataType) filterStore.setDataType(nextDataType, false);
            if (nextViewMode) filterStore.setViewMode(nextViewMode, false);
            filterStore.triggerSearch();
        } finally {
            syncingFromRoute = false;
        }
    }

    // ---------------------------
    // 2) store -> route.query
    // ---------------------------
    function applyStoreToRoute(mode: 'push' | 'replace' = 'push') {
        const nextQuery = {
            ...route.query,
            [QK.dataType]: dataType.value,
            [QK.viewMode]: viewMode.value,
        };

        syncingToRoute = true;
        const nav = mode === 'replace' ? router.replace : router.push;
        return nav.call(router, {query: nextQuery}).finally(() => {
            syncingToRoute = false;
        });
    }

    // ---------------------------
    // watchers
    // ---------------------------

    // a) 최초 진입/뒤로가기: route 변화 -> store 반영
    watch(
        () => route.query,
        (q) => {
            if (syncingToRoute) return;

            const hasAnyQuery = Object.values(q).some(v => v !== undefined && v !== '');

            // query가 아예 없는 경우 → 기본값 세팅
            if (!hasAnyQuery) {
                syncingToRoute = true;

                router.replace({
                    query: {
                        dataType: dataType.value,
                        viewMode: viewMode.value
                    }
                }).finally(() => {
                    syncingToRoute = false;
                });

                return;
            }

            applyRouteToStore();
        },
        {immediate: true}
    );

    // b) store 변화 -> route 반영
    //    - 탭 변경은 push 권장
    //    - 날짜 이동은 replace 고려
    watch(
        [dataType, viewMode],
        () => {
            if (syncingFromRoute) return;

            void applyStoreToRoute('push');
        },
    );

    return {
        syncFromRoute: applyRouteToStore,
        syncToRoute: applyStoreToRoute,
    };
}
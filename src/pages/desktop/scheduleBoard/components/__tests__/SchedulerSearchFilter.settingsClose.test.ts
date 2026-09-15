/**
 * @vitest-environment happy-dom
 *
 * 설정 팝업을 닫을 때 자식의 떠 있는 레이어부터 정리한다 (2026-09-03).
 *
 * 사고: 설정 팝업 바깥(스케줄러 배경)을 클릭하면 팝업만 사라지고 운영시간 popover 는 화면에
 * 그대로 떠 있었다. 자식의 popover 는 Teleport 로 body 에 그려져 이 팝업 DOM 밖에 있으므로,
 * 팝업이 닫혀도 저 혼자 남는다.
 *
 * ★순서가 계약이다 — settlePopovers() 를 isDirty() **보다 먼저** 불러야 한다.
 *  아직 draft 로만 있던 운영시간 입력은 상태가 아니라 dirty 로 보이지 않는다. 정리하면서 상태로
 *  옮겨야 "저장되지 않은 정보가 있다" 확인창이 뜬다. 순서를 뒤집으면 입력해 둔 값이 확인 없이 사라진다.
 *
 * 자식 쪽 계약(settlePopovers 가 무엇을 닫나 · draft 가 dirty 로 잡히나)은
 * SchedulerSettingsTreatmentSetting.popoverExclusive.test 가 본다.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {flushPromises, mount} from '@vue/test-utils';
import {createPinia, setActivePinia} from 'pinia';

vi.mock('@/lib/http', () => ({
    useApi: () => ({get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn()}),
    useDialog: () => ({alert: vi.fn(), confirm: vi.fn()}),
    useUserProfile: () => ({currentUser: {value: null}}),
}))
vi.mock('@/lib/useDialog', () => ({
    useApi: () => ({get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn()}),
    useDialog: () => ({alert: vi.fn(), confirm: vi.fn()}),
    useUserProfile: () => ({currentUser: {value: null}}),
}));
vi.mock('notivue', () => ({
    push: {success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn()},
}));
/* DxPopup 은 렌더하지 않으므로(아래 stubs) 모듈째 대체한다 — 실물을 import 하면 devextreme 의
 * 테마 로더가 setTimeout 을 걸고, 그게 환경 teardown 뒤에 깨어나
 * `window.getComputedStyle is not a function` 으로 터져 스위트 종료코드를 1 로 만든다(실측). */
vi.mock('devextreme-vue/popup', () => ({default: {name: 'DxPopup', render: () => null}}));

const mocks = vi.hoisted(() => ({
    getDoctors: vi.fn(),
    getTeams: vi.fn(),
}));
vi.mock('@/api/staffApi', () => ({
    getDoctors: mocks.getDoctors,
    syncDoctors: vi.fn(),
}));
vi.mock('@/api/siteApi', () => ({
    getTeams: mocks.getTeams,
    getTreatmentSettings: vi.fn(async () => ({data: {payload: {}}})),
    getSiteWorkHours: vi.fn(async () => ({data: {payload: []}})),
    getStaffWorkHours: vi.fn(async () => ({data: {payload: []}})),
    saveTreatmentSettings: vi.fn(),
}));
vi.mock('@/api/publicHolidayApi', () => ({fetchPublicHolidays: vi.fn(async () => [])}));
vi.mock('@/api/mcsApi', () => ({
    get: vi.fn(async () => ({data: {payload: 'N'}})),
    modify: vi.fn(),
}));
vi.mock('@/api/bookApi', () => ({
    get: vi.fn(async () => ({data: {payload: []}})),
    getMemberStatistics: vi.fn(async () => ({data: {payload: []}})),
    getStateStatistics: vi.fn(async () => ({data: {payload: []}})),
    getUnassignedReservations: vi.fn(async () => ({data: {payload: false}})),
    assignUnassigned: vi.fn(),
    add: vi.fn(),
    modify: vi.fn(),
    remove: vi.fn(),
    updateStatus: vi.fn(),
}));

import SchedulerSearchFilter from '@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue';

async function mountFilter() {
    const wrapper = mount(SchedulerSearchFilter, {
        global: {stubs: {DxPopup: true, Teleport: true}},
    });
    await flushPromises();
    await wrapper.vm.$nextTick();
    return wrapper;
}

/** 운영일정 설정 자식 대역 — 호출 순서를 관찰할 수 있게 한 배열에 기록한다 */
function fakeChild(calls: string[], {dirty = false} = {}) {
    return {
        settlePopovers: vi.fn(() => {
            calls.push('settlePopovers');
        }),
        isDirty: vi.fn(() => {
            calls.push('isDirty');
            return dirty;
        }),
        isDialogBusy: () => false,
        attemptClose: vi.fn(() => {
            calls.push('attemptClose');
        }),
    };
}

/** 운영일정 설정 탭을 활성으로 두고 자식 대역을 꽂는다 */
function useTreatmentTab(wrapper: any, child: any) {
    const state = wrapper.vm.$.setupState;
    state.activeSettingsTab = 'TREATMENT_SETTING';
    state.treatmentSettingRef = child;
    return state;
}

describe('설정 팝업 닫기 — 자식 popover 를 먼저 정리한다', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
        mocks.getDoctors.mockResolvedValue({data: {payload: []}});
        mocks.getTeams.mockResolvedValue({data: {payload: {teams: []}}});
    });

    it('★바깥 클릭으로 닫힐 때(hiding) settlePopovers 를 부른다 — 안 부르면 popover 가 화면에 남는다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const state = useTreatmentTab(wrapper, fakeChild(calls));

        state.onSettingsPopupHiding({});

        expect(calls).toContain('settlePopovers');
    });

    it('★settlePopovers 가 isDirty 보다 먼저다 — draft 를 상태로 옮긴 뒤에 물어야 확인창이 뜬다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const state = useTreatmentTab(wrapper, fakeChild(calls, {dirty: true}));

        state.onSettingsPopupHiding({});

        expect(calls.indexOf('settlePopovers')).toBeLessThan(calls.indexOf('isDirty'));
    });

    it('★정리 뒤 dirty 면 닫힘을 취소하고 확인창을 띄운다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const child = fakeChild(calls, {dirty: true});
        const state = useTreatmentTab(wrapper, child);
        const event: any = {};

        state.onSettingsPopupHiding(event);

        expect(event.cancel, '닫히지 않는다').toBe(true);
        expect(child.attemptClose, '"저장되지 않은 정보" 확인창').toHaveBeenCalled();
    });

    it('정리 뒤 dirty 가 아니면 그대로 닫힌다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const child = fakeChild(calls, {dirty: false});
        const state = useTreatmentTab(wrapper, child);
        const event: any = {};

        state.onSettingsPopupHiding(event);

        expect(event.cancel).toBeUndefined();
        expect(child.attemptClose).not.toHaveBeenCalled();
    });

    /* 다이얼로그가 떠 있는 동안은 닫힘 자체를 막는다 — 그 위 클릭이 외부클릭으로 잡히기 때문이다.
     * 이때는 정리도 하지 않는다: 팝업이 그대로 열려 있으니 popover 도 제자리에 있어야 한다. */
    it('자식이 다이얼로그 대기 중이면 정리하지 않고 닫힘만 취소한다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const child = {...fakeChild(calls), isDialogBusy: () => true};
        const state = useTreatmentTab(wrapper, child);
        const event: any = {};

        state.onSettingsPopupHiding(event);

        expect(event.cancel).toBe(true);
        expect(child.settlePopovers).not.toHaveBeenCalled();
    });

    it('★팝업 [×] 버튼으로 닫을 때도 정리한다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const child = fakeChild(calls, {dirty: true});
        const state = useTreatmentTab(wrapper, child);

        state.onCloseButtonClick();

        expect(calls.indexOf('settlePopovers')).toBeLessThan(calls.indexOf('isDirty'));
        expect(child.attemptClose).toHaveBeenCalled();
    });

    /* ★정리 대상은 dirty 대상과 다르다 — 조회 탭은 편집이 없어 dirty 를 갖지 않지만,
     * 더보기 popover 는 있고 그것도 Teleport 라 팝업이 닫혀도 남는다. */
    it('★조회 탭의 더보기 popover 도 정리한다', async () => {
        const wrapper = await mountFilter();
        const state = wrapper.vm.$.setupState;
        const settlePopovers = vi.fn();
        state.activeSettingsTab = 'TREATMENT_VIEW';
        state.treatmentViewRef = {settlePopovers};

        state.onSettingsPopupHiding({});

        expect(settlePopovers).toHaveBeenCalled();
    });

    /* 저장·취소 emit 경로 — hiding 인터셉트를 건너뛰므로(closingConfirmed) 여기서 한 번 더 정리한다 */
    it('★저장·취소로 닫을 때도 정리한다', async () => {
        const wrapper = await mountFilter();
        const calls: string[] = [];
        const child = fakeChild(calls);
        const state = useTreatmentTab(wrapper, child);

        state.closeSettingsPopupConfirmed();

        expect(child.settlePopovers).toHaveBeenCalled();
        expect(state.settingsPopupVisible).toBe(false);
    });
});

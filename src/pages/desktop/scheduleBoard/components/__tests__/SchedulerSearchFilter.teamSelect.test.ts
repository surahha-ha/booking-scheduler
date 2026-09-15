/**
 * @vitest-environment happy-dom
 *
 * 메인 화면 팀 셀렉트 — '미지정' 선택지는 팀 미소속 담당자가 있을 때만 노출한다.
 *
 * '미지정' 은 팀이 아니라 "어느 팀에도 속하지 않은 담당자" 그룹이다(resolveVisibleDoctors(null,…)).
 * 전원이 팀에 배정돼 그 그룹이 비면 골라도 담당자 0명·컬럼 0개인 빈 화면이 되므로 선택지에서 감춘다.
 * 반대로 팀 미소속 담당자가 한 명이라도 있으면 그들을 볼 유일한 경로라 반드시 남긴다.
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

const mocks = vi.hoisted(() => ({
    getDoctors: vi.fn(),
    getTeams: vi.fn(),
}));
vi.mock('@/api/staffApi', () => ({
    getDoctors: mocks.getDoctors,
    syncDoctors: vi.fn(),
}));
// 팀은 siteApi 소관이다(staffApi 아님).
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

/** 담당자 대표 응답 */
function doctorsResp(names: string[]) {
    return {
        data: {
            payload: names.map((staffName, i) => ({staffName, staffId: i + 1, openYn: 'Y'})),
        },
    };
}

/** 팀 응답 — teams[].doctors 가 그 팀의 멤버 */
function teamsResp(teams: Array<{ name: string; members: string[] }>) {
    return {
        data: {
            payload: {
                teams: teams.map((t, i) => ({
                    id: String(i + 1),
                    name: t.name,
                    doctors: t.members.map(staffName => ({staffName})),
                })),
            },
        },
    };
}

async function mountFilter() {
    const wrapper = mount(SchedulerSearchFilter, {
        global: {stubs: {DxPopup: true, Teleport: true}},
    });
    await flushPromises();
    await wrapper.vm.$nextTick();
    return wrapper;
}

/** 팀 셀렉트의 선택지 라벨 */
function teamOptions(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll('.scheduleSearchFilter__teamSelect option').map(el => el.text());
}

describe("팀 셀렉트의 '미지정' 선택지", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
    });

    it('전원이 팀에 배정돼 팀 미소속이 0명이면 노출하지 않는다', async () => {
        mocks.getDoctors.mockResolvedValue(doctorsResp(['김담당', '이담당']));
        mocks.getTeams.mockResolvedValue(teamsResp([{name: '관리팀', members: ['김담당', '이담당']}]));

        const wrapper = await mountFilter();

        expect(teamOptions(wrapper)).toEqual(['관리팀']);
    });

    it('팀 미소속 담당자가 남아 있으면 노출한다', async () => {
        mocks.getDoctors.mockResolvedValue(doctorsResp(['김담당', '이담당']));
        mocks.getTeams.mockResolvedValue(teamsResp([{name: '관리팀', members: ['김담당']}]));

        const wrapper = await mountFilter();

        expect(teamOptions(wrapper)).toEqual(['관리팀', '미지정']);
    });

    it('대표에 선등록된 "미지정" 은 팀 멤버가 될 수 없으므로 선택지가 유지된다', async () => {
        mocks.getDoctors.mockResolvedValue(doctorsResp(['김담당', '미지정']));
        mocks.getTeams.mockResolvedValue(teamsResp([{name: '관리팀', members: ['김담당']}]));

        const wrapper = await mountFilter();

        expect(teamOptions(wrapper)).toEqual(['관리팀', '미지정']);
    });

    it('팀이 하나도 없으면 전원이 미소속이므로 선택지가 유지된다', async () => {
        mocks.getDoctors.mockResolvedValue(doctorsResp(['김담당']));
        mocks.getTeams.mockResolvedValue(teamsResp([]));

        const wrapper = await mountFilter();

        expect(teamOptions(wrapper)).toEqual(['미지정']);
    });
});

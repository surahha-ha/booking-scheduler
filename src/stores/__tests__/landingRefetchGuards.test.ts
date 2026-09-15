/**
 * 랜딩 시 동일 payload 중복 조회 억제 + 응답 경합 가드 회귀 테스트.
 *
 * 배경 — `/book` 랜딩 1회에 같은 payload 의 장부 조회가 5~6회 나가고 있었다.
 *   ① loadDoctor 가 응답이 같아도 doctors 배열을 매번 교체 → 하위 computed(컬럼→조회 윈도우) 재평가 →
 *      윈도우가 흔들리면 searchVersion 이 다시 올라 loadDoctor 가 또 불리는 되먹임.
 *   ② 팀 선택은 담당자 선택이 비어 있으면 재조회를 생략한다 — 장부 조회 payload 에 팀이 없다(표시 오버레이).
 *      한동안 통계 조회의 doctorName 이 팀에서 파생된다는 이유로 재조회를 걸었는데, 상태·회원 카운트가
 *      화면 카드에서 세는 방식(boardStatistics)으로 바뀌어 그 이유가 사라졌다.
 *   ③ 겹친 조회의 응답 순서가 뒤바뀌면 늦게 온 옛 응답이 최신 화면을 덮었다(upsert 는 전량 교체).
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createPinia, setActivePinia} from 'pinia';
import {ref} from 'vue';

// @/lib/http — bookApi/staffApi 가 모듈 로드 시점에 useApi() 를 호출하므로 부작용 없는 stub 필요.
vi.mock('@/lib/http', () => ({
    useApi: () => ({get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn()}),
    useUserProfile: () => ({currentUser: ref(null)}),
    useDialog: () => ({confirm: vi.fn()}),
}))
vi.mock('@/lib/useDialog', () => ({
    useApi: () => ({get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn()}),
    useUserProfile: () => ({currentUser: ref(null)}),
    useDialog: () => ({confirm: vi.fn()}),
}));

vi.mock('@/api/staffApi', () => ({
    getDoctors: vi.fn(),
    syncDoctors: vi.fn(),
}));

import {getDoctors} from '@/api/staffApi';
import {useStaffStore} from '../staffStore';
import {useSchedulerFilterStore} from '../useSchedulerFilterStore';
import {toBookApiParams} from '@/mappers/schedulerSearchFilterToApiParams';

const mockGetDoctors = getDoctors as unknown as ReturnType<typeof vi.fn>;

function doctorsResp(list: Array<{ staffName: string; staffId: number; openYn: 'Y' | 'N' }>) {
    return {data: {payload: list}};
}

const BASE = [
    {staffName: '김담당', staffId: 1, openYn: 'Y' as const},
    {staffName: '이담당', staffId: 2, openYn: 'N' as const},
];

describe('staffStore.loadDoctor — 무변경 응답은 배열을 교체하지 않는다(되먹임 차단)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockGetDoctors.mockReset();
    });

    it('같은 목록을 다시 받으면 배열·요소 identity 가 유지된다', async () => {
        const store = useStaffStore();
        mockGetDoctors.mockResolvedValue(doctorsResp(BASE));

        await store.loadDoctor();
        const snapshot = [...store.doctors];

        await store.loadDoctor();

        expect(store.doctors.length).toBe(2);
        // 요소 identity 유지 = 하위 computed 재평가 없음 = 조회 윈도우 재설정 없음.
        expect(store.doctors[0]).toBe(snapshot[0]);
        expect(store.doctors[1]).toBe(snapshot[1]);
    });

    it('openYn 이 바뀌면(마이페이지에서 공개 전환) 교체한다 — 비공개 뱃지가 stale 로 남지 않게', async () => {
        const store = useStaffStore();
        mockGetDoctors.mockResolvedValue(doctorsResp(BASE));
        await store.loadDoctor();
        expect(store.doctors[1].openYn).toBe('N');

        mockGetDoctors.mockResolvedValue(doctorsResp([
            BASE[0],
            {...BASE[1], openYn: 'Y'},
        ]));
        await store.loadDoctor();

        expect(store.doctors[1].openYn).toBe('Y');
    });

    it('순서만 바뀌어도 교체한다 — 담당자 순서 설정이 보드에 반영돼야 한다', async () => {
        const store = useStaffStore();
        mockGetDoctors.mockResolvedValue(doctorsResp(BASE));
        await store.loadDoctor();

        mockGetDoctors.mockResolvedValue(doctorsResp([BASE[1], BASE[0]]));
        await store.loadDoctor();

        expect(store.doctors.map(d => d.text)).toEqual(['이담당', '김담당']);
    });

    it('추가/삭제는 당연히 교체한다', async () => {
        const store = useStaffStore();
        mockGetDoctors.mockResolvedValue(doctorsResp(BASE));
        await store.loadDoctor();

        mockGetDoctors.mockResolvedValue(doctorsResp([BASE[0]]));
        await store.loadDoctor();

        expect(store.doctors.length).toBe(1);
    });

    it('조회 실패 시 이전 목록을 비우지 않는다(기존 규약 보존)', async () => {
        const store = useStaffStore();
        mockGetDoctors.mockResolvedValue(doctorsResp(BASE));
        await store.loadDoctor();

        mockGetDoctors.mockRejectedValue(new Error('network'));
        const ok = await store.loadDoctor();

        expect(ok).toBe(false);
        expect(store.doctors.length).toBe(2);
    });
});

describe('useSchedulerFilterStore.setTeam — 팀은 표시 오버레이라 payload 가 안 바뀌면 재조회하지 않는다', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    // 기대값 출처: setTeam 주석. 종전 "오른다" 단언의 근거(통계 doctorName 이 팀에서 파생)는 카운트를 화면
    // 카드에서 세게 되면서(boardStatistics) 없어졌다 — 팀 전환은 컬럼만 바꾸고 숫자는 컬럼을 따라간다.
    it('담당자 선택이 비어 있으면 팀이 바뀌어도 searchVersion 은 그대로다 — 장부 payload 가 같다', () => {
        const filter = useSchedulerFilterStore();
        const before = filter.searchVersion;
        const payloadBefore = toBookApiParams(filter.$state);

        filter.setTeam('점검팀');

        expect(filter.selectedTeamName).toBe('점검팀');
        expect(toBookApiParams(filter.$state)).toEqual(payloadBefore);
        expect(filter.searchVersion).toBe(before);
    });

    it('팀을 연달아 바꿔도(미지정 ↔ 팀 포함) 재조회는 없다', () => {
        const filter = useSchedulerFilterStore();
        const before = filter.searchVersion;

        filter.setTeam('점검팀');
        filter.setTeam('관리팀');
        filter.setTeam(null);

        expect(filter.selectedTeamName).toBeNull();
        expect(filter.searchVersion).toBe(before);
    });

    it('담당자 선택이 있으면 초기화가 payload(doctorName) 를 바꾸므로 재조회한다', () => {
        const filter = useSchedulerFilterStore();
        filter.setDoctors(['김담당'], false);
        const before = filter.searchVersion;
        const payloadBefore = toBookApiParams(filter.$state);

        filter.setTeam('점검팀');

        expect(filter.doctors).toEqual([]);
        expect(toBookApiParams(filter.$state)).not.toEqual(payloadBefore);
        expect(filter.searchVersion).toBe(before + 1);
    });

    it('trigger=false 면 담당자 선택이 있어도 재조회하지 않는다', () => {
        const filter = useSchedulerFilterStore();
        filter.setDoctors(['김담당'], false);
        const before = filter.searchVersion;

        filter.setTeam('점검팀', false);

        expect(filter.doctors).toEqual([]);
        expect(filter.searchVersion).toBe(before);
    });

    it('같은 팀 재선택은 아무 것도 하지 않는다', () => {
        const filter = useSchedulerFilterStore();
        filter.setDoctors(['김담당'], false);
        filter.setTeam('점검팀');
        const before = filter.searchVersion;

        filter.setTeam('점검팀');

        expect(filter.searchVersion).toBe(before);
    });
});

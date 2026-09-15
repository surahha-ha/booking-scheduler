/**
 * 장부 조회 응답 경합 가드 회귀 테스트.
 *
 * 배경 — 랜딩 중 조회 윈도우가 흔들려 같은 화면에서 조회가 여러 번 겹쳤고, load() 에 순서 가드가 없었다.
 * upsertAppointments 는 누적이 아니라 전량 교체(stale 제거)라, 늦게 도착한 옛 응답이 그대로 화면이 된다.
 * → 요청 순번을 물려 "가장 마지막에 시작한 조회"의 응답만 반영한다.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createPinia, setActivePinia} from 'pinia';
import {ref} from 'vue';

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

vi.mock('@/api/bookApi', () => ({
    get: vi.fn(),
    getMemberStatistics: vi.fn(async () => ({data: {payload: []}})),
    getStateStatistics: vi.fn(async () => ({data: {payload: []}})),
    add: vi.fn(),
    modify: vi.fn(),
    remove: vi.fn(),
    updateStatus: vi.fn(),
}));

// 담당자·사업장 조회는 이 테스트의 관심사가 아니다 — 조회 체인이 굴러가기만 하면 된다.
const oimStub = vi.hoisted(() => ({
    doctors: [{id: '김의사', text: '김의사', staffId: 1, openYn: 'Y'}],
    teams: [],
    hospitalRules: {weekly: {1: [{start: '09:00', end: '18:00'}]}},
    loadDoctor: vi.fn(async () => true),
    loadSchedule: vi.fn(async () => undefined),
}));
vi.mock('@/stores/staffStore', () => ({useStaffStore: () => oimStub}));
vi.mock('@/stores/mcsStore', () => ({
    useMcsStore: () => ({loadTreatmentStateType: vi.fn(async () => undefined)}),
}));

import {get} from '@/api/bookApi';
import {useBookStore} from '../bookStore';
import {useSchedulerFilterStore} from '../useSchedulerFilterStore';

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

/** 응답을 임의 시점에 완료시키기 위한 지연 큐 */
type Deferred = { resolve: (value: unknown) => void };

function bookResp(names: string[]) {
    return {
        data: {
            payload: [{
                workRsvtDt: '20260819',
                items: names.map((name, i) => ({
                    reservationId: i + 1,
                    customerName: name,
                    startAt: '2026-08-19T10:00:00',
                    endAt: '2026-08-19T10:30:00',
                    staffName: '김의사',
                    customerId: 100 + i,
                    statusCode: '00',
                })),
            }],
        },
    };
}

/** 대기 중인 마이크로태스크 정리 */
const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('bookStore.load — 늦게 도착한 옛 응답이 최신 응답을 덮지 않는다', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockGet.mockReset();
        oimStub.loadDoctor.mockClear();
    });

    it('응답 순서가 뒤바뀌어도 마지막에 시작한 조회의 결과만 화면에 남는다', async () => {
        const deferreds: Deferred[] = [];
        mockGet.mockImplementation(() => new Promise((resolve) => {
            deferreds.push({resolve});
        }));

        const book = useBookStore();       // searchVersion watch{immediate} → 조회 #1 시작
        const filter = useSchedulerFilterStore();
        await flush();

        filter.triggerSearch();            // 조회 #2 시작
        await flush();

        expect(deferreds.length).toBe(2);

        // #2(최신) 가 먼저 도착 → 화면 반영
        deferreds[1].resolve(bookResp(['최신고객']));
        await flush();
        expect(book.appointments.map(a => a.patientName)).toEqual(['최신고객']);

        // #1(옛것) 이 뒤늦게 도착 → 버려져야 한다
        deferreds[0].resolve(bookResp(['옛고객A', '옛고객B']));
        await flush();
        expect(book.appointments.map(a => a.patientName)).toEqual(['최신고객']);
    });

    it('옛 응답이 먼저 끝나도 pending 이 조기 해제되지 않는다', async () => {
        const deferreds: Deferred[] = [];
        mockGet.mockImplementation(() => new Promise((resolve) => {
            deferreds.push({resolve});
        }));

        const book = useBookStore();
        const filter = useSchedulerFilterStore();
        await flush();
        filter.triggerSearch();
        await flush();

        deferreds[0].resolve(bookResp(['옛고객']));   // 옛 조회 완료
        await flush();
        expect(book.pending).toBe(true);              // 최신 조회는 아직 진행 중

        deferreds[1].resolve(bookResp(['최신고객']));
        await flush();
        expect(book.pending).toBe(false);
    });
});

/**
 * bookStore.appointmentsStale — 조건이 바뀐 재조회가 떠 있는 동안 목록은 이전 조건의 것이다.
 *
 * 배경 — 상태 칩 숫자를 화면 카드에서 세게 되자, 검색 조건을 바꾼 직후 새 목록이 오기 전까지
 * 이전 조건의 카드 수가 새 조건의 숫자처럼 잠시 보였다. 페이지는 이 플래그가 켜져 있으면 0 을 낸다.
 *
 * 고정하는 계약:
 *   ① 파라미터가 달라지는 조회가 시작되면 stale, 그 응답이 반영되면 해제
 *   ② 같은 파라미터의 재조회(SSE 갱신)는 stale 이 아니다 — 숫자가 깜빡이지 않는다
 *   ③ 늦게 도착한 옛 응답은 stale 을 풀지 못한다(응답 경합 가드와 같은 순번)
 *
 * 기대값 출처: bookStore.load 주석(loadedParamsKey).
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
    add: vi.fn(),
    modify: vi.fn(),
    remove: vi.fn(),
    updateStatus: vi.fn(),
}));

const oimStub = vi.hoisted(() => ({
    doctors: [{id: '김담당', text: '김담당', staffId: 1, openYn: 'Y'}],
    teams: [],
    hospitalRules: {weekly: {1: [{start: '09:00', end: '18:00'}]}},
    doctorRules: {},
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

const mockGet = vi.mocked(get);

type Deferred = { resolve: (value: unknown) => void };
const empty = () => ({data: {payload: []}});

const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** 최초 조회까지 끝낸 store — 이후 조회는 deferreds 에 쌓인다. */
async function landed(deferreds: Deferred[]) {
    mockGet.mockImplementation(() => new Promise((resolve) => {
        deferreds.push({resolve});
    }));
    const book = useBookStore();
    const filter = useSchedulerFilterStore();
    await flush();
    deferreds.shift()!.resolve(empty());
    await flush();
    expect(book.appointmentsStale).toBe(false);
    return {book, filter};
}

describe('bookStore.appointmentsStale', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockGet.mockReset();
    });

    it('① 조건이 바뀐 조회가 떠 있는 동안 stale, 응답이 반영되면 해제', async () => {
        const deferreds: Deferred[] = [];
        const {book, filter} = await landed(deferreds);

        filter.setKeyword('홍길동', true); // payload 가 바뀌는 재조회
        await flush();
        expect(book.appointmentsStale).toBe(true);

        deferreds.shift()!.resolve(empty());
        await flush();
        expect(book.appointmentsStale).toBe(false);
    });

    it('② 같은 조건의 재조회(SSE 갱신)는 stale 이 아니다', async () => {
        const deferreds: Deferred[] = [];
        const {book, filter} = await landed(deferreds);

        filter.triggerSearch();
        await flush();
        expect(deferreds.length).toBe(1);
        expect(book.appointmentsStale).toBe(false);

        deferreds.shift()!.resolve(empty());
        await flush();
        expect(book.appointmentsStale).toBe(false);
    });

    it('③ 옛 조건의 응답이 늦게 와도 새 조건의 조회가 떠 있으면 stale 은 그대로', async () => {
        const deferreds: Deferred[] = [];
        const {book, filter} = await landed(deferreds);

        filter.setKeyword('홍길동', true);
        await flush();
        filter.setKeyword('김철수', true);
        await flush();
        expect(deferreds.length).toBe(2);

        deferreds[0].resolve(empty()); // 옛 조건(홍길동) 응답
        await flush();
        expect(book.appointmentsStale).toBe(true);

        deferreds[1].resolve(empty()); // 현재 조건(김철수) 응답
        await flush();
        expect(book.appointmentsStale).toBe(false);
    });

    // 기대값 출처: load() catch 주석 — 실패하면 이전 목록의 카드가 그대로 남으므로 숫자만 0 으로 고착되면 안 된다.
    it('④ 최신 조회가 실패하면 stale 을 푼다 — 카드는 남는데 숫자만 0 으로 고착되지 않게', async () => {
        const deferreds: Deferred[] = [];
        const {book, filter} = await landed(deferreds);
        // 성공 응답과 다른 형태로 reject 하기 위해 Deferred 대신 실패 Promise 를 직접 돌려준다.
        mockGet.mockImplementationOnce(() => Promise.reject(new Error('network')));

        filter.setKeyword('홍길동', true);
        await flush();

        expect(book.appointmentsStale).toBe(false);
        expect(book.pending).toBe(false);
    });
});

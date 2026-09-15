/**
 * 화면 진입 게이트 — 담당자 0건이면 운영시간 유무와 무관하게 안내(마이페이지 이동)를 띄운다.
 *
 * 배경 — 운영시간 게이트가 "차단"에서 "배너 권장"으로 완화되면서(기관 운영시간 미등록은 비블로킹),
 * 담당자 0건만이 유일한 하드 차단 조건으로 남았다. 이 순서가 뒤집히면 담당자가 없는 거래처가
 * 운영시간이 등록돼 있다는 이유로 조용히 통과해 컬럼 0개짜리 빈 보드를 보게 된다.
 * 판정 기준은 담당자 조회 결과 목록이 0건인지 하나뿐이다("미지정" 1건은 목록이 있는 것으로 센다).
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
    get: vi.fn(async () => ({data: {payload: []}})),
    getMemberStatistics: vi.fn(async () => ({data: {payload: []}})),
    getStateStatistics: vi.fn(async () => ({data: {payload: []}})),
    add: vi.fn(),
    modify: vi.fn(),
    remove: vi.fn(),
    updateStatus: vi.fn(),
}));

// 운영시간은 "등록된" 상태로 고정한다 — 담당자 게이트가 운영시간과 무관하게 걸리는지가 관심사다.
const oimStub = vi.hoisted(() => ({
    doctors: [] as Array<{ id: string; text: string; staffId: number; openYn: string }>,
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

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

function doctor(name: string, no: number) {
    return {id: name, text: name, staffId: no, openYn: 'Y'};
}

/** 대기 중인 마이크로태스크 정리 */
const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('bookStore 진입 게이트 — 담당자 0건', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockGet.mockClear();
        oimStub.loadDoctor.mockClear();
        oimStub.loadDoctor.mockImplementation(async () => true);
        oimStub.doctors = [];
    });

    it('담당자 0건이면 기관 운영시간이 등록돼 있어도 안내를 띄운다', async () => {
        oimStub.doctors = [];

        const book = useBookStore();
        await flush();

        expect(book.redirectReason).toContain('[담당자]');
        // 하드 차단이므로 장부 조회까지 가지 않는다.
        expect(mockGet).not.toHaveBeenCalled();
    });

    it('담당자가 "미지정" 1건뿐이어도 목록은 0건이 아니므로 통과시킨다', async () => {
        oimStub.doctors = [doctor('미지정', 1)];

        const book = useBookStore();
        await flush();

        expect(book.redirectReason).toBeNull();
        expect(mockGet).toHaveBeenCalled();
    });

    it('담당자 조회 실패(장애)는 0건과 구분해 재시도 안내로 처리한다', async () => {
        oimStub.loadDoctor.mockImplementation(async () => false);

        const book = useBookStore();
        await flush();

        expect(book.redirectReason).toBeNull();
        expect(book.serviceUnavailable).toContain('일시적인 서비스 접근 불가');
    });
});

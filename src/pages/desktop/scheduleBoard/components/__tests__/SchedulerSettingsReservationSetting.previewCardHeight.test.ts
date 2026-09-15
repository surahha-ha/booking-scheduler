/**
 * @vitest-environment happy-dom
 *
 * 예약장부 설정 — 미리보기 카드의 세로 배치가 실제 보드 엔진과 같은 규칙인가.
 *
 * 종전 미리보기는 카드 높이를 분(分) 비례(`duration * slotHeight / unit`)로 그렸다.
 * 그래서 30분 샘플 예약이 45·60분 눈금에서 한 칸보다 낮아졌고, 카드가 칸에 반쯤
 * 걸친 채 표시 정보가 잘렸다(제보 건). 실제 보드(layoutPipeline computeRects)는
 * 분 비례가 아니라 "시작 칸에 스냅 → 한 칸 안에서 끝나면 1칸, 관통하면 종료 칸까지" 다.
 *
 * 칸 개수는 종료 시각이 아니라 보이는 영역 높이가 정한다. 종료 시각을 고정하면
 * 눈금이 커질수록 칸이 적어져 격자 아래에 빈 회색 영역이 남았다(제보 건).
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {nextTick} from 'vue';
import {flushPromises, mount} from '@vue/test-utils';
import {createPinia, setActivePinia} from 'pinia';

vi.mock('notivue', () => ({
    push: {success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn()},
}));

const mocks = vi.hoisted(() => ({
    getReservationSettings: vi.fn(),
    saveReservationSettings: vi.fn(),
}));
vi.mock('@/api/reservationSettingsApi', () => ({
    getReservationSettings: mocks.getReservationSettings,
    saveReservationSettings: mocks.saveReservationSettings,
}));

import SchedulerSettingsReservationSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsReservationSetting.vue';

/** 카드 높이 단계 3 = 한 칸 80px (엔진 ROW_HEIGHT_BY_LEVEL 과 같은 값). */
const SLOT_PX = 80;

const BASE = {
    totalColumnCount : 8,
    displayInfo        : ['NAME', 'AGE', 'GENDER', 'TREATMENT'],
    cardHeightLevel: 3,
};

/* 격자 칸 수는 스크롤 영역 실측 높이로 정해진다(ResizeObserver). happy-dom 은 레이아웃이
 * 없어 높이가 늘 0 이므로, 관측 콜백을 붙잡아 원하는 높이를 직접 흘려 넣는다. */
let emitViewportHeight: ((_height: number) => Promise<void>) | null = null;

class MockResizeObserver {
    constructor(callback: (_entries: {contentRect: {height: number}}[]) => void) {
        emitViewportHeight = async (height: number) => {
            callback([{contentRect: {height}}]);
            await nextTick();
        };
    }
    observe() {}
    disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

async function mountWithUnit(unit: number, viewportPx = 0) {
    mocks.getReservationSettings.mockResolvedValue({
        data: {code: 'succeed', payload: {...BASE, slotUnitMinutes: unit}},
    });
    const wrapper = mount(SchedulerSettingsReservationSetting, {attachTo: document.body});
    await flushPromises();
    if (viewportPx) await emitViewportHeight?.(viewportPx);
    return wrapper;
}

/** 미리보기 카드의 인라인 style 에서 top/height 픽셀값을 뽑는다. */
async function cardBox(unit: number) {
    const wrapper = await mountWithUnit(unit);
    const style = wrapper.find('.schedulerReservationSetting__appointment').attributes('style') ?? '';
    const px = (prop: string) => Number(new RegExp(`${prop}:\\s*([\\d.]+)px`).exec(style)?.[1]);

    return {top: px('top'), height: px('height')};
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
});

/* 샘플 예약은 '2번 칸에서 시작하는 1시간' 한 건. 눈금별로 몇 칸을 덮는지가 이 묶음의 대상이다. */
describe('미리보기 카드 세로 배치 — 시작 칸 스냅 + 최소 한 칸', () => {
    it.each([
        // [눈금, 덮는 칸 수]  ※ 시작 칸은 눈금과 무관하게 늘 2번
        [60, 1],   // 11:00~12:00 — 칸에 정확히 맞는다
        [45, 1.5], // 10:30~11:30 — 정수 칸이면 30분 눈금과 똑같이 2칸이라, 여기만 반 칸을 쓴다
        [30, 2],   // 10:00~11:00
        [20, 3],   // 09:40~10:40
        [10, 6],   // 09:20~10:20
    ])('%i분 눈금에서 카드는 %i칸을 덮는다', async (unit, spans) => {
        expect(await cardBox(unit)).toEqual({
            top   : 2 * SLOT_PX,
            height: spans * SLOT_PX,
        });
    });

    /* 시작을 시각으로 고정하면 그 시각이 걸리는 칸이 눈금마다 달라져(60분 1번 칸 · 10분 6번 칸)
     * 눈금을 바꿀 때마다 카드가 위아래로 널뛴다. */
    it('눈금을 바꿔도 카드가 같은 자리에서 시작한다', async () => {
        const tops = await Promise.all([10, 20, 30, 45, 60].map(async (unit) => (await cardBox(unit)).top));

        expect(new Set(tops)).toEqual(new Set([2 * SLOT_PX]));
    });

    /* 눈금이 촘촘할수록 카드가 커진다 — 45분의 반 칸 예외도 이 순서 안에 있어야 한다.
     * (2.5칸으로 잡으면 45분이 30분보다 커져 이 순서가 뒤집힌다.) */
    it('60·45·30분 눈금이 서로 다르고, 촘촘할수록 카드가 커진다', async () => {
        const [at60, at45, at30] = await Promise.all(
            [60, 45, 30].map(async (unit) => (await cardBox(unit)).height),
        );

        expect(at60).toBeLessThan(at45);
        expect(at45).toBeLessThan(at30);
    });

    it('가장 잘게 나눈 10분 눈금에서도 카드가 6칸을 넘지 않는다 — 미리보기를 다 덮지 않게', async () => {
        expect((await cardBox(10)).height).toBe(6 * SLOT_PX);
    });

    it('어느 눈금에서도 카드 높이가 한 칸보다 낮아지지 않는다 — 정보가 잘리던 회귀', async () => {
        for (const unit of [10, 20, 30, 45, 60]) {
            const {height} = await cardBox(unit);
            expect(height, `${unit}분 눈금`).toBeGreaterThanOrEqual(SLOT_PX);
        }
    });
});

describe('격자 칸 수 — 보이는 영역을 채운다', () => {
    const labelsOf = (wrapper: {findAll: (_s: string) => {text: () => string}[]}) =>
        wrapper.findAll('.schedulerReservationSetting__timeCell').map((c) => c.text());

    it('720px 영역이면 9칸이고, 마지막 시각은 눈금을 따라간다', async () => {
        expect(labelsOf(await mountWithUnit(60, 720))).toHaveLength(9);
        expect(labelsOf(await mountWithUnit(60, 720)).at(-1)).toBe('17:00');
        expect(labelsOf(await mountWithUnit(30, 720)).at(-1)).toBe('13:00');
    });

    /* 영역이 좁으면(카드 높이를 키운 경우) 10분 눈금 예약이 끝나는 8번째 칸이 영역(5칸) 밖으로
     * 밀린다. 영역만 채우면 카드 아랫부분이 격자 밖으로 잘리므로, 예약이 끝나는 칸까지는 늘린다. */
    it('예약이 영역 밖에서 끝나면 그 칸까지 격자를 늘린다', async () => {
        const labels = labelsOf(await mountWithUnit(10, 400));

        expect(labels).toHaveLength(8);
        expect(labels.at(-1)).toBe('10:10');
    });

    it.each([560, 720, 810, 1000])(
        '%ipx 영역에서 격자가 그 높이 이상이라 아래에 빈 영역이 남지 않는다',
        async (viewportPx) => {
            const wrapper = await mountWithUnit(60, viewportPx);
            const gridHeight = labelsOf(wrapper).length * SLOT_PX;

            expect(gridHeight).toBeGreaterThanOrEqual(viewportPx);
        },
    );

    it('영역을 아직 못 잰 첫 렌더에서도 칸이 최소 1개는 그려진다', async () => {
        expect(labelsOf(await mountWithUnit(30)).length).toBeGreaterThanOrEqual(1);
    });

    it('자정을 넘겨도 25:00 같은 라벨이 나오지 않는다', async () => {
        const labels = labelsOf(await mountWithUnit(60, 1600));

        expect(labels.some((l) => Number(l.slice(0, 2)) > 23)).toBe(false);
    });
});

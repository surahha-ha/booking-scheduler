/**
 * @vitest-environment happy-dom
 *
 * 예약장부 설정 — 미리보기 헤더(1,2,3,4…)의 세로선이 아래 격자의 세로선과 맞는가.
 *
 * 헤더 행은 스크롤 영역 밖에 있어 세로 스크롤바 폭만큼 더 넓었다. 헤더도 격자도 칸을
 * 1fr 로 나누므로 그 차이가 칸마다 쌓여, 오른쪽 칸으로 갈수록 두 세로선이 벌어졌다(제보 건).
 *
 * 스크롤바 폭을 재서 빼는 방식은 offsetWidth·clientWidth 가 정수라 소수점만큼 어긋남이 남는다
 * (화면 배율이 100% 가 아니면 스크롤바 폭도 소수점이다). 그래서 폭을 계산하지 않고
 * 격자를 소수점까지 실측해 헤더의 칸 영역에 그대로 준다 — 두 쪽이 같은 폭을 같은 수로 나눈다.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {nextTick} from 'vue';
import {flushPromises, mount} from '@vue/test-utils';
import {createPinia, setActivePinia} from 'pinia';

vi.mock('notivue', () => ({
    push: {success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn()},
}));

const mocks = vi.hoisted(() => ({
    getReservationSettings : vi.fn(),
    saveReservationSettings: vi.fn(),
}));
vi.mock('@/api/reservationSettingsApi', () => ({
    getReservationSettings : mocks.getReservationSettings,
    saveReservationSettings: mocks.saveReservationSettings,
}));

import SchedulerSettingsReservationSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsReservationSetting.vue';

const BASE = {
    slotUnitMinutes : 30,
    totalColumnCount : 8,
    displayInfo        : ['NAME', 'AGE', 'GENDER', 'TREATMENT'],
    cardHeightLevel: 3,
};

/* happy-dom 은 레이아웃이 없어 폭이 늘 0 이다. 관측 콜백을 붙잡아 두고 격자 실측폭을 심는다. */
let fireResize: ((_height: number) => Promise<void>) | null = null;

class MockResizeObserver {
    constructor(callback: (_entries: {contentRect: {height: number}}[]) => void) {
        fireResize = async (height: number) => {
            callback([{contentRect: {height}}]);
            await nextTick();
        };
    }
    observe() {}
    disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

function setMeasuredWidth(el: Element, width: number) {
    el.getBoundingClientRect = () => ({width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0,
        toJSON: () => ({})}) as DOMRect;
}

async function mountPreview() {
    mocks.getReservationSettings.mockResolvedValue({data: {code: 'succeed', payload: BASE}});
    const wrapper = mount(SchedulerSettingsReservationSetting, {attachTo: document.body});
    await flushPromises();
    return wrapper;
}

/** 헤더 칸 영역에 지정된 폭(px). 지정이 없으면 null. */
function headerColumnsWidthPx(wrapper: ReturnType<typeof mount>) {
    const style = wrapper.find('.schedulerReservationSetting__colHeader').attributes('style') ?? '';
    const hit = /(?:^|[;\s])width:\s*([\d.]+)px/.exec(style);
    return hit ? Number(hit[1]) : null;
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
});

describe('미리보기 헤더 — 격자와 칸 폭 맞추기', () => {
    it('헤더의 칸 영역 폭이 격자 실측폭과 같다 — 스크롤바가 먹은 만큼 헤더도 좁아진다', async () => {
        const wrapper = await mountPreview();
        setMeasuredWidth(wrapper.find('.schedulerReservationSetting__grid').element, 725);

        await fireResize?.(600);

        expect(headerColumnsWidthPx(wrapper)).toBe(725);
    });

    it('소수점 폭도 그대로 따라간다 — 정수로 깎으면 뒷 칸에서 어긋남이 남는다', async () => {
        const wrapper = await mountPreview();
        setMeasuredWidth(wrapper.find('.schedulerReservationSetting__grid').element, 724.67);

        await fireResize?.(600);

        expect(headerColumnsWidthPx(wrapper)).toBe(724.67);
    });

    it('폭이 바뀌면 헤더도 다시 따라간다 — 한 번 잰 값을 붙들지 않는다', async () => {
        const wrapper = await mountPreview();
        const grid = wrapper.find('.schedulerReservationSetting__grid').element;

        setMeasuredWidth(grid, 725);
        await fireResize?.(600);
        expect(headerColumnsWidthPx(wrapper)).toBe(725);

        setMeasuredWidth(grid, 540.5);
        await fireResize?.(600);
        expect(headerColumnsWidthPx(wrapper)).toBe(540.5);
    });

    it('아직 재기 전(폭 0)이면 폭을 지정하지 않는다 — 헤더가 접히지 않는다', async () => {
        const wrapper = await mountPreview();

        expect(headerColumnsWidthPx(wrapper)).toBeNull();
    });
});

/* 칸을 1fr 로 나누면 폭이 소수점이라, 화면 배율이 100% 가 아닐 때 헤더와 격자가
 * 서로 다른 픽셀로 반올림돼 뒤 칸으로 갈수록 어긋나 보인다(제보 건). 보드와 같은 규칙으로 정수화한다. */
describe('미리보기 칸 폭 — 배율과 무관하게 같은 자리', () => {
    /** 요소의 grid-template-columns 선언값. */
    function tracks(wrapper: ReturnType<typeof mount>, cls: string) {
        const style = wrapper.find(cls).attributes('style') ?? '';
        return /grid-template-columns:\s*([^;]+)/.exec(style)?.[1].trim();
    }

    it('헤더와 격자가 완전히 같은 칸 폭을 쓴다', async () => {
        const wrapper = await mountPreview();
        setMeasuredWidth(wrapper.find('.schedulerReservationSetting__grid').element, 725);

        await fireResize?.(600);

        const grid = tracks(wrapper, '.schedulerReservationSetting__grid');
        expect(grid).toBeDefined();
        expect(tracks(wrapper, '.schedulerReservationSetting__colHeader')).toBe(grid);
    });

    it('칸 폭은 정수 px 이고, 합이 실측폭과 같다 — 칸 사이에 틈이 없다', async () => {
        const wrapper = await mountPreview();
        setMeasuredWidth(wrapper.find('.schedulerReservationSetting__grid').element, 725);

        await fireResize?.(600);

        const parts = (tracks(wrapper, '.schedulerReservationSetting__grid') ?? '').split(/\s+/);
        expect(parts).toHaveLength(8); // 기본 전체 칸 개수 8
        parts.forEach(p => expect(p).toMatch(/^\d+px$/));
        expect(parts.reduce((s, p) => s + parseInt(p, 10), 0)).toBe(725);
    });

    it('재기 전에는 1fr 로 둔다 — 폭 0 으로 칸이 사라지지 않는다', async () => {
        const wrapper = await mountPreview();

        expect(tracks(wrapper, '.schedulerReservationSetting__grid')).toBe('repeat(8, 1fr)');
    });
});

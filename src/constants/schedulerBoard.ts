import type dayjsType from 'dayjs'

// View mode (internal)
export const VIEW_MODE = {
    DAY: 'DAY',
    WEEK: 'WEEK',
} as const

export type ViewMode = typeof VIEW_MODE[keyof typeof VIEW_MODE]

export const DATA_TYPE = {
    APPOINTMENT: 'APPOINTMENT',
    TREATMENT: 'TREATMENT',
} as const

export type DataType = typeof DATA_TYPE[keyof typeof DATA_TYPE]

// View mode (DevExtreme)
export const DX_VIEW = {
    DAY: 'day',
    WEEK: 'week',
} as const

export type DxView = typeof DX_VIEW[keyof typeof DX_VIEW]

// View mode mapping
export const VIEW_MODE_TO_DX_VIEW: Record<ViewMode, DxView> = {
    [VIEW_MODE.DAY]: DX_VIEW.DAY,
    [VIEW_MODE.WEEK]: DX_VIEW.WEEK,
}

// Group orientation
export const GROUP_ORIENTATION = {
    HORIZONTAL: 'horizontal',
    VERTICAL: 'vertical',
} as const

export type GroupOrientation =
    typeof GROUP_ORIENTATION[keyof typeof GROUP_ORIENTATION]

// Indicator update interval
export const INDICATOR_UPDATE_INTERVAL_MS = 60 * 1000

// Default time range
export const DEFAULT_START = 9
export const DEFAULT_END = 20

// Week header formatter
export function formatWeekHeader(date: Date, dayjs: typeof dayjsType): string {
    return dayjs(date).format('MM.DD (ddd)')
}

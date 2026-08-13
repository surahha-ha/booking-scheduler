import dayjs from 'dayjs'

// "More" popup title formatter
export function formatMorePopupTitle(start: Date | null) {
    return start ? dayjs(start).format('MM.DD(ddd) HH:mm') + ' 예약' : '예약 목록'
}

import { describe, expect, it } from 'vitest'
import {
  filterDayGroupsByTempBucket,
  formatMonthChip,
  formatMonthHeader,
  groupDayGroupsByMonth,
  groupLooksByDate,
  listMonthsFromLooks,
  monthKey,
  pickPrimaryLook,
  placeSummary,
  sortDayGroupsByFeelsLike,
  TEMP_BUCKETS,
} from './dayGroups'
import type { Look, WeatherProfile } from '../types'

function weather(partial: Partial<WeatherProfile> = {}): WeatherProfile {
  return {
    date: '2026-07-01',
    feelsLike: 18,
    tempMean: 17,
    windMs: 2,
    humidity: 50,
    precipMm: 0,
    precipProb: 10,
    cloudCover: 40,
    ...partial,
  }
}

function look(partial: Partial<Look> & Pick<Look, 'id' | 'date'>): Look {
  return {
    createdAt: 1,
    placeName: 'Москва',
    latitude: 55.75,
    longitude: 37.62,
    locationSource: 'settings',
    weather: weather({ date: partial.date }),
    ...partial,
  }
}

describe('groupLooksByDate', () => {
  it('merges same calendar date into one group', () => {
    const a = look({ id: 'a', date: '2026-07-10', time: '09:00' })
    const b = look({ id: 'b', date: '2026-07-10', time: '18:00' })
    const c = look({ id: 'c', date: '2026-07-11', time: '12:00' })
    const groups = groupLooksByDate([a, b, c])
    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2026-07-11')
    expect(groups[1].date).toBe('2026-07-10')
    expect(groups[1].looks.map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('pickPrimaryLook prefers time closest to outing hour', () => {
    const morning = look({
      id: 'm',
      date: '2026-07-10',
      time: '09:00',
      createdAt: 2,
    })
    const evening = look({
      id: 'e',
      date: '2026-07-10',
      time: '18:00',
      createdAt: 1,
    })
    expect(pickPrimaryLook([morning, evening], '17:30').id).toBe('e')
    expect(pickPrimaryLook([morning, evening], '08:00').id).toBe('m')
  })

  it('placeSummary says N места when mixed', () => {
    const a = look({
      id: 'a',
      date: '2026-07-10',
      placeName: 'Москва',
      time: '09:00',
      locationSource: 'photo',
    })
    const b = look({
      id: 'b',
      date: '2026-07-10',
      placeName: 'Стамбул',
      time: '18:00',
      locationSource: 'settings',
    })
    const group = groupLooksByDate([a, b], '09:00')[0]
    expect(placeSummary(group)).toBe('2 места')
  })
})

describe('month helpers', () => {
  it('monthKey takes YYYY-MM', () => {
    expect(monthKey('2026-07-21')).toBe('2026-07')
  })

  it('formatMonthChip / header are Russian', () => {
    expect(formatMonthChip('2026-07')).toMatch(/2026/)
    expect(formatMonthChip('2026-07').toLowerCase()).toMatch(/июл/)
    expect(formatMonthHeader('2026-07').toLowerCase()).toMatch(/июл/)
  })

  it('listMonthsFromLooks newest first', () => {
    const looks = [
      look({ id: 'a', date: '2026-05-01' }),
      look({ id: 'b', date: '2026-07-10' }),
      look({ id: 'c', date: '2026-07-02' }),
    ]
    expect(listMonthsFromLooks(looks)).toEqual(['2026-07', '2026-05'])
  })

  it('groupDayGroupsByMonth keeps day groups under months', () => {
    const groups = groupLooksByDate([
      look({ id: 'a', date: '2026-07-10' }),
      look({ id: 'b', date: '2026-06-01' }),
      look({ id: 'c', date: '2026-07-02' }),
    ])
    const sections = groupDayGroupsByMonth(groups)
    expect(sections.map((s) => s.month)).toEqual(['2026-07', '2026-06'])
    expect(sections[0].groups.map((g) => g.date)).toEqual([
      '2026-07-10',
      '2026-07-02',
    ])
  })
})

describe('sortDayGroupsByFeelsLike', () => {
  it('sorts cold to warm by default', () => {
    const groups = groupLooksByDate([
      look({
        id: 'warm',
        date: '2026-07-10',
        weather: weather({ date: '2026-07-10', feelsLike: 22 }),
      }),
      look({
        id: 'cold',
        date: '2026-07-11',
        weather: weather({ date: '2026-07-11', feelsLike: 5 }),
      }),
      look({
        id: 'mid',
        date: '2026-07-12',
        weather: weather({ date: '2026-07-12', feelsLike: 12 }),
      }),
    ])
    const sorted = sortDayGroupsByFeelsLike(groups)
    expect(sorted.map((g) => g.primary.id)).toEqual(['cold', 'mid', 'warm'])
  })
})

describe('filterDayGroupsByTempBucket', () => {
  const groups = () =>
    groupLooksByDate([
      look({
        id: 'freeze',
        date: '2026-01-10',
        weather: weather({ date: '2026-01-10', feelsLike: -3 }),
      }),
      look({
        id: 'cool',
        date: '2026-04-01',
        weather: weather({ date: '2026-04-01', feelsLike: 7 }),
      }),
      look({
        id: 'mild',
        date: '2026-05-01',
        weather: weather({ date: '2026-05-01', feelsLike: 12 }),
      }),
      look({
        id: 'warm',
        date: '2026-07-10',
        weather: weather({ date: '2026-07-10', feelsLike: 22 }),
      }),
      look({
        id: 'hot',
        date: '2026-08-01',
        weather: weather({ date: '2026-08-01', feelsLike: 28 }),
      }),
    ])

  it('all leaves groups unchanged', () => {
    expect(filterDayGroupsByTempBucket(groups(), 'all')).toHaveLength(5)
  })

  it('filters by primary feelsLike bucket edges', () => {
    expect(
      filterDayGroupsByTempBucket(groups(), 'lt0').map((g) => g.primary.id),
    ).toEqual(['freeze'])
    expect(
      filterDayGroupsByTempBucket(groups(), '5-10').map((g) => g.primary.id),
    ).toEqual(['cool'])
    expect(
      filterDayGroupsByTempBucket(groups(), '10-15').map((g) => g.primary.id),
    ).toEqual(['mild'])
    expect(
      filterDayGroupsByTempBucket(groups(), '20-25').map((g) => g.primary.id),
    ).toEqual(['warm'])
    expect(
      filterDayGroupsByTempBucket(groups(), 'gt25').map((g) => g.primary.id),
    ).toEqual(['hot'])
  })

  it('includes bucket boundary on the lower side', () => {
    const edge = groupLooksByDate([
      look({
        id: 'edge',
        date: '2026-06-01',
        weather: weather({ date: '2026-06-01', feelsLike: 15 }),
      }),
    ])
    expect(filterDayGroupsByTempBucket(edge, '15-20')).toHaveLength(1)
    expect(filterDayGroupsByTempBucket(edge, '10-15')).toHaveLength(0)
  })

  it('exposes Russian chip labels', () => {
    expect(TEMP_BUCKETS[0].label).toBe('все')
    expect(TEMP_BUCKETS.some((b) => b.label === '0–5°')).toBe(true)
  })
})

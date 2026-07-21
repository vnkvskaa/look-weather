import { describe, expect, it } from 'vitest'
import {
  formatMonthChip,
  formatMonthHeader,
  groupDayGroupsByMonth,
  groupLooksByDate,
  listMonthsFromLooks,
  monthKey,
  pickPrimaryLook,
  placeSummary,
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
    photoBlob: new Blob(),
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

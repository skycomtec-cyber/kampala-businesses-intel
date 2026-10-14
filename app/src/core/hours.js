import { ValidationError } from './errors.js'

/**
 * Opening hours.
 *
 * A directory that can say where a business is but not when it is open is only
 * half a directory: the single most common reason somebody looks a business up
 * is to decide whether to go there now. This file is the pure rule for that — a
 * recurring weekly schedule, validated on the way in and read on the way out —
 * and it deliberately carries no clock of its own.
 *
 * Everything here is a pure function of its inputs, for the reason the whole
 * core layer exists. `describeState` is handed the current moment rather than
 * reading it, so the same schedule and the same instant always produce the same
 * sentence, and a page can be tested at three in the morning without waiting
 * until three in the morning.
 *
 * Time zone: Uganda runs on East Africa Time, UTC+3, and has never observed
 * daylight saving. That is a fact about the place this platform serves rather
 * than a simplification, so the offset is a constant here and not a per-record
 * column. The platform does not pretend to support businesses that keep shop
 * hours in another zone, because none of the ones it indexes do.
 */

/** Minutes east of UTC. EAT is fixed; there is no DST to account for. */
export const TZ_OFFSET_MINUTES = 180
export const TZ_LABEL = 'EAT'

const MINUTES_PER_DAY = 24 * 60

/**
 * ISO-8601 weekdays: 1 is Monday and 7 is Sunday.
 *
 * Chosen over JavaScript's 0-Sunday convention because this number is written
 * into the database and read out of it, and "0 is Sunday" is the kind of fact
 * that is only obvious to the person who wrote it down.
 */
export const WEEKDAYS = Object.freeze([
  { weekday: 1, name: 'Monday', short: 'Mon' },
  { weekday: 2, name: 'Tuesday', short: 'Tue' },
  { weekday: 3, name: 'Wednesday', short: 'Wed' },
  { weekday: 4, name: 'Thursday', short: 'Thu' },
  { weekday: 5, name: 'Friday', short: 'Fri' },
  { weekday: 6, name: 'Saturday', short: 'Sat' },
  { weekday: 7, name: 'Sunday', short: 'Sun' },
])

const BY_WEEKDAY = new Map(WEEKDAYS.map((day) => [day.weekday, day]))

export function weekdayName(weekday) {
  return BY_WEEKDAY.get(weekday)?.name ?? String(weekday)
}

export function weekdayShort(weekday) {
  return BY_WEEKDAY.get(weekday)?.short ?? String(weekday)
}

export function assertWeekday(value) {
  const weekday = Number(value)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new ValidationError('A weekday must be a whole number from 1 (Monday) to 7 (Sunday).', {
      field: 'weekday',
      allowed: [1, 2, 3, 4, 5, 6, 7],
    })
  }
  return weekday
}

/**
 * `HH:MM` to minutes since midnight.
 *
 * A single-digit hour is accepted ("9:00") because a person typing into a form
 * will write it that way and refusing it teaches nothing. Seconds are not
 * accepted: opening times are recorded to the minute, and storing a precision
 * nothing reads is how a field grows values no one meant.
 */
export function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) {
    throw new ValidationError('A time must look like HH:MM on a 24-hour clock.', {
      field: 'opens',
    })
  }
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) {
    throw new ValidationError('A time must be between 00:00 and 23:59.', { field: 'opens' })
  }
  return hours * 60 + minutes
}

/** Minutes since midnight back to `HH:MM`, zero-padded so a table lines up. */
export function formatTime(minutes) {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hours = Math.floor(wrapped / 60)
  const rest = wrapped % 60
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/**
 * Builds one validated day of a week.
 *
 * A closed day carries no times and an open day carries both, and that pairing
 * is enforced here so no caller can write a "closed 09:00 to 17:00". A day whose
 * opening and closing times are equal is refused rather than guessed: it could
 * mean "never" or "all day", and the two are opposites, so the honest answer is
 * to ask.
 */
export function buildHours(input = {}) {
  const weekday = assertWeekday(input.weekday)
  const isClosed = Boolean(input.isClosed)
  if (isClosed) {
    return { weekday, isClosed: true, opens: null, closes: null }
  }
  const opens = String(input.opens ?? '').trim()
  const closes = String(input.closes ?? '').trim()
  if (!opens || !closes) {
    throw new ValidationError('An open day needs both an opening and a closing time.', {
      field: !opens ? 'opens' : 'closes',
      weekday,
    })
  }
  const opensMinutes = parseTime(opens)
  const closesMinutes = parseTime(closes)
  if (opensMinutes === closesMinutes) {
    throw new ValidationError(
      'Opening and closing time cannot be the same. A day that is open all day is not supported yet.',
      { field: 'closes', weekday },
    )
  }
  return {
    weekday,
    isClosed: false,
    opens: formatTime(opensMinutes),
    closes: formatTime(closesMinutes),
    // `closes` earlier than `opens` is not an error: it is the shape of a night
    // shift, and `isOpenAt` below reads it as running past midnight.
    overnight: closesMinutes < opensMinutes,
  }
}

/**
 * A whole week, always seven entries in weekday order.
 *
 * Missing days are filled in as closed rather than left absent, so a caller
 * never has to distinguish "not in the list" from "closed": a schedule read out
 * of the database and one typed into a form have the same shape.
 */
export function validateWeek(rows = []) {
  const byDay = new Map()
  for (const row of rows) {
    const day = buildHours(row)
    if (byDay.has(day.weekday)) {
      throw new ValidationError('A weekday can only appear once in a week of opening hours.', {
        field: 'weekday',
        weekday: day.weekday,
      })
    }
    byDay.set(day.weekday, day)
  }
  return WEEKDAYS.map(
    (day) => byDay.get(day.weekday) ?? { weekday: day.weekday, isClosed: true, opens: null, closes: null },
  )
}

/** Stored rows (camelCase, from the repository) to a validated seven-day week. */
export function weekFromRows(rows = []) {
  return validateWeek(rows)
}

/** A validated week to the plain objects the repository writes. */
export function rowsFromWeek(week) {
  return week.map((day) => ({
    weekday: day.weekday,
    isClosed: day.isClosed ? 1 : 0,
    opens: day.isClosed ? null : day.opens,
    closes: day.isClosed ? null : day.closes,
  }))
}

export function isOpenAllWeek(week) {
  return week.length > 0 && week.every((day) => !day.isClosed)
}

const MINUTES = (day) => day.opens.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
const CLOSE_MINUTES = (day) => day.closes.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)

/**
 * Whether the doors are open at one local moment.
 *
 * Two intervals can cover a given instant: today's, and yesterday's if
 * yesterday ran past midnight. Both are checked, because a shop that opens at
 * 20:00 and closes at 02:00 is open at 01:00 and the day it belongs to is the
 * previous one.
 */
export function isOpenAt(week, { weekday, minutes }) {
  const today = week.find((day) => day.weekday === weekday)
  if (today && !today.isClosed) {
    const opens = MINUTES(today)
    const closes = CLOSE_MINUTES(today)
    if (closes > opens) {
      if (minutes >= opens && minutes < closes) return true
    } else if (minutes >= opens) {
      // Overnight: open until midnight and beyond, handled by the spill below.
      return true
    }
  }

  const previousWeekday = weekday === 1 ? 7 : weekday - 1
  const previous = week.find((day) => day.weekday === previousWeekday)
  if (previous && !previous.isClosed) {
    const opens = MINUTES(previous)
    const closes = CLOSE_MINUTES(previous)
    if (closes <= opens && minutes < closes) return true
  }

  return false
}

/**
 * The moment the current state ends, and what the next one is.
 *
 * Used to say "closes 20:00" rather than only "open", because the second
 * question a person asks after "is it open" is "for how much longer".
 */
function closeOfCurrentInterval(week, { weekday, minutes }) {
  const today = week.find((day) => day.weekday === weekday)
  if (today && !today.isClosed) {
    const opens = MINUTES(today)
    const closes = CLOSE_MINUTES(today)
    if ((closes > opens && minutes >= opens && minutes < closes) || (closes <= opens && minutes >= opens)) {
      return closes
    }
  }
  const previousWeekday = weekday === 1 ? 7 : weekday - 1
  const previous = week.find((day) => day.weekday === previousWeekday)
  if (previous && !previous.isClosed) {
    const opens = MINUTES(previous)
    const closes = CLOSE_MINUTES(previous)
    if (closes <= opens && minutes < closes) return closes
  }
  return null
}

/** The next opening at or after now, as an offset in days and a time. */
function nextOpening(week, { weekday, minutes }) {
  for (let ahead = 0; ahead < 7; ahead += 1) {
    const day = ((weekday - 1 + ahead) % 7) + 1
    const entry = week.find((candidate) => candidate.weekday === day)
    if (!entry || entry.isClosed) continue
    const opens = MINUTES(entry)
    if (ahead === 0 && opens <= minutes) continue
    return { daysAhead: ahead, weekday: day, opens }
  }
  return null
}

function relativeDay(daysAhead, weekday) {
  if (daysAhead === 1) return 'tomorrow'
  if (daysAhead === 0) return 'today'
  return weekdayName(weekday)
}

/**
 * The whole answer, as data and as a sentence.
 *
 * `open` is what a badge colours on; `label` is what it says. Both come from
 * here rather than from a page, so the badge, the listing and any future mobile
 * client cannot disagree about whether the same business is open.
 */
export function describeState(week, at = new Date()) {
  const eat = new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000)
  const jsDay = eat.getUTCDay()
  const weekday = jsDay === 0 ? 7 : jsDay
  const minutes = eat.getUTCHours() * 60 + eat.getUTCMinutes()

  if (!week || week.every((day) => day.isClosed)) {
    return { open: false, recorded: false, label: 'Opening hours not recorded' }
  }

  if (isOpenAt(week, { weekday, minutes })) {
    const closes = closeOfCurrentInterval(week, { weekday, minutes })
    return {
      open: true,
      recorded: true,
      closesAt: closes === null ? null : formatTime(closes),
      label: closes === null ? 'Open now' : `Open now · closes ${formatTime(closes)}`,
    }
  }

  const next = nextOpening(week, { weekday, minutes })
  if (!next) {
    return { open: false, recorded: true, label: 'Closed' }
  }
  return {
    open: false,
    recorded: true,
    nextOpens: { weekday: next.weekday, time: formatTime(next.opens) },
    label: `Closed · opens ${relativeDay(next.daysAhead, next.weekday)} ${formatTime(next.opens)}`,
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Comment, Composing, Held, RecentTurn, Sent, SessionFile, Source, View } from '../types'
import { diffRows, splitLines } from './diff'
import { completions, expand, splitTyped } from './paths'
import type { Row } from './diff'
import { cells, cut, wrapRows } from './text'

type Engine = EngineInterface
type Doc = Extract<View, { screen: 'doc' }>

const PANE = 'redpen'
const REPLY = 'Claude 마지막 답변'
const EXCERPT_MAX = 8
// Keys described beside the hotkey Buttons, drawn as a Button draws its own: the key in a
// theme color, a colon, the text. A theme key, not a fixed color, so it follows the theme.
type KeyHint = readonly [key: string, text: string]
const KEY_COLOR = 'suggestion'
const LIST_KEYS: KeyHint[] = [
  ['↑↓', '이동'],
  ['Enter', '열기'],
]
const DOC_KEYS: KeyHint[] = [
  ['↑↓', '이동'],
  ['Enter', '코멘트 작성/수정'],
]
// Claude Code's keys for the pane itself, the same on every screen, under each screen's own.
const PANE_KEYS: KeyHint[] = [
  ['Esc', '프롬프트로'],
  ['Ctrl+X Tab', 'Redpen으로'],
  ['Ctrl+X X', 'Redpen 닫기'],
]
const hintWidth = ([key, text]: KeyHint) => cells(`${key}: ${text}`)
const HEADER = '다음 리뷰 코멘트를 모두 반영해서 수정해줘. 코멘트가 지적한 부분 외에는 건드리지 마.'

// The turn running now, the turn that last changed files, every file changed this session, and
// what the files the list knows held when the running turn began. All last the session: /clear,
// a resume and a restart start them anew.
const turn = atom({ plugin: 'redpen', key: 'turn' } as const, null as string | null)
const recent = atom({ plugin: 'redpen', key: 'recent' } as const, null as RecentTurn | null)
const edited = atom({ plugin: 'redpen', key: 'edited' } as const, [] as SessionFile[])
const snapshot = atom({ plugin: 'redpen', key: 'snapshot' } as const, [] as Held[])
// Files opened by path, latest first: offered again when a path is typed.
const opened = atom({ plugin: 'redpen', key: 'opened' } as const, [] as string[])
const OPENED_MAX = 10
const OFFERS_MAX = 8
const view = atom({ plugin: 'redpen', key: 'view' } as const, { screen: 'list' } as View)
const comments = atom({ plugin: 'redpen', key: 'comments' } as const, [] as Comment[])
const sent = atom({ plugin: 'redpen', key: 'sent' } as const, null as Sent | null)

// The path's stat with where it lands: absolute, links followed, . and .. folded.
const statPath = ($: Engine, path: string) => $.fs.stat(path, { resolve: true }).catch(() => undefined)

// Puts a change into the turn running now, the moment it is made, so a turn cut short keeps its
// changes: the turn's first change makes it the recent turn, and a file keeps what it held
// before the turn first changed it. The session's list takes the file as changed last.
async function recordEdit($: Engine, filePath: string, base: string | null) {
  // Kept as /redpen <path> resolves it, so both name a file the same way.
  const path = (await statPath($, filePath))?.realPath ?? filePath
  const turnId = (await read($, turn)) ?? ''
  await update($, recent, r => {
    const files = r?.turnId === turnId ? r.files : []
    return { turnId, files: files.some(f => f.path === path) ? files : [...files, { path, base }] }
  })
  const at = await $.clock.now()
  await update($, edited, list => [...list.filter(f => f.path !== path), { path, at }])
}

// A file gone from disk leaves the list.
async function forget($: Engine, path: string) {
  await update($, recent, r => (r === null ? r : { ...r, files: r.files.filter(f => f.path !== path) }))
  await update($, edited, list => list.filter(f => f.path !== path))
}

// The files the list knows: those changed this session and those with comments.
async function known($: Engine) {
  const commented = (await read($, comments)).filter(c => c.kind !== 'reply').map(c => c.path)
  return [...new Set([...(await read($, edited)).map(f => f.path), ...commented])]
}

// The last diff computed, by what it was computed from. A module variable: a reload drops it.
let lastDiff: { path: string; base: string; text: string; whole: boolean; rows: Row[] } | null = null

const plainRows = (lines: string[]): Row[] => lines.map((text, i) => ({ kind: 'ctx', text, newLine: i + 1 }))

type Loaded = { lines: string[]; rows: Row[]; note?: string }

async function loadDoc($: Engine, source: Source, whole = false): Promise<Loaded> {
  if (source.kind === 'reply') {
    const lines = splitLines(source.text)
    return { lines, rows: plainRows(lines) }
  }
  let text: string
  try {
    text = await $.fs.read(source.path)
  } catch {
    return { lines: [], rows: [], note: '파일을 읽을 수 없습니다 (없거나 4 MiB 초과).' }
  }
  const lines = splitLines(text)
  if (source.kind === 'file') return { lines, rows: plainRows(lines) }
  if (source.base === null) return { lines, rows: plainRows(lines), note: '변경 전 내용이 없어 파일 전체를 보여줍니다.' }
  // Every arrow key redraws; the file is read again, the diff reused while nothing changed.
  const key = { path: source.path, base: source.base, text, whole }
  if (!lastDiff || Object.entries(key).some(([k, value]) => lastDiff![k as keyof typeof key] !== value)) {
    lastDiff = { ...key, rows: diffRows(splitLines(source.base), lines, whole ? Infinity : 3) }
  }
  const rows = lastDiff.rows
  return { lines, rows, note: rows.every(r => r.kind === 'ctx') ? '변경분이 없습니다.' : undefined }
}

// The document as last drawn. The pane redraws on state, not when a file changes, so the
// keys act on these rows, the ones on screen, rather than on the file read again.
// A reply is not kept: its text is in the view already.
let drawn: { key: string | null; doc: Loaded } | null = null
const drawnKey = (v: Doc) => (v.source.kind === 'reply' ? null : `${v.source.kind}:${v.whole === true}:${v.source.path}`)

async function shown($: Engine, v: Doc): Promise<Loaded> {
  const key = drawnKey(v)
  return key !== null && drawn?.key === key ? drawn.doc : loadDoc($, v.source, v.whole === true)
}

const docPath = (source: Source) => (source.kind === 'reply' ? REPLY : source.path)

// Where the comment's excerpt stands now: its saved line, else the nearest exact match.
// `lines` undefined means the text cannot have moved (a deleted line, a reply snapshot).
function locate(c: Comment, lines: string[] | null | undefined): number | null {
  if (lines === undefined || c.side === 'old') return c.start
  if (lines === null) return null
  const at = (i: number) => c.excerpt.every((text, k) => lines[i + k] === text)
  if (at(c.start - 1)) return c.start
  let best: number | null = null
  for (let i = 0; i + c.excerpt.length <= lines.length; i++) {
    if (at(i) && (best === null || Math.abs(i + 1 - c.start) < Math.abs(best - c.start))) best = i + 1
  }
  return best
}

const span = (start: number, c: Comment) => (c.end === c.start ? `${start}` : `${start}-${start + c.end - c.start}`)

function relative(path: string, cwd: string) {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function where(c: Comment, start: number | null, cwd: string) {
  const name = c.kind === 'reply' ? REPLY : relative(c.path, cwd)
  if (start === null) return `${name} (위치 불명, 원래 ${span(c.start, c)}행)`
  if (c.kind === 'reply') return `${name} ${span(start, c)}행`
  if (c.side === 'old') return `${name}:${span(start, c)} (삭제된 줄, 변경 전 기준)`
  return `${name}:${span(start, c)}`
}

export async function buildPrompt($: Engine, list: Comment[]): Promise<string> {
  const cwd = await $.session.cwd()
  const files = new Map<string, string[] | null>()
  const items: string[] = []
  for (const [i, c] of list.entries()) {
    let lines: string[] | null | undefined
    if (c.kind !== 'reply' && c.side === 'new') {
      if (!files.has(c.path)) files.set(c.path, await $.fs.read(c.path).then(splitLines, () => null))
      lines = files.get(c.path)
    }
    const shown = c.excerpt.slice(0, EXCERPT_MAX).map(text => `   > ${text}`)
    if (c.excerpt.length > EXCERPT_MAX) shown.push(`   > …(${c.excerpt.length - EXCERPT_MAX}줄 생략)`)
    items.push(
      [
        `${i + 1}. ${where(c, locate(c, lines), cwd)}`,
        ...shown,
        ...c.text.split('\n').map(text => `   ${text}`),
      ].join('\n'),
    )
  }
  return [HEADER, '', ...items].join('\n')
}

async function submit($: Engine) {
  // Taken in the same write that empties the list: a second 0 finds nothing to send, and a
  // comment saved while the prompt is built stays for the next send.
  let list: Comment[] = []
  await update($, comments, now => ((list = now), []))
  if (list.length === 0) {
    $.ui.toast('보낼 코멘트가 없습니다.')
    return
  }
  const putBack = () => update($, comments, now => [...list, ...now])
  let text: string
  try {
    text = await buildPrompt($, list)
  } catch {
    await putBack()
    $.ui.toast('프롬프트를 만들지 못했습니다.')
    return
  }
  const at = await $.clock.now()
  await update($, sent, () => ({ at, count: list.length }))
  const undo = async (message: string) => {
    await putBack()
    await update($, sent, () => null)
    $.ui.toast(message)
  }
  // Resolves only when the turn starts, so it is not awaited while Claude may be working.
  void $.prompt.submit({ text, asUser: true }).then(
    result => ('drop' in result && result.drop !== undefined ? undo(`전송이 거절되었습니다: ${result.drop}`) : undefined),
    () => undo('전송하지 못했습니다.'),
  )
}

async function lastReply($: Engine): Promise<string | null> {
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim() !== '') return m.text
  }
  return null
}

async function openDoc($: Engine, source: Source) {
  await update($, view, (): View => ({ screen: 'doc', source, cursor: 0, anchor: null, composing: null, focused: null }))
}

async function openReply($: Engine) {
  const text = await lastReply($)
  if (text === null) $.ui.toast('Claude의 답변이 아직 없습니다.')
  else await openDoc($, { kind: 'reply', text })
}

// The Buttons the pane drew last, in order, and whether the next try at putting the ring
// back is the one retry a denied try gets. See pinRing.
let lastRing = ''
let retrying = false

// Opens the file a typed path names: the recent turn's diff if that turn changed it, else the
// whole file, and keeps it in the opened files. Says why when it opens nothing.
async function openPath($: Engine, typed: string): Promise<string | null> {
  const given = expand(typed, await $.session.cwd(), (await $.env.get('HOME')) ?? '')
  const stat = await statPath($, given)
  if (stat === undefined) return `${typed} 파일이 없습니다.`
  if (stat.kind !== 'file') return `${typed} 은(는) 파일이 아닙니다.`
  const path = stat.realPath ?? given
  await update($, opened, list => [path, ...list.filter(p => p !== path)].slice(0, OPENED_MAX))
  const changed = (await read($, recent))?.files.find(f => f.path === path)
  await openDoc($, changed ? { kind: 'diff', path, base: changed.base } : { kind: 'file', path })
  return null
}

// `opened`: a file opened by path before, marked ↺ apart from the directory's entries.
type Offer = { label: string; open: string; isDir: boolean; opened: boolean }

// The entries of a typed path's directory, the last listing kept: every key typed asks again.
let lastListing: { dir: string; entries: { name: string; kind: 'file' | 'dir' | 'other' }[] } | null = null

// What a typed path offers: the opened files whose shown path holds the text, then the entries
// of the typed directory that complete it. A directory's offer fills the input, a file's opens.
async function pathOffers($: Engine, typed: string): Promise<Offer[]> {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const shown = (path: string) => {
    const rel = relative(path, cwd)
    return home !== '' && rel.startsWith(`${home}/`) ? `~${rel.slice(home.length)}` : rel
  }
  const needle = typed.toLowerCase()
  const offers: Offer[] = (await read($, opened))
    .map(path => ({ label: shown(path), open: path, isDir: false, opened: true }))
    .filter(o => o.label.toLowerCase().includes(needle))
  if (typed !== '') {
    const { dir } = splitTyped(typed)
    const at = dir === '' ? cwd : expand(dir, cwd, home)
    if (lastListing?.dir !== at) lastListing = { dir: at, entries: await $.fs.list(at).catch(() => []) }
    for (const c of completions(typed, lastListing.entries, OFFERS_MAX)) {
      if (!offers.some(o => o.label === c.text)) offers.push({ label: c.text, open: c.text, isDir: c.isDir, opened: false })
    }
  }
  return offers.slice(0, OFFERS_MAX)
}

async function setPath($: Engine, path: { text: string; error: string | null } | undefined) {
  await update($, view, v => (v.screen === 'list' ? { ...v, path } : v))
}

async function submitPath($: Engine, typed: string) {
  const text = typed.trim()
  // An empty Enter closes the input, as it cancels a new comment.
  if (text === '') return setPath($, undefined)
  const error = await openPath($, text)
  if (error !== null) {
    await setPath($, { text: typed, error })
    focus($, 'path-input')
  }
}

async function pickOffer($: Engine, offer: Offer) {
  if (!offer.isDir) return submitPath($, offer.open)
  await setPath($, { text: offer.open, error: null })
  focus($, 'path-input')
}

async function openReview($: Engine, args: string) {
  const arg = args.trim()
  if (arg === '') {
    await update($, view, (): View => ({ screen: 'list' }))
  } else {
    const error = await openPath($, arg)
    if (error !== null) return { text: error }
  }
  // Above the prompt the pane asks for 20 rows rather than a third of the screen.
  await $.ui.open({ id: PANE, title: 'redpen', focus: true, rows: 20 })
  return {}
}

const isLine = (row: Row | undefined) => row !== undefined && row.kind !== 'gap'

function step(rows: Row[], from: number, by: number) {
  let i = from + by
  while (i >= 0 && i < rows.length && !isLine(rows[i])) i += by
  return i < 0 || i >= rows.length ? from : i
}

function normalize(rows: Row[], cursor: number) {
  const c = Math.max(0, Math.min(cursor, rows.length - 1))
  if (isLine(rows[c])) return c
  const down = step(rows, c, 1)
  return down !== c ? down : step(rows, c, -1)
}

async function setDoc($: Engine, fn: (v: Doc) => Doc) {
  await update($, view, v => (v.screen === 'doc' ? fn(v) : v))
}

// `{ deny }` when the ring did not move (the pane not holding the keyboard, the element not
// drawn in time, another move first); null when the engine could not take the call at all.
const tryFocus = ($: Engine, key: string) => $.ui.focus({ requestId: PANE, key }).catch(() => null)

// Best effort: the result is not waited for.
const focus = ($: Engine, key: string) => void tryFocus($, key)

// The pane keeps the ring on a Button by its place among the Buttons drawn, not by its key:
// when a window gains or loses a Button above the cursor's, the ring lands on a neighbour and
// no ui.focus is raised. Whenever the drawn Buttons (`ring`, their keys in order) change, put
// the ring back on `start` once this drawing is on screen. A try that is denied (the element
// not drawn in time, another move first) gets one more after a fresh drawing, aimed at the
// cursor as it stands then.
function pinRing($: Engine, ring: string, start: string | null, isFocused: boolean) {
  if (ring !== lastRing && isFocused && start !== null) {
    const key = start
    const retry = retrying
    retrying = false
    void $.clock
      .sleep(0)
      .then(() => tryFocus($, key))
      .then(result => {
        if (result?.deny === undefined || retry) return
        retrying = true
        lastRing = ''
        $.ui.invalidate('ui.render')
      })
  }
  lastRing = ring
}

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Fits a path into `width` cells, keeping the file name: the home directory becomes ~,
// and the directories that do not fit give way to one … from the middle.
function fitPath(path: string, home: string, width: number) {
  const shown = home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
  if (cells(shown) <= width) return shown
  const parts = shown.split('/')
  const name = parts.pop()!
  const tail = `…/${name}`
  if (cells(tail) > width) return cut(name, width)
  let head = ''
  for (const part of parts) {
    if (cells(`${head}${part}/${tail}`) > width) break
    head += `${part}/`
  }
  return head + tail
}

// Rows a wrapping row of items takes: each item `widths[i]` cells, `gap` cells apart.
function flowRows(widths: number[], gap: number, width: number) {
  let rows = 1
  let used = 0
  for (const w of widths) {
    if (used > 0 && used + gap + w > width) {
      rows++
      used = 0
    }
    used += (used > 0 ? gap : 0) + w
  }
  return rows
}

// Rows the pane's keys take at `width` columns, laid out as the hotkeys are.
const paneKeyRows = (width: number) => flowRows(PANE_KEYS.map(hintWidth), 2, width)

function layout(v: Doc, all: Comment[], doc: Loaded) {
  const { rows, lines } = doc
  const cursor = normalize(rows, v.cursor)
  const [selFrom, selTo] = v.anchor === null ? [cursor, cursor] : [Math.min(v.anchor, cursor), Math.max(v.anchor, cursor)]

  const attached = new Map<number, { c: Comment; start: number }[]>()
  const away: { c: Comment; why: string }[] = []
  // A comment sits on its last line: by new line number, or a deleted line's old one.
  const byNew = new Map<number, number>()
  const byOld = new Map<number, number>()
  rows.forEach((r, i) => {
    if (r.kind === 'gap') return
    if (r.newLine !== undefined && !byNew.has(r.newLine)) byNew.set(r.newLine, i)
    if (r.kind === 'del' && r.oldLine !== undefined && !byOld.has(r.oldLine)) byOld.set(r.oldLine, i)
  })
  const path = docPath(v.source)
  for (const c of all.filter(c => c.path === path)) {
    const start = locate(c, c.kind === 'reply' && v.source.kind !== 'reply' ? undefined : lines)
    const end = start === null ? null : start + c.end - c.start
    const row = end === null ? -1 : ((c.side === 'old' ? byOld : byNew).get(end) ?? -1)
    if (row === -1) away.push({ c, why: start === null ? '위치 불명' : `${span(start, c)}행, 표시 범위 밖` })
    else attached.set(row, [...(attached.get(row) ?? []), { c, start: start! }])
  }

  // Line numbers rise down the rows, so a selection's first and last numbers bound it.
  const selected = rows.slice(selFrom, selTo + 1).filter(r => r.kind !== 'gap')
  const newLines = selected.flatMap(r => (r.newLine === undefined ? [] : [r.newLine]))
  const range =
    newLines.length > 0
      ? { side: 'new' as const, start: newLines[0]!, end: newLines[newLines.length - 1]! }
      : { side: 'old' as const, start: selected[0]?.oldLine ?? 0, end: selected[selected.length - 1]?.oldLine ?? 0 }
  // The row a comment on the range sits on, by the same rule the comments above are placed.
  const endRow = (range.side === 'old' ? byOld : byNew).get(range.end) ?? -1
  const excerpt =
    range.side === 'new'
      ? lines.slice(range.start - 1, range.end)
      : selected.filter(r => r.kind === 'del').map(r => r.text)
  return { doc, rows, lines, cursor, selFrom, selTo, attached, away, range, endRow, excerpt }
}

const lineSpan = (r: { start: number; end: number }) => (r.end === r.start ? `${r.start}` : `${r.start}-${r.end}`)

async function compose($: Engine, composing: Composing) {
  await setDoc($, d => ({ ...d, composing }))
  focus($, 'comment-input')
}

async function save($: Engine, text: string) {
  const v = await read($, view)
  if (v.screen !== 'doc' || v.composing === null) return
  const composing = v.composing
  const body = text.trim()
  if ('editId' in composing) {
    const { editId } = composing
    // Emptying a comment's text and saving deletes it.
    await update($, comments, list =>
      body === '' ? list.filter(c => c.id !== editId) : list.map(c => (c.id === editId ? { ...c, text: body } : c)),
    )
  } else if ('lines' in composing && body !== '') {
    const comment: Comment = {
      id: Math.random().toString(36).slice(2, 10),
      kind: v.source.kind,
      path: docPath(v.source),
      ...composing.lines,
      text: body,
      at: await $.clock.now(),
    }
    await update($, comments, list => [...list, comment])
  }
  await setDoc($, d => ({ ...d, composing: null, anchor: null, focused: 'editId' in composing ? null : d.focused }))
  focus($, `L${normalize((await shown($, v)).rows, v.cursor)}`)
}

// Enter on (or a click of) a line number: ▶ moves there and the line's comment opens. One
// comment per line, on the selection's last line: that line's comment opens for editing if it
// has one; else the line or range gets a new one, its lines and excerpt taken now from the
// rows on screen. One write, since a drawing in between would read the file again.
async function pressLine($: Engine, row: number) {
  const v = await read($, view)
  if (v.screen !== 'doc') return
  const at: Doc = { ...v, cursor: row, focused: null }
  const l = layout(at, await read($, comments), await shown($, at))
  const here = l.attached.get(l.endRow)?.[0]?.c
  const composing: Composing = here ? { editId: here.id } : { lines: { ...l.range, excerpt: l.excerpt } }
  await setDoc($, d => ({ ...d, cursor: row, focused: null, composing }))
  focus($, 'comment-input')
}

// Switches a diff between its changes alone and the whole file, ▶ staying on its line.
async function toggleWhole($: Engine) {
  const v = await read($, view)
  if (v.screen !== 'doc' || v.composing !== null || v.source.kind !== 'diff') return
  const { rows } = await shown($, v)
  const at = rows[normalize(rows, v.cursor)]
  const whole = !v.whole
  const next = (await loadDoc($, v.source, whole)).rows
  const same = (r: Row) =>
    at !== undefined && at.kind !== 'gap' && r.kind === at.kind && r.newLine === at.newLine && r.oldLine === at.oldLine
  const cursor = Math.max(0, next.findIndex(same))
  await setDoc($, d => ({ ...d, whole, cursor, anchor: null, focused: null }))
}

async function toggleRange($: Engine) {
  const v = await read($, view)
  if (v.screen !== 'doc' || v.composing !== null) return
  const { rows } = await shown($, v)
  await setDoc($, d => ({ ...d, anchor: d.anchor === null ? normalize(rows, d.cursor) : null }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'redpen',
      description: '마지막 턴의 변경이나 파일을 줄 단위로 리뷰하고 코멘트를 한 번에 보냄',
      argumentHint: '[path]',
    })
    return next(e)
  })

  on('command.run', { command: 'redpen' }, ($, e) => openReview($, e.args))

  // In the prompt, /redpen <path> completes the path typed: the opened files that hold it and
  // the entries of its directory join the typeahead, a directory's taken to type on in.
  on('prompt.autocomplete', async ($, e, next) => {
    const answered = await next(e)
    if (e.text.slice(0, e.start).trimEnd() !== '/redpen') return answered
    const offers = await pathOffers($, e.token)
    return {
      suggestions: [
        ...answered.suggestions,
        ...offers.map(o => ({ text: o.label, ...(o.isDir ? { description: '디렉토리' } : {}) })),
      ],
    }
  })

  // Edit, Write and NotebookEdit say what they changed; a file the list knows that Bash or an
  // MCP tool changed shows only in its content. So what each known file holds is kept as the
  // turn begins, and compared as the turn ends.
  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    const paths = await known($)
    const texts = await Promise.all(paths.map(path => $.fs.read(path).catch(() => null)))
    await update($, snapshot, () => paths.flatMap((path, i) => (texts[i] === null ? [] : [{ path, text: texts[i]! }])))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const held = await read($, snapshot)
      await update($, snapshot, () => [])
      const turnId = await read($, turn)
      const r = await read($, recent)
      const recorded = r !== null && r.turnId === turnId ? r.files.map(f => f.path) : []
      for (const { path, text } of held) {
        if ((await statPath($, path)) === undefined) {
          await forget($, path)
          continue
        }
        // A file the turn's own tools recorded keeps the content before their first change.
        if (recorded.includes(path)) continue
        const now = await $.fs.read(path).catch(() => null)
        if (now !== null && now !== text) await recordEdit($, path, text)
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.staged !== true) {
      await recordEdit($, ran.result.filePath, ran.result.originalFile ?? '')
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.staged !== true) {
      await recordEdit($, ran.result.filePath, ran.result.type === 'create' ? '' : ran.result.originalFile)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.error === undefined) {
      await recordEdit($, ran.result.notebook_path, ran.result.original_file)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    // The footer keys answer their hotkeys only; the ring stays on the lines.
    if (e.element?.startsWith('key-')) return { deny: 'redpen: 단축키 안내는 포커스를 받지 않습니다.' }
    // The ring moves first, ▶ after it, and only where it landed. Moving ▶ first redraws the
    // window before the move, and the move then lands by its place among the redrawn Buttons.
    const moved = await next(e)
    if (moved.deny !== undefined) return moved
    // ▶ is where the ring is: one position, so Enter always acts where ▶ points.
    const line = /^L(\d+)$/.exec(e.element ?? '')
    const comment = /^C(.+)$/.exec(e.element ?? '')
    if (line) await setDoc($, v => ({ ...v, cursor: Number(line[1]), focused: null }))
    // The list keeps its own cursor, so its window can follow the ring.
    const file = /^F(\d+)$/.exec(e.element ?? '')
    const entry = e.element === 'reply' ? 0 : file ? Number(file[1]) + 1 : null
    if (entry !== null) await update($, view, v => (v.screen === 'list' ? { ...v, cursor: entry } : v))
    if (comment) {
      const v = await read($, view)
      if (v.screen === 'doc') {
        // The cursor goes to the comment's line, so the title and a range follow it.
        const l = layout(v, await read($, comments), await shown($, v))
        const row =[...l.attached].find(([, list]) => list.some(({ c }) => c.id === comment[1]))?.[0]
        await setDoc($, d => ({ ...d, cursor: row ?? d.cursor, focused: comment[1]! }))
      }
    }
    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>redpen은 터미널과 데스크톱에서만 동작합니다.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    const v = await read($, view)
    const all = await read($, comments)
    const last = await read($, sent)
    const cwd = await $.session.cwd()

    // The prompt sent is in the conversation; the header only says when, and how many.
    const header = (
      <Text bold wrap="truncate-end">
        Redpen · 코멘트 {all.length}개{last ? ` · 마지막 전송 ${clock(last.at)} (${last.count}개)` : ''}
      </Text>
    )
    // A described key, as Texts: a Button would join the ring that ↑ and ↓ move along.
    const keyHint = ([key, text]: KeyHint) => (
      <Box>
        <Text color={KEY_COLOR}>{key}</Text>
        <Text>{`: ${text}`}</Text>
      </Box>
    )
    const paneKeys = (
      <Box flexWrap="wrap" columnGap={2}>
        {PANE_KEYS.map(keyHint)}
      </Box>
    )

    if (v.screen === 'list') {
      // Two parts: the files the recent turn changed, each opening as that turn's diff; then
      // every other file of the session, changed earlier or holding comments alone, latest
      // first (by its last change, else its last comment), each opening whole.
      const changed = (await read($, recent))?.files ?? []
      const lastChange = new Map((await read($, edited)).map(f => [f.path, f.at]))
      const lastComment = new Map<string, number>()
      for (const c of all) {
        if (c.kind !== 'reply') lastComment.set(c.path, Math.max(lastComment.get(c.path) ?? 0, c.at ?? 0))
      }
      const when = (path: string) => lastChange.get(path) ?? lastComment.get(path) ?? 0
      const earlier = [...new Set([...lastChange.keys(), ...lastComment.keys()])]
        .filter(path => !changed.some(f => f.path === path))
        .sort((a, b) => when(b) - when(a))
      const entries: { path: string; source: Source }[] = [
        ...changed.map(f => ({ path: f.path, source: { kind: 'diff', path: f.path, base: f.base } as Source })),
        ...earlier.map(path => ({ path, source: { kind: 'file', path } as Source })),
      ]
      const count = (path: string) => all.filter(c => c.path === path).length
      const home = (await $.env.get('HOME')) ?? ''
      // The count always shows; the path takes the room left.
      const entryLabel = (entry: { path: string }) => {
        const suffix = ` · 코멘트 ${count(entry.path)}`
        return `${fitPath(relative(entry.path, cwd), home, Math.max(1, width - 1 - cells(suffix)))}${suffix}`
      }
      // The entries the ring moves along, one row each: the reply, then the files.
      const total = 1 + entries.length
      const cursor = Math.max(0, Math.min(v.cursor ?? 0, total - 1))
      const keyOf = (k: number) => (k === 0 ? 'reply' : `F${k - 1}`)
      // The ring starts on the cursor's entry, as it starts on the cursor line in a document;
      // on the path input while it is open.
      const typing = v.path
      const offers = typing === undefined ? [] : await pathOffers($, typing.text)
      const item = (k: number) =>
        k === 0 ? (
          <Button
            plain
            key="reply"
            autoFocus={(k === cursor && typing === undefined) || undefined}
            label={cut(`${REPLY} · 코멘트 ${count(REPLY)}`, Math.max(1, width - 3))}
            onPress={() => openReply($)}
          />
        ) : (
          <Button
            plain
            key={`F${k - 1}`}
            autoFocus={(k === cursor && typing === undefined) || undefined}
            label={entryLabel(entries[k - 1]!)}
            onPress={() => openDoc($, entries[k - 1]!.source)}
          />
        )

      // As in a document, the tree must never be taller than the pane, or the arrows scroll it.
      // While every entry fits, the list shows whole, the blank rows giving way first. Past
      // that the entries show in a window around the cursor, without the blank rows and the
      // titles, and the rest give way in order: the pane's keys and the path input's offers,
      // the header, the keys' hint. The window keeps five entries' room while the pane's keys
      // show; then the cursor's entry and one past each end of it, the least ↑ and ↓ need.
      type Parts = { header: boolean; gaps: boolean; hint: boolean; keys: boolean }
      const pathTitle = typing?.error ?? '열 파일 경로 · 빈 Enter 취소'
      // The footer: the hotkeys, or while it is open the path input, its title and its offers.
      const footerRows = (p: Parts) =>
        typing !== undefined
          ? wrapRows(pathTitle, width).length + 1 + (p.keys ? offers.length : 0)
          : flowRows(
              [...(p.hint ? LIST_KEYS.map(hintWidth) : []), cells('1: 경로로 열기'), cells(`0: 전송 (${all.length})`)],
              2,
              width,
            )
      // Each part's title, the first's note when it is empty; a blank row before the second.
      const titleRows = (changed.length === 0 ? 2 : 1) + (earlier.length > 0 ? 1 : 0)
      const gapRows = earlier.length > 0 ? 4 : 3
      const chrome = (p: Parts, windowed: boolean) =>
        (p.header ? 1 : 0) +
        (p.gaps && !windowed ? gapRows : 0) +
        (windowed ? 0 : titleRows) +
        footerRows(p) +
        (p.keys ? paneKeyRows(width) : 0)
      const every: Parts = { header: true, gaps: true, hint: true, keys: true }
      const bare: Parts = { ...every, gaps: false }
      const least = Math.min(3, total)
      const plans: [Parts, boolean, number][] = [
        [every, false, total],
        [bare, false, total],
        [bare, true, Math.min(5, total)],
        [{ ...bare, keys: false }, true, least],
        [{ ...bare, keys: false, header: false }, true, least],
        [{ header: false, gaps: false, hint: false, keys: false }, true, least],
      ]
      // One spare row in case the footer wraps one row more than counted.
      const plan = plans.find(([p, windowed, need]) => bodyRows - chrome(p, windowed) - 1 >= need)
      if (plan === undefined) {
        lastRing = ''
        return (
          <Text color="warning" wrap="truncate-end">
            pane 높이가 부족합니다. 창을 키우거나 Ctrl+X X로 닫으세요.
          </Text>
        )
      }
      const [parts, windowed] = plan
      // The window: as many entries as the room holds, the cursor's away from its ends.
      const room = windowed ? Math.min(total, bodyRows - chrome(parts, true) - 1) : total
      const top = Math.max(0, Math.min(cursor - Math.floor((room - 1) / 2), total - room))
      const shown = Array.from({ length: room }, (_, k) => top + k)
      // While the path input is open the ring is the person's to move, as in a comment input.
      pinRing($, shown.map(keyOf).join(' '), typing === undefined ? keyOf(cursor) : null, e.props.isFocused)

      return (
        <Box flexDirection="column">
          {parts.header && header}
          {parts.gaps && <Text> </Text>}
          {windowed ? (
            shown.map(item)
          ) : (
            <Box flexDirection="column">
              {item(0)}
              {parts.gaps && <Text> </Text>}
              <Text bold>최근 수정</Text>
              {changed.length === 0 && <Text dimColor>  없음. /redpen &lt;path&gt; 로 임의 파일을 열 수 있습니다.</Text>}
              {changed.map((_, i) => item(i + 1))}
              {earlier.length > 0 && parts.gaps && <Text> </Text>}
              {earlier.length > 0 && <Text bold>파일 목록</Text>}
              {earlier.map((_, i) => item(changed.length + i + 1))}
            </Box>
          )}
          {parts.gaps && <Text> </Text>}
          {typing !== undefined ? (
            <Box flexDirection="column">
              <Text color={typing.error === null ? undefined : 'warning'}>{pathTitle}</Text>
              <Input
                key="path-input"
                placeholder="경로 입력 후 Enter"
                value={typing.text}
                submitLabel="열기"
                autoFocus
                onInput={value => void setPath($, { text: value, error: null })}
                onSubmit={value => void submitPath($, value)}
              />
              {parts.keys &&
                offers.map((offer, i) => (
                  <Button
                    plain
                    key={`O${i}`}
                    dimColor
                    label={cut(`${offer.opened ? '↺' : ' '} ${offer.label}`, Math.max(1, width - 1))}
                    onPress={() => void pickOffer($, offer)}
                  />
                ))}
            </Box>
          ) : (
            <Box flexWrap="wrap" columnGap={2}>
              {parts.hint && LIST_KEYS.map(keyHint)}
              <Button
                plain
                key="key-1"
                hotkey="1"
                label="경로로 열기"
                onPress={() => void (setPath($, { text: '', error: null }).then(() => focus($, 'path-input')))}
              />
              <Button plain key="key-0" hotkey="0" label={`전송 (${all.length})`} onPress={() => void submit($)} />
            </Box>
          )}
          {parts.keys && paneKeys}
        </Box>
      )
    }

    const loaded = await loadDoc($, v.source, v.whole === true)
    drawn = { key: drawnKey(v), doc: loaded }
    const { doc, rows, cursor, selFrom, selTo, attached, away, range } = layout(v, all, loaded)

    // Where the ring starts when the pane takes the keyboard (ctrl+x tab, a click):
    // the focused comment, else the cursor line. An open Input keeps its own autoFocus.
    // ▶ sits on the focused comment's row while a comment row has the ring, else on the cursor line.
    const focusedHere = all.some(c => c.id === v.focused)
    const start = v.composing !== null ? null : focusedHere ? `C${v.focused}` : `L${cursor}`

    // A comment's rows: the marker takes the focus ring, the text in its own color so it
    // reads apart from the document, split to the pane's width under the marker.
    const commentRows = (c: Comment, indent: string, text: string) =>
      wrapRows(`${text}${c.text.replace(/\n/g, ' ')}`, width - cells(indent) - 5)
    // A comment as screen rows, one element each.
    const commentLines = (c: Comment, indent: string, mark: string, text: string) => {
      const style = { color: 'suggestion', bold: c.id === v.focused, wrap: 'truncate-end' } as const
      const [first, ...more] = commentRows(c, indent, text)
      return [
        <Box>
          <Text color="claude">{c.id === v.focused ? '▶' : ' '}</Text>
          <Text>{indent.slice(1)}</Text>
          <Button
            plain
            key={`C${c.id}`}
            autoFocus={start === `C${c.id}` || undefined}
            dimColor={c.id !== v.focused}
            label={mark}
            onPress={() => compose($, { editId: c.id })}
          />
          <Text {...style}>{` ${first}`}</Text>
        </Box>,
        ...more.map(row => <Text {...style}>{`${indent}  ${row}`}</Text>),
      ]
    }

    // The footer, with or without the hint before the hotkeys, and the rows it takes.
    let footerFor: (hint: boolean) => { el: JSX.Element; rows: number }
    const rangeText = lineSpan(range)
    if (v.composing !== null) {
      const composing = v.composing
      const editing = 'editId' in composing ? all.find(c => c.id === composing.editId) : undefined
      // The lines fixed when Enter opened the input, which ▶ moving since does not change.
      const target = 'lines' in composing ? composing.lines : range
      const composeTitle = editing
        ? '코멘트 수정 · 모두 지우고 Enter 삭제'
        : `코멘트 ${target.side === 'old' ? '(삭제된 줄) ' : ''}L${lineSpan(target)} · 빈 Enter 취소`
      const input = {
        el: (
          <Box flexDirection="column">
            <Text>{composeTitle}</Text>
            <Input
              key="comment-input"
              placeholder="코멘트 입력 후 Enter"
              value={editing?.text ?? ''}
              submitLabel="저장"
              autoFocus
              onSubmit={value => save($, value)}
            />
          </Box>
        ),
        rows: wrapRows(composeTitle, width).length + 1,
      }
      footerFor = () => input
    } else {
      // Digits, which the Korean input method passes through as typed. Moving and
      // commenting take ↑↓ and Enter.
      const keys: [string, string, () => unknown][] = [
        ['1', '목록', () => update($, view, (): View => ({ screen: 'list' }))],
        ...(v.source.kind === 'diff'
          ? [['2', v.whole ? '바뀐 부분만' : '전체 보기', () => toggleWhole($)] as [string, string, () => unknown]]
          : []),
        ['3', v.anchor === null ? '범위' : '범위 해제', () => toggleRange($)],
        ['0', `전송 (${all.length})`, () => submit($)],
      ]
      const keyWidths = keys.map(([hotkey, label]) => cells(`${hotkey}: ${label}`))
      footerFor = hint => ({
        el: (
          <Box flexWrap="wrap" columnGap={2}>
            {hint && DOC_KEYS.map(keyHint)}
            {keys.map(([hotkey, label, run]) => (
              <Button plain key={`key-${hotkey}`} hotkey={hotkey} label={label} onPress={() => void run()} />
            ))}
          </Box>
        ),
        rows: flowRows([...(hint ? DOC_KEYS.map(hintWidth) : []), ...keyWidths], 2, width),
      })
    }

    const lineNo = (r: Row) => (r.kind === 'gap' ? '' : String(r.newLine ?? r.oldLine))
    // reduce, not Math.max(...): spreading a hundred thousand rows overflows the call stack.
    const gutter = rows.reduce((n, r) => Math.max(n, lineNo(r).length), 1)
    const title = v.source.kind === 'reply' ? REPLY : relative(v.source.path, cwd)
    // The note and the count of comments that lost their place.
    const noteRows = (doc.note ? wrapRows(doc.note, width).length : 0) + (away.length > 0 ? 1 : 0)
    const awayLines = away.slice(0, 5).flatMap(({ c, why }) => commentLines(c, '  ', '?', `${why} · `))
    // The tree must never be taller than the pane: past it the arrows scroll the pane instead
    // of moving the ring, and the ring leaves ▶ behind. The parts besides the lines and the
    // title, and the order they give way in when the pane is short: the comments that lost
    // their place, the rule and the pane's keys, the notes, the header, the footer's hint.
    // The first two keep five lines' room; the rest the ▶ line and one past each end of it,
    // the least ↑ and ↓ need to move.
    type Parts = { away: boolean; keys: boolean; notes: boolean; header: boolean; hint: boolean }
    const chrome = (p: Parts) =>
      (p.header ? 1 : 0) +
      1 +
      (p.notes ? noteRows : 0) +
      (p.away ? awayLines.length : 0) +
      footerFor(p.hint).rows +
      (p.keys ? 1 + paneKeyRows(width) : 0)
    const every: Parts = { away: true, keys: true, notes: true, header: true, hint: true }
    const least = Math.min(3, Math.max(1, rows.filter(isLine).length))
    const plans: [Parts, number][] = [
      [every, 5],
      [{ ...every, away: false }, 5],
      [{ ...every, away: false, keys: false }, least],
      [{ ...every, away: false, keys: false, notes: false }, least],
      [{ ...every, away: false, keys: false, notes: false, header: false }, least],
      [{ away: false, keys: false, notes: false, header: false, hint: false }, least],
    ]
    // One spare row in case the footer wraps one row more than counted.
    const parts = plans.find(([p, need]) => bodyRows - chrome(p) - 1 >= need)?.[0]
    if (parts === undefined) {
      // Too short for even that: one row saying so, and the comment input if one is open, so
      // a comment being written stays. Nothing to scroll, and no ring to put back.
      lastRing = ''
      return (
        <Box flexDirection="column">
          <Text color="warning" wrap="truncate-end">
            pane 높이가 부족합니다. 창을 키우거나 Ctrl+X X로 닫으세요.
          </Text>
          {v.composing !== null && footerFor(false).el}
        </Box>
      )
    }
    const room = Math.max(1, bodyRows - chrome(parts) - 1)
    // Line i's text after "▶", the number and " + ", split to the pane's width; each line
    // is split once per drawing, however often the window and the blocks ask for it.
    const split = new Map<number, string[]>()
    const lineRows = (i: number) => {
      let out = split.get(i)
      if (!out) {
        const row = rows[i]!
        out = row.kind === 'gap' ? [''] : wrapRows(row.text.replace(/\t/g, '  ') || ' ', width - gutter - 5)
        split.set(i, out)
      }
      return out
    }
    const indent = ' '.repeat(gutter + 2)
    const heights = new Map<number, number>()
    const height = (i: number) => {
      let h = heights.get(i)
      if (h === undefined) {
        h =
          lineRows(i).length +
          (attached.get(i) ?? []).reduce((n, { c, start }) => n + commentRows(c, indent, `L${span(start, c)} `).length, 0)
        heights.set(i, h)
      }
      return h
    }
    // ↑ and ↓ move the ring only between the Buttons drawn, so the window always shows a line
    // past each end of it: the rows up to the nearest line there (a gap first, if one is in the
    // way), each cut to its first row. These are the edges a window from t to b needs; `tight`
    // ones leave the gap out, the line's number telling the lines between are folded.
    const above = (t: number, tight = false) =>
      t === 0 ? [] : rows[t - 1]!.kind !== 'gap' || t === 1 ? [t - 1] : tight ? [t - 2] : [t - 2, t - 1]
    const below = (b: number, tight = false) =>
      b === rows.length - 1
        ? []
        : rows[b + 1]!.kind !== 'gap' || b === rows.length - 2
          ? [b + 1]
          : tight
            ? [b + 2]
            : [b + 1, b + 2]
    const edges = (t: number, b: number, tight = false) => above(t, tight).length + below(b, tight).length
    let top = cursor
    let bottom = cursor
    let used = rows.length > 0 ? height(cursor) : 0
    for (let grew = rows.length > 0; grew; ) {
      grew = false
      if (bottom + 1 < rows.length && used + height(bottom + 1) + edges(top, bottom + 1) <= room)
        used += height(++bottom), (grew = true)
      if (top > 0 && used + height(top - 1) + edges(top - 1, bottom) <= room) used += height(--top), (grew = true)
    }
    // In a room too small for them, the edges drop their gaps, then give way to the ▶ line.
    const loose = room > edges(top, bottom)
    const tight = !loose && room > edges(top, bottom, true)
    const withEdges = rows.length > 0 && (loose || tight)
    const edgeTop = withEdges ? above(top, tight) : []
    const edgeBottom = withEdges ? below(bottom, tight) : []
    const inner = room - edgeTop.length - edgeBottom.length

    // One line and its comments as screen rows, one element each.
    const block = (i: number) => {
      const row = rows[i]!
      if (row.kind === 'gap') return [<Text dimColor>{' '.repeat(gutter + 2)}⋯</Text>]
      const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
      const style = {
        wrap: 'truncate-end',
        inverse: v.anchor !== null && i >= selFrom && i <= selTo,
        bold: i === cursor,
        color: row.kind === 'add' ? 'success' : row.kind === 'del' ? 'error' : undefined,
      } as const
      const [first, ...more] = lineRows(i)
      return [
        <Box>
          <Text color="claude">{i === cursor && !focusedHere ? '▶' : ' '}</Text>
          <Button
            plain
            key={`L${i}`}
            autoFocus={start === `L${i}` || undefined}
            dimColor={i !== cursor}
            label={lineNo(row).padStart(gutter)}
            onPress={() => pressLine($, i)}
          />
          <Text {...style}>{` ${mark} ${first}`}</Text>
        </Box>,
        ...more.map(text => <Text {...style}>{`${' '.repeat(gutter + 4)}${text}`}</Text>),
        ...(attached.get(i) ?? []).flatMap(({ c, start }) => commentLines(c, indent, '└', `L${span(start, c)} `)),
      ]
    }
    let body = rows.length > 0 ? Array.from({ length: bottom - top + 1 }, (_, k) => block(top + k)).flat() : []
    if (body.length > inner) {
      // The ▶ line alone is taller than the room: show the part of it that holds ▶, the
      // line's first row or the focused comment's.
      let at = 0
      if (focusedHere) {
        at = lineRows(cursor).length
        for (const { c, start } of attached.get(cursor) ?? []) {
          if (c.id === v.focused) break
          at += commentRows(c, indent, `L${span(start, c)} `).length
        }
      }
      const from = at >= inner ? at - inner + 1 : 0
      body = block(cursor).slice(from, from + inner)
    }
    body = [...edgeTop.map(i => block(i)[0]!), ...body, ...edgeBottom.map(i => block(i)[0]!)]

    const edgeKeys = (list: number[]) => list.filter(i => isLine(rows[i])).map(i => `L${i}`)
    const ring = [
      ...(parts.away ? away.slice(0, 5).map(({ c }) => `C${c.id}`) : []),
      ...edgeKeys(edgeTop),
      ...Array.from({ length: Math.max(0, bottom - top + 1) }, (_, k) => [
        `L${top + k}`,
        ...(attached.get(top + k) ?? []).map(({ c }) => `C${c.id}`),
      ]).flat(),
      ...edgeKeys(edgeBottom),
    ].join(' ')
    pinRing($, ring, start, e.props.isFocused)

    return (
      <Box flexDirection="column">
        {parts.header && header}
        <Text bold wrap="truncate-end">
          {title}
          {v.whole ? ' · 전체' : ''}
          {rows.length > 0 ? ` · L${lineNo(rows[cursor]!)}` : ''}
          {v.anchor !== null ? ` · 범위 ${rangeText}` : ''}
        </Text>
        {parts.notes && doc.note && <Text color="warning">{doc.note}</Text>}
        {parts.notes && away.length > 0 && <Text color="warning">표시되지 않은 코멘트 {away.length}개</Text>}
        {parts.away && awayLines}
        {body}
        {/* The document runs down to the footer, so a rule sets the keys apart from it. ASCII,
            one cell wide on every terminal, so it spans the pane and never wraps. */}
        {parts.keys && (
          <Text dimColor wrap="truncate-end">
            {'-'.repeat(width)}
          </Text>
        )}
        {footerFor(parts.hint).el}
        {parts.keys && paneKeys}
      </Box>
    )
  })
}

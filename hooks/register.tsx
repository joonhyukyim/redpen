import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Comment, Composing, Sent, Source, TurnFile, View } from '../types'
import { diffRows, splitLines } from './diff'
import type { Row } from './diff'
import { cells, cut, wrapRows } from './text'

type Engine = EngineInterface
type Doc = Extract<View, { screen: 'doc' }>

const PANE = 'redpen'
const REPLY = 'Claude 마지막 답변'
const EXCERPT_MAX = 8
const HINT = '↑↓ 이동 · Enter 코멘트 작성/수정'
const HEADER = '다음 리뷰 코멘트를 모두 반영해서 수정해줘. 코멘트가 지적한 부분 외에는 건드리지 마.'

const pending = atom({ plugin: 'redpen', key: 'pending' } as const, [] as TurnFile[])
const lastTurn = atom({ plugin: 'redpen', key: 'lastTurn' } as const, [] as TurnFile[])
const view = atom({ plugin: 'redpen', key: 'view' } as const, { screen: 'list' } as View)
const comments = atom({ plugin: 'redpen', key: 'comments' } as const, [] as Comment[])
const sent = atom({ plugin: 'redpen', key: 'sent' } as const, null as Sent | null)

// The path's stat with where it lands: absolute, links followed, . and .. folded.
const statPath = ($: Engine, path: string) => $.fs.stat(path, { resolve: true }).catch(() => undefined)

async function recordEdit($: Engine, filePath: string, base: string | null) {
  // Kept as /redpen <path> resolves it, so both name a file the same way.
  const path = (await statPath($, filePath))?.realPath ?? filePath
  await update($, pending, list => (list.some(f => f.path === path) ? list : [...list, { path, base }]))
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
    $.ui.toast('redpen: 보낼 코멘트가 없습니다.')
    return
  }
  const putBack = () => update($, comments, now => [...list, ...now])
  let text: string
  try {
    text = await buildPrompt($, list)
  } catch {
    await putBack()
    $.ui.toast('redpen: 프롬프트를 만들지 못했습니다.')
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
    result => ('drop' in result && result.drop !== undefined ? undo(`redpen: 전송이 거절되었습니다: ${result.drop}`) : undefined),
    () => undo('redpen: 전송하지 못했습니다.'),
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
  if (text === null) $.ui.toast('redpen: Claude의 답변이 아직 없습니다.')
  else await openDoc($, { kind: 'reply', text })
}

// The Buttons the document drew last, in order. See where the window is drawn.
let lastRing = ''

async function openReview($: Engine, args: string) {
  const arg = args.trim()
  if (arg === '') {
    await update($, view, (): View => ({ screen: 'list' }))
  } else {
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    const given = arg.startsWith('/') ? arg : (arg === '~' || arg.startsWith('~/')) && home !== '' ? home + arg.slice(1) : `${cwd}/${arg}`
    const stat = await statPath($, given)
    if (stat === undefined) return { text: `redpen: ${arg} 파일이 없습니다.` }
    if (stat.kind !== 'file') return { text: `redpen: ${arg} 은(는) 파일이 아닙니다.` }
    const path = stat.realPath ?? given
    const changed = (await read($, lastTurn)).find(f => f.path === path)
    await openDoc($, changed ? { kind: 'diff', path, base: changed.base } : { kind: 'file', path })
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

// Best effort: the ring cannot move while the pane does not hold the keyboard.
const focus = ($: Engine, key: string) => void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

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

  on('turn.start', async ($, e, next) => {
    await update($, pending, () => [])
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const files = await read($, pending)
    if (e.agentId === undefined && files.length > 0) await update($, lastTurn, () => files)
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
    // ▶ is where the ring is: one position, so Enter always acts where ▶ points.
    const line = /^L(\d+)$/.exec(e.element ?? '')
    const comment = /^C(.+)$/.exec(e.element ?? '')
    if (line) await setDoc($, v => ({ ...v, cursor: Number(line[1]), focused: null }))
    if (comment) {
      const v = await read($, view)
      if (v.screen === 'doc') {
        // The cursor goes to the comment's line, so the title and a range follow it.
        const l = layout(v, await read($, comments), await shown($, v))
        const row =[...l.attached].find(([, list]) => list.some(({ c }) => c.id === comment[1]))?.[0]
        await setDoc($, d => ({ ...d, cursor: row ?? d.cursor, focused: comment[1]! }))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>redpen은 터미널과 데스크톱에서만 동작합니다.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const v = await read($, view)
    const all = await read($, comments)
    const last = await read($, sent)
    const cwd = await $.session.cwd()

    // The prompt sent is in the conversation; the header only says when, and how many.
    const header = (
      <Text bold wrap="truncate-end">
        redpen · 코멘트 {all.length}개{last ? ` · 마지막 전송 ${clock(last.at)} (${last.count}개)` : ''}
      </Text>
    )

    if (v.screen === 'list') {
      const changed = await read($, lastTurn)
      const others = [...new Set(all.filter(c => c.kind !== 'reply').map(c => c.path))].filter(
        path => !changed.some(f => f.path === path),
      )
      const entries: { path: string; source: Source; tag: string }[] = [
        ...changed.map(f => ({
          path: f.path,
          source: { kind: 'diff', path: f.path, base: f.base } as Source,
          tag: f.base === '' ? 'new' : 'edited',
        })),
        ...others.map(path => ({ path, source: { kind: 'file', path } as Source, tag: 'commented' })),
      ]
      const count = (path: string) => all.filter(c => c.path === path).length
      const home = (await $.env.get('HOME')) ?? ''
      // The tag and the count always show; the path takes the room left after "2: ".
      const entryLabel = (entry: { path: string; tag: string }) => {
        const suffix = ` (${entry.tag}) · 코멘트 ${count(entry.path)}`
        return `${fitPath(relative(entry.path, cwd), home, Math.max(1, width - 4 - cells(suffix)))}${suffix}`
      }
      return (
        <Box flexDirection="column">
          {header}
          <Text> </Text>
          {/* The reply is always 1 and the ring starts on it, as it starts on the cursor line in a document. */}
          <Button
            plain
            key="reply"
            autoFocus
            hotkey="1"
            label={`${REPLY} · 코멘트 ${count(REPLY)}`}
            onPress={() => openReply($)}
          />
          <Text> </Text>
          <Text bold>파일 목록</Text>
          {changed.length === 0 && <Text dimColor>  없음. /redpen &lt;path&gt; 로 임의 파일을 열 수 있습니다.</Text>}
          {entries.map((entry, i) => (
            <Button
              plain
              key={`F${i}`}
              hotkey={i < 8 ? String(i + 2) : undefined}
              label={entryLabel(entry)}
              onPress={() => openDoc($, entry.source)}
            />
          ))}
          <Text> </Text>
          <Box flexWrap="wrap" columnGap={2}>
            <Text dimColor>1 마지막 답변 열기 · 2-9 파일 열기</Text>
            <Button plain key="key-0" hotkey="0" label={`전송 (${all.length})`} onPress={() => void submit($)} />
            <Text dimColor>Esc 프롬프트로</Text>
          </Box>
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

    let footer
    let footerRows = 2
    const rangeText = lineSpan(range)
    if (v.composing !== null) {
      const composing = v.composing
      const editing = 'editId' in composing ? all.find(c => c.id === composing.editId) : undefined
      // The lines fixed when Enter opened the input, which ▶ moving since does not change.
      const target = 'lines' in composing ? composing.lines : range
      const composeTitle = editing
        ? '코멘트 수정 · 모두 지우고 Enter 삭제'
        : `코멘트 ${target.side === 'old' ? '(삭제된 줄) ' : ''}L${lineSpan(target)} · 빈 Enter 취소`
      footerRows = wrapRows(composeTitle, width).length + 1
      footer = (
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
      )
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
      footer = (
        <Box flexWrap="wrap" columnGap={2}>
          <Text dimColor>{HINT}</Text>
          {keys.map(([hotkey, label, run]) => (
            <Button plain key={`key-${hotkey}`} hotkey={hotkey} label={label} onPress={() => void run()} />
          ))}
        </Box>
      )
      footerRows = flowRows([cells(HINT), ...keys.map(([hotkey, label]) => cells(`${hotkey}: ${label}`))], 2, width)
    }

    const lineNo = (r: Row) => (r.kind === 'gap' ? '' : String(r.newLine ?? r.oldLine))
    // reduce, not Math.max(...): spreading a hundred thousand rows overflows the call stack.
    const gutter = rows.reduce((n, r) => Math.max(n, lineNo(r).length), 1)
    const title = v.source.kind === 'reply' ? REPLY : relative(v.source.path, cwd)
    const bodyRows = e.props.scroll.bodyRows
    const noteRows = doc.note ? wrapRows(doc.note, width).length : 0
    const awayLines = away.slice(0, 5).flatMap(({ c, why }) => commentLines(c, '  ', '?', `${why} · `))
    // The tree must never be taller than the pane: past it the pane scrolls on its own and
    // the ring leaves ▶ behind. When the pane is short, the comments that lost their place
    // give way first, then the document shows fewer rows.
    const chrome = (full: boolean) =>
      1 +
      1 +
      noteRows +
      (away.length > 0 ? 1 + (full ? awayLines.length : 0) : 0) +
      footerRows
    // One spare row in case the footer wraps one row more than counted.
    const full = bodyRows - chrome(true) - 1 >= 5
    const room = Math.max(1, bodyRows - chrome(full) - 1)
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
    // way), each cut to its first row. These are the edges a window from t to b needs.
    const above = (t: number) => (t === 0 ? [] : rows[t - 1]!.kind !== 'gap' || t === 1 ? [t - 1] : [t - 2, t - 1])
    const below = (b: number) =>
      b === rows.length - 1 ? [] : rows[b + 1]!.kind !== 'gap' || b === rows.length - 2 ? [b + 1] : [b + 1, b + 2]
    const edges = (t: number, b: number) => above(t).length + below(b).length
    let top = cursor
    let bottom = cursor
    let used = rows.length > 0 ? height(cursor) : 0
    for (let grew = rows.length > 0; grew; ) {
      grew = false
      if (bottom + 1 < rows.length && used + height(bottom + 1) + edges(top, bottom + 1) <= room)
        used += height(++bottom), (grew = true)
      if (top > 0 && used + height(top - 1) + edges(top - 1, bottom) <= room) used += height(--top), (grew = true)
    }
    // In a room too small for them, the edges give way to the ▶ line.
    const withEdges = rows.length > 0 && room > edges(top, bottom)
    const edgeTop = withEdges ? above(top) : []
    const edgeBottom = withEdges ? below(bottom) : []
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

    // The pane keeps the ring on a Button by its place among the Buttons drawn, not by its key:
    // when the window gains or loses a line above ▶, the ring lands on a neighbour and no
    // ui.focus is raised. Whenever the drawn Buttons change, put the ring back on ▶'s element
    // once this drawing is on screen.
    const edgeKeys = (list: number[]) => list.filter(i => isLine(rows[i])).map(i => `L${i}`)
    const ring = [
      ...(full ? away.slice(0, 5).map(({ c }) => `C${c.id}`) : []),
      ...edgeKeys(edgeTop),
      ...Array.from({ length: Math.max(0, bottom - top + 1) }, (_, k) => [
        `L${top + k}`,
        ...(attached.get(top + k) ?? []).map(({ c }) => `C${c.id}`),
      ]).flat(),
      ...edgeKeys(edgeBottom),
    ].join(' ')
    if (ring !== lastRing && e.props.isFocused && start !== null) {
      const key = start
      void $.clock.sleep(0).then(() => focus($, key))
    }
    lastRing = ring

    return (
      <Box flexDirection="column">
        {header}
        <Text bold wrap="truncate-end">
          {title}
          {v.whole ? ' · 전체' : ''}
          {rows.length > 0 ? ` · L${lineNo(rows[cursor]!)}` : ''}
          {v.anchor !== null ? ` · 범위 ${rangeText}` : ''}
        </Text>
        {doc.note && <Text color="warning">{doc.note}</Text>}
        {away.length > 0 && <Text color="warning">표시되지 않은 코멘트 {away.length}개</Text>}
        {full && awayLines}
        {body}
        {footer}
      </Box>
    )
  })
}

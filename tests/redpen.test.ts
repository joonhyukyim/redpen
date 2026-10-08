import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { diffRows, splitLines } from '../hooks/diff'
import { cells, cut, wrapRows } from '../hooks/text'

const CWD = '/repo'
const FILE = '/repo/src/foo.ts'
const RELEASE_NOTES = `# 10월 3주차 릴리스 노트

배포일: 2026년 10월 20일(화) 14:00

## 새 기능

- 주문 목록에서 배송 상태로 필터링할 수 있습니다.
- 관리자 페이지에 일별 매출 그래프를 추가했습니다.
- 상품 상세 화면에서 리뷰를 최신순, 평점순으로 정렬할 수 있습니다.

## 개선

- 상품 검색 응답 시간을 평균 820ms에서 310ms로 줄였습니다.
- 결제 실패 시 오류 메시지에 실패 사유 코드를 함께 표시합니다.
- 이미지 업로드 최대 크기를 5MB에서 10MB로 늘렸습니다.

## 버그 수정

- 장바구니에 같은 상품을 두 번 담으면 수량이 1로 초기화되던 문제를 수정했습니다.
- iOS 앱에서 쿠폰 적용 후 결제 금액이 갱신되지 않던 문제를 수정했습니다.
- 관리자 페이지에서 엑셀 내보내기 시 한글 파일명이 깨지던 문제를 수정했습니다.

## 알려진 문제

- Android 12 이하에서 푸시 알림 아이콘이 회색으로 표시됩니다. 다음 릴리스에서 수정할 예정입니다.

## 문의

#release 채널에 남겨 주세요.
`
const BEFORE = ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n'
const AFTER = ['a', 'b', 'helper()', 'c', 'd', 'e'].join('\n') + '\n'

const PANE = {
  plugin: 'redpen',
  component: 'Pane',
  requestId: 'redpen',
  props: {
    title: 'redpen',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 120, rows: 40 },
} as const

// Sleeps redpen asked for: one per drawing whose Buttons changed, before the ring goes back
// on ▶. Each test's engine() starts it empty.
const sleeps: number[] = []
// The ring's moves under a person's arrow and ▶'s, in the order they reached the engine, and
// the denials the engine gives the next moves, one each. Each test's engine() starts them empty.
const moves: string[] = []
const focusDenials: string[] = []

// The engine beneath the plugin: a file map, a prompt log, and the session's other answers.
// `base` is the file before the turn's Edit.
function engine(on: On, files: Record<string, string>, base = BEFORE) {
  sleeps.length = 0
  moves.length = 0
  focusDenials.length = 0
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: '/home' }))
  // A file's real path: absolute, . and .. folded. A path with files under it is a directory.
  on('fs.stat', ($, e) => {
    const real = e.path.split('/').reduce<string[]>((out, part) => {
      if (part === '..') out.pop()
      else if (part !== '.' && part !== '') out.push(part)
      return out
    }, []).join('/')
    const path = `/${real}`
    if (path in files) return { value: { kind: 'file', size: files[path]!.length, mtimeMs: 0, isLink: false, realPath: path } }
    if (Object.keys(files).some(f => f.startsWith(`${path}/`))) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: path } }
    return { deny: 'ENOENT' }
  })
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'no such file' }))
  // A minute later at each call, so changes and comments have an order.
  let now = Date.UTC(2026, 9, 7, 1, 2)
  on('clock.now', () => ({ value: (now += 60_000) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', ($, e) => {
    if (e.origin.kind === 'person') moves.push(`ring ${e.element}`)
    const deny = focusDenials.shift()
    return deny === undefined ? {} : { deny }
  })
  on('state.set', ($, e, next) => {
    const write = e as { key: string; value?: { cursor?: number } }
    if (write.key === 'view' && write.value?.cursor !== undefined) moves.push(`▶ ${write.value.cursor}`)
    return next(e)
  })
  on('clock.sleep', ($, e) => {
    sleeps.push(e.ms)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => ({
    result: {
      filePath: (e as { file_path?: string }).file_path ?? FILE,
      oldString: 'b\n',
      newString: 'b\nhelper()\n',
      originalFile: base,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    },
  }))
  return submitted
}

// The ring moving onto an element, as ↑/↓ or Tab move it.
const arrow = ($: Engine, element: string) =>
  $.ui.focus({ component: 'Pane', requestId: 'redpen', element, origin: { kind: 'person' } })

// A turn in which Claude makes one edit (by default the Edit that adds helper()), then /redpen.
async function editTurn(
  $: Engine,
  call: Parameters<Engine['tool']['call']>[0] = { tool: 'Edit', file_path: FILE, old_string: 'b\n', new_string: 'b\nhelper()\n' },
) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'edit', turnId: 't1' })
  await $.tool.call(call)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.command.run({ command: 'redpen', args: '' } as never)
}

// Rows a drawn element takes at `cols` columns, as the terminal lays it out.
type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const textOf = (el: unknown): string => (typeof el === 'string' ? el : ((el as El).children ?? []).map(textOf).join(''))
const widthOf = (el: El): number =>
  el.type === 'Button' ? cells(`${el.props?.hotkey ? `${el.props.hotkey}: ` : ''}${el.props?.label}`) : cells(textOf(el))
const rowsOf = (el: El, cols: number): number => {
  const kids = (el.children ?? []).filter((k): k is El => typeof k === 'object')
  if (el.type !== 'Box') return el.type === 'Text' && el.props?.wrap !== 'truncate-end' ? Math.ceil(cells(textOf(el)) / cols) || 1 : 1
  if (el.props?.flexWrap === 'wrap') {
    let rows = 1
    let used = 0
    for (const k of kids) {
      const w = widthOf(k)
      if (used > 0 && used + 2 + w > cols) (rows++, (used = 0))
      used += (used > 0 ? 2 : 0) + w
    }
    return rows
  }
  return el.props?.flexDirection === 'column' ? kids.reduce((n, k) => n + rowsOf(k, cols), 0) : 1
}
// The drawn row holding the Button keyed `key`.
const lineOf = (el: El, key: string): El | undefined => {
  const kids = (el.children ?? []).filter((k): k is El => typeof k === 'object')
  if (kids.some(k => k.type === 'Button' && k.props?.key === key)) return el
  for (const k of kids) {
    const found = lineOf(k, key)
    if (found) return found
  }
}

describe('text', () => {
  test('a row too narrow for a Hangul character still takes one per row and ends', () => {
    expect(wrapRows('가나', 1)).toEqual(['가', '나'])
    expect(wrapRows('ab cd', 3)).toEqual(['ab', 'cd'])
    expect(cells('a가·')).toBe(5)
  })

  test('a cut text and its … fit the width', () => {
    expect(cut('abcdef', 4)).toBe('ab…')
    expect(cells(cut('가나다라', 5))).toBeLessThanOrEqual(5)
    expect(cut('abc', 1)).toBe('')
  })
})

describe('diff', () => {
  test('marks an inserted line with context and gaps', () => {
    const rows = diffRows(splitLines(BEFORE), splitLines(AFTER), 1)
    expect(rows).toEqual([
      { kind: 'gap' },
      { kind: 'ctx', text: 'b', oldLine: 2, newLine: 2 },
      { kind: 'add', text: 'helper()', newLine: 3 },
      { kind: 'ctx', text: 'c', oldLine: 3, newLine: 4 },
      { kind: 'gap' },
    ])
  })

  test('has no rows when nothing changed', () => {
    expect(diffRows(['x'], ['x'])).toEqual([])
  })

  test('a change too large for the LCS is shown in bulk without overflowing the stack', () => {
    // A million lines in all: spread as arguments, this many overflow the stack here.
    const before = Array.from({ length: 500_000 }, (_, k) => `old ${k}`)
    const after = Array.from({ length: 500_000 }, (_, k) => `new ${k}`)
    const rows = diffRows(before, after, Infinity)
    expect(rows.length).toBe(1_000_000)
    expect(rows[0]).toEqual({ kind: 'del', text: 'old 0', oldLine: 1 })
    expect(rows[500_000]).toEqual({ kind: 'add', text: 'new 0', newLine: 1 })
  })
})

describe('review pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`comment on the added line and send it (${surface})`, async ($, on) => {
      const files: Record<string, string> = { [FILE]: AFTER }
      const submitted = engine(on, files)
      await editTurn($)

      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'F0' }))?.text).toMatch('src/foo.ts · 코멘트 0')
      await ui.press({ key: 'F0' })

      // rows: a b helper() c d e (all within 3 lines of context); row 2 is the added line
      await ui.press({ key: 'L2' })
      await ui.input({ key: 'comment-input', text: '한 번만 쓰이는 헬퍼라 인라인으로 풀어줘.' })
      expect(await ui.find({ type: 'Text', text: /코멘트 1개/ })).toBeDefined()
      expect((await ui.find({ key: 'key-0' }))?.text).toMatch('전송 (1)')

      await ui.press({ key: 'key-0' })
      expect(submitted).toEqual([
        [
          '다음 리뷰 코멘트를 모두 반영해서 수정해줘. 코멘트가 지적한 부분 외에는 건드리지 마.',
          '',
          '1. src/foo.ts:3',
          '   > helper()',
          '   한 번만 쓰이는 헬퍼라 인라인으로 풀어줘.',
        ].join('\n'),
      ])
      expect(await ui.find({ type: 'Text', text: /코멘트 0개 · 마지막 전송 \d\d:\d\d \(1개\)/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a range follows its lines when the file shifts, and is unknown once they are gone', async ($, on) => {
    const files: Record<string, string> = { [FILE]: AFTER }
    const submitted = engine(on, files)
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })

    await arrow($, 'L3')
    await ui.press({ key: 'key-3' })
    await arrow($, 'L4')
    await ui.press({ key: 'L4' })
    await ui.input({ key: 'comment-input', text: '범위 코멘트' })

    files[FILE] = 'new top\n' + AFTER
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /^ L5-6 범위 코멘트/ })).toBeDefined()

    files[FILE] = 'a\nb\n'
    await ui.redraw()
    expect(await ui.find({ text: /\? 위치 불명 · 범위 코멘트/ })).toBeDefined()

    await ui.press({ key: 'key-0' })
    expect(submitted[0]).toMatch('1. src/foo.ts (위치 불명, 원래 4-5행)\n   > c\n   > d\n   범위 코멘트')
    await ui.unmount()
  })

  test('Enter comments on a line, edits its comment, and an emptied edit deletes it', async ($, on) => {
    engine(on, { [FILE]: AFTER })
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })

    await ui.press({ key: 'L2' })
    await ui.input({ key: 'comment-input', text: '   ' })
    expect(await ui.find({ type: 'Text', text: /코멘트 0개/ })).toBeDefined()

    await ui.press({ key: 'L2' })
    await ui.input({ key: 'comment-input', text: '주석 삭제.' })
    expect(await ui.find({ type: 'Text', text: /코멘트 1개/ })).toBeDefined()

    // Enter on a line that has a comment opens that comment, its text in the field.
    await ui.press({ key: 'L2' })
    expect(await ui.find({ type: 'Text', text: /코멘트 수정 · 모두 지우고 Enter 삭제/ })).toBeDefined()
    expect((await ui.find({ key: 'comment-input' }))?.props.value).toBe('주석 삭제.')
    await ui.input({ key: 'comment-input', text: '주석 전부 삭제.' })
    // A comment's text sits beside its marker in its own color; each row is cut, not wrapped, by the terminal.
    const row = await ui.find({ type: 'Text', text: /^ L3 주석 전부 삭제\./ })
    expect(row?.props).toMatchObject({ color: 'suggestion', wrap: 'truncate-end' })

    // One comment per line: a range ending on a commented line opens that comment.
    await arrow($, 'L1')
    await ui.press({ key: 'key-3' })
    await arrow($, 'L2')
    await ui.press({ key: 'L2' })
    expect((await ui.find({ key: 'comment-input' }))?.props.value).toBe('주석 전부 삭제.')
    await ui.input({ key: 'comment-input', text: '주석 전부 삭제.' })
    expect(await ui.find({ type: 'Text', text: /코멘트 1개/ })).toBeDefined()

    // Enter on a comment row edits that comment; emptying it deletes it.
    const mark = await ui.find({ type: 'Button', text: '└' })
    await ui.press({ key: mark!.key! })
    expect((await ui.find({ key: 'comment-input' }))?.props.value).toBe('주석 전부 삭제.')
    await ui.input({ key: 'comment-input', text: '' })
    expect(await ui.find({ type: 'Text', text: /코멘트 0개/ })).toBeDefined()
    await ui.unmount()
  })

  test('▶ is where the ring is, and Enter acts there', async ($, on) => {
    engine(on, { [FILE]: AFTER })
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })
    const title = async () => (await ui.find({ type: 'Text', text: /src\/foo\.ts · L/ }))?.text
    const pointers = async () => (await ui.findAll({ type: 'Text', text: '▶' })).length

    // The footer keys stay out of the ring; an arrow onto a line takes ▶ there.
    expect((await arrow($, 'key-1')).deny).toMatch('포커스를 받지 않습니다')
    await arrow($, 'L2')
    expect(await title()).toMatch('L3')
    // Taking the keyboard again starts the ring on the ▶ line, not the pane's top.
    expect((await ui.find({ key: 'L2' }))?.props.autoFocus).toBe(true)
    expect((await ui.find({ key: 'L1' }))?.props.autoFocus).toBeUndefined()

    // Enter on a line other than ▶'s comments on that line: ▶ moves with it.
    await ui.press({ key: 'L4' })
    expect(await ui.find({ type: 'Text', text: /코멘트 L5 · 빈 Enter 취소/ })).toBeDefined()
    await ui.input({ key: 'comment-input', text: '확인.' })
    expect(await title()).toMatch('L5')

    // The ring on a comment row takes ▶ there, one ▶ on screen, the title on its line.
    await arrow($, 'L1')
    const mark = await ui.find({ type: 'Button', text: '└' })
    await arrow($, mark!.key!)
    expect(await pointers()).toBe(1)
    expect(await title()).toMatch('L5')
    expect((await ui.find({ key: mark!.key! }))?.props.autoFocus).toBe(true)
    await ui.unmount()
  })

  test('an arrow moves the ring before ▶ follows it, and a denied move leaves ▶ where it was', async ($, on) => {
    engine(on, { [FILE]: AFTER })
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })
    const title = async () => (await ui.find({ type: 'Text', text: /src\/foo\.ts · L/ }))?.text

    // The engine moves the ring first; ▶ follows to row 2 after.
    moves.length = 0
    await arrow($, 'L2')
    expect(moves).toEqual(['ring L2', '▶ 2'])
    expect(await title()).toMatch('L3')

    // A move the engine refuses comes back as it was refused, and ▶ stays on row 2.
    moves.length = 0
    focusDenials.push('another move landed first')
    expect((await arrow($, 'L4')).deny).toBe('another move landed first')
    expect(moves).toEqual(['ring L4'])
    expect(await title()).toMatch('L3')
    await ui.unmount()
  })

  test('a long line and a long comment are split into rows within the pane', async ($, on) => {
    const notes = '/repo/notes.md'
    const long = '상품 검색 응답 시간을 평균 820ms에서 310ms로 줄였습니다. 캐시 적중률은 64%에서 91%로 올랐습니다.'
    engine(on, { [FILE]: AFTER, [notes]: `제목\n${long}\n끝\n` })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: notes } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
    await ui.press({ key: 'L1' })
    await ui.press({ key: 'L1' })
    await ui.input({ key: 'comment-input', text: '수치는 대시보드 기준인지 로그 기준인지 출처를 밝혀 주세요. 그리고 기간도 적어 주세요.' })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // Every row fits the 40 columns, counting ·, ▶ and └ as two, and the line's text is all there.
    for (const text of texts) expect(cells(text)).toBeLessThanOrEqual(40)
    const first = texts.findIndex(t => t.startsWith('   상품 검색'))
    expect(first).toBeGreaterThan(-1)
    expect(texts.join('')).toMatch(/91%로\s+올랐습니다\./)
    // The comment's later rows sit under its text, in its color.
    const tail = await ui.find({ type: 'Text', text: /^\s+주세요\./ })
    expect(tail?.props).toMatchObject({ color: 'suggestion' })
    expect(tail?.text.startsWith('     ')).toBe(true)
    // The footer still shows.
    expect(await ui.find({ key: 'key-0' })).toBeDefined()
    await ui.unmount()
  })

  test('in a short, narrow pane the tree never outgrows it and ▶ stays on the ring', async ($, on) => {
    // The pane seated above the prompt in a half-width window: 60 columns, 12 rows.
    const notes = '/repo/release-notes.md'
    engine(on, { [FILE]: AFTER, [notes]: RELEASE_NOTES })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: notes } as never)
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 12 } } as const
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })

    // Lines 9 to 22 are rows 8 to 21: down through them, then back up.
    const path = [...Array.from({ length: 14 }, (_, k) => 8 + k), ...Array.from({ length: 14 }, (_, k) => 21 - k)]
    for (const i of path) {
      await arrow($, `L${i}`)
      const tree = (await ui.drawn()) as El
      expect(rowsOf(tree, 60)).toBeLessThanOrEqual(12)
      expect((await ui.findAll({ type: 'Text', text: '▶' })).length).toBe(1)
      const row = lineOf(tree, `L${i}`)
      expect(row && textOf(row).startsWith('▶')).toBe(true)
    }
    // Moving 28 times through a window of a few lines shifts it many times, each one re-pinned.
    expect(sleeps.length).toBeGreaterThan(4)
    // At 60 columns the pane's keys wrap to two rows: with the rule, more than 12 rows leave
    // the document its five lines, so they give way.
    expect(await ui.find({ type: 'Text', text: ': Redpen 닫기' })).toBeUndefined()
    await ui.unmount()

    // One row more and they show, counted with the rest.
    const taller = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...props, scroll: { offset: 0, bodyRows: 13 } } })
    expect(await taller.find({ type: 'Text', text: ': Redpen 닫기' })).toBeDefined()
    expect(rowsOf((await taller.drawn()) as El, 60)).toBeLessThanOrEqual(13)
    await taller.unmount()
  })

  test("the pane's keys sit under every screen's own, and a short pane leaves them out", async ($, on) => {
    const notes = '/repo/release-notes.md'
    engine(on, { [FILE]: AFTER, [notes]: RELEASE_NOTES })
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const paneKeys = async () => (await ui.findAll({ type: 'Text', text: /^: (프롬프트로|Redpen으로|Redpen 닫기)$/ })).length

    // The list, a document, and the comment input, where Esc leaves the comment open.
    expect(await paneKeys()).toBe(3)
    expect((await ui.find({ type: 'Text', text: 'Esc' }))?.props.color).toBe('suggestion')
    // In a document a rule sets the footer apart from the lines above it, the pane's width.
    const rule = () => ui.find({ type: 'Text', text: /^-+$/ })
    expect(await rule()).toBeUndefined()
    await ui.press({ key: 'F0' })
    expect(await paneKeys()).toBe(3)
    expect((await rule())?.text).toBe('-'.repeat(PANE.props.bodyColumns))
    await ui.press({ key: 'L2' })
    expect(await ui.find({ key: 'comment-input' })).toBeDefined()
    expect(await paneKeys()).toBe(3)
    expect(await rule()).toBeDefined()
    await ui.unmount()

    // 8 rows at 60 columns: the rule and the pane's keys give way, and the tree stays within the pane.
    await $.command.run({ command: 'redpen', args: notes } as never)
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 8 } } as const
    const short = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    expect(await short.find({ type: 'Text', text: ': Redpen 닫기' })).toBeUndefined()
    expect(await short.find({ type: 'Text', text: /^-+$/ })).toBeUndefined()
    expect(rowsOf((await short.drawn()) as El, 60)).toBeLessThanOrEqual(8)
    await short.unmount()
  })

  test('in a pane as short as 6 rows the parts give way, so ↑ and ↓ still move ▶', async ($, on) => {
    const notes = '/repo/release-notes.md'
    engine(on, { [FILE]: AFTER, [notes]: RELEASE_NOTES })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: notes } as never)
    for (const bodyRows of [6, 7, 8, 9]) {
      const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows } } as const
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })
      for (const i of [9, 10, 11, 10]) {
        await arrow($, `L${i}`)
        const tree = (await ui.drawn()) as El
        // Taller than the pane, the arrows would scroll it; without both neighbours, ↑ or ↓ has nowhere to go.
        expect(rowsOf(tree, 60)).toBeLessThanOrEqual(bodyRows)
        expect(textOf(lineOf(tree, `L${i}`)!).startsWith('▶')).toBe(true)
        expect(await ui.find({ key: `L${i - 1}` })).toBeDefined()
        expect(await ui.find({ key: `L${i + 1}` })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('in a pane shorter than 6 rows one row says so, and an open comment input stays', async ($, on) => {
    const notes = '/repo/release-notes.md'
    engine(on, { [FILE]: AFTER, [notes]: RELEASE_NOTES })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: notes } as never)
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 5 } } as const
    const short = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    expect(await short.find({ type: 'Text', text: /pane 높이가 부족합니다/ })).toBeDefined()
    expect(await short.find({ key: 'L0' })).toBeUndefined()
    expect(rowsOf((await short.drawn()) as El, 60)).toBeLessThanOrEqual(5)
    await short.unmount()

    // A comment being written when the pane shrinks keeps its input.
    const tall = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await tall.press({ key: 'L2' })
    await tall.unmount()
    const again = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    expect(await again.find({ type: 'Text', text: /pane 높이가 부족합니다/ })).toBeDefined()
    expect(await again.find({ key: 'comment-input' })).toBeDefined()
    await again.unmount()
  })

  test('in a tight room a neighbour past folded lines drops its ⋯, so ↓ still reaches it', async ($, on) => {
    // Changes on lines 2 and 28 of 30: the lines between fold into one gap.
    const base = Array.from({ length: 30 }, (_, k) => `l${k + 1}`).join('\n') + '\n'
    const after = base.replace('l2\n', 'L2\n').replace('l28\n', 'L28\n')
    engine(on, { [FILE]: after }, base)
    await editTurn($)
    const rows = diffRows(splitLines(base), splitLines(after), 3)
    const gap = rows.findIndex(r => r.kind === 'gap')
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 6 } } as const
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    await ui.press({ key: 'F0' })

    // ▶ on the line above the gap: the line past it is drawn, the ⋯ is not.
    await arrow($, `L${gap - 1}`)
    const tree = (await ui.drawn()) as El
    expect(rowsOf(tree, 60)).toBeLessThanOrEqual(6)
    expect(await ui.find({ key: `L${gap + 1}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⋯/ })).toBeUndefined()
    await ui.unmount()
  })

  test("the list: the recent turn's files as diffs, then the session's other files latest first", async ($, on) => {
    const [a, b, c, d] = ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/src/c.ts', '/repo/notes/d.md']
    const files: Record<string, string> = { [a]: AFTER, [b]: AFTER, [c]: AFTER, [d]: 'note\n' }
    engine(on, files)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
    // A turn that edits `paths`, and runs `during` before it ends, as a Bash call would.
    const turn = async (turnId: string, paths: string[], during = () => {}, isAborted = false) => {
      await $.turn.start({ text: 'edit', turnId })
      for (const p of paths) await $.tool.call({ tool: 'Edit', file_path: p, old_string: 'b\n', new_string: 'b\nhelper()\n' })
      during()
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted, turnId, reason: 'answer' })
    }
    const list = async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const labels = (await ui.findAll({ type: 'Button' })).filter(x => /^F\d+$/.test(x.key ?? '')).map(x => x.text)
      return { ui, labels }
    }
    const names = (labels: string[]) => labels.map(l => /(\w+\.\w+) ·/.exec(l)?.[1])

    // t1 edits a; then d gets a comment, without any edit.
    await turn('t1', [a])
    await $.command.run({ command: 'redpen', args: d } as never)
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await first.press({ key: 'L0' })
    await first.input({ key: 'comment-input', text: '확인.' })
    await first.unmount()

    // t2 edits b and c; t3 edits nothing and leaves the recent turn as it was.
    await turn('t2', [b, c])
    await turn('t3', [])
    await $.command.run({ command: 'redpen', args: '' } as never)
    let { ui, labels } = await list()
    expect(names(labels)).toEqual(['b.ts', 'c.ts', 'd.md', 'a.ts'])
    expect(await ui.find({ type: 'Text', text: '최근 수정' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '파일 목록' })).toBeDefined()
    // The recent turn's file opens as its diff, an earlier one whole: 2 switches a diff alone.
    await ui.press({ key: 'F0' })
    expect(await ui.find({ key: 'key-2' })).toBeDefined()
    await ui.press({ key: 'key-1' })
    await ui.press({ key: 'F3' })
    expect(await ui.find({ key: 'key-2' })).toBeUndefined()
    await ui.press({ key: 'key-1' })
    await ui.unmount()

    // t4 changes a with no Edit, as sed would: a, known to the list, is the recent turn's,
    // its diff from what it held as t4 began.
    await turn('t4', [], () => (files[a] = AFTER.replace('c\n', 'c2\n')))
    ;({ ui, labels } = await list())
    expect(names(labels)).toEqual(['a.ts', 'c.ts', 'b.ts', 'd.md'])
    await ui.press({ key: 'F0' })
    expect(await ui.find({ type: 'Text', text: /\+ c2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+ helper\(\)/ })).toBeUndefined()
    await ui.press({ key: 'key-1' })
    await ui.unmount()

    // t5 deletes b: it leaves the list. t6, cut short, still makes c's edit the recent turn.
    await turn('t5', [], () => delete files[b])
    await turn('t6', [c], () => {}, true)
    ;({ labels } = await list())
    expect(names(labels)).toEqual(['c.ts', 'a.ts', 'd.md'])
  })

  test('a list taller than the pane shows a window around the cursor, so ↑ and ↓ still move', async ($, on) => {
    // A turn that edits twelve files: the list holds the reply and twelve entries.
    const paths = Array.from({ length: 12 }, (_, k) => `/repo/src/f${k}.ts`)
    engine(on, Object.fromEntries(paths.map(p => [p, AFTER])))
    await editTurn($, { tool: 'Edit', file_path: paths[0]!, old_string: 'b\n', new_string: 'b\nhelper()\n' })
    await $.turn.start({ text: 'edit', turnId: 't2' })
    for (const p of paths) await $.tool.call({ tool: 'Edit', file_path: p, old_string: 'b\n', new_string: 'b\nhelper()\n' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    const keys = ['reply', ...paths.map((_, k) => `F${k}`)]

    // Tall enough, the list shows whole, with its title.
    const tall = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await tall.find({ type: 'Text', text: '최근 수정' })).toBeDefined()
    expect(await tall.find({ key: 'F11' })).toBeDefined()
    await tall.unmount()

    for (const bodyRows of [5, 8, 12]) {
      const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows } } as const
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })
      for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 6, 0]) {
        await arrow($, keys[k]!)
        // Taller than the pane, the arrows would scroll it; without both neighbours, ↑ or ↓ has nowhere to go.
        expect(rowsOf((await ui.drawn()) as El, 60)).toBeLessThanOrEqual(bodyRows)
        expect(await ui.find({ key: keys[k]! })).toBeDefined()
        if (k > 0) expect(await ui.find({ key: keys[k - 1]! })).toBeDefined()
        if (k < 12) expect(await ui.find({ key: keys[k + 1]! })).toBeDefined()
      }
      await ui.unmount()
    }

    // Shorter than 5 rows: one row says so.
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 4 } } as const
    const short = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    expect(await short.find({ type: 'Text', text: /pane 높이가 부족합니다/ })).toBeDefined()
    expect(await short.find({ key: 'reply' })).toBeUndefined()
    await short.unmount()
  })

  test('a neighbour line too tall for the room still shows its first row, so ↑ and ↓ reach it', async ($, on) => {
    // Line 2 wraps to a dozen rows at 60 columns, more than a 12-row pane leaves the document.
    const notes = '/repo/tall.md'
    const tall = 'word '.repeat(120).trim()
    engine(on, { [FILE]: AFTER, [notes]: `a\n${tall}\nb\nc\n` })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: notes } as never)
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 12 } } as const
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })

    // ▶ on line 3: line 2 above it takes one row, with its number to move onto.
    await arrow($, 'L2')
    expect(await ui.find({ key: 'L1' })).toBeDefined()
    expect(rowsOf((await ui.drawn()) as El, 60)).toBeLessThanOrEqual(12)

    // ▶ on the tall line itself: it is cut to the room, and both neighbours still show.
    await arrow($, 'L1')
    const tree = (await ui.drawn()) as El
    expect(rowsOf(tree, 60)).toBeLessThanOrEqual(12)
    expect(await ui.find({ key: 'L0' })).toBeDefined()
    expect(await ui.find({ key: 'L2' })).toBeDefined()
    expect(textOf(lineOf(tree, 'L1')!).startsWith('▶')).toBe(true)
    await ui.unmount()
  })

  test('2 switches a diff between its changes and the whole file, ▶ staying on its line', async ($, on) => {
    // 20 lines with one added after line 10: the changes alone show lines 8-14 between gaps.
    const before = Array.from({ length: 20 }, (_, k) => `line ${k + 1}`)
    const after = [...before.slice(0, 10), 'added', ...before.slice(10)]
    engine(on, { [FILE]: after.join('\n') + '\n' })
    on('tool.call', { tool: 'Write' }, () => ({
      result: { type: 'update', filePath: FILE, content: '', originalFile: before.join('\n') + '\n', structuredPatch: [] },
    }) as never)
    await editTurn($, { tool: 'Write', file_path: FILE, content: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })
    const title = async () => (await ui.find({ type: 'Text', text: /src\/foo\.ts/ }))?.text
    const shown = async () => (await ui.findAll({ type: 'Button', text: /^\s*\d+$/ })).length

    expect(await shown()).toBe(7)
    expect((await ui.find({ key: 'key-2' }))?.text).toMatch('전체 보기')
    // ▶ on the added line (row 4, after the gap and lines 8-10), then the whole file: 21 lines, ▶ still on 11.
    await arrow($, 'L4')
    expect(await title()).toMatch('L11')
    await ui.press({ key: 'key-2' })
    expect(await shown()).toBe(21)
    expect(await title()).toMatch(/전체 · L11/)
    expect((await ui.find({ key: 'key-2' }))?.text).toMatch('바뀐 부분만')
    await ui.press({ key: 'key-2' })
    expect(await shown()).toBe(7)
    expect(await title()).toMatch('L11')
    await ui.unmount()
  })

  test('a long path gives way in the middle, keeping the file name and count', async ($, on) => {
    const long = '/home/Documents/personal/redpen-test-drafts/retry_payment.py'
    engine(on, { [FILE]: AFTER, [long]: 'x\n' })
    await editTurn($)
    await $.command.run({ command: 'redpen', args: long } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
    await ui.press({ key: 'L0' })
    await ui.input({ key: 'comment-input', text: '확인.' })
    await ui.press({ key: 'key-1' })
    // 40 columns leave the path 27 cells beside the 12-cell count (· counts two) and one spare;
    // 50 leave the 37 that ~/Documents/…/retry_payment.py fits in, ~/Documents/personal/… not.
    const label = async () => (await ui.find({ type: 'Button', text: /retry_payment\.py/ }))?.props.label
    expect(await label()).toBe('~/…/retry_payment.py · 코멘트 1')
    await ui.redraw({ ...PANE.props, bodyColumns: 50 })
    expect(await label()).toBe('~/Documents/…/retry_payment.py · 코멘트 1')
    await ui.unmount()
  })

  test('the list: the reply and files by ↑↓ and Enter, send on 0; a document goes back on 1', async ($, on) => {
    const submitted = engine(on, { [FILE]: AFTER })
    on('session.messages', () => ({ value: [{ role: 'assistant', text: '초안입니다.' }] }) as never)
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '최근 수정' })).toBeDefined()
    // The reply is the first entry, reached by ↑↓ like the files: no number opens it.
    expect((await ui.find({ key: 'reply' }))?.props).toMatchObject({ autoFocus: true })
    expect((await ui.find({ key: 'reply' }))?.props.hotkey).toBeUndefined()
    // Files carry no number: however many there are, ↑↓ and Enter reach each.
    expect((await ui.find({ key: 'F0' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: '↑↓' }))?.props.color).toBe('suggestion')
    expect(await ui.find({ type: 'Text', text: ': 열기' })).toBeDefined()

    // A comment on the reply, sent from the list with 0.
    await ui.press({ key: 'reply' })
    await ui.press({ key: 'L0' })
    await ui.input({ key: 'comment-input', text: '좋아요.' })
    await ui.press({ key: 'key-1' })
    expect(await ui.find({ type: 'Text', text: '최근 수정' })).toBeDefined()
    await ui.press({ key: 'key-0' })
    expect(submitted[0]).toMatch('1. Claude 마지막 답변 1행\n   > 초안입니다.\n   좋아요.')
    await ui.unmount()
  })

  test('two presses of 0 at once send the comments once', async ($, on) => {
    const submitted = engine(on, { [FILE]: AFTER })
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })
    await ui.press({ key: 'L2' })
    await ui.input({ key: 'comment-input', text: '확인.' })
    await Promise.all([ui.press({ key: 'key-0' }), ui.press({ key: 'key-0' })])
    expect(submitted.length).toBe(1)
    await ui.unmount()
  })

  test('Enter takes the lines on screen, and they stay while ▶ moves', async ($, on) => {
    const files: Record<string, string> = { [FILE]: AFTER }
    const submitted = engine(on, files)
    await editTurn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })

    // The file changes after the pane drew it; row 2 on screen is still helper() on line 3.
    files[FILE] = 'new top\n' + AFTER
    await ui.press({ key: 'L2' })
    expect(await ui.find({ type: 'Text', text: /코멘트 L3 · 빈 Enter 취소/ })).toBeDefined()
    // ▶ moving while the input is open changes neither the lines in the title nor the comment's.
    await arrow($, 'L4')
    expect(await ui.find({ type: 'Text', text: /코멘트 L3 · 빈 Enter 취소/ })).toBeDefined()
    await ui.input({ key: 'comment-input', text: '인라인으로.' })

    await ui.press({ key: 'key-0' })
    expect(submitted[0]).toMatch('1. src/foo.ts:4\n   > helper()\n   인라인으로.')
    await ui.unmount()
  })

  test('a range ending on a deleted line opens the comment already on its last line', async ($, on) => {
    engine(on, { [FILE]: 'a\nc\n' })
    on('tool.call', { tool: 'Write' }, () => ({
      result: { type: 'update', filePath: FILE, content: '', originalFile: 'a\nb\nc\n', structuredPatch: [] },
    }) as never)
    await editTurn($, { tool: 'Write', file_path: FILE, content: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'F0' })

    // rows: a (L1), - b, c (L2). A range of a and - b puts its comment on L1.
    const rangeOverDeleted = async () => {
      await arrow($, 'L0')
      await ui.press({ key: 'key-3' })
      await arrow($, 'L1')
      await ui.press({ key: 'L1' })
    }
    await rangeOverDeleted()
    await ui.input({ key: 'comment-input', text: '첫 코멘트' })
    await rangeOverDeleted()
    expect((await ui.find({ key: 'comment-input' }))?.props.value).toBe('첫 코멘트')
    await ui.input({ key: 'comment-input', text: '첫 코멘트' })
    expect(await ui.find({ type: 'Text', text: /코멘트 1개/ })).toBeDefined()
    await ui.unmount()
  })

  test('/redpen with ./ or .. opens the same file as the edit, and a directory is refused', async ($, on) => {
    engine(on, { [FILE]: AFTER })
    await editTurn($)
    const refused = (await $.command.run({ command: 'redpen', args: 'src' } as never)) as { text?: string }
    expect(refused.text).toMatch('파일이 아닙니다')
    // Claude Code puts "redpen:" before the command's output itself.
    expect(refused.text).not.toMatch(/^redpen:/)

    await $.command.run({ command: 'redpen', args: './src/../src/foo.ts' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The diff opens, not the whole file: 2 switches to the whole file only on a diff.
    expect((await ui.find({ key: 'key-2' }))?.text).toMatch('전체 보기')
    await ui.press({ key: 'L2' })
    await ui.input({ key: 'comment-input', text: '확인.' })
    await ui.press({ key: 'key-1' })
    // The comment counts on the edited file's entry; no second entry for another spelling.
    expect((await ui.find({ key: 'F0' }))?.text).toMatch('src/foo.ts · 코멘트 1')
    expect(await ui.find({ key: 'F1' })).toBeUndefined()
    await ui.unmount()
  })
})

export type Row =
  | { kind: 'gap' }
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number }

// Above this many LCS cells the changed middle is shown as a block replace.
const MAX_CELLS = 2_000_000

export function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

// `context` lines are kept around each change, the rest folded into gaps; Infinity keeps all.
export function diffRows(before: string[], after: string[], context = 3): Row[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++

  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  const ops: ('=' | '-' | '+')[] = []
  if (a.length * b.length > MAX_CELLS) {
    // A loop, not push(...): spreading a hundred thousand lines overflows the call stack.
    for (let i = 0; i < a.length; i++) ops.push('-')
    for (let j = 0; j < b.length; j++) ops.push('+')
  } else {
    const w = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * w)
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push('=')
        i++
        j++
      } else if (j < b.length && (i === a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
        ops.push('+')
        j++
      } else {
        ops.push('-')
        i++
      }
    }
  }

  const all: Row[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of [...Array<'='>(head).fill('='), ...ops, ...Array<'='>(tail).fill('=')]) {
    if (op === '=') all.push({ kind: 'ctx', text: after[newLine - 1]!, oldLine: oldLine++, newLine: newLine++ })
    else if (op === '-') all.push({ kind: 'del', text: before[oldLine - 1]!, oldLine: oldLine++ })
    else all.push({ kind: 'add', text: after[newLine - 1]!, newLine: newLine++ })
  }

  if (context === Infinity) return all
  const keep = all.map(() => false)
  all.forEach((row, i) => {
    if (row.kind === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true
  })
  const rows: Row[] = []
  all.forEach((row, i) => {
    if (!keep[i]) return
    if (i > 0 && !keep[i - 1]) rows.push({ kind: 'gap' })
    rows.push(row)
  })
  if (rows.length > 0 && !keep[all.length - 1]) rows.push({ kind: 'gap' })
  return rows
}

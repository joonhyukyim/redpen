// Terminal cells a character takes: Hangul and other wide glyphs take two.
// East Asian Ambiguous characters (·, …, ↑, ▶, └, ①, ...) count as two as well: a terminal
// set for Korean may draw them two wide, and a row one cell too wide wraps and pushes every
// row below it down, parting ▶ from the line it marks.
const WIDE =
  /[¡¤§¨ª­®°-´¶-º¼-¿×÷ᄀ-ᅟ‐-‧‰-‾←-⇿∀-⋿①-⓿─-◿☀-⛿❶-❿⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

// Every wide range starts at U+00A1, so ASCII skips the regex.
export const cellOf = (ch: string) => (ch < '¡' ? 1 : WIDE.test(ch) ? 2 : 1)

export const cells = (text: string) => {
  let n = 0
  for (const ch of text) n += cellOf(ch)
  return n
}

// Splits text into rows of at most `width` cells, breaking at a space in the row's second
// half when there is one. redpen splits rows itself so it knows how many each line takes.
export function wrapRows(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  let rest = text
  for (;;) {
    let row = ''
    let n = 0
    let over = false
    for (const ch of rest) {
      const c = cellOf(ch)
      if (n + c > w) {
        over = true
        break
      }
      row += ch
      n += c
    }
    if (!over) break
    // A two-cell character wider than the row still takes a row of its own, so the loop ends.
    if (row === '') row = [...rest][0]!
    const space = row.lastIndexOf(' ')
    const take = space > row.length / 2 ? space : row.length
    out.push(row.slice(0, take))
    rest = rest.slice(take === space ? take + 1 : take)
  }
  if (rest !== '' || out.length === 0) out.push(rest)
  return out
}

// Cuts text to `width` cells, ending in … when it does not fit. … itself takes two cells,
// so a width below two leaves nothing.
export function cut(text: string, width: number) {
  if (cells(text) <= width) return text
  const room = width - cells('…')
  if (room < 0) return ''
  let out = ''
  let n = 0
  for (const ch of text) {
    const c = cellOf(ch)
    if (n + c > room) break
    out += ch
    n += c
  }
  return `${out}…`
}

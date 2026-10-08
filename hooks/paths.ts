// A path as typed: absolute, under ~, or relative to the working directory.
export function expand(typed: string, cwd: string, home: string) {
  if (typed.startsWith('/')) return typed
  if ((typed === '~' || typed.startsWith('~/')) && home !== '') return home + typed.slice(1)
  return `${cwd}/${typed}`
}

// The directory part of a typed path, as typed (with its last /, or empty), and the start of
// the name being typed in it.
export function splitTyped(typed: string) {
  const slash = typed.lastIndexOf('/')
  return { dir: typed.slice(0, slash + 1), stem: typed.slice(slash + 1) }
}

export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

// The entries of the typed directory that complete the typed name, as the typed path would
// read with them: directories first, then by name, each directory ending in /. A hidden entry
// shows only once its leading dot is typed.
export function completions({ dir, stem }: ReturnType<typeof splitTyped>, entries: Entry[], max: number) {
  return entries
    .filter(e => e.name.startsWith(stem) && (stem.startsWith('.') || !e.name.startsWith('.')))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(e => ({ text: `${dir}${e.name}${e.kind === 'dir' ? '/' : ''}`, isDir: e.kind === 'dir' }))
}

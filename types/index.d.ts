export type TurnFile = { path: string; base: string | null }

/** The turn that last changed files, and each file's content before the turn first changed it. */
export type RecentTurn = { turnId: string; files: TurnFile[] }

/** A file changed this session, and when it was changed last. */
export type SessionFile = { path: string; at: number }

/** A file's content when the running turn began. */
export type Held = { path: string; text: string }

export type Source =
  | { kind: 'diff'; path: string; base: string | null }
  | { kind: 'file'; path: string }
  | { kind: 'reply'; text: string }

/**
 * What the open comment input saves: an existing comment's new text, or a new comment on the
 * lines and excerpt fixed when Enter opened it, wherever ▶ or the file goes meanwhile.
 */
export type Composing = { editId: string } | { lines: Pick<Comment, 'side' | 'start' | 'end' | 'excerpt'> }

export type View =
  | {
      screen: 'list'
      /** The entry the focus ring is on: 0 the reply, i + 1 the i-th file. */
      cursor?: number
    }
  | {
      screen: 'doc'
      source: Source
      cursor: number
      anchor: number | null
      composing: Composing | null
      /** The comment row the focus ring is on: ▶ is drawn there instead of on the cursor line. */
      focused: string | null
      /** A diff shown whole, every unchanged line in place, rather than its changes alone. */
      whole?: boolean
    }

export type Comment = {
  id: string
  kind: Source['kind']
  path: string
  side: 'new' | 'old'
  start: number
  end: number
  excerpt: string[]
  text: string
  /** When the comment was written: a file with comments alone takes its place in the list by it. */
  at?: number
}

export type Sent = { at: number; count: number }

declare module 'claude-code' {
  interface PluginState {
    redpen: {
      turn: string | null
      recent: RecentTurn | null
      edited: SessionFile[]
      snapshot: Held[]
      view: View
      comments: Comment[]
      sent: Sent | null
    }
  }
}

export type TurnFile = { path: string; base: string | null }

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
  | { screen: 'list' }
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
}

export type Sent = { at: number; count: number }

declare module 'claude-code' {
  interface PluginState {
    redpen: {
      pending: TurnFile[]
      lastTurn: TurnFile[]
      view: View
      comments: Comment[]
      sent: Sent | null
    }
  }
}

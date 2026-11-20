import { useEffect, useState } from 'react'
import type { ThemedToken } from 'shiki'
import { Badge } from '@/components/ui/badge'
import type { Excerpt } from './api'

export function SourceExcerpt({ excerpt, previous }: { excerpt: Excerpt; previous: boolean }) {
  const [highlighted, setHighlighted] = useState<{ excerpt: Excerpt; lines: ThemedToken[][] } | null>(null)
  const cited = excerpt.highlight
  const tokens = highlighted?.excerpt === excerpt ? highlighted.lines : []

  useEffect(() => {
    let current = true
    const source = excerpt.lines.map(line => line.text).join('\n')
    void import('./lib/highlight').then(({ highlight }) => highlight(excerpt.path, source)).then(lines => {
      if (current) setHighlighted({ excerpt, lines })
    }).catch(() => undefined)
    return () => { current = false }
  }, [excerpt])

  return <div className="code">
    <div className="code-meta">
      <code title={excerpt.path}>{excerpt.path}</code>
      <Badge variant="outline" className="commit-tag" title={excerpt.commit}>
        {excerpt.commit.slice(0, 7)}{previous ? ' · previous' : ''}
      </Badge>
    </div>
    <div className="code-scroll" role="region" aria-label="Pinned source lines" tabIndex={0} key={excerpt.url}>
      <div className="code-lines">
        {excerpt.lines.map((line, index) => (
          <div className={!cited || (line.number >= cited.start && line.number <= cited.end) ? 'code-row cited' : 'code-row'}
            key={line.number}>
            <span className="code-line-number">{line.number}</span>
            <code>{tokens[index]?.length
              ? tokens[index].map((token, part) => <span key={part} style={{ color: token.color }}>{token.content}</span>)
              : line.text || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  </div>
}

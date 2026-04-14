import { useState, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import './MarkdownRenderer.css'

// ─── HTML escape — CRITICAL ──────────────────────────────────────────────────
// Every piece of user/LLM-generated text MUST go through this before being
// fed into any regex transform, otherwise a response containing `<img onerror=...>`
// would execute as real DOM (XSS → localStorage exfiltration of API keys).
// We escape first, then our regex transforms re-introduce only the HTML tags
// we explicitly want (strong, em, a, code, etc.).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Safer URL check — reject javascript:, data:, vbscript: etc.
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase()
  if (trimmed.startsWith('javascript:')) return false
  if (trimmed.startsWith('vbscript:')) return false
  if (trimmed.startsWith('data:') && !trimmed.startsWith('data:image/')) return false
  return true
}

interface Props {
  text: string
  onFileClick?: (path: string) => void
}

// ─── Syntax highlighting ─────────────────────────────────────────────────────

function highlightLine(line: string, lang: string): string {
  // Comments
  line = line.replace(/(\/\/.*$)/gm, '<span class="sh-comment">$1</span>')
  line = line.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="sh-comment">$1</span>')
  line = line.replace(/(#.*$)/gm, (m, p1) => {
    // Don't highlight CSS color hex values
    if (/^#[0-9a-fA-F]{3,8}$/.test(p1.trim())) return m
    if (lang === 'css' || lang === 'scss') return m
    return `<span class="sh-comment">${p1}</span>`
  })

  // Strings (double and single quoted)
  line = line.replace(/("(?:[^"\\]|\\.)*")/g, '<span class="sh-string">$1</span>')
  line = line.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="sh-string">$1</span>')
  line = line.replace(/(`(?:[^`\\]|\\.)*`)/g, '<span class="sh-string">$1</span>')

  // Keywords
  const keywords = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|import|export|from|default|new|this|typeof|instanceof|try|catch|finally|throw|async|await|yield|of|in|true|false|null|undefined|void|type|interface|enum|implements|abstract|static|public|private|protected|readonly|declare|module|namespace|require)\b/g
  line = line.replace(keywords, '<span class="sh-keyword">$1</span>')

  // HTML tags
  line = line.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="sh-tag">$2</span>')
  line = line.replace(/([\w-]+)(=)/g, '<span class="sh-attr">$1</span>$2')

  // Numbers
  line = line.replace(/\b(\d+\.?\d*)\b/g, '<span class="sh-number">$1</span>')

  // CSS properties
  if (lang === 'css' || lang === 'scss') {
    line = line.replace(/([\w-]+)(\s*:)/g, '<span class="sh-attr">$1</span>$2')
  }

  return line
}

function highlightCode(code: string, lang: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map(line => highlightLine(line, lang))
    .join('\n')
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <button className="code-copy-btn" onClick={handleCopy} title="Kopiraj">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? 'Kopirano!' : 'Kopiraj'}</span>
    </button>
  )
}

// ─── File path detection ─────────────────────────────────────────────────────

function processInlineCode(text: string, onFileClick?: (path: string) => void): string {
  // Text is already HTML-escaped when this runs.
  if (!onFileClick) {
    return text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
  }

  return text.replace(/`([^`]+)`/g, (_match, content: string) => {
    // The captured content is already HTML-escaped from processInline.
    // For the data-path attribute we need the RAW path (unescaped back).
    // Since escapeHtml only touched &<>"' we can reverse by replacing known entities.
    const rawPath = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    if (/^(?:[\w.-]+\/)*[\w.-]+\.\w{1,10}$/.test(rawPath)) {
      // Re-escape for the attribute
      const attr = rawPath.replace(/"/g, '&quot;').replace(/</g, '&lt;')
      return `<code class="md-inline-code md-file-link" data-path="${attr}">${content}</code>`
    }
    return `<code class="md-inline-code">${content}</code>`
  })
}

// ─── Inline formatting ───────────────────────────────────────────────────────
// SECURITY: `text` is HTML-escaped FIRST, then our regex transforms re-introduce
// only the tags we whitelist (strong, em, a, code). Any raw HTML in the input
// (e.g. `<img onerror>`) is already inert (`&lt;img onerror&gt;`).
function processInline(text: string, onFileClick?: (path: string) => void): string {
  // Use a placeholder to preserve intentional <br/> tags through the escape step.
  const BR_MARK = '\u0001BR\u0001'
  text = text.replace(/<br\s*\/?>/gi, BR_MARK)
  text = escapeHtml(text)
  text = text.replace(new RegExp(BR_MARK, 'g'), '<br/>')
  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Inline code (with file path detection)
  text = processInlineCode(text, onFileClick)
  // Links [text](url) — URL is validated to reject javascript:, vbscript:, data:, etc.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    // url and label are both already HTML-escaped by escapeHtml above
    const decoded = url.replace(/&amp;/g, '&')
    if (!isSafeUrl(decoded)) return label
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  // Auto-link URLs (only http/https; already escaped)
  text = text.replace(/(?<!")(?<!=)(https?:\/\/[^\s<>"]+)/g, (_m, url) => {
    if (!isSafeUrl(url.replace(/&amp;/g, '&'))) return url
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  })
  // Localhost links
  text = text.replace(/\blocalhost:(\d+)(\/[^\s]*)?/g, '<a href="http://localhost:$1$2" target="_blank" rel="noopener noreferrer">localhost:$1$2</a>')
  return text
}

// ─── Main renderer ───────────────────────────────────────────────────────────

interface Block {
  type: 'paragraph' | 'heading' | 'code' | 'table' | 'list' | 'blockquote' | 'hr'
  content: string
  lang?: string
  level?: number
  ordered?: boolean
  items?: string[]
  rows?: string[][]
  hasHeader?: boolean
}

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Horizontal rule
    if (/^(---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'hr', content: '' })
      i++
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,5})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: 'heading', content: headingMatch[2], level: headingMatch[1].length })
      i++
      continue
    }

    // Code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim() || 'code'
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push({ type: 'code', content: codeLines.join('\n'), lang })
      continue
    }

    // Table (detect | at start of line)
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      // Parse table
      const rows = tableLines
        .filter(l => !/^\|[\s-:|]+\|$/.test(l)) // Remove separator row
        .map(l =>
          l.split('|').slice(1, -1).map(cell => cell.trim())
        )
      if (rows.length > 0) {
        blocks.push({ type: 'table', content: '', rows, hasHeader: tableLines.length > 1 })
      }
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') })
      continue
    }

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s/, ''))
        i++
      }
      blocks.push({ type: 'list', content: '', items, ordered: false })
      continue
    }

    // Ordered list
    if (/^[\s]*\d+[.)]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[\s]*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*\d+[.)]\s/, ''))
        i++
      }
      blocks.push({ type: 'list', content: '', items, ordered: true })
      continue
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — collect until empty line or block element
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,5}\s/) &&
      !lines[i].trimStart().startsWith('```') &&
      !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) &&
      !lines[i].startsWith('>') &&
      !/^[\s]*[-*+]\s/.test(lines[i]) &&
      !/^[\s]*\d+[.)]\s/.test(lines[i]) &&
      !/^(---+|___+|\*\*\*+)\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') })
    }
  }

  return blocks
}

// ─── React Component ─────────────────────────────────────────────────────────

export default function MarkdownRenderer({ text, onFileClick }: Props) {
  const blocks = parseBlocks(text)

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const filePath = target.closest('[data-path]')?.getAttribute('data-path')
    if (filePath && onFileClick) {
      onFileClick(filePath)
    }
  }, [onFileClick])

  return (
    <div className="md-body" onClick={handleClick}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'hr':
            return <hr key={i} className="md-hr" />

          case 'heading': {
            const level = block.level || 3
            if (level === 1) return <h1 key={i} className="md-heading" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
            if (level === 2) return <h2 key={i} className="md-heading" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
            if (level === 4) return <h4 key={i} className="md-heading" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
            if (level === 5) return <h5 key={i} className="md-heading" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
            return <h3 key={i} className="md-heading" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
          }

          case 'code':
            return (
              <div key={i} className="md-code-block">
                <div className="md-code-header">
                  <span className="md-code-lang">{block.lang}</span>
                  <CopyButton code={block.content} />
                </div>
                <pre className="md-code-pre">
                  <code dangerouslySetInnerHTML={{ __html: highlightCode(block.content, block.lang || '') }} />
                </pre>
              </div>
            )

          case 'table':
            return (
              <div key={i} className="md-table-wrap">
                <table className="md-table">
                  {block.hasHeader && block.rows && block.rows.length > 0 && (
                    <thead>
                      <tr>
                        {block.rows[0].map((cell, j) => (
                          <th key={j} dangerouslySetInnerHTML={{ __html: processInline(cell, onFileClick) }} />
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {(block.rows || []).slice(block.hasHeader ? 1 : 0).map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci} dangerouslySetInnerHTML={{ __html: processInline(cell, onFileClick) }} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )

          case 'blockquote':
            return (
              <blockquote key={i} className="md-blockquote" dangerouslySetInnerHTML={{ __html: processInline(block.content, onFileClick) }} />
            )

          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} className="md-list">
                {(block.items || []).map((item, j) => {
                  // Checklist detection
                  const checkMatch = item.match(/^\[([ xX])\]\s*(.*)$/)
                  if (checkMatch) {
                    const checked = checkMatch[1] !== ' '
                    return (
                      <li key={j} className={`md-checklist ${checked ? 'checked' : ''}`}>
                        <span className="md-check">{checked ? '✓' : '○'}</span>
                        <span dangerouslySetInnerHTML={{ __html: processInline(checkMatch[2], onFileClick) }} />
                      </li>
                    )
                  }
                  return <li key={j} dangerouslySetInnerHTML={{ __html: processInline(item, onFileClick) }} />
                })}
              </Tag>
            )
          }

          case 'paragraph':
            return (
              <p key={i} className="md-paragraph" dangerouslySetInnerHTML={{ __html: processInline(block.content.replace(/\n/g, '<br/>'), onFileClick) }} />
            )

          default:
            return null
        }
      })}
    </div>
  )
}

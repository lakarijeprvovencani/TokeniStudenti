import { useEffect, useRef } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getWebContainer } from '../services/webcontainer'
import { X, Terminal as TerminalIcon } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

interface TerminalProps {
  onClose: () => void
}

export default function TerminalPanel({ onClose }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerminal | null>(null)

  useEffect(() => {
    if (!termRef.current) return

    const terminal = new XTerminal({
      theme: {
        background: '#0f0f12',
        foreground: '#fafafa',
        cursor: '#f97316',
        cursorAccent: '#0f0f12',
        selectionBackground: 'rgba(249, 115, 22, 0.25)',
        black: '#09090b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#fafafa',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 1000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(termRef.current)
    xtermRef.current = terminal

    // Fit after a frame so container has dimensions
    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    // Connect to WebContainers jsh shell
    getWebContainer().then(async (wc) => {
      const shell = await wc.spawn('jsh', {
        terminal: { cols: terminal.cols, rows: terminal.rows },
      })

      shell.output.pipeTo(new WritableStream({
        write(data) {
          terminal.write(data)
        },
      }))

      const writer = shell.input.getWriter()
      terminal.onData(data => writer.write(data))

      // Resize shell when terminal resizes
      terminal.onResize(({ cols, rows }) => {
        shell.resize({ cols, rows })
      })
    }).catch(err => {
      terminal.writeln('\x1b[31mGreška: WebContainer nije spreman.\x1b[0m')
      console.error('[Terminal] Error:', err)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit())
    })
    if (termRef.current) resizeObserver.observe(termRef.current)

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
    }
  }, [])

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalIcon size={13} />
          <span>Terminal</span>
        </div>
        <button className="terminal-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="terminal-body" ref={termRef} />
    </div>
  )
}

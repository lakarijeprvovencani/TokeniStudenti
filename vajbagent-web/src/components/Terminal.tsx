import { useEffect, useRef } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getWebContainer, onAgentCommand } from '../services/webcontainer'
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

    // Shell + writer handles live in closures we need to reach from the
    // cleanup effect. Without these references we'd leak a running jsh
    // process every time the panel closes — and a couple of those add up
    // fast on mobile browsers that evict WebContainers after a few minutes
    // of inactivity.
    let shellHandle: { kill: () => Promise<void> | void } | null = null
    let inputWriter: { releaseLock: () => void } | null = null
    let disposed = false

    // Colored ANSI banner. Written by xterm directly (not through jsh) so
    // it survives no matter what jsh prints afterwards. Orange mirrors
    // the app's cursor/accent color; dim gray is used for hints.
    const BANNER = [
      '',
      '  \x1b[38;2;249;115;22m██╗   ██╗ █████╗      ██╗██████╗ \x1b[0m',
      '  \x1b[38;2;249;115;22m██║   ██║██╔══██╗     ██║██╔══██╗\x1b[0m',
      '  \x1b[38;2;249;115;22m██║   ██║███████║     ██║██████╔╝\x1b[0m',
      '  \x1b[38;2;249;115;22m╚██╗ ██╔╝██╔══██║██   ██║██╔══██╗\x1b[0m',
      '  \x1b[38;2;249;115;22m ╚████╔╝ ██║  ██║╚█████╔╝██████╔╝\x1b[0m',
      '  \x1b[38;2;249;115;22m  ╚═══╝  ╚═╝  ╚═╝ ╚════╝ ╚═════╝ \x1b[0m',
      '',
      '  \x1b[38;2;212;212;216mVajbAgent terminal  \x1b[38;2;113;113;122m· jsh u WebContainers sandboxu\x1b[0m',
      '  \x1b[38;2;113;113;122mProbaj:\x1b[0m \x1b[38;2;250;204;21mls\x1b[0m  \x1b[38;2;250;204;21mnpm install\x1b[0m  \x1b[38;2;250;204;21mnpm run dev\x1b[0m  \x1b[38;2;250;204;21mnode -v\x1b[0m',
      '',
    ]
    for (const line of BANNER) terminal.writeln(line)

    getWebContainer().then(async (wc) => {
      if (disposed) return
      // Spawn jsh directly in /home/project (WebContainers' canonical
      // project root). Without `cwd` jsh lands in ~/<random-hash> which
      // looks like garbage — and then the user has to manually `cd` to
      // find the files they wrote. This gives them a sensible starting
      // directory right off the prompt.
      const shell = await wc.spawn('jsh', {
        terminal: { cols: terminal.cols, rows: terminal.rows },
        cwd: '/home/project',
      })
      shellHandle = shell

      shell.output.pipeTo(new WritableStream({
        write(data) {
          if (!disposed) terminal.write(data)
        },
      })).catch(() => { /* stream ended */ })

      const writer = shell.input.getWriter()
      inputWriter = writer
      terminal.onData(data => {
        if (!disposed) writer.write(data).catch(() => { /* socket closed */ })
      })

      terminal.onResize(({ cols, rows }) => {
        if (!disposed) shell.resize({ cols, rows })
      })
    }).catch(err => {
      if (!disposed) terminal.writeln('\x1b[31mGreška: WebContainer nije spreman.\x1b[0m')
      console.error('[Terminal] Error:', err)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit())
    })
    if (termRef.current) resizeObserver.observe(termRef.current)

    // Mirror every agent-issued command into this terminal. We prefix
    // start/end lines with colored markers so the user can clearly
    // separate their own input from agent activity. Raw stdout/stderr
    // bytes from the spawned process get written verbatim so colored
    // output from npm / vite / next stays colored.
    //
    // Note: the agent's process and the interactive jsh process are
    // separate children of WebContainers. Output interleaving with an
    // in-flight user command is possible but rare — the panel is
    // passive most of the time.
    const AGENT_START = '\x1b[38;2;249;115;22m▶ agent\x1b[0m \x1b[38;2;113;113;122m·\x1b[0m '
    const AGENT_OK = '\x1b[38;2;34;197;94m✓ agent\x1b[0m'
    const AGENT_FAIL = '\x1b[38;2;239;68;68m✗ agent\x1b[0m'
    const AGENT_DETACH = '\x1b[38;2;59;130;246m◆ agent\x1b[0m'
    const unsubAgent = onAgentCommand((e) => {
      if (disposed) return
      if (e.type === 'command-start') {
        terminal.writeln('')
        terminal.writeln(`${AGENT_START}${e.cmd}`)
      } else if (e.type === 'command-output') {
        terminal.write(e.data)
      } else if (e.type === 'command-end') {
        if (e.exitCode === null) {
          terminal.writeln(`\r\n${AGENT_DETACH} dev server radi u pozadini`)
        } else if (e.exitCode === 0) {
          terminal.writeln(`\r\n${AGENT_OK} završeno`)
        } else {
          terminal.writeln(`\r\n${AGENT_FAIL} exit ${e.exitCode}`)
        }
        terminal.writeln('')
      }
    })

    return () => {
      disposed = true
      unsubAgent()
      resizeObserver.disconnect()
      try { inputWriter?.releaseLock() } catch { /* ignore */ }
      try { shellHandle?.kill() } catch { /* ignore */ }
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

import { useEffect, useState } from 'react'
import { Monitor, Smartphone } from 'lucide-react'

/**
 * Mobile gate. VajbAgent requires a WebContainer, Monaco, and a long-lived
 * multi-panel layout — all of that is a terrible experience on a phone.
 * Rather than let a curious mobile user burn credits on a broken preview,
 * we show an unambiguous "please use a computer" wall. There is NO bypass:
 * every "but I know what I'm doing" user will still fail five minutes in
 * once they try to drag a file or read tiny Monaco text.
 *
 * Detection combines viewport width, touch support, and a narrow UA check
 * so iPad landscape (which works fine) and small laptop windows aren't
 * falsely blocked.
 */
function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const ua = (navigator.userAgent || '').toLowerCase()
  const uaMobile = /iphone|ipod|android.*mobile|blackberry|iemobile|opera mini|mobile/.test(ua)
  const narrow = window.innerWidth < 900
  const touchOnly = (navigator.maxTouchPoints || 0) > 0 && !window.matchMedia('(pointer: fine)').matches
  // iPad in landscape reports >= 1024 width and has a fine pointer via Apple
  // Pencil / hardware keyboard trackpad — those users get through. Pure
  // phones (narrow + touch-only) OR explicit mobile UA are blocked.
  return uaMobile || (narrow && touchOnly)
}

export default function MobileBlock() {
  const [blocked, setBlocked] = useState(() => isMobileDevice())

  useEffect(() => {
    const onResize = () => setBlocked(isMobileDevice())
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  if (!blocked) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'radial-gradient(120% 120% at 50% 0%, #1a1412 0%, #0c0a09 60%, #050403 100%)',
        color: '#f5f1ea',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        textAlign: 'center',
        fontFamily: 'Inter, system-ui, sans-serif',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 24,
          color: '#ff7a1a',
        }}
      >
        <Smartphone size={36} strokeWidth={1.6} style={{ opacity: 0.5 }} />
        <span style={{ fontSize: 28, opacity: 0.7 }}>→</span>
        <Monitor size={44} strokeWidth={1.6} />
      </div>

      <div
        style={{
          fontSize: 13,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#ff7a1a',
          marginBottom: 12,
          fontWeight: 600,
        }}
      >
        VajbAgent
      </div>

      <h1
        style={{
          fontSize: 'clamp(22px, 6vw, 30px)',
          fontWeight: 700,
          lineHeight: 1.25,
          margin: '0 0 16px',
          maxWidth: 420,
        }}
      >
        Otvori VajbAgent na računaru
      </h1>

      <p
        style={{
          fontSize: 15,
          lineHeight: 1.55,
          color: '#bfb9ae',
          maxWidth: 380,
          margin: '0 0 28px',
        }}
      >
        Aplikacija je editor, pregled i terminal u jednom — treba joj miš,
        tastatura i veći ekran. Na telefonu nažalost ne može da radi.
      </p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          alignItems: 'flex-start',
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 14,
          padding: '16px 20px',
          maxWidth: 380,
          width: '100%',
          textAlign: 'left',
          color: '#d6d0c3',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ color: '#ff7a1a', fontWeight: 700 }}>1.</span>
          <span>Otvori <b style={{ color: '#fff' }}>vajbagent.com</b> u browser-u na laptopu ili desktop računaru.</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ color: '#ff7a1a', fontWeight: 700 }}>2.</span>
          <span>Preporučujemo Chrome ili Edge za najbolji rad WebContainer-a.</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ color: '#ff7a1a', fontWeight: 700 }}>3.</span>
          <span>Uloguj se istim nalogom — tvoji krediti i projekti čekaju te tamo.</span>
        </div>
      </div>

      <p
        style={{
          marginTop: 28,
          fontSize: 12,
          color: '#7a746a',
          maxWidth: 320,
          lineHeight: 1.5,
        }}
      >
        Vidimo se na računaru. Mobilna verzija stiže kasnije — hvala na strpljenju.
      </p>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import './LoadingTransition.css'

interface LoadingTransitionProps {
  onComplete: () => void
}

const STEPS = [
  { label: 'Analiziram zahtev...', icon: '🔍', duration: 800 },
  { label: 'Pripremam okruženje...', icon: '⚙️', duration: 1000 },
  { label: 'Pokrećem agenta...', icon: '🚀', duration: 700 },
]

export default function LoadingTransition({ onComplete }: LoadingTransitionProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let stepIdx = 0
    let progressVal = 0
    let cancelled = false
    const timers: number[] = []
    let intervalId: number | null = null

    const advanceStep = () => {
      if (cancelled) return
      if (stepIdx >= STEPS.length) {
        timers.push(window.setTimeout(() => { if (!cancelled) onComplete() }, 300))
        return
      }

      setCurrentStep(stepIdx)

      const stepDuration = STEPS[stepIdx].duration
      const startProgress = (stepIdx / STEPS.length) * 100
      const endProgress = ((stepIdx + 1) / STEPS.length) * 100
      const interval = 30
      const ticks = stepDuration / interval
      const increment = (endProgress - startProgress) / ticks
      let tickCount = 0

      intervalId = window.setInterval(() => {
        if (cancelled) {
          if (intervalId) window.clearInterval(intervalId)
          return
        }
        tickCount++
        progressVal = startProgress + increment * tickCount
        setProgress(Math.min(progressVal, endProgress))

        if (tickCount >= ticks) {
          if (intervalId) window.clearInterval(intervalId)
          intervalId = null
          stepIdx++
          timers.push(window.setTimeout(advanceStep, 200))
        }
      }, interval)
    }

    timers.push(window.setTimeout(advanceStep, 300))

    return () => {
      cancelled = true
      if (intervalId) window.clearInterval(intervalId)
      for (const id of timers) window.clearTimeout(id)
    }
  }, [onComplete])

  return (
    <motion.div
      className="loading-transition"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.03, filter: 'blur(6px)' }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Background glow */}
      <div className="loading-bg">
        <div className="loading-glow loading-glow-1" />
        <div className="loading-glow loading-glow-2" />
      </div>

      <div className="loading-content">
        {/* Logo */}
        <motion.div
          className="loading-logo-wrap"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <img src="/logo.svg" alt="VajbAgent" className="loading-logo" />
          <div className="loading-logo-ring" />
          <div className="loading-logo-ring loading-logo-ring-2" />
        </motion.div>

        {/* Brand */}
        <motion.h1
          className="loading-brand"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          Vajb<span>Agent</span>
        </motion.h1>

        {/* Steps */}
        <div className="loading-steps">
          {STEPS.map((step, i) => (
            <motion.div
              key={i}
              className={`loading-step ${i < currentStep ? 'done' : i === currentStep ? 'active' : ''}`}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.3 + i * 0.15 }}
            >
              <div className="step-indicator">
                {i < currentStep ? (
                  <motion.div
                    className="step-check"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.2, ease: [0.34, 1.56, 0.64, 1] }}
                  >
                    ✓
                  </motion.div>
                ) : i === currentStep ? (
                  <div className="step-spinner" />
                ) : (
                  <div className="step-dot" />
                )}
              </div>
              <span className="step-label">{step.label}</span>
            </motion.div>
          ))}
        </div>

        {/* Progress bar */}
        <motion.div
          className="loading-progress-wrap"
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: '100%' }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <div className="loading-progress-track">
            <motion.div
              className="loading-progress-bar"
              style={{ width: `${progress}%` }}
            />
          </div>
        </motion.div>
      </div>
    </motion.div>
  )
}

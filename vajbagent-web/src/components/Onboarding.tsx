import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Zap, Code2, Rocket, ChevronRight } from 'lucide-react'
import './Onboarding.css'

interface OnboardingProps {
  onComplete: () => void
}

const STEPS = [
  {
    icon: <Sparkles size={32} />,
    title: 'Dobrodošao u VajbAgent',
    description: 'AI agent koji ti pravi kompletne sajtove i aplikacije iz jednog opisa. Bez setupa, bez konfiguracije.',
    bullets: [
      'Opišeš ideju → agent piše kod',
      'Vidiš preview odmah u browser-u',
      'Deploy jednim klikom na Netlify',
    ],
  },
  {
    icon: <Code2 size={32} />,
    title: 'Kako radi',
    description: 'Imamo gotove templejte ili kreni od svog opisa. Sve radi u browser-u — nema instalacije.',
    bullets: [
      'Templejti — gotovi starteri (Landing, Dashboard, Portfolio...)',
      'Quick prompts — brz start sa idejom',
      'Sopstveni opis — opišeš detaljno šta hoćeš',
    ],
  },
  {
    icon: <Zap size={32} />,
    title: 'Šta agent može',
    description: 'Pravi kompleksne web aplikacije — od običnih sajtova do React/Next.js projekata.',
    bullets: [
      'HTML/CSS/JS sajtovi — instant preview',
      'React, Vite, Next.js — automatski build',
      'Slike sa Unsplash-a, web search, fetch URL-ova',
    ],
  },
  {
    icon: <Rocket size={32} />,
    title: 'Spreman si!',
    description: 'Tvoji projekti se automatski čuvaju. Možeš se vratiti bilo kada.',
    bullets: [
      'Auto-save — refresh stranice ne briše rad',
      'Istorija projekata — vrati se kada hoćeš',
      'GitHub & Netlify integracija u Settings',
    ],
  },
]

const STORAGE_KEY = 'vajb_onboarding_done'

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem(STORAGE_KEY)
}

export function markOnboardingDone(): void {
  localStorage.setItem(STORAGE_KEY, '1')
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0)

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      markOnboardingDone()
      onComplete()
    }
  }

  const handleSkip = () => {
    markOnboardingDone()
    onComplete()
  }

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-bg-glow" />
      <motion.div
        className="onboarding-modal"
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <button className="onboarding-skip" onClick={handleSkip}>Preskoči</button>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            className="onboarding-step"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
          >
            <div className="onboarding-icon">{current.icon}</div>
            <h2>{current.title}</h2>
            <p>{current.description}</p>
            <ul>
              {current.bullets.map((bullet, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.08 }}
                >
                  {bullet}
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </AnimatePresence>

        <div className="onboarding-footer">
          <div className="onboarding-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
            ))}
          </div>
          <button className="onboarding-next" onClick={handleNext}>
            {isLast ? 'Hajde da kreiramo!' : 'Dalje'}
            <ChevronRight size={16} />
          </button>
        </div>
      </motion.div>
    </div>
  )
}

import { useState, useCallback, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Welcome from './components/Welcome'
import LoadingTransition from './components/LoadingTransition'
import IDELayout from './components/IDELayout'
import { DEFAULT_MODEL } from './models'
import { type UserInfo } from './services/userService'
import { type SavedProject } from './services/projectStore'
import './App.css'

type AppState = 'welcome' | 'loading' | 'ide'

export default function App() {
  const [state, setState] = useState<AppState>('welcome')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [resumeProject, setResumeProject] = useState<SavedProject | null>(null)

  // Auto-select Lite for free tier users
  useEffect(() => {
    if (user?.freeTier && model !== 'vajb-agent-lite') {
      setModel('vajb-agent-lite')
    }
  }, [user?.freeTier])

  const handleAuth = useCallback((userInfo: UserInfo) => {
    setUser(userInfo)
  }, [])

  const handleStart = (text: string) => {
    setResumeProject(null)
    setPrompt(text)
    setState('loading')
  }

  const handleResume = (project: SavedProject) => {
    setResumeProject(project)
    setPrompt('')
    setModel(project.model)
    // Skip loading animation for resume — go straight to IDE
    setState('ide')
  }

  const handleLoadingComplete = useCallback(() => {
    setState('ide')
  }, [])

  const handleBackToWelcome = useCallback(() => {
    setResumeProject(null)
    setPrompt('')
    setState('welcome')
  }, [])

  const freeTier = user?.freeTier ?? true

  return (
    <AnimatePresence mode="wait">
      {state === 'welcome' && (
        <motion.div
          key="welcome"
          exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Welcome
            onStart={handleStart}
            onResume={handleResume}
            model={model}
            onModelChange={setModel}
            onAuth={handleAuth}
            user={user}
            freeTier={freeTier}
          />
        </motion.div>
      )}

      {state === 'loading' && (
        <motion.div
          key="loading"
          exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)' }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'fixed', inset: 0 }}
        >
          <LoadingTransition onComplete={handleLoadingComplete} />
        </motion.div>
      )}

      {state === 'ide' && (
        <motion.div
          key="ide"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          style={{ height: '100vh' }}
        >
          <IDELayout
            initialPrompt={prompt}
            model={model}
            onModelChange={setModel}
            freeTier={freeTier}
            resumeProject={resumeProject}
            onBackToWelcome={handleBackToWelcome}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText } from 'lucide-react'
import './FileMention.css'

interface Props {
  files: Record<string, string>
  query: string // text after @
  visible: boolean
  onSelect: (path: string) => void
}

export default function FileMention({ files, query, visible, onSelect }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const fileList = Object.keys(files)
    .filter(f => !f.endsWith('/'))
    .filter(f => !query || f.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8)

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  if (!visible || fileList.length === 0) return null

  return (
    <AnimatePresence>
      <motion.div
        className="file-mention"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.15 }}
      >
        <div className="file-mention-header">FAJLOVI</div>
        {fileList.map((path, i) => (
          <button
            key={path}
            className={`file-mention-item ${i === selectedIndex ? 'selected' : ''}`}
            onClick={() => onSelect(path)}
            onMouseEnter={() => setSelectedIndex(i)}
          >
            <FileText size={13} />
            <span>{path}</span>
          </button>
        ))}
      </motion.div>
    </AnimatePresence>
  )
}

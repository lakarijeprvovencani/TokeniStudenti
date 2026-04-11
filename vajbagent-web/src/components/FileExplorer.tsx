import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, FileCode, FileJson, Folder, Hash, ChevronRight, FolderOpen } from 'lucide-react'
import './FileExplorer.css'

interface FileExplorerProps {
  files: Record<string, string>
  activeFile: string | null
  onSelectFile: (path: string) => void
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''

  if (ext === 'html' || ext === 'htm') return <FileCode size={14} className="ficon ficon-html" />
  if (ext === 'css' || ext === 'scss') return <Hash size={14} className="ficon ficon-css" />
  if (ext === 'tsx' || ext === 'jsx') return <FileCode size={14} className="ficon ficon-react" />
  if (ext === 'ts' || ext === 'js') return <FileCode size={14} className="ficon ficon-js" />
  if (ext === 'json') return <FileJson size={14} className="ficon ficon-json" />
  if (ext === 'md') return <FileText size={14} className="ficon ficon-md" />
  return <FileText size={14} className="ficon" />
}

// Group files into folder structure
function buildTree(paths: string[]): { folders: Record<string, string[]>; rootFiles: string[] } {
  const folders: Record<string, string[]> = {}
  const rootFiles: string[] = []

  for (const p of paths) {
    const slashIdx = p.indexOf('/')
    if (slashIdx === -1) {
      rootFiles.push(p)
    } else {
      const folder = p.substring(0, slashIdx)
      if (!folders[folder]) folders[folder] = []
      folders[folder].push(p)
    }
  }
  return { folders, rootFiles }
}

function FolderGroup({ folder, folderFiles, activeFile, onSelectFile }: {
  folder: string
  folderFiles: string[]
  activeFile: string | null
  onSelectFile: (path: string) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="explorer-folder-group">
      <button className="explorer-folder" onClick={() => setOpen(!open)}>
        <motion.div
          className="folder-chevron"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <ChevronRight size={12} />
        </motion.div>
        {open ? (
          <FolderOpen size={14} className="ficon ficon-folder" />
        ) : (
          <Folder size={14} className="ficon ficon-folder" />
        )}
        <span>{folder}</span>
        <span className="folder-count">{folderFiles.length}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="folder-children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {folderFiles.map((path) => (
              <motion.button
                key={path}
                className={`explorer-file nested ${path === activeFile ? 'active' : ''}`}
                onClick={() => onSelectFile(path)}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
              >
                <FileIcon name={path} />
                <span className="file-name">{path.split('/').pop()}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function FileExplorer({ files, activeFile, onSelectFile }: FileExplorerProps) {
  const fileList = Object.keys(files).filter(f => !f.endsWith('/')).sort()
  const { folders, rootFiles } = buildTree(fileList)

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span>EXPLORER</span>
        <span className="explorer-count">{fileList.length}</span>
      </div>
      <div className="explorer-tree">
        {fileList.length === 0 ? (
          <div className="explorer-empty">
            <div className="empty-logo-wrap">
              <img src="/logo.svg" alt="" className="empty-logo" />
              <div className="empty-logo-ring" />
            </div>
            <span>Agent će kreirati fajlove...</span>
          </div>
        ) : (
          <>
            {/* Folders first */}
            {Object.entries(folders).map(([folder, folderFiles]) => (
              <FolderGroup
                key={folder}
                folder={folder}
                folderFiles={folderFiles}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
              />
            ))}

            {/* Root files */}
            <AnimatePresence>
              {rootFiles.map((path, i) => (
                <motion.button
                  key={path}
                  className={`explorer-file ${path === activeFile ? 'active' : ''}`}
                  onClick={() => onSelectFile(path)}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03 }}
                >
                  <FileIcon name={path} />
                  <span className="file-name">{path}</span>
                </motion.button>
              ))}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  )
}

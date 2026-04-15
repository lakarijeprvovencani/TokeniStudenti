import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, FileCode, FileJson, Folder, Hash, ChevronRight, FolderOpen, Key, FilePlus, FolderPlus, RefreshCw, FoldVertical, Trash2, Edit3, ImagePlus, Image as ImageIcon } from 'lucide-react'
import './FileExplorer.css'

interface FileExplorerProps {
  files: Record<string, string>
  activeFile: string | null
  onSelectFile: (path: string) => void
  onCreateFile?: (path: string, content: string) => void | Promise<void>
  onDeleteFile?: (path: string) => void | Promise<void>
  onRenameFile?: (oldPath: string, newPath: string) => void | Promise<void>
  onRefresh?: () => void
  onUploadImages?: (files: File[]) => void | Promise<void>
}

const IMAGE_EXT_SET = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif'])
const VIDEO_EXT_SET = new Set(['mp4', 'webm'])

function FileIcon({ name, preview }: { name: string; preview?: string }) {
  const base = name.split('/').pop() || name
  const ext = base.split('.').pop()?.toLowerCase() || ''

  // User-uploaded images: show a live thumbnail so the explorer looks premium.
  if (IMAGE_EXT_SET.has(ext) && preview && preview.startsWith('data:image/')) {
    return <img src={preview} alt="" className="ficon-thumb" />
  }
  if (IMAGE_EXT_SET.has(ext)) return <ImageIcon size={14} className="ficon ficon-image" />
  if (VIDEO_EXT_SET.has(ext)) return <FileCode size={14} className="ficon ficon-video" />

  // Env files — special orange key icon
  if (base === '.env' || base.startsWith('.env.')) return <Key size={13} className="ficon ficon-env" />
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

interface FileRowProps {
  path: string
  displayName: string
  nested?: boolean
  active: boolean
  preview?: string
  onSelect: () => void
  onDelete?: () => void
  onRename?: (newName: string) => void
  onUploadImages?: (files: File[]) => void | Promise<void>
}

function FileRow({ path, displayName, nested, active, preview, onSelect, onDelete, onRename, onUploadImages }: FileRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(displayName)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowUploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [renaming])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenuOpen(true)
  }

  const submitRename = () => {
    setRenaming(false)
    if (renameValue && renameValue !== displayName && onRename) {
      onRename(renameValue)
    }
  }

  const handleRowUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length > 0 && onUploadImages) await onUploadImages(picked)
    e.target.value = ''
  }

  if (renaming) {
    return (
      <div className={`explorer-file ${nested ? 'nested' : ''}`}>
        <FileIcon name={path} preview={preview} />
        <input
          ref={inputRef}
          className="rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename()
            if (e.key === 'Escape') { setRenaming(false); setRenameValue(displayName) }
          }}
        />
      </div>
    )
  }

  return (
    <>
      <motion.button
        layout
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -8 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className={`explorer-file ${nested ? 'nested' : ''} ${active ? 'active' : ''}`}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
      >
        <FileIcon name={path} preview={preview} />
        <span className="file-name">{displayName}</span>
      </motion.button>
      {menuOpen && (
        <>
          <div className="ctx-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="ctx-menu">
            {onUploadImages && (
              <button onClick={() => { setMenuOpen(false); rowUploadRef.current?.click() }}>
                <ImagePlus size={12} /> Dodaj sliku / video
              </button>
            )}
            <button onClick={() => { setMenuOpen(false); setRenaming(true) }}>
              <Edit3 size={12} /> Preimenuj
            </button>
            {onDelete && (
              <button className="ctx-danger" onClick={() => { setMenuOpen(false); onDelete() }}>
                <Trash2 size={12} /> Obriši
              </button>
            )}
          </div>
        </>
      )}
      <input
        ref={rowUploadRef}
        type="file"
        multiple
        accept="image/*,video/mp4,video/webm"
        style={{ display: 'none' }}
        onChange={handleRowUpload}
      />
    </>
  )
}

function FolderGroup({
  folder, folderFiles, activeFile, files, onSelectFile, isCollapsed, onToggleCollapse,
  onDeleteFile, onRenameFile, onCreateFile, onUploadImages,
}: {
  folder: string
  folderFiles: string[]
  activeFile: string | null
  files: Record<string, string>
  onSelectFile: (path: string) => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  onDeleteFile?: (path: string) => void | Promise<void>
  onRenameFile?: (oldPath: string, newPath: string) => void | Promise<void>
  onCreateFile?: (path: string, content: string) => void | Promise<void>
  onUploadImages?: (files: File[]) => void | Promise<void>
}) {
  const open = !isCollapsed
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder)
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const createRef = useRef<HTMLInputElement>(null)
  const folderUploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 0)
  }, [renaming])

  useEffect(() => {
    if (creatingFile) setTimeout(() => createRef.current?.focus(), 0)
  }, [creatingFile])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const submitRename = () => {
    setRenaming(false)
    if (renameValue && renameValue !== folder && onRenameFile) {
      for (const p of folderFiles) {
        onRenameFile(p, p.replace(new RegExp(`^${folder}/`), `${renameValue}/`))
      }
    }
  }

  const submitNewFile = async () => {
    const name = newFileName.trim()
    setCreatingFile(false)
    setNewFileName('')
    if (name && onCreateFile) {
      const path = `${folder}/${name}`
      await onCreateFile(path, '')
      onSelectFile(path)
    }
  }

  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length > 0 && onUploadImages) await onUploadImages(picked)
    e.target.value = ''
  }

  const deleteFolder = () => {
    if (!onDeleteFile) return
    for (const p of folderFiles) onDeleteFile(p)
  }

  const folderLabel = renaming ? (
    <div className="explorer-folder renaming">
      <Folder size={14} className="ficon ficon-folder" />
      <input
        ref={renameRef}
        className="rename-input"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={submitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitRename()
          if (e.key === 'Escape') { setRenaming(false); setRenameValue(folder) }
        }}
      />
    </div>
  ) : (
    <button className="explorer-folder" onClick={onToggleCollapse} onContextMenu={handleContextMenu}>
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
  )

  return (
    <div className="explorer-folder-group">
      {folderLabel}

      {menuOpen && (
        <>
          <div className="ctx-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="ctx-menu">
            {onCreateFile && (
              <button onClick={() => { setMenuOpen(false); setCreatingFile(true); if (!open) onToggleCollapse() }}>
                <FilePlus size={12} /> Novi fajl
              </button>
            )}
            {onUploadImages && (
              <button onClick={() => { setMenuOpen(false); folderUploadRef.current?.click() }}>
                <ImagePlus size={12} /> Dodaj sliku / video
              </button>
            )}
            <button onClick={() => { setMenuOpen(false); setRenaming(true); setRenameValue(folder) }}>
              <Edit3 size={12} /> Preimenuj
            </button>
            {onDeleteFile && (
              <button className="ctx-danger" onClick={() => { setMenuOpen(false); deleteFolder() }}>
                <Trash2 size={12} /> Obriši folder
              </button>
            )}
          </div>
        </>
      )}

      <input
        ref={folderUploadRef}
        type="file"
        multiple
        accept="image/*,video/mp4,video/webm"
        style={{ display: 'none' }}
        onChange={handleFolderUpload}
      />

      <AnimatePresence>
        {open && (
          <motion.div
            className="folder-children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {creatingFile && (
              <div className="explorer-file nested creating">
                <FileText size={14} className="ficon" />
                <input
                  ref={createRef}
                  className="rename-input"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="filename.html"
                  onBlur={submitNewFile}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitNewFile()
                    if (e.key === 'Escape') { setCreatingFile(false); setNewFileName('') }
                  }}
                />
              </div>
            )}
            <AnimatePresence initial={false}>
              {folderFiles.map((path) => (
                <FileRow
                  key={path}
                  path={path}
                  displayName={path.split('/').pop() || path}
                  nested
                  active={path === activeFile}
                  preview={files[path]}
                  onSelect={() => onSelectFile(path)}
                  onDelete={onDeleteFile ? () => onDeleteFile(path) : undefined}
                  onRename={onRenameFile ? (newName: string) => {
                    const dir = path.substring(0, path.lastIndexOf('/'))
                    return onRenameFile(path, dir ? `${dir}/${newName}` : newName)
                  } : undefined}
                  onUploadImages={onUploadImages}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function FileExplorer({
  files, activeFile, onSelectFile, onCreateFile, onDeleteFile, onRenameFile, onRefresh, onUploadImages,
}: FileExplorerProps) {
  const fileList = Object.keys(files).filter(f => !f.endsWith('/')).sort()
  const { folders, rootFiles } = buildTree(fileList)

  // Inline create new file/folder
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const newInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const handleImageButtonClick = () => {
    imageInputRef.current?.click()
  }

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length > 0 && onUploadImages) {
      await onUploadImages(picked)
    }
    e.target.value = ''
  }

  // Drag & drop: highlight the panel when an image file is dragged over it,
  // accept drops anywhere inside, ignore non-image drops so text file drag
  // keeps whatever other handling the page has.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!onUploadImages) return
    if (!Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) return
    e.preventDefault()
    dragDepth.current++
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!onUploadImages) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  const handleDragOver = (e: React.DragEvent) => {
    if (!onUploadImages) return
    e.preventDefault()
  }
  const handleDrop = async (e: React.DragEvent) => {
    if (!onUploadImages) return
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'))
    if (dropped.length > 0) await onUploadImages(dropped)
  }

  // Clipboard paste — Cmd/Ctrl+V anywhere while the explorer is the
  // focused context pastes images from the clipboard into the project.
  useEffect(() => {
    if (!onUploadImages) return
    const handler = async (e: ClipboardEvent) => {
      // Never hijack paste when the user is typing somewhere.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const items = e.clipboardData?.items
      if (!items) return
      const pasted: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f && (f.type.startsWith('image/') || f.type.startsWith('video/'))) pasted.push(f)
        }
      }
      if (pasted.length > 0) {
        e.preventDefault()
        await onUploadImages(pasted)
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [onUploadImages])

  useEffect(() => {
    if (creating) {
      setTimeout(() => newInputRef.current?.focus(), 0)
    }
  }, [creating])

  const handleNewFile = () => {
    setCreating('file')
    setNewName('')
  }

  const handleNewFolder = () => {
    setCreating('folder')
    setNewName('')
  }

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) {
      setCreating(null)
      return
    }
    if (creating === 'file' && onCreateFile) {
      await onCreateFile(name, '')
      onSelectFile(name)
    } else if (creating === 'folder' && onCreateFile) {
      // Create a placeholder file inside the folder so it shows up
      await onCreateFile(`${name}/.gitkeep`, '')
    }
    setCreating(null)
    setNewName('')
  }

  const handleCollapseAll = () => {
    setCollapsed(new Set(Object.keys(folders)))
  }

  const toggleFolder = (folder: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  return (
    <div
      className={`explorer ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="explorer-header">
        <span>EXPLORER</span>
        <span className="explorer-count">{fileList.length}</span>
      </div>
      {(onCreateFile || onRefresh || onUploadImages) && (
        <div className="explorer-toolbar">
          {onCreateFile && (
            <button className="explorer-tool-btn" onClick={handleNewFile} title="Novi fajl">
              <FilePlus size={13} />
            </button>
          )}
          {onCreateFile && (
            <button className="explorer-tool-btn" onClick={handleNewFolder} title="Novi folder">
              <FolderPlus size={13} />
            </button>
          )}
          {onUploadImages && (
            <button className="explorer-tool-btn" onClick={handleImageButtonClick} title="Dodaj sliku / video">
              <ImagePlus size={13} />
            </button>
          )}
          {onRefresh && (
            <button className="explorer-tool-btn" onClick={onRefresh} title="Osveži">
              <RefreshCw size={13} />
            </button>
          )}
          <button className="explorer-tool-btn" onClick={handleCollapseAll} title="Sakrij sve foldere">
            <FoldVertical size={13} />
          </button>
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*,video/mp4,video/webm"
        style={{ display: 'none' }}
        onChange={handleImagePick}
      />
      {dragOver && (
        <div className="explorer-drop-overlay">
          <ImagePlus size={28} />
          <span>Pusti sliku ili video da dodaš u projekat</span>
        </div>
      )}
      <div className="explorer-tree">
        {fileList.length === 0 && !creating ? (
          <div className="explorer-empty">
            <div className="empty-logo-wrap">
              <img src="/logo.svg" alt="" className="empty-logo" />
              <div className="empty-logo-ring" />
            </div>
            <span>Agent će kreirati fajlove...</span>
          </div>
        ) : (
          <>
            {/* Inline create input */}
            {creating && (
              <div className="explorer-file creating">
                {creating === 'file' ? <FileText size={14} className="ficon" /> : <Folder size={14} className="ficon ficon-folder" />}
                <input
                  ref={newInputRef}
                  className="rename-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={creating === 'file' ? 'index.html' : 'src'}
                  onBlur={submitNew}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitNew()
                    if (e.key === 'Escape') { setCreating(null); setNewName('') }
                  }}
                />
              </div>
            )}

            {/* Folders first */}
            {Object.entries(folders).map(([folder, folderFiles]) => (
              <FolderGroup
                key={folder}
                folder={folder}
                folderFiles={folderFiles}
                activeFile={activeFile}
                files={files}
                onSelectFile={onSelectFile}
                isCollapsed={collapsed.has(folder)}
                onToggleCollapse={() => toggleFolder(folder)}
                onDeleteFile={onDeleteFile}
                onRenameFile={onRenameFile}
                onCreateFile={onCreateFile}
                onUploadImages={onUploadImages}
              />
            ))}

            {/* Root files */}
            <AnimatePresence initial={false}>
              {rootFiles.map((path) => (
                <FileRow
                  key={path}
                  path={path}
                  displayName={path}
                  active={path === activeFile}
                  preview={files[path]}
                  onSelect={() => onSelectFile(path)}
                  onDelete={onDeleteFile ? () => onDeleteFile(path) : undefined}
                  onRename={onRenameFile ? (newName: string) => onRenameFile(path, newName) : undefined}
                  onUploadImages={onUploadImages}
                />
              ))}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  )
}

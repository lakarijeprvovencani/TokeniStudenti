/**
 * Project templates — pre-defined starter prompts that give the agent
 * specific instructions to build complete, working projects.
 */

export interface Template {
  id: string
  name: string
  description: string
  icon: string  // emoji
  category: 'web' | 'app' | 'tool' | 'fun'
  prompt: string
}

export const TEMPLATES: Template[] = [
  // ─── Web Sites ──────────────────────────────────────────────────────────
  {
    id: 'landing-saas',
    name: 'SaaS Landing',
    description: 'Moderan landing page za SaaS proizvod',
    icon: '🚀',
    category: 'web',
    prompt: 'Napravi moderan SaaS landing page sa: hero sekcijom (gradijent pozadina, naslov, CTA dugme), features sekcijom (3 kartice sa ikonama), pricing tabelom (3 plana), testimonials sekcijom, FAQ accordion-om, i footer-om. Stack: HTML + CSS (bez JS framework-a). Premium dizajn, dark theme sa orange accent bojom.',
  },
  {
    id: 'portfolio-dev',
    name: 'Portfolio',
    description: 'Lični portfolio za developera',
    icon: '👨‍💻',
    category: 'web',
    prompt: 'Napravi portfolio sajt za developera. Sadržaj: hero sa imenom i pozicijom, About sekciju, Skills sa progress bars, Projects galeriju (6 projekata sa slikama), Experience timeline, Contact formu. Stack: HTML + CSS + vanilla JS. Modern minimalist dizajn, dark theme.',
  },
  {
    id: 'restaurant',
    name: 'Restoran',
    description: 'Sajt za restoran sa menijem',
    icon: '🍕',
    category: 'web',
    prompt: 'Napravi sajt za restoran sa: hero sekcijom sa fotografijom hrane, About sekcijom, kompletnim menijem (predjela, glavna jela, deserti, pića sa cenama), galerijom slika, kontakt informacijama, formom za rezervaciju, i footer-om sa radnim vremenom. Topao dizajn, prijatne boje. Koristi Unsplash slike za hranu.',
  },
  {
    id: 'agency',
    name: 'Agencija',
    description: 'Sajt za digitalnu agenciju',
    icon: '🏢',
    category: 'web',
    prompt: 'Napravi sajt za digitalnu agenciju. Sekcije: hero sa bold tipografijom i CTA, services (web dev, design, marketing, SEO), portfolio grid, tim sekcija sa fotografijama, klijenti (logoi), CTA blok pre footer-a. Premium dizajn, bold tipografija, animacije pri scroll-u.',
  },

  // ─── Apps ──────────────────────────────────────────────────────────────
  {
    id: 'admin-dashboard',
    name: 'Admin Dashboard',
    description: 'Admin panel sa statistikama i tabelama',
    icon: '📊',
    category: 'app',
    prompt: 'Napravi admin dashboard u React + Vite stack-u. Sadržaj: sidebar navigacija (Dashboard, Korisnici, Narudžbine, Postavke), top bar sa search-om i avatar-om, glavni dashboard sa 4 stats kartice (prihodi, korisnici, narudžbine, konverzija), grafikon (chart.js ili svg), tabela skorašnjih narudžbina sa pagination-om. Dark tema, moderan dizajn.',
  },
  {
    id: 'todo-app',
    name: 'Todo App',
    description: 'Todo aplikacija sa kategorijama',
    icon: '✅',
    category: 'app',
    prompt: 'Napravi todo aplikaciju u React + Vite stack-u. Funkcionalnosti: dodavanje/brisanje/edit zadataka, kategorije (Posao, Lično, Hitno), filteri (Sve, Aktivni, Završeni), drag & drop reorder, dark mode toggle, persistencija u localStorage. Moderan minimalist dizajn.',
  },
  {
    id: 'chat-ui',
    name: 'Chat Interface',
    description: 'Chat UI kao ChatGPT/Claude',
    icon: '💬',
    category: 'app',
    prompt: 'Napravi chat interface u React + Vite stack-u koji izgleda kao ChatGPT/Claude. Komponente: sidebar sa istorijom razgovora, glavni chat area sa message bubble-ovima (user desno, AI levo), input polje na dnu sa send dugmetom, model selector dropdown na vrhu. Mock podatke za poruke. Dark tema sa orange accent.',
  },
  {
    id: 'kanban-board',
    name: 'Kanban Board',
    description: 'Trello-style kanban board',
    icon: '📋',
    category: 'app',
    prompt: 'Napravi Kanban board u React + Vite stack-u. 3 kolone (To Do, In Progress, Done), kartice se mogu prevlačiti između kolona (drag and drop), dodavanje novih kartica, brisanje, edit, persistencija u localStorage. Trello-like dizajn, ali tamna tema.',
  },

  // ─── Tools ─────────────────────────────────────────────────────────────
  {
    id: 'calculator',
    name: 'Kalkulator',
    description: 'Kalkulator sa naučnim funkcijama',
    icon: '🔢',
    category: 'tool',
    prompt: 'Napravi kalkulator. Standardne operacije (+, -, *, /), naučne funkcije (sin, cos, tan, log, sqrt, pow), istorija računanja, keyboard support, dark/light tema. Stack: HTML + CSS + JS. Veliki, čitki tasteri, glassmorphism dizajn.',
  },
  {
    id: 'pomodoro',
    name: 'Pomodoro Timer',
    description: 'Productivity timer 25/5',
    icon: '⏰',
    category: 'tool',
    prompt: 'Napravi Pomodoro timer aplikaciju. 25 min rad / 5 min pauza, dugmad za start/pause/reset, zvučni signal kad istekne, statistika završenih ciklusa, todo lista uz timer. Stack: HTML + CSS + JS. Minimalan, fokusiran dizajn.',
  },
  {
    id: 'qr-generator',
    name: 'QR Generator',
    description: 'Generator QR kodova',
    icon: '📱',
    category: 'tool',
    prompt: 'Napravi QR kod generator. Korisnik unosi text/URL, dobija QR kod. Mogućnost preuzimanja kao PNG, izbor boje QR koda, izbor veličine. Koristi qrcode.js biblioteku. Stack: HTML + CSS + JS. Čist, jednostavan dizajn.',
  },

  // ─── Fun ───────────────────────────────────────────────────────────────
  {
    id: 'snake-game',
    name: 'Snake Igrica',
    description: 'Klasična Snake igrica',
    icon: '🐍',
    category: 'fun',
    prompt: 'Napravi Snake igricu u canvas-u. Strelice za kontrolu, score brojač, game over ekran sa restart dugmetom, high score u localStorage, postepeno povećanje brzine. Stack: HTML + CSS + JS canvas. Retro dizajn sa neon bojama.',
  },
  {
    id: 'memory-game',
    name: 'Memory Igra',
    description: 'Igra pamćenja sa kartama',
    icon: '🃏',
    category: 'fun',
    prompt: 'Napravi memory igru sa kartama. 16 karata (8 parova), klikni dve da otkrijes, ako su iste ostaju otvorene, ako nisu zatvore se. Score, broj poteza, timer, restart dugme. Stack: HTML + CSS + JS. Šarene karte sa emoji-jima ili ikonama.',
  },
]

export const TEMPLATE_CATEGORIES = [
  { id: 'web', name: 'Web sajtovi', icon: '🌐' },
  { id: 'app', name: 'Aplikacije', icon: '⚛️' },
  { id: 'tool', name: 'Alati', icon: '🛠️' },
  { id: 'fun', name: 'Igrice', icon: '🎮' },
] as const

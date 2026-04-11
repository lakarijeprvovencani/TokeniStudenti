export interface Command {
  name: string
  label: string
  description: string
  icon: string
  type: 'command' | 'skill'
  /** For commands: the message template. {arg} is replaced with user input */
  message?: string
  /** For skills: the prompt injected into system context */
  skillPrompt?: string
}

export const COMMANDS: Command[] = [
  {
    name: 'test',
    label: '/test',
    description: 'Generiši testove',
    icon: 'FlaskConical',
    type: 'command',
    message: 'Napisi unit testove za {arg}. Koristi testing framework koji projekat vec koristi. Ako nema, predlozi odgovarajuci.',
  },
  {
    name: 'fix',
    label: '/fix',
    description: 'Popravi greške',
    icon: 'Wrench',
    type: 'command',
    message: 'Pronadji i popravi greske u {arg}. Proveri logicke greske, tipove, edge case-ove.',
  },
  {
    name: 'doc',
    label: '/doc',
    description: 'Dodaj dokumentaciju',
    icon: 'FileText',
    type: 'command',
    message: 'Dodaj dokumentaciju (JSDoc/docstring komentare) za {arg}. Dokumentuj parametre, return vrednosti i primere koriscenja.',
  },
  {
    name: 'commit',
    label: '/commit',
    description: 'Predlog commit poruke',
    icon: 'GitCommitHorizontal',
    type: 'command',
    message: 'Pregledaj sve promene u projektu i predlozi commit poruku. Koristi konvencionalni format (feat/fix/chore/docs).',
  },
  {
    name: 'explain',
    label: '/explain',
    description: 'Objasni kod',
    icon: 'MessageCircleQuestion',
    type: 'command',
    message: 'Objasni detaljno kako radi {arg}. Opisi arhitekturu, tok podataka, kljucne odluke i potencijalne probleme.',
  },
  {
    name: 'refactor',
    label: '/refactor',
    description: 'Refaktoriši kod',
    icon: 'RefreshCw',
    type: 'command',
    message: 'Refaktorisi i poboljsaj kvalitet koda u {arg}. Poboljsaj citljivost, strukturu i performanse bez menjanja funkcionalnosti.',
  },
]

export const SKILLS: Command[] = [
  {
    name: 'dizajn',
    label: '/dizajn',
    description: 'UI/CSS dizajn ekspert',
    icon: 'Palette',
    type: 'skill',
    skillPrompt: `<skill_context name="dizajn">
UI/CSS Design Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Procitaj trenutni kod i identifikuj UI elemente koji se menjaju ili kreiraju.
2. Pre svake izmene proveri koji CSS framework projekat koristi i prati ga konzistentno.
3. Primeni sledece principe:

LAYOUT: flexbox ili CSS grid, jasna vizuelna hijerarhija, spacing u konzistentnim koracima (4/8/12/16/24/32/48px).
TIPOGRAFIJA: max 2 fonta, line-height 1.5 za body, 1.2 za headinge, rem/em za font-size.
BOJE: CSS varijable, dovoljan kontrast (WCAG AA 4.5:1), konzistentan palette.
RESPONZIVNOST: mobile-first, breakpointi 576/768/992/1200px, nema overflow-x.
ANIMACIJE: hover subtle scale/opacity/shadow, transition 0.15-0.3s ease, CSS animacije > JS.
KOMPONENTE: svaka mora imati loading, success, error, empty stanje.

OGRANICENJA: NE inline stilove, NE !important, NE apsolutno pozicioniranje za layout, prati postojeci stil.
</skill_context>`,
  },
  {
    name: 'api',
    label: '/api',
    description: 'REST/backend endpoint',
    icon: 'Zap',
    type: 'skill',
    skillPrompt: `<skill_context name="api">
REST API / Backend Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Procitaj postojece rute i middleware, identifikuj framework (Express, Fastify, Next.js API routes).
2. RESTful konvencije: GET citanje, POST kreiranje, PUT/PATCH azuriranje, DELETE brisanje.
3. Konzistentno imenovanje: /api/users, /api/users/:id.
4. HTTP status kodovi: 200, 201, 204, 400, 401, 403, 404, 409, 500.
5. Validiraj SVE ulazne podatke (body, params, query).
6. Centralizovan error handler, nikad stack trace u produkciji.
7. Parametrizovani upiti, CORS eksplicitno, ne hardkoduj kredencijale.
</skill_context>`,
  },
  {
    name: 'baza',
    label: '/baza',
    description: 'SQL/Prisma/baza podataka',
    icon: 'Database',
    type: 'skill',
    skillPrompt: `<skill_context name="baza">
Database / SQL / ORM Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Identifikuj ORM (Prisma, Drizzle, Knex, Sequelize, MongoDB/Mongoose).
2. Procitaj postojecu schema-u pre predlaganja promena.
3. Schema: primarni kljuc, createdAt/updatedAt, odgovarajuci tipovi, foreign key odnosi.
4. Upiti: parametrizovani (NIKAD string konkatenacija), selektuj samo potrebna polja, dodaj indekse.
5. Migracije: reverzibilne (up/down), testiraj na praznoj bazi.
6. Relacije: One-to-many FK na "many" strani, Many-to-many junction tabela.
7. NE brisi tabele bez zahteva, NE menjaj primenjene migracije, hash lozinke, izbegavaj N+1.
</skill_context>`,
  },
  {
    name: 'perf',
    label: '/perf',
    description: 'Optimizacija performansi',
    icon: 'Gauge',
    type: 'skill',
    skillPrompt: `<skill_context name="perf">
Performance Optimization Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Procitaj kod i identifikuj uska grla pre predlaganja izmena.
2. Frontend: bundle size, lazy loading, slike (WebP/AVIF), memo samo kad je merljiv problem.
3. Backend: N+1 problemi, nedostajuci indeksi, caching, Promise.all za nezavisne operacije.
4. Algoritmi: O(n^2) → O(n log n), Map/Set umesto Array za lookup.
5. NE optimizuj premature, NE zrtvuj citljivost, OBJASNI ocekivani uticaj.
</skill_context>`,
  },
  {
    name: 'security',
    label: '/security',
    description: 'Provera bezbednosti',
    icon: 'ShieldCheck',
    type: 'skill',
    skillPrompt: `<skill_context name="security">
Security Review Skill — aktiviran za ovaj zahtev.

PROCEDURA — proveri OWASP Top 10:
1. INJECTION: parametrizovani upiti, ne exec/eval sa korisnickim podacima.
2. AUTH: bcrypt/argon2 za lozinke, rate limiting na login, JWT tajne jake.
3. DATA EXPOSURE: ne hardkoduj kredencijale, ne vracaj vise podataka nego treba, .env u .gitignore.
4. XSS: escape korisnicki unos, ne innerHTML sa korisnickim podacima.
5. CONFIG: CORS eksplicitno, security headeri (CSP, X-Frame-Options), debug off u produkciji.
6. CRYPTO: ne MD5/SHA1/DES, crypto.randomBytes umesto Math.random.

FORMAT: [KRITICNO/VISOKO/SREDNJE/NISKO] Opis — Fajl:linija — Fix.
</skill_context>`,
  },
  {
    name: 'convert',
    label: '/convert',
    description: 'Konverzija koda',
    icon: 'ArrowLeftRight',
    type: 'skill',
    skillPrompt: `<skill_context name="convert">
Code Conversion Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Procitaj izvorni kod kompletno pre konverzije.
2. Sacuvaj IDENTICNU funkcionalnost — konverzija ne menja ponasanje.
3. Koristi idiome ciljnog jezika (JS forEach → Python list comprehension, callback → async/await).
4. Prilagodi naming konvenciju (camelCase za JS/TS, snake_case za Python).
5. Zameni biblioteke ekvivalentima (axios → requests, lodash → Python stdlib).
6. JS → TS: dodaj tipove, ne koristi 'any'. TS → JS: ukloni tipove cisto.
7. NE dodaj novu funkcionalnost, NE preskaci delove, konvertuj SVE.
</skill_context>`,
  },
  {
    name: 'style',
    label: '/style',
    description: 'Stil i konvencije koda',
    icon: 'Sparkles',
    type: 'skill',
    skillPrompt: `<skill_context name="style">
Coding Style Skill — aktiviran za ovaj zahtev.

PROCEDURA:
1. Procitaj kod i identifikuj postojece konvencije, proveri linter/formatter config.
2. Imenovanje: opisna imena, boolean is/has/can prefiks, SCREAMING_SNAKE za konstante, PascalCase klase.
3. Struktura: jedna funkcija — jedna odgovornost, early return, logicko grupisanje.
4. Konzistentnost: isti pattern za iste stvari, ne mesaj stilove bez razloga.
5. NE menjaj logiku, NE dodaj ocigledne komentare, prati POSTOJECE konvencije projekta.
</skill_context>`,
  },
]

export const ALL_COMMANDS = [...COMMANDS, ...SKILLS]

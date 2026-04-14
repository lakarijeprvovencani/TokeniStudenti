# VajbAgent — Handoff: Backend-first Storage (Cloudflare R2 + Postgres)

**Ovaj dokument je za sledećeg Claude agenta koji će preuzeti migraciju.** Ceo
kontekst potreban za posao je unutra. Nikakvo pitanje korisnika nije potrebno
osim potvrde "krećemo".

---

## 1. Šta je VajbAgent (trenutno stanje)

VajbAgent je bolt.new-slična web aplikacija: korisnik ukuca opis, AI agent pravi
kompletan sajt/aplikaciju u browseru. Sve radi end-to-end u produkciji:

- **Frontend SPA**: React + Vite + TypeScript, `vajbagent-web/`, deploy na
  `https://vajbagent.netlify.app` (grandfathered *.netlify.app origin — jedini
  način da WebContainer API radi bez StackBlitz OAuth-a)
- **Backend**: Node.js + Express, `src/`, deploy na Render, domen `vajbagent.com`
- **Apex domen** (`vajbagent.com`) — Express servira Cursor/VS Code landing na
  `/extenzija` i SPA redirect na `/` koji šalje na `vajbagent.netlify.app`
- **Baza**: Upstash Redis (sesije, kredite, stripe events) — nema Postgres/SQL
- **Runtime**: WebContainers (@webcontainer/api) u browseru — virtualni Node.js
  koji gradi/pokreće korisničke projekte
- **Auth**: session cookies sa `/auth/login`, `/auth/register`, per-user
  `student_key_id` hash koji je javno bezbedan identifikator
- **Plaćanja**: Stripe Checkout, credits model ($1 = 1000 kredita u UI)
- **Integracije koje korisnik povezuje preko OAuth-a**: GitHub push, Netlify
  deploy, Supabase (kreira Edge Functions, upravlja bazom korisnika)

Backend endpointi relevantni za migraciju:
- `/auth/me` — vraća `{ name, user_id, balance_usd, free_tier }`
- `/api/github/push` — primenjuje filter, prihvata data URL slike kao base64
- `/api/netlify/deploy` — isto, dekodira data URL u Buffer pre upload-a
- `POST /create-checkout` — Stripe session sa return_url whitelist-om

## 2. Šta je trenutno u browseru (problem koji rešavamo)

Sva korisnička stanja **trenutno žive u IndexedDB-u**, prefixovana po user_id-u
da dva korisnika na istom browser profilu ne vide tuđe stvari:

- `vajbagent-projects::<userId>` — IndexedDB baza, svaki projekat kao
  `SavedProject { id, name, files, chatHistory, displayMessages, model, ... }`
- `vajb_env_secrets::<userId>` — localStorage, user-defined env varijable
- `vajb_last_active_project::<userId>` — localStorage pointer
- `vajb_unsaved_project::<userId>` — localStorage emergency backup
- `vajb_session::<userId>` — localStorage, chat draft session
- Razni `vajb_supabase_*`, `vajb_github_repo`, `vajb_netlify_token` —
  scopedStorage helper u `services/storageScope.ts`

**Svaki `SavedProject.files` je `Record<string, string>` — svaki fajl je tekst
ili (za slike) data URL `data:image/jpeg;base64,...`.** Upload slika radi:
`imageResize.ts` smanjuje na <=1600px, JPEG ~900KB max, upisuje se u WC
filesystem kao Uint8Array i u `files` map-u kao data URL za IndexedDB.

## 3. Zašto backend migracija

- **Cross-device**: korisnik radi na laptopu, hoće da nastavi na drugom računaru
- **Cross-browser**: Chrome → Safari gubi sve
- **Brisanje browser podataka** briše sve projekte
- **IndexedDB quota** — 50% free disk-a, ali ogroman broj data URL slika moze
  da baci upozorenja
- **Deljenje projekta**: jedan link koji otvara projekat negde drugde

**Cloudflare R2 je izabran** jer:
- $0 bandwidth zauvek (ključno — slike se gledaju mnogo više nego upload-uju)
- 10GB free storage (dovoljno za 500+ aktivnih korisnika)
- S3-kompatibilan API (library izbor, nula vendor lock-in)
- Cloudflare već servisira DNS za vajbagent.com (jedan provider)

**Postgres** je potreban za metadatu projekata (id, name, owner, timestamps).
Predlog: Supabase Postgres (free 500MB, korisnik već koristi Supabase za
integracije), ili Neon (free 512MB), ili dodati Postgres add-on na Render.
**Odluku donosi korisnik na početku sledeće sesije** — preporuka je Supabase
jer već ima wiring na backend-u (`src/supabaseOAuth.js`, `supabase_*` tool-ovi).

## 4. Šta TREBA DA SE URADI (task list)

### Faza A — Backend infrastruktura (dan 1)

1. **Odluka o bazi**: Supabase Postgres vs Neon vs Render Postgres. Default:
   Supabase jer postoji integracija.
2. **Schema**:
   ```sql
   create table projects (
     id text primary key,                 -- slug ili uuid
     owner_key_id text not null,          -- SHA hash student key-ja
     name text not null,
     prompt text,
     model text not null default 'vajb-agent-turbo',
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   );
   create index projects_owner_idx on projects (owner_key_id, updated_at desc);

   create table project_files (
     project_id text references projects(id) on delete cascade,
     path text not null,
     kind text not null check (kind in ('text', 'binary')),
     -- For text files: inline UTF-8 content
     text_content text,
     -- For binary files: R2 object key (bucket-relative path)
     r2_key text,
     size_bytes int,
     updated_at timestamptz default now(),
     primary key (project_id, path)
   );

   create table project_chat (
     project_id text primary key references projects(id) on delete cascade,
     history jsonb not null default '[]',
     display_messages jsonb not null default '[]',
     updated_at timestamptz default now()
   );
   ```
3. **Cloudflare R2 bucket**: `vajbagent-uploads`, privatni (objekti se serviraju
   preko presigned GET URL-a ili preko public subdomain-a tipa
   `assets.vajbagent.com`). Credentials idu u Render env:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET` (= vajbagent-uploads)
   - `R2_PUBLIC_BASE_URL` (ako javni, npr. `https://assets.vajbagent.com`)
4. **S3 SDK**: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
   u root package.json (backend koristi root)
5. **Novi moduli**:
   - `src/r2.js` — S3Client wrapper: `putObject(key, buffer, contentType)`,
     `deleteObject(key)`, `getSignedUploadUrl(key, contentType, expiresSec)`,
     `publicUrl(key)` (ako public base postoji)
   - `src/projectStore.js` — Postgres DAL: `listProjects(ownerKeyId)`,
     `loadProject(ownerKeyId, projectId)`, `saveProject(ownerKeyId, project)`,
     `deleteProject(ownerKeyId, projectId)`, `saveChat(projectId, chat)`,
     svi ovi prave row-level security check-ove na `owner_key_id`
6. **Novi endpointi** u `src/index.js`:
   ```
   GET    /api/projects                         list for current user
   GET    /api/projects/:id                     full project + files + chat
   POST   /api/projects                         create (body: name, prompt, model)
   PATCH  /api/projects/:id                     update (name, prompt, model)
   DELETE /api/projects/:id                     cascade delete + R2 cleanup
   PUT    /api/projects/:id/files/:path*        upsert single text file
   DELETE /api/projects/:id/files/:path*        delete single file
   POST   /api/projects/:id/autosave            bulk patch (text files + chat)
   POST   /api/projects/:id/uploads/sign        returns presigned R2 PUT URL
                                                 body: { path, contentType, sizeBytes }
                                                 validates: size <= 2MB, contentType in
                                                 whitelist, path in public/, image count <= 20
   POST   /api/projects/:id/uploads/commit      after client uploads to R2,
                                                 client calls this to create the
                                                 project_files row. backend verifies
                                                 object exists in R2 via HEAD.
   ```
7. Svi endpointi ID-uju korisnika preko postojeće `requireAuth` middleware-a i
   koriste `req.studentKeyId` kao owner filter.

### Faza B — Frontend migracija (dan 1-2)

8. **Novi servis** `vajbagent-web/src/services/remoteProjectStore.ts` koji
   implementira isti API kao postojeći `projectStore.ts` ali preko `fetch`-a
   ka backend endpoint-ima. Type-level kompatibilan sa `SavedProject`.
9. **Slike**: `userAssets.ts` treba da:
   - Ne stavlja više data URL u `files` map-u
   - Umesto toga: zove `POST /api/projects/:id/uploads/sign` → dobija presigned
     URL → PUT sliku direktno na R2 → zove `commit` endpoint → upisuje u
     `files[path] = publicR2Url` (ne data URL, već stvarni URL)
10. **Preview**: `PreviewPanel.inlineImageRefs` treba da prepozna i javne R2
    URL-ove u `<img src>` i da ih pusti kroz (ne treba da inline-uje, iframe
    će moći da ih fetch-uje jer bucket ima CORS: allow `https://vajbagent.netlify.app`
    i `https://vajbagent.com`)
11. **WebContainer hydration**: umesto `hydrateImagesIntoWc` koji dekodira data
    URL, treba da `fetch` R2 URL-ove i upiše Uint8Array u WC fs. Cache po user
    sesiji da se ne fetch-uje svaki put.
12. **App.tsx boot**: auto-resume logika poziva `remoteProjectStore.listProjects()`
    umesto IndexedDB-ja. Migration helper: ako postoji lokalni IndexedDB sa
    projektima (old client), ponudi korisniku "Prebaci X projekata u cloud"
    dugme koje sve pošalje preko novih POST endpointa.
13. **GitHub/Netlify push**: backend već dekodira data URL → treba da bude
    dograđen da **fetch-uje R2 objekat pre push-a** i ubaci pravi binary
    umesto data URL-a. `src/githubOAuth.js` i `src/netlifyOAuth.js` dobijaju
    helper `async function resolveBinary(fileRow)` koji ide u R2 ako je
    `kind === 'binary'`.

### Faza C — Cleanup (dan 2)

14. Postojeći IndexedDB kod (`projectStore.ts`, `hydrateImagesIntoWc`,
    `vajb_last_active_project::` localStorage) ostaje kao **fallback** za
    offline ali gubi ulogu "source of truth".
15. Autosave rate limit: ne zvati `/api/projects/:id/autosave` više od 1×/3s.
16. Error handling: ako R2 upload padne, korisnik vidi toast sa "pokušaj
    ponovo" dugme. Project se ne gubi jer data URL ostaje u React state-u
    kao lokalni fallback dok upload ne prođe.
17. Observability: Sentry add-on (već predloženo ranije), 5k events/mesec
    besplatno.

## 5. Bezbednosna razmatranja

- **Presigned URL-ovi vredi do 5 minuta max**, sa content-type i size limit-om
  na backend-u
- **Svaki R2 key uključuje `owner_key_id` kao prefix**:
  `<ownerKeyId>/<projectId>/<slugifiedFilename>` — čak i ako neko ukrade
  project_id, ne može da pristupi tuđim fajlovima
- **Nikad ne izdavati presigned GET URL-ove** — javni bucket sa custom domenom
  ILI backend endpoint koji provera vlasništvo pre streaming-a. Preporuka:
  javni R2 bucket sa obfuskiranim putanjama (project_id je slug, ne inkrementalan)
- **CORS na R2 bucket-u**: allow-origin whitelist = isti kao `WEB_ORIGINS`
  env var — `vajbagent.com`, `vajbagent.netlify.app`, `localhost:5173`
- **Quota check** na backend-u pre svakog `sign` poziva: postojeći broj
  slika i ukupna veličina iz `project_files` — koristi iste limite kao
  frontend (20 slika, 2MB po slici, 35MB po projektu)
- **Brisanje kaskadom**: kada se projekat briše, trigger ili DAL logika mora
  da obriše sve R2 objekte sa prefix-om `<ownerKeyId>/<projectId>/`

## 6. Šta NE DIRATI

- **WebContainer integracija** (`services/webcontainer.ts`) — grandfathered
  host detection, auth.init logika, boot timeout. Apsolutno ne dirati osim
  ako treba dodati `hydrateFromR2` helper.
- **Stripe flow** (`/create-checkout`, webhook, credit system) — radi
  savršeno, out of scope
- **Per-user scoping helper** (`services/storageScope.ts`) — i dalje koristan
  za localStorage ključeve koji ne idu u bazu (npr. `vajb_onboarding_done`,
  chat draft session). Ostaje.
- **System prompt** (`systemPrompt.ts`) — osim ako treba da se doda rečenica
  o "slike se sad čuvaju u cloud-u, uvek možeš da ih referenciraš". Default:
  ne dirati ništa.
- **Extension landing** (`public/extenzija.html`) — potpuno odvojen od SPA
- **Cursor ekstenzija** (`vajbagent-vscode/`) — ne koristi nijedan od ovih
  storage mehanizama, ništa ne menjamo

## 7. Testni scenariji (definition of done)

1. Novi korisnik → registruje se → pravi projekat "moj sajt" → upload fotka
   → agent napravi sajt sa tom slikom → Preview panel pokazuje pravu sliku
   → klikne "Objavi na Netlify" → live URL sa pravom slikom
2. Isti korisnik → logout → login na **drugom browser-u** → lista projekata
   pokazuje "moj sajt" → otvori ga → slika i kod su tu, identični
3. Drugi korisnik na istom laptopu → login → NE vidi "moj sajt" u svojoj listi
4. Prvi korisnik → obriše projekat → R2 bucket više ne sadrži one slike
   (proveriti preko Cloudflare dashboard-a ili AWS CLI command-om)
5. Korisnik sa lokalnim IndexedDB projektima (iz stare verzije) → login →
   vidi migration prompt → klik "Prebaci" → 3 projekta se pojave u listi
   sa istim fajlovima i slikama → lokalni IndexedDB može da se obriše
6. Quota test: upload 21 sliku → 21. slika se odbija sa toast-om, backend
   vraća 400 pre nego što se presigned URL generiše

## 8. Konkretni fajlovi koje sledeća sesija gleda prvo

```
src/index.js                           # postojeći backend, vidi requireAuth, asyncHandler, ima Supabase
src/auth.js                            # requireAuth middleware, studentKeyId
src/githubOAuth.js                     # push logika, data URL dekodiranje već postoji
src/netlifyOAuth.js                    # deploy logika, isto

vajbagent-web/src/services/projectStore.ts      # trenutni IndexedDB store (target za zamenu)
vajbagent-web/src/services/userAssets.ts        # upload pipeline (treba R2 wiring)
vajbagent-web/src/services/webcontainer.ts      # writeBinaryFile, hydrateImagesIntoWc
vajbagent-web/src/services/storageScope.ts      # ostaje za localStorage
vajbagent-web/src/components/IDELayout.tsx      # handleImageUpload, handleFilesChanged, resume logika
vajbagent-web/src/components/PreviewPanel.tsx   # inlineImageRefs — možda više ne treba za R2 URL-ove
vajbagent-web/src/App.tsx                       # boot/resume flow
```

## 9. Environment promenljive koje treba dodati na Render

```
R2_ACCOUNT_ID            = <cloudflare account id>
R2_ACCESS_KEY_ID         = <api token>
R2_SECRET_ACCESS_KEY     = <api secret>
R2_BUCKET                = vajbagent-uploads
R2_PUBLIC_BASE_URL       = https://assets.vajbagent.com   # optional, iff public

# Database (ako Supabase Postgres)
DATABASE_URL             = postgres://...
# ili (ako Neon)
NEON_DATABASE_URL        = postgres://...
```

Postojeće `WEB_ORIGINS`, `REGISTER_TOKEN_SECRET`, `ADMIN_SECRET`,
`SESSION_SECRET`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `REDIS_URL`
ostaju.

## 10. Kako startovati sledeću sesiju (prompt za korisnika da pita Claude-a)

```
Preuzmi projekat VajbAgent i završi R2 + Postgres backend migraciju.
Ceo plan i kontekst je u fajlu HANDOFF_R2_BACKEND.md u root-u repozitorijuma.
Pročitaj ga od početka do kraja, postavi mi KONKRETNA pitanja ako ti nešto
fali, pa kreni sa Fazom A. Ne pitaj me za trivial decisions kao naming —
imaš default preporuke u dokumentu. Ciljam da za 2-3 sesije budemo potpuno
u cloud-u.

Počni sa:
1. Potvrdi koju bazu koristimo (preporučeno: Supabase Postgres)
2. Sipaj mi Cloudflare R2 setup instrukcije (koje env vars da dodam,
   kako da napravim bucket, kakav CORS treba)
3. Pokaži schema SQL, ja je izvršim u Supabase SQL editoru
4. Kreni da kodiraš src/r2.js i src/projectStore.js
```

## 11. Za kraj

Trenutno stanje je **production-ready za single-device korisnika** kroz
IndexedDB. Migracija na R2/Postgres je **pure upgrade** — frontend može da
drži lokalni fallback i migrira kad god korisnik želi, bez downtime-a.
Nema žurbe da se cela migracija završi u jednoj sesiji.

Commit hash-ovi relevantni (git log za detalje):
- `4bed12a` — getAllFiles skips binary + handleFilesChanged merge
- `20ab3c6` — glavni feature: upload / drag / paste / persist slika
- `183b405` — preview iframe inline data URL fix
- `95e73d2` — per-user storage scoping (temelj za multi-user)
- `9339632` — sigurnosne sekcije u system promptu (RLS mandatorna)

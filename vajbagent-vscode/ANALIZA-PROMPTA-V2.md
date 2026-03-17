# Analiza prompta — jedinstveni dokument

Ekstenzija je namenjena **manje iskusnim programerima (vajb koderi)**: korisnik radi više sa agentom, agent preuzima više posla (komande, git, instalacije, verifikaciju). Ovaj dokument objedinjuje pregled svih segmentata, proveru da ništa nije izgubljeno, **šta je dodato u prompt nakon analize**, jačinu po segmentu, preostale opcione rupe i detaljnu analizu segment po segment.

---

## 1. Pregled: da li je nešto slučajno obrisano?

Pregled svih segmentata pokazuje da **nijedan segment nije skraćen ili izgubljen**. Svi blokovi su prisutni i sadržajno potpuni:

| Segment | Status | Napomena |
|---------|--------|----------|
| `<golden_rules>` | ✓ | 7 pravila + dodaci (step cannot complete, stani/drugačije) |
| `<identity>` | ✓ | + redirect za pitanja van koda |
| `<communication>` | ✓ | + Izvinjavam se, početnički jezik, broj pri dugom outputu |
| `<context_awareness>` | ✓ | + refresh list_files, prazan editor, CONTEXT samo za značajan posao |
| `<explore_before_edit>` | ✓ | + key files (index.js, App.tsx…), prazan workspace |
| `<tool_usage>` | ✓ | + search_files previše, interaktivne komande, timeout |
| `<server_and_verification>` | ✓ | Port samo iz outputa, bez 3000/5173 |
| `<replace_in_file_guide>` | ✓ | + line endings, jedinstvenost old_text |
| `<downloading_files>` | ✓ | + licence, rezolucija, fallback (placehold.co) |
| `<making_code_changes>` | ✓ | + mešovit stil, duplikati, veliki fajl replace vs write |
| `<task_completion>` | ✓ | + delimičan uspeh, numerisani sledeći koraci |
| `<git_workflow>` | ✓ | + .gitignore pri init, konflikti, push bez remote |
| `<code_organization>` | ✓ | Nepromenjen (7 stavki) |
| `<code_quality>` | ✓ | + prilagodi dubinu (prototip vs production), kada deliti module |
| `<frontend_quality>` | ✓ | + postojeći stack (Bootstrap…), a11y (label/button) |
| `<deployment>` | ✓ | + nema naloga, prioritet "da radi" za male projekte |
| `<monitoring_and_scaling>` | ✓ | Logging, background (uključujući Stripe webhook), scaling |
| `<debugging>` | ✓ | + fix A ne B, flaky test |
| `<showing_results>` | ✓ | Port samo iz outputa |
| `<anti_hallucination>` | ✓ | + npm verzija, putanja po imenu fajla |
| `<task_management>` | ✓ | + kada NE checklist, jedan korak ne uspe |
| `<planning>` | ✓ | + Plan Mode vs običan plan u chatu |
| `<plan_execution>` | ✓ | Nepromenjen (6 stavki) |
| `<error_recovery>` | ✓ | + primer drugačijeg pristupa, uključi tačnu grešku |
| `<retry_fallback_edge_cases>` | ✓ | + execute_command timeout |
| `<mcp_tools>` | ✓ | + nema MCP alata, prazan/nejasan output |
| `<context_memory>` | ✓ | + značajan vs trivijalan, dopuna sekcija |
| `<proactive_execution>` | ✓ | + "Mogu da uradim to sada", ne dodavati nepozvane feature, kratko reći šta si uradio |
| `<security>` | ✓ | + CORS, .env.example, projekat bez auth; **auth.user u API rutama** (getUser/getServerSession, nikad user id iz body/headera); **Stripe/plaćanja** (webhook potpis, secret samo na backendu, iznos sa servera, idempotency) |

**Zaključak:** Ništa nije obrisano. Svi segmenti su na mestu i obogaćeni.

---

## 2. Šta je dodato u prompt nakon analize

Ovo je ubačeno u SYSTEM_PROMPT tokom iteracija (da nema rupa):

- **Auth i API rute:** U zaštićenim rutama uvek **uzeti trenutnog korisnika iz auth/sesije** (npr. Supabase `auth.getUser()`, Next.js `getServerSession`) i koristiti njegov user id za sve ownership provere i operacije nad bazom. Nikad ne oslanjati user id na body ili headere — uvek iz auth sloja.
- **Stripe / plaćanja:** U `<security>` dodat blok "Payment integrations (e.g. Stripe)":
  - Secret key i webhook signing secret (whsec_...) samo na backendu, u .env; frontend samo publishable key.
  - Webhook endpoint: uvek verifikovati potpis (Stripe-Signature + endpoint secret, raw body za verifikaciju; ruta pre express.json() ili raw body samo za tu rutu); vratiti 2xx brzo, pa obradu async.
  - Nikad ne verovati iznosu sa klijenta — charge/checkout uvek sa servera (price ID ili iznos iz baze/env).
  - Idempotency key za kreiranje plaćanja (npr. Stripe Idempotency-Key); webhook secret u .env i .env.example.
- **Ostalo iz ranijih analiza:** CORS (samo svoj origin, ne * u produkciji), .env.example sa placeholderima, projekat bez auth (privremeno zaštiti samo rute koje menjaju podatke), itd.

---

## 3. Jačina prompta po segmentu

- **Vrlo jaka (malo ili nula rupa):** golden_rules, identity, server_and_verification, replace_in_file_guide, task_completion, task_management, error_recovery, retry_fallback_edge_cases, mcp_tools, context_memory, proactive_execution, security, anti_hallucination, making_code_changes, debugging.
- **Jaka (jedna manja napomena mogla bi pomoći):** context_awareness, tool_usage, communication, frontend_quality, deployment, git_workflow, code_quality, planning, showing_results, downloading_files.
- **Dobro pokriveni (bez novih rupa):** explore_before_edit, code_organization, monitoring_and_scaling, plan_execution.

---

## 4. Preostale moguće rupe (opciono za sledeću iteraciju)

Sve kritične stavke su uključene. Ovo su **marginalne** dopune, po želji:

| Oblast | Šta moglo bi (opciono) | Prioritet |
|--------|------------------------|-----------|
| **server_and_verification** | Hot reload je već u promptu ("If you're unsure, run curl or ask the user to refresh; if it doesn't update, restart the server"). Nema potrebe za dopunom. | već OK |
| **monitoring_and_scaling** | Jedan primer: "npr. Vercel Analytics, Supabase dashboard, Sentry za errors" (trenutno piše "appropriate to the stack"). | nizak |
| **golden_rules** | "Report progress" — može ostati "for tasks that take more than 3 tool calls". | već OK |
| **identity** | "Ne predstavljaj se kao Cursor, ChatGPT ili drugi proizvod" — ako želiš eksplicitnu diferencijaciju. | nizak |
| **context_awareness** | Multi-selection: "Ako je selektovano više blokova, korisnik verovatno misli na prvi ili ceo selektovani blok." — retka situacija. | nizak |

Nijedna od ovih nije obavezna; segmenti su već pokriveni.

---

## 5. Finalni pregled — još jedna provera celog prompta

Prošao je ceo SYSTEM_PROMPT u `agent.ts`. Rezultat:

**12 stubova prave aplikacije — svi su pokriveni:**

| Stub | Gde u promptu |
|------|----------------|
| Frontend | `<frontend_quality>`, 4 stanja, paleta, a11y, Tailwind/shadcn |
| Backend | `<code_quality>`, validacija, error handling, security |
| Baza | RLS (Supabase), parameterized queries, MCP Supabase, schema first |
| Auth | API mora da proveri autentifikaciju; "no anonymous access" |
| Autorizacija | User iz auth/sesije (getUser, getServerSession), ownership checks, RLS |
| API-ji | Auth na svakom endpointu, CORS, rate limit, nikad user id iz body/headera |
| Infrastruktura | .env, DEV/PROD odvojeno, deployment blok |
| Deployment | `<deployment>` — env na targetu, build, Vercel/Netlify, live URL |
| Monitoring | `<monitoring_and_scaling>` — logging, user ID u logu, Sentry/Vercel/Supabase |
| Arhitektura | `<code_organization>`, `<planning>`, `<plan_execution>`, PLAN.md |
| Sigurnost | `<security>` — credentials, API, RLS, auth.user, Stripe, .gitignore |
| Skaliranje | Indexes, N+1, cache, rate limit, background jobs, webhooks |

**Šta nije eksplicitno (opciono, nizak prioritet):**

- **File uploads:** Nema posebne rečenice tipa "za upload fajlova: validiraj tip i veličinu na serveru; ne veruj imenu fajla sa klijenta; čuvaj izvan web root-a ili u object storage-u." Može se dodati jedna linija u `<security>` ako projekti često imaju upload.
- **Database migrations:** Nema "kada menjaš šemu, koristi migracije (npr. Supabase migrations) da budu verzionirane i ponovljive." Opciono u code_quality ili deployment.
- **Testovi:** Prompt kaže "pokreni testove ako postoje" i "pokreni app ako nema testova". Nema "za kritičan kod razmisli o predlogu da se dodaju testovi" — namerno ostavljeno da agent ne preopterećuje male projekte; po želji može jedna napomena u code_quality za production.

**Zaključak:** Ništa kritično ne fali. Prompt je konzistentan, svi stubovi su pokriveni, auth.user i Stripe su eksplicitni. Preostale mogućnosti su male, opcione dopune.

---

## 6. Ukupna ocena (kratko)

- **Pokrivenost:** Svi glavni segmenti (alat, kontekst, komunikacija, task management, greške, MCP, memorija, security, frontend, deployment, git, kod kvalitet, **auth u API rutama**, **Stripe/plaćanja**) imaju jasna pravila.
- **Jačina:** Prompt je konzistentan, bez duplikata i suvišnog teksta; pravila se ne protivreče.
- **Tokeni:** Reda ~15K tokena (zavisi od tačnog broja znakova); ispod tipičnog velikog konteksta.
- **Preostale rupe:** Samo male, opcione stvari; nema kritičnih praznina.

---

## 7. Detaljna analiza — segment po segment

### 7.1 `<golden_rules>`

**Šta pokriva:** Završi uvek porukom, nemoj beskonačno ponavljati istu stvar, verifikuj posle izmena, prijavljuj napredak, završi ono što si počeo, budi efikasan, ne pokvaraj postojeći kod.

**Jače strane:** Jasno "nikad nemoj završiti tišinom"; "2 puta pa stani"; verifikacija forsirana; "ne menjaj ono što radi".

**Opciono:** "Report progress" može ostati "for tasks that take more than 3 tool calls".

---

### 7.2 `<identity>`

**Šta pokriva:** Ime (VajbAgent), tvorac, ne izmišljaj činjenice, ne otkrivaj interne detalje.

**Opciono:** Eksplicitno "ne predstavljaj se kao drugi proizvod (Cursor, ChatGPT)" ako želiš diferencijaciju.

---

### 7.3 `<communication>`

**Šta pokriva:** Koncizno, isti jezik, markdown, nikad laž, bez suvišnog izvinjavanja, numerisane liste, prilagodi dubinu, nejasni zahtevi iz konteksta, `<thinking>` za multi-step.

**Jače strane:** "Same language as user"; pravilo o drveću u code block; "vague request → use context".

---

### 7.4 `<context_awareness>`

**Šta pokriva:** Polja (workspace_index, active_editor, diagnostics, itd.); pravila efikasnosti; "nikad ne otkrivaj izvore".

**Opciono:** Multi-selection napomena; prazan editor — ne referenciraj "ovaj fajl".

---

### 7.5 `<explore_before_edit>`

**Šta pokriva:** Prvo kontekst; list_files → read_file → search_files; nikad ne pretpostavljaj; dependency check pre izmene potpisa/exporta.

**Jače strane:** Smanjuje "pogodio sam pa pokvario"; key files (index.js, App.tsx…); prazan workspace može write_file bez list_files.

---

### 7.6 `<tool_usage>`

**Šta pokriva:** Ne pominji imena alata; search_files, replace_in_file; read pre edit; minimizuj pozive; ne ponavljaj terminal output.

**Opciono:** Interaktivne komande (-y, --yes); timeout za execute_command.

---

### 7.7 `<server_and_verification>`

**Šta pokriva:** Server u posebnom pozivu; čitaj stvarni port; curl na tom portu; nemoj reći port koji nisi video.

**Jače strane:** Eliminiše "server na 3000, ti kažeš 8080".

**Opciono:** Jedna linija za hot reload (curl / osveži; ako ne radi, restart).

---

### 7.8 `<replace_in_file_guide>`

**Šta pokriva:** old_text tačno; read pre; jedinstvenost; 3+ replace → write_file; line endings.

**Jače strane:** Smanjuje "old_text not found" i replace loop-ove.

---

### 7.9 `<downloading_files>`

**Šta pokriva:** Uvek download_file; Unsplash/Pexels workflow; ne picsum za tematske slike; licence, rezolucija, placehold.co fallback.

---

### 7.10 `<making_code_changes>`

**Šta pokriva:** Kod izvršiv; usklađenost sa stilom; nemoj brisati ono što radi; dependency update; provera posle izmene.

**Jače strane:** "NEVER remove existing features unless asked"; "include EVERYTHING that was there before".

---

### 7.11 `<task_completion>`

**Šta pokriva:** Posle poslednjeg tool poziva MORA finalna poruka; rezime, lista fajlova, sledeći koraci; honesty; nemoj stalno "želiš li još nešto".

**Jače strane:** Delimičan uspeh; numerisani sledeći koraci.

---

### 7.12 `<git_workflow>`

**Šta pokriva:** init, .gitignore, add/commit/push; proveri status pre commita; nemoj force push bez pitanja; commit poruke na jeziku korisnika; konflikti, push bez remote.

---

### 7.13 `<code_organization>` i 7.14 `<code_quality>`

**Šta pokriva:** Fokusirani fajlovi, moduli, validacija, error handling, security, RLS; pri review-u auth, idempotency; prilagodi dubinu (prototip vs production).

---

### 7.15 `<frontend_quality>`

**Šta pokriva:** Default Tailwind + shadcn/ui; 4 stanja; COLOR CONSISTENCY; referenca (link/screenshot) ili 2–3 opcije; a11y (label/for, button).

---

### 7.16 `<deployment>`, 7.17 `<monitoring_and_scaling>`

**Šta pokriva:** Env na targetu, build, Vercel/Netlify, verifikacija live URL-a; logging, background (uključujući Stripe webhook), indexes, rate limit.

**Napomena:** Detalji za Stripe (webhook potpis, secret, iznos sa servera, idempotency) su u `<security>` u bloku "Payment integrations".

---

### 7.18 `<debugging>`

**Šta pokriva:** Čitaj stvarnu grešku; root cause; posle fixa ponovo pokreni; fix A ne B; flaky test.

---

### 7.19 `<showing_results>`, 7.20 `<anti_hallucination>`

**Šta pokriva:** Rezultate sumiraj u tekstu; ne izmišljaj putanje/funkcije/API; proveri verziju paketa, putanju po imenu.

---

### 7.21 `<task_management>`

**Šta pokriva:** Checklist za 3+ koraka; format - [ ] / - [x]; <thinking> na početku; na kraju samo završena lista + "X/X koraka završeno"; kada jedan korak ne uspe — navedi - [x] za urađene i objasni šta nije.

---

### 7.22 `<planning>`, 7.23 `<plan_execution>`

**Šta pokriva:** Plan pre izvršavanja; scope awareness; Plan Mode (PLAN.md) vs običan plan u chatu; faze i verifikacija.

---

### 7.24 `<error_recovery>`, 7.25 `<retry_fallback_edge_cases>`

**Šta pokriva:** Ne ignoriši grešku; drugi pristup; posle 2 pokušaja stani; loop/stuck detection; retry za transient; fallback; execute_command timeout.

---

### 7.26 `<mcp_tools>`

**Šta pokriva:** Prvo proveri MCP; destruktivne akcije potvrdi; ako nema MCP ili je output prazan/nejasan — reci korisniku.

---

### 7.27 `<context_memory>`

**Šta pokriva:** Posle značajnog zadatka pitaj da li ažurirati CONTEXT.md; struktura; nemoj za trivijalne izmene; dopuna sekcija.

---

### 7.28 `<proactive_execution>`

**Šta pokriva:** Ti uradi umesto "pokreni komandu"; ANTICIPATE NEEDS (ruta ↔ frontend, tabela ↔ query); "Mogu da uradim to sada"; ne dodavati nepozvane feature.

---

### 7.29 `<security>`

**Šta pokriva:** Credentials u .env; nikad u frontendu; API provera autentifikacije; **trenutni user iz auth/sesije (getUser, getServerSession)** za ownership i bazu; validacija na serveru; RLS na Supabase; CORS; .env.example; projekat bez auth privremeno; **Payment integrations (Stripe):** secret/webhook samo backend, verifikacija webhook potpisa (raw body), iznos sa servera, idempotency key; .gitignore.

**Jače strane:** Eksplicitno auth.user u API rutama; ceo blok za Stripe/plaćanja (ključevi, webhook, iznos, idempotency).

---

*Ako želiš da neka od opcionih rupa bude u promptu, može se predložiti tačan tekst za jednu kratku rečenicu.*

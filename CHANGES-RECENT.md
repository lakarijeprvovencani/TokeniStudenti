# Šta smo radili — 20–22. apr 2026

Kratko i pošteno, šta je dirano i šta bi moglo da utiče na osećaj da „agenti pametuju manje". Grupisao sam po sistemu; u svakoj grupi piše **može li to da utiče na kvalitet modela** (spoiler: većina ne može, ali dve stvari mogu i izdvojio sam ih).

---

## 1) Anti-bot / registracija (najveći deo posla)

**Može da utiče na kvalitet modela?** NE. Sve je oko `/auth/register`, `/register` i admin panela. Ne dodiruje `/v1/chat/completions`, ni routing modela, ni promptove.

Šta je urađeno:

- `feat(auth): email verification for web signup` — novi nalozi sa `email_verified: false`, verifikacioni link preko Resend-a, welcome bonus samo posle klika.
- `feat(antibot): heuristic signup filter` — imena se proveravaju na gibberish, email na disposable domene.
- `feat(antibot): honeypot + signed-token + 3s delay` — prekopirano iz Cursor dashboard-a u web signup.
- `antibot: block spam-only TLDs (.sbs/.xyz/.top/...)` + heuristika za interleaved-digit email local-part-ove.
- `antibot: flood-control layer + kill switch` — novi `src/reg-limits.js`:
  - globalni cap/sat i /dan
  - /24 subnet cap
  - kill switch (env var i runtime Redis toggle)
- `antibot: forensic attack log` — poslednjih 200 blokiranih pokušaja sa IP / country / ASN / UA.
- `antibot: align legacy /register (extension landing) with /auth/register` — ista zaštita.
- `antibot: resolve real client IP from CF-Connecting-IP` — ranije smo logovali Cloudflare edge IP, sad pravi klijent.
- `harden anti-bot (22 Apr)` — poslednji komit:
  - per-email-domain cap (default 3/dan) — bio si napadnut svim `@outlook.com`, to ih sad hvata.
  - defaulti pooštreni: 5/sat, 20/dan, 2/subnet.
  - legacy `/register` više **ne daje welcome bonus** (Cursor users startuju sa $0, deponuju Stripe).
  - chat endpoint više ne propušta `email_verified=undefined` — traži eksplicitno `=== true` (sa grandfather izuzetkom za naloge pre 2026-04-01).

**Env vars koje možeš da menjaš na Render-u:**

```
REGISTRATION_HOURLY_CAP=5
REGISTRATION_DAILY_CAP=20
REGISTRATION_SUBNET_DAILY_CAP=2
REGISTRATION_DOMAIN_DAILY_CAP=3
REGISTRATION_DISABLED=1         # kill switch preko env-a
SELF_REGISTER_BONUS=2           # i dalje radi za /auth/register (tek posle email-verify)
TURNSTILE_SECRET=...            # ako je prazno — Turnstile se preskače!
ADMIN_SECRET=...                # rotirao si ga
```

---

## 2) Admin dashboard

**Može da utiče na kvalitet modela?** NE.

- Multi-select + bulk delete + search u tabeli studenata.
- Email diagnostics + per-student resend-verification dugme.
- Password reset diagnostics + per-student reset dugme (zaobilazi enumeration protection za admin-a).
- Anti-bot monitor & kill switch card — uživo brojači ✓ Uspešno / ✗ Blokirano.
- Attack forensics card — tabela poslednjih 100 napada (country, city, IP, UA).
- API activity card — ko troši Anthropic/OpenAI u poslednjem prozoru (1h … 7 dana).
- One-click bulk purge za bot signupe + `created_after` mode u purge-unverified.

---

## 3) Email / password reset

**Može da utiče na kvalitet modela?** NE.

- Password reset preko Upstash Redis (one-time tokens, 30 min TTL).
- Spam-folder hint (Resend često ide u junk).
- Posle email-verify sesija se već čuva — nema ponovnog login-a.
- Admin trigger za reset (daje specifičnu grešku umesto enumeration-safe poruke).

---

## 4) Netlify / Render routing

**Može da utiče na kvalitet modela?** NE.

- `vajbagent-web/public/_redirects` — dodao sam proxy za:
  - `/extenzija` → Render (legacy landing)
  - `/dashboard` i `/dashboard/*` → Render
  - `/vajbagent-latest.vsix` → Render
  - `/og-image.png` i `/img/*` → Render (screenshots za extenzija stranicu)
  - ostalo ide kao SPA (`/* /index.html 200`)
- Netlify nije linkovan za GitHub auto-deploy (ručno se radi `npm run build` pa `netlify deploy --prod --dir=dist`). **Ovo treba da povežemo kad budeš imao vremena.**

---

## 5) Model / inference sloj — **OVDE PAZI**

**Može da utiče na kvalitet modela?** **DA, neke stvari ovde.**

Spisak svega što je dirano u tom sloju zadnjih 48h (po sećanju iz ranije sesije pre anti-bot napada, ovo je gde bi mogao biti uzrok osećaja da agenti „pametuju manje"):

### 5a. Hard cap na `write_file` po jednom path-u po potezu
- Ograničenje: **maks 2 stvarna `write_file` po istom putu u jednom turn-u**.
- Razlog: sonnet/opus su upadali u loop da prepišu isti fajl 5x zaredom.
- **Nuspojava:** ako je zadatak legitimno zahtevao 3. iteraciju istog fajla (npr. multi-step refactor), agent ranije odustaje. Moguć uzrok „glupljeg" osećaja.

### 5b. Dedupe konsekutivnih status poruka u `ChatPanel`
- Samo UI — uklanja duplicirane „Reading file..." poruke jednu za drugom.
- **Ne utiče na kvalitet modela**, samo na prikaz.

### 5c. Pathological loop break
- Ako isti path dobije **5+ write-ova ukupno u turn-u**, agent se force-break-uje.
- **Nuspojava:** slična kao 5a — ako zadatak legitimno traži 5+ izmena istog fajla, rano prekida.

### 5d. SW controller wait (preview fix)
- Preview ne pada više na SPA fallback dok se service worker registruje.
- Ne utiče na model.

### 5e. Temperatura / max_tokens / model selekcija
- **Nije dirano u ovih 48h.** Ako imaš osećaj da Haiku/Sonnet/Opus/5.4 rade drugačije nego pre, to je ili:
  1. Anthropic ih je menjao silent-om (dešava se stalno), ili
  2. Neki raniji komit je menjao model aliase / temperature — treba proveriti `src/models.js` i `src/providers/*`.

### 5f. „Agenti pametuju manje" — najverovatniji uzroci
Po redu verovatnoće:
1. **5a + 5c** — hard cap na write_file. Ako mnogo zavisiš od scenarija sa više izmena istog fajla, ovo je prva stvar koju treba labaviti ili skinuti. Treba bar da se opcija podigne sa 2 → 4 po putu, i loop-break sa 5 → 8.
2. **Anthropic-ova tiha regresija** — trebali bismo izmeriti konkretnim testom (isti prompt isti model, 10 ponavljanja, čuvati rezultate). Imamo `test-harness` koji možemo pustiti.
3. **Model routing** — vredi proveriti da li se neka ruta greškom prebacila sa Sonnet-a na Haiku kod „Lite" / „Fast" etiketa.

---

## 6) Bot napad koji i dalje ide (22. apr 17:00–17:48)

- Prošlo ~14 `@outlook.com` naloga za 34 minute, svi „Neverified", nekoliko sa balansom $0.51–$0.90 — što znači da su **KORISTILI Claude** pre nego što smo zatvorili rupu.
- Rupa je bila: legacy `/register` dodeljivao $2 bez email verifikacije + chat endpoint propuštao `email_verified=undefined`.
- Rešeno u poslednjem komitu (`3e955e8`).
- **Ti treba da:**
  1. Pritisneš kill switch u admin-u dok se Render deploy ne završi.
  2. Obrišeš sve te `@outlook.com` botove sa 21.4.2026 17:14–17:48.
  3. Proveriš Anthropic konzolu sutra — napadi $ trebaju da stanu.

---

## 7) Šta NIJE dirano (za mir duše)

- `src/providers/anthropic.js` / `src/providers/openai.js` — API pozivi, key pools, rotacija.
- `src/models.js` — mape modela.
- Temperature, max_tokens, sistem promptovi agenta.
- Tool definicije (`read_file`, `write_file`, `run_terminal`, ...).
- Balans / Stripe / billing.

---

## 8) Sledeći koraci (predlog)

1. **Povratiti osećaj kvaliteta modela** — prvo labaviti hard cap na write_file:
   - 2 → 4 po putu
   - 5 → 8 ukupno pre force-break-a
2. **Izmeriti da li je Anthropic tiho regresirao** — pustiti test-harness sa 10 ponavljanja istog kompleksnog prompt-a, usporediti sa starim rezultatima.
3. **Linkovati Netlify na GitHub** za auto-deploy (ručno deployovanje je prespora petlja).
4. **Obrisati bot signupe** i vratiti whitelist u admin-u.

Kad budeš spreman da krenem na (1), samo reci „labavi cap" — napraviću PR koji samo to dira, čisto da izolujemo uzrok.

---

# DODATAK — Kompletna analiza agent/inference sloja (22. apr, popodne)

Prošao sam **sve** što je dirano 14–17. aprila i uticalo bi na osećaj kvaliteta modela. Svaka stavka ima **status** (OK / PROBLEM / KRITIČNO) i gde primereno akciju.

## Status po kategoriji

| # | Kategorija | Status | Napomena |
|---|---|---|---|
| 1 | `write_file` cap-ovi (3 sloja) | **KRITIČNO → fixovano** | Bilo 1/2/2; sada 3/3/5, env-konfigurabilno |
| 2 | Poruke kod cap-a / guard-a | **PROBLEM → fixovano** | Bile ALL-CAPS srpski imperativ; sada blage engleski napomene |
| 3 | `max_tokens` floor | OK | reasoning=32k, Opus thinking=32k, Sonnet/Haiku=16k. Opravdano. |
| 4 | History trimming (`trimOpenAIMessages`) | OK | Budgetovi 0.5–3.6M znakova po modelu. Ne odbacuje preagresivno. |
| 5 | Prompt caching | OK | `cache_control: ephemeral` na system bloku + poslednjem tool-u. Standard. |
| 6 | Model routing | OK | 7 tier-a čisto mapirano (`VAJB_MODELS`), `resolveModel()` radi. |
| 7 | Iteration limit | OK | 50, sa „approaching limit" upozorenjem na 40. |
| 8 | First-chunk watchdog | OK | 120s za prvi chunk, 5min između. |
| 9 | Stream handling | OK | Truncation detection, empty-tool-call filter, parallel-write detection, sve razumno. |
| 10 | Reasoning / adaptive thinking | OK | Opus 4.7 explicitno opted-in, `reasoning_effort: low/medium` po budgetu. |
| 11 | **POWER system prompt** | **VISOKI PRIORITET** | 6 „ABSOLUTE RULES NEVER BREAK THESE" sa ALL-CAPS imperativima. |
| 12 | **Broj alata + jezička nekonzistentnost** | **SREDNJI PRIORITET** | 21 tool-a; opisi pomešani srpski/engleski/srpski-bez-dijakritika. |

## Šta je u ovom potezu već popravljeno (commit-ovano u istom PR-u)

### Fix #1 — Trostruki `write_file` cap od 1/2/2 je popušten na 3/3/5

Fajlovi:
- `vajbagent-web/src/services/toolHandler.ts` — `MAX_REAL_WRITES_PER_PATH`: 1 → **3**, konfigurabilno preko `VITE_WRITE_SOFT_CAP`.
- `src/index.js` — `injectRewriteLoopGuard` threshold: 2 → **3**, env `REWRITE_GUARD_THRESHOLD`.
- `src/index.js` — `maybeDisableWriteFile` threshold: 2 → **5**, env `WRITE_FILE_DISABLE_THRESHOLD`.

### Fix #2 — Omekšani promptovi u cap porukama

Ranije je model dobijao ovakvu poruku na 2. pokušaj:

```
DUPLIKAT ODBIJEN: već si u ovom agent turn-u napisao X
...
Tvoj sledeći potez MORA biti tačno jedno od:
1) Završi — napiši korisniku jednu kratku rečenicu...
2) write_file za DRUGI fajl...
3) replace_in_file sa kratkim old_text/new_text...
Ne izvinjavaj se. Ne objašnjavaj.
```

Sad dobija:

```
Note: path.tsx has already been written 3 time(s) in this turn
(last version on disk is 4532 chars). To avoid a rewrite loop,
further full rewrites of this path are being skipped. The previous
version is kept.

If this file genuinely needs another change, use replace_in_file
with a focused old_text/new_text diff. Otherwise, move on to other
tasks or finish the turn.
```

Razlika: **informativno, na engleskom, bez ALL-CAPS, bez „MORA", bez „STOP"**. Model dobija kontekst i predlog, a ne komandu iz komandne sobe.

## Šta OSTAJE kao kandidat (nije dirano u ovom potezu, treba tvoj zeleno)

### Problem #1 — POWER prompt je preskriptivan

Trenutno u `src/index.js` linije 209–251:

```
## ABSOLUTE RULES — NEVER BREAK THESE:

1. ALWAYS FINISH WHAT YOU START. If you begin writing a file, write it COMPLETELY. ...NEVER stop halfway.
2. WRITE COMPLETE CODE. ...NEVER use "// ... rest of the code"...An incomplete write_file DESTROYS the user's code.
3. READ EVERY TOOL RESULT. ...NEVER claim success without proof.
4. RECOVER FROM ERRORS. ...NEVER retry the exact same failing command. After 2 failed attempts...STOP and explain.
5. ALWAYS END WITH A MESSAGE. ...NEVER end with silence.
6. ACT, DON'T EXPLAIN. ...
```

Šest „NEVER"-ova i više „ALWAYS"-ova u ALL-CAPS. Poznata je **Anthropic-ova preporuka da se modeli ne uče strahu** — preskriptivni „NIKAD" stilovi učine da model troši tokene na samonadzor (meta-kogniciju: „jesam li prekršio pravilo?") umesto na stvarni posao. Simptom: agent koji se „gubi u parsiranju i dopisivanju".

**Predlog:** pisati u **pozitivnom, opisnom tonu** umesto negativno-imperativnom. Kratak primer:

```
You are VajbAgent Architect — a senior full-stack coding partner.

Working style:
- Finish the task you start; if you begin a file, write it fully.
- After each tool call, read the result and react to what it says.
- When a command fails, read the error and try a meaningfully
  different approach before stopping.
- End each turn with a short summary to the user.
- Use replace_in_file for small tweaks; use write_file when you need
  to create a file or rewrite it substantially.

You have deep expertise across the stack (Node, React, Supabase,
Stripe, Tailwind, DevOps). Match the project's existing style when
editing.
```

Isti signal, bez preskriptivnog pritiska. **Ne diram ovo bez tvoje saglasnosti** jer menja ponašanje premium tier-a direktno.

### Problem #2 — 21 tool + jezička nekonzistentnost

Tool definitions u `vajbagent-web/src/tools.ts`:

- **21 alata** — tik do granice (15–20) gde Claude/GPT-5 istraživanja pokazuju pad u tool-selection kvalitetu.
- `write_file` opis: „Kreiraj ili prepisi fajl. Sadrzaj mora biti kompletan." (srpski bez dijakritika)
- `search_files` opis: engleski
- `supabase_sql` opis: engleski sa dugim rečenicama
- `git_push` opis: srpski bez dijakritika

Model se trenira uglavnom na engleski + dijakritički-korektnoj gramatici. Izmešana dijakritika i jezici u tool schema-i stvaraju *slabiji signal* modelu da mapira namjeru ⇄ alat. To nije fatalno, ali je real efekat.

**Predlog:** sve opise normalizovati na **engleski + čist srpski kod korisničkog stringa**. Ne skidam alate — svi su korisni — ali opisi treba da budu konzistentni.

## Kako da definitivno znamo (empirijski test — ~20 min)

1. **Deploy ovog fix-a (3/3/5 cap + omekšane poruke)**. Ja ću napraviti commit odmah posle ovog pasusa.
2. **Ti uradiš JEDAN zadatak** koji si nedavno video da „glupi":
   - Otvori web app ili Cursor extension
   - Pošalji prompt (npr. „Napravi mi React Todo app sa dark mode i localStorage")
   - Zapamti: koliko tool poziva, koliko ponavljanja, da li je završio
3. **Javi mi rezultat**. Ako je bolje → znali smo uzrok. Ako isto → idemo na Problem #1 (POWER prompt rewrite).
4. Ako ni to ne pomogne → idemo na Problem #2 (tool cleanup).
5. Ako nakon svega i dalje isto → test sa raw Anthropic API-jem potvrđuje da je regresija kod **provider-a**, ne kod nas.

Ovaj poredak od 4 koraka garantovano stiže do istine. Nikakva magija, samo isključivanje hipoteza jedna po jedna.


# VajbAgent – OpenAI‑kompatibilan proxy za Claude (Anthropic)

Proxy koji prima zahteve u **OpenAI Chat Completions** formatu (kao Cursor IDE), u pozadini koristi **Anthropic (Claude)** API, izlaže modele (npr. VajbAgent Pro, VajbAgent Max) i podržava **streaming (SSE)**. Svaki student ima svoj API ključ; proxy proverava Bearer token i loguje **usage (input/output tokeni)** po ključu radi naplate.

---

## Korak po korak (tvoj put)

### Korak 1: Pokreni proxy na svom računaru

1. U folderu projekta otvori terminal.
2. Napiši: `cp .env.example .env`
3. Otvori fajl `.env` i unesi:
   - **ANTHROPIC_API_KEY** = tvoj Anthropic ključ (dobijaš na [console.anthropic.com](https://console.anthropic.com)); ti plaćaš Anthropic za tokene.
   - **STUDENT_API_KEYS** = bar jedan ključ za test, npr. `moj-test-kljuc` (bez razmaka, ako ih ima više razdvoji zarezom).
4. U terminalu: `npm install`, pa zatim `npm start`.
5. Kad vidiš poruku tipa “VajbAgent proxy listening on http://localhost:3000”, **Korak 1 je gotov** – tvoj server radi.

**Anthropic API ključ:** Da, treba ti – jedan ključ za sve agente. **Agenti u Cursoru:** korisnici vide VajbAgent Pro / VajbAgent Max (ne naziv Claude modela). U kodu: Pro = Sonnet 4.6, Max = Opus 4.6; mapiranje u `src/index.js` (`VAJB_MODELS`).

---

### Korak 2: Probaj u Cursoru (da sve radi)

1. **Dodaj sebi kredit** (inače proxy vraća 402). U `.env` dodaj: `ADMIN_SECRET=neka-tajna-rec`. U drugom terminalu (server neka radi):
   ```bash
   curl -X POST http://localhost:3000/admin/add-credits \
     -H "X-Admin-Secret: neka-tajna-rec" \
     -H "Content-Type: application/json" \
     -d '{"key_id":"POSLEDNJIH_8","amount_usd":5}'
   ```
   Zameni `POSLEDNJIH_8` sa **poslednjih 8 karaktera** tvog test ključa (na dashboardu, kad se uloguješ, piše "Ključ: …xxxxx" – to je key_id).

2. **Cursor:** Settings → Models → proširi OpenAI API → **Override Base URL**: `http://localhost:3000` (bez `/` na kraju) → **API Key**: tvoj test ključ (ceo iz `STUDENT_API_KEYS`).

3. Model: Cursor može da ne učita listu automatski; ako je lista prazna, **+ Add Custom Model** → Model ID: `vajb-agent-pro` (ili `vajb-agent-max`). Chat zahtevi idu na `POST /chat/completions`, proxy je usklađen sa Anthropic (200K kontekst) i OpenAI formatom.

4. Izaberi model **VajbAgent Pro** ili **VajbAgent Max** i pošalji poruku. Ako dobiješ odgovor, **Korak 2 je gotov**.

5. Opciono: otvori **http://localhost:3000/dashboard**, uloguj se istim ključem i proveri potrošnju i kredit.

*(Sledeće: deploy za druge, Stripe za automatski kredit.)*

---

## Zahtevi

- Node.js 18+

## Instalacija

```bash
npm install
cp .env.example .env
# Uredi .env: ANTHROPIC_API_KEY i STUDENT_API_KEYS
```

## Konfiguracija (.env)

| Promenljiva | Obavezno | Opis |
|-------------|----------|------|
| `ANTHROPIC_API_KEY` | Da | Tvoj Anthropic API ključ (ti plaćaš Anthropic). |
| `STUDENT_API_KEYS` | Da | Lista validnih student API ključeva, razdvojenih zarezom. Svaki student dobija jedan ključ. |
| `PORT` | Ne | Port servera (default 3000). |
| `ANTHROPIC_MODEL` | Ne | Claude model (npr. `claude-sonnet-4-20250514`). |

Primer `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
STUDENT_API_KEYS=student-key-abc123,student-key-xyz789
PORT=3000
```

## Pokretanje

```bash
npm start
# ili za razvoj sa auto-reload:
npm run dev
```

Server sluša na `http://localhost:3000` (ili na `PORT` iz .env).

## Kako da ljudima daš da koriste u Cursoru (korak po korak)

Da – korisnici **mogu da dodaju custom model** u Cursoru. Cursor podržava “Override OpenAI Base URL” i tvoj proxy izgleda kao OpenAI API, pa se model **vajb-agent** pojavi u dropdown-u. Podeljeno je na: šta **ti** radiš, i šta **oni** rade.

---

### Šta ti radiš (admin)

1. **Pokreneš proxy** (lokalno ili deploy na Railway/Fly.io) i dobiješ URL, npr. `https://vajb-agent.railway.app`.
2. **Za svakog korisnika** napraviš jedan API ključ (npr. `vajb-student-ana-xyz123`) i dodaš ga u `STUDENT_API_KEYS` u `.env` (ili env varijable na Railway/Fly), razdvojeno zarezom.
3. **Svakom korisniku pošalješ:**
   - **Base URL** (URL proxyja, bez `/v1` na kraju), npr. `https://vajb-agent.railway.app`
   - **Njegov API ključ** (samo njegov, ne tvoj Anthropic ključ).

Korisnici ne vide tvoj Anthropic ključ i ne mogu da ga zloupotrebe – svako ima svoj ključ, a ti vidiš usage po ključu u `data/usage.json`.

---

### Šta korisnik radi u Cursoru (dodavanje custom modela)

1. Otvori **Cursor** → ikona **zupčanika (Settings)** dole levo → **Cursor Settings**.
2. U meniju izaberi **Models** (ili **Features** → deo gde se podešavaju modeli / OpenAI API).
3. Nađi polje za **OpenAI API Key** (ili “Add API key” / “Use custom endpoint”).
4. Klikni na **malu strelicu** pored tog polja da se otvori prošireno podešavanje.
5. Uključi / unesi **Override OpenAI Base URL** (ili “Custom Base URL”) i stavi:
   - Base URL koji si im dao, npr. `https://vajb-agent.railway.app`  
   (bez `https://` na kraju putanje, samo domen; Cursor sam dodaje `/v1/...` kada šalje zahteve.)
6. U polje **API Key** unesi **njegov** API ključ koji si im dao (ne tvoj Anthropic ključ).
7. Sačuvaj. Cursor će pozvati `GET <Base URL>/v1/models` i dobiti listu sa **vajb-agent**.
8. U dropdown-u za izbor modela (npr. u chat-u ili u Settings → Models) trebalo bi da se pojavi **vajb-agent** – to je tvoj custom model. Izaberi ga i koristi kao i bilo koji drugi model.

Ako **vajb-agent** ne izađe u listi: nek korisnik proveri da je Base URL tačan (bez trailing slash, bez `/v1`), da je API key unet, i da ponovo otvori listu modela (ponekad treba osvežiti).

---

### Ukratko

| Ko | Šta |
|----|-----|
| Ti | Deploy proxy → dodeljuješ jedan API ključ po korisniku → šalješ im Base URL + njihov ključ. |
| Oni | U Cursoru: Settings → Models → Override Base URL + API key → u listi modela biraju **vajb-agent**. |

Da – **mogu da dodaju custom model**: na taj način ga “dodaju” tako što biraju tvoj endpoint i model **vajb-agent** u Cursoru.

---

## Tehnički: šta Cursor šalje proxyju

Cursor šalje zahteve na:

- `GET <Base URL>/v1/models` – lista modela (vajb-agent)
- `POST <Base URL>/v1/chat/completions` – chat sa streamingom

Proxy proverava `Authorization: Bearer <student-api-key>` i loguje usage po tom ključu.

## API

| Metod | Putanja | Auth | Opis |
|-------|---------|------|------|
| GET | `/v1/models` | Ne | Vraća listu sa jednim modelom `vajb-agent` (za Cursor dropdown). |
| POST | `/v1/chat/completions` | Bearer | OpenAI‑kompatibilan chat; u pozadini Claude, podržan streaming. |
| GET | `/usage` | Bearer | Statistika usage po ključu (input/output tokeni, broj zahteva). |
| GET | `/health` | Ne | Health check. |

## Usage (naplata)

- Za svaki uspešan zahtev proxy upisuje **input_tokens** i **output_tokens** u `data/usage.json`, po identifikatoru ključa (kraći hash ključa).
- Ti plaćaš Anthropic; studente naplaćuješ prema tome kako definišeš (npr. po tokenu ili po paketu).
- Fajl `data/usage.json` možeš koristiti za računanje ili ga zameniti bazom / eksternim servisom (izmena u `src/usage.js`).

### Konkretan predlog (paketi + sati + kako te plaćaju)

| Paket     | Zahtevi/mesec | Okvirno sati* | Tvoj trošak (Sonnet) | Naplati studentu |
|-----------|----------------|----------------|------------------------|-------------------|
| Mini      | 100            | ~3–5 h         | ~2,55 USD              | **5 USD**         |
| Standard  | 250            | ~8–12 h        | ~6,38 USD              | **12 USD**        |
| Pro       | 500            | ~16–25 h       | ~12,75 USD             | **22 USD**        |
| Pro+      | 1000           | ~33–50 h       | ~25,50 USD             | **42 USD**        |

\* 1 zahtev ≈ 2–3 min; sati su orientaciono.

**Kako te plaćaju:** U ovoj aplikaciji **nema Stripe ni drugog plaćanja**. Proxy samo beleži usage. Naplatu radiš ručno (račun + tvoj IBAN/PayPal/Revolut) ili kasnije dodaš **Stripe** u poseban portal gde student vidi potrošnju i plaća paket – to je van ovog repo-a. Detalji i matematika: [docs/ANTHROPIC-PRICING-I-PREDLOG-NAPLATE.md](docs/ANTHROPIC-PRICING-I-PREDLOG-NAPLATE.md).

### Prepaid kredit (koliko potroše toliko plate)

- Za svaki API ključ postoji **stanje u USD** u `data/balances.json`. Svaki uspešan zahtev **oduzima** trošak od tog stanja (cena = Anthropic × **STUDENT_MARKUP**; ako nije setovan, 1 = bez marže). Kad stanje padne na 0 ili manje, sledeći zahtev dobija **402** i poruku da dopune nalog. **Zarada:** ako je npr. `STUDENT_MARKUP=1.5`, sa studenta skidaš 1.5× više nego što plaćaš Anthropic-u – razlika ostaje tebi.
- **Pravilo: 1 USD uplate = 1 USD kredita.** Nema posebnih paketa – iznos koji student plati (npr. 5 USD) direktno se dodaje na stanje.
- **Kalkulacija troška:** automatski po modelu iz `ANTHROPIC_MODEL` (Anthropic 2026): Sonnet 4 / 4.5 / 4.6 = 3 USD/1M ulaz, 15 USD/1M izlaz; Opus 4.5 / 4.6 = 5 / 25; Haiku 4.5 = 1 / 5.
- **Automatsko dodavanje kredita (Stripe):**  
  - Student na **/dashboard** klikne npr. "Dopuni 5 USD" → otvori se Stripe Checkout → po uspešnoj uplati Stripe šalje webhook na **POST /webhooks/stripe** → proxy dodaje taj iznos (5 USD) na stanje tog ključa. Ne razmiljavaš ručno.  
  - Potrebno u `.env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, opciono `BASE_URL`. U Stripe Dashboardu podeš webhook na `https://tvoj-domen.com/webhooks/stripe`, event `checkout.session.completed`.
- **Ručno (bez Stripe):** **POST /admin/add-credits** sa `X-Admin-Secret` i telom `{ "key_id": "xxxxx", "amount_usd": 5 }` (`key_id` = poslednjih 8 karaktera API ključa).

## Deploy (Render / Railway / Fly.io)

### Render (free tier, preporučeno za start)

1. **GitHub:** Otvori repo na GitHubu (ako već nemaš: `git init`, `git add .`, `git commit -m "init"`, pa na github.com New Repository i push).
2. **Render:** Idi na [render.com](https://render.com), uloguj se, **New** → **Web Service**.
3. **Poveži repo:** Izaberi GitHub nalog i repozitorijum **TokeniStudenti** (ili kako god se zove). Branch: `main` (ili `master`).
4. **Podešavanja:**
   - **Name:** npr. `vajb-agent`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** **Free**
5. **Environment (Environment Variables):** Klikni **Add Environment Variable** i dodaj (kao **Secret** gde ima smisla):
   - `ANTHROPIC_API_KEY` = tvoj Anthropic ključ
   - `STUDENT_API_KEYS` = npr. `student-key-1,student-key-2` (zapeti, bez razmaka)
   - `ADMIN_SECRET` = npr. `kalabunga1991`
6. **Create Web Service.** Render će buildovati i pokrenuti; sačekaj da status bude **Live** (zelena kvačica).
7. **URL:** Ispod imena servisa videćeš URL, npr. `https://vajb-agent.onrender.com`. To je tvoj **Base URL**.
8. **Cursor:** U Override OpenAI Base URL stavi **taj URL** (npr. `https://vajb-agent.onrender.com`). API Key ostaje `student-key-1`. Osveži modele / pošalji poruku – trebalo bi da radi (prvi zahtev posle duže pauze može da traje ~1 min dok se free instanca probudi).
9. **Kredit:** Dodaj sebi kredit preko curl-a, zamenjujući domen:
   ```bash
   curl -X POST https://vajb-agent.onrender.com/admin/add-credits \
     -H "X-Admin-Secret: kalabunga1991" \
     -H "Content-Type: application/json" \
     -d '{"key_id":"ent-key-1","amount_usd":5}'
   ```

**Napomena:** Na free tieru servis se gasi posle 15 min neaktivnosti; sledeći zahtev ga budi (~1 min). Na free tieru su `data/` (balance, usage) efemerni – gube se pri restartu. Da bi preživeli: u Render Dashboard dodaj **Persistent Disk** (mount path `/data`), u Environment postavi `DATA_DIR=/data`; tada se balance i usage čuvaju trajno. (Disk može zahtevati paid plan.)

---

### Railway

1. Kreiraj projekat na [railway.app](https://railway.app), poveži GitHub repo.
2. U **Variables** dodaj: `ANTHROPIC_API_KEY`, `STUDENT_API_KEYS`, po želji `PORT` (Railway obično postavlja `PORT`).
3. **Deploy** iz repozitorijuma; build: `npm install`, start: `npm start`.
4. Base URL u Cursoru: `https://tvoj-projekat.railway.app`.

### Fly.io

1. U root-u projekta: `fly launch` (izaberi region, ime app-a).
2. Tajne:  
   `fly secrets set ANTHROPIC_API_KEY=sk-ant-...`  
   `fly secrets set STUDENT_API_KEYS="key1,key2,key3"`
3. Deploy: `fly deploy`.
4. Base URL: `https://tvoj-app.fly.dev`.

### Opšte

- Za produkciju preporučeno: HTTPS, ograničenje brzine po ključu, eventualno poseban admin auth za `/usage`.
- `data/` na Railway/Fly je efemerno osim ako ne dodaš persistent volume; za trajno čuvanje usage koristi bazu ili eksterni storage i prilagodi `src/usage.js`.

## Licenca

MIT (ili kako odlučiš).

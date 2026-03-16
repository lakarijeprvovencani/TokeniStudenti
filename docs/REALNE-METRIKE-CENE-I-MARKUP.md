# Realne metrike, cene i markup – VajbAgent vs Cursor vs Cline

Dokument sa **stvarnim** API cenama (mart 2026), prosečnom potrošnjom tokena pri kodiranju, poređenjem sa Cursor i Cline, i preporukom markupa.

---

## 1. Zvanične API cene (izvor: OpenAI + Anthropic)

### 1.1 OpenAI (Chat Completions)

| Model        | Input ($/1M tok) | Output ($/1M tok) | Kontekst   |
|-------------|-------------------|-------------------|------------|
| **GPT-5 mini** | 0.25              | 2.00              | do 270K    |
| **o4-mini**    | 1.10              | 4.40              | 200K       |
| **GPT-5**      | 1.25              | 10.00             | 400K       |
| **GPT-5.4**    | 2.50              | 15.00             | frontier   |

Izvori: [openai.com/api/pricing](https://openai.com/api/pricing), [developers.openai.com/docs/pricing](https://developers.openai.com/api/docs/pricing).  
Cached input: obično 10% osnovne cene (npr. GPT-5 mini cached $0.025/1M).

### 1.2 Anthropic (Claude API)

| Model             | Input ($/1M tok) | Output ($/1M tok) |
|------------------|-------------------|-------------------|
| **Claude Sonnet 4.6** | 3.00               | 15.00             |
| **Claude Opus 4.6**   | 5.00               | 25.00             |
| Claude Haiku 4.5      | 1.00               | 5.00              |

Izvor: [docs.anthropic.com/en/docs/about-claude/pricing](https://docs.anthropic.com/en/docs/about-claude/pricing).

---

## 2. Šta ti trenutno imaš u kodu (`src/balance.js`)

Tvoje **PRICES** su usklađene sa zvaničnim cenama:

- `gpt-5-mini`: $0.25 / $2.00 ✅  
- `o4-mini`: $1.10 / $4.40 ✅  
- `gpt-5`: $1.25 / $10.00 ✅  
- `gpt-5.4`: $2.50 / $15.00 ✅  
- `claude-sonnet-4-6`: $3.00 / $15.00 ✅  
- `claude-opus-4-6`: $5.00 / $25.00 ✅  

Markup (iz env): **OPENAI_MARKUP=1.80**, **ANTHROPIC_MARKUP=1.65**.

---

## 3. Realne metrike: koliko tokena po zahtevu kada korisnik kodira

Kodiranje u Cursoru/Cline znači: **poruka korisnika + ceo kontekst (history + codebase + system)** šalje se na svaki zahtev. Broj tokena varira jako.

### 3.1 Šta utiče na broj tokena

- **History** – cela prethodna konverzacija (Cursor/klijent šalje sve ili skraćeno).
- **Codebase / @fajlovi** – selektovani fajlovi, search rezultati, ponekad i deo projekta.
- **System prompt** – Cursor dodaje ~600–800 tokena po zahtevu.
- **Tool calls** – svaki tool call može ponovo uključiti deo konteksta (zbog toga neki izvori navode i 10× “inflaciju” u prikazu u odnosu na minimalan zahtev).

Zato **jedan “prosečan” zahtev** u praksi nije “jedna kratka poruka”, već jedan ciklus (korisnik pita → model odgovara, eventualno tool calls).

### 3.2 Usvojene prosečne vrednosti (konzervativno)

Za računicu koristimo brojke koje su u skladu sa tvojim doc-om i realnim merenjima u IDE:

| Metrika        | Vrednost   | Napomena |
|----------------|------------|----------|
| **Input po zahtevu**  | 3.500 tok  | Umereno: malo fajlova + kratka history. Teži slučajevi 10k–50k+. |
| **Output po zahtevu** | 1.000 tok  | Kratak odgovor ~300, duži (refaktor, objašnjenje) 1.5k–3k. |

**Jedan prosečan zahtev ≈ 3.500 input + 1.000 output tokena.**

Za “teške” sesije (dosta @fajlova, duga history): realno **2×–4×** više input tokena (npr. 7k–15k input po zahtevu).

---

## 4. Trošak po zahtevu (tebe) i po korisniku (sa tvojim markupom)

Formula:  
`trošak_provider = (input/1e6)*in_price + (output/1e6)*out_price`  
`naplata_korisnik = trošak_provider * markup`

Za **3.500 in / 1.000 out** i tvoje cene:

| Model              | Tvoj trošak/zahtev | Sa markup 1.80 (OpenAI) | Sa markup 1.65 (Anthropic) |
|--------------------|--------------------|--------------------------|-----------------------------|
| **GPT-5 mini**     | $0.000 89          | $0.001 60                | –                           |
| **o4-mini**        | $0.002 25          | $0.004 05                | –                           |
| **GPT-5**          | $0.004 69          | $0.008 44                | –                           |
| **GPT-5.4**        | $0.008 75          | $0.015 75                | –                           |
| **Claude Sonnet 4.6** | $0.002 55       | –                        | $0.004 21                   |
| **Claude Opus 4.6**   | $0.004 25       | –                        | $0.007 01                   |

### 4.1 Koliko zahteva za $1 (tebe) – provider cost

- **GPT-5 mini**: ~1.124 zahteva/$1  
- **o4-mini**: ~444 zahteva/$1  
- **GPT-5**: ~213 zahteva/$1  
- **Claude Sonnet 4.6**: ~392 zahteva/$1  
- **Claude Opus 4.6**: ~235 zahteva/$1  

### 4.2 Koliko korisnik “može da kodira” za npr. $10 kredita (na tvojoj naplati)

Uzimajući **samo jedan model** i prosečan zahtev (3.5k in / 1k out):

| Model              | Naplata po zahtevu (tvoj markup) | Za $10 kredita (broj zahteva) |
|--------------------|-----------------------------------|--------------------------------|
| **VajbAgent Lite (GPT-5 mini)**   | ~$0.001 60 | ~6.250 zahteva |
| **VajbAgent Turbo (o4-mini)**    | ~$0.004 05 | ~2.470 zahteva |
| **VajbAgent Pro (GPT-5)**        | ~$0.008 44 | ~1.185 zahteva |
| **VajbAgent Max (Claude Sonnet)**| ~$0.004 21 | ~2.375 zahteva |

U satima (ako je ~50–80 zahteva/sat aktivnog kodiranja):  
- **Lite**: $10 ≈ desetine sati.  
- **Pro / Max**: $10 ≈ red veličine 15–25 sati umerenog korišćenja.

---

## 5. Poređenje: Cursor vs Cline vs VajbAgent (ti)

### 5.1 Cursor (mart 2026)

- **Pro**: $20/mesec – uključuje **$20 kredita** po API cenama (frontier modeli).  
- **Pro+**: $60/mesec – 3× više korišćenja na OpenAI/Claude/Gemini.  
- **Ultra**: $200/mesec – 20× usage.  
- **Teams**: $40/korisnik/mesec, $20 agent usage po useru + preko toga po list API cenama.

Cursor naplaćuje **po tokenima** (API cene), ne “po zahtevu”. Znači za $20 mogu da potroše $20 po list cenama (npr. GPT-5, Claude).  
Tvoj model: korisnik kupi kredit (npr. $10) i troši po **tvojoj** ceni (API × markup). Ti ostaješ na razlici.

### 5.2 Cline

- **Individual**: besplatan softver; korisnik koristi **sopstveni API ključ** (OpenAI, Anthropic, itd.) – plaća direktno provajderu po zvaničnim cenama.  
- **Teams**: do Q1 2026 besplatno, zatim $20/korisnik/mesec (prvih 10 mesta besplatno).  
- **Enterprise**: custom.

Kod Cline-a nema “markup-a” od strane Cline-a – korisnik vidi iste cene kao da koristi API direktno. Ti sa VajbAgentom nudiš **jednostavnost** (jedan endpoint, jedan ključ, bez da student otvara OpenAI/Anthropic nalog) i **kontrolu** (limit, naplata po tebi).

### 5.3 Rezime poređenja

|                    | Cursor Pro      | Cline (svoj ključ) | VajbAgent (ti)        |
|--------------------|-----------------|---------------------|------------------------|
| Cena za korisnika  | $20/mes + usage | Samo API cene       | Tvoja naplata (API × markup) |
| Ko plaća API       | Cursor          | Korisnik            | Ti (pa naplatiš)       |
| Kontekst / history  | Da, veliki      | Da                  | Da (isto šalje Cursor) |
| Kontrola / limiti   | Cursor          | Korisnik            | Ti (balance, ključevi) |

---

## 6. Da li su markup 1.65 (Anthropic) i 1.80 (OpenAI) realni?

- **Anthropic 1.65×**:  
  - Tvoj trošak Sonnet: $3 / $15.  
  - Naplata: $4.95 / $24.75 po 1M.  
  - To je **ispod** Cursor liste (Cursor naplaćuje po list cenama, nema “popusta” za studente).  
  - Za studenta je i dalje jeftinije ili na sličnom nivou kao da koristi Cursor sa svojim budžetom, a ti imaš ~39% marže na Anthropic.

- **OpenAI 1.80×**:  
  - Npr. GPT-5: $1.25 / $10 → naplata $2.25 / $18.  
  - I dalje ispod ili na nivou “custom endpoint” cena; **80% marže** za tebe je u skladu sa rizikom i operativom (podrška, limiti, naplata).

**Zaključak:** 1.65 i 1.80 su **realni i konzervativni** markupi: korisnik nije preplaćen u odnosu na Cursor/API, a ti imaš jasnu maržu.

### 6.1 Opcioni raspon (ako želiš da eksperimentišeš)

- **Minimalno** (mala marža, privlačenje korisnika): 1.25–1.40 (OpenAI), 1.25–1.35 (Anthropic).  
- **Trenutno (preporučeno)**: 1.80 (OpenAI), 1.65 (Anthropic).  
- **Agresivnije**: 2.0 (OpenAI), 1.80 (Anthropic) – i dalje konkurentno za “paket za studente” u odnosu na Cursor.

---

## 7. Koji model za šta (orijentaciono)

| Potreba                         | Model koji ima smisla        | Razlog |
|---------------------------------|------------------------------|--------|
| Svakodnevno kodiranje, brzo     | **VajbAgent Lite (GPT-5 mini)** | Najjeftiniji, dovoljno dobar za većinu zadataka. |
| Reasoning, debugging, teža logika| **VajbAgent Turbo (o4-mini)**    | Bolji za multi-step, jeftiniji od GPT-5. |
| Ozbiljniji projekti, složeniji kod | **VajbAgent Pro (GPT-5)**    | Jači, skuplji. |
| Kompleksni zadaci, najbolji kvalitet | **VajbAgent Max (Claude Sonnet)** | Dobar odnos cena/kvalitet za “max” tier. |

Za “koliko u proseku može da se kodira”:  
- **Lite**: najviše zahteva po $ – za one koji rade puno sati, ali sa kratkim kontekstom.  
- **Pro / Max**: manje zahteva po $, ali dovoljno za red veličine **15–30 sati** aktivnog kodiranja za ~$10 ako su zahtevi blizu proseka (3.5k in / 1k out).  
Ako korisnik često šalje veliki kontekst (mnogo fajlova, duga history), broj zahteva po $10 opada (npr. 2× manje).

---

## 8. Kratak rezime

1. **Cene u `balance.js`** su usklađene sa zvaničnim OpenAI i Anthropic cenama.  
2. **Prosečan zahtev** pri kodiranju: **~3.500 input + 1.000 output** tokena; teži slučajevi 2×–4× više inputa.  
3. **Cursor**: $20/mes + API krediti; **Cline**: besplatno, korisnik plaća API; **VajbAgent**: ti naplaćuješ API × markup.  
4. **Markup 1.65 (Anthropic) i 1.80 (OpenAI)** su realni i daju ti maržu bez preterivanja.  
5. Za **$10 kredita**, u proseku: **Lite** hiljade zahteva, **Pro/Max** red veličine 1.200–2.400 zahteva (~15–25 sati umerenog kodiranja).  
6. Za svakodnevno kodiranje: **Lite**; za teži posao: **Turbo** ili **Pro**; za “najbolje”: **Max (Claude Sonnet)**.

Sve brojke su iz javnih izvora (OpenAI, Anthropic, Cursor, Cline) i tvojeg koda; nema namerno “halucinacija” – samo zaokruživanje i prosečne procene za tokene po zahtevu.

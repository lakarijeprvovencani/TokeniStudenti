# Anthropic cene (2026) + matematika potrošnje + predlog naplate za studente

Izvori: [Anthropic Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing), mart 2026. Cene su u USD po milion tokena (MTok).

---

## Pricing plan i predlog naplate (najnoviji modeli: Sonnet 4.5/4.6, Opus 4.5/4.6)

Sve brojke su za **najnovije** modele (Sonnet 4.5/4.6 i Opus 4.5/4.6). U proxyju model biraš preko `ANTHROPIC_MODEL`; trošak se u kodu računa automatski po ovoj tabeli.

**Cene Anthropic (2026) – verzije koje koristimo:**

| Model              | Verzija   | Ulaz (USD/1M tok.) | Izlaz (USD/1M tok.) |
|--------------------|-----------|--------------------|----------------------|
| Claude Sonnet      | 4.5, 4.6  | 3                   | 15                   |
| Claude Opus        | 4.5, 4.6  | 5                   | 25                   |

**Predlog paketa i naplate:**

| Paket     | Zahtevi/mesec | Okvirno sati | Tvoj trošak (Sonnet 4.5/4.6) | Naplati studentu | **Tvoja neto zarada** | Tvoj trošak (Opus 4.5/4.6) | Naplati studentu | **Tvoja neto zarada** |
|-----------|----------------|--------------|------------------------------|-------------------|-------------------------|----------------------------|-------------------|-------------------------|
| **Mini**  | 100            | ~3–5 h       | ~2,55 USD                    | **5 USD**         | **~2,45 USD**            | ~4,25 USD                  | **7–8 USD**       | **~2,75–3,75 USD**     |
| **Standard** | 250          | ~8–12 h      | ~6,38 USD                    | **12 USD**        | **~5,62 USD**            | ~10,63 USD                 | **15–18 USD**     | **~4,37–7,37 USD**     |
| **Pro**   | 500            | ~16–25 h     | ~12,75 USD                   | **22 USD**        | **~9,25 USD**            | ~21,25 USD                 | **28–32 USD**     | **~6,75–10,75 USD**    |
| **Pro+**  | 1000           | ~33–50 h     | ~25,50 USD                   | **42 USD**        | **~16,50 USD**           | ~42,50 USD                 | **52–58 USD**     | **~9,50–15,50 USD**    |

- **Sonnet 4.5 / Sonnet 4.6** – isti cene (3 USD/1M ulaz, 15 USD/1M izlaz). Ako u proxyju koristiš neki od njih (npr. `ANTHROPIC_MODEL=claude-sonnet-4-20250514`), gledaj kolone „Tvoj trošak (Sonnet 4.5/4.6)” i „Naplati studentu”. Marža na ovim naplatama je ~50–95%.
- **Opus 4.5 / Opus 4.6** – isti cene (5 USD/1M ulaz, 25 USD/1M izlaz). Ako koristiš Opus, gledaj kolone za Opus 4.5/4.6; naplate su veće jer je tvoj trošak veći (~35–65% marža).
- **Prepaid u aplikaciji:** 1 USD uplate = 1 USD kredita. Student kupuje npr. „Dopuni 12 USD” i dobija 12 USD kredita; potrošnja se oduzima po cenama iz tabele gore.

---

## 1. Cene po modelima (base input / output, bez cache-a)

| Model | Input ($/MTok) | Output ($/MTok) |
|-------|----------------|-----------------|
| **Claude Opus 4.6** | 5 | 25 |
| **Claude Opus 4.5** | 5 | 25 |
| Claude Opus 4 / 4.1 | 15 | 75 |
| **Claude Sonnet 4.6** | 3 | 15 |
| **Claude Sonnet 4.5** | 3 | 15 |
| Claude Sonnet 4 | 3 | 15 |
| Claude Haiku 4.5 | 1 | 5 |

Za tvoj proxy najrelevantniji su **Sonnet 4.5/4.6** i **Opus 4.5/4.6** (najnoviji, najbolji odnos cena/kvalitet). Opus 4.1 je skuplji, Haiku je jeftiniji. U kodu (`src/balance.js`) trošak se računa automatski iz `ANTHROPIC_MODEL`: ako model u imenu sadrži "opus" koriste se 5/25, ako "haiku" onda 1/5, inače Sonnet 3/15.

---

## 2. Prosečna potrošnja (matematika)

Procena po jednom zahtevu (npr. jedan odgovor u Cursoru):

- **Input**: kontekst (kod, poruke, system) – red veličine **2.000–6.000** tokena po zahtevu. Za računicu uzimamo **3.500** tokena prosek.
- **Output**: odgovor modela – red veličine **300–2.000** tokena. Za računicu uzimamo **1.000** tokena prosek.

Znači **jedan “prosečan” zahtev** ≈ **3.500 input + 1.000 output** tokena.

### Mesec po tipu studenta (orientaciono)

| Tip | Zahtevi/mesec | Input tokeni | Output tokeni |
|-----|----------------|--------------|---------------|
| Lagan | 100 | 350.000 | 100.000 |
| Umeren | 250 | 875.000 | 250.000 |
| Aktivan | 500 | 1.750.000 | 500.000 |
| Veoma aktivan | 1.000 | 3.500.000 | 1.000.000 |

---

## 3. Tvoja cena (Anthropic) po modelu i po studentu

Formula:  
**Trošak = (Input / 1.000.000 × cena_in) + (Output / 1.000.000 × cena_out)**

### Sonnet 4.5 / 4.6 ($3 in, $15 out)

| Tip | Input (M) | Output (M) | Trošak (USD) |
|-----|-----------|------------|--------------|
| Lagan | 0,35 | 0,10 | 0,35×3 + 0,10×15 = **2,55** |
| Umeren | 0,875 | 0,25 | 0,875×3 + 0,25×15 = **6,38** |
| Aktivan | 1,75 | 0,50 | 1,75×3 + 0,50×15 = **12,75** |
| Veoma aktivan | 3,5 | 1,0 | 3,5×3 + 1,0×15 = **25,50** |

### Opus 4.5 / 4.6 ($5 in, $25 out)

| Tip | Input (M) | Output (M) | Trošak (USD) |
|-----|-----------|------------|--------------|
| Lagan | 0,35 | 0,10 | 0,35×5 + 0,10×25 = **4,25** |
| Umeren | 0,875 | 0,25 | 0,875×5 + 0,25×25 = **10,63** |
| Aktivan | 1,75 | 0,50 | 1,75×5 + 0,50×25 = **21,25** |
| Veoma aktivan | 3,5 | 1,0 | 3,5×5 + 1,0×25 = **42,50** |

Ako koristiš **samo Sonnet** u proxyju (npr. `ANTHROPIC_MODEL=claude-sonnet-4-20250514`), gledaj samo redove za Sonnet. Ako kasnije dodaš izbor modela (npr. vajb-sonnet / vajb-opus), možeš računati posebno po modelu.

---

## 4. Predlog naplate za studente

Ti plaćaš Anthropic; studente naplaćuješ sa maržom. Opcije:

### A) Marža na trošak (npr. +50% ili +100%)

- **+50%**: Sonnet umeren → 6,38 × 1,5 ≈ **9,57 USD** studentu.
- **+100%**: isti slučaj → 6,38 × 2 ≈ **12,76 USD** studentu.

Možeš na mesečnom računu koristiti `data/usage.json` (input/output po ključu), izračunati trošak po Anthropic cenama, pa pomnožiti sa 1,5 ili 2.

### B) Fiksni paketi (najjednostavnije za studente)

Cilj: pokriti trošak + marža, a cene za studente okrugle i razumljive.

| Paket | Okvirno pokriveno | Tvoj trošak (Sonnet) | Naplati studentu (npr. +60%) |
|-------|--------------------|-----------------------|------------------------------|
| Mini | ~lagan (100 req) | ~2,55 USD | **4–5 USD** |
| Standard | ~umeren (250 req) | ~6,38 USD | **10–12 USD** |
| Pro | ~aktivan (500 req) | ~12,75 USD | **20–22 USD** |
| Unlimited* | cap npr. 1000 req | ~25,50 USD | **40–45 USD** |

\* “Unlimited” = do neke gornje granice zahteva ili tokena, posle koje blokiraš ili naplatiš prekoračenje.

### C) Cena po tokenu za studente (transparentno)

Npr. za Sonnet:

- Input: 3 × 1,5 = **4,50 USD / MTok** (ili 0,0045 USD / 1k tokena).
- Output: 15 × 1,5 = **22,50 USD / MTok** (ili 0,0225 USD / 1k tokena).

Student vidi u `data/usage.json` (ili na nekom dashboardu) input/output tokeni; ti na kraju meseca računaš:  
`(input_tokens/1e6 * 4.5) + (output_tokens/1e6 * 22.5)` u USD.

### Preporuka

- Za početak: **paketi (B)** – npr. Mini / Standard / Pro sa fiksnom mesečnom cenom; ti u pozadini pratiš usage i podešavaš limite (npr. po broju zahteva ili ukupnim tokenima) da ne pređeš željenu maržu.
- Ako želiš da bude “fer” i da plaćaju samo ono što potroše: **marža na trošak (A)** ili **cena po tokenu (C)** na osnovu istih Anthropic cena iz tabele.

---

## 5. Rezime brojeva (brza referenca)

- **Sonnet 4.5/4.6**: 3 USD / MTok in, 15 USD / MTok out.
- **Opus 4.5/4.6**: 5 USD / MTok in, 25 USD / MTok out.
- **Prosečan zahtev**: ~3.500 in + 1.000 out tokena.
- **Umeren student (250 req) na Sonnetu**: tvoj trošak ~**6,38 USD**, naplata 10–12 USD (paket) ili trošak × 1,5–2 (marža).

Kada imaš stvarne podatke iz `data/usage.json`, možeš zameniti ove procene prosečnim input/output po studentu i prilagoditi pakete i cene.

---

## 6. Konkretan predlog (rezime)

**Model u proxyju:** Sonnet 4.5/4.6 (tvoj trošak: 3 / 15 USD po MTok).

| Paket   | Zahtevi/mesec | Okvirno sati korišćenja* | Tvoj trošak (Anthropic) | Naplati studentu |
|---------|----------------|---------------------------|--------------------------|-------------------|
| **Mini**      | 100  | ~3–5 h   | ~2,55 USD  | **5 USD**  |
| **Standard**  | 250  | ~8–12 h  | ~6,38 USD  | **12 USD** |
| **Pro**       | 500  | ~16–25 h | ~12,75 USD | **22 USD** |
| **Pro+**      | 1000 | ~33–50 h | ~25,50 USD | **42 USD** |

\* **Sati:** 1 zahtev ≈ 2–3 min u proseku (čekanje odgovora + čitanje). 100 zahteva ≈ 200–300 min ≈ **3–5 h**. 250 ≈ **8–12 h**, 500 ≈ **16–25 h**, 1000 ≈ **33–50 h**. Zavisi koliko brzo korisnik šalje sledeći zahtev.

**Marža:** na ovim cenama oko 50–65% preko tvog troška (pokriva rizik, podršku, naplatu).

---

## 7. Gde si ti – kako te studenti plaćaju?

**U ovoj aplikaciji (VajbAgent proxy) trenutno nema naplate.** Aplikacija samo:

- izdaje API ključeve (ti ih ručno dodaš u `.env`),
- proverava ključ i šalje zahteve Anthropicu,
- beleži potrošnju u `data/usage.json` (input/output tokeni po ključu).

**Novac od studenta ne ide nigde automatski.** Ti imaš podatke ko je koliko potrošio; naplatu radiš posebno. Moguće varijante:

1. **Ručno (najjednostavnije za početak)**  
   Na kraju meseca gledaš `data/usage.json` (ili `/usage` sa nečijim ključem), računaš po paketu ili po tokenu, šalješ im **račun** (PDF) i tražiš uplatu na svoj račun / PayPal / Revolut. Nema integracije u aplikaciji.

2. **Stripe**  
   - **Stripe Subscription:** student bira paket (Mini / Standard / Pro), plaća mesečno; ti u Stripe Dashboard vidiš ko je platio. Povezuješ “ko je platio” sa “koji API ključ” ručno ili preko emaila (npr. isti email u Stripe i u tvojoj listi ključeva).  
   - **Stripe One-time / Checkout:** pošalješ im link za plaćanje za tekući mesec; nakon plaćanja aktiviraš ili produžiš njihov ključ.  
   U oba slučaja **Stripe nije u proxyju** – radiš ga u posebnoj stranici (npr. “VajbAgent portal”) gde se student prijavi, vidi usage i plaća. Proxy ostaje kao samo API.

3. **PayPal / Revolut / drugo**  
   Ista logika kao ručno: račun ili link za plaćanje, ti ručno proveravaš i “aktiviraš” ili ograničavaš ključ u proxyju (npr. uklanjaš iz `STUDENT_API_KEYS` ako nije platio).

**Praktično za prvi korak:** naplata **ručno** (račun + tvoj IBAN/PayPal) na osnovu usage-a iz aplikacije; kad se isplati, dodaš **Stripe** (ili drugi gateway) u mali “portal” gde student vidi potrošnju i plaća paket – ali to je sledeći korak, van ovog proxyja.

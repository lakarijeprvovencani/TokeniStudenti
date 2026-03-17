# Brzi vodič — od registracije do prvog chata

Sve na jednom mestu: kako da se registruješ, dobiješ ključ, instaliraš ekstenziju i počneš da kodiraš.

---

## 1. Registracija

1. Idi na [vajbagent.com/dashboard](https://vajbagent.com/dashboard)
2. Klikni tab **Novi nalog**
3. Unesi ime, prezime i email
4. Klikni **Napravi nalog**
5. Dobijaš **API ključ** i **$2 kredita** na poklon — sačuvaj ključ negde sigurno

---

## 2. Dashboard — šta imaš

Posle prijave vidiš:

| Sekcija | Šta radi |
|---------|----------|
| **Pregled** | Stanje kredita, potrošnja, API ključ (Kopiraj / Preuzmi) |
| **Modeli** | Orijentaciono koliko zahteva možeš za tvoj kredit |
| **Dopuna** | Dopuni kredit karticom (Stripe) |
| **Podešavanja** | Uputstva za instalaciju ekstenzije |

---

## 3. Instalacija ekstenzije

### Korak 1 — Instaliraj

- Otvori **Cursor** ili **VS Code**
- Pritisni `Ctrl+Shift+X` (Windows/Linux) ili `Cmd+Shift+X` (Mac) — otvara se Extensions
- U pretrazi upiši **VajbAgent**
- Klikni **Install**

Ili direktno: [Marketplace → VajbAgent](https://marketplace.visualstudio.com/items?itemName=VajbAgent.vajbagent) → Install

### Korak 2 — Unesi API ključ

- U sidebar-u otvori panel **VajbAgent** (ikona u Activity Bar)
- Klikni na ⚙️ (podešavanja)
- U polje **API Key** nalepi svoj ključ (sa dashboarda → Pregled → Kopiraj)
- Sačuvaj

### Korak 3 — Izaberi model i kreni

- U footeru chata izaberi model (Lite, Pro, Max...)
- Napiši poruku — agent odgovara, čita fajlove, menja kod, pokreće komande

**Napomena:** Ekstenzija automatski koristi naš server. Ne treba ti Base URL ni model ID — samo API ključ.

---

## 4. Cursor bez ekstenzije (alternativa)

Ako želiš da koristiš Cursor sa ugrađenim chatom (bez naše ekstenzije):

1. Idi na [vajbagent.com/setup](https://vajbagent.com/setup)
2. Kopiraj **Base URL** i svoj **API ključ**
3. U Cursoru: Settings → Models → Override OpenAI Base URL + API Key
4. Dodaj custom model (npr. `vajb-agent-pro`)
5. U chatu izaberi taj model

---

## 5. Česta pitanja

| Pitanje | Odgovor |
|---------|---------|
| Gde je moj ključ? | Dashboard → Pregled → API ključ (Kopiraj / Preuzmi) |
| Zaboravio sam ključ | Dashboard → Zaboravio si ključ? → unesi email |
| Nema kredita | Dashboard → Dopuna → izaberi iznos |
| Ekstenzija ne radi | Proveri da li je API ključ unet u ⚙️ podešavanjima |
| Prvi zahtev spor? | Na free tieru server se budi posle pauze (~1 min) |

---

## 6. Linkovi

- **Dashboard:** [vajbagent.com/dashboard](https://vajbagent.com/dashboard)
- **Setup (Cursor bez ekstenzije):** [vajbagent.com/setup](https://vajbagent.com/setup)
- **Marketplace:** [marketplace.visualstudio.com → VajbAgent](https://marketplace.visualstudio.com/items?itemName=VajbAgent.vajbagent)

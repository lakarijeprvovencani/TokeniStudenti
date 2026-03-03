# Deploy VajbAgent na Render – korak po korak

## 1. Repo na GitHubu

- Ako već nemaš: otvori terminal u folderu projekta i uradi:
  ```bash
  git init
  git add .
  git commit -m "VajbAgent proxy"
  ```
- Na [github.com](https://github.com) → **New repository** (npr. ime `TokeniStudenti`), ne dodavaj README.
- Poveži i push:
  ```bash
  git remote add origin https://github.com/TVOJ_USERNAME/TokeniStudenti.git
  git branch -M main
  git push -u origin main
  ```
  (Zameni `TVOJ_USERNAME` i `TokeniStudenti` svojim podacima.)

## 2. Render nalog i novi servis

- Idi na [render.com](https://render.com), uloguj se (ili registruj, možeš preko GitHub-a).
- **New** → **Web Service**.
- Poveži GitHub i izaberi repozitorijum ovog projekta. Klikni **Connect**.

## 3. Podešavanja servisa

- **Name:** `vajb-agent` (ili kako hoćeš)
- **Region:** izaberi najbliži (npr. Frankfurt)
- **Branch:** `main`
- **Runtime:** **Node**
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Instance type:** **Free**

## 4. Environment variables

U sekciji **Environment** klikni **Add Environment Variable** i dodaj (svaki u poseban red):

| Key | Value |
|-----|--------|
| `ANTHROPIC_API_KEY` | tvoj Anthropic API ključ (sk-ant-...) |
| `STUDENT_API_KEYS` | `student-key-1,student-key-2` (ključevi razdvojeni zarezom) |
| `ADMIN_SECRET` | tvoja tajna za admin (npr. `kalabunga1991`) |

Sve tri stavi kao **Secret** (kad ima opciju).

## 5. Deploy

- Klikni **Create Web Service**.
- Render će raditi build i start. Sačekaj da status bude zelen **Live** (može 2–5 min).

## 6. Uzmi URL

- Ispod imena servisa videćeš link, npr. `https://vajb-agent.onrender.com`. To je tvoj **Base URL** – kopiraj ga.

## 7. Cursor

- **Settings** → **Models** → **API Keys**.
- **Override OpenAI Base URL:** uključeno, u polje stavi **Render URL** (npr. `https://vajb-agent.onrender.com`).
- **OpenAI API Key:** uključeno, u polje stavi `student-key-1` (ili neki drugi iz `STUDENT_API_KEYS`).
- Ako nemaš model u listi: **+ Add Custom Model** → unesi `vajb-agent-pro` (pa eventualno `vajb-agent-max`).

## 8. Dodaj kredit (da chat radi)

U terminalu (zameni URL svojim):

```bash
curl -X POST https://vajb-agent.onrender.com/admin/add-credits \
  -H "X-Admin-Secret: kalabunga1991" \
  -H "Content-Type: application/json" \
  -d '{"key_id":"ent-key-1","amount_usd":5}'
```

(`ent-key-1` = poslednjih 8 karaktera od `student-key-1`. Ako koristiš drugi ključ, zameni `key_id`.)

## 9. Test

U Cursoru izaberi **vajb-agent-pro**, pošalji poruku. Ako je sve ok, dobićeš odgovor.

---

**Napomene**

- Free instanca se gasi posle 15 min neaktivnosti; prvi zahtev posle toga može da traje ~1 min (cold start).
- Studentima šalješ: **Base URL** (tvoj Render URL) i **njihov** API ključ (koji dodaš u `STUDENT_API_KEYS` na Renderu i redeploy-uješ, ili im dodaš pre deploy-a).

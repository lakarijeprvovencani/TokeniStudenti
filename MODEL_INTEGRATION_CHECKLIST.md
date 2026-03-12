# Checklist: Dodavanje novog modela u VajbAgent

Svaki put kad dodaješ novi AI model u VajbAgent, prođi kroz ove korake redom.
Ovo osigurava da ništa ne preskočiš — od istraživanja do testiranja.

---

## 1. ISTRAŽIVANJE (pre pisanja koda)

### 1.1 Osnovno o modelu
- [ ] Koji je **tačan API naziv** modela? (npr. `gpt-5-mini`, `o4-mini`, `claude-sonnet-4-6`)
- [ ] Koji **provider**? (OpenAI, Anthropic, Google, itd.)
- [ ] Koji **API endpoint** podržava? (Chat Completions, Responses API, Messages API)

### 1.2 Cene (obavezno sa zvaničnog sajta)
- [ ] **Input cena** po 1M tokena
- [ ] **Output cena** po 1M tokena
- [ ] **Cached input** cena (ako postoji)
- [ ] Da li postoji **cena za reasoning tokene** posebno ili se broje kao output?
- [ ] Proveri: https://openai.com/api/pricing/ ili https://docs.anthropic.com/en/docs/models

### 1.3 Limiti
- [ ] **Context window** (max input + output zajedno)
- [ ] **Max output tokena** (koliko model može da generiše u jednom odgovoru)
- [ ] Da li postoji **limit na broj tool-ova**?

### 1.4 Parametri API poziva
- [ ] Da li koristi `max_tokens` ili `max_completion_tokens`?
  - OpenAI: `max_completion_tokens` za sve GPT-5+ i o-seriju (`max_tokens` je deprecated)
  - Anthropic: `max_tokens`
- [ ] Da li podržava `stream`?
- [ ] Da li u stream modu vraća `usage` (sa `stream_options: { include_usage: true }`)?
- [ ] Da li podržava `reasoning_effort`? Koje vrednosti? (none/minimal/low/medium/high)
- [ ] Da li podržava `temperature`? (reasoning modeli nekad ne podržavaju)
- [ ] Koji parametri NISU podržani? (npr. `stop` ne radi sa nekim modelima)

### 1.5 Funkcionalnosti
- [ ] **Vision (slike)** — da li može da primi slike kao input? Koji format? (base64, URL)
- [ ] **Tool calling / function calling** — da li podržava `tools` parametar?
- [ ] **Structured output / JSON mode** — da li podržava `response_format`?
- [ ] **Streaming** — da li radi SSE streaming?

### 1.6 Usage / naplata
- [ ] Kako izgleda `usage` objekat u odgovoru?
  - OpenAI: `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`
  - Anthropic: `input_tokens`, `output_tokens`
- [ ] Da li se **reasoning tokeni** broje unutar `completion_tokens`? (da, kod OpenAI)
- [ ] Da li stream vraća usage u poslednjem chunku?
- [ ] Šta ako stream NE vrati usage — kako estimirati?

---

## 2. IMPLEMENTACIJA

### 2.1 `src/index.js` — Model registar

```js
// VAJB_MODELS niz — dodaj novi model
{ id: 'vajb-agent-NAZIV', name: 'VajbAgent NAZIV', backend: 'openai|anthropic',
  backendModel: 'tačan-api-naziv', desc: 'Kratak opis' }
```

- [ ] Dodaj u `VAJB_MODELS` niz na pravo mesto (sortiran po ceni/snazi)
- [ ] Dodaj u `MAX_OUTPUT` objekat: `'model-api-naziv': maxOutputTokens`
- [ ] Ako je reasoning model: proveri da `isReasoning` check hvata (startsWith('o'))
- [ ] Ako koristi `max_completion_tokens`: proveri da payload builder to koristi
- [ ] Ako ima poseban system prompt (kao Architect): dodaj `isPower: true` flag

### 2.2 `src/balance.js` — Cene

```js
// PRICES objekat — dodaj cenu
'model-api-naziv': { in: CENA_PO_MILION_INPUT, out: CENA_PO_MILION_OUTPUT },
```

- [ ] Dodaj u `PRICES` objekat
- [ ] Dodaj fallback u `getPrice()` funkciju za fuzzy matching naziva
- [ ] NE brišti stare modele iz PRICES (istorijske računice ih koriste)

### 2.3 `src/index.js` — Handling

Za OpenAI modele:
- [ ] `handleOpenAI` šalje `max_completion_tokens` (ne `max_tokens`)
- [ ] `handleOpenAIStream` čita `chunk.usage.prompt_tokens` i `chunk.usage.completion_tokens`
- [ ] `handleOpenAIStream` čita `chunk.usage.completion_tokens_details.reasoning_tokens`
- [ ] Fallback estimacija postoji kad stream ne vrati usage

Za Anthropic modele:
- [ ] `handleAnthropic` koristi `max_tokens` (Anthropic API)
- [ ] `handleAnthropicStream` čita `event.message.usage` i `event.usage`
- [ ] Tool calls se konvertuju iz Anthropic formata u OpenAI format

### 2.4 `src/index.js` — Admin overview

- [ ] `modelToProvider` mapiranje: dodaj novi backendModel -> provider

---

## 3. FRONTEND (sve stranice)

### 3.1 `public/index.html` (landing)
- [ ] Ticker tekst: ažuriraj broj modela
- [ ] Tiers sekcija: dodaj karticu za novi model
- [ ] Primeri sekcija: dodaj primer korišćenja
- [ ] Responsive CSS: proveri grid za novi broj kolona

### 3.2 `public/dashboard.html`
- [ ] `MODELS` niz u JS-u: dodaj novi model sa `per15` brojem zahteva
- [ ] Model grid renderovanje: proveri da radi
- [ ] Setup tab (VS Code + Cline): dodaj copy-box za novi model ID
- [ ] Setup tab (Cursor): dodaj copy-box za novi model ID

### 3.3 `public/setup.html`
- [ ] `modelInfo` objekat: dodaj naziv i opis novog modela

### 3.4 `public/admin.html` (ako ima model-specifičan UI)
- [ ] Proveri da admin overview prikazuje nove modele ispravno

---

## 4. TESTIRANJE (obavezno za svaki model)

### 4.1 Basic test — da li radi?
```bash
curl -s https://vajbagent.com/v1/models | python3 -c "import sys,json; [print(m['id']) for m in json.load(sys.stdin)['data']]"
```
- [ ] Novi model se pojavljuje u listi

### 4.2 Non-stream test
```bash
curl -s https://vajbagent.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer STUDENT_KEY" \
  -d '{"model":"vajb-agent-NAZIV","messages":[{"role":"user","content":"Reci samo: OK"}],"max_tokens":10}'
```
- [ ] Vraća odgovor (ne grešku)
- [ ] `usage.prompt_tokens` > 0
- [ ] `usage.completion_tokens` > 0

### 4.3 Stream test
```bash
curl -sN https://vajbagent.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer STUDENT_KEY" \
  -d '{"model":"vajb-agent-NAZIV","messages":[{"role":"user","content":"Napiši 3 rečenice."}],"max_tokens":200,"stream":true}'
```
- [ ] Stream radi (dolaze chunkovi `data: {...}`)
- [ ] Na kraju dolazi `data: [DONE]`
- [ ] Usage se pravilno računa (balans se smanjio)

### 4.4 Tool calling test
```bash
curl -s https://vajbagent.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer STUDENT_KEY" \
  -d '{"model":"vajb-agent-NAZIV","messages":[{"role":"user","content":"Koliko je 15+27?"}],"max_tokens":200,"tools":[{"type":"function","function":{"name":"calculator","parameters":{"type":"object","properties":{"expression":{"type":"string"}}}}}]}'
```
- [ ] Model vraća `tool_calls` u odgovoru (ili ga koristi)
- [ ] `finish_reason` je `tool_calls` ili `stop`

### 4.5 Vision test (ako model podržava slike)
```bash
curl -s https://vajbagent.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer STUDENT_KEY" \
  -d '{"model":"vajb-agent-NAZIV","messages":[{"role":"user","content":[{"type":"text","text":"Šta vidiš?"},{"type":"image_url","image_url":{"url":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/320px-Camponotus_flavomarginatus_ant.jpg"}}]}],"max_tokens":200}'
```
- [ ] Model opisuje sliku (ne vraća grešku)

### 4.6 Naplata test
- [ ] Pre zahteva: zapiši balance
- [ ] Pošalji zahtev
- [ ] Posle zahteva: proveri da se balance smanjio
- [ ] Iznos odbitka odgovara modelu (cena × tokeni × markup)

### 4.7 Error handling
- [ ] Šta se dešava kad model ne postoji? → Jasan error sa listom modela
- [ ] Šta se dešava kad nema kredita? → 402 error
- [ ] Šta kad je kontekst prevelik? → Error poruka (ne crash)
- [ ] Šta kad je API rate limited? → 429 sa retry

---

## 5. DEPLOY I VERIFIKACIJA

- [ ] `git add -A && git commit && git push`
- [ ] Sačekaj Render deploy (1-5 min)
- [ ] Proveri `/v1/models` endpoint
- [ ] Proveri `/health` endpoint
- [ ] Proveri admin overview (`/admin/api/overview`)
- [ ] Otvori landing page — proveri da se modeli prikazuju
- [ ] Otvori dashboard — proveri model grid i setup tabove
- [ ] Pošalji test zahtev sa svakim novim modelom

---

## QUICK REFERENCE: Trenutni modeli (mart 2026)

| VajbAgent ID | Backend model | Provider | Cena in/out $/M | Max output | Vision | Tools | Reasoning |
|---|---|---|---|---|---|---|---|
| vajb-agent-lite | gpt-5-mini | OpenAI | $0.25 / $2.00 | 16K | Da | Da | Da (default medium) |
| vajb-agent-turbo | o4-mini | OpenAI | $1.10 / $4.40 | 100K | Da | Da | Da (low/med/high) |
| vajb-agent-pro | gpt-5 | OpenAI | $1.25 / $10.00 | 65K | Da | Da | Da (default medium) |
| vajb-agent-max | claude-sonnet-4-6 | Anthropic | $3.00 / $15.00 | 65K | Da | Da | Ne |
| vajb-agent-power | gpt-5.4 | OpenAI | $2.50 / $15.00 | 65K | Da | Da | Da (default medium) |
| vajb-agent-ultra | claude-opus-4-6 | Anthropic | $15.00 / $75.00 | 131K | Da | Da | Ne |
| vajb-agent-architect | claude-opus-4-6 | Anthropic | $15.00 / $75.00 | 131K | Da | Da | Ne |

### Napomene
- GPT-5.4 context window: 1,050,000 tokena
- GPT-5/GPT-5 mini context window: 400,000 tokena
- o4-mini context window: 200,000 tokena
- Claude Sonnet/Opus context window: 200,000 tokena
- Reasoning tokeni se kod OpenAI broje kao output i naplaćuju po output ceni
- `max_completion_tokens` za sve OpenAI modele (deprecated: `max_tokens`)
- `max_tokens` za sve Anthropic modele
- Stream usage: OpenAI sa `stream_options: { include_usage: true }`, Anthropic sa `message_delta` event

# Dodavanje i izmena modela

## Pregled arhitekture

Sistem koristi dva provajdera: **OpenAI** i **Anthropic**. Svaki VajbAgent model je wrapper oko jednog backend modela. Routing se vrši automatski na osnovu `backend` polja.

Kad se doda novi model, potrebno je ažurirati **4 fajla** (5 mesta ukupno).

---

## Korak po korak

### 1. Model registry — `src/index.js`

**`VAJB_MODELS` niz** (~linija 42) — dodaj novi objekat:

```js
{ id: 'vajb-agent-flash', name: 'VajbAgent Flash', backend: 'google', backendModel: 'gemini-2.5-flash', desc: 'Brz i jeftin Gemini model' },
```

Polja:
- `id` — ono što korisnik bira u Cursoru (mora biti unikatan)
- `name` — prikazano ime
- `backend` — `'openai'`, `'anthropic'`, ili novi (npr. `'google'`)
- `backendModel` — tačan model ID kod provajdera
- `desc` — kratak opis

**`MAX_OUTPUT` objekat** (~linija 34) — dodaj max output tokene:

```js
'gemini-2.5-flash': 65536,
```

> Ova vrednost ograničava `max_tokens` koji se šalje provajderu. Proveri dokumentaciju provajdera za tačan limit.

### 2. Cenovnik — `src/balance.js`

**`PRICES` objekat** (~linija 116) — dodaj cenu po milion tokena:

```js
'gemini-2.5-flash': { in: 0.15, out: 0.60 },
```

> **KRITIČNO: NIKAD ne upisuj cene iz memorije — one se često menjaju!**
> Pre dodavanja, OBAVEZNO idi na zvaničnu pricing stranicu provajdera i proveri aktuelne cene:
> - OpenAI: https://openai.com/api/pricing/
> - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
> - Google Gemini: https://ai.google.dev/pricing
>
> Cene su u USD po **milion tokena** (input/output). Ako model nije u listi, koristi se `DEFAULT_PRICE` ($3/$15) što je skupo i netačno — uvek dodaj eksplicitnu cenu sa zvaničnog sajta.

**Opciono:** ako model ima sličan pattern u imenu, dodaj fallback u `getPrice()` funkciju (~linija 131):

```js
if (m.includes('gemini')) return PRICES['gemini-2.5-flash'];
```

### 3. Token limiti — `src/convert.js`

**`MODEL_INPUT_LIMITS` objekat** (~linija 39) — dodaj input token limit:

```js
'gemini-2.5-flash': { tokens: 800000, chars: 3200000 },
```

> `chars` je otprilike `tokens × 4`. Ovo kontroliše koliko konteksta trimming algoritam propušta. Ako model nije u listi, koristi se `DEFAULT_LIMIT` (100K tokena). Za modele sa velikim kontekstom (Gemini ima 1M+), ne stavljaj pun limit — ostavi prostor za output i drži razuman budžet.

### 4. Backend handler — `src/index.js`

Za **postojeće provajdere** (OpenAI/Anthropic) — ništa ne treba. Routing je automatski.

Za **novi provajder** (npr. Google Gemini):

1. Instaliraj SDK:
   ```bash
   npm install @google/generative-ai
   ```

2. Dodaj klijent (~posle postojećih klijenata, linija ~60):
   ```js
   import { GoogleGenerativeAI } from '@google/generative-ai';
   const gemini = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
   ```

3. Dodaj granu u `chatCompletionsHandler` (~linija 434):
   ```js
   if (resolved.backend === 'openai') {
     await handleOpenAI(...);
   } else if (resolved.backend === 'google') {
     await handleGoogle(req, res, keyId, resolved, messages, openAITools, stream, max_tokens);
   } else {
     await handleAnthropic(...);
   }
   ```

4. Napiši `handleGoogle()` funkciju. Ključne stvari:
   - Pozovi `trimOpenAIMessages(messages, resolved.backendModel)` za trimming
   - Konvertuj OpenAI format poruka u Gemini format
   - Obradi stream i non-stream varijante
   - Izvuci `input_tokens` i `output_tokens` iz response-a
   - Pozovi `costUsd()`, `deductBalance()`, `logUsage()` na kraju
   - Ako Gemini podržava tools, konvertuj OpenAI tools format u Gemini format

5. Dodaj env varijablu u `.env.example`:
   ```
   # Google Gemini API key
   # GOOGLE_API_KEY=...
   ```

---

## Checklist za novi model

```
[ ] src/index.js     → VAJB_MODELS niz (id, name, backend, backendModel, desc)
[ ] src/index.js     → MAX_OUTPUT objekat (max output tokena)
[ ] src/balance.js   → PRICES objekat (cena po milion tokena: in/out)
[ ] src/convert.js   → MODEL_INPUT_LIMITS (input token/char limit)
[ ] Novi provajder?   → handler funkcija + SDK + env varijabla
[ ] .env.example     → API ključ za novi provajder (ako je novi)
[ ] Landing page     → Ažuriraj tabelu nivoa ako se menjaju tierovi
```

---

## Trimming — kako radi

Trimming je generički i radi za sve modele. Ne treba pisati ništa specifično po modelu.

Algoritam (u `convert.js`):
1. System prompt se čuva (max 8K karaktera)
2. Poslednje 2 poruke se čuvaju u punoj dužini
3. Starije poruke: tool rezultati se skraćuju (max 10K), tekst se reže
4. Ako je i dalje preveliko, brišu se najstarije poruke
5. Budget se računa iz `MODEL_INPUT_LIMITS[backendModel]`

Za Anthropic modele, `openAIToAnthropicMessages()` automatski konvertuje format poruka (tool_calls, system prompt, itd.).

Za novi provajder, koristi `trimOpenAIMessages()` za trimming, pa konvertuj rezultat u format tog provajdera.

---

## Konverzija formata poruka

Cursor šalje poruke u **OpenAI formatu**. Za Anthropic, `convert.js` automatski konvertuje:
- System poruke → `system` parametar
- Tool calls → Anthropic `tool_use` / `tool_result` blokovi
- Content array → Anthropic content format

Za Gemini, treba napisati sličnu konverziju (`openAIToGeminiMessages`). Ključne razlike:
- Gemini koristi `parts` umesto `content`
- Role `assistant` → `model`
- Tool calls imaju drugačiju strukturu (`functionCall` / `functionResponse`)

---

## Primer: dodavanje Gemini 2.5 Flash

Minimalne izmene za postojeći provajder (3 linije):

```js
// src/index.js — VAJB_MODELS
{ id: 'vajb-agent-flash', name: 'VajbAgent Flash', backend: 'google', backendModel: 'gemini-2.5-flash', desc: 'Ultra brz, za jednostavne taskove' },

// src/index.js — MAX_OUTPUT
'gemini-2.5-flash': 65536,

// src/balance.js — PRICES
'gemini-2.5-flash': { in: 0.15, out: 0.60 },

// src/convert.js — MODEL_INPUT_LIMITS
'gemini-2.5-flash': { tokens: 800000, chars: 3200000 },
```

Plus: handler funkcija `handleGoogle()` (~100-150 linija) i SDK instalacija.

---

## VajbAgent VS Code Extension — sinhronizacija modela

Extension koristi isti backend i iste model ID-ove. Kad dodas novi model na backend, treba ga dodati i u extension na **2 mesta**:

### 1. Settings — `vajbagent-vscode/src/settings.ts`

**`MODEL_INFO` niz** — dodaj novi objekat:

```ts
{ id: 'vajb-agent-flash', label: 'Flash', description: 'Ultra brz, za jednostavne taskove' },
```

Polja:
- `id` — MORA biti identican `id`-u iz backend-a (`VAJB_MODELS`)
- `label` — kratko ime koje se prikazuje u dropdown-u (npr. "Flash", "Lite", "Pro")
- `description` — kratak opis za korisnika

### 2. Token limiti — `vajbagent-vscode/src/agent.ts`

**`_getContextLimit()` metoda** — dodaj limit za novi model:

```ts
'vajb-agent-flash': 1000000,
```

Ova vrednost kontrolise context progress bar u UI-ju. Trebalo bi da odgovara ukupnom input limitu modela (vidi `MODEL_INPUT_LIMITS` u `src/convert.js` na backendu).

### 3. `package.json` — enum lista

**`vajbagent.model` enum** — dodaj novi model ID u listu:

```json
"enum": ["vajb-agent-lite", "vajb-agent-turbo", "vajb-agent-pro", "vajb-agent-max", "vajb-agent-power", "vajb-agent-ultra", "vajb-agent-architect", "vajb-agent-flash"]
```

### Extension checklist za novi model

```
[ ] vajbagent-vscode/src/settings.ts   → MODEL_INFO niz (id, label, description)
[ ] vajbagent-vscode/src/agent.ts      → _getContextLimit() (token limit)
[ ] vajbagent-vscode/package.json      → vajbagent.model enum lista
[ ] Rebuild: cd vajbagent-vscode && npx tsc && npx vsce package --no-dependencies --allow-missing-repository
```

> **Napomena:** Extension NE treba handler za novi provajder — to je sve na backendu. Extension samo salje model ID, a backend rutira na pravi provajder.

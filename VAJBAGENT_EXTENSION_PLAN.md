# VajbAgent VSCode Extension — Implementacioni plan

## Zasto ovo radimo

Cline (v3.71) salje ~10,500 tokena system prompta na SVAKI zahtev — pravila ponasanja, capabilities, Act/Plan mode, MCP instrukcije, itd. Cak i sa native tool calling (od v3.35) overhead je ogroman. To pojede 40-48% studentskog budzeta.

Nasi modeli (GPT-5 serija, Claude) vec imaju native tool calling — ne treba im Cline-ov prompt. Nas extension koristi native `tools` JSON parametar: ~800-1000 tokena overhead umesto 10,500.

**Rezultat: studenti dobijaju 55-75% vise zahteva za isti novac.**

| Model | Sa Cline v3.35 | Sa nasim extension-om |
|---|---|---|
| Lite (GPT-5 mini) | 1,708 req / 57h | **2,651 req / 88h** |
| Turbo (o4-mini) | 468 req / 16h | **820 req / 27h** |
| Pro (GPT-5) | 341 req / 11h | **530 req / 18h** |
| Max (Claude Sonnet) | 163 req / 5h | **275 req / 9h** |
| Power (GPT-5.4) | 186 req / 6h | **305 req / 10h** |

---

## Arhitektura

```
Student u VS Code
  → VajbAgent extension (nas, ~800 tokena overhead)
    → vajbagent.onrender.com (nas proxy, vec postoji)
      → OpenAI / Anthropic API
```

Extension salje OpenAI-kompatibilne zahteve na proxy. Proxy vec hendla sve: routing ka OpenAI/Anthropic, format konverziju, billing, streaming, vision.

---

## Komponente

### 1. Extension scaffolding
- TypeScript projekat
- `package.json` sa `contributes`: viewsContainer, views, commands, configuration
- Aktivacija na sidebar ikonu "VajbAgent"
- `vscode.window.registerWebviewViewProvider` za chat panel

### 2. Chat WebView UI (HTML/CSS/JS)
- Sidebar panel sa tamnom temom (match VSCode)
- Input polje: Shift+Enter novi red, Enter slanje
- Poruke: user (desno), assistant (levo), tool calls (kolapsibilni blokovi)
- **Markdown renderovanje** sa `marked` + `highlight.js` za syntax highlighting
- **Image handling**: paste (Ctrl+V), drag-and-drop, dugme za file picker
- Image preview pre slanja (thumbnail)
- Model selector dropdown u headeru
- "Nova sesija" dugme
- Streaming tekst (typewriter efekat)
- Auto-scroll sa smart detection

### 3. Agent Loop (`src/agent.ts`)
- Salje poruke na proxy sa `tools` JSON parametrom (native function calling)
- Parsira streaming SSE response
- Kad model vrati `tool_calls`: izvrsi svaki tool, vrati rezultat, posalji ponovo
- Loop se zavrsava kad model vrati tekst bez tool_calls
- Conversation history: cuva poruke, tool results, slike
- **System prompt**: ~500 tokena, inject na pocetak
- **Max iterations** safety: 25 tool calls max po zahtevu

### 4. Tools (6 tools, native JSON schema)

**read_file** — Cita fajl, vraca sadrzaj sa line numbers
- params: `path` (string), `start_line` (optional int), `end_line` (optional int)

**write_file** — Pravi ili prepisuje fajl sa diff pregledom
- params: `path` (string), `content` (string)
- Pre pisanja: otvori diff u VSCode editoru, cekaj user approve/reject

**replace_in_file** — Zameni deo fajla
- params: `path` (string), `old_text` (string), `new_text` (string)
- Prikaz diff-a pre primene

**list_files** — Lista fajlove/foldere rekurzivno
- params: `path` (string), `recursive` (bool, default true)
- Postuje `.gitignore`, ignorise `node_modules`

**search_files** — Regex pretraga kroz fajlove
- params: `path` (string), `pattern` (string), `file_glob` (optional string)

**execute_command** — Pokrece terminal komandu
- params: `command` (string)
- `child_process.exec` sa 30s timeout
- Vraca stdout + stderr

### 5. Vision / slike
- Paste (Ctrl+V), drag-and-drop, file picker dugme
- Konverzija u base64
- Slanje kao OpenAI vision format: `{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }`
- Proxy vec prosledjuje ovo modelima as-is

### 6. Diff preview za file operacije
- `write_file` i `replace_in_file` koriste `vscode.diff` komandu
- Levo (staro) / desno (novo) u editoru
- Accept: primeni. Reject: tool vraca "User rejected change"
- Koristimo `vscode.window.showInformationMessage` sa Accept/Reject dugmadima

### 7. Settings
- `vajbagent.apiKey`: string (VSCode secret storage)
- `vajbagent.apiUrl`: string, default `https://vajbagent.onrender.com`
- `vajbagent.model`: enum sa 7 modela
- Onboarding: ako nema API key, prikazi poruku sa linkom na dashboard

### 8. Conversation management
- Nova sesija: brise history
- `@file` mention: student napise `@src/index.js`, extension cita i dodaje u kontekst
- Auto-detect: na start cita `package.json`, `CONTEXT.md` ako postoji

---

## Procena velicine koda

| Fajl | Opis | ~Linije |
|---|---|---|
| `src/extension.ts` | Entry point, registracija providera | ~80 |
| `src/agent.ts` | Agent loop, streaming, API calls | ~350 |
| `src/tools.ts` | 6 tool handlers | ~300 |
| `src/webview.ts` | WebView provider, message handling | ~150 |
| `media/chat.html` | Chat UI (HTML/CSS/JS) | ~500 |
| `src/diff.ts` | Diff preview logic | ~100 |
| `src/settings.ts` | Configuration handling | ~50 |
| **Ukupno** | | **~1,500-1,800** |

---

## Postojeci proxy (NE DIRATI)

Proxy vec postoji i radi na `https://vajbagent.onrender.com`.
Source code: `/Users/nemanjalakic/Documents/TokeniStudenti/src/index.js`

**API format**: OpenAI-kompatibilan
- `POST /v1/chat/completions` — chat sa streaming
- `GET /v1/models` — lista modela
- Auth: `Authorization: Bearer STUDENT_API_KEY`
- Streaming: SSE sa `stream: true`, usage u poslednjem chunku
- Tools: proxy prosledjuje `tools` parametar as-is (konvertuje za Anthropic)
- Vision: proxy prosledjuje `image_url` content as-is

**7 modela** (extension salje kao `model` field):
- `vajb-agent-lite` — GPT-5 Mini ($0.25/$2.00 per M tokena)
- `vajb-agent-turbo` — o4-mini ($1.10/$4.40 per M)
- `vajb-agent-pro` — GPT-5 ($1.25/$10.00 per M)
- `vajb-agent-max` — Claude Sonnet 4.6 ($3.00/$15.00 per M)
- `vajb-agent-power` — GPT-5.4 ($2.50/$15.00 per M)
- `vajb-agent-ultra` — Claude Opus 4.6 ($15.00/$75.00 per M)
- `vajb-agent-architect` — Claude Opus + architect prompt ($15.00/$75.00 per M)

---

## Gde se extension pravi

Novi folder, van TokeniStudenti repozitorijuma:
`/Users/nemanjalakic/Documents/vajbagent-vscode/`

---

## Redosled implementacije

1. Scaffold + extension entry point + settings
2. WebView chat panel (UI bez funkcionalnosti)
3. Agent loop + streaming + API connection
4. Core tools (read_file, list_files, search_files)
5. write_file + replace_in_file + diff preview
6. execute_command
7. Vision (image paste/drop/picker)
8. Markdown renderovanje + syntax highlight
9. @file context + conversation management
10. Test sa svim 7 modela + .vsix pakovanje

---

## Publish na Marketplace

1. Lokalno testiranje: F5 u VSCode otvara Extension Development Host
2. Pakovanje: `vsce package` -> `vajbagent-X.X.X.vsix`
3. Rucna instalacija: `code --install-extension vajbagent-X.X.X.vsix`
4. Marketplace: `vsce publish` (besplatno, treba Azure DevOps nalog)

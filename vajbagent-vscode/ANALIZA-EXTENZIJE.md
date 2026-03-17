# Iskrena analiza VajbAgent VS Code ekstenzije

Analiza je urađena na osnovu stvarnog koda (package.json, extension.ts, agent.ts, tools.ts, mcp.ts, settings.ts, webview.ts, chat.html). Nema nagađanja — sve navedeno proizlazi iz implementacije.

---

## 1. Šta ekstenzija IMA (pregled parametara i mogućnosti)

### Konfiguracija (package.json → configuration)
- **vajbagent.apiUrl** — URL API-ja (default: https://vajbagent.com)
- **vajbagent.model** — 7 modela: lite, turbo, pro, max, power, ultra, architect
- **vajbagent.autoApprove.writeFile** — auto-odobravanje pisanja fajlova
- **vajbagent.autoApprove.replaceInFile** — auto-odobravanje replace_in_file
- **vajbagent.autoApprove.executeCommand** — auto-odobravanje komandi

Nema: custom system prompt, custom temperature, max_tokens, timeout, proxy, offline mode, multi-workspace specifične opcije.

### Komande
- New Session, Set API Key, Stop Generation
- Explain Selection, Refactor Selection (kontekstni meni)
- Revert All (vrati sve promene)

### Alati (tools) koje agent koristi
- read_file, write_file, replace_in_file
- list_files, search_files
- execute_command (sa dedikovanim terminalom, background server detekcija)
- fetch_url, web_search
- MCP alati (dinamički iz .vajbagent/mcp.json)

### Kontekst koji se ubacuje u svaki zahtev (agent.ts → _buildMessages)
- **System prompt**: veliki fiksni SYSTEM_PROMPT (pravila, komunikacija, tool usage, security, itd.)
- **Auto-context**: package.json name/description/dependencies (ako postoji)
- **project_memory**: .vajbagent/CONTEXT.md (do 10k znakova)
- **custom_instructions**: .vajbagentrules ili .vajbagent/rules.md (do 8k znakova, linije koje počinju sa # se ignorišu)
- **workspace_index**: stablo fajlova + prvih ~8 linija po fajlu (do 300 fajlova, 5k znakova), TTL 2 min
- **active_editor**: trenutni fajl, jezik, broj linija, cursor, selektovani tekst, vidljive linije (do 60)
- **diagnostics**: greške i upozorenja iz VS Code
- **git_status**: branch, uncommitted, last 3 commita
- **editor_state**: otvoreni tabovi + detektovan project stack (Next, React, Vite, Prisma, itd.)
- **terminal_output**: output poslednje execute_command (do 3k znakova)

### Prompts
- Jedan veliki system prompt (agent.ts). Nema izbor “persona” ili “mode” u UI osim Plan Mode (checkbox u chatu).
- Slash komande (/test, /fix, /doc, /commit, /explain, /refactor) samo zamjenjuju tekst poruke u frontendu; backend ne zna da je to “slash komanda”.
- Plan Mode: kada je uključen, poruka se prefiksuje sa [PLAN MODE] + uputstvo da agent napiše plan u .vajbagent/PLAN.md i prikaže faze. Faze se parsiraju u chat.html i prikazuju dugmad “Faza 1 ▶”, “Nastavi → Faza 2”, itd.

### @ sistem
- **@fajl**: regex `@([\w./-]+)` u agent.ts (_expandFileMentions) — ako putanja postoji kao fajl, zamenjuje se sadržajem fajla (do 5k znakova); ako je folder, listom stavki (do 50).
- **@folder/**: podržano kroz isti mehanizam (folder → listing).
- **@terminal**: kada korisnik napiše `@terminal`, zamenjuje se blokom iz getLastCommandOutput() (do 5k znakova). Terminal output se **uvek** ubacuje i u system prompt preko `<terminal_output>` — agent ga vidi i bez @terminal; @terminal eksplicitno ubaci output u telo poruke.

### Attach fajlova
- File picker (attachFile): PDF (pdftotext), slike (base64 u poruku), ostali tekstualni fajlovi (do 15k znakova). Slike idu kao image_url u content; tekst/PDF kao deo user poruke.

### Checkpoint / Undo
- Pre svake write_file/replace_in_file čuva se original u Map; revert po fajlu ili “vrati sve”. Checkpoint se šalje u webview (checkpointSaved, files). Nema “step-by-step” undo (npr. jedan replace unazad).

### MCP
- Konfiguracija: .vajbagent/mcp.json (ili root objekat ili mcpServers). Serveri: command, args, env, disabled. Stdio transport, JSON-RPC 2.0, initialize + tools/list, tools/call. Alati se eksportuju kao mcp_<serverName>_<toolName>. Restart na promenu mcp.json. Nema UI za dodavanje servera iz ekstenzije — samo “Open MCP settings” otvara fajl.

### Sesije i istorija
- Sesije po workspace-u (hash root putanje), do 50 sesija, u globalState. Load/delete session iz UI. Nema “export chat” ili “share” u kodu.

### UI (chat.html)
- Model selector, API key, apiUrl, auto-approve checkboxes, MCP status, list of sessions, undo/checkpoint list, diff preview za fajlove, command preview za komande, Plan Mode checkbox, slash dropdown, @ file dropdown, attach file, paste/drag slike, follow-up dugmad, plan phase dugmad. Kontekst bar (token usage procenat). Nema: inline edit u editoru (Cursor-style), “Apply to codebase” kao poseban flow, Composer-style multi-file view.

---

## 2. Šta Cursor / Cline (ili slično) obično imaju, a VajbAgent nema ili ima drugačije

### Cursor (IDE / ekosistem)
- **Inline edit u editoru**: Cursor ima “Edit” u editoru (Ctrl+K), gde se izmene primenjuju direktno u fajlu u obliku inline diff / accept/reject. VajbAgent: sve izmene idu preko toolova (write_file/replace_in_file) sa diff preview u **panelu chata**, ne u editoru. Korisnik odobri u panelu, pa se fajl menja — nema “edit ovde u fajlu”.
- **Composer / Agent u posebnom prozoru**: Cursor ima Composer za multi-file, plan-based rad u zasebnom UI. VajbAgent ima Plan Mode u istom chatu (checkbox + faze kao dugmad), što je bliže “jedan chat sa planom” nego zaseban composer prozor.
- **Rules / Instructions**: Cursor ima .cursorrules i možda project/global rules u settings. VajbAgent ima .vajbagentrules (ili .vajbagent/rules.md) i nema globalna pravila u VS Code settings — samo u fajlu u projektu.
- **Model / provider**: Cursor koristi svoje modele ili API. VajbAgent koristi samo svoj backend (vajbagent.com) i svoje nazive modela; nema “OpenAI API key” ili “Anthropic key” direktno u ekstenziji.
- **Terminal**: Cursor integriše terminal u flow. VajbAgent ima dedikovan “VajbAgent” terminal i ubacuje last output u kontekst — konceptualno slično, ali jedan terminal po sesiji/flow.

### Cline (ekstenzija)
- **Podešavanja**: Cline obično ima više opcija za API (base URL, key, model, temperature, max tokens). VajbAgent ima apiUrl + model; nema temperature ili max_tokens u konfiguraciji.
- **System / custom prompt**: Cline često dozvoljava custom system prompt ili “rules” iz fajla. VajbAgent ima fiksni system prompt + .vajbagentrules; nema polje “custom system prompt” u settings.
- **Tool approval**: Obe strane imaju approve/reject za fajlove i komande. VajbAgent ima i auto-approve po tipu (write/replace/command).
- **MCP**: Obe podržavaju MCP. VajbAgent čita samo iz .vajbagent/mcp.json u workspace-u; nema globalnu MCP konfiguraciju u user settings.

### Opšte stvari koje često postoje u “AI coding” alatima, a ovde nisu u kodu
- **Temperature / max_tokens** u UI ili config — nema.
- **“Apply to editor” / inline edit** — nema; sve preko chata.
- **Export chat (Markdown / JSON)** — nema.
- **Global rules** (van projekta) — nema; samo .vajbagentrules u rootu.
- **Više providera / API keys** (OpenAI, Anthropic, lokalni server) — nema; samo jedan API (vajbagent.com).
- **Codebase indexing kao poseban servis** (semantic search, embeddings) — nema; samo workspace_index (file tree + prvih 8 linija) i list_files/read_file/search_files.
- **Slash komande koje backend prepoznaje** — nema; slash se samo pretvara u običan tekst u frontendu.

---

## 3. Predlozi za poboljšanje (konkretno, bez nagađanja)

### Konfiguracija i kontroliši prompta
- Dodati **temperature** i **max_tokens** u `configuration` (package.json) i koristiti ih u request body u agent.ts (_streamRequest). Opciono: “custom system prompt suffix” iz settings (jedan text area) koji se nadovezuje na SYSTEM_PROMPT.
- Ako želiš da backend razlikuje slash komande: slati u poruci metadata npr. `{ type: 'slash', command: 'test', payload: '...' }` umesto samo zamenjenog teksta, i na backendu (ako ga kontrolišeš) prilagoditi ponašanje.

### @terminal
- Urađeno: u _expandFileMentions postoji slučaj za `@terminal` — zamenjuje se blokom iz getLastCommandOutput().

### Inline / editor integracija
- Za “Cursor-like” osećaj: opciono dodati komandu tipa “VajbAgent: Edit selection” koja otvori mali input za instrukciju i onda ili (a) pošalje u chat sa kontekstom “apply change in editor”, ili (b) ako jednog dana imaš “apply edit” API, primeniti diff direktno u editoru (editor.edit). Trenutno sve ide preko chata i diff preview u panelu.

### Plan Mode i PLAN.md
- U system promptu već postoji <plan_execution>. Moguće poboljšanje: kada agent u nekoj poruci eksplicitno referira .vajbagent/PLAN.md (npr. “Evo plana u PLAN.md”), frontend može da parsira taj odgovor i prikaže “Plan ready” bar čak i ako write_file nije poslat u toj iteraciji (npr. plan je već postojao). Trenutno bar se gradi kada agent pošalje write_file na PLAN.md i odgovor sadrži numerisane faze.

### MCP
- U settings dodati opciono “MCP config path” (workspace ili global) da ne mora uvek da bude .vajbagent/mcp.json u rootu. Ili dokumentovati da je samo workspace config podržan.
- Opciono: u UI prikazati listu MCP servera i toolova (već imaš getStatus), npr. u Settings panelu “MCP: 2 servera, 5 alata”.

### Token / kontekst
- Context limit po modelu je u kodu (400K, 200K, 1.05M…). Korisnik ne vidi ove brojeve u settings. Moguće: u context bar ili u Settings prikazati “Max context: X tokens” za izabrani model.
- _trimHistory skraćuje stari tool/assistant odgovore kada se približi limitu; to je dobro. Možda u UI prikazati upozorenje kada je usage npr. >80% (“Razgovor će uskoro biti skraćivan”).

### Export i istorija
- Komanda “Export chat” koja trenutnu sesiju ispiše u Markdown ili JSON na disk (npr. u workspace ili Download) poboljšava pregled i deljenje bez menjanja arhitekture.

### Bezbednost i granice
- execute_command: trenutno se komanda pokreće u workspace root. Nema “allowed commands” / “blocked commands” liste u config. Za strože okruženje moglo bi da se doda whitelist/blacklist ili upozorenje za opasne komande (rm -rf, sudo, itd.).
- Auto-approve za execute_command može biti rizičan; to je već dokumentovano u opisu. Može u UI dodati kratko upozorenje pored checkboxa.

---

## 4. Rezime

- **Jače strane**: bogat system prompt, dobar kontekst (workspace index, editor, git, diagnostics, terminal, project memory, custom rules), Plan Mode sa fazama, MCP, checkpoint/undo, diff i command approval, 7 modela, slash komande u UI, @fajl/@folder ekspanzija.
- **Šta nema u odnosu na tipičan “Cursor/Cline” set**: inline edit u editoru, global/custom system prompt u settings, temperature/max_tokens, export chata, više providera/API-ja, poseban “composer” prozor, backend prepoznavanje slash komandi.
- **Konkretni predlozi**: temperature/max_tokens i opciono “system prompt suffix” u config; opciono “Edit selection” za bliži Cursor osećaj; MCP config path ili bolji prikaz u settings; export chat; (opciono) whitelist/blacklist za execute_command i kratko upozorenje uz auto-approve.

Sve navedeno proizlazi iz analize koda; nema nagađanja o planiranim feature-ima.

---

## 5. Poređenje sa Cursor i Cline + realne ocene

### Tabela: feature po feature

| Oblast | Cursor | Cline | VajbAgent |
|--------|--------|-------|----------|
| Chat + streaming | Da | Da | Da |
| Edit fajlova (write/replace) | Da (inline u editoru) | Da (preko chata) | Da (preko chata, diff u panelu) |
| Inline edit u editoru (Ctrl+K) | Da | Delimično | Ne |
| Odobravanje pre izvršavanja (diff/command) | Da | Da | Da + auto-approve po tipu |
| Plan / faze / multi-step | Composer, poseban UI | Različito | Plan Mode u chatu, faze kao dugmad |
| @fajl / @folder | Da | Da | Da |
| @terminal | N/A (integrisan) | Različito | Da (ekspanzija + uvek u kontekstu) |
| Slash komande | Da, backend zna | Da | Da u UI, backend ne zna tip |
| Pravila (project/global) | .cursorrules, settings | Fajl + često settings | .vajbagentrules, samo projekt |
| MCP | Da | Da | Da (.vajbagent/mcp.json) |
| Temperature / max_tokens | Zavisi od plana | Često da | Ne |
| Export chata | Da / share | Često | Ne |
| Više providera (OpenAI, Anthropic…) | Ne (svoj ekosistem) | Da | Ne (samo vajbagent.com) |
| Checkpoint / undo | Različito | Različito | Da (po fajlu ili sve) |
| Kontekst (workspace, editor, git, diag) | Jak | Jak | Jak (workspace index, editor, git, diag, terminal, CONTEXT.md) |
| Prikaz max konteksta (npr. 400K) | Različito | Različito | Da (context bar) |

### Realne ocene (1–10)

- **Cursor (ceo IDE)**: 9–10 — referenca za "sve u jednom", inline edit, Composer, jako dobar kontekst. Minus: zatvoren ekosistem, cena.
- **Cline (ekstenzija)**: 8–9 — otvoren, često više providera, temperature/max_tokens, export. Zavisi od verzije i konfiguracije.
- **VajbAgent (ekstenzija)**: **7,5–8** — jako dobar za "chat + alati + plan + kontekst" u okviru jednog API-ja. Jače strane: bogat kontekst, Plan Mode sa fazama, MCP, checkpoint/undo, tool call streaming, @terminal, 7 modela, auto-approve. Slabije: nema inline edit u editoru, nema temperature/max_tokens, nema export chata, slash komande backend ne prepoznaje, samo jedan provider. Za nekoga ko koristi vajbagent.com backend i želi sve u VS Code bez pretplate — realno **8/10**. Da bi bila 9/10: bar jedan od export chata, temperature u config, ili "Edit selection" flow koji primeni izmene iz chata direktno u editoru.

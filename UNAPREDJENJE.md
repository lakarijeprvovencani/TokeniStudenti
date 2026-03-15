# VajbAgent — Plan Unapredjenja

## Trenutna ocena: 7.5/10
## Ciljna ocena: 9/10

---

## FAZA 1 — Lake pobede (1-2 nedelje, moze ODMAH)

Ovo su stvari koje mozemo da implementiramo brzo bez rizika da pokvarimo postojece.

### 1. Custom Instructions (.vajbagentrules)
- **Sta:** Korisnik kreira `.vajbagentrules` fajl u root projekta
- **Kako:** Agent ga ucita i doda na kraj system prompta
- **Zasto:** Svaki projekat je razlicit — "koristi Tailwind", "pnpm ne npm", "TypeScript strict"
- **Tezina:** Easy (2-3 dana)
- **Rizik:** Nikakav — samo cita fajl i dodaje u prompt

### 2. Slash komande (/test, /fix, /doc, /commit)
- **Sta:** Kucas `/test` i agent generise testove za trenutni fajl
- **Kako:** Parse `/command` u input-u, mapiraj na pre-built prompt template
- **Komande:** /test, /fix, /doc, /commit, /explain, /refactor
- **Tezina:** Easy (3-5 dana)
- **Rizik:** Nikakav — dodaje se na postojeci sendMessage flow

### 3. Cost tracking ($ po poruci)
- **Sta:** Prikaz cene svake poruke u chatu, ukupan trosak sesije
- **Kako:** Backend vec zna token usage — surface-ovati u UI
- **Tezina:** Easy (2-3 dana)
- **Rizik:** Nikakav — samo prikaz podataka

### 4. @terminal kontekst
- **Sta:** Agent moze da cita output iz VajbAgent terminala
- **Kako:** Vec imamo `_lastCommandOutput` — expose kao kontekst
- **Tezina:** Easy (1-2 dana)
- **Rizik:** Minimalan

### 5. @folder mention
- **Sta:** @src/components — ucitava listu fajlova i summary iz foldera
- **Kako:** Prosiri postojeci @file mention regex
- **Tezina:** Easy (1-2 dana)
- **Rizik:** Nikakav

---

## FAZA 2 — Srednje teske (2-4 nedelje)

### 6. Multi-provider podrska (Bring Your Own Key)
- **Sta:** Korisnik moze da koristi svoj OpenAI/Anthropic/Ollama API key
- **Kako:** Settings UI za provider/key/endpoint, streaming vec govori OpenAI-compatible
- **Tezina:** Medium (1-2 nedelje)
- **Rizik:** Srednji — mora da radi sa razlicitim API formatima

### 7. Diffovi u pravom editoru (ne u sidebar-u)
- **Sta:** Kad agent edituje fajl, diff se prikazuje inline u editoru
- **Kako:** VS Code TextEditorDecorationType + accept/reject CodeLens
- **Tezina:** Medium (2-3 nedelje)
- **Rizik:** Srednji — kompleksna editor integracija

### 8. Slash komande napredne (/pr, /review, /migrate)
- **Sta:** Generisanje PR opisa, code review, migracije
- **Kako:** Napredni prompt template + vise tool poziva
- **Tezina:** Medium (1 nedelja)
- **Rizik:** Nizak

---

## FAZA 3 — Teske ali game-changing (1-2 meseca)

### 9. Tab Autocomplete (Ghost text)
- **Sta:** Dok korisnik kuca, AI predvidja sledecih 1-50 linija
- **Kako:** VS Code InlineCompletionItemProvider + brz model endpoint
- **Tezina:** Hard (3-6 nedelja)
- **Rizik:** Visok — potpuno nova arhitektura, zahteva brz/jeftin model
- **Napomena:** Ovo je #1 feature koji koriste svi — 50-100x dnevno

### 10. Inline Edit u editoru (Cmd+K)
- **Sta:** Selektuj kod, pritisni precicu, ukucaj instrukciju, vidi diff u editoru
- **Kako:** Custom editor overlay + streaming edit + inline diff
- **Tezina:** Hard (3-5 nedelja)
- **Rizik:** Visok — mora da bude brz i precizan

### 11. Codebase RAG / Embeddings (@codebase)
- **Sta:** Ceo projekat indeksiran u vektorsku bazu, semanticki search
- **Kako:** Embedding model + lokalni vector store (SQLite/FAISS)
- **Tezina:** Hard (4-8 nedelja)
- **Rizik:** Visok — infrastruktura, performanse, incremental indexing

### 12. Browser Testing Tool
- **Sta:** Agent otvara browser, testira UI, pravi screenshot
- **Kako:** Playwright/Puppeteer integracija ili MCP server
- **Tezina:** Hard (3-6 nedelja)
- **Rizik:** Srednji ako se radi kao MCP server

---

## Sta VajbAgent vec ima a konkurencija NEMA:

1. **Plan Mode sa phase-by-phase execution** — jedinstven UX
2. **Fallback summary** kad model vrati prazan odgovor
3. **Post-edit diagnostics** — automatska provera gresaka
4. **7 model tiers** na jednoj platformi
5. **Usage guide overlay** sa tutorijalima
6. **Web search + URL fetch** kao built-in tools
7. **Per-file checkpoint/revert** sistem
8. **VajbAgent terminal** za vidljivost komandi

---

## Prioritet implementacije:

```
ODMAH (ova nedelja):
  [1] Custom Instructions    — 2-3 dana, NULA rizika
  [2] Slash komande           — 3-5 dana, NULA rizika
  [3] Cost tracking           — 2-3 dana, NULA rizika
  [4] @terminal kontekst      — 1-2 dana, NULA rizika
  [5] @folder mention          — 1-2 dana, NULA rizika

SLEDECI MESEC:
  [6] Multi-provider           — 1-2 nedelje
  [7] Editor diffovi           — 2-3 nedelje

DUGOROCNO:
  [9]  Tab autocomplete        — 3-6 nedelja
  [10] Inline edit (Cmd+K)     — 3-5 nedelja
  [11] Codebase RAG            — 4-8 nedelja
  [12] Browser testing         — 3-6 nedelja
```

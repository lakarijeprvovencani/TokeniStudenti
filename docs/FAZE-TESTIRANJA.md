# Faze testiranja ekstenzije

Redosled od najlakših do najtežih zadataka. Svaka stavka se mora testirati. Na kraju — izrada cele aplikacije.

---

## FAZA 1 — Osnove (najlakše)

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 1.1 | Registruj se na dashboard, uloguj se, proveri da vidiš kredit i API ključ | Registracija, login, prikaz podataka | ☐ |
| 1.2 | Instaliraj ekstenziju u Cursor/VS Code | Instalacija, aktivacija | ☐ |
| 1.3 | Unesi API ključ u ekstenziju i pošalji jednostavnu poruku: "Reci mi hello" | Povezivanje, osnovni chat | ☐ |
| 1.4 | Proveri da li se u dashboardu prikazuje potrošnja (zahtevi, tokeni) | Sinhronizacija usage-a | ☐ |

---

## FAZA 2 — Čitanje i pretraga

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 2.1 | Otvori projekat sa nekoliko fajlova. Pitaj: "Koja je struktura ovog projekta?" | Workspace index, listanje | ☐ |
| 2.2 | Pitaj: "Šta radi funkcija X u fajlu Y?" (zameni X i Y stvarnim imenima) | read_file, razumevanje koda | ☐ |
| 2.3 | Pitaj: "Gde se koristi useState u ovom projektu?" | search_files | ☐ |
| 2.4 | Koristi @fajl — napiši "@src/App.js objasni ovaj fajl" | @ ekspanzija | ☐ |

---

## FAZA 3 — Izmene fajlova

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 3.1 | Pitaj: "Dodaj console.log na početak funkcije main" | replace_in_file, mali edit | ☐ |
| 3.2 | Pitaj: "Kreiraj fajl utils/helper.js sa funkcijom formatDate" | write_file | ☐ |
| 3.3 | Proveri diff preview — da li vidiš prihvati/odbaci dugmad | Inline diff, approval | ☐ |
| 3.4 | Pitaj da izmeni više fajlova odjednom (npr. dodaj import u 2 fajla) | Multi-file edit | ☐ |

---

## FAZA 4 — Komande i verifikacija

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 4.1 | Pitaj: "Pokreni npm run build" (ili sličnu komandu u projektu) | execute_command | ☐ |
| 4.2 | Proveri da li vidiš command preview sa Run/Reject | Command approval | ☐ |
| 4.3 | Pitaj da instalira paket (npr. lodash) i da ga koristi u kodu | execute_command + edit | ☐ |
| 4.4 | Pitaj: "Pokreni testove" — proveri da agent vidi output i reaguje na greške | Terminal output, error handling | ☐ |

---

## FAZA 5 — Naprednije funkcije

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 5.1 | Koristi Plan Mode — pitaj: "Napravi plan kako da dodam dark mode" | Plan Mode, faze | ☐ |
| 5.2 | Koristi slash komandu: /fix (selektuj kod sa greškom) | Slash komande | ☐ |
| 5.3 | Attach sliku (screenshot ili dijagram) i pitaj nešto o njoj | Vision, attach fajlova | ☐ |
| 5.4 | Pitaj: "Pretraži web za najnoviju verziju React-a" | web_search | ☐ |
| 5.5 | Koristi Revert All — napravi izmenu, pa vrati sve | Checkpoint, undo | ☐ |

---

## FAZA 6 — Sesije i podešavanja

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 6.1 | Napravi novu sesiju (New Session), proveri da je chat prazan | Sesije | ☐ |
| 6.2 | Učitaj staru sesiju iz liste | Istorija, load session | ☐ |
| 6.3 | Promeni model u footeru (npr. sa Lite na Pro) i pošalji poruku | Model selector | ☐ |
| 6.4 | Proveri context bar — da li se prikazuje korišćenje tokena | Token bar | ☐ |

---

## FAZA 7 — Kompleksniji zadaci

| # | Zadatak | Šta proverava | Prošao? |
|---|---------|---------------|---------|
| 7.1 | Pitaj: "Refaktoriši ovu funkciju da koristi async/await" (selektuj kod) | Refactor Selection | ☐ |
| 7.2 | Pitaj: "Dodaj error boundary u React aplikaciju" | Multi-step, novi fajl + izmene | ☐ |
| 7.3 | Pitaj: "Napiši unit test za ovu funkciju" | Test generisanje | ☐ |
| 7.4 | Pitaj da popravi bug — prikaži grešku iz terminala ili diagnostike | Debugging flow | ☐ |

---

## FAZA 8 — Celokupna aplikacija (finalni test)

**Zadatak:** Napravi malu ali kompletnu aplikaciju od nule.

### Specifikacija

- **Tip:** Todo lista ili jednostavan blog / notes app
- **Stack:** React + Vite (ili Next.js ako preferiraš)
- **Zahtevi:**
  - Lista stavki (dodaj, obriši, označi kao završeno)
  - Jednostavan UI (CSS ili Tailwind)
  - Lokalno čuvanje (localStorage) ili mock API
  - Bar jedan komponenta, jedan hook, jedan utility fajl

### Koraci (agent radi, ti daješ instrukcije)

| # | Korak | Prošao? |
|---|-------|---------|
| 8.1 | "Kreiraj novi React + Vite projekat za todo aplikaciju" | ☐ |
| 8.2 | "Dodaj komponentu za unos novog todo-a" | ☐ |
| 8.3 | "Dodaj listu todo stavki sa dugmadima obriši i označi" | ☐ |
| 8.4 | "Poveži sa localStorage da se podaci čuvaju" | ☐ |
| 8.5 | "Dodaj osnovni stil (CSS ili Tailwind)" | ☐ |
| 8.6 | "Pokreni aplikaciju i proveri da sve radi" | ☐ |

### Kriterijumi uspeha

- [ ] Aplikacija se pokreće bez greške
- [ ] Možeš dodati, obrisati i označiti stavke
- [ ] Podaci se čuvaju nakon osvežavanja (localStorage)
- [ ] UI je čitljiv i funkcionalan

---

## Rezime

| Faza | Broj stavki | Težina |
|------|-------------|--------|
| 1 | 4 | ⭐ |
| 2 | 4 | ⭐ |
| 3 | 4 | ⭐⭐ |
| 4 | 4 | ⭐⭐ |
| 5 | 5 | ⭐⭐⭐ |
| 6 | 4 | ⭐⭐ |
| 7 | 4 | ⭐⭐⭐ |
| 8 | 6 | ⭐⭐⭐⭐ |

**Ukupno:** 35 stavki + 1 celokupna aplikacija

---

## Feedback

Za svaku fazu zabeleži:
- Šta je radilo dobro
- Šta nije radilo ili je zbunjujuće
- Predloge za poboljšanje

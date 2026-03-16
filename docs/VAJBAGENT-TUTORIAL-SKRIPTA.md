# VajbAgent — Tutorial / Demo Skripta

Ovo je vodic za snimanje demo videa koji pokazuje sve mogucnosti VajbAgent ekstenzije.
Svaka sekcija je jedan "shot" — moze se snimiti zasebno pa spojiti.

---

## Intro (30 sec)

**Prikazi:** VS Code sa otvorenim projektom i VajbAgent panelom.

**Tekst/naracija:**
> VajbAgent je AI coding asistent napravljen za studente. Radi direktno u VS Code-u, podrzava 7 AI modela, i kosta do 10x manje od konkurencije. Evo sta sve moze.

---

## 1. Razumevanje projekta — bez alata (45 sec)

**Sta radis:** Otvori chat, pitaj:
> Koja je struktura ovog projekta i koje tehnologije koristi?

**Sta pokazujes:**
- Agent odgovara ODMAH bez pozivanja ikakvih alata (0 tool calls)
- Zna strukturu jer automatski indeksira workspace
- Fajlovi u odgovoru su klikabilni — klikni na jedan da se otvori

**Poenta:** Agent vec zna tvoj projekat pre nego sto ga ista pitas.

---

## 2. Kontekst aktivnog editora (30 sec)

**Sta radis:** Otvori fajl, stavi kursor na neku funkciju, pitaj:
> Sta radi ova funkcija?

**Sta pokazujes:**
- Nisi rekao koje fajl ni koja funkcija — agent zna jer vidi tvoj editor
- Daje objasnjenje tacno za kod koji gledas

**Poenta:** Agent prati gde radis u realnom vremenu.

---

## 3. Git kontekst (30 sec)

**Sta radis:** Pitaj:
> Na kom sam branchu i sta sam menjao?

**Sta pokazujes:**
- Agent zna branch, uncommitted changes, poslednje commitove
- Odgovara bez pokretanja git komandi

**Poenta:** Ne moras da izlazis iz editora za git info.

---

## 4. Automatsko prepoznavanje gresaka (45 sec)

**Sta radis:**
1. Namerno ubaci gresku u .ts fajl (obrisi zagradu)
2. Sacuvaj fajl
3. Pitaj: "Imam li neke greske u projektu?"

**Sta pokazujes:**
- Agent vidi greske iz VS Code dijagnostike
- Sam cita fajl, pronalazi problem, i POPRAVLJA ga
- Checkpoint se pojavi — mozes da vratis izmenu

**Poenta:** Agent ne samo da pronalazi greske — sam ih popravlja.

---

## 5. Plan Mode — planiranje pre kodiranja (60 sec)

**Sta radis:**
1. Ukljuci Plan Mode toggle (dole u chatu)
2. Posalji: "Napravi todo aplikaciju sa dodavanjem i brisanjem"

**Sta pokazujes:**
- Agent kreira detaljan plan sa fazama (Faza 1, 2, 3...)
- Pojave se dugmad: "Izvrsi ceo plan", "Faza 1 ▶", "Otkazi"
- Klikni "Faza 1 ▶" — agent radi samo tu fazu
- Posle zavrsetka nudi: "Nastavi → Faza 2" ili "Zaustavi"

**Poenta:** Slozene projekte razbija na korake — ti kontrolises tempo.

---

## 6. Checkpoint i Undo sistem (45 sec)

**Sta radis:** Trazi od agenta da izmeni neki fajl, npr:
> Dodaj komentar na vrh fajla src/utils.js

**Sta pokazujes:**
- Posle izmene pojavi se "Izmenjeni fajlovi (1)" sa listom
- Ime fajla je klikabilno (otvara ga)
- ↩ dugme pored fajla — vraca samo taj fajl
- "Vrati sve" dugme — vraca sve izmene
- "Undo (1)" dugme gore — brz pristup

**Poenta:** Svaka izmena se moze vratiti jednim klikom. Nikad ne gubis kod.

---

## 7. Click-to-apply — kod iz chata u editor (30 sec)

**Sta radis:** Pitaj:
> Napisi helper funkciju za formatiranje datuma

**Sta pokazujes:**
- Kod u odgovoru ima "Primeni" i "Copy" dugmad
- Klikni "Primeni" — kod se ubaci na poziciju kursora u aktivnom editoru

**Poenta:** Ne treba copy-paste. Jedan klik i kod je u fajlu.

---

## 8. Explain i Refactor selekcija (30 sec)

**Sta radis:**
1. Selektuj par linija koda
2. Desni klik → "VajbAgent: Objasni selektovani kod"

**Sta pokazujes:**
- Agent objasni selektovan kod
- Isto radi i "Refaktorisi selekciju" — predlaze poboljsanja

**Poenta:** Selektuj, desni klik, gotovo. Najbrzi nacin za razumevanje tudjeg koda.

---

## 9. Terminal greske — formatiran prikaz (30 sec)

**Sta radis:** Pitaj:
> Pokreni komandu npm run nepostojeca-komanda

**Sta pokazujes:**
- Agent trazi odobrenje pre pokretanja (Pokreni/Odbij)
- Kad komanda propadne — pojavi se formatirana greska
- Narandzasti header, stderr output, exit code

**Poenta:** Greske su citljive i jasne, ne raw terminal output.

---

## 10. Pametni follow-up suggestions (20 sec)

**Sta pokazujes:**
- Posle code izmena: pojave se dugmad "Objasni detaljnije", "Proveri"
- Posle informativnih odgovora: NEMA dugmadi (ne zagadjuje UI)

**Poenta:** Dugmad se pojavljuju samo kad imaju smisla.

---

## 11. Diff preview sa odobrenjem (30 sec)

**Sta pokazujes:** (iz bilo kog prethodnog primera gde agent menja fajl)
- Pre izmene fajla pojavi se diff preview (+/- linije)
- "Prihvati" ili "Odbij" — ti odlucujes
- Auto-approve opcija za brzi workflow

**Poenta:** Nista se ne menja bez tvog odobrenja.

---

## 12. MCP podrska (20 sec)

**Sta radis:** Pokazi Settings → MCP sekcija.

**Sta pokazujes:**
- Moze se povezati sa eksternim alatima preko MCP protokola
- Browser, baze, API-ji — sve dostupno agentu

**Poenta:** Prosiriv je — moze da koristi bilo koji alat koji podrzi MCP.

---

## 13. 7 AI modela — ti biras (20 sec)

**Sta radis:** Pokazi Settings → Model sekcija.

**Sta pokazujes:**
- GPT-4.1 mini, GPT-4.1, GPT-5, Claude Sonnet/Haiku, Gemini Flash/Pro
- Svaki ima svoju cenu i brzinu
- Student bira sta mu odgovara

**Poenta:** Od brzog i jeftinog do mocnog — sve u jednom mestu.

---

## Outro (15 sec)

**Tekst/naracija:**
> VajbAgent — AI asistent koji razume tvoj projekat, pise i menja kod, planira, popravlja greske, i sve to za cenu jednog obroka. Instaliraj ga iz VS Code Marketplace-a ili preuzmi sa GitHub-a.

---

## Tehnicke napomene za snimanje

- **Rezolucija:** Snimi u 1920x1080 minimum
- **Font size:** Uvecaj VS Code font na 16+ za citljivost
- **Tema:** Dark tema (VajbAgent je dizajniran za tamne teme)
- **Branding boja:** #FA7315 (narandzasta) — pojavljuje se u celom UI-ju
- **Tempo:** Pauziraj 1-2 sec posle svakog agentovog odgovora da gledalac procita
- **Muzika:** Lo-fi ili minimalna pozadinska muzika
- **Trajanje:** Ceo video 5-7 minuta idealno

---

*Dokument generisan: Mart 2026*
*Verzija: VajbAgent v0.21.0*

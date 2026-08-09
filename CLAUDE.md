# CLAUDE.md — FlowMind

Projectrichtlijnen voor Claude Code in deze repository. De algemene
configuratie staat in `C:\Users\Tarik\.codex\CLAUDE.md`; dit bestand gaat
alleen over FlowMind.

## Wat is dit project?

**FlowMind** (`nl.polatinos.flowmind`) — een Homey SDK v3 app die een
AI-assistent op de Homey Pro zelf draait. Chat-UI in de app-instellingen;
de AI leest het systeem uit, stuurt apparaten aan, bouwt/bewerkt (advanced)
flows, onthoudt feiten en leest Insights-historie. Twee flow-actionkaarten
(`ai_do`, `ai_ask`) laten flows zelf de AI aanroepen.

- **Repo:** https://github.com/polatinos/flowmind (default branch `main`)
- **Doel:** publicatie in de Homey App Store

## Commands

```bash
npm ci                                  # dependencies (lockfile!)
npx homey app validate --level publish  # ALTIJD draaien vóór commit
npx homey app run --remote              # tijdelijk op de Homey (logs in terminal)
npx homey app install                   # permanent installeren
```

`app run` **zonder** `--remote` draait de app in een Docker-container op deze
machine; zonder draaiende Docker faalt dat. Met `--remote` draait hij op de
Homey zelf — dat is ook eerlijker om te testen. Remote-mode doet **geen
hot-reload**: na elke codewijziging het proces stoppen en opnieuw starten.
Eerste keer: `npx homey select --name "Homey Pro van Tarik"` (de CLI vraagt
anders interactief, wat in een agent-sessie vastloopt).

Er zijn geen unit tests; verifieer met `node --check <file>`, de validate
hierboven, en waar mogelijk een echte API-call (Zen werkt zonder key).

## Architectuur (kort)

```
app.json               Manifest: api-routes, flow-kaarten, permissions
app.js                 App-init, settings, chat-entrypoint, flow-card listeners
api.js                 Web-API handlers (/config, /chat, /memories)
settings/index.html    Chat-UI + instellingen (i18n via data-i18n + Homey.__)
locales/en.json, nl.json  Alle UI-teksten (EN = basis, NL = vertaling)
lib/
  webTerminal.js       LAN-webserver (poort 8737): fullscreen desktop-terminal + eigen page-HTML
  HomeyContext.js      Homey Web API wrapper + ALLE tool-uitvoering + memory/backups
  tools.js             Provider-neutrale tooldefinities (23 tools)
  flowNormalize.js     Leesbare card-keys → UUID's voor advanced flows
  http.js              Dependency-vrije http/https JSON-client
  llm/index.js         Providerkeuze + tool-use loop + memory-injectie in prompt
  llm/{anthropic,openai,gemini}.js  Per provider; openai.js dient ook Zen/compatible
  llm/systemPrompt.js  Systemprompt met exacte flow-structuren
```

## Kritieke lessen (NIET opnieuw ontdekken)

### OpenCode Zen (default provider)
- Base URL `https://opencode.ai/zen/v1`, endpoint `/chat/completions`.
- Model-ID's zijn **kaal**: `big-pickle` — het `opencode/`-prefix uit de docs
  wordt door de API geweigerd ("Model not supported").
- Gratis modellen werken momenteel **zonder API-key** → key is `keyOptional`
  in `PROVIDERS`; niet opnieuw verplicht maken.
- Modellenlijst live checken: `GET https://opencode.ai/zen/v1/models`.

### Providers
- **Anthropic eist strikt alternerende user/assistant-rollen.** anthropic.js
  voegt opeenvolgende gelijke rollen samen — weghalen breekt de chat na één
  mislukte beurt.
- `http.js` ondersteunt bewust ook `http://` (Ollama op LAN). Niet
  "opschonen" naar https-only.
- `homey-api` staat via de lockfile op **3.17.3**; 3.19+ eist Node ≥ 24 en de
  Homey-runtime is ouder. Niet blind updaten.

### Homey App Store
- **"Homey" mag niet in de appnaam** (Athom-richtlijn). Vandaar FlowMind.
- **Het app-ID kan na publicatie nooit meer wijzigen.**
- `homey:manager:api` permissie ⇒ langere review (bekend, geaccepteerd).
- Versie bumpen in **app.json én package.json** (moeten gelijk lopen).

### Flow-kaarten
- Actionkaarten mét `tokens` (zoals `ai_ask`) zijn **alleen zichtbaar in
  Advanced Flows** — daarom bestaat `ai_do` (zonder token) apart.
- Flow-runlisteners hebben een krap tijdsbudget: flow-runs gaan door
  `_runFromFlow()` met `maxSteps: 6` en een `[flow]`-prefix zodat de
  systemprompt bevestigingsvragen overslaat.
- **Autocomplete-argumenten** (bv. `user` van `push_text`): sinds v0.3.1 lost
  de tool `search_flow_card_autocomplete` deze op via
  `api.flow.getFlowCardAutocomplete({ id, type, name, query })`; het gekozen
  resultaat-object gaat integraal als argumentwaarde de kaart in. Zonder deze
  tool koos het model verkeerde kaarten (les uit test 4/5).
- **Push ≠ tijdlijn:** een melding op de telefoon is
  `homey:manager:mobile:push_text`; `notifications:create_notification` is
  alleen de tijdlijn. Staat ook in de systemprompt.
- **Advanced flow handmatig startbaar** ⇒ een `start`-kaart (type `start`),
  niet `programmatic_trigger` — anders "Advanced Flow Is Not triggerable".

### Flows aanmaken kan NIET met het app-token (opgelost in v0.3.0)
- `createFlow` faalt met **"Missing Scopes"**. Lezen van flows en apparaten
  aansturen werkt wél. Dit is een bewuste beperking van Athom, geen bug:
  de scopes die een app (en elke OAuth-client) krijgt kennen alleen
  `homey.flow.readonly` en `homey.flow.start`.
- **Oplossing (gebouwd in v0.3.0):** een optionele "Homey API-sleutel"-setting
  (`homeyApiKey`). De gebruiker maakt de sleutel op de Homey Pro zelf
  (my.homey.app → Instellingen → Systeem → API-sleutels); die kent wél de
  ouder-scope `homey.flow`. Als de sleutel gezet is gebruikt `HomeyContext`
  `HomeyAPI.createLocalAPI({ address, token })` voor álles (adres komt van
  `homey.cloud.getLocalAddress()`); mislukt dat, dan valt hij terug op
  `createAppAPI` zodat chat en apparaatbediening blijven werken
  (`apiMode`: 'local' | 'app'). Bij Missing Scopes in app-modus verrijkt
  `executeTool` de fout met de sleutel-instructie; de systemprompt zegt er
  expliciet bij dat de sleutel de énige route is, zodat het model geen
  workarounds gaat verzinnen.
- Route op 2026-07-21 twee keer onafhankelijk live geverifieerd (connect →
  createFlow → delete slaagde met de sleutel).
- Niet opnieuw proberen op te lossen met permissies in `app.json`: de complete
  lijst kent maar dertien permissies en `homey:manager:api` is de enige
  relevante.
- Minimale scopes nog onbekend — getest met een full-access sleutel.
  Verwachting (nog verifiëren met een smallere sleutel): `homey.flow` +
  `homey.device` + `homey.zone` + `homey.insights` + `homey.mood`.

### Desktop: settings-modal is ~330px → eigen webterminal (v0.5.0)
- my.homey.app toont app-settings op desktop in een vaste smalle modal
  (±330px, cross-origin iframe) — daar is niets aan te doen vanuit de app.
  Op mobiel is dezelfde pagina fullscreen en prima.
- **Oplossing (het Magnus/HA-model, live getest):** de app draait zelf een
  http-server op poort **8737** (`lib/webTerminal.js`, Node `http`, bind
  0.0.0.0 — een Homey-app MAG een LAN-poort openen, bevestigd op de Homey
  Pro 2023). Fullscreen terminal op `http://<homey-ip>:8737/?token=…`.
- Beveiliging: random token (crypto, in settings `webTerminalToken`),
  timingSafeEqual-check, 403 zonder token; token wordt na laden uit de URL
  gepoetst (history.replaceState) en zit daarna in localStorage. Er gaan
  géén API-keys over deze poort — settings blijven in de Homey-modal.
- Live stappen gaan hier via **polling**: `getChatJob` geeft bij `pending`
  ook `steps` terug (gebufferd op de job, cap 100). De settings-pagina
  gebruikt realtime `chatStep`-events; de webpagina kan dat niet.
- Toggle + kant-en-klare link staan in de settings-pagina
  (`webTerminalEnabled`); de pagina-HTML zit als template-string in
  webTerminal.js met eigen embedded EN/NL-strings (buiten de locales om).

### De instellingenpagina kapt requests af na 10 seconden
- Een `Homey.api()`-call vanuit de settings-pagina wordt door de Homey-app na
  ~10s geannuleerd ("Fetch request has been canceled"), terwijl de app gewoon
  doorwerkt. Een AI-beurt duurt 15-60s, dus dat haalt het nooit.
- Daarom is `/chat` een **wachtrij**: hij geeft direct een `jobId` terug en de
  pagina haalt het antwoord op via `GET /chat/:jobId`. Niet terugbouwen naar
  één synchrone request.

### Modellen sturen verkeerde typen mee
- `control_device.value` kan geen vast type hebben (boolean voor onoff, getal
  voor dim, string voor enums), dus modellen sturen `"false"` als tekst en
  Homey weigert dat. `coerceCapabilityValue()` in HomeyContext.js zet het om op
  basis van de echte capability-definitie. Elke nieuwe tool die vrije waarden
  aanneemt heeft dezelfde bescherming nodig.

### Geheugen & opslag (Homey Pro = beperkt)
- Limieten staan als constanten bovenin `HomeyContext.js`:
  `MEMORY_MAX_COUNT` 50 × max 500 tekens; prompt-injectie gebudgetteerd op
  `MEMORY_PROMPT_BUDGET` 4000 tekens (nieuwste eerst, rest via
  `list_memories`). Vol ⇒ `save_memory` geeft een error en het model moet
  eerst consolideren.
- Flow-backups: max 15 stuks én max ~300 KB totaal (`BACKUP_MAX_*`).
- Nieuwe opslag in settings? Altijd een count- én size-cap toevoegen.

### i18n
- Engels is de basistaal; alle UI-strings in `locales/en.json` + `nl.json`
  (keys moeten 1-op-1 gelijk zijn). Statische HTML via `data-i18n`,
  dynamische strings en placeholders via `Homey.__('settings.…')`.
- Geen hardcoded UI-teksten in settings/index.html zetten.

### Advanced flows
- Card-graph: keys mogen leesbaar zijn (`trigger1`); `flowNormalize.js`
  hermapt ze (incl. `input`-referenties `key::output`) naar UUID's.
- Device-card-ID's volgen `homey:device:<deviceId>:<cardId>` — altijd via
  `get_flow`/`list_flow_cards` opzoeken, nooit gokken (staat ook in de
  systemprompt).

### Verifieer tegen de API, niet tegen wat de assistent beweert

Elke testuitkomst is gecontroleerd **tegen de Homey API zelf**. Dat verschil
legde de stekker-bug bloot en had een vals succes ook opgemerkt. Twee lessen
die daaruit volgden:

- **Verzonnen device-UUID's.** Zonder echte ID's in de gesprekscontext verzint
  het model ze — en Homey slaat een advanced flow met onbekende device-kaarten
  gewoon op ("niet beschikbaar"), waarna hij stil niets doet en het model
  "Gedaan" meldt. Sinds v0.5.4 weigert `_assertDeviceCardsExist` onbekende
  device-ids bij elke flow create/update; de prompt eist ID's uit een
  tool-result van dít gesprek en verificatie vóór een succesclaim. De
  gesprekshistorie bevat alléén tekst, geen toolresultaten — dus dit kan in
  productie ook. Overweeg dezelfde bescherming voor andere id-parameters.
- **Capability-status bewijst geen fysieke verandering.** Bij optimistische
  cloud-drivers (getest met Govee, `com.govee.developer`) klapte de
  Homey-status netjes om terwijl de lamp niets deed. Insights liegen dan mee.
  De waarneming van de gebruiker wint altijd.
- Bij een vertraagde actie via een tijdelijke flow: meld expliciet "was 20s
  uit, staat nu weer aan", anders twijfelt de gebruiker.

**Openstaande tests:** 6 (`ai_do`/`ai_ask` flow-kaarten, risico: flow-timeout
bij `maxSteps: 6`), 7 (Insights), 8 (Moods — `moods.setMood` nooit live
getest), `check_flows` zelf, en de minimale API-sleutel-scopes met een smallere
sleutel. De chronologie van wat wél getest is staat in `SESSIONS.md`.

### `run_script` is verwijderd in v0.5.5 — niet terugbouwen
- **Bewezen:** Node's `vm` is géén sandbox. Met exact de context-vorm uit
  `runScript` leverde zowel `homeyApi.constructor.constructor('return
  process')()` als `setTimeout.constructor('return process')()` het echte
  `process`; via `child_process` draaide een shell-commando. Wie de tool kan
  aanroepen heeft dus alles wat het app-proces heeft.
- **Bewezen:** de "10s timeout" deed niets. `Promise.race` kan synchrone code
  niet onderbreken — een busy loop van 3s liep gewoon af terwijl de timer van
  1s nooit vuurde. Een `while(true)` van het model bevriest het hele
  FlowMind-proces (chat, flow-kaarten, webterminal). `vm`'s eigen
  `{ timeout }` dóódt zoiets wél (getest: 1013ms) — maar lost de escape niet
  op, want `vm` is principieel geen beveiligingsgrens.
- Waarom dit zwaarder weegt dan "de toggle staat toch uit": de code wordt
  gekozen door een LLM, en diens invoer bevat strings die de gebruiker niet
  beheert (apparaat- en flownamen uit andere apps → prompt-injectie).
- De use-case die er écht was (vertraagde acties) is sinds v0.5.3 opgelost
  met een tijdelijke flow.

### Webterminal: de comment liegt

`lib/webTerminal.js` zegt "chat only, no secrets over this port". In
werkelijkheid krijgt een token-houder op het LAN volledige huisbediening, álle
memories en flow-beheer — over plain HTTP, met het token in de URL-query. Ga
daar bij elke wijziging aan die server van uit.

**Kwaliteitslat:** het niveau van Magnus' Home Assistant-werk, vóór er over de
App Store wordt nagedacht.

De openstaande security-punten (Host-header-validatie, token uit de query,
rate limiting op `/api/chat`, client-gekozen `provider`/`model` uit
`startChat`, `.homeyignore`) staan met toelichting in `SESSIONS.md`.

## Werkwijze

- Elke wijziging: `npx homey app validate --level publish` moet slagen.
- **Einde sessie: `SESSIONS.md` bijwerken** (chronologisch logboek, nieuwste
  onderaan). Blijvende lessen horen hier in CLAUDE.md, het verloop in
  SESSIONS.md — niet dupliceren, anders lopen ze uit elkaar.
- Nieuwe tool? Drie plekken: `tools.js` (definitie), `HomeyContext.js`
  (implementatie + `executeTool`-case), evt. systemprompt-uitleg.
- Commits in het Engels; lokaal committen mag, **pushen alleen na
  toestemming van Tarik** (zie algemene CLAUDE.md).

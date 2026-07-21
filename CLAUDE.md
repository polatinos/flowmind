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
  `executeTool` de fout met de sleutel-instructie; de systemprompt verbiedt
  expliciet het "Run scripts"-advies als workaround (run_script gebruikt
  hetzelfde token en zou identiek falen).
- Route op 2026-07-21 twee keer onafhankelijk live geverifieerd (connect →
  createFlow → delete slaagde met de sleutel).
- Niet opnieuw proberen op te lossen met permissies in `app.json`: de complete
  lijst kent maar dertien permissies en `homey:manager:api` is de enige
  relevante.
- Minimale scopes nog onbekend — getest met een full-access sleutel.
  Verwachting (nog verifiëren met een smallere sleutel): `homey.flow` +
  `homey.device` + `homey.zone` + `homey.insights` + `homey.mood`.

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

## Test op echte Homey — stand per 2026-07-21 (v0.2.3)

Getest op Tarik's Homey Pro (Early 2023, fw 13.3.0). Elke uitkomst is
gecontroleerd **tegen de Homey API zelf**, niet op wat de assistent beweerde —
dat verschil legde de stekker-bug bloot (hij meldde eerlijk falen) én had een
vals succes ook opgemerkt.

| # | Test | Status |
|---|------|--------|
| 1 | Chat zonder API-key (Zen/big-pickle) | ✅ |
| 2 | Device aansturen (stekker uit én aan) | ✅ |
| 3 | Geheugen over gesprekken heen | ⏳ |
| 4 | Standaard flow maken | ❌ Missing Scopes |
| 5 | Advanced flow maken | ⏳ geblokkeerd door 4 |
| 6 | Flow-kaarten `ai_do` / `ai_ask` | ⏳ risico: flow-timeout, maxSteps 6 |
| 7 | Insights | ⏳ |
| 8 | Moods (`moods.setMood` nooit live getest) | ⏳ |
| 9 | NL-vertaling van de settings-pagina | ✅ |

Gevonden en opgelost tijdens die sessie: de 10s-timeout, het waarde-type bij
`control_device`, twee hardcoded Nederlandse labels, en Markdown die niet
gerenderd werd. Zie de kritieke lessen hierboven.

**Volgende stap (na v0.3.0):** op de Homey de sleutel in de settings-pagina
plakken en test 4 en 5 draaien; daarna de minimale scopes bepalen met een
smallere sleutel.

In v0.3.0 opgelost:
- API-sleutel-setting + lokale API-client met fallback (zie hierboven).
- Het invoerveld groeit nu mee met de tekst (max ~8 regels) en het
  chatvenster is hoger op brede schermen (media query ≥900px).
- Het "Scripts uitvoeren"-advies bij een mislukte flow is vervangen door de
  juiste instructie (API-sleutel instellen), zowel in de systemprompt als in
  de foutmelding van `executeTool`.

Bevindingen/fixes: versie bumpen (app.json + package.json), valideren,
committen; pushen alleen na toestemming.

## Werkwijze

- Elke wijziging: `npx homey app validate --level publish` moet slagen.
- Nieuwe tool? Drie plekken: `tools.js` (definitie), `HomeyContext.js`
  (implementatie + `executeTool`-case), evt. systemprompt-uitleg.
- Commits in het Engels; lokaal committen mag, **pushen alleen na
  toestemming van Tarik** (zie algemene CLAUDE.md).

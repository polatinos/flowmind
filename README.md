# HomeyAI

Een AI-assistent die **op je eigen Homey Pro draait**. Je opent de app-instellingen,
typt in gewone taal een vraag of opdracht, en de AI voert die echt uit op je
Homey: hij leest je systeem uit, stuurt apparaten aan en bouwt flows — inclusief
**Advanced Flows** (de node-based editor).

> Bedoeld voor persoonlijk gebruik op je eigen Homey Pro via `homey app run`.
> Publicatie in de App Store is niet nodig.

## Wat kan het?

1. **Flows maken** — zowel standaard flows als Advanced Flows. De AI gebruikt de
   echte Homey Web API (`createFlow` / `createAdvancedFlow`), met de exacte
   card-structuur die in de Homey Apps SDK v3 / `homey-api` is vastgelegd.
2. **Het hele systeem uitlezen** — alle devices (met capabilities + actuele
   waardes), zones, bestaande flows (standaard én advanced) en moods/scenes.
   Zo weet de AI wat er al is voordat hij iets voorstelt of aanmaakt.
3. **Devices aansturen** — capabilities zoals `onoff`, `dim`,
   `target_temperature`, kleur, volume, enz.
4. **Meerdere LLM's** — kies zelf je AI-provider. **Anthropic (Claude)** en
   **OpenAI (GPT)** worden ondersteund, elk met een eigen API-key in de
   instellingen. Het verschil in function-calling tussen de providers wordt
   intern genormaliseerd, dus dezelfde tools werken bij beide.

## Vereisten

- Een **Homey Pro** (firmware met Advanced Flow API, `>= 8.1.4`).
- [Node.js](https://nodejs.org) en de **Homey CLI** op je computer:
  ```bash
  npm install -g homey
  homey login
  ```
- Een API-key van **Anthropic** (https://console.anthropic.com) en/of
  **OpenAI** (https://platform.openai.com).

## Installeren & draaien

```bash
git clone <deze-repo>
cd Homeyai
npm install
homey app run          # installeert de app tijdelijk op je Homey en toont logs
```

`homey app run` houdt de app draaiend zolang de terminal open staat. Wil je hem
permanent installeren, gebruik dan `homey app install`.

## Gebruiken

1. Open in de Homey-app (of via https://my.homey.app) de app **HomeyAI** →
   **Instellingen**.
2. Klap **Instellingen (AI-provider & API-keys)** open, kies je provider, plak je
   API-key en klik **Opslaan**. Keys worden versleuteld op je Homey opgeslagen en
   nooit teruggestuurd naar de instellingenpagina.
3. Typ in het chatvenster je opdracht, bijvoorbeeld:
   - "Welke lampen staan er nu aan in de woonkamer?"
   - "Zet alle lampen beneden op 30%."
   - "Maak een advanced flow: als de bewegingssensor in de gang beweging ziet
     en het is donker, zet dan het ganglicht 5 minuten aan."

De AI leest eerst je systeem uit, vraagt bij ingrijpende acties om bevestiging,
en laat onder elk antwoord zien welke acties (tools) hij heeft uitgevoerd.

## Architectuur

```
app.json                 App-manifest (SDK v3) + Web API-routes (/config, /chat)
app.js                   App-init, config-opslag (settings), chat-entrypoint
api.js                   Web API-handlers die de instellingenpagina aanroept
settings/index.html      Chat-UI (custom settings-pagina)
lib/
  HomeyContext.js        Wrapt de Homey Web API: uitlezen, aansturen, flows maken
  flowNormalize.js       Zet leesbare card-keys om naar UUID's voor advanced flows
  tools.js               Provider-onafhankelijke tool-definities (JSON Schema)
  http.js                Kleine dependency-vrije HTTPS/JSON-client voor LLM-calls
  llm/
    index.js             Kiest de provider en draait de tool-use loop
    anthropic.js         Anthropic Messages API (tool-use)
    openai.js            OpenAI Chat Completions API (function calling)
    systemPrompt.js      Systeemprompt incl. exacte (advanced) flow-structuren
```

### Hoe de AI tools gebruikt

De tools worden **één keer** neutraal beschreven in `lib/tools.js`
(`{ name, description, input_schema }`). Elke provider vertaalt dat naar zijn
eigen format (Anthropic `tools`, OpenAI `tools[].function`). De uitvoering loopt
altijd via `HomeyContext.executeTool()`, die netjes een JSON-resultaat teruggeeft
(of `{ error }`), zodat het model fouten kan lezen en herstellen.

Beschikbare tools: `get_system_overview`, `list_devices`, `list_zones`,
`list_flows`, `get_flow`, `list_moods`, `control_device`, `activate_mood`,
`start_flow`, `list_flow_cards`, `create_standard_flow`, `create_advanced_flow`.

### Advanced Flows

De structuur van een Advanced Flow is een graaf van "cards" (nodes) met types
`start | trigger | condition | action | delay | all | any | note`, elk met
`x`/`y`-coördinaten en verbindingsarrays (`outputSuccess`, `outputError`,
`outputTrue`, `outputFalse`). Device-cards hebben een id volgens het patroon
`homey:device:<deviceId>:<cardId>`. Om de exacte card-id's te vinden inspecteert
de AI een bestaande, vergelijkbare flow met `get_flow` en kopieert het patroon —
dit is betrouwbaarder dan gokken.

Het model mag leesbare card-keys gebruiken (`trigger1`, `cond1`, …); de app zet
die automatisch om naar geldige UUID's voordat de flow naar Homey gaat.

## Beperkingen (v0.1)

- Dit is een werkende basis voor persoonlijk gebruik. Het genereren van complexe
  Advanced Flows hangt af van hoe goed het gekozen model de exacte card-id's
  ophaalt; begin daarom met eenvoudige opdrachten en breid uit.
- De permissie `homey:manager:api` is nodig zodat de app het volledige systeem
  kan uitlezen en aansturen.

## Claude Code

Deze repository is uitgerust met [Claude Code](https://claude.com/claude-code)
via GitHub Actions (`.github/workflows/`). Noem `@claude` in een issue of
pull-request om Claude in te schakelen; elke PR krijgt automatisch een review.
Vereist eenmalig de [Claude GitHub App](https://github.com/apps/claude) en het
repository-secret `ANTHROPIC_API_KEY`. Zie [`CLAUDE.md`](./CLAUDE.md).

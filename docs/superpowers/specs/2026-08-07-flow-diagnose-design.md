# Flow-diagnose in FlowMind — ontwerp

**Datum:** 2026-08-07
**Status:** goedgekeurd, nog niet geïmplementeerd

## Waarom

Homey meldt niet wanneer een flow stilvalt. De flow blijft bestaan, doet alleen
niets meer. De bestaande community-app Flow Checker (`com.athom.flowchecker`)
leunt op Homey's eigen `broken`-vlag en mist daardoor een hele klasse problemen.

Dat gat is op 2026-08-07 live aangetoond op Tariks Homey. In de flow
"Systeem Herstel" (`d2bcbc5e-da15-4ff2-9af9-65e57c255dd2`) staat een
`homey:manager:apps:restart_app`-kaart met `args.app.id = "com.dyson"`. De Dyson-app
is verwijderd. Homey rapporteert de flow als `"broken": false`, want de kaart
zelf (`restart_app`) bestaat nog — alleen het argument wijst nergens meer heen.

De kaart staat op plek 2 van een ketting van 16 `restart_app`-kaarten die elk via
`outputSuccess` de volgende aanroepen. Zodra kaart 2 faalt, draaien de 14 kaarten
erna nooit meer, inclusief de afsluitende pushmelding. Zichtbaar effect: nul.
Meldingen: nul.

Deze tool vult dat gat en maakt Flow Checker (25 MB) overbodig op een Homey Pro
die structureel tegen zijn geheugengrens zit.

## Scope

Eén nieuwe tool: `check_flows`. **Leest alleen.** Repareren blijft buiten scope —
FlowMind heeft daar al `update_advanced_flow` en `update_standard_flow` voor, mét
automatische backup. Vraagt de gebruiker om een fix, dan gebruikt het model die
bestaande tools.

Bewust **niet** in scope: melden dat een flow uitgeschakeld is. Tarik zet flows
bewust uit; dat als probleem rapporteren levert alleen ruis op.

## De drie checks

### 1. Kaart wijst naar een verdwenen apparaat

Kaart-id's volgen `homey:device:<uuid>:<capability>`. Bestaat die uuid niet meer
in de apparatenlijst, dan is de kaart dood.

Hergebruik de regex en de opzoeklogica uit `_assertDeviceCardsExist`
(`lib/HomeyContext.js`), die dit al doet bij het *schrijven* van flows. Deze tool
past dezelfde controle toe in de leesrichting.

### 2. Kaart wijst naar een verdwenen app

Twee vormen, beide moeten gedekt:

- **`ownerUri`**: `homey:app:<appId>` waar `<appId>` niet geïnstalleerd is.
- **`restart_app`-argument**: kaart-id `homey:manager:apps:restart_app` met
  `args.app.id` die niet geïnstalleerd is. Dit is het Dyson-geval en het
  belangrijkste onderscheid met Flow Checker.

De lijst geïnstalleerde apps komt van `getApps` (`GET /app`) op `ManagerApps`.
Geverifieerd aanwezig in `homey-api` 3.17.3
(`assets/specifications/HomeyAPIV3Local.json`).

### 3. Ketting valt stil

Alleen bij advanced flows. Heeft een kaart met een probleem uit check 1 of 2 een
gevulde `outputSuccess`, dan zijn alle kaarten stroomafwaarts onbereikbaar.

Een kaart geldt pas als onbereikbaar wanneer **elke** route ernaartoe door de
kapotte kaart loopt. Naïef stroomafwaarts tellen geeft valse meldingen: kaarten
hebben vaak meerdere inkomende verbindingen, en een kaart die ook vanaf een
tweede trigger bereikbaar is valt niet stil.

Bepaal het dus in twee stappen:

1. Bereken de kaarten die bereikbaar zijn vanaf alle triggers, met de kapotte
   kaart verwijderd.
2. Onbereikbaar = alles wat wél bereikbaar was mét die kaart, maar niet zonder.

Volg daarbij `outputSuccess`, `outputTrue` en `outputFalse`. Neem `outputError`
expliciet **wel** mee: is die gevuld, dan heeft de gebruiker een vangnet gebouwd
en valt die tak juist níet stil. Bewaak cycli met een bezochte-verzameling —
advanced flows mogen lussen bevatten.

Melding luidt dan: *"kaart 2 van 16 is kapot, waardoor 14 kaarten erna niet meer
draaien"*.

## Uitvoer

Per bevinding: flownaam, flowtype, aan/uit, welke kaart, reden, gevolg.

Compact houden — het resultaat moet ook door een `ai_ask`-flowrun passen.

Maximaal **25 bevindingen** per aanroep, als constante bovenin `HomeyContext.js`
naast de bestaande `MEMORY_MAX_*`- en `BACKUP_MAX_*`-limieten. Wordt die grens
gehaald, dan bevat het resultaat een expliciet veld met het aantal weggelaten
bevindingen. Nooit stilzwijgend afkappen: een diagnoselijst die er compleet
uitziet maar het niet is, is gevaarlijker dan een zichtbaar afgekapte lijst.

## Aansturing

Geen eigen planner in de app. De tool is bereikbaar via:

- de chat ("controleer mijn flows")
- de bestaande `ai_ask`-flowkaart, zodat de gebruiker zelf een flow bouwt
  (bijvoorbeeld: elke maandag 09:00 → `ai_ask` → pushmelding)

Homey's eigen cron doet zo het plannen. Dat scheelt FlowMind een timer, opslag
van al-gemelde problemen, en geheugen op een Homey die daar geen ruimte voor heeft.

## Raakvlakken in de code

| Bestand | Wijziging |
|---|---|
| `lib/tools.js` | tooldefinitie `check_flows` |
| `lib/HomeyContext.js` | implementatie + `case` in `executeTool` |
| `lib/llm/systemPrompt.js` | korte uitleg wanneer de tool te gebruiken |

Conform de werkwijze in `CLAUDE.md`: nieuwe tool = drie plekken.

## Risico's en hoe we ze afvangen

### Scope-beperking op `getApps`

`getApps` vereist `homey.app.readonly`. FlowMind draait in twee modi
(`apiMode`: `'local'` met API-sleutel, of `'app'` met app-token). In app-modus is
die scope er vermoedelijk niet — hetzelfde patroon als bij `createFlow`, dat in
app-modus "Missing Scopes" geeft.

**Afvang:** faalt `getApps`, dan draaien checks 1 en 3 gewoon door en meldt het
resultaat expliciet dat de app-check is overgeslagen en waarom. Nooit stil
weglaten — een diagnosetool die stilletjes minder controleert dan hij suggereert
is erger dan geen diagnosetool.

### Tijdsbudget

Flow-runs hebben `maxSteps: 6` en een krap tijdsbudget. Daarom doet de tool de
volledige scan binnen **één** tool-aanroep, niet één aanroep per flow.

### Geheugen

De Homey Pro had bij het schrijven van dit ontwerp 540 MB vrij van 1,99 GB.
Verwerk flows één voor één en houd alleen de bevindingen vast; laad niet alle
flow-objecten tegelijk in het geheugen.

## Testen

Bouwen en valideren vereist geen Homey:

```bash
node --check lib/HomeyContext.js
npx homey app validate --level publish
```

Installeren op de Homey kan technisch vanuit het buitenland (de CLI loopt via de
Athom cloud, niet via LAN), maar wordt uitgesteld tot Tarik thuis is: de Homey is
recent vastgelopen en kon alleen fysiek herstart worden.

**Testcase ligt klaar:** de Dyson-kaart in "Systeem Herstel" blijft bewust staan
tot de tool hem kan vinden. Een geslaagde run meldt zowel de dode kaart als de
14 onbereikbare kaarten erachter.

## Vervolg, buiten deze spec

Apart traject: CallMeBot vervangen door een ElevenLabs-webhook die belt in plaats
van WhatsApp te sturen (naar het voorbeeld van "Bella" in CRM2.0). Raakt de
SOS-flow voor Tariks oma en is dus veiligheidskritisch — verdient een eigen
ontwerp met terugvalpad.

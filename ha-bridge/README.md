# Aula i Home Assistant

Separat Aula-dashboard med alle 19 navngivne læsefunktioner fra aula-mcp 1.6.2.
Railway beholder Aula-login og den private ChatGPT-tunnel. En særskilt HTTPS-gateway
giver HA adgang med sin egen nøgle. Dashboardets JavaScript får aldrig gatewaynøglen.

## Dækning

| Funktion | Automatisk oversigt | Yderligere adgang fra dashboardet |
|---|---|---|
| `aula.discover` | Børn, institutioner og understøttede kilder | Datakilder |
| `aula.profiles.list` | Profiler | Datakilder |
| `aula.calendar.events` | Næste 30 dage, begge børn | HA-kalenderens ønskede datointerval |
| `aula.presence.today` | Dagens fremmøde | Fremmøde |
| `aula.presence.templates` | Ugens komme/gå-plan | Valgfrit datointerval via læse-endpoints |
| `aula.messages.list_threads` | Nyeste side, op til 20 samtaler | Ældre og nyere sider |
| `aula.messages.get_thread` | Hentes ved åbning | Hele den valgte samtale |
| `aula.messages.get_attachment` | Hentes ved valg | Download bilag efter nummer |
| `aula.notifications.list` | Notifikationer og aktivitet | Overblik |
| `aula.posts.list` | Nyeste 20 opslag, alle institutioner | Ældre opslag i portioner på 20 |
| `aula.posts.get_attachment` | Hentes ved valg | Download et bilag fra opslag |
| `aula.ugeplan.meebook` | Når kilden er registreret | Planer og lektier |
| `aula.ugeplan.easyiq` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.ugeplan.easyiq_skoleportal` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.lektier.easyiq` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.opgaver.minuddannelse` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.ugebrev.minuddannelse` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.huskelisten.systematic` | Når kilden er registreret | Planer og lektier / læse-endpoints |
| `aula.utils.extract_pdf_text` | Hentes ved valg | Læs senest hentede PDF som tekst |

En institution kan bruge én ugeplanudbyder. Automatisk hentning følger den udbyder,
som Aula selv angiver. Uregistrerede widgets vises som **Ikke tilgængelig** og kan
forespørges eksplicit under Datakilder → Alle læse-endpoints. At værktøjet findes,
garanterer ikke, at skolen har data eller adgang til produktet.

Oversigten hentes hvert 10. minut. Gatewayen har fem minutters cache og samler
samtidige forespørgsler. Kortet læser HA's lokale cache hvert minut. Opdatér anmoder
HA om en ny hentning; gatewayens korte cache kan stadig blive brugt.
Fejl vises pr. kilde. Sidste kendte data bevares og markeres som forældede.

Dette er en løbende oversigt med adgang til detaljerne, ikke et historisk arkiv over
hele Aula. Frister i fritekst/PDF bliver ikke automatisk fortolket som sikre deadlines.
Dashboardet viser de returnerede kalenderfrister og giver adgang til beskeder og bilag.
Automatiske påmindelser kan bygges ovenpå efter installation og datakontrol.

## Railway: privat forbindelse med Tailscale

Gatewayen lytter kun på `127.0.0.1:8081`. Den eksisterende MCP lytter fortsat
kun på `127.0.0.1:7878`. Der skal ikke oprettes Railway-domæne eller TCP-proxy.
Tailscale Serve giver HTTPS-adgang på port 443 i det private tailnet.
Funnel, subnetannoncering, exit node og Tailscale SSH bliver ikke slået til.

1. Opret en personlig Tailscale-konto, og forbind HA med Tailscale-appen.
2. Begræns tailnet-politikken, så kun HA må forbinde til `tag:aula-bridge` på TCP 443.
   Tagget skal ejes af tailnet-administratorerne. Undlad en samtidig allow-all-regel.
3. Opret en særskilt `AULA_HA_TOKEN` på mindst 32 tilfældige tegn i Railway.
   Send ikke nøglen i chat eller GitHub. Sæt `AULA_HA_ENABLED=1`.
4. Deploy den gennemgåede private kode. Tailscale starter i userspace-tilstand og
   gemmer sin vedvarende nodeidentitet under `/data/tailscale` med begrænsede rettigheder.
5. Følg loginlinket i Railway-loggen og godkend **aula-bridge** på din personlige konto.
   Dette er en vedvarende node, ikke en ephemeral ressource. Nodeidentiteten genbruges
   på tværs af deploys via volumenet. Login kan kræves igen ved nøgleudløb eller tilbagekaldelse.
6. Hvis Serve viser et separat link til HTTPS-opsætning, godkendes det af kontoejeren.
   Kontrollér, at godkendelsen gælder privat Serve; Funnel skal forblive deaktiveret.
   HTTPS-certifikatets enhedsnavn kan indgå i offentlige certifikatregistre. Navnet er
   derfor det generiske **aula-bridge**, ikke et familie- eller børnenavn.
7. Brug serverens fulde `https://aula-bridge.…ts.net`-adresse i HA sammen med HA-nøglen.
   Kontrollér, at HA Core selv kan nå adressen; en Connected-status i Tailscale er ikke
   i sig selv bevis for, at HA Core kan bruge netværksforbindelsen og DNS.

HA og Railway kræver en korrekt afgrænset tailnet-politik. Enheden på Railway skal
ikke have adgang til HA eller hjemmets subnet. Den private netværksadgang erstatter
ikke gatewayens bearer-nøgle; begge kontroller bruges. Alle gatewayruter kræver nøglen,
inklusive status. Nye upstream-værktøjer er afvist som standard.

Under første login kan ChatGPT-tunnelen og loopback-gatewayen allerede køre, mens
Tailscale venter på godkendelse. Det giver ingen offentlig adgang til gatewayen.
Når Serve er oppe, skal adgang testes fra HA med korrekt og forkert nøgle samt fra
et sted uden adgang til tailnettet, før forbindelsen meldes aktiv.

## Installation i HA

HA-adgangen i ChatGPT er read-only. Følgende installation udføres af HA-administratoren.
Den installerede HA-version skal kontrolleres før aktivering; koden er ikke live-testet
i Jonas' HA. Tag en normal HA-backup før installation af en ny custom integration.

1. Kopiér `custom_components/aula_bridge/` til `/config/custom_components/aula_bridge/`.
2. Kopiér `www/aula-dashboard-card.js` til `/config/www/aula-dashboard-card.js`.
3. Genstart HA for at indlæse den nye integration.
4. Under **Settings → Devices & services → Add integration**, vælg **Aula Bridge**.
   Indtast den private Tailscale HTTPS-adresse og den separate `AULA_HA_TOKEN` lokalt i HA.
   Nøglen gemmes i HA's config entry, ikke i Lovelace eller `www`.
5. Tilføj `/local/aula-dashboard-card.js?v=1` som JavaScript module under
   dashboardets Resources. Slå Advanced mode til på HA-profilen, hvis Resources er skjult.
6. Opret et nyt, tomt dashboard med navnet Aula. Indsæt indholdet af `dashboard.yaml`
   i det nye dashboards Raw configuration editor. Brug ikke et eksisterende familiedashboard.
7. Åbn Aula-dashboardet, kontrollér Datakilder, og åbn en samtale samt et bilag.
   HA opretter også en kalender pr. barn og status-sensorer pr. kilde.

Konkrete entity_id'er tildeles af HA ved installation; dashboardet gætter dem ikke.
HA's indbyggede kalendervisning kan tilføje de nye Aula-kalendere efter installation.
I HA kan almindelige calendar-triggers senere bruges til begivenhedspåmindelser.
Derudover stiller integrationen læsehandlingerne `aula_bridge.query` og
`aula_bridge.snapshot` til rådighed med response data, så scripts og automations
kan bruge alle kilder uden at skulle læse dashboardets HTML eller kende gatewaynøglen.
`query` tager `name` og `arguments` og returnerer resultatet under `data`.
`snapshot` returnerer hele den aktuelle oversigt inklusive kildefejl og hentetidspunkter.

**Adgang:** dashboarddata kræver et godkendt HA-login. Som udgangspunkt kan alle
godkendte brugere i denne HA-installation læse integrationens data; skjulte dashboardlinks
er ikke en adgangsbegrænsning. Beskedindhold gemmes i hukommelsen og ikke i sensorattributter.
HA's almindelige config-entry-opbevaring og backup indeholder gatewaynøglen og skal beskyttes.

## Bilag og fejlsituationer

- Et opslagbilag skal først være returneret af `posts.list`; vilkårlige URL'er afvises.
- Bilag hentes til upstreams midlertidige mappe. HA får et tilfældigt attachment_id,
  der udløber efter én time. PDF-læsning accepterer dette id, aldrig en fri serversti.
- Filindhold er begrænset til 50 MiB. Bilag med følsom adgang kan kræve nyt MitID-login.
- Meebook kan kræve, at man én gang åbner Meebook-widgetten fra Aula i sin browser.
- Ved udløbet Aula-login: gennemfør det eksisterende lokale MitID-login og den sikre
  tokenoverførsel til Railway. Del hverken tokens.json eller .key i chat.
- Ved rotation af HA-nøglen: opdatér Railway og tilføj integrationen igen i HA med den
  nye nøgle. Det kan ændre entity_id'er; kontrollér senere automations efter rotation.

## Kontrol og tilbageførsel

Fra repositoryroden:

```sh
node --test ha-bridge/tests/*.test.mjs
python -m unittest discover -s ha-bridge/tests -p 'test_*.py'
bash -n deploy/railway-start.sh deploy/tailscale-start.sh
```

Testene bruger syntetiske data og en mock-MCP. De kontrollerer nøglekrav, afvisning af
skrive/raw-kald, sessionsrækkefølge, cache, kildefejl, tidszoner og HTML-escaping.
Python-tests kontrollerer klientens URL-regler samt kalenderkonvertering med minimale
HA-stubs; de erstatter ikke en rigtig HA-runtime-test.

Deaktivér gatewayen med `AULA_HA_ENABLED=0`, og redeploy. Fjern ved behov også Aula-noden i Tailscale.
Den private ChatGPT-tunnel fortsætter via den eksisterende MCP. I HA kan integrationen
og det separate Aula-dashboard fjernes. Ingen eksisterende dashboards ændres af filerne.

Tekniske referencer: [HA calendar entity](https://developers.home-assistant.io/docs/core/entity/calendar/),
[HA config flow](https://developers.home-assistant.io/docs/config_entries_config_flow_handler/),
[HA custom card](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/).

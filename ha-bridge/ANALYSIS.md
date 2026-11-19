# Aula-analyse med den eksisterende OpenClaw-forbindelse

Analysen tilføjes til Aula Bridge uden nye credentials, netværksporte eller Python-afhængigheder.
OpenClaw send_message bruger agent_id main og en unik agent-scoped session pr. kildeversion.
Svar modtages via openclaw_message_received og valideres før videre behandling.

## Drift

- Deaktiveret ved første opstart. Aktivér med aula_bridge.analysis_control, enabled: true.
- Nye skoleopslag og beskedtråde kontrolleres hvert 10. minut fra installationstidspunktet.
- Familiekontekst gives via analysis_control config og gemmes kun i HA Store. Opdatér den ved klasseskift.
- Konkrete opgaver giver straks en kort besked til begge telefoner.
- Relevant orientering leveres ved næste kontrol mellem kl. 18 og 19. Én besked pr. kilde.
- Ingen relevans giver ingen push. Ingen ekstra AI-kørsel bruges til orienteringsbeskederne.
- Fuld analyse vises i den personlige indbakke på Aula-dashboardet. Telefonens link åbner dashboardet.
- Private tråde med få modtagere eller markeret følsomt indhold får altid en neutral pushtekst.
- Ulæselige bilag, ugyldigt svar eller for stor kilde giver en neutral besked om manuel gennemlæsning.
- Testhandling analysis_test kræver kind: post/thread og source_id som heltal. Sender aldrig push.
- analysis_status returnerer historik, resultater og fejl. analysis_run henter nye kilder manuelt, hvis aktiveret.
- Slå fra med analysis_control enabled: false. En igangværende analyse kan afslutte i HA, men sender ikke push.

Historik og indstillinger gemmes med HA Store og overlever genstart. Expirerende URL'er og læsemarkeringer
indgår ikke i kildehash. En ny version får ny analyse; identiske notifikationstekster og opgaver gentages ikke.
Et job, som blev afbrudt under genstart, markeres til manuel kontrol og genafsendes ikke til AI automatisk.
Der sendes en ny, unik session for hver modelkørsel. Ingen modelværktøjer anmodes brugt.
Den eksisterende OpenClaw-integration skal fortsat have serviceudførelse deaktiveret.

## Konkrete begrænsninger

- Historiske opslag og beskeder fra før installationen bliver ikke masseudsendt. De kan testes enkeltvis.
- Opslagets publiceringsdato bruges til afgrænsning; redigeringer af opslag fra før installationen opdages ikke.
- Nye svar i gamle tråde opdages via seneste beskeds tidspunkt og id.
- Opslag uden skoleangivelse overlades til relevansvurderingen. Andre institutioners beskeder fravælges efter den konfigurerede institutionskode.
- PDF'er tekstlæses i den eksisterende Aula-gateway. Fotos, scannede PDF'er uden tekst, Word og andre filtyper
  kræver manuel læsning; løsningen påstår ikke at have læst dem.
- Tråde læses sidevis til en tom side. Bilagsværktøjet understøtter kun første trådside; ældre bilag markeres.
- Der hentes højst 100 sider. Grænsen og kildefejl giver synlig kontrolbesked i HA.
- Telefonlevering gemmes før kaldet for at undgå dubletter efter nedbrud. Fejl genafsendes ikke automatisk.
  Leveringsfejl fremgår af den gemte historik. En accepteret HA-notify-handling beviser ikke visning på telefonen.
- Modelleverandør, abonnement og pris styres af den eksisterende OpenClaw-opsætning og er ikke ændret her.
- Tidspunkter bruger Europe/Copenhagen. Kilder og telefoner skal verificeres i den rigtige HA-runtime.

## Validering og tilbageførsel

Kør python3 -m unittest discover -s ha-bridge/tests -p 'test_analysis.py' -v.
Testene bruger syntetiske kilder og HA-stubs; de erstatter ikke livekontrol.
De øvrige eksisterende integrationstest skal også køres før installation.

Ved tilbageførsel: stop analysen, gendan __init__.py og services.yaml fra basecommit
10c9353d0f0309559e29c112f66032877be65de5 og genstart HA. analysis.py kan blive liggende inaktivt.
Historikken i HA Store kan bevares. Aula-login og gatewayen ændres ikke.


## Personlig indbakke (0.1.1)

Aula-dashboardet åbner nu på **Indbakke** med **Ulæste**, **Alle** og **Arkiv**.
**Læs besked** markerer kun den aktuelle HA-brugers kopi som læst. **Arkivér hos mig**
skjuler kun beskeden hos denne bruger; den kan gendannes fra Arkiv. **Markér ulæst**
bevarer beskeden til senere. Status gemmes i den eksisterende HA Store og følger
HA-kontoen på tværs af enheder og genstarter. Jonas og Charlotte skal derfor være
logget ind med hver sin eksisterende HA-bruger. En fælles konto giver fælles status.

Kun indlogget HA-bruger bestemmer, hvis status API'et læser og ændrer; klienten kan
ikke angive en anden bruger. Ingen ekstra login, credentials eller eksternt lager.
Aula selv markeres ikke læst. Telefon-push og den automatiske analyse bevares.
At læse eller arkivere udløser hverken AI-analyse, push eller sletning i Aula.

Eksisterende gemte analyser er med i indbakken, også hvis den tidligere fælles
HA-notifikation er blevet afvist. Prøveanalyser markeres tydeligt. Én seneste analyse
vises pr. kilde, med rigtig analyse foretrukket over test. En ny kildeversion starter
ulæst for begge. Ældre læststatus påvirker ikke den nye version. Relevans none vises
ikke, hvis analysen ellers er komplet. Ufuldstændige analyser får en kontrolmarkering.
Nye kildeanalyser opretter ikke flere fælles persistent notifications. Allerede oprettede
HA-notifikationer slettes ikke af opgraderingen. En generel fejl i datahentningen kan
stadig vises som en fælles driftsadvarsel og fremgår også af den personlige indbakke.

### Installation af indbakken

Bevar den eksisterende HA-lokale konfiguration og analysehistorik. Redigér ikke .storage.
Tag kopi af de fire berørte installerede filer før erstatning:

- `custom_components/aula_bridge/__init__.py`
- `custom_components/aula_bridge/analysis.py`
- `custom_components/aula_bridge/manifest.json`
- `www/aula-dashboard-card.js`

Erstat dem med filerne fra samme gennemgåede inbox-commit. Kør HA's konfigurationskontrol,
genstart HA for at indlæse Python-koden, og ændr den eksisterende dashboards ressource-URL
til `/local/aula-dashboard-card.js?v=inbox-1` (JavaScript module). Tilføj ikke en ekstra kopi
af ressourcen. Dashboardets YAML og Aula-login behøver ingen ændring.

Kontrollér med to forskellige HA-brugere: Læs samme besked som bruger A, og bekræft,
at den stadig er ulæst hos B. Arkivér hos A, genindlæs begge, og kontrollér at den fortsat
ligger hos B. Gendan hos A. Kontrollér også at en ny kildeversion vises ulæst hos begge.
Ved tilbageførsel gendannes de fire filer samlet, og HA genstartes. De nye læstmarkeringer
kan ligge inaktive i Store uden at ændre den tidligere analysedel.

### Validering af indbakken

Kør `python3 -m unittest discover -s ha-bridge/tests -p 'test_*.py' -v` og
`node --test ha-bridge/tests/card.test.mjs ha-bridge/tests/gateway.test.mjs`.
Testene dækker brugeradskillelse, HTTP-brugeridentitet, samtidige ændringer,
vedvarende status, ny kildeversion, arkiv/gendannelse, gemmefejl, HTML-escaping,
forældede svar og kontoskift. De emulerer ikke en kørende Home Assistant-installation.

## Flere børn · 0.2.0

Se [FAMILY.md](FAMILY.md) for adskilte skole-/børnehaveregler, madordning, lokal tilføjelse af børn og bagudkompatibel historik. Den eksisterende primære kontekst og telefoner bevares. Koden er ikke automatisk installeret eller aktiveret i HA.

# Gastronomy ReelScan – Real-World Pilot 2

**Datum der Quellenprüfung:** 31. Juli 2026  
**Modus:** lokale Validierung, kein Deployment, keine Provider-Aufrufe  
**Sicherheit:** `EMAIL_MODE=mock`, `OUTREACH_ENABLED=false`; kein Gmail, kein Versand

## Ziel und Methode

Dieser zweite Pilot prüft den verbesserten Gastronomy ReelScan gegen zehn reale
marokkanische Hospitality-Betriebe. Die Stichprobe ist bewusst geschichtet:

- 3 Betriebe, bei denen in den geprüften öffentlichen Einträgen keine
  eigenständige offizielle Website belegt werden konnte
- 3 Betriebe mit einfachen oder fragmentierten Websites
- 4 Betriebe mit starken Websites

„Keine Website belegt“ bedeutet ausdrücklich **nicht**, dass global keine
Website existiert. In diesen Fällen wurden fehlende Informationen als
Abdeckungslücke behandelt und nicht als Opportunity. Fehlende Evidenz allein
durfte weder einen Score noch einen E-Mail-Entwurf erzeugen.

Die Bewertung kombiniert:

1. die echten ReelScan-, Qualification- und Email-Review-Klassen,
2. aktuelle, öffentlich abrufbare Geschäfts- und Website-Quellen,
3. eine manuelle 1–5-Bewertung anhand eines vorab festgelegten Maßstabs:
   - 5 = konkret, direkt durch die Quelle gedeckt und für den Eigentümer
     unmittelbar brauchbar
   - 3 = im Kern richtig, aber mit generischer oder unvollständiger Begründung
   - 1 = unbelegt, austauschbar oder irreführend

## Stichprobe und Ergebnisse

| Betrieb | Segment | Verifizierte Opportunities | Opportunity Score | Evidenz | Ergebnis |
|---|---|---:|---:|---|---|
| Chez Chegrouni, Marrakech | Keine eigenständige Website belegt | 0 | – | Low | Zurückgehalten |
| Café Hafa, Tanger | Keine eigenständige Website belegt | 0 | – | Low | Zurückgehalten |
| Chez Lamine, Marrakech | Keine eigenständige Website belegt | 0 | – | Low | Zurückgehalten |
| Green Black, Casablanca | Einfache Website | 3 | 64 | Medium | Zurückgehalten: keine öffentliche E-Mail gespeichert |
| Cafe Clock, Fès | Einfache/fragmentierte Website | 3 | 66 | Medium | Qualifiziert |
| OMBÚ, Essaouira | Einfache Website | 3 | 70 | Medium | Qualifiziert |
| NOMAD, Marrakech | Starke Website | 0 | – | Low | Korrekt nicht qualifiziert |
| Café Bianca, Casablanca | Starke Website | 0 | – | Low | Korrekt nicht qualifiziert |
| Le Six, Fès | Starke Website | 0 | – | Low | Korrekt nicht qualifiziert |
| Restaurant Bagatelle, Marrakech | Starke Website | 0 | – | Low | Korrekt nicht qualifiziert |

`Low` bei einer starken Website bedeutet hier nicht „schlechte Website“,
sondern „keine ausreichende Opportunity-Evidenz“. Der Agent verweigert deshalb
korrekt einen Opportunity Score.

## Pilot-Kennzahlen

- **Qualifizierte Leads:** 2
- **Zurückgehaltene/abgelehnte Leads:** 8
- **Betriebe mit realen, belegten Opportunities:** 3
- **Outreach-fähige Opportunities:** 2
- **Falsch positive Qualifikationen gegenüber der manuellen Referenz:** 0
- **Durchschnittliche Evidenzstufe pro Betrieb:** 1,3/3
  (`High=3`, `Medium=2`, `Low=1`; 3× Medium, 7× Low)
- **Durchschnittliche Beobachtungsgenauigkeit:** 4,86/5
- **Durchschnittliche Relevanz für Gäste:** 4,93/5
- **Durchschnittliche Umsetzbarkeit der Empfehlung:** 4,93/5
- **Durchschnittliche manuelle Personalisierungsbewertung der 2 Entwürfe:**
  4,6/5
- **Automatisches Email-Review der 2 Entwürfe:** 100/100 im Durchschnitt

Die niedrige durchschnittliche Evidenzstufe ist in dieser Stichprobe ein
positives Sicherheitsmerkmal: Sie entsteht durch sieben bewusst
nicht-qualifizierte Fälle und verhindert Scores aus bloßem Nichtwissen.

## Qualität des ReelScan

### Faktentreue

Die Beobachtungen waren faktisch eng genug formuliert:

- Bei OMBÚ wurde nicht behauptet, dass es „kein Menü“ gebe. Festgestellt wurde
  präziser, dass die geprüfte Menüseite in ihrem öffentlich abrufbaren Text
  keine einzelnen Gerichte und Preise ausweist.
- Bei Cafe Clock wurde nicht behauptet, Reservierungen seien unmöglich. Der
  Befund beschränkt sich darauf, dass im geprüften öffentlichen Pfad nur
  „Group Bookings“ und kein eigener Weg für normale Tischreservierungen
  sichtbar war.
- Bei Green Black wurde die tatsächlich veröffentlichte Formulierung
  „tous les jours, midi et soir“ als unpräzise Öffnungszeit bewertet.
- Bei den drei Fällen ohne belegte eigenständige Website wurden keine
  Website-Mängel erfunden.

### Relevanz für Gäste

Die stärksten Befunde liegen genau an nachvollziehbaren Entscheidungspunkten:

- Gerichte und Preise vor dem Besuch vergleichen
- konkrete Öffnungszeiten prüfen
- Regeln für eine normale Tischreservierung verstehen
- von der Adresse direkt zur Navigation wechseln

Die vorgeschlagenen Maßnahmen sind klein und realistisch: HTML-lesbare
Menüinformationen, genaue Öffnungszeiten, klare Reservierungsanweisung und
direkte Kartenlinks. Es gibt keine Umsatz-, Ranking- oder
Kundengewinnungsversprechen.

## Qualität der Qualifikation

Der Evidenz-Gate verhielt sich im Pilot sinnvoll:

- **OMBÚ (70):** höchste Opportunity im Test; die konkrete Kombination aus
  eingeschränkt textlich zugänglicher Menüinformation, nicht verifizierten
  Öffnungszeiten und fehlendem direktem Kartenpfad ist ein plausibler
  Gastronomie-Beratungsfall.
- **Cafe Clock (66):** moderate, echte Opportunity; das Angebot ist stark, aber
  der digitale Weg vom Interesse an Speisen zur Menü- und
  Reservierungsentscheidung ist fragmentiert.
- **Green Black (64):** reale Verbesserungspunkte, aber keine gespeicherte
  öffentliche E-Mail. Der Agent erzeugte deshalb keinen Outreach-Entwurf.
- **Vier starke Websites:** kein Opportunity Score und keine Qualifikation.
  Das vermeidet den typischen Fehlalarm „eine optionale Funktion fehlt, also
  ist der Betrieb ein Sales-Lead“.
- **Drei Fälle ohne belegte Website:** kein Score. Das vermeidet eine
  Qualifikation aus fehlender Evidenz.

In dieser kleinen, kuratierten Stichprobe waren somit die beiden
Outreach-Qualifikationen echte, nachvollziehbare Prospects. Die Stichprobe ist
zu klein, um daraus eine allgemeine Präzisionsrate für Discovery oder
Browser-Rendering abzuleiten.

## Email Review

### Starkes Systembeispiel

> En examinant la présence publique de OMBÚ Restaurant & Café à Essaouira,
> j’ai vérifié un point précis : La page « Our Menu » vérifiée décrit la
> cuisine, mais n’expose pas de plats individuels ni de prix en texte lisible.
> Pour une personne qui choisit où aller, cela oblige les personnes à chercher
> ailleurs avant de pouvoir comparer l’offre. Une amélioration réaliste serait
> la suivante : ajouter un lien direct vers une carte lisible sur mobile, avec
> les principaux plats et prix.

Warum stark:

- nennt Betrieb und Ort,
- beginnt mit einem nachprüfbaren Detail der konkreten Seite,
- erklärt den Effekt auf die Gästeentscheidung,
- bietet eine realistische, kleine Verbesserung.

### Weiterhin verbesserungsfähig

Der zweite und dritte Satzteil des automatisch erzeugten Absatzes ist trotz
guter Ausgangsbeobachtung noch relativ standardisiert. „Cela oblige les
personnes à chercher ailleurs…“ und die generische Empfehlung zu einer mobil
lesbaren Karte könnten sprachlich noch enger an das konkrete OMBÚ-Angebot
gebunden werden. Deshalb liegt die manuelle Personalisierung bei 4,7/5 und
nicht bei 5/5.

### Schwaches Beispiel – korrekt abgelehnt

> Nous aidons les restaurants à améliorer leur présence numérique. ReelScan
> est une première étape simple.

Das Review lehnte diesen Text ab, weil im ersten Absatz eine verifizierte
Beobachtung, der konkrete Gast-Impact, eine realistische Empfehlung sowie
Betrieb und Ort fehlen. Für einen Lead ohne Mindest-Evidenz war bereits die
Entwurfserstellung blockiert.

## Quellen

### Keine eigenständige Website in den geprüften Einträgen belegt

- Chez Chegrouni:
  [Tripadvisor](https://www.tripadvisor.fr/Restaurant_Review-g293734-d1097803-Reviews-Chez_Chegrouni-Marrakech_Marrakech_Safi.html),
  [Restaurants Marrakesh](https://www.restaurantsmarrakesh.com/en/listing/chez-chegrouni-marrakech)
- Café Hafa:
  [My Tangier](https://www.mytangier.com/place/cafe-hafa),
  [Wanderlog](https://wanderlog.com/place/details/463400/caf%C3%A9-hafa)
- Chez Lamine:
  [Tripadvisor](https://www.tripadvisor.com/Restaurant_Review-g293734-d2434157-Reviews-Chez_Lamine-Marrakech_Marrakech_Safi.html),
  [Apple Maps](https://maps.apple.com/place?place-id=IBECF13257BEC1ECE)

### Einfache oder fragmentierte Websites

- Green Black:
  [Startseite](https://www.greenblack.ma/),
  [öffentliches Menü](https://greenblack.ma/menu/)
- Cafe Clock:
  [Startseite](https://www.cafeclock.com/),
  [Kontakt](https://www.cafeclock.com/contact-us)
- OMBÚ:
  [Startseite](https://www.ombu-restaurant.com/),
  [Menüseite](https://www.ombu-restaurant.com/menu1)

### Starke Websites

- NOMAD:
  [Startseite](https://nomadmarrakech.com/),
  [Menü](https://nomadmarrakech.com/menu/),
  [Reservierung](https://nomadmarrakech.com/reservation/),
  [Kontakt](https://nomadmarrakech.com/contact/)
- Café Bianca:
  [Restaurantseite](https://www.villablanca.ma/en/restaurant-cafe-bianca/)
- Le Six:
  [Website](https://www.lesixcafe.com/)
- Restaurant Bagatelle:
  [Website](https://www.restaurant-bagatelle-marrakech.com/)

## Grenzen des Piloten

- Es wurde kein Discovery-System getestet oder gebaut.
- Die Bewertung stützt sich auf öffentlich abrufbare Seiteninhalte und
  Verzeichnisangaben; sie ist kein Vor-Ort-Betriebsaudit.
- „Nicht sichtbar in den geprüften Seiten“ ist keine Aussage über alle
  denkbaren Unterseiten, Social-Media-Kanäle oder Offline-Prozesse.
- Responsives Verhalten und visuelle Qualität wurden in diesem Lauf nicht mit
  einem echten Cloudflare Browser Rendering in Produktion gemessen.
- Öffentliche Angaben können sich nach dem Prüfdatum ändern.

## Freigabeempfehlung

**Noch nicht deployen.** Die Qualität ist deutlich besser und der
Evidenz-Gate vermeidet in dieser Stichprobe falsche Qualifikationen. Vor einem
Deployment sollte als nächster Qualitäts-Schritt die sprachliche
Personalisierung von Impact und Empfehlung stärker aus dem konkreten
Restaurantbefund abgeleitet und anschließend mit einer weiteren unabhängigen
Stichprobe geprüft werden.

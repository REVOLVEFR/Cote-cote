# Backtest — Cote à Cote

Répond à une seule question : **le modèle bat-il la cote de clôture ?**

Tout le reste — rendement, série de victoires, courbe qui monte — peut venir
de la chance. La cote de clôture, non.

## Lancer

```bash
node backtest/download.mjs 10   # ~80 fichiers, quelques minutes
node backtest/selftest.mjs      # vérifie le moteur avant de s'en servir
node backtest/run.mjs           # le backtest lui-même
```

Le téléchargement doit se faire depuis ta machine : football-data.co.uk
n'est pas joignable depuis l'environnement où le code a été écrit.

## Ce que fait le moteur

**Il n'a jamais accès à l'avenir.** À chaque match, les forces d'attaque et de
défense sont estimées uniquement sur les rencontres antérieures, sur une
fenêtre glissante de 900 jours, pondérées par leur ancienneté (demi-vie de
240 jours). C'est la précaution qui invalide la majorité des backtests de
paris qu'on trouve en ligne.

**Il compare au prix équitable, pas au prix affiché.** La cote inclut la
marge du bookmaker. On la retire avant de calculer l'écart, sinon on
mesurerait la marge au lieu de mesurer un avantage.

**Il sépare apprentissage et validation.** Le seuil est choisi sur les
premières saisons, et jugé uniquement sur les dernières. Un seuil choisi et
jugé sur les mêmes données mesure la capacité à ajuster après coup, rien
d'autre.

**Il juge chaque marché séparément.** L'auto-test a montré qu'agréger les
cinq marchés dilue un avantage réel dans la sélection adverse des autres :
un biais de +8 % sur la victoire à domicile disparaissait complètement une
fois mélangé au reste.

## L'auto-test

`selftest.mjs` construit deux championnats fictifs dont on connaît la vérité.

Sur un marché **efficient**, le moteur ne doit trouver aucun avantage. Sur un
marché **biaisé de 12 % sur le domicile**, il doit retrouver un rendement de
+8,2 % — la valeur que donne le calcul. Il trouve +8,04 %, avec t = 2,93, et
le résultat tient hors échantillon.

Un backtest faux est pire qu'aucun backtest, parce qu'il donne une fausse
assurance. Relance l'auto-test après toute modification du moteur.

## Lire le résultat

Trois issues, dans l'ordre de probabilité.

**Négatif en validation.** Le modèle ne bat pas la clôture. C'est l'issue la
plus probable et elle a la valeur d'une réponse : deux ans économisés.

**Positif mais l'intervalle contient zéro.** Indistinguable de la chance.
Ne rien engager.

**Positif, intervalle au-dessus de zéro.** Résultat inhabituel. Chercher
d'abord une fuite de données : une colonne de cote postérieure au match, un
doublon, une équipe renommée. La probabilité d'un bug dépasse largement celle
d'avoir trouvé une faille dans un marché à plusieurs milliards.

## Limites assumées

- `rho` (correction de Dixon-Coles) est fixé à −0,1, pas ajusté. L'ajuster
  sur ces données reviendrait à apprendre sur le jeu de test.
- La dévigorisation est proportionnelle. La méthode de Shin serait plus
  juste sur les gros favoris ; l'écart reste faible sur les marchés liquides.
- Les cotes de clôture anciennes sont parfois absentes selon les saisons.
- Pas de blessures, pas de compositions, pas de calendrier européen. Le
  marché, lui, les intègre.

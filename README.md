# Cote à Cote

Suivi public et horodaté de paris sur sept grands championnats européens.
Site statique sur GitHub Pages, automatisé par GitHub Actions. Aucun serveur,
aucun coût.

## Pourquoi l'historique git compte

Chaque pari est publié par une Action, qui écrit dans `data/picks.json` et
commite. Le commit est daté par GitHub, pas par moi : impossible d'antidater un
pari ou de retoucher un pronostic après le match sans que ça se voie dans
l'historique. C'est la seule chose qui sépare un palmarès vérifiable d'une
capture d'écran.

Le code refuse d'ailleurs de publier un pari dont le coup d'envoi est passé, et
de modifier une cote d'ouverture déjà posée.

## Mise en route

1. Dépôt **public** — sur GitHub Free pour organisations, Pages ne fonctionne
   que sur les dépôts publics.
2. Settings → Secrets and variables → Actions → New repository secret :
   `FOOTBALL_DATA_TOKEN`, obtenu sur football-data.org. Les secrets ne sont
   jamais exposés, même sur un dépôt public.
3. Settings → Pages → Source : Deploy from a branch, `main`, dossier `/ (root)`.
4. Settings → Actions → General → Workflow permissions : **Read and write**,
   sinon les Actions ne pourront pas commiter.

## Usage courant

Tout se passe dans l'onglet Actions, sans ligne de commande.

| Workflow | Quand |
| --- | --- |
| Publier un pari | avant le coup d'envoi |
| Enregistrer des cotes | `open` à la publication, `close` juste avant le match |
| Régler les paris terminés | automatique toutes les 30 min, ou à la main |

L'identifiant `match_id` vient de football-data et conditionne le règlement
automatique. Sans lui, le pari reste en attente.

## Marchés réglés automatiquement

`1` `X` `2` `1X` `X2` `12` `BTTS` `NOBTTS` `O2.5` `U2.5` `O1.5` `U3.5`…

Les lignes entières (`O3` sur un 2-1) sont remboursées. Buteurs, cartons et
corners sont marqués `needsManual` : le palier gratuit de football-data ne
fournit pas les données joueur.

Championnats couverts : `PL` `PD` `BL1` `SA` `FL1` `DED` `PPL`. La Jupiler Pro
League est en palier payant chez football-data et n'est pas incluse.

## Ce que le site mesure

L'écart à la cote de clôture passe devant le taux de réussite, et le rendement
est toujours affiché avec sa marge d'erreur à 95 %. Tant que l'intervalle
traverse le zéro, le site l'écrit : le résultat reste compatible avec l'absence
d'avantage.

Un taux de réussite seul ne dit rien. À cote 1,28, il faut 78,1 % pour être à
l'équilibre.

## Limites connues

- Les crons GitHub Actions peuvent être retardés en période de charge.
- Les workflows planifiés se désactivent après 60 jours sans activité sur le
  dépôt ; les commits automatiques suffisent à les maintenir.
- Les cotes sont saisies à la main. Un fournisseur automatique couvrant
  Winamax coûte environ 60 €/mois.

## Local

```bash
python3 -m http.server 8000   # puis http://localhost:8000
node scripts/cli.mjs settle   # avec FOOTBALL_DATA_TOKEN dans l'environnement
```

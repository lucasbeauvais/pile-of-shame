# Pile of Shame — brief projet

## Objectif
Outil web public et gratuit : n'importe qui colle l'URL de son profil Steam public et obtient une recommandation du **prochain jeu de sa bibliothèque à lancer**. La reco tient compte :
- du **temps disponible** : une soirée (< 5 h), quelques soirées (5–15 h), un gros morceau (15–40 h), un monde où vivre (40 h +) ;
- du **mode** : solo, coop ou peu importe ;
- de ses **goûts**, devinés depuis ses jeux les plus joués et ajustables par tags (♥ / ✕).

Le problème de départ : on possède trop de jeux, on n'a aucune visibilité sur son catalogue et on ne sait jamais quoi lancer.

Langue de l'interface : **français**.

## Architecture
Un seul **Cloudflare Worker** sert à la fois la page statique et l'API.

```
public/index.html   page unique (HTML + CSS + JS vanilla, aucune dépendance)
src/worker.js       relais API, la clé Steam reste côté serveur
wrangler.jsonc      config Worker + static assets (binding ASSETS)
test/worker.test.js tests node:test du relais (npm test)
```

### Endpoints
- `GET /api/profile?u=<url|pseudo|steamid64>`
  - Résout le pseudo (`ResolveVanityURL`), puis appelle `GetOwnedGames` et `GetPlayerSummaries`.
  - Renvoie `{steamid, persona, avatar, games:[{appid,name,playtime(min),lastPlayed}]}`.
  - Erreurs : 400 entrée non reconnue · 404 pseudo inconnu · 403 bibliothèque privée · 500 clé absente · 502 Steam indisponible.
- `GET /api/meta?ids=1,2,…` (10 maximum)
  - Interroge SteamSpy `appdetails` et renvoie `{meta:{appid:{tags[], median, average, pos, neg, ccu}|null}}`.
  - `median` et `average` sont en minutes de temps joué par les possesseurs.
  - Résultats mis en cache 30 jours via `caches.default`.
  - Requêtes SteamSpy espacées d'1 seconde, comme l'exige leur limite de débit.
  - `ccu` : pic de joueurs simultanés la veille de l'analyse, utilisé comme « niveau habituel » pour détecter un pic.
- `GET /api/players?ids=1,2,…` (15 maximum, limite de sous-requêtes d'un Worker)
  - `ISteamUserStats/GetNumberOfCurrentPlayers` par jeu, renvoie `{players:{appid:nombre|null}}`. Cache 30 min.
- `GET /api/charts`
  - `ISteamChartsService/GetMostPlayedGames` : top 100 Steam, renvoie `{ranks:[{appid, rank, lastWeekRank, peak}]}`. `lastWeekRank` = 0 pour une nouvelle entrée. Cache 30 min.
- `GET /api/ttb?ids=1,2,…` (50 maximum)
  - Temps pour finir d'après IGDB : `{status:'ok', ttb:{appid:{hastily, normally, completely, count}|null}}` (minutes), ou `{status:'not_configured', ttb:{}}` sans secrets Twitch.
  - 2 requêtes IGDB par appel quel que soit le nombre de jeux : `external_games` (source Steam = 1, champ `external_game_source` puis `category` en repli), puis `game_time_to_beats`. Jeton Twitch `client_credentials` mis en cache. Pas de cache par jeu côté Worker : c'est le navigateur qui garde les résultats (`pos.ttb`).
- `GET /api/site?appid=X`
  - Redirige (302) vers le site officiel du jeu, lu dans `website` de la fiche Steam (`store.steampowered.com/api/appdetails?filters=basic`, http(s) seulement), ou vers sa page Steam à défaut. Cache 30 jours.

### Secret
`STEAM_API_KEY`, à définir via `wrangler secret put STEAM_API_KEY` ou dans le dashboard Cloudflare.
Recommandés, pour les durées IGDB (sans eux, repli sur SteamSpy, qui n'a plus de temps de jeu pour beaucoup de jeux) : `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` (application créée sur https://dev.twitch.tv/console/apps).
⚠️ Ne jamais la committer. Pour le développement local, la mettre dans `.dev.vars` (déjà dans `.gitignore`).
⚠️ L'ancienne clé de Lucas a été exposée dans une conversation : **la révoquer et en générer une nouvelle** sur https://steamcommunity.com/dev/apikey.

## Logique de reco (dans public/index.html)
- **Candidats** : jeux avec moins de 2 h de jeu, sauf ceux marqués fini, pas intéressé ou en cours, et sauf ceux masqués pour la session.
  - Les deux cases d'inclusion sont de grandes options sous « Quels jeux inclure ? » (`.incl`) : « à peine commencés » (`started`, moins de 2 h) et « auxquels tu joues déjà » (`played`). Elles valent aussi pour Ça bouge et le Versus, qui partent des mêmes candidats. Une autre édition d'un jeu joué (ex. Miles Morales à côté de Spider-Man) reste un jeu distinct pour Steam.
  - Case « Inclure les jeux auxquels tu joues déjà » (`played`, décochée par défaut) : ajoute les jeux à plus de 2 h et ceux marqués en cours. Pour eux, l'adéquation au créneau se calcule sur le temps restant (`median` − temps joué) ; durée inconnue (0.45) si ce temps est dépassé.
- **Exclusions automatiques** :
  - logiciels (tags Utilities, Software…) ;
  - mode coop : uniquement les jeux avec un tag Co-op, Online Co-Op, Local Co-Op ou Split Screen ;
  - mode solo : on retire les jeux MMO et ceux tournés vers le PvP sans tag Singleplayer ;
  - un tag marqué ✕ dans le top 5 des tags du jeu.
- **Tes goûts** (`renderTags`) : tous les genres de la pile (8 premiers tags de chaque jeu, hors fini / écarté, hors génériques), avec le nombre de jeux concernés. Ordre : ♥ / ✕ choisis, puis affinité, puis nombre de jeux. 16 visibles (`TAGS_SHOWN`), le reste derrière « Voir tous les genres », avec une recherche.
- **Affinité** : somme des tags des jeux joués plus de 2 h, pondérée par log(1 + heures) et par le rang du tag, puis normalisée sur 0–1. Les tags génériques (Indie, Singleplayer…) sont ignorés.
- **Score** :
  - avec un créneau choisi : `0.45·goûts + 0.22·avis + 0.33·durée` ;
  - sans créneau : `0.62·goûts + 0.38·avis` ;
  - le tout × 0.85 si le jeu a déjà été lancé.
- **Avis** : lissage bayésien `(pos + 7.5) / (pos + neg + 10)`.
- **Adéquation de durée** : 1 dans la fourchette, décroissance logarithmique en dehors, 0.45 si la durée est inconnue.
- **Ça bouge en ce moment** : parmi les candidats des recos (mêmes critères : créneau, mode, cases à cocher, tags ✕), les jeux qui ont au moins 300 joueurs connectés, un pic (joueurs actuels / `ccu` ≥ 1,5) ou qui gagnent au moins 5 places dans le top 100 Steam. Tri par `log10(joueurs) + min(pic, 5) + min(places gagnées, 50)/10`. Joueurs connectés demandés pour les candidats du top Steam et les 40 meilleures recos, une fois l'analyse finie ; quand les critères changent, seuls les jeux jamais demandés repartent au serveur (`live.asked`).
- **🎲 Hasard** : tire 3 jeux d'un coup parmi les 15 meilleures recos (poids `score³`), sans reprendre le tirage précédent quand il reste assez de choix (`picks`).
- **⚙️ Changer les critères** : boutons dans « À jouer ensuite » et « Ça bouge en ce moment », qui remontent au panneau des critères (`#criteres`).
- **Durée d'un jeu** (`durOf`) : temps pour finir IGDB (`normally`, sinon `hastily`, sinon `completely`) ; à défaut `median` SteamSpy, affiché « temps médian des joueurs ». Chargée pour toute la bibliothèque par lots de 50 au début de l'analyse ; un jeu inconnu d'IGDB est redemandé après 7 jours.
- **Affichage des temps** (`timeInfo`) : partout (recos, tendances, pile), la durée du jeu à côté de ton temps de jeu Steam, avec ta progression en % de cette durée.
- **Versus** (bloc sous « À jouer ensuite », état de session `vs`) : deux jeux tirés des 40 meilleures recos non éliminées ; on touche celui qu'on **élimine**, le survivant affronte un nouvel adversaire. Après 10 duels (`VS_ROUNDS`), le survivant devient la reco. « Encore » élimine ce gagnant et relance 10 duels ; idem s'il est marqué pas ce soir / fini / pas intéressé. Chaque duel met aussi à jour une note Elo (`duel:{appid:{r, n}}`, K = 32, « éliminer les deux » retire 16) qui pèse sur le score `× (1 + 0.3·tanh(r/100))` et sert au tri « tes duels ».
- **Stats du haut** : cliquables, elles ouvrent « Toute ta pile » sur la bonne vue : jeux possédés (toute la bibliothèque, par nom), jamais lancés, heures au compteur (tri par temps de jeu), marqués finis (bouton « Pas fini finalement »).
- **Toute ta pile** : vues recos / toute la bibliothèque / jamais lancés / finis / écartés / en cours ; tris pertinence / duels / plus courts / temps de jeu / nom. Les jeux finis, écartés ou en cours peuvent être démarqués.
- Plus de bouton « C'est parti » (retiré à la demande de Lucas) ; le statut « en cours » ne reste que pour les jeux déjà marqués.
- **Liens d'un jeu** (`linksHTML`) : Lancer dans Steam, Voir la page du jeu (`/api/site`), Page Steam, plus HowLongToBeat (recos) ou la courbe de joueurs (tendances).
- **Ordre d'analyse** : les 15 jeux les plus joués d'abord (pour l'affinité), puis la pile, puis les 25 suivants. Les recos se mettent à jour à chaque lot de 10.
- **État utilisateur** dans le localStorage :
  - `pos.u.<steamid>` : statuts, préférences, filtres, notes des duels ;
  - `pos.meta` : cache des métadonnées SteamSpy ;
  - `pos.ttb` : cache des durées IGDB (`{n, h, c, t}` ou `{t}` si inconnu) ;
  - `pos.last` : dernier profil saisi.
- **Lien partageable** : `?u=<profil>` charge directement un profil.

## État actuel
- ✅ Code complet. Les tests du relais passent (`npm test`, 16 tests).
- ✅ Déployé sur https://pile-of-shame.lucasbeauvais.workers.dev (Cloudflare Workers Builds, déploiement à chaque push sur `main`). Testé en réel par Lucas : profil et recos OK.
- 🆕 Tendances (`/api/players`, `/api/charts`) : vérifiées seulement avec des données simulées, la forme réelle de `GetMostPlayedGames` reste à confirmer.
- ✅ Moteur de reco vérifié sur des données d'exemple.

## À faire (dans l'ordre)
1. Créer le dépôt GitHub `pile-of-shame` et pousser le code : `git init`, `gh repo create pile-of-shame --private --source=. --push`.
2. Déployer :
   - soit en CLI : `npm install`, `npx wrangler login`, `npx wrangler secret put STEAM_API_KEY`, `npx wrangler deploy` ;
   - soit via le dashboard : Workers & Pages, puis Import a repository (déploiement automatique à chaque push).
3. Tester en réel avec un profil public : vérifier la forme des réponses SteamSpy, le temps d'analyse et l'affichage des jaquettes.
4. Pistes d'amélioration :
   - ~~**Durée plus juste**~~ : fait avec IGDB (`/api/ttb`). Un labo à base de durées de référence a été essayé puis retiré : Lucas veut des données qui marchent pour tout le monde sans saisie.
   - **Rate limiting par IP** sur `/api/meta`, pour ménager SteamSpy.
   - **Repli quand SteamSpy est indisponible** : Steam Store `appdetails` pour les genres et catégories (single-player / co-op).
   - **Mode « à deux »** : croiser deux profils pour trouver un jeu coop possédé par les deux.

## Conventions
- JS vanilla, pas de framework ni de bundler. La page reste un fichier unique.
- Thème sombre unique (palette dans `:root`). Interface en français, tutoiement.
- Les messages d'erreur expliquent quoi faire, sans jargon.

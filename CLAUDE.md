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
  - Interroge SteamSpy `appdetails` et renvoie `{meta:{appid:{tags[], median, average, pos, neg}|null}}`.
  - `median` et `average` sont en minutes de temps joué par les possesseurs.
  - Résultats mis en cache 30 jours via `caches.default`.
  - Requêtes SteamSpy espacées d'1 seconde, comme l'exige leur limite de débit.

### Secret
`STEAM_API_KEY`, à définir via `wrangler secret put STEAM_API_KEY` ou dans le dashboard Cloudflare.
⚠️ Ne jamais la committer. Pour le développement local, la mettre dans `.dev.vars` (déjà dans `.gitignore`).
⚠️ L'ancienne clé de Lucas a été exposée dans une conversation : **la révoquer et en générer une nouvelle** sur https://steamcommunity.com/dev/apikey.

## Logique de reco (dans public/index.html)
- **Candidats** : jeux avec moins de 2 h de jeu, sauf ceux marqués fini, pas intéressé ou en cours, et sauf ceux masqués pour la session.
- **Exclusions automatiques** :
  - logiciels (tags Utilities, Software…) ;
  - mode coop : uniquement les jeux avec un tag Co-op, Online Co-Op, Local Co-Op ou Split Screen ;
  - mode solo : on retire les jeux MMO et ceux tournés vers le PvP sans tag Singleplayer ;
  - un tag marqué ✕ dans le top 5 des tags du jeu.
- **Affinité** : somme des tags des jeux joués plus de 2 h, pondérée par log(1 + heures) et par le rang du tag, puis normalisée sur 0–1. Les tags génériques (Indie, Singleplayer…) sont ignorés.
- **Score** :
  - avec un créneau choisi : `0.45·goûts + 0.22·avis + 0.33·durée` ;
  - sans créneau : `0.62·goûts + 0.38·avis` ;
  - le tout × 0.85 si le jeu a déjà été lancé.
- **Avis** : lissage bayésien `(pos + 7.5) / (pos + neg + 10)`.
- **Adéquation de durée** : 1 dans la fourchette, décroissance logarithmique en dehors, 0.45 si la durée est inconnue.
- **Ordre d'analyse** : les 15 jeux les plus joués d'abord (pour l'affinité), puis la pile, puis les 25 suivants. Les recos se mettent à jour à chaque lot de 10.
- **État utilisateur** dans le localStorage :
  - `pos.u.<steamid>` : statuts, préférences, filtres ;
  - `pos.meta` : cache des métadonnées ;
  - `pos.last` : dernier profil saisi.
- **Lien partageable** : `?u=<profil>` charge directement un profil.

## État actuel
- ✅ Code complet. Les tests du relais passent (`npm test`, 7 tests).
- ✅ Moteur de reco vérifié sur des données d'exemple.
- ❌ **Jamais testé contre les vraies API Steam et SteamSpy** (environnement sans réseau). C'est la première chose à faire.

## À faire (dans l'ordre)
1. Créer le dépôt GitHub `pile-of-shame` et pousser le code : `git init`, `gh repo create pile-of-shame --private --source=. --push`.
2. Déployer :
   - soit en CLI : `npm install`, `npx wrangler login`, `npx wrangler secret put STEAM_API_KEY`, `npx wrangler deploy` ;
   - soit via le dashboard : Workers & Pages, puis Import a repository (déploiement automatique à chaque push).
3. Tester en réel avec un profil public : vérifier la forme des réponses SteamSpy, le temps d'analyse et l'affichage des jaquettes.
4. Pistes d'amélioration :
   - **Durée plus juste** : SteamSpy sous-estime les longs jeux. Explorer une source « time to beat » fiable ou un ajustement entre `median` et `average`.
   - **Rate limiting par IP** sur `/api/meta`, pour ménager SteamSpy.
   - **Repli quand SteamSpy est indisponible** : Steam Store `appdetails` pour les genres et catégories (single-player / co-op).
   - **Mode « à deux »** : croiser deux profils pour trouver un jeu coop possédé par les deux.

## Conventions
- JS vanilla, pas de framework ni de bundler. La page reste un fichier unique.
- Thème sombre unique (palette dans `:root`). Interface en français, tutoiement.
- Les messages d'erreur expliquent quoi faire, sans jargon.

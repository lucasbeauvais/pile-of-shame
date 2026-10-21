# Pile of Shame — brief projet

## Objectif
Outil web public et gratuit : n'importe qui colle l'URL de son profil Steam public et obtient une recommandation du **prochain jeu de sa bibliothèque à lancer**. La reco tient compte :
- du **temps disponible** : une soirée (< 5 h), quelques soirées (5–15 h), un gros morceau (15–40 h), un monde où vivre (40 h +) ;
- du **mode** : solo, coop ou peu importe ;
- de ses **goûts**, devinés depuis ses jeux les plus joués et ajustables par tags (♥ / ✕).

Le problème de départ : on possède trop de jeux, on n'a aucune visibilité sur son catalogue et on ne sait jamais quoi lancer.

Langues de l'interface : **français** et **anglais** (voir « Langue » plus bas).

## Architecture
Un seul **Cloudflare Worker** sert à la fois la page statique et l'API.

```
public/index.html   page unique (HTML + CSS + JS vanilla, aucune dépendance)
public/robots.txt   tout autorisé (Content-Signal search/ai-input/ai-train = yes), y compris GPTBot, ClaudeBot, PerplexityBot, Google-Extended
src/worker.js       relais API, la clé Steam reste côté serveur
wrangler.jsonc      config Worker + static assets (binding ASSETS)
test/worker.test.js tests node:test du relais (npm test)
```

### Endpoints
- `GET /api/profile?u=<url|pseudo|steamid64>`
  - Résout le pseudo (`ResolveVanityURL`), puis appelle `GetOwnedGames` et `GetPlayerSummaries`.
  - Renvoie `{steamid, persona, avatar, games:[{appid,name,playtime(min),lastPlayed}]}`.
  - Erreurs : 400 entrée non reconnue · 404 pseudo inconnu · 403 bibliothèque privée · 500 clé absente · 502 Steam indisponible.
- `GET /api/meta?ids=1,2,…` (50 maximum)
  - Renvoie `{meta:{appid:{tags[], median, average, pos, neg, ccu, ctrl, deck, age, mature, v}|null}}`.
  - `age` (`ageOf`) : âge minimum d'après les classifications de la fiche (`include_ratings`) : PEGI, sinon ESRB (EC/E 3, E10+ 10, T 13, M 17, AO 18), sinon USK, sinon `required_age` ; `null` si inconnu. `mature` : `content_descriptorids` contient 1, 2, 3 ou 4 (nudité, violence / gore, contenu sexuel).
  - `ctrl` : manette `'full'` (catégorie Steam 28), `'partial'` (18), `'none'` (Steam a répondu sans) ou `null` (inconnu ; repli sur les tags « Full controller support » / « Controller »). `deck` : `platforms.steam_deck_compat_category` (3 vérifié, 2 jouable, 1 non pris en charge, 0 inconnu) ou `null`. Demandés via `include_platforms` et `include_basic_info`.
  - `v` (`META_V` côté page, actuellement 3) : version des fiches ; la page redemande une fois les fiches de son cache plus anciennes. Monter `v` dans le Worker **et** `META_V` dans la page quand on ajoute un champ.
  - Source principale : `IStoreBrowseService/GetItems` (tout le lot en **une** requête, `include_tag_count: 20`, `include_reviews`), noms des tags via `IStoreService/GetTagList` (cache 7 jours). Avis = `review_count` × `percent_positive`. `median`, `average` et `ccu` valent 0 pour ces jeux.
  - Secours SteamSpy `appdetails` pour les jeux absents de Steam : 3 au plus par appel (`SPY_FALLBACK`), espacés d'1 seconde. Là, `median`/`average` sont en minutes de temps joué par les possesseurs et `ccu` est le pic de joueurs simultanés de la veille.
  - Pourquoi : SteamSpy seul (1 requête/s) demandait ~25 min pour une bibliothèque de 1 500 jeux ; c'est maintenant une trentaine de requêtes.
  - Pas de cache par jeu côté Worker : le navigateur garde les résultats (`pos.meta`).
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
- **🧒 Kid friendly** (`kids`, 3ᵉ option de « Quels jeux inclure ? », `kidOk`) : rien au-dessus de PEGI 10 (`KID_MAX_AGE`). Exclut `mature`, les tags adultes (`KID_BAD_TAGS` : Gore, Violent, Horror, Nudity…). Sans `age` connu, seulement les jeux tagués « Family Friendly ». Pastille « 🧒 N ans et + » / « 🧒 Family Friendly ». Vaut aussi pour Ça bouge et le Versus.
- **Tu as envie de quoi ?** (`mood` : peu importe / 😌 chill / 🍿 casual / 💀 hardcore / 🏆 compétitif / 🔁 grind, `MOODS`, `moodFit`) : devinée depuis les tags Steam. Chaque envie a des tags `pos` (au moins un dans les 10 premiers tags du jeu, pondérés par leur rang) et `neg` (un seul dans les 6 premiers exclut le jeu ; ex. « Difficult » jamais en chill). Facteur de score `0.9 + 0.1·min(poids, 2)`. Jeu sans tags exclu quand une envie est choisie. Les tags qui collent sont affichés dans l'explication de la carte. Vaut aussi pour Ça bouge et le Versus.
- **Comment tu joues ?** (`device` : peu importe / clavier-souris / manette / Steam Deck, `deviceFit`) :
  - clavier-souris : aucun filtre (tous les jeux PC) ;
  - manette : exclut `ctrl: 'none'` ; facteur de score 1 (complète), 0,8 (partielle), 0,85 (inconnu) ;
  - Steam Deck : exclut `deck: 1` (non pris en charge) ; facteur 1 (vérifié), 0,9 (jouable), 0,75 (inconnu) ;
  - s'applique aussi à Ça bouge et au Versus ; pastille manette / Steam Deck sur les cartes quand ce mode est choisi.
- **Exclusions automatiques** :
  - logiciels (tags Utilities, Software…) ;
  - mode coop : uniquement les jeux avec un tag Co-op, Online Co-Op, Local Co-Op ou Split Screen ;
  - mode solo : on retire les jeux MMO et ceux tournés vers le PvP sans tag Singleplayer ;
  - un tag marqué ✕ dans le top 5 des tags du jeu.
- **Tes goûts** (`renderTags`) : tous les genres de la pile (8 premiers tags de chaque jeu, hors fini / écarté, hors génériques), avec le nombre de jeux concernés. Ordre : ♥ / ✕ choisis, puis affinité, puis nombre de jeux. 16 visibles (`TAGS_SHOWN`), le reste derrière « Voir tous les genres », avec une recherche.
- **Temps de jeu masqué** (`renderNote`) : si tous les jeux sont à 0 h (au moins 10 jeux), le profil a coché « Toujours garder mon temps de jeu total privé » dans Steam. Un message l'explique ; l'affinité est vide et seuls les ♥ comptent. Sans rapport avec les durées.
- **Durées** : depuis le passage de `/api/meta` sur Steam, elles viennent presque toutes d'IGDB. Sans `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`, la plupart s'affichent « Durée inconnue ».
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
- **Bouton affilié Instant Gaming** (`.ig`, entre le Versus et « Ça bouge en ce moment ») : bouton compact centré, dégradé orange #ff5400 → jaune-orangé #ffa000 avec sous-titre jaune pâle, « Encore des jeux que je lancerai pas ! » / « More games I'll never launch! », mention « lien affilié » / « affiliate link » en petit gris. Lien affilié de Lucas dans `IG_URL`, `rel="sponsored noopener"`.
- **Stats du haut** : cliquables, elles ouvrent « Toute ta pile » sur la bonne vue : jeux possédés (toute la bibliothèque, par nom), jamais lancés, heures au compteur (tri par temps de jeu), marqués finis (bouton « Pas fini finalement »).
- **Toute ta pile** : vues recos / toute la bibliothèque / jamais lancés / finis / écartés / en cours ; tris pertinence / duels / plus courts / temps de jeu / nom. Les jeux finis, écartés ou en cours peuvent être démarqués.
- Plus de bouton « C'est parti » (retiré à la demande de Lucas) ; le statut « en cours » ne reste que pour les jeux déjà marqués.
- **Liens d'un jeu** (`linksHTML`) : Lancer dans Steam, Voir la page du jeu (`/api/site`), Page Steam, plus HowLongToBeat (recos) ou la courbe de joueurs (tendances).
- **Ordre d'analyse** : les 15 jeux les plus joués d'abord (pour l'affinité), puis la pile, puis les 25 suivants. Les recos se mettent à jour à chaque lot de 50.
- **État utilisateur** dans le localStorage :
  - `pos.u.<steamid>` : statuts, préférences, filtres, notes des duels ;
  - `pos.meta` : cache des métadonnées SteamSpy ;
  - `pos.ttb` : cache des durées IGDB (`{n, h, c, t}` ou `{t}` si inconnu) ;
  - `pos.last` : dernier profil saisi.
- **Lien partageable** : `?u=<profil>` charge directement un profil.

## État actuel
- ✅ Code complet. Les tests du relais passent (`npm test`, 22 tests).
- ✅ Déployé sur https://pile-of-shame.lucasbeauvais.com (aussi https://pile-of-shame.lucasbeauvais.workers.dev ; Cloudflare Workers Builds, déploiement à chaque push sur `main`). Testé en réel par Lucas : profil et recos OK.
- 🆕 Âge (`ratings`, `content_descriptorids` de `GetItems`) : format écrit de mémoire, testé avec des données simulées. Si Steam ne renvoie pas les classifications, kid friendly ne garde que les jeux « Family Friendly ».
- 🆕 Manette / Steam Deck (`categories`, `platforms` de `GetItems`) : noms de champs écrits de mémoire, testés avec des données simulées. Si Steam ne les renvoie pas, les jeux restent proposés avec « non précisé » / « non testé ».
- 🆕 `/api/meta` via `IStoreBrowseService/GetItems` : forme de la réponse écrite de mémoire, vérifiée seulement avec des données simulées. Si Steam ne répond pas comme prévu, tout retombe sur SteamSpy (lent).
- 🆕 Tendances (`/api/players`, `/api/charts`) : vérifiées seulement avec des données simulées, la forme réelle de `GetMostPlayedGames` reste à confirmer.
- ✅ Moteur de reco vérifié sur des données d'exemple.

## À faire
- ✅ Dépôt GitHub `lucasbeauvais/pile-of-shame`, déploiement Cloudflare Workers Builds (push sur `main` = mise en ligne), domaine perso.
- À vérifier en réel (jamais testé contre les vraies API depuis l'environnement de dev, sans réseau) :
  - `/api/meta` via `GetItems` : l'analyse d'une bibliothèque de 1 500 jeux doit prendre quelques secondes. Si c'est lent, la réponse Steam n'a pas la forme attendue et tout retombe sur SteamSpy.
  - `/api/ttb` : secrets Twitch en place ? `GET /api/ttb?ids=1245620,620` doit renvoyer `status: ok`.
  - `/api/charts` (forme de `GetMostPlayedGames`) et `/api/site` (redirection vers le site officiel).
  - `robots.txt` sur le domaine perso : vérifier que le robots.txt géré par Cloudflare ne s'ajoute pas en bloquant des crawlers d'IA.
- Pistes :
  - **Rate limiting par IP** sur `/api/meta`.
  - **Mode « à deux »** : croiser deux profils pour trouver un jeu coop possédé par les deux.
  - `og:image` pour les partages.

## SEO / GEO
- URL canonique : **https://pile-of-shame.lucasbeauvais.com/** (canonical, `og:url`, JSON-LD). L'URL workers.dev reste joignable.
- L'appli (`<main id="app">`) est rendue en JS : les crawlers ne la voient pas. Ce qui est lisible sans JS est donc écrit **en dur** dans `public/index.html` :
  - footer : « Side project de Lucas Beauvais · LinkedIn » (nom → https://lucasbeauvais.com/, LinkedIn → https://fr.linkedin.com/in/lucas-beauvais) et la ligne des sources de données ;
  - bloc `#about`, **tout en bas, après le footer**, volontairement discret (12 px, gris, sans cartes) : « C'est quoi, la pile de la honte ? », « Comment ça marche », « Qui est derrière ». Visible quand même, pour ne pas ressembler à du texte caché.
  - Ces blocs portent `data-i18n="clé"` : en français dans le HTML d'origine, `applyLang()` les traduit quand la page passe en anglais. Modifier le texte = modifier le HTML **et** les clés `fr` / `en`.
- `<head>` : canonical, Open Graph (pas d'`og:image`, aucune image dans le projet), `meta author`, JSON-LD `@graph` = `WebApplication` (auteur → `#lucas`) + `Person` (`#lucas`, `sameAs` LinkedIn).
- `robots.txt` : tout autorisé, `Content-Signal: search=yes, ai-input=yes, ai-train=yes`, plus des groupes explicites pour GPTBot, ClaudeBot, PerplexityBot, Google-Extended.
- Seul bouton affilié : Instant Gaming (pas de Humble).

## Langue
- Dictionnaire `I18N = {fr, en}` en tête du script, fonction `t(clé, {variables})`. Tout texte affiché passe par `t()`, y compris les messages d'erreur du serveur, traduits côté page à partir de leur code (`err.<error>`).
- Détection : `pos.lang` si l'utilisateur a choisi, sinon français pour tout navigateur en français (fr-FR, fr-BE, fr-CH, fr-CA…), anglais pour tous les autres.
- Bouton 🇬🇧 EN / 🇫🇷 FR dans l'en-tête, à côté de « Changer de profil » ; il re-rend toute la page.
- Nombres et tris selon la langue (`toLocaleString(LANG)`, `localeCompare(…, LANG)`), virgule décimale en français. Les noms de genres restent ceux de Steam (anglais).
- Ajouter un texte = ajouter la clé dans `fr` **et** `en`.

## Conventions
- JS vanilla, pas de framework ni de bundler. La page reste un fichier unique.
- Thème sombre unique (palette dans `:root`). Français : tutoiement. Anglais : ton direct et décontracté.
- Les messages d'erreur expliquent quoi faire, sans jargon.

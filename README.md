# Pile of Shame

Colle l'URL de ton profil Steam et découvre à quel jeu de ta bibliothèque jouer ensuite, selon le temps dont tu disposes et tes goûts.

## Comment ça marche

- **Ta bibliothèque** est lue via l'API officielle Steam (le profil doit avoir « Détails des jeux » en public).
- **Tes goûts** sont devinés à partir des tags SteamSpy de tes jeux les plus joués, pondérés par ton temps de jeu. Tu peux les ajuster : ♥ pour en vouloir plus, ✕ pour écarter.
- **La durée** d'un jeu est le temps médian joué par ses possesseurs (SteamSpy). C'est une estimation, pas un « temps pour finir ».
- **Le score** combine l'affinité avec tes goûts, l'adéquation au temps disponible et les avis Steam. Il favorise les jeux jamais lancés.
- Tes choix (« Déjà fini », « Pas intéressé »…) restent dans ton navigateur. Le serveur ne stocke rien sur toi.

## Structure

```
public/index.html   la page (HTML, CSS et JS dans un seul fichier)
src/worker.js       le relais : /api/profile et /api/meta, la clé Steam reste ici
wrangler.jsonc      la configuration Cloudflare
test/               les tests du relais (npm test)
```

## Mise en ligne (gratuite, environ 15 minutes)

### 1. Une clé API Steam neuve
1. Va sur https://steamcommunity.com/dev/apikey.
2. Si une clé existe déjà et a circulé quelque part, clique sur **Révoquer**.
3. Crée une nouvelle clé. Comme nom de domaine, mets `pile-of-shame.workers.dev` (Steam ne le vérifie pas).
4. Garde la clé de côté pour l'étape 3. Elle ne doit **jamais** aller dans le code ni dans GitHub.

### 2. Le dépôt GitHub
1. Sur https://github.com/new, crée un dépôt `pile-of-shame` (public ou privé, au choix).
2. Clique sur **uploading an existing file** et glisse **le contenu** du dossier (les dossiers `public`, `src`, `test` et les fichiers à la racine), puis **Commit changes**.

### 3. Le déploiement Cloudflare
1. Crée un compte gratuit sur https://dash.cloudflare.com/sign-up.
2. Va dans **Workers & Pages**, puis **Create**, puis **Import a repository**. Connecte ton compte GitHub et choisis `pile-of-shame`.
3. Laisse les réglages par défaut (deploy command : `npx wrangler deploy`) et clique sur **Deploy**.
4. Une fois déployé, ouvre le Worker, puis **Settings** et **Variables and Secrets**, puis **Add** :
   - Type : **Secret**
   - Nom : `STEAM_API_KEY`
   - Valeur : ta clé de l'étape 1
5. Enregistre. Ton outil est en ligne sur `https://pile-of-shame.<ton-sous-domaine>.workers.dev`.

Chaque modification poussée sur GitHub redéploie automatiquement le site.

### Astuce partage
Tu peux envoyer un lien qui charge directement un profil :
`https://pile-of-shame.<ton-sous-domaine>.workers.dev/?u=https://steamcommunity.com/id/tonpseudo`

## Développement local

```bash
npm install
echo "STEAM_API_KEY=ta_cle" > .dev.vars   # ignoré par git
npm run dev                                # http://localhost:8787
npm test
```

## Limites connues

- **Première analyse lente pour les grosses bibliothèques.** SteamSpy autorise une requête par seconde, donc 300 jeux jamais vus prennent environ 5 minutes. Les infos sont ensuite gardées en cache 30 jours, pour tout le monde, et dans le navigateur. Les recos s'affichent au fil de l'analyse.
- **Des durées parfois absentes ou trop basses.** Pour les jeux peu connus, SteamSpy n'a pas toujours de données. Le temps médian sous-estime aussi les longs jeux que beaucoup abandonnent. Le lien HowLongToBeat de chaque carte permet de vérifier.
- **Aucune limite d'usage sur le relais.** Si l'outil devient populaire, on pourra ajouter une limite par IP (Cloudflare Rate Limiting) pour ménager SteamSpy.

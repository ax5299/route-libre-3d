# Route Libre 3D

**Jouer : https://route-libre-3d.vercel.app/**

Prototype de conduite arcade en 3D dans le navigateur (Babylon.js + Vite + TypeScript).

## Lancer le jeu

```bash
npm install      # une seule fois
npm run dev      # puis ouvrir http://127.0.0.1:5173/
```

> **Ne jamais ouvrir `index.html` par double-clic.** En `file://`, le navigateur
> refuse les modules ES (politique CORS) : le jeu ne démarre pas et la page reste
> sur « Préparation du circuit… ». Si cela arrive, la page affiche maintenant la
> marche à suivre.

## Commandes

| Commande            | Effet                                                        |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | serveur de développement, http://127.0.0.1:5173/             |
| `npm run build`     | vérifie les types puis génère le paquet statique dans `dist/` |
| `npm run preview`   | sert `dist/` sur http://127.0.0.1:4173/ (le build doit exister) |
| `npm run typecheck` | `tsc --noEmit` seulement                                      |
| `npm run smoke`     | parcours le jeu dans un vrai navigateur et écrit dans `.smoke/` |
| `npm run steer`     | vérifie le sens de braquage (cap, trajectoire, roues, roulis) dans `.smoke/` |

`npm run smoke` suppose que `npm run dev` tourne déjà (ou pointe `SMOKE_URL` vers une
autre adresse, par exemple `SMOKE_URL=http://127.0.0.1:4173/ npm run smoke`).
Il en va de même pour `npm run steer`.

### Sens de la direction

Le cap `heading` suit la convention de la piste : avant `(cos h, 0, sin h)` et normale
**gauche** `(-sin h, 0, cos h)`. Dans le repère main-gauche de Babylon, augmenter
`heading` tourne donc vers la gauche ; c'est la constante `HEADING_SIGN`
(`src/game/vehicle.ts`) qui convertit un braquage positif (« à droite », roues avant
vers `+x`) dans ce sens. `npm run steer` maintient `→` puis `←` et vérifie que le cap,
la trajectoire, les roues avant et le roulis de caisse suivent bien — le rapport complet
est écrit dans `.smoke/steer-check.json`.

## En cas d'écran figé

1. Vérifier l'adresse dans la barre du navigateur : elle doit commencer par
   `http://127.0.0.1:` et non `file:///`.
2. Vérifier que le serveur écoute : `Get-NetTCPConnection -State Listen -LocalPort 5173`.
3. Rechargement forcé `Ctrl + Maj + R` (cache Vite périmé), puis regarder la console
   `F12` et le terminal de Vite.
4. Contrôle complet automatisé : `npm run smoke` lit `.smoke/report.json`.

## Conduite

Flèches ou `ZQSD` / `WASD` : gaz, frein, direction · `Espace` : frein à main ·
`C` : caméra · `R` : remettre sur la piste · `Échap` : pause · manette prise en
charge automatiquement dès qu'un bouton est pressé.

## Publication

Dépôt GitHub : https://github.com/ax5299/route-libre-3d

Le projet Vercel `route-libre-3d` utilise Node.js 22, `npm ci`, puis
`npm run build`. Le dossier publié est `dist/`.

Une fois le dépôt connecté à Vercel, les changements poussés sur `main`
sont déployés automatiquement.

Les réglages et records sont enregistrés dans le navigateur de chaque joueur.

### État de publication — 27 octobre 2026

- Dépôt public et site Vercel publiés.
- Build et test navigateur sur le site public : 24/24 contrôles, aucune erreur console.
- Liaison automatique GitHub → Vercel en attente de l’autorisation du dépôt
  `ax5299/route-libre-3d` dans l’application GitHub Vercel.
- Les deux projets Piscari existants restent indépendants de ce projet.

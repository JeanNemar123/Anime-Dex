# AnimeDex

Catalogue d’animés (données AniList) avec favoris, vus, « à regarder », progression des épisodes, statistiques, bandes-annonces, **comptes (pseudo + mot de passe)** et **synchronisation entre appareils**. Installable sur téléphone (PWA).

## Lancer en local
Node 22.13 ou plus récent, aucune dépendance à installer :

    node server.js

Puis ouvre http://localhost:3000. Les comptes sont stockés dans `data/animedex.db` (SQLite).

## Mettre en ligne
Le serveur a besoin d’un **stockage persistant** pour `DB_PATH` (par défaut `/data/animedex.db` dans Docker) et d’**HTTPS** (fourni par la plupart des hébergeurs). Options : Fly.io (volume), Railway (volume), Render (disque payant), ou un VPS avec Docker.

    docker build -t animedex .
    docker run -p 3000:3000 -v animedex-data:/data animedex

Variables : `PORT` (3000), `DB_PATH`, `TRUST_PROXY=1` si le serveur est derrière un proxy (pour limiter les tentatives de connexion par IP réelle).

## GitHub
Le workflow `.github/workflows/docker.yml` vérifie le code puis publie l’image Docker sur `ghcr.io/<ton-compte>/<repo>:latest` à chaque push sur `main`. Ton hébergeur peut ensuite la déployer.

## Fabriquer l’APK (Android)
1. Pousse le projet sur GitHub.
2. Onglet **Actions** → **Build APK** → **Run workflow**. Tu peux y saisir l’adresse HTTPS de ton serveur, ou la définir une fois dans *Settings → Variables → Actions* (`SERVER_URL`).
3. Quand c’est vert, télécharge `animedex-apk` en bas de la page du run, dézippe, puis installe `app-debug.apk` sur ton téléphone (autorise l’installation d’apps inconnues).

Si tu n’as pas défini le serveur, l’appli demande son adresse dans la fenêtre « Compte ». Le serveur doit être en **HTTPS** et accepter l’appli (`CORS_ORIGINS`, par défaut `https://localhost,capacitor://localhost,http://localhost`). L’APK produit est un APK de test (« debug ») : parfait pour un usage perso, mais pas publiable sur le Play Store tel quel.

## Installer sur téléphone (sans APK)
Ouvre le site en HTTPS dans Chrome (Android) ou Safari (iOS) puis « Ajouter à l’écran d’accueil ».

## Sécurité et limites
- Mots de passe hachés avec scrypt et sel ; sessions de 90 jours ; 20 tentatives de connexion par 10 minutes et par IP.
- Aucune récupération de mot de passe (pas d’e-mail). Sauvegarde le fichier de base de données.
- Synchronisation : le serveur garde la dernière version ; en cas de modifications simultanées sur deux appareils, les listes sont fusionnées (une suppression faite en même temps peut réapparaître).
- Les données d’animés viennent d’AniList : respecte leurs conditions d’utilisation si tu rends le site public.

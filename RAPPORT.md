# RAPPORT — TP DevSecOps

> **Auteur** : Samantha THIEBAUT
> **Date** : 2026-05-22

---

## ÉTAPE 1 — Conteneurisation Docker

### Question 1 : Pourquoi utilise-t-on un multi-stage build plutôt qu'un seul `FROM` ?

En gros, le multi-stage build sert à avoir une image finale la plus légère possible. Dans notre Dockerfile on a 3 stages :

- `deps` : on installe tous les node_modules
- `builder` : on compile l'app Next.js et on génère le client Prisma
- `runner` : on récupère seulement ce qui est nécessaire pour faire tourner l'app

Du coup l'image finale ne contient pas les sources, pas les devDependencies, pas les outils de build. On passe d'une image qui pourrait faire plus d'1 Go à moins de 300 Mo. Et en bonus, moins y'a de trucs dans l'image, moins y'a de failles de sécu potentielles.

### Question 2 : Que fait `output: 'standalone'` dans `next.config.js` et comment Docker l'exploite-t-elle ?

Quand on met `output: 'standalone'`, Next.js génère un dossier `.next/standalone/` qui contient un `server.js` autonome + seulement les dépendances vraiment utilisées par l'app (il fait du tree-shaking sur les packages).

Dans le Dockerfile, le stage `runner` copie ce dossier standalone au lieu de tout le `node_modules` qui pèse des centaines de Mo. C'est pour ça que l'image reste petite et que le conteneur démarre vite.

### Question 3 : Pourquoi crée-t-on un utilisateur `nextjs` non-root ?

Par défaut dans Docker tout tourne en root. Le problème c'est que si quelqu'un arrive à exploiter une faille dans l'app, il se retrouve root dans le conteneur et peut faire pas mal de dégâts (modifier les fichiers système, tenter de s'échapper du conteneur, etc.).

En créant un user `nextjs` avec des droits limités et en faisant `USER nextjs`, l'app tourne avec le minimum de permissions nécessaires. C'est le principe du moindre privilège. Si l'app est compromise, l'attaquant ne peut toucher qu'aux fichiers qui appartiennent à cet utilisateur.

### Question 4 : À quoi sert `HEALTHCHECK` dans le Dockerfile ?

Le `HEALTHCHECK` c'est une commande que Docker lance régulièrement pour vérifier que l'app répond bien :

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
```

Concrètement : toutes les 30s, Docker appelle `/api/health`. Si ça ne répond pas en 3s, c'est compté comme un échec. Au bout de 3 échecs d'affilée, le conteneur passe en `unhealthy`. Ça laisse 10s au démarrage pour que l'app ait le temps de se lancer.

C'est utile parce que Docker Compose (avec `restart: unless-stopped`) peut redémarrer le conteneur automatiquement si l'app plante.

### Question 5 : Quel est l'avantage du volume `helpdesk-data` ?

Le volume `helpdesk-data` permet de stocker la base SQLite en dehors du conteneur. Sans ça, si on fait un `docker compose down` ou un rebuild, on perd toutes les données parce que le filesystem du conteneur est éphémère.

J'ai fait le test :
- `docker compose down` (sans `-v`) puis `docker compose up -d` → les tickets sont toujours là, le volume a survécu
- `docker compose down -v` → là par contre tout est supprimé parce que le `-v` détruit les volumes

C'est indispensable vu qu'on utilise SQLite, la DB est juste un fichier sur le disque.

---

## ÉTAPE 2 — Tests unitaires

### Question 6 : Couverture de code

J'ai ajouté 13 tests en plus des 13 de base, donc 26 au total. J'ai testé les permissions (`canEditTicket`, `canDeleteTicket`), le `loginSchema` et le `ticketUpdateSchema`.

Voici ce que j'obtiens sur `src/lib/` :

| Fichier | Stmts | Branch | Funcs | Lines |
|---------|-------|--------|-------|-------|
| auth.ts | 80% | 100% | 80% | 80% |
| permissions.ts | 81.81% | 87.5% | 100% | 81.81% |
| validators.ts | 100% | 100% | 100% | 100% |
| prisma.ts | 0% | 0% | 0% | 0% |

C'est pas à 100% partout et c'est normal :
- **auth.ts** : `getAuthFromRequest` est pas testée parce qu'elle utilise `NextRequest` et c'est galère à mocker dans un test unitaire basique.
- **permissions.ts** : le `return false` à la fin c'est un cas par défaut qui arrive jamais en vrai (rôle ni ADMIN, ni AGENT, ni USER).
- **prisma.ts** : c'est juste le client Prisma qui se connecte à la DB, y'a rien à tester unitairement là-dedans.

Pour les routes API et les pages React c'est à 0% mais c'est logique, on fait des tests unitaires sur les fonctions utilitaires, pas des tests d'intégration sur les endpoints.

---

## ÉTAPE 3 — Tests de montée en charge avec k6

### Question 7 : Que signifient les métriques `http_req_duration`, `http_req_failed`, `iterations` ?

- **http_req_duration** : c'est le temps que met chaque requête HTTP du début à la fin (envoi + attente + réception). On a le avg, le min, le max et les percentiles (p90, p95). C'est la métrique principale pour savoir si l'app est rapide ou pas.
- **http_req_failed** : c'est le pourcentage de requêtes qui ont échoué (status 4xx/5xx ou timeout). Dans mon smoke test c'était à 0%, donc tout allait bien.
- **iterations** : c'est le nombre de fois que la fonction de test a été exécutée en entier. Chaque itération fait plusieurs requêtes (healthcheck + list tickets + create ticket dans le load test).

### Question 8 : Que se passe-t-il si on coupe l'app pendant le smoke test ?

Si on coupe l'app (genre `docker compose down`) pendant que k6 tourne, toutes les requêtes vont échouer avec des erreurs de connexion (connection refused). Le `http_req_failed` va monter à 100% et les thresholds vont être dépassés. k6 va finir par s'arrêter avec des erreurs partout.

### Question 9 : p95 et seuil

Mon p95 sur le load test est de **1612 ms**. Le seuil défini dans le script est `p(95)<500`, donc il est **dépassé**. L'erreur `thresholds on metrics 'http_req_duration' have been crossed` le confirme. L'app n'arrive pas à tenir la charge à 50 VUs.

### Question 10 : Taux d'erreur et RPS

- **Taux d'erreur** : 0.00%, aucune requête n'a échoué, l'app répond toujours mais lentement.
- **Requêtes totales** : 11017 en 4 minutes, ça fait environ **46 RPS**.
- **Itérations** : 3672 (chaque itération fait 3 requêtes : health + list + create).

Le problème c'est pas les erreurs, c'est la latence qui explose quand y'a trop d'utilisateurs en même temps. SQLite gère mal les accès concurrents en écriture.

### Question 11 : Utilisation CPU/RAM au pic

Pendant le load test, j'ai lancé `docker stats helpdesk-app` dans un autre terminal. Au pic de charge (50 VUs) :
- **CPU** : ~1650% (ça parait énorme mais c'est parce que Docker affiche le % par core, donc sur ma machine avec plusieurs cores ça monte vite)
- **RAM** : ~580 MiB

Ça montre que l'app consomme pas mal de ressources sous charge. Le CPU explose surtout à cause des écritures SQLite qui bloquent les unes les autres (pas de vrai accès concurrent en écriture avec SQLite).

---

## ÉTAPE 4 — Sécurité

### Question 12 : Vulnérabilités `npm audit`

J'ai lancé `npm audit` et j'ai **11 vulnérabilités** au total : 7 moderate et 4 high. Pas de critique.

Les principales :
- **Next.js (14.2.33)** : y'a plein de CVE dessus, surtout des DoS via les Server Components et du cache poisoning. Par exemple GHSA-mwv6-3258-q52c, un attaquant peut envoyer des requêtes bizarres qui font planter les Server Components → l'app devient inaccessible. C'est corrigé dans Next 14.2.34 mais on est bloqué sur la 14.2.33.
- **glob (10.4.2)** — CVE-2025-64756 : c'est une injection de commande via des noms de fichiers malicieux. En gros si l'app traite des fichiers avec des noms spéciaux ça peut exécuter du code.

### Question 13 : Vulnérabilités Trivy vs npm audit

Trivy trouve **18 vulnérabilités HIGH** dans l'image Docker. Ce qui est intéressant c'est que certaines apparaissent pas du tout dans `npm audit` :

- **cross-spawn (7.0.3)** — CVE-2024-21538 : un ReDoS (l'attaquant envoie une string qui fait boucler la regex). C'est utilisé par npm dans l'image, pas par notre app directement.
- **tar (6.2.1)** : 6 CVEs, que des failles de path traversal. Un attaquant pourrait écraser des fichiers en créant des archives piégées. Ça vient de npm dans `/usr/local/lib/node_modules/npm/`.
- **minimatch (9.0.5)** : 3 CVEs de DoS, des regex qui partent en boucle infinie avec certains patterns.

En fait ces failles viennent pas de notre code, elles sont dans **l'image de base node:20-alpine** et dans les outils pré-installés (npm, yarn). `npm audit` les voit pas parce qu'il regarde que les dépendances de notre `package.json`, pas ce qui est installé dans l'OS de l'image Docker.

### Exercice 4.3.1 — JWT secret faible

J'ai récupéré mon token USER via `localStorage.getItem('token')` dans la console du navigateur. Sur jwt.io, j'ai vu le payload en clair avec `"role": "USER"`.

Le truc c'est que le secret dans `.env.example` est `change-me-in-production-use-a-strong-secret-key-please`, et c'est le même qui est utilisé. Du coup j'ai changé le rôle en `"ADMIN"`, resigné avec ce secret, et avec le nouveau token j'ai pu :
- Voir **tous** les tickets (alors que normalement un USER voit que les siens)
- **Supprimer** un ticket avec `DELETE /api/tickets/<id>` → ça renvoie `{"ok":true}`

Ça marche parce que l'app vérifie juste la signature du JWT et fait confiance au rôle qui est dedans sans vérifier en base.

**3 trucs à faire pour corriger ça :**
1. Mettre un vrai secret aléatoire et long (avec `openssl rand -base64 64` par exemple), pas le même que celui de l'example
2. Vérifier le rôle en base de données à chaque requête importante, pas juste se fier au JWT
3. Réduire la durée du token (1h au lieu de 7 jours) et utiliser des refresh tokens

### Exercice 4.3.2 — IDOR (Authorization bypass)

J'ai testé en tant que `user@helpdesk.io` d'accéder au ticket d'un autre utilisateur et j'ai eu un 403 Forbidden. L'API est bien protégée contre l'IDOR.

Dans le code (`src/app/api/tickets/[id]/route.ts` lignes 28-29) :

```typescript
if (auth.role === 'USER' && ticket.authorId !== auth.userId) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

En gros, un USER peut voir/modifier que ses propres tickets. Les AGENT et ADMIN voient tout, ce qui est normal pour le support.

### Exercice 4.3.3 — Headers de sécurité manquants

J'ai fait `curl -I http://localhost:3000` et voilà ce que j'ai eu :

```
HTTP/1.1 200 OK
Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Accept-Encoding
x-nextjs-cache: HIT
Cache-Control: s-maxage=31536000, stale-while-revalidate
Content-Type: text/html; charset=utf-8
```

### Question 16 : Headers manquants

Y'a aucun header de sécurité, il manque :
- **Content-Security-Policy (CSP)** : ça empêche le chargement de scripts non autorisés, ça protège contre le XSS
- **X-Frame-Options** : ça empêche quelqu'un de mettre notre site dans une iframe pour faire du clickjacking
- **Strict-Transport-Security (HSTS)** : ça force le HTTPS, comme ça même si quelqu'un tape http:// il est redirigé
- **X-Content-Type-Options** : ça empêche le navigateur de deviner le type de fichier, sinon il pourrait exécuter un fichier malicieux

Pour corriger ça on peut ajouter un middleware Next.js :

```typescript
// src/middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");

  return response;
}
```

---

## ÉTAPE 5 — CI/CD GitHub Actions

### Question 17 : Pourquoi le job `deploy` a `needs: [test, security, docker]` ?

C'est pour dire que le deploy ne se lance que si les 3 autres jobs ont réussi avant. Ça évite de déployer en prod du code qui a des tests qui cassent, des failles de sécu, ou une image Docker qui build pas. C'est un peu le principe du pipeline : chaque étape valide quelque chose, et si ça passe pas on déploie pas.

### Question 18 : Que fait `if: github.ref == 'refs/heads/main'` ?

Ça fait que le job `deploy` se lance **uniquement** quand on push sur la branche `main`. Si on push sur `develop` ou sur une autre branche, les jobs test/security/docker tournent mais le deploy est skip. C'est logique parce qu'on veut pas déployer en prod à chaque commit sur une branche de dev.

### Question 19 : `continue-on-error: true` est-ce une bonne pratique ?

C'est utilisé sur le job `security` (npm audit et Trivy). Ça veut dire que même si l'audit trouve des vulnérabilités, le pipeline continue et passe pas en rouge.

C'est pratique pour pas bloquer le développement quand y'a des vulnérabilités dans des dépendances qu'on peut pas forcément corriger tout de suite (genre Next.js 14 qui a des CVE mais on peut pas migrer vers la 15 en 5 min). Mais c'est pas top comme pratique parce que du coup on peut ignorer des failles critiques sans s'en rendre compte. L'idéal ce serait de mettre `continue-on-error: false` et de gérer les exceptions au cas par cas, ou de filtrer par niveau de sévérité.

---

## ÉTAPE 6 — Déploiement Azure

L'app est déployée sur **Azure App Service** via **Azure Container Registry**.

- URL : https://helpdesk-st.azurewebsites.net
- Le healthcheck répond `{"status":"ok"}`
- On peut se connecter et créer des tickets

---

## Synthèse finale

### 1. Architecture finale

```
Dev local          GitHub              CI/CD                 Azure
─────────         ────────           ─────────            ──────────

 Code        ──>  git push   ──>   GitHub Actions    ──>  ACR (registry)
 Next.js           main             - test (lint+unit)      │
 Prisma                              - security (audit)      │
 SQLite                              - docker (build)        v
                                     - deploy           App Service (B1)
                                                         helpdesk-st
                                                        .azurewebsites.net
```

En gros : je code en local, je push sur GitHub, la CI lance les tests + l'audit sécu + le build Docker. Si tout passe et qu'on est sur main, ça pousse l'image sur Azure Container Registry et ça redéploie sur App Service.

### 2. 3 améliorations DevSecOps

1. **Azure Key Vault pour les secrets** : là le JWT_SECRET est en clair dans les app settings. Avec Key Vault on le stocke dans un coffre-fort chiffré et l'app le récupère au runtime. C'est plus sécurisé si quelqu'un accède au portail Azure.

2. **Monitoring avec Application Insights** : pour l'instant on a aucune visibilité sur ce qui se passe en prod. Avec App Insights on aurait les temps de réponse, les erreurs, l'utilisation CPU/RAM en temps réel, et des alertes si ça dépasse un seuil.

3. **Remplacer SQLite par PostgreSQL** : SQLite c'est bien pour le dev mais en prod ça gère pas les accès concurrents (on l'a vu avec k6, le p95 explose). Avec un vrai PostgreSQL (Azure Database for PostgreSQL) les perfs seraient bien meilleures et les données plus fiables.

### 3. Coût Azure estimé

- **App Service Plan B1** : ~13€/mois
- **Container Registry Basic** : ~5€/mois
- **Total** : ~18€/mois

Avec les 100$ de crédit étudiant, ça tient environ 5 mois. Pour le TP ça a coûté quasi rien vu que c'est quelques heures d'utilisation.

### 4. Difficultés rencontrées

- **Port 3000 occupé** : au début le serveur Next.js en mode dev bloquait le port, j'ai dû le kill avant de lancer le conteneur Docker.
- **Prisma dans le conteneur** : `npx prisma` téléchargeait la v7 alors que le projet utilise la v5.22. Il fallait préciser `npx prisma@5.22.0`.
- **bcryptjs manquant** : le build standalone de Next.js n'inclut pas bcryptjs, donc le seed crashait dans le conteneur. Il fallait l'installer manuellement.
- **Trivy via snap** : Trivy installé via snap avait un problème de sandbox et pouvait pas accéder aux fichiers Docker. J'ai dû le réinstaller via le script officiel.
- **SSH Azure** : impossible de SSH dans le conteneur sur App Service parce que notre image n'a pas de serveur SSH. J'ai contourné en ajoutant un script `start.sh` qui fait le migrate + seed au démarrage.
- **Settings Azure écrasés** : une commande `az webapp config appsettings set` écrasait les settings existants, il fallait tout remettre d'un coup.

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

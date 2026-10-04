# Wake-on-LAN Web UI

Interface web simple et légère pour **réveiller des machines par Wake-on-LAN**
et **vérifier leur connectivité** avec `ping`.

- Gestion des appareils : **nom + adresse MAC + adresse IP** (ajout, édition, suppression).
- Envoi du **paquet magique** (magic packet) en UDP ports 9 et 7, vers l'IP de
  l'appareil, l'adresse de diffusion globale et la diffusion du sous-réseau.
- **Ping** d'un appareil ou d'un hôte arbitraire, avec affichage du RTT.
- Frontend statique, backend **Node.js sans aucune dépendance externe**.

## Prérequis

- **Node.js ≥ 18** (aucun `npm install` nécessaire).
- La commande `ping` disponible (`iputils-ping` sur la plupart des distributions).
- Le **Wake-on-LAN activé** dans le BIOS/UEFI et la carte réseau des machines
  cibles. La machine qui héberge cette UI doit se trouver sur le **même réseau
  (L2)** que les machines à réveiller, sinon le paquet magique doit être relayé.

## Démarrage rapide

```bash
node server.js
```

Puis ouvrez <http://127.0.0.1:8080>.

### Variables d'environnement

| Variable       | Défaut               | Description                                        |
| -------------- | -------------------- | -------------------------------------------------- |
| `HOST`         | `127.0.0.1`          | Interface d'écoute.                                 |
| `PORT`         | `8080`               | Port d'écoute.                                      |
| `DEVICES_FILE` | `devices.json` (à côté de `server.js`) | Chemin du fichier de stockage des appareils. |

Exemple :

```bash
HOST=0.0.0.0 PORT=9000 node server.js
```

> ⚠️ Le service écoute sur `127.0.0.1` par défaut et **ne fournit pas
> d'authentification**. Pour un accès distant, placez-le derrière un reverse
> proxy avec authentification (voir plus bas).

## Installation en service systemd

Le script `install.sh` copie l'application dans `/opt/wol_webui` (appartenant à
`root`, en lecture seule pour le service) et installe l'unité systemd.

```bash
sudo ./install.sh
# ou, pour changer le port d'écoute :
sudo PORT=8090 ./install.sh
```

Le service utilise **`DynamicUser=yes`** : systemd alloue un utilisateur et un
groupe transitoires, sans créer de compte système permanent. Les données
persistantes (`devices.json`) sont stockées via **`StateDirectory=wol-webui`**
dans `/var/lib/wol-webui/`, avec des durcissements supplémentaires
(`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`).

Le fichier `wol-webui.service` sert de modèle ; le script réécrit uniquement le
chemin de `node` pour l'adapter à votre système.

### Configuration (`/etc/wol-webui.conf`)

Les valeurs par défaut peuvent être surchargées dans
`/etc/wol-webui.conf`, chargé par l'unité :

```ini
HOST=127.0.0.1
PORT=8090
```

Gestion du service :

```bash
sudo systemctl status wol-webui
sudo systemctl restart wol-webui
sudo journalctl -u wol-webui -f
```

## API HTTP

| Méthode  | Chemin                        | Description                                  |
| -------- | ----------------------------- | -------------------------------------------- |
| `GET`    | `/api/devices`                | Liste des appareils.                         |
| `POST`   | `/api/devices`                | Ajoute un appareil.                          |
| `PUT`    | `/api/devices/:id`            | Modifie un appareil.                         |
| `DELETE` | `/api/devices/:id`            | Supprime un appareil.                        |
| `POST`   | `/api/devices/:id/wake`       | Envoie le paquet magique.                    |
| `POST`   | `/api/devices/:id/ping`       | Ping l'IP de l'appareil.                     |
| `POST`   | `/api/ping`                   | Ping un hôte arbitraire.                     |

Exemples :

```bash
# Ajouter un appareil
curl -X POST http://127.0.0.1:8080/api/devices \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mon PC","mac":"AA:BB:CC:DD:EE:FF","ip":"192.168.1.50"}'

# Réveiller
curl -X POST http://127.0.0.1:8080/api/devices/<id>/wake

# Ping rapide
curl -X POST http://127.0.0.1:8080/api/ping \
  -H 'Content-Type: application/json' \
  -d '{"host":"8.8.8.8"}'
```

## Reverse proxy avec authentification

Exemple **nginx** (paquet `apache2-utils` pour `htpasswd`) :

```nginx
server {
    listen 443 ssl;
    server_name wol.example.com;

    ssl_certificate     /etc/ssl/certs/wol.example.com.pem;
    ssl_certificate_key /etc/ssl/private/wol.example.com.key;

    location / {
        auth_basic           "Wake-on-LAN";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

Génération du fichier de mots de passe :

```bash
sudo htpasswd -c /etc/nginx/.htpasswd monutilisateur
```

## Sécurité

- L'application n'embarque **aucune authentification** : ne l'exposez pas
  directement sur Internet.
- Les entrées sont validées côté serveur (MAC, IP/hôte) et le `ping` est
  exécuté via `execFile` sans shell, ce qui évite toute injection de commande.
- Le fichier `devices.json` est créé lors du premier lancement et ignoré par git.

## Licence

Distribué sous licence **Apache-2.0**. Voir le fichier [LICENSE](LICENSE).

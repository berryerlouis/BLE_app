# BLE_app — Centrale BLE Raspberry Pi pour IMU_Capture

[![CI](https://github.com/berryerlouis/BLE_app/actions/workflows/check.yml/badge.svg)](https://github.com/berryerlouis/BLE_app/actions/workflows/check.yml)
[![Version](https://img.shields.io/badge/version-0.0.4-blue)](VERSION)

Ce projet transforme un Raspberry Pi en centrale BLE qui détecte, connecte et suit plusieurs capteurs Arduino `IMU_Capture` sur un même réseau local. Le dashboard web affiche pour chaque satellite :

- statut de connexion
- dernières valeurs d'accéléromètre, gyroscope et température
- niveau et tension de batterie
- journal complet des messages reçus
- vue détaillée avec graphiques temps réel

Au démarrage, le Raspberry Pi :
1. active un point d'accès Wi‑Fi local pour permettre la connexion depuis un téléphone ou un PC
2. lance la centrale BLE qui scanne continuellement et se connecte automatiquement aux périphériques `IMU Satellite` détectés
3. sert un tableau de bord sur `http://<ip-du-pi>:80`

## Fonctionnalités actuelles

- détection et suivi de plusieurs satellites BLE simultanément
- reconnect automatique par périphérique
- tableau de bord centralisé avec liste des appareils et détail par périphérique
- graphiques temps réel via Chart.js
- historique persistant des appareils et journaux dans une base SQLite locale
- journal des messages avec historique côté serveur
- footer avec version locale et auteur
- vérification de mise à jour via GitHub (`origin/main`)
- modal de mise à jour avec barre de progression et redémarrage automatique du service

## Architecture

```text
BLE_app/
├── main.py                  # point d'entrée: lance la centrale BLE + le serveur web
├── config.yaml              # UUIDs BLE, nom du device, interface AP, port web, emplacement SQLite
├── data.db                  # base SQLite locale: appareils + historique des logs
├── secrets.example.yaml     # modèle de secrets pour le mot de passe du hotspot
├── secrets.yaml             # fichier local, non versionné, contient le mot de passe Wi‑Fi
├── VERSION                  # version de l’application
├── requirements.txt
├── README.md
├── ble_central/
│   ├── __init__.py
│   ├── ble_client.py        # connexion BLE, notifications, reconnexion
│   ├── db.py                # persistance SQLite des appareils et logs
│   ├── models.py            # décodage des structures IMU et batterie
│   ├── server.py            # serveur aiohttp + API + websocket
│   └── update.py            # vérification et application des mises à jour
├── scripts/
│   ├── install.sh           # installation système + venv + base de données + service
│   ├── setup_ap.sh          # création du hotspot Wi‑Fi via NetworkManager
│   ├── ble-central.service  # service systemd
│   ├── uninstall.sh         # suppression du service, du venv et de la base SQLite
│   └── update.sh            # mise à jour manuelle du dépôt
├── static/
│   ├── index.html
│   ├── css/
│   │   └── main.css         # styles et design system moderne
│   ├── style.css            # import de rétrocompatibilité
│   └── js/                  # architecture modulaire ES (app, state, api, charts, views)
│       ├── app.js
│       ├── ...
└── .venv/                   # généré localement lors de l’installation
```

## Correspondance avec le firmware Arduino

Le firmware `IMU_Capture` expose :

- service `2A6F0001-...`
  - caractéristique `2A6F0002-...` en `notify`: structure `{ax, ay, az, gx, gy, gz, temp}` en floats little-endian
  - caractéristique `2A6F0003-...` en `notify`: structure `{voltage (float), percentage (uint8)}` de la batterie

Le décodage est fait dans [ble_central/models.py](ble_central/models.py) et doit rester aligné avec la structure du firmware côté Arduino.

Les capteurs peuvent tous annoncer le même nom BLE (`IMU Satellite`); la centrale les distingue par leur adresse MAC BLE, utilisée comme identifiant unique dans le tableau et dans la vue détail.

## Prérequis

- Raspberry Pi OS Bookworm ou plus récent
- Bluetooth activé
- NetworkManager installé et utilisé par défaut
- accès root pour installer le service et le hotspot

## Installation sur le Raspberry Pi

```bash
cd ~
git clone https://github.com/berryerlouis/BLE_app.git BLE_app
cd BLE_app
cp secrets.example.yaml secrets.yaml
# puis éditer secrets.yaml pour définir le mot de passe Wi‑Fi du point d’accès
sudo ./scripts/install.sh
```

Le script installe :

- paquets système (`bluez`, `network-manager`, `python3-venv`)
- un environnement virtuel Python et les dépendances de [requirements.txt](requirements.txt)
- un point d’accès Wi‑Fi via [scripts/setup_ap.sh](scripts/setup_ap.sh)
- le service systemd [scripts/ble-central.service](scripts/ble-central.service)

Vérifier l’état ensuite :

```bash
systemctl status ble-central
journalctl -u ble-central -f
```

## Configuration

Le fichier [config.yaml](config.yaml) contient les paramètres applicatifs, notamment :

- `ble.device_name`: nom des capteurs BLE attendus (`IMU Satellite`)
- `ble.*_char_uuid`: UUIDs des services et caractéristiques du firmware
- `web.host` / `web.port`: adresse d’écoute et port du serveur web
- `wifi_ap.ssid` / `wifi_ap.interface`: SSID et interface du hotspot
- `database.path`: chemin de la base SQLite locale (`data.db` par défaut), utilisée pour stocker les résumés des appareils et l’historique des logs à travers les redémarrages

Le mot de passe du point d’accès ne doit pas être stocké dans [config.yaml](config.yaml). Il est défini dans [secrets.yaml](secrets.yaml), copié depuis [secrets.example.yaml](secrets.example.yaml), puis ignoré par Git.

La base SQLite est créée automatiquement lors du démarrage si elle n’existe pas, et conserve les données déjà vues dans le dashboard pour éviter de perdre l’historique après un redémarrage du service.

Après modification de la config :

```bash
sudo ./scripts/setup_ap.sh
sudo systemctl restart ble-central
```

## Wi‑Fi AP + Ethernet

Le script [scripts/setup_ap.sh](scripts/setup_ap.sh) ne touche que l’interface Wi‑Fi configurée dans [config.yaml](config.yaml). Il crée ou renforce un profil NetworkManager dédié pour l’Ethernet afin d’assurer la redémarrage automatique du réseau filaire, et il force la route par défaut à rester sur Ethernet pour que le trafic du réseau hotspot (`10.42.x.x`) passe uniquement via le Wi‑Fi.

En cas de problème après une ancienne version du script :

```bash
sudo ./scripts/setup_ap.sh
```

Ou, si nécessaire, réactiver manuellement le profil Ethernet :

```bash
nmcli connection show
nmcli connection up "Wired connection 1"
nmcli connection modify "Wired connection 1" connection.autoconnect yes connection.autoconnect-priority 200
```

## Utilisation

1. allumer les Arduino `IMU_Capture`
2. démarrer le Raspberry Pi ou redémarrer le service
3. se connecter au Wi‑Fi du point d’accès configuré
4. ouvrir `http://<ip-du-pi>:80`

Le dashboard reste aussi accessible via l’IP Ethernet du Raspberry Pi.

## Mise à jour automatique

Le pied de page du dashboard affiche la version courante et l’auteur, et le serveur expose les endpoints suivants :

- `GET /api/version`: version locale + auteur
- `GET /api/update/check`: compare le commit local et la version distante sur `origin/main`
- `POST /api/update/apply`: réinitialise le dépôt sur `origin/main`, réinstalle les dépendances, puis quitte proprement pour permettre au service systemd de redémarrer l’application automatiquement

La vérification de version s’exécute automatiquement et le bouton de mise à jour n’apparaît que si une nouvelle version est détectée. La modal affiche aussi une barre de progression pendant l’installation.

Pour mettre à jour manuellement :

```bash
sudo ./scripts/update.sh
```

> `secrets.yaml` étant ignoré par Git, il n’est pas écrasé par `git reset --hard origin/main`.

## Développement local

Pour tester localement sur un ordinateur (Windows/macOS/Linux), sans point d’accès Raspberry Pi :

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt
python main.py
```

Ouvrez ensuite :

```text
http://localhost:80
```

## Notes

- la version actuelle est stockée dans [VERSION](VERSION)
- le code de la mise à jour est dans [ble_central/update.py](ble_central/update.py)
- le dashboard web est servi depuis [static/index.html](static/index.html) et [static/js/app.js](static/js/app.js)

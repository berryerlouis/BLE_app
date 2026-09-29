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
- service standard Device Information `180A`
  - caractéristique Firmware Revision String `2A26`: version installée, par exemple `1.0.0`

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
- le service systemd [scripts/ble-central.service](scripts/ble-central.service), qui débloque et active tous les contrôleurs Bluetooth détectés avant de lancer la centrale

Vérifier l’état ensuite :

```bash
systemctl status ble-central
journalctl -u ble-central -f
```

## Configuration

Le fichier [config.yaml](config.yaml) contient les paramètres applicatifs, notamment :

- `ble.adapter`: contrôleur Bluetooth utilisé sur Raspberry Pi. Configurez `hci1` pour
  privilégier l'adaptateur USB plutôt que le module interne (`hci0`). Vérifiez les noms avec
  `bluetoothctl list` puis redémarrez le service.
- Les adaptateurs USB nouvellement ajoutés sont automatiquement débloqués et activés à chaque
  mise à jour exécutée avec `sudo ./scripts/update.sh`, puis avant chaque démarrage du service.
- `ble.adapters`: liste optionnelle des contrôleurs BLE (`hci1`, `hci2`, ...). La centrale crée
  un scanner et un pool de connexions par adaptateur, puis attribue durablement chaque satellite à
  une seule radio. Pour 30 satellites, configurez au moins trois adaptateurs USB et répartissez-les
  physiquement pour limiter les interférences. Ne définissez cette liste qu'avec les contrôleurs
  réellement présents; sinon conservez `ble.adapter` et son mécanisme de secours.
- `ble.device_name`: nom des capteurs BLE attendus (`IMU Satellite`)
- `ble.*_char_uuid`: UUIDs des services et caractéristiques du firmware
- `ble.firmware_version_refresh_s`: intervalle de relecture de la version des satellites connectés,
  utile pour actualiser le dashboard après un flash USB
- `telemetry.queue_maxsize`: nombre maximal de messages BLE en attente; au-delà, les lectures IMU
  excédentaires sont écartées pour préserver la disponibilité de la centrale
- `telemetry.websocket_imu_interval_ms` / `telemetry.persistence_imu_interval_ms`: cadence maximale
  par satellite envoyée au dashboard et sauvegardée dans SQLite (200 ms, soit 5 Hz par défaut)
- `ble.connect_timeout_s`: durée maximale d'une tentative de connexion GATT avant une nouvelle tentative
- `ble.winrt_use_cached_services`: réutilise sous Windows le cache GATT pour accélérer les connexions; passez-le à `false` après une modification des services du firmware
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

## Mise à jour du firmware des satellites (USB)

Le bouton **« Firmware »** dans l’en-tête ouvre une modal permettant de flasher un satellite
IMU_Capture branché en USB sur la machine qui exécute l’app (pas de mise à jour sans fil/BLE :
le satellite doit être connecté par câble).

Flux :

1. Compiler le firmware (tâche VS Code **Arduino: Verify** dans `IMU_Capture/`) : cela produit
   entre autres un paquet DFU `IMU_Capture.ino.zip` dans `IMU_Capture/build/cli/`.
2. Mettre à jour `IMU_Capture/VERSION` et `IMU_Capture/Version.h`, puis copier le paquet dans
  `firmware/` sous un nom versionné, par exemple `IMU_Capture-1.1.0.zip`.
3. Commiter et pousser ce paquet avec l'application. Il est ainsi livré automatiquement sur chaque
  Raspberry Pi lors de la mise à jour de l'app. L'import dans la modal reste disponible pour un test local.
4. Le dashboard affiche la version lue sur chaque satellite connecté. Lorsqu'un paquet présent dans
  `firmware/` est plus récent, un indicateur de mise à jour ouvre directement la modal avec ce paquet sélectionné.
5. Choisir le port série du satellite (détecté automatiquement via son VID USB Seeed `0x2886`),
   puis cliquer sur **« Flasher »**. Pour déployer le même paquet sur tous les satellites USB
   détectés, cliquer sur **« Flasher tous »** : les redémarrages en bootloader sont préparés l'un
   après l'autre, puis les transferts DFU sont lancés en parallèle avec une progression par port.

Lorsqu'un satellite XIAO est détecté par USB, le dashboard l'indique dans l'en-tête. Après
l'installation du firmware incluant l'état USB VBUS, la batterie du satellite affiche aussi
**« En charge »** dans le tableau et dans sa fiche détail.

Sous le capot, l’app reproduit le flux d’upload d’`arduino-cli` pour ces cartes (bootloader
Adafruit) : réveil du bootloader par un « touch » série à 1200 bauds, puis transfert du paquet
DFU via `adafruit-nrfutil dfu serial`. Nécessite les paquets `pyserial` et `adafruit-nrfutil`
(déjà listés dans `requirements.txt`).

Endpoints exposés :

- `GET /api/firmware` : liste des paquets `.zip` versionnés disponibles
- `POST /api/firmware/upload` : importe un nouveau paquet (`multipart/form-data`, champ `file`)
- `DELETE /api/firmware/{filename}` : supprime un paquet importé
- `GET /api/firmware/ports` : liste les ports série disponibles
- `POST /api/firmware/flash` : lance le flashage `{ "port": "...", "filename": "..." }` ; la
  progression est diffusée aux clients connectés via WebSocket (`type: "firmware_flash"`)
- `POST /api/firmware/flash-all` : lance le flashage du paquet `{ "filename": "..." }` sur tous
  les satellites XIAO USB détectés ; chaque progression WebSocket inclut `batch: true` et son port

## Récupérer les logs une fois le Pi sur site

Une fois déployé sur site (sans accès SSH), l'app conserve :

- les logs applicatifs (BLE, erreurs, etc.) dans `logs/app.log` (rotation automatique, 5 fichiers de 2 Mo max)
- un journal des actions utilisateur (clics/appels API : création de session, label, seuil d'impact, mise à jour…) dans `logs/user_actions.log`
- la base `data.db` (historique des sessions/mesures)

Pour les récupérer sans accès distant, n'importe qui connecté au dashboard peut cliquer sur **« Télécharger les journaux »** dans le pied de page : cela télécharge un fichier `.zip` (logs + base de données) via `GET /api/logs/export`, à renvoyer par mail/USB pour analyse de votre côté.

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

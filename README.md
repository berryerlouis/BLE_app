# BLE_app — Centrale BLE Raspberry Pi pour IMU_Capture

Ce projet transforme un Raspberry Pi en **centrale BLE** qui se connecte automatiquement
à **plusieurs** périphériques Arduino [`IMU_Capture`](../IMU_Capture) ("IMU Capture"), et affiche
un **tableau de tous les satellites connectés** ainsi que le **détail en direct** (graphiques +
journal complet) de chacun sur une page web.

Au démarrage, le Raspberry Pi :
1. Crée un point d'accès Wi-Fi (`ble_ap`) auquel on peut se connecter avec un téléphone/PC.
2. Démarre la centrale BLE qui scanne en continu et se connecte à chaque satellite "IMU Capture"
   détecté (identifié par son adresse BLE), avec reconnexion automatique par satellite.
3. Sert un tableau de bord web sur `http://<ip-du-pi>:80` :
   - une **liste** de tous les satellites (statut, dernières valeurs, batterie)
   - en cliquant sur un satellite, une **vue détail** avec graphiques temps réel et le
     **journal complet** des messages reçus (jusqu'à 2000 entrées conservées côté serveur).

## Architecture

```
BLE_app/
├── main.py                  # point d'entrée (asyncio): lance BLE + serveur web
├── config.yaml              # UUIDs BLE, nom du device, SSID/mot de passe AP, port web
├── requirements.txt
├── ble_central/
│   ├── models.py             # dataclasses miroir des structs C (ImuData, BatteryData)
│   ├── ble_client.py         # bleak: scan continu, une session par satellite découvert
│   └── server.py             # aiohttp: page statique, API /api/devices(/log), websocket /ws
├── static/
│   ├── index.html, app.js, style.css   # tableau des satellites + vue détail (Chart.js + logs)
└── scripts/
    ├── setup_ap.sh            # crée le hotspot Wi-Fi via NetworkManager (nmcli)
    ├── ble-central.service    # unité systemd pour lancer l'app au boot
    └── install.sh             # installe tout en une commande
```

## Correspondance avec le firmware Arduino

Le firmware `IMU_Capture` (`Ble.cpp`) expose :
- Service `2A6F0001-...` avec :
  - Caractéristique `2A6F0002-...` (notify) : struct `{aX,aY,aZ,gX,gY,gZ,temp}` = 7 floats LE (28 octets)
  - Caractéristique `2A6F0003-...` (notify) : `voltage` (float, 4 octets)
- Service standard batterie `180F`, caractéristique `2A19` (niveau %, 1 octet)

`ble_central/models.py` décode ces octets exactement dans cet ordre/format.

Tous les satellites Arduino peuvent partager le même nom BLE (`IMU Capture`) : la centrale les
distingue par leur **adresse BLE** (MAC), qui sert d'identifiant unique dans le tableau et l'URL du détail.

## Installation sur le Raspberry Pi

Prérequis : Raspberry Pi OS **Bookworm** ou plus récent (NetworkManager par défaut), Bluetooth activé.

```bash
cd ~
git clone https://github.com/berryerlouis/BLE_app.git BLE_app
cd BLE_app
cp secrets.example.yaml secrets.yaml   # puis éditer secrets.yaml et mettre le vrai mot de passe Wi-Fi
sudo ./scripts/install.sh
```

Ce script :
- installe les paquets système (`bluez`, `network-manager`, `python3-venv`)
- crée un environnement virtuel Python et installe `requirements.txt`
- configure le point d'accès Wi-Fi (`scripts/setup_ap.sh`, éditable via `config.yaml` → `wifi_ap`)
- installe et démarre le service systemd `ble-central` (auto-restart, démarrage au boot)

Vérifier l'état :
```bash
systemctl status ble-central
journalctl -u ble-central -f
```

## Configuration (`config.yaml` / `secrets.yaml`)

- `ble.device_name` : nom annoncé par l'Arduino (`BLE.setLocalName("IMU Capture")`)
- `ble.*_char_uuid` : UUIDs des caractéristiques (déjà alignés sur le firmware)
- `web.port` : port du serveur web (80 par défaut)
- `wifi_ap.ssid` / `wifi_ap.interface` : SSID et interface du point d'accès Wi-Fi (dans `config.yaml`, versionné)
- `wifi_ap.password` : **mot de passe du point d'accès**, stocké uniquement dans `secrets.yaml`
  (copié depuis `secrets.example.yaml`). Ce fichier est dans `.gitignore` et n'est **jamais commité**.

Après modification, relancer `sudo ./scripts/setup_ap.sh` (Wi-Fi) et/ou
`sudo systemctl restart ble-central` (app).

## Wi-Fi AP + Ethernet en même temps

`scripts/setup_ap.sh` ne touche que l'interface Wi-Fi (`wifi_ap.interface`, `wlan0` par défaut) :
- il crée/renforce un profil NetworkManager dédié pour l'Ethernet (`ble-wired`, autoconnect,
  priorité 200) pour garantir qu'il redémarre toujours automatiquement,
- il force `ipv4.never-default yes` sur le point d'accès Wi-Fi pour que la route par défaut
  (accès Internet) reste sur Ethernet, seul le trafic vers le sous-réseau du hotspot (`10.42.x.x`)
  passe par `wlan0`.

**Si l'Ethernet a été coupé avec l'ancienne version du script**, reconnecte-toi en Wi-Fi ou en
local et relance simplement :
```bash
sudo ./scripts/setup_ap.sh
```
Ou restaure manuellement l'Ethernet :
```bash
nmcli connection show                     # lister les profils
nmcli connection up "Wired connection 1"  # ou le nom de ton profil filaire
nmcli connection modify "Wired connection 1" connection.autoconnect yes connection.autoconnect-priority 200
```

## Utilisation

1. Allumer l'Arduino `IMU_Capture` (il advertise en BLE).
2. Le Raspberry Pi démarre son point d'accès Wi-Fi (SSID défini dans `config.yaml`) **en plus**
   de sa connexion Ethernet existante.
3. Se connecter à ce Wi-Fi depuis un téléphone/PC, puis ouvrir `http://<ip-du-pi>:80`
   (IP par défaut du côté "shared" NetworkManager : généralement `10.42.0.1`).
   Le dashboard reste aussi accessible via l'IP Ethernet du Pi.
4. Le dashboard affiche en direct l'accéléromètre, le gyroscope, la température et la batterie.

## Version et mise à jour automatique

Le pied de page du dashboard affiche la version courante (fichier [`VERSION`](VERSION)) et l'auteur.

Le serveur expose :
- `GET /api/version` : version locale + auteur
- `GET /api/update/check` : compare `HEAD` local à `origin/main` sur
  [berryerlouis/BLE_app](https://github.com/berryerlouis/BLE_app) (via `git fetch`)
- `POST /api/update/apply` : `git reset --hard origin/main` + réinstalle `requirements.txt`,
  puis quitte le process (le service systemd `Restart=always` le relance automatiquement)

Le bouton **"Mettre à jour"** n'apparaît dans le pied de page que lorsqu'une nouvelle version est
détectée (vérification automatique toutes les 5 minutes). Cliquer dessus déclenche la mise à jour
et recharge la page une fois le service redémarré.

`secrets.yaml` étant ignoré par git, il n'est jamais écrasé par `git reset --hard`.

On peut aussi mettre à jour manuellement :
```bash
sudo ./scripts/update.sh
```

## Développement / test local (Windows/macOS/Linux avec Bluetooth)

```bash
python -m venv .venv
.venv\Scripts\activate   # ou source .venv/bin/activate
pip install -r requirements.txt
python main.py
```
Ouvrir `http://localhost:80` dans un navigateur (aucun point d'accès Wi-Fi n'est requis en local).

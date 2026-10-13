# IMU Capture Firmware

## Release automatique

Avant le premier commit sur une nouvelle copie du dépôt, activez le hook versionné :

```powershell
git config core.hooksPath .githooks
```

Chaque `git commit` incrémente la version patch dans `VERSION` et `Version.h`, compile le firmware
pour le XIAO nRF52840 Sense, puis copie le paquet DFU dans
`../BLE_app/firmware/IMU_Capture-X.Y.Z.zip`.

Le ZIP est préparé pour être commité dans le dépôt de l'application avec la mise à jour associée.
Pour vérifier la prochaine version sans rien modifier :

```powershell
python scripts/release_firmware.py --dry-run
```

Définissez `ARDUINO_CLI` si `arduino-cli` n'est pas dans le `PATH` et qu'Arduino IDE n'est pas
installé à son emplacement Windows habituel.
# Raspberry Pi Setup

These steps assume a Raspberry Pi 4 or 5, a blank microSD card, and a wired or
wireless network. The [official Raspberry Pi OS documentation](https://www.raspberrypi.com/documentation/computers/getting-started.html)
has screenshots and troubleshooting for each step.

## Install Raspberry Pi OS and Windsor

1. Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to write
   **Raspberry Pi OS Lite (64-bit)** to the microSD card. Before writing,
   open the OS customization screen and set:
   * a hostname such as `windsor-pi`
   * a username such as `piuser` (the Linux account that will run Windsor)
   * a strong password
   * your Wi-Fi country, network name, and password (if using Wi-Fi)
   * the correct time zone and keyboard layout
   * **Enable SSH**, using password authentication for the first login
2. Eject the card, insert it into the Pi, connect the printer, and power on the
   Pi. Wait two to five minutes for the first boot.
3. From another computer on the same network, connect using the hostname:

   ```bash
   ssh piuser@windsor-pi.local
   ```

   If that name does not resolve, find the Pi in the router's client list and
   use its address instead:

   ```bash
   ssh piuser@192.168.1.50
   ```

   See the
   [Raspberry Pi SSH guide](https://www.raspberrypi.com/documentation/computers/remote-access.html#ssh)
   if hostname discovery does not work.
4. Update Raspberry Pi OS and install Node.js, npm, and the optional CUPS
   printing tools:

   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y nodejs npm cups
   node --version
   npm --version
   ```

5. Install Windsor globally:

   ```bash
   sudo npm install --global windsor-bot
   command -v windsor-bot
   ```

6. Create a dedicated working directory. Configuration and cached icons will
   be stored here:

   ```bash
   mkdir -p ~/windsor
   cd ~/windsor
   ```

7. Connect the USB printer. For a direct ESC/P printer, identify the device:

   ```bash
   ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
   ```

   The usual result is `/dev/ttyUSB0` or `/dev/ttyACM0`. Add the login user to
   the device-access group, then reconnect over SSH:

   ```bash
   sudo usermod -aG dialout "$USER"
   exit
   ssh piuser@windsor-pi.local
   cd ~/windsor
   ```

   For a CUPS printer, enable the service and list configured printers:

   ```bash
   sudo systemctl enable --now cups
   lpstat -p
   ```

   Add the printer in CUPS, then use the name returned by `lpstat -p` in the
   Windsor control panel.

## Install Windsor as a boot-time service

Windsor should run under `systemd`, so it starts automatically whenever the Pi
boots and restarts if the process exits. `systemd` does not use your interactive
shell's username or `nvm` settings, so use the actual account and absolute
binary path. Record them while logged in as the account that should run
Windsor:

```bash
id -un
echo "$HOME"
command -v windsor-bot
```

The first command must print an existing Linux username, and the last command
must print an executable path. In the example below the account is `piuser`,
the home directory is `/home/piuser`, and the installed command is
`/usr/bin/windsor-bot`. If your output is different, substitute your values
everywhere in the service file. For example, a Pi account named `windsor`
uses `User=windsor` and `/home/windsor/...`; do not leave `User=piuser` unless
that account actually exists.

Create `/etc/systemd/system/windsor.service`:

```bash
sudo nano /etc/systemd/system/windsor.service
```

Paste the following, replacing the three example values with the output from
the commands above:

```ini
[Unit]
Description=Windsor Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=piuser
WorkingDirectory=/home/piuser/windsor
ExecStart=/usr/bin/windsor-bot
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable windsor
sudo systemctl start windsor
sudo systemctl status windsor
```

The service starts Windsor on every boot. View its logs with:

```bash
journalctl -u windsor -f
```

If the unit was already started with the wrong username or path, edit the unit,
then run `sudo systemctl daemon-reload`, `sudo systemctl reset-failed windsor`,
and `sudo systemctl restart windsor`.

## Sources

* [Raspberry Pi: Getting started](https://www.raspberrypi.com/documentation/computers/getting-started.html)
* [Raspberry Pi: Remote access over SSH](https://www.raspberrypi.com/documentation/computers/remote-access.html#ssh)

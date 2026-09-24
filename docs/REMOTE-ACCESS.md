# Remote access from your phone

Check on the bot, stop it, and get told when it dies — from anywhere, without
opening anything on the Mac to the internet.

```
 iPhone ──Tailscale (private, encrypted)──▶ Mac ──SSH──▶ cm ──▶ engine on 127.0.0.1
                                                       ╰─▶ tunnel ──▶ dashboard on 127.0.0.1

 engine ──ping every minute while healthy──▶ healthchecks.io ──"it went quiet"──▶ your phone
```

Three pieces:

| Piece | What it does | Why this one |
|---|---|---|
| **Tailscale** | Puts the Mac and your phone on a private network | No router port-forwarding; the Mac is invisible to the internet |
| **SSH + `cm`** | Status, kill switch, flatten, restart from a terminal | The engine and dashboard stay bound to `127.0.0.1`; SSH makes your request local |
| **Dead-man's switch** | Alerts you when the bot goes *silent* | Every other alert is sent by the bot, so none can fire when the bot is dead |

**Never** port-forward 3000 or 4000 on your router, and never put them behind
Tailscale Funnel. Nothing in the engine or dashboard is authenticated beyond
"this request came from this machine" — that is the design, and SSH preserves it.

---

## 1. On the Mac (once)

### Tailscale

1. Install Tailscale for macOS from <https://tailscale.com/download> and sign in.
2. In the admin console (<https://login.tailscale.com/admin/machines>), open the
   Mac's `…` menu and choose **Disable key expiry**. Otherwise the Mac silently
   drops off your network when its key expires, typically while you are away.

### SSH (Remote Login)

1. **System Settings → General → Sharing → Remote Login**: on.
2. Click the **ⓘ** next to it and set *Allow access for* to **Only these users**,
   with just your account.

Password login gets switched off in step 3, once your phone's key works.

### The `cm` command

Add this to `~/.zshrc`, adjusting the path to wherever the repo lives:

```bash
alias cm="node $HOME/crypto-magic/scripts/cm.mjs"
```

Open a new terminal and run `cm`. You should see the status screen.

---

## 2. On the iPhone (once)

1. Install **Tailscale** from the App Store and sign in with the same account.
   The Mac should appear in its device list.
2. Install an SSH app. **Termius** and **Blink Shell** both work.
3. In the SSH app, **generate a new key** (Ed25519) and turn on the app's
   Face ID lock, since that key is now a way into your Mac.
4. Get the **public** key to the Mac (AirDrop, Notes, or email it to yourself) and
   append it to `~/.ssh/authorized_keys`:

   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   cat >> ~/.ssh/authorized_keys      # paste the key, press Enter, then Ctrl-D
   chmod 600 ~/.ssh/authorized_keys
   ```

5. Add a host in the SSH app:
   - **Host:** the Mac's Tailscale name (for example `mac-mini`) or its `100.x.y.z`
     address, both shown in the Tailscale app
   - **User:** your Mac short username (`whoami` on the Mac)
   - **Key:** the one you just generated
6. Connect and run `cm`.

---

## 3. Turn off password login (once, after step 2 works)

A key on your phone is far stronger than a password. With Tailscale in front,
the Mac is not reachable from the internet anyway; this closes the door on your
home network too.

```bash
sudo tee /etc/ssh/sshd_config.d/010-crypto-magic.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && echo "config OK"
```

Then turn **Remote Login** off and on again in System Settings to apply it.

**Keep your current SSH session open** and check from the phone that a *new*
connection still works before you close anything. To confirm passwords are now
refused, from another computer on the network run
`ssh -o PubkeyAuthentication=no you@mac-mini`. It should say
`Permission denied (publickey)`.

---

## 4. The dead-man's switch (once)

1. Create a free account at <https://healthchecks.io> and **Add Check**.
2. Set **Period** to 5 minutes and **Grace Time** to 10 minutes. You will hear
   about a dead bot within about 15 minutes, and a brief network blip will not
   wake you.
3. Under **Integrations**, connect where alerts should go (email, Telegram,
   Discord, ntfy and others). Use the same place your bot alerts already go.
4. Copy the check's ping URL (`https://hc-ping.com/…`) into `.env`:

   ```bash
   DEADMAN_PING_URL=https://hc-ping.com/your-check-uuid
   ```

5. `cm restart`. Within a minute or two, `cm` should show
   `Dead-man   pinged 40s ago` and healthchecks.io should show the check as up.
6. **Test it.** Stop the engine (`launchctl unload ~/Library/LaunchAgents/com.cryptomagic.engine.plist`),
   wait for the alert, then start it again with `launchctl load …`.
   An alert you have never seen fire is not an alert.

What "healthy" means: the engine pings only while its trading loop has completed
a pass in the last few minutes. A crashed engine, a wedged loop, a sleeping or
powered-off Mac, and a dead home internet connection all look the same from
outside: silence. That is the point.

Treat the ping URL as a secret. Anyone holding it can make a dead bot look alive.
The engine never logs it and never shows it in the API.

---

## Daily use

Connect from the SSH app, then:

| Command | What it does |
|---|---|
| `cm` | Status: mode, kill switch, halts, loop health, dead-man, equity, positions |
| `cm kill [reason]` | Kill switch on. New entries blocked; stops and exits keep running |
| `cm release` | Kill switch off |
| `cm flatten` | Kill switch on, **then** sell every position at market. Asks you to type `FLATTEN` |
| `cm events [n]` | Last n engine events |
| `cm logs [n]` | Last n log lines, condensed for a small screen |
| `cm restart` | Restart the engine service and wait for it to answer |

`cm kill` works even when the engine is not answering: it writes the kill switch
file directly, which the engine checks before every entry and at every startup.

`cm flatten` engages the kill switch first on purpose. Without that, the next
hourly bar could buy straight back in.

### The dashboard on your phone (optional)

Set up a **local port forward** in the SSH app: local port `3000` →
`127.0.0.1:3000` on the Mac. In Blink this is `ssh -L 3000:127.0.0.1:3000 mac-mini`;
in Termius it is under *Port Forwarding*. Then open <http://localhost:3000> on
the phone.

iOS may pause the SSH app when you switch to the browser, which can drop the
tunnel. `cm` in the terminal is the reliable path; the dashboard is a nicety.

The dashboard deliberately answers only requests addressed to `localhost`, to
block DNS-rebinding and cross-site attacks. Serving it under a Tailscale name
would mean relaxing that check, so it has not been done.

---

## Before you travel

- [ ] `cm` from the phone works over cellular, not just home Wi-Fi (turn Wi-Fi off to test)
- [ ] The dead-man check is **up** on healthchecks.io
- [ ] The daily check-in arrived today
- [ ] Mac is on the UPS, on ethernet, and set to start after a power failure
- [ ] You know the two commands that matter: `cm` and `cm kill`

## Things that will bite you

- **An unattended reboot locks you out.** With FileVault on, which it should be
  because your API keys are on that disk, a Mac that restarts after a power cut
  waits at the unlock screen. Until someone types the password at the Mac,
  nothing runs: not the engine, not Tailscale, not SSH. The dead-man's switch will
  tell you this has happened; it cannot fix it. The UPS is what prevents it, so
  also turn off automatic macOS update restarts. Your exchange-side protective
  stop still guards any open position while the Mac is down.
- **The work laptop.** Do not install Tailscale on it or SSH from it. Zscaler
  routes and may inspect its traffic, and most employers' policies forbid it.
  Use your phone or a personal computer.
- **Losing the phone.** Remove its key from `~/.ssh/authorized_keys` and remove
  the phone from the Tailscale admin console. That revokes both layers.
- **`cm: command not found` over SSH.** The alias lives in `~/.zshrc`; run
  `node ~/crypto-magic/scripts/cm.mjs` directly, or check the path in the alias.

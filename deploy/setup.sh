#!/bin/bash
# setup.sh — a fresh box, once. Creates the hamachi account, the /srv checkouts, /etc/clawcius,
# the deploy units and timers. Run as root. Secrets are placed by hand afterwards (see SETUP.md).
set -euo pipefail

id hamachi >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/hamachi --shell /bin/bash hamachi
install -m 0440 -o root -g root "$(dirname "$0")/hamachi.sudoers" /etc/sudoers.d/hamachi
visudo -cf /etc/sudoers.d/hamachi

install -d -m 0750 -o root -g hamachi /etc/clawcius
for f in clawcius.env hamachi.env; do [ -f /etc/clawcius/$f ] || install -m 0640 -o root -g hamachi /dev/null /etc/clawcius/$f; done

for repo in clawcius oj; do
  case $repo in clawcius) url=https://github.com/NickPurcell/Clawcius.git ;; oj) url=https://github.com/NickPurcell/OJ.git ;; esac
  install -d -m 0755 -o hamachi -g hamachi /srv/$repo /srv/$repo/releases
  [ -d /srv/$repo/src/.git ] || runuser -u hamachi -- git clone -q "$url" /srv/$repo/src
done
install -d -m 0755 -o hamachi -g hamachi /var/lib/hamachi/run

install -m 0644 -o root -g root "$(dirname "$0")"/../systemd/deploy@.service "$(dirname "$0")"/../systemd/deploy@.timer "$(dirname "$0")"/../systemd/deploy@.path /etc/systemd/system/
install -m 0755 -o root -g root "$(dirname "$0")/deploy.sh" /usr/local/sbin/deploy
systemctl daemon-reload
systemctl enable --now deploy@clawcius.timer deploy@oj.timer deploy@clawcius.path deploy@oj.path
echo "setup done: put secrets in /etc/clawcius, then: deploy clawcius && deploy oj"

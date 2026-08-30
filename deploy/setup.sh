#!/bin/bash
# setup.sh — a fresh box, once. Creates the hamachi account, the /srv checkouts, /etc/clawcius,
# the deploy units and timers. Run as root. Secrets are placed by hand afterwards (see SETUP.md).
set -euo pipefail

if [ ! -x /usr/bin/node ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q nodejs
fi
id hamachi >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/hamachi --shell /bin/bash hamachi
install -m 0440 -o root -g root "$(dirname "$0")/hamachi.sudoers" /etc/sudoers.d/hamachi
visudo -cf /etc/sudoers.d/hamachi

# Each crew's secrets are readable by the user its units run as: docker reads --env-file as that user.
install -d -m 0755 -o root -g root /etc/clawcius
[ -f /etc/clawcius/clawcius.env ] || install -m 0640 -o root -g npurcell /dev/null /etc/clawcius/clawcius.env
[ -f /etc/clawcius/hamachi.env ] || install -m 0640 -o root -g hamachi /dev/null /etc/clawcius/hamachi.env

for repo in clawcius oj; do
  case $repo in clawcius) url=https://github.com/NickPurcell/Clawcius.git ;; oj) url=https://github.com/NickPurcell/OJ.git ;; esac
  install -d -m 0755 -o hamachi -g hamachi /srv/$repo /srv/$repo/releases
  [ -d /srv/$repo/src/.git ] || runuser -u hamachi -- git clone -q "$url" /srv/$repo/src
done
install -d -m 0755 -o hamachi -g hamachi /var/lib/hamachi/run

install -m 0644 -o root -g root "$(dirname "$0")"/../systemd/deploy@.service "$(dirname "$0")"/../systemd/deploy@.timer "$(dirname "$0")"/../systemd/deploy@.path /etc/systemd/system/
install -m 0755 -o root -g root "$(dirname "$0")/deploy.sh" /usr/local/sbin/deploy
systemctl daemon-reload
cat <<'NEXT'
setup done. Next, in this order:
  1. secrets into /etc/clawcius (clawcius.env, hamachi.env, the PEMs)     — SETUP.md § 3
  2. chown -R hamachi:hamachi /var/lib/hamachi; stop hamachi-container.service and hamachi-snapshot.timer
  3. deploy clawcius && deploy oj
  4. systemctl enable --now deploy@clawcius.timer deploy@oj.timer deploy@clawcius.path deploy@oj.path
NEXT

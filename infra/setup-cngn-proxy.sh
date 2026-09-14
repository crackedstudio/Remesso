#!/usr/bin/env bash
#
# Stand up a fixed-IP forward proxy for cNGN traffic on a fresh Ubuntu/Debian VPS.
#
# Why this exists: cNGN whitelists by source IP and will not accept a CIDR
# range ("static IP. No CIDR." — cNGN support, 2026-09-10). Supabase Edge
# Functions egress from the whole AWS eu-central-1 NAT pool (measured: 8
# consecutive calls, 8 distinct IPs), so there is no set of addresses that
# could be whitelisted. Routing cNGN calls through one proxy gives cNGN a
# single address to trust.
#
# What the proxy can and cannot see: clients reach api.cngn.co over HTTPS via
# CONNECT, so the proxy tunnels an encrypted stream. It never sees the API key,
# the request bodies, or the sealed responses. It is a router, not a
# man-in-the-middle — which is why a $4 VPS is an acceptable place for it.
#
#   sudo bash setup-cngn-proxy.sh
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "run with sudo" >&2; exit 1; fi

PROXY_PORT="${PROXY_PORT:-8888}"
PROXY_USER="${PROXY_USER:-remesso}"
PROXY_PASS="${PROXY_PASS:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)}"

apt-get update -qq
apt-get install -y -qq tinyproxy ufw >/dev/null

cat > /etc/tinyproxy/tinyproxy.conf <<CONF
User tinyproxy
Group tinyproxy
Port ${PROXY_PORT}
Timeout 600

# Bind to all interfaces; ufw below is what restricts who may reach the port.
Listen 0.0.0.0

# Anyone who can reach the port must authenticate. Without this the box is an
# open proxy and will be found and abused within hours.
BasicAuth ${PROXY_USER} ${PROXY_PASS}

# CONNECT is the only method that matters here — the client is opening a TLS
# tunnel to api.cngn.co. 443 only: no plaintext, no other ports.
ConnectPort 443

# And only to cNGN. If this proxy's credentials ever leak, the worst an
# attacker gets is the ability to talk to cNGN's public API, which still
# requires an API key they do not have.
# tinyproxy 1.11 requires file paths to be quoted, like LogFile and PidFile
# below; an unquoted path is a config syntax error and the daemon refuses to
# start. Boolean directives take Yes/No, not On/Off.
FilterURLs No
Filter "/etc/tinyproxy/allowed-hosts"
FilterDefaultDeny Yes
FilterExtended Yes

# Do not advertise the client's address; cNGN should see only this host.
DisableViaHeader Yes
XTinyproxy No

LogFile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Warning
PidFile "/run/tinyproxy/tinyproxy.pid"
MaxClients 50
CONF

# Anchored so "api.cngn.co.evil.com" does not match.
cat > /etc/tinyproxy/allowed-hosts <<'HOSTS'
^api\.cngn\.co$
HOSTS

chown tinyproxy:tinyproxy /etc/tinyproxy/tinyproxy.conf /etc/tinyproxy/allowed-hosts
chmod 600 /etc/tinyproxy/tinyproxy.conf

ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow "${PROXY_PORT}"/tcp >/dev/null
ufw --force enable >/dev/null

systemctl enable tinyproxy >/dev/null 2>&1 || true
systemctl restart tinyproxy
sleep 1
systemctl is-active --quiet tinyproxy || { journalctl -u tinyproxy -n 20 --no-pager; exit 1; }

IP="$(curl -s --max-time 10 https://api.ipify.org || echo UNKNOWN)"

cat <<DONE

  tinyproxy is running.

  Whitelist this IP in the cNGN dashboard (IP whitelisting -> Add IP;
  it will ask for your authenticator code):

      ${IP}

  Then set this secret on the Supabase project:

      CNGN_EGRESS_PROXY_URL=http://${PROXY_USER}:${PROXY_PASS}@${IP}:${PROXY_PORT}

  Verify from here first — 200 means the whitelist entry took, 403 means it
  has not propagated or the wrong IP was added:

      curl -x http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${PROXY_PORT} \\
        -H "Authorization: Bearer \$CNGN_API_KEY" \\
        https://api.cngn.co/v1/api/balance

DONE

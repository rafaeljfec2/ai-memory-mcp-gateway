# Operations

## Stable origin with a named Cloudflare Tunnel

The maintained deployment uses a named, remotely configured Cloudflare Tunnel.
The tunnel sends its public hostname to the local AI Memory HTTP listener and
sets the origin `Host` header to `localhost`. Route the hostname to the tunnel
and configure a catch-all origin service: the gateway requests `/api/v1/*`,
not only `/mcp`.

For each installation:

1. Create a named tunnel in Cloudflare Zero Trust and save its tunnel UUID.
2. Create a public hostname/DNS route for your origin hostname. The DNS record
   should be a proxied CNAME to `<tunnel-uuid>.cfargotunnel.com`.
3. Configure the tunnel service as `http://127.0.0.1:49374` (or the local AI
   Memory port) and set the origin HTTP Host header to `localhost`.
4. Set `AI_MEMORY_ORIGIN_URL` to `https://<origin-hostname>/mcp` in the Worker.
   Add that exact hostname to the allowlist in `src/mcp-gateway.ts`.
5. Store the tunnel token locally, not in the repository. A user-owned systemd
   service can read it from a mode `600` file.

The checked-in [local tunnel configuration example](../cloudflared/config.example.yml)
uses a locally managed tunnel and a credentials JSON file. Do not combine that
mode with the remotely managed token-file unit below.

## systemd user service example

Save this as `~/.config/systemd/user/cloudflared-ai-memory.service` and replace
`REPLACE_WITH_TUNNEL_UUID` and the binary path for your installation:

```ini
[Unit]
Description=Cloudflare Tunnel for AI Memory
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token-file %h/.config/cloudflared/ai-memory-origin.token REPLACE_WITH_TUNNEL_UUID
Restart=always
RestartSec=10s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=default.target
```

Create the token file without putting its value in shell history:

```sh
install -d -m 700 ~/.config/cloudflared
umask 077
read -r -s -p 'Tunnel token: ' tunnel_token
printf '\n'
printf '%s' "$tunnel_token" > ~/.config/cloudflared/ai-memory-origin.token
unset tunnel_token
chmod 600 ~/.config/cloudflared/ai-memory-origin.token
```

Enable the service and start it now:

```sh
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-ai-memory.service
```

To start user services after reboot before the user logs in, enable linger with
administrator authorization:

```sh
sudo loginctl enable-linger "$USER"
```

`--no-autoupdate` disables cloudflared's self-update. The systemd unit restarts
the connector after failures; maintainers must update the cloudflared binary
separately. The computer and network must be available for the local AI Memory
origin to respond.

## Validation and monitoring

Check the connector and AI Memory services:

```sh
systemctl --user status cloudflared-ai-memory.service
systemctl --user status ai-memory.service
journalctl --user -u cloudflared-ai-memory.service -n 50 --no-pager
dig +short <origin-hostname>
```

An unauthenticated request to the origin may return `401`; that confirms only
that the request reached an authenticated API, not that the MCP credential is
valid. Validate a real read through the deployed gateway using an authorized
client, then confirm `tools/list` and a read tool call. Keep any temporary Quick
Tunnel until that check passes. Stop only the Quick Tunnel process that points
to the AI Memory port; do not stop other tunnels.

For Worker logs:

```sh
npx wrangler tail --name <worker-name>
```

## Common issues

| Symptom | Likely cause and action |
| --- | --- |
| `401` from AI Memory | Check the dedicated user key and its read grants. Do not substitute a root key. |
| `403` during consent | The Cloudflare Access identity is absent or its `user_uuid` differs from `OAUTH_ALLOWED_USER_ID`. |
| `workspace and project are required` | Pass both names returned by `memory_list_projects` to a project-scoped tool. |
| Tunnel is inactive | Check the token-file permissions, tunnel UUID in `ExecStart`, DNS route, and systemd logs. |
| AI Memory logs a disallowed Host header | Set the tunnel's origin Host header to `localhost`. |
| `/mcp` works but REST calls return 404 | Ensure the tunnel routes all paths for the hostname, including `/api/v1/*`. |
| Stale tool list in a client | Refresh the MCP connection or client session after a deployment; keep the same URL when only the Worker implementation changes. |

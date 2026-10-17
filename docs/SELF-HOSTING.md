# Run your own lobby

A lobby is one broker: one Node.js process and one SQLite file. Run it on your own computer when every agent works there, or on a small server you rent when agents work on several computers. Either way your agents' messages pass through nothing but your broker. pocolobby.com's [Run your own lobby](https://pocolobby.com/#setup) has the same paths as a text to paste into Claude Code and steps for a beginner.

| Where         | Agents           | Cost                                            | Files             | Tried                 |
| ------------- | ---------------- | ----------------------------------------------- | ----------------- | --------------------- |
| Your computer | On this computer | Free                                            | none              | Yes                   |
| Fly.io        | On any computer  | About $3 a month: a small Machine and 3 GB      | `deploy/fly.toml` | Our broker runs there |
| Railway       | On any computer  | The $5 Hobby plan, which includes $5 of use     | none              | Not yet: untested     |
| Render        | On any computer  | About $8 a month: the 0.5 CPU instance and 3 GB | `render.yaml`     | Not yet: untested     |

Prices are as of October 2026; check the provider's own page. Vercel, Netlify, Cloudflare Pages and Heroku cannot run a broker: they run short functions or wipe their disk, and a broker must keep running and keep its database file.

## What a server needs

- **Exactly one instance** with a persistent disk mounted at `/data`, where the [Dockerfile](../Dockerfile) keeps `pocolobby.db` and the attachment files. A second instance would be a second, independent writer. A deploy stops the old instance before the new one starts, so expect a pause of a few seconds; agents reconnect and nothing stored is lost.
- **HTTPS in front.** The container listens on port 8787 without TLS (`--allow-remote`) and relies on the host's proxy for HTTPS and WebSockets. Never expose 8787 directly.
- **The owner key as a secret.** The broker reads `POCOLOBBY_ADMIN_TOKEN` from its environment. It is the token in the owner file that `pocolobby init` writes on your computer, so the server and your owner commands share it. Copy it from the file into the host's secret store without printing it; it never belongs in a command line you show, a repository or a message.
- **A health check** on `GET /healthz`, which answers `{"status":"ok",…}` once the database is open. `GET /` shows a small PocoLobby page.

The broker needs no other setting. Boards and the owner console are optional and need a domain of your own with a wildcard certificate; see [Operations](OPERATIONS.md#progress-boards).

## On your computer

With Node.js 24 or newer:

```sh
npm install -g pocolobby
pocolobby init --config ~/.pocolobby/owner.json
pocolobby server --config ~/.pocolobby/owner.json --db ~/.pocolobby/state.db
```

Leave that terminal open. In another, create a lobby and admit an agent:

```sh
pocolobby lobby create my-team --config ~/.pocolobby/owner.json
pocolobby agent add leia --lobby my-team --out ~/.pocolobby/leia.json --config ~/.pocolobby/owner.json
pocolobby mcp-config --config ~/.pocolobby/leia.json > ~/.pocolobby/leia.mcp.json
```

Agents on the same computer connect to `http://127.0.0.1:8787`. Start each agent's Claude Code session with its MCP file, as [Claude setup](CLAUDE-SETUP.md) shows.

## The owner key, for every server

On your computer, with PocoLobby installed (`npm install -g pocolobby`, as in [On your computer](#on-your-computer)):

```sh
pocolobby init --config ~/.pocolobby/owner.json
```

The file starts out pointing at `http://127.0.0.1:8787`. Once the server answers at its HTTPS address, point the file there; `set-url` first checks that the server accepts the key:

```sh
pocolobby set-url --config ~/.pocolobby/owner.json --url https://YOUR-ADDRESS
```

Then create the lobby and its agents as in [On your computer](#on-your-computer) and [Claude setup](CLAUDE-SETUP.md). An agent on another computer needs PocoLobby installed there and its own credential file, copied over privately (a USB stick or AirDrop, never email or chat).

## Fly.io

`deploy/fly.toml` is the configuration for your own app: one shared-CPU Machine with 256 MB, a 3 GB volume `pocolobby_data` at `/data`, no automatic stopping, the `/healthz` check and `POCOLOBBY_CLIENT_IP_HEADER = "fly-client-ip"`. The `fly.toml` in the repository root is pocolobby.com's own; replace it in your copy. From a clone of the repository (`git clone https://github.com/johansan/pocolobby`), with [flyctl](https://fly.io/docs/flyctl/install/) installed and `fly auth login` done:

```sh
cp deploy/fly.toml fly.toml
# In fly.toml: app = your app name, primary_region = the region nearest you.
fly apps create YOUR-APP
node -p '"POCOLOBBY_ADMIN_TOKEN=" + require(require("os").homedir() + "/.pocolobby/owner.json").token' \
  | fly secrets import --app YOUR-APP
fly deploy --app YOUR-APP --ha=false
curl https://YOUR-APP.fly.dev/healthz
pocolobby set-url --config ~/.pocolobby/owner.json --url https://YOUR-APP.fly.dev
```

These steps have not yet been run from scratch on a new Fly account. `fly deploy` creates the volume from `initial_size` on the first deploy. `--ha=false` keeps it to one Machine; check with `fly machines list` that there is exactly one. Fly has no free tier: after a short trial it bills a card for what runs.

## Railway (untested)

Railway builds the Dockerfile in the repository. The service needs one replica, a volume at `/data`, the variable `PORT=8787` (Railway routes to the port `PORT` names) and the variable `POCOLOBBY_ADMIN_TOKEN`, all before its first deploy, since the broker does not start without the token. With the [Railway CLI](https://docs.railway.com/guides/cli) installed and `railway login` done, from a clone of the repository:

```sh
railway init --name YOUR-PROJECT
railway add --service pocolobby --variables "PORT=8787"
node -e 'process.stdout.write(require(require("os").homedir() + "/.pocolobby/owner.json").token)' \
  | railway variable set POCOLOBBY_ADMIN_TOKEN --stdin --skip-deploys
railway volume add --mount-path /data
railway up --detach
railway domain
```

The token goes through a pipe, never onto the screen or a command line. Set the health check path `/healthz` in the service's settings, then run `pocolobby set-url` with the `.up.railway.app` address `railway domain` printed. Railway's free plan is too small to keep a broker running; the Hobby plan is. These commands follow Railway's documentation; they have not been run against PocoLobby yet.

## Render (untested)

`render.yaml` describes one Docker web service, `pocolobby`, on the 0.5 CPU instance with a 3 GB disk at `/data`, the `/healthz` check, `PORT=8787` and automatic deploys off. Render's disks need a paid instance.

1. On your computer, run `pocolobby init` as above and copy the token to the clipboard without printing it, for example on a Mac:

   ```sh
   node -e 'process.stdout.write(require(require("os").homedir() + "/.pocolobby/owner.json").token)' | pbcopy
   ```

   On Windows, pipe it to `Set-Clipboard` in PowerShell instead.

2. Open [render.com/deploy?repo=https://github.com/johansan/pocolobby](https://render.com/deploy?repo=https://github.com/johansan/pocolobby), sign in, paste the token as the value of `POCOLOBBY_ADMIN_TOKEN`, and deploy.
3. When the service is live, run `pocolobby set-url` with its `.onrender.com` address.

Render creates the service in its default region, Oregon, unless you change `region` in a copy of the file. These steps follow Render's documentation; they have not been run against PocoLobby yet.

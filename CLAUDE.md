# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Melreels — a video streaming platform delivered as a Telegram Mini App (WebApp), with a Telegram bot as the admin/content-management interface. Node.js/Express backend, plain PostgreSQL (via `pg` Pool, no BaaS layer) for data, PIX (Brazilian instant payment) for checkout via EFI Bank (primary) and MercadoPago (backup). Deployed on Railway.

## Commands

- Install deps: `npm install`
- Run server: `node app.js` (or `npm start`). Deployed on Railway in production (see `railway.json`); a leftover empty `pm2` file remains from an earlier PM2-based deployment.
- No lint/test scripts are configured (`npm test` is a stub that exits 1). There is no build step — plain ESM Node.js.

## Architecture

**Almost the entire application lives in one file: `app.js` (~3600 lines).** The `src/` directory (`src/api/controllers`, `src/api/routes`, `src/bot/commands.js`, `src/bot/handlers.js`, `src/bot/middleware.js`) exists but is currently empty/unused scaffolding — do not assume logic lives there; check `app.js` first. Only `src/services/*.js` are real, in-use modules:
- `src/services/db.js` — `pg` `Pool` singleton built from `DATABASE_URL` (throws at import time if missing). SSL is enabled automatically unless the connection string points at `localhost`/`127.0.0.1` (needed for managed Postgres like Railway's). All DB access in `app.js` goes through this pool with parameterized queries (`$1, $2...`) — table names are always double-quoted (`"CONTEUDOS"`, `"VENDAS"`, etc.) since they were originally created with mixed-case identifiers. There is no ORM; Supabase-style embedded selects (e.g. `.select("*, PLANOS(nm_plano)")`) were translated to explicit `LEFT JOIN`s with aliased columns.
- `src/services/efiService.js` — EFI Bank PIX integration (`sdk-node-apis-efi`), uses `certificado.p12` at repo root for mTLS.
- `src/services/mercadopago.js` — MercadoPago PIX integration, used as a backup payment path.

`app.js` is organized into five numbered sections (search for `// N. ...` banner comments):
1. **In-memory cache** — `catalogCache` (30s TTL) for the catalog endpoint, plus `resolveVideoUrl()` which checks `STORAGE_PATH_1`/`STORAGE_PATH_2` (env, full base URLs like `https://media.melreels.com.br/filmes`) via an HTTP `HEAD` request to locate "local" video files. These aren't local disk paths anymore — they're HDs on a home PC exposed through a Cloudflare Tunnel, since the app itself runs on Railway.
2. **Telegraf Wizard Scenes** — all admin content-management flows are `Scenes.WizardScene` instances (e.g. `adicionarDramaScene`, `adicionarEpisodioScene`, `gerenciarClienteScene`, `excluirConteudoScene`, `atualizarFilmeScene`, `alterarBannerScene`, `alterarStartScene`, `editarCarrosselScene`, `alterarPrecoPlanoScene`, `consultarTxidScene`, `criarPlanoScene`, `editarNomeCategoriaPlanoScene`, `gerarLinkScene`), registered together in a single `Scenes.Stage`. Bot state is kept in a hand-rolled `customSessions` object (not Telegraf's built-in `session()` middleware) keyed by `${ctx.from.id}:${ctx.from.id}`.
3. **Express middleware & REST API** (Mini App backend) — CORS, JSON body parsing, `express.static("public")` with no-cache headers, and a global ban-check middleware that rejects requests from `userId`s present in the `BANS` table before any route handler runs.
4. **Bot commands and events** — `bot.command(...)`, `bot.action(...)`, `bot.on("photo"/"channel_post")` handlers, including a **channel-based content-ingestion pipeline**: admins post structured messages in a Telegram channel and the bot parses them to create catalog entries (see the automation formats below).
5. **Server init** — `app.listen` then `bot.launch()` inside the listen callback; `uncaughtException`/`unhandledRejection` handlers call `process.exit(1)` so PM2 restarts the process; SIGINT/SIGTERM stop the bot gracefully.

### Data model (PostgreSQL)

- `CONTEUDOS` — catalog items: `cd_conteudo` (UUID), `nm_titulo`, `nm_categoria`, `tp_formato` (FILME/SERIE/etc), `ds_generos`, `vl_aluguel`, `vl_vitalicio`, `ds_url_poster`, `ds_file_id_telegram`, `ds_url_bunny`, `tp_fonte_prioritaria` (LOCAL/BUNNY/TELEGRAM), `sn_destaque`.
- `EPISODIOS` — `cd_episodio`, `cd_conteudo` (FK), `nr_episodio`, `nm_titulo`, `ds_file_id_telegram`, `ds_url_bunny`.
- `VENDAS` — purchases/subscriptions: `cd_venda`, `nr_id_telegram`, `cd_conteudo` (null for plans), `cd_plano` (null for one-off purchases), `tp_compra` (ALUGUEL/VITALICIO/ASSINATURA), `tp_status` (PENDENTE/APROVADA), `ds_txid`, `ts_expiracao`.
- `PLANOS` — `cd_plano`, `nm_plano`, `nm_categoria`, `vl_plano`, `nr_dias_validade`.
- `BANS` — `nr_id_telegram` (checked on every API request by the global middleware).
- `CONFIGURACOES` — key/value app config (e.g. `FOTO_START`).

**Access model:** two independent ways a user can unlock content — a one-off purchase of a single item (`ALUGUEL`/`VITALICIO` against `CONTEUDOS`) or a category subscription (`ASSINATURA` against `PLANOS`). `verificarAssinaturaAtiva(userId)` checks for an approved, non-expired subscription. Category string comparisons must be done with `.toLowerCase().normalize("NFD")` to avoid accent/casing bugs — follow this pattern anywhere categories are compared.

### Video delivery cascade

`GET /api/smart-stream` resolves playback source in priority order **LOCAL → BUNNY (CDN) → TELEGRAM**, validating the requester's access (purchase/subscription/ban status) before serving. Both the `LOCAL` branch and `GET /api/video/:filename` no longer stream bytes themselves — they resolve the filename against `STORAGE_PATH_1`/`STORAGE_PATH_2` via `resolveVideoUrl()` and issue a `302 redirect` straight to the Cloudflare-tunneled URL, letting the origin machine handle Range requests. Telegram-hosted content is delivered through the bot (`POST /api/watch-video`) using `ds_file_id_telegram`.

### Key REST routes (Mini App)

- `GET /api/catalog` — ranked catalog (cached 30s, ranking driven by sales).
- `GET /api/user-status?userId=` — VIP/subscription status.
- `GET /api/my-contents?userId=` — content the user can access.
- `GET /api/plans` — subscription plans.
- `POST /api/create-order` — generates an EFI PIX charge.
- `GET /api/check-payment` — checks payment status (DB first, falling back to EFI polling).
- `GET /api/smart-stream`, `GET /api/video/:filename`, `GET /api/episodes?conteudoId=` — playback.
- `POST /api/heartbeat`, `POST/GET /api/historico` — watch-progress tracking ("continue watching").
- `POST /webhook-efi` — EFI Bank payment webhook.

### Channel content-automation format

Admins publish content by posting formatted messages to a Telegram channel, parsed in the `bot.on("channel_post", ...)` handler:
- `FILME: TITULO | CATEGORIA | PREÇO | URL_POSTER`
- `EPISÓDIO: EP | SERIE_ID | NUM_EP | TITULO_EP | (BUNNY_URL opcional)`

## Frontend

`public/index.html` + `public/script.js` (~1300 lines) + `public/style.css` implement the Telegram WebApp UI served statically by Express with `no-cache` headers. There is no bundler/framework — plain JS/CSS/HTML.

## Deployment (Railway)

- Runs via `npm start` (`node app.js`). `PORT` and `DATABASE_URL` are provided by Railway; `app.listen` already binds `0.0.0.0` and falls back to `3000` locally.
- `railway.json` sets `restartPolicyType: ON_FAILURE` — matches the existing `process.exit(1)` behavior in the `uncaughtException`/`unhandledRejection` handlers (previously relied on PM2 to restart; Railway now plays that role).
- All required env vars are documented (without values) in `.env.example`. `.env`, `*.log`, and `*.rar` are gitignored — `certificado.p12` is intentionally **not** gitignored (see gotcha below).
- The app itself has no local disk to store video files on Railway — see the `STORAGE_PATH_1`/`STORAGE_PATH_2` gotcha below.

## Notable gotchas

- `certificado.p12` (EFI mTLS client cert) is committed to the repo root — be careful with it in diffs/PRs; if the repo ever goes public, treat this as a leaked credential and get it reissued by EFI.
- `STORAGE_PATH_1`/`STORAGE_PATH_2` are **not filesystem paths** despite the name — they're full base URLs (e.g. `https://media.melreels.com.br/filmes`) pointing at HDs on a home Windows PC, exposed to the internet via a Cloudflare Tunnel that starts automatically with Windows. If that PC/tunnel is offline, `resolveVideoUrl()`'s `HEAD` check fails and the cascade silently falls through to `BUNNY`/`TELEGRAM` — worth checking first when a "local" video won't play.
- The `SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_ROLE_KEY` env vars may still linger in some `.env` files from before the Postgres migration — they're unused by the app now and safe to remove.

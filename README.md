# LAST LIGHT

A coastal story about the plans we make together, and the people who remember them.

**[Play LAST LIGHT](https://last-light-app-production.up.railway.app/)**

![The ferry shelter](public/assets/backgrounds/ferry-shelter.png)

The last ferry is overdue. Six people wait under a shelter, the radio has gone quiet, and daylight is running out. Mira has a map and a little time to act. She needs someone to make a plan with her.

LAST LIGHT combines a three-chapter narrative adventure with a ChatGPT-powered companion. You can explore the coast, talk freely with Mira, agree on a plan, and revise it when the situation changes. Her memory is stored and retrieved through Walrus Memory on Mainnet.

## How to play

1. Choose **Begin crossing** and enter a name. Names are display labels; separate players receive separate identities even if they use the same name.
2. Read the scene, inspect what is around you, and use the dialogue choices or type a message to Mira.
3. Agree on what to do together. You can teach her a signal, define who calls and who answers, and explain why the plan matters.
4. Open the field journal to review your crossing and memory status. A pending write is shown as pending until its receipt and recall are verified.
5. Return later or use the private transfer link to continue in another browser or on another device.

The game has two endings, animated environments and character gestures, a voiced opening film, and sea and wind ambience. Sound and motion can be disabled. The dialogue controls support keyboard navigation.

## What Mira remembers

Mira can remember a player's name, confirmed plans, personal reasons, promises, corrections, and shared experiences. Relevant memories help her suggest the next step and coordinate an action. A remembered detail can return in the ending.

For example, you might teach her the cue “Harbor light,” tell her that she calls while you answer, and explain that your brother is on one of the boats. On a later visit, she can recall that agreement and use it during the signal-station handoff.

Memory is scoped to the player, crossing, and character. Corrections create new revisions, and old or forgotten facts are excluded from recall. The server checks scope, content integrity, and the active revision before using a stored memory. If retrieval fails, the game reports the problem rather than inventing a remembered fact. A current agreement can also be used without saving it as long-term memory.

## Architecture

| Component | Role |
| --- | --- |
| React, TypeScript, Vite | Story interface, illustrated scenes, animation, journal, and recovery controls |
| Hono on Node.js | Sessions, validated story transitions, chat, and player-confirmed actions |
| ChatGPT | Mira's live dialogue and proposed memories, accessed through a configurable OpenAI-compatible endpoint |
| Walrus Memory | Persistent NPC memory on Mainnet, retrieval, and blob receipts |
| PostgreSQL | Sessions, story progress, encrypted pending writes, receipt metadata, revisions, and recovery tokens |
| Memory worker | Submits queued writes, polls accepted jobs, verifies recall, and records confirmed receipts |

The language model proposes dialogue and actions; it cannot directly advance the story or write arbitrary game state. Actions are checked against the current scene and version and require player confirmation.

PostgreSQL coordinates the application. It does not replace Walrus as Mira's long-term memory store. The worker clears completed queued payloads after verification. A name alone is not a recovery credential: the private transfer link authorizes access to the saved crossing.

## Requirements

- Node.js 24 and npm
- PostgreSQL 17, or Docker for the included database service
- A ChatGPT-capable endpoint supporting OpenAI-style `/v1/chat/completions`, with a model ID and server API key
- A Walrus Memory Mainnet account and an authorized delegate key

ChatGPT dialogue and persistent memory require your own service credentials. The repository does not include keys, player data, or saved sessions. A ChatGPT browser session is not an API key for this application.

## Local installation

```sh
git clone https://github.com/liamtren21/last-light.git
cd last-light
npm ci
```

Copy `.env.example` to `.env`. On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```sh
cp .env.example .env
```

Generate a session secret and put the output in `SESSION_SECRET`:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Set a database password in `POSTGRES_PASSWORD` and use the same password in `DATABASE_URL`. URI-encode reserved characters in the URL password. The included local database listens only on `127.0.0.1:54329`:

```sh
docker compose up -d db
```

If you use an existing PostgreSQL instance, set `DATABASE_URL` to that database instead. `DATABASE_SSL=disable` is intended only for a local or private database. Use verified TLS for a public production database.

### Configure ChatGPT

Set these values in `.env`:

```dotenv
LLM_PROVIDER=chatgpt
LLM_BASE_URL=https://your-llm-endpoint.example/v1
LLM_ALLOWED_ORIGINS=https://your-llm-endpoint.example
LLM_API_KEY=your_server_api_key
LLM_MODEL=your_chatgpt_model_id
```

Use the exact model identifier accepted by your endpoint. `LLM_BASE_URL` ends at `/v1`; the application appends `/chat/completions`. Public endpoints must use HTTPS and their origin must be listed in `LLM_ALLOWED_ORIGINS`. Credentials stay on the server.

### Configure Walrus Memory

Create a Mainnet account and delegate at [Walrus Memory](https://memory.walrus.xyz/dashboard), then fill in:

```dotenv
MEMWAL_ACCOUNT_ID=your_mainnet_account_object_id
MEMWAL_DELEGATE_KEY=your_authorized_delegate_private_key
MEMWAL_RELAYER_URL=https://relayer.memory.walrus.xyz
```

Keep the delegate private key out of the browser, logs, and Git. Storage availability, quotas, and fees depend on the configured service; a managed relayer should not be treated as unlimited free storage.

### Start the game and worker

In the first terminal:

```sh
npm run dev
```

In a second terminal, from the same directory:

```sh
npm run worker
```

Open **http://127.0.0.1:4328**. The API runs on port **4329**. Database migrations run at API and worker startup. Use a dedicated database for this application.

The game can open without live credentials, but free-text dialogue and persistent recall are unavailable until the corresponding services are configured. There is no scripted substitute presented as a live ChatGPT reply.

Keep `SESSION_SECRET` stable across restarts and use the same value for the API and worker. Changing it can invalidate sessions and prevent existing encrypted queue entries or memory namespaces from being recovered normally.

## Production deployment

The Dockerfile builds the frontend and serves it with the Node API. Deploy the API, a PostgreSQL database, and a separate worker using the same server configuration.

- API command: `node node_modules/tsx/dist/cli.mjs server/index.ts`
- Worker command: `node node_modules/tsx/dist/cli.mjs server/memory/worker.ts`
- Health endpoint: `/api/health`
- Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT`, and an HTTPS `PUBLIC_ORIGIN`.
- Keep `SESSION_SECRET`, database settings, LLM settings, and Walrus settings consistent between the API and worker.

Railway service configurations are in `deploy/railway-app.json` and `deploy/railway-worker.json`. Set their variables through the hosting dashboard; do not upload a filled `.env` file.

For a server with Docker and a domain, copy `.env.production.example` to `.env.production`, configure the values, point DNS to the server, and run:

```sh
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

This configuration uses Caddy for HTTPS and persistent volumes for PostgreSQL. Back up the database and server secrets before changing the deployment. Walrus memory alone is not a replacement for the session and game-state backup.

## Development checks

```sh
npm run typecheck
npm test
npm run build
```

Unit tests use fixture transports and do not prove a live Mainnet write. PostgreSQL integration tests require a separate disposable test database. Run them with `DATABASE_URL` and `DATABASE_SSL` pointing to that database and serialize the test files:

```sh
npm test -- --no-file-parallelism
```

Set `LAST_LIGHT_DATABASE_TEST=1` to enable the PostgreSQL integration suites; otherwise they are skipped. In PowerShell, set the environment variables before running the command:

```powershell
docker compose exec db createdb -U last_light last_light_test
$env:DATABASE_URL = 'postgresql://last_light:YOUR_TEST_PASSWORD@127.0.0.1:54329/last_light_test'
$env:DATABASE_SSL = 'disable'
$env:LAST_LIGHT_DATABASE_TEST = '1'
npm test -- --no-file-parallelism
```

Browser checks:

The full browser suite also needs the disposable local test database configured in `.env`, because some compatibility tests seed older save formats. Use a test session secret and leave live LLM and Walrus credentials blank. Do not point this suite at a production database. Stop existing development servers before running it so Playwright starts the API with the test configuration.

```sh
npx playwright install chromium
npm run test:e2e
```

Live checks use your configured credentials:

```sh
npm run verify:provider
npm run verify:memwal-auth
```

The provider check makes an LLM request. The Walrus authentication check performs signed reads; it does not create a memory blob. Neither command replaces an end-to-end storage and recall check in the game.

## Repository layout

```text
src/        Game interface, story data, animation, and client API
server/     API, chat validation, memory retrieval, and worker
db/         PostgreSQL schema and migrations
public/     Assets used by the playable game
tests/      Gameplay, chat, memory, identity, and browser tests
scripts/    Service checks and scoped memory maintenance
deploy/     Hosting and reverse-proxy configuration
```

## Troubleshooting

- **Mira cannot reply:** check the model ID, API key, endpoint URL, origin allowlist, and provider quota.
- **Memory stays pending:** make sure the worker is running with the same database and credentials as the API. An uncertain submission is reconciled rather than blindly resubmitted.
- **Recovery fails:** use a valid private transfer link. Entering the same display name does not restore another player's identity.
- **The browser cannot reach the API:** check ports 4328 and 4329 and ensure `PUBLIC_ORIGIN` matches the frontend origin.
- **Production cannot start:** verify the database URL, HTTPS origin, and session secret of at least 32 characters.

The opening film can be skipped. If it cannot load, its transcript is available and the player can still begin the story.

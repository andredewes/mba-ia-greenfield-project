# StreamTube Frontend

Next.js 16 frontend for StreamTube. The app follows a BFF model: browser requests go to same-origin Route Handlers under `app/api/**`, and those handlers call the NestJS API server-side.

## First Run

Start the backend first, then run the frontend stack:

```bash
cp .env.example .env.local
docker compose up -d
docker compose exec next-frontend npm install
docker compose exec -d next-frontend npm run dev
```

The app is available at <http://localhost:3001>.

## Environment

`API_URL` must be reachable from inside the `next-frontend` container. With the backend running from its separate Compose stack, use `http://host.docker.internal:3000`.

`SESSION_PASSWORD` protects the iron-session cookie and must have at least 32 characters.

## Regular Startup

```bash
docker compose up -d
docker compose exec -d next-frontend npm run dev
```

## Tests

Vitest tests use MSW and do not call the real backend:

```bash
docker compose exec next-frontend npm test
```

Playwright runs on the host against the containerized dev server. Start the dev server with server-side MSW enabled:

```bash
docker compose exec -d next-frontend sh -c "MSW_ENABLED=true npm run dev"
npx playwright test
```

## Quality Checks

```bash
docker compose exec next-frontend npm run lint
docker compose exec next-frontend npm run build
```

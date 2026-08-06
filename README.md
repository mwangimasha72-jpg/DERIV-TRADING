# Deriv Synthetics Terminal

A trading terminal for Deriv's synthetic indices, built with React + Vite. It
connects directly from the browser to Deriv's own WebSocket API
(`wss://ws.derivws.com`) using an API token you paste in at runtime — nothing
is stored server-side, and no backend is involved.

## Local development

```
npm install
npm run dev
```

## Production build

```
npm install
npm run build
npm run start   # serves the built app, respects $PORT
```

## Deploying on Railway

Railway auto-detects this as a Node project via Nixpacks, runs `npm run build`
during the build phase, and `npm run start` to serve it. No environment
variables are required — each visitor supplies their own Deriv API token in
the UI.

## Security note

This app trades real funds on whatever Deriv account the pasted token
belongs to (unless it's a demo/virtual account token). Anyone with access to
the deployed URL can paste in *their own* token and trade on *their own*
account — the app never sees or stores anyone's token beyond the current
browser session.

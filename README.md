# Project CUI

A self-hosted, collaborative development workspace that runs entirely on your own machine. Built with **Node.js, Express, WebSockets** and a **Monaco / React** frontend, it bundles a real terminal (`node-pty`), a full file manager, and optional **Google Drive backup** into one page.

## Features

- **Code editor** — Monaco editor with syntax highlighting, auto-completion and a plain-text fallback if Monaco fails to load.
- **Real terminal** — persistent `node-pty` sessions that survive page reloads, with a virtual keys bar for touch devices.
- **File manager** — create, rename, delete, upload and download files; media preview for images/video/audio.
- **Collaboration** — username-based registration, invite links, multiplayer rooms with live cursors, chat and voice.
- **Google Drive backup** — opt-in, per-user: every save, new file, rename or delete is mirrored to a `Project CUI` folder in Google Drive.
- **Mobile friendly** — hamburger navigation, bottom-sheet terminal and adaptive layouts.

## Quick start

```bash
npm install
npm start          # server/index.js
```

Open `http://localhost:3300`, type a username and enter the workspace. Every user gets their own folder under the workspace root.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3300` | HTTP + WebSocket port |
| `IDEROOT` | parent of `server/` | sandbox root where user folders are created |
| `GOOGLE_CLIENT_ID` | – | enables Google Drive backup (Desktop OAuth client) |
| `GOOGLE_CLIENT_SECRET` | – | Google Drive backup secret |
| `GOOGLE_REDIRECT_URI` | `urn:ietf:wg:oauth:2.0:oob:auto` | copy-paste OAuth flow redirect |

Users and Drive tokens are stored in `database.json` at the workspace root.

## Docker

```bash
docker build -t project-cui .
docker run -p 3300:3300 -v $(pwd)/data:/data \
  -e IDEROOT=/data \
  project-cui
```

## Deploy to Railway / Render

The repo ships a root `Dockerfile` (used by both platforms) plus a `render.yaml`
blueprint. HTTP and WebSocket share the same port, which the platform injects via
`PORT`.

**Railway** — create a new project linked to this repo; Railway auto-detects the
`Dockerfile`. For persistent files add a volume mounted at `/data` (`IDEROOT`).

**Render** — New → Blueprint → select this repo (uses `render.yaml`) or a Docker
web service pointing at the root `Dockerfile`. Health check: `/api/status`.

Both platforms should set `PORT` automatically. Data (users + `database.json`)
lives under `/data` (env `IDEROOT=/data`); mounting a disk there keeps it across
redeploys.

## Google Drive backup

1. Create a **Desktop** OAuth client in Google Cloud, enable the Drive API.
2. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the server.
3. In the UI tap the Google Drive icon → authorize with the copy-paste code.

Once connected, a green indicator shows the backup is active.

## Project structure

```
server/index.js      Express + WS API: files, auth, terminals, multiplayer, Drive sync
public/app.jsx       React frontend
public/style.css     Dark theme UI
public/index.html    SPA shell
```

## Tech

Express · `ws` · `node-pty` · Monaco Editor · React (in-browser Babel) · Font Awesome · Google Drive API v3
<p align="center">
  <img src="apps/web/public/icon.svg" width="96" height="96" alt="myClass logo" />
</p>

<h1 align="center">myClass</h1>

<p align="center">
  A web and mobile app (PWA) for the <b>University of Piraeus</b> Open eClass. Sign in with your UniPi account (CAS), with an assistant built on <b>Google Gemini</b>
</p>

> **A personal project.** myClass is built by one student in their own time. It is not made, run or endorsed by the University of Piraeus or the Open eClass team, and it uses only what a signed-in student can already see on eClass.

---

## Overview

**myClass** connects to the **University of Piraeus** Open eClass portals — `eclass.unipi.gr` (every department) and `thales.cs.unipi.gr` (Informatics) — using each student's institutional **CAS (SSO)** credentials.

It puts course files, announcements, deadlines, messages, `.zip` downloads, push notifications and an assistant that can act on eClass into one interface, built with **React + TypeScript + Tailwind CSS** and **Hono (Node.js)**.

---

## Features

### 1. Every University of Piraeus department (CAS SSO)
- **Sign in with your UniPi account**: Sign in with your UniPi username; your department is guessed from it (e.g. `p24xxx` → *Informatics*, `e24xxx` → *Digital Systems*) and can be changed in Settings or in Courses → All. All 11 departments' catalogs are supported.
- **Both portals**: Signs in to and merges courses across departmental and central Open eClass portals (`thales.cs.unipi.gr` + `eclass.unipi.gr`).

### 2. Your courses and the full curriculum
- **Your courses first**: Opens on the courses you are subscribed to, with one-click access to the full undergraduate curriculum (`Α' Εξάμηνο` – `Η' Εξάμηνο`) at the bottom of the page.
- **Semester filter**: Filter or expand and collapse semesters (`Α_εξάμηνο` .. `Η_Εξάμηνο`) on desktop and mobile.
- **Subscribe and leave**: Subscribe (`Εγγραφή`) or leave (`Απεγγραφή`) live Open eClass courses directly from the app or via the AI Assistant, also from another department's catalog in Courses → All.
- **Forgiving search**: The catalog search ignores accents and matches numerals however they are written (`ανάλυση 1` finds `ΑΝΑΛΥΣΗ Ι`).

### 3. Academic-year filtering
- Hides stale assignments, exam slots, announcements, and project files from previous academic years while preserving timeless lecture notes and current-year projects.

### 4. Files and `.zip` downloads
- **Browse course folders**: Navigate nested document folders and download individual lecture slides, PDFs, and lab exercises.
- **Per-course `.zip`**: Download all files of a course at once (`/api/courses/:code/documents/zip`).
- **Per-semester and all-courses `.zip`**: Download a whole semester (`Α_εξάμηνο.zip`) or every course, organized into `Εξάμηνο / Μάθημα / ...` folders.

### 5. Assistant (Google Gemini)
- **Knows your courses**: Answers questions about your current assignments/projects, announcements, professors, uploaded files, and semester subjects.
- **Asks before acting**: Can subscribe you to a course, unenroll you when a semester ends, or archive completed semesters. It always shows a confirmation card (`[Confirm] [Cancel]`) before changing anything on eClass.
- **Joins the course you mean**: Say it the way you would ("γράψε με στην Ανάλυση 1", "ανάλυση ένα", "Analysis I", `ΤΜΑ117` typed on a Greek keyboard). The server looks the course up in the catalog before any card is shown, ignoring accents and reading `1` / `ένα` / `Ι` as the same numeral; a course code is also looked up in the department it belongs to. If several courses fit, the assistant lists them and asks; if a course is already joined, closed, or needs the teacher's registration code, it says so instead of showing a card that would fail.
- **Works without setup**: Uses the server's shared Gemini key (`GEMINI_API_KEY`, cheapest available Flash / Flash-Lite model picked automatically), limited to 15 requests per student per hour (`AI_HOURLY_LIMIT`). Students who add their own **Google AI Studio API key** (encrypted at rest) have no limit.
- **Summaries and study material**: Summarizes a lecture file, or turns it into flashcards, a quiz or exam-style questions with model answers. Password-locked PDFs get a clear message instead of an error.
- **Announcement triage**: Sorts announcements into *Action needed* and *FYI*.

### 6. Mobile and push notifications (PWA)
- **Swipe navigation**: Swipe left and right on mobile to move between pages (`Home` ↔ `Courses` ↔ `Inbox` ↔ `AI Assistant` ↔ `Settings`).
- **Installable (PWA)**: Add `myClass` to your phone's home screen on **Android** or **iOS (Safari 16.4+)** to run it full screen.
- **Live updates and Web Push (VAPID)**: Background polling picks up new announcements, messages and deadlines and sends them through **Server-Sent Events (SSE)** and **Web Push** (`/sw.js`). Deadline reminders go out 24 hours and 1 hour before each deadline.
- **One inbox**: Notifications and course announcements share one list, with *Announcements* and *Action needed* filters.
- **Calendar feed and widget**: Subscribe to your deadlines as a calendar feed (Google Calendar, Apple Calendar), or add the deadlines widget on Windows 11.

### 7. Languages, themes and accessibility
- **Bilingual**: Instant switch between **Greek (`ΕΛ`)** and **English (`EN`)**.
- **Light and dark themes**: Follows the device, or pick one in Settings.
- **Accessibility**: Four text sizes and a reduced-motion option (follows the device by default).

---

## Security and privacy

- **AES-256-GCM encryption at rest**: When *"Remember me"* is enabled for background notifications, CAS credentials, serialized Open eClass cookie jars, and user-supplied Gemini API keys are encrypted using **AES-256-GCM** with random 96-bit IVs and 128-bit authentication tags (`apps/server/src/crypto.ts`).
- **HttpOnly session cookies**: Browser sessions use random 192-bit session IDs stored in `HttpOnly`, `SameSite=Lax` cookies.
- **Rate limiting and security headers**: Login rate limiting and strict API response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`).
- **Delete your data**: Users can permanently delete all local session data, encrypted credentials, and settings at any time from **Settings → Delete my data**.
- **Nothing sensitive in git**: `.gitignore` excludes `.env*`, `.data/`, and live session artifacts so sensitive data is never committed.

---

## Project structure

```text
myClass/
├── apps/
│   ├── server/                 # Hono + TypeScript backend API (port 8787)
│   │   └── src/
│   │       ├── eclass/
│   │       │   ├── connector.ts          # Live Open eClass & CAS SSO client
│   │       │   ├── course-match.ts       # Finds the course a typed name or code means
│   │       │   ├── parsers.ts            # HTML/AJAX/RSS/CSRF parsers for Open eClass
│   │       │   ├── unipi-curriculum.ts   # Semester mapping (Α'–Η') & academic-year filters
│   │       │   └── universities.ts       # University of Piraeus portal
│   │       ├── ai.ts                     # Gemini AI assistant & tool calling
│   │       ├── crypto.ts                 # AES-256-GCM encryption utilities
│   │       ├── poller.ts                 # Background notification poller & Web Push (VAPID)
│   │       ├── store.ts                  # Encrypted local persistence layer
│   │       └── index.ts                  # HTTP/SSE API routes
│   └── web/                    # React 19 + Vite + Tailwind CSS v4 frontend (port 5173)
│       ├── public/
│       │   ├── icon.svg                  # myClass vector icon
│       │   ├── icon-192.png              # 192x192 PWA & Web Push notification icon
│       │   ├── icon-512.png              # 512x512 PWA maskable icon
│       │   ├── apple-touch-icon.png      # 180x180 iOS Home Screen icon
│       │   ├── manifest.webmanifest      # Web App Manifest (standalone PWA)
│       │   └── sw.js                     # Service Worker for Web Push notifications
│       └── src/
│           ├── App.tsx                   # Desktop & mobile swipe UI views
│           ├── api.ts                    # Typed API client & Web Push registration
│           ├── i18n.ts                   # Greek (el) & English (en) dictionary
│           └── index.css                 # Light/dark theme tokens & animations
└── packages/
    └── shared/                 # Shared TypeScript types & Zod schemas (@myclass/shared)
```

---

## Getting started

### Prerequisites
- **Node.js** `>= 20.x`
- **npm** `>= 10.x`

### 1. Install dependencies
```bash
npm install
```

### 2. Environment (optional)
Copy `apps/server/.env.example` to `apps/server/.env` if you want to pin custom keys. In development, `ENCRYPTION_KEY` and the VAPID keys are generated automatically in `apps/server/.data/` when they are not set:

```env
PORT=8787
WEB_ORIGIN=http://localhost:5173

# 32-byte key, base64-encoded, for AES-256-GCM credential encryption
# (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
ENCRYPTION_KEY=

# Shared Gemini key so the assistant works for everyone without setup
# (students can still add their own key in Settings). https://aistudio.google.com/app/apikey
GEMINI_API_KEY=
# Optional: force a model; empty = best available Flash / Flash-Lite
GEMINI_MODEL=
# Requests per hour for students on the shared key (0 = no limit)
AI_HOURLY_LIMIT=15
```

### 3. Run in development
```bash
npm run dev
```
- **Web app**: [http://localhost:5173](http://localhost:5173)
- **API server**: [http://localhost:8787](http://localhost:8787)

### 4. Typecheck, test and build
```bash
npm run typecheck
npm test
npm run build
```

### 5. Deploying to production
`npm run build` builds the web app; `npm start` then serves both the API and the built web app from one Node process on `PORT`.

Set these environment variables on the host (the server prints a warning at startup for each one that is missing when `NODE_ENV=production`):

| Variable | Why it matters |
| --- | --- |
| `NODE_ENV=production` | Enables production defaults (Secure session cookies, `WEB_ORIGIN` defaults to `PUBLIC_URL`). |
| `PUBLIC_URL` | The public `https://` address of the app. Used for the Google OAuth redirect and as the web origin. |
| `DATA_DIR` | Folder for `db.json` (users, sessions, encrypted credentials). Point it at a **persistent disk/volume** — on hosts with an ephemeral filesystem everything is lost on each redeploy otherwise. |
| `ENCRYPTION_KEY` | Keeps the encryption key out of `DATA_DIR`, so a copy of the data alone cannot be decrypted. Must stay the same across deploys or stored credentials become unreadable. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Keep Web Push subscriptions valid across deploys (`npx web-push generate-vapid-keys`). |
| `GEMINI_API_KEY` | The shared key behind the assistant, summaries and study material. `.env` is not deployed, so set it on the host too; without it AI only works for students who add their own key. The server logs `[ai] shared Gemini key OK` at startup when it works. |

---

## Push notifications on mobile

1. Open `myClass` on your phone browser (**Chrome** on Android or **Safari** on iOS 16.4+).
2. Add it to your home screen:
   - **iOS (Safari)**: Tap **Share** → **Add to Home Screen** (`Προσθήκη στην Οθόνη Αφετηρίας`).
   - **Android (Chrome)**: Tap the menu (`⋮`) → **Add to Home screen / Install app**.
3. Open `myClass` from your home screen, go to **Settings → Notifications**, and tap **Turn on** (`Ενεργοποίηση`).

---

## License

MIT. This is a personal, non-commercial project with no official connection to the University of Piraeus.

<p align="center">
  <img src="apps/web/public/icon.svg" width="96" height="96" alt="myClass Logo" />
</p>

<h1 align="center">myClass — Personal AI Assistant for Open eClass</h1>

<p align="center">
  A minimalist, security-first web & mobile PWA assistant for Greek universities' <b>Open eClass (GUnet)</b> platforms, powered by <b>CAS Single Sign-On</b> and <b>Google Gemini</b>.
</p>

---

## ✨ Overview

**myClass** connects directly to live university **Open eClass** portals (starting with the **University of Piraeus** — both `thales.cs.unipi.gr` and `eclass.unipi.gr`, plus major Greek universities including UoA, NTUA, AUTh, AUEB, UPatras, UoM, and UniWA) using each student's institutional **CAS (SSO)** credentials.

It unifies course materials, announcements, deadlines, inbox messages, bulk `.zip` downloads, mobile push notifications, and an action-capable **AI Assistant** in a fast, minimalist interface built with **React + TypeScript + Tailwind CSS** and **Hono (Node.js)**.

---

## 🚀 Key Features

### 1. Automatic University & Department Detection (CAS SSO)
- **Zero-Configuration Login**: Automatically detects your university and department directly from your CAS username (e.g. `p24xxx` → *University of Piraeus · Department of Informatics*, `e24xxx` → *Digital Systems*, etc.).
- **Dual-Portal Synchronization**: Seamlessly authenticates and merges courses across departmental and central Open eClass portals (`thales.cs.unipi.gr` + `eclass.unipi.gr`).

### 2. Minimalist Semester Curriculum & Subscribed Classes
- **Subscribed Classes by Default**: Opens directly to the courses you are subscribed to, with 1-click access to the full undergraduate curriculum (`Α' Εξάμηνο` – `Η' Εξάμηνο`) at the bottom of the page.
- **Minimalist Semester Dropdown & Collapsible Accordions**: Filter or expand/collapse semesters (`Α_εξάμηνο` .. `Η_Εξάμηνο`) cleanly on both desktop and mobile.
- **1-Click Course Subscription**: Subscribe (`Εγγραφή`) or leave (`Απεγγραφή`) live Open eClass courses directly from the app or via the AI Assistant.

### 3. Smart Academic-Year Filtering
- Automatically filters out stale assignments, exam slots, announcements, and project files from previous academic years while preserving timeless lecture notes and current-year projects.

### 4. Bulk File & Semester `.zip` Downloads
- **Browse Course Directories**: Navigate nested document folders and download individual lecture slides, PDFs, and lab exercises.
- **Per-Course `.zip` Download**: Download all files of any subject in a single click (`/api/courses/:code/documents/zip`).
- **Per-Semester & All-Courses `.zip` Archives**: Download an entire semester folder (`Α_εξάμηνο.zip`) or all courses at once, automatically organized into `Εξάμηνο / Μάθημα / ...` folders.

### 5. AI Assistant (Google Gemini)
- **Full Curriculum & Live Course Awareness**: Answers questions about your current assignments/projects, announcements, professors, uploaded files, and semester subjects.
- **Confirmed Actions**: Can subscribe you to a course, unenroll you when a semester ends, or archive completed semesters — always presenting an interactive **Confirmation Card (`[Confirm] [Cancel]`)** before executing any change on eClass.
- **Flexible Gemini Connection**: Connect via **Google OAuth**, a personal **Google AI Studio API Key** (encrypted at rest), or the built-in smart assistant.

### 6. Mobile-First Ergonomics & Home Screen Push Notifications (PWA)
- **Horizontal Touch Swipe Navigation**: Swipe left and right on mobile to slide smoothly between pages (`Home` ↔ `Courses` ↔ `Inbox` ↔ `AI Assistant` ↔ `Settings`).
- **Installable Home Screen Web App (PWA)**: Save `myClass` to your phone's Home Screen on **Android** or **iOS (Safari 16.4+)** for a standalone full-screen experience with custom minimalist icons.
- **Real-Time SSE & Web Push (VAPID)**: Background polling detects new announcements, messages, and deadlines and delivers real-time alerts via **Server-Sent Events (SSE)** and native **Web Push** notifications via `/sw.js`.

### 7. Minimalist Bilingual UI & Dark/Light Themes
- **Bilingual**: Instant switch between **Greek (`ΕΛ`)** and **English (`EN`)**.
- **Minimalist Palette**: Soft light surfaces in **Light Mode** and deep obsidian/purple tones (`#0A0910` / `#13111C` / `#A78BFA`) in **Dark Mode**.

---

## 🔒 Data Security & Privacy Architecture

- **AES-256-GCM Encryption at Rest**: When *"Remember me"* is enabled for background notifications, CAS credentials, serialized Open eClass cookie jars, and user-supplied Gemini API keys are encrypted using **AES-256-GCM** with random 96-bit IVs and 128-bit authentication tags (`apps/server/src/crypto.ts`).
- **HttpOnly Session Cookies**: Browser sessions use random 192-bit session IDs stored in `HttpOnly`, `SameSite=Lax` cookies.
- **Brute-Force Rate Limiting & Security Headers**: Built-in login rate limiting and strict API response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`).
- **1-Click Data Erasure**: Users can permanently wipe all local session data, encrypted credentials, and settings at any time from **Settings → Delete my stored data**.
- **Git-Safe by Default**: `.gitignore` strictly excludes `.env*`, `.data/`, and live session artifacts so sensitive data is never committed.

---

## 🗂️ Project Structure

```text
myClass/
├── apps/
│   ├── server/                 # Hono + TypeScript backend API (port 8787)
│   │   └── src/
│   │       ├── eclass/
│   │       │   ├── connector.ts          # Live Open eClass & CAS SSO client
│   │       │   ├── parsers.ts            # HTML/AJAX/RSS/CSRF parsers for Open eClass
│   │       │   ├── unipi-curriculum.ts   # Semester mapping (Α'–Η') & academic-year filters
│   │       │   └── universities.ts       # Greek university registry
│   │       ├── ai.ts                     # Gemini AI assistant & tool calling
│   │       ├── crypto.ts                 # AES-256-GCM encryption utilities
│   │       ├── poller.ts                 # Background notification poller & Web Push (VAPID)
│   │       ├── store.ts                  # Encrypted local persistence layer
│   │       └── index.ts                  # HTTP/SSE API routes
│   └── web/                    # React 19 + Vite + Tailwind CSS v4 frontend (port 5173)
│       ├── public/
│       │   ├── icon.svg                  # Minimalist myClass vector icon
│       │   ├── icon-192.png              # 192x192 PWA & Web Push notification icon
│       │   ├── icon-512.png              # 512x512 PWA maskable icon
│       │   ├── apple-touch-icon.png      # 180x180 iOS Home Screen icon
│       │   ├── manifest.webmanifest      # Web App Manifest (standalone PWA)
│       │   └── sw.js                     # Service Worker for Web Push notifications
│       └── src/
│           ├── App.tsx                   # Desktop & mobile swipe UI views
│           ├── api.ts                    # Typed API client & Web Push registration
│           ├── i18n.ts                   # Greek (el) & English (en) dictionary
│           └── index.css                 # Minimalist light/dark theme tokens & animations
└── packages/
    └── shared/                 # Shared TypeScript types & Zod schemas (@myclass/shared)
```

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js** `>= 20.x`
- **npm** `>= 10.x`

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration (Optional)
Copy `.env.example` to `apps/server/.env` if you want to pin custom keys (otherwise development keys for `MASTER_KEY` and `VAPID` are generated automatically in `apps/server/.data/` with `0600` permissions):

```env
PORT=8787
WEB_ORIGIN=http://localhost:5173

# 32-byte key (base64 or 64 hex chars) for AES-256-GCM credential encryption
MASTER_KEY=

# Optional default server-side Gemini API key (users can also add their own in Settings)
GEMINI_API_KEY=

# Optional Google OAuth credentials (if using full OAuth redirect flow)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8787/api/ai/google/callback
```

### 3. Run in Development Mode
```bash
npm run dev
```
- **Web App**: [http://localhost:5173](http://localhost:5173)
- **API Server**: [http://localhost:8787](http://localhost:8787)

### 4. Typecheck, Test & Production Build
```bash
npm run typecheck
npm test
npm run build
```

---

## 📱 Enabling Push Notifications on Mobile

1. Open `myClass` on your phone browser (**Chrome** on Android or **Safari** on iOS 16.4+).
2. Add the web link to your Home Screen:
   - **iOS (Safari)**: Tap **Share** → **Add to Home Screen** (`Προσθήκη στην Οθόνη Αφετηρίας`).
   - **Android (Chrome)**: Tap the menu (`⋮`) → **Add to Home screen / Install app**.
3. Open `myClass` from your Home Screen, go to **Settings → Notifications**, and tap **Enable Web Push (`Ενεργοποίηση Web Push`)**.

---

## 📄 License

MIT

# AI DJ Cara - Technical Design Document

## 1. Executive Summary

**AI DJ Cara** is a Chrome Extension that integrates into YouTube Music to provide an AI-powered Radio Jockey (RJ) experience. It seamlessly bridges the gap between songs by generating and playing context-aware voice intros that mimic professional radio hosts.

The system is designed for **low latency**, **privacy**, and **flexibility**, supporting multiple backends for Large Language Models (LLM) and Text-to-Speech (TTS), including completely offline execution via WebGPU and local servers, as well as cloud-based solutions like Google's Gemini API.

Key technical achievements include:
*   **Zero-Interruption Playback**: Uses intelligent pre-warming and caching to ensure audio is ready before the song ends.
*   **Hybrid Architecture**: Runs logic across Content Scripts, Background Service Workers, and Offscreen Documents to bypass browser restrictions on DOM access and audio playback.
*   **Persistent Caching**: Leverages the Origin Private File System (OPFS) to cache generated audio, reducing API costs and latency.

---

## 2. Architecture Overview

The extension follows the **Manifest V3** architecture, utilizing a distributed component model to handle the distinct requirements of DOM observation, state orchestration, and heavy compute/audio processing.

### High-Level Component Diagram

```mermaid
graph TD
    subgraph "YouTube Music Tab"
        Injector[Injector Script (Main World)] -- "Events (CustomEvent)" --> CS[Content Script]
        CS -- "State & Events" --> BG[Background Service Worker]
        CS -- "Playback Control" --> DOM[YouTube Music DOM]
    end

    subgraph "Extension Core"
        BG -- "Orchestration" --> OS[Offscreen Document]
        BG -- "Settings" --> Storage[Chrome Storage]
        Popup[Popup UI] -- "Config" --> Storage
    end

    subgraph "The Engine (Offscreen)"
        OS -- "LLM Generation" --> ExtServices[External APIs / WebLLM]
        OS -- "TTS Generation" --> ExtServices
        OS -- "Audio Playback" --> Audio[HTML5 Audio]
        OS -- "Persistence" --> OPFS[Origin Private File System]
    end

    subgraph "External / Local Services"
        ExtServices --> Gemini[Gemini API]
        ExtServices --> LocalServer[Local Python Server]
        ExtServices --> WebLLM[In-Browser LLM (WebGPU)]
        ExtServices --> Kokoro[In-Browser TTS (ONNX)]
    end
```

### Component Breakdown

| Component | Responsibility | Key Technologies |
| :--- | :--- | :--- |
| **Injector Script** (`injector.ts`) | Intercepts `navigator.mediaSession` metadata to detect song changes and queues instantly. Runs in the MAIN world to access internal app state. | DOM Interception, Custom Events |
| **Content Script** (`content.ts`) | Listens to events from Injector, manages application state, coordinates pre-fetching, and triggers announcements. | Custom Events, Chrome Runtime Messaging |
| **Background Service Worker** (`background.ts`) | Orchestrates the workflow, manages settings, handles "Pre-warm" and "Play" signals, manages the Offscreen lifecycle. | Chrome Messaging, Chrome Storage, Service Worker API |
| **Offscreen Document** (`offscreen.ts`) | Executes heavy tasks that require a DOM or long-running processes (WebLLM, Audio Playback, Fetching). | Web Audio API, WebGPU, OPFS, Transformers.js |
| **Popup** (`popup.ts`) | User interface for configuration (Providers, API Keys). | HTML/CSS, Chrome Storage |

---

## 3. Component Details

### 3.1. Injector Script (The Interceptor)
*   **Location**: `src/injection/injector.ts` (injected into `MAIN` world).
*   **Mechanism**:
    *   Patches `navigator.mediaSession.metadata` setter.
    *   Detects `set` calls to identify song changes immediately.
    *   Dispatches `YTM_EXT_TRIGGER` (Song Changed) and `YTM_EXT_UPDATE` (Info Update) events.
*   **Why?**: XPath polling is slow and unreliable for instant detection. Intercepting the internal state provides zero-latency updates.

### 3.2. Content Script (The Coordinator)
*   **Location**: `src/content/content.ts`
*   **Context**: Runs in the context of `https://music.youtube.com/*` (ISOLATED world).
*   **Event Handling**:
    *   Listens for `YTM_EXT_TRIGGER` from `injector.ts`.
    *   Listens for `TTS_ENDED` from `background.ts`.
*   **Logic**:
    *   **Song Change**: Triggers `triggerAnnounce` for the transition (if cached/ready) and `schedulePrefetch` for the *next* transition.
    *   **Prefetch Scheduling**: Delays prefetch by 15s to avoid spamming APIs during rapid skipping.

### 3.3. Background Service Worker (The Orchestrator)
*   **Location**: `src/background/background.ts`
*   **Context**: Event-driven Service Worker.
*   **Responsibilities**:
    1.  **Session Caching**: Maintains an in-memory (via `chrome.storage.session`) cache of generated text.
    2.  **Offscreen Lifecycle**: Automatically creates `offscreen.html` when needed and destroys it when idle.
    3.  **Message Routing**: Bridges `content.ts` and `offscreen.ts`.

### 3.4. Offscreen Document (The Engine)
*   **Location**: `src/offscreen/offscreen.ts`
*   **Context**: Hidden HTML document (`offscreen.html`).
*   **Core Capabilities**:
    *   **LLM Service**: Calls Gemini API (`gemini-2.5-flash`), WebLLM (Llama 3.1), or Local Server.
    *   **TTS Service**: Calls Gemini TTS, Kokoro JS (ONNX), or Local Server.
    *   **Validation**: Implements the `shouldShutTheFuckUp` check (The "Shut The F*** Up" protocol) to ensure the intro matches the currently playing song before starting audio.

---

## 4. Data & Control Flow

### 4.1. The Pre-warming Pipeline (Look-Ahead Generation)
1.  **Trigger**: `content.ts` schedules a prefetch 15 seconds after a song starts.
2.  **Request**: Sends `PREWARM_RJ` to `background.ts` with metadata (Current -> Next).
3.  **Generation**:
    *   `background.ts` checks cache.
    *   If miss, calls `GENERATE_RJ` (Offscreen).
    *   LLM generates text.
4.  **Audio Pre-fetch**:
    *   `background.ts` triggers `PRELOAD_AUDIO`.
    *   `offscreen.ts` generates audio (TTS) and saves to OPFS (`dj_audio_<hash>.wav`).

### 4.2. The Announcement Sequence
1.  **Trigger**: `injector.ts` detects song change.
2.  **Action**: `injector.ts` sends `YTM_EXT_TRIGGER`. `content.ts` receives it.
3.  **Request**: `content.ts` sends `SONG_ABOUT_TO_END` (legacy naming, effectively "Play Transition") to `background.ts`.
4.  **Playback**:
    *   `background.ts` retrieves text.
    *   Sends `PLAY_AUDIO` to `offscreen.ts`.
    *   `offscreen.ts` checks `shouldAbortPlayback` (verifies song titles match).
    *   Plays audio from OPFS or generates on-the-fly.
5.  **Resume**:
    *   `offscreen.ts` finishes audio.
    *   `background.ts` sends `TTS_ENDED`.
    *   `content.ts` dispatches `YTM_EXT_RESUME` to `injector.ts` (or handled internally) to unlock playback.

---

## 5. Storage & Caching Strategy

### 5.1. Text Cache
*   **Storage**: `chrome.storage.session`.
*   **Key**: `rj_intro_<OldTitle>_<NewTitle>`.

### 5.2. Audio Cache (Tier 1: Memory)
*   **Storage**: `Map<string, Promise<string>>` in `offscreen.ts`.
*   **TTL**: 10 minutes.

### 5.3. Audio Cache (Tier 2: Persistent OPFS)
*   **Storage**: Origin Private File System.
*   **Key**: SHA-256 hash of `text + provider`.
*   **Cleanup**: Probabilistic (10% chance), deletes files > 30 mins old.

---

## 6. External Integrations

### 6.1. Gemini API (Google)
*   **LLM**: `gemini-2.5-flash`.
*   **TTS**: `gemini-2.5-flash-preview-tts` (Voice: "Aoede").

### 6.2. WebLLM (Local Browser)
*   **Model**: Llama 3.1 8B (4-bit quantized).
*   **Engine**: `MLC-LLM` via WebGPU.

### 6.3. Kokoro JS (Local Browser)
*   **Model**: Kokoro-82M (ONNX).
*   **Voice**: `af_bella` (American Female).

### 6.4. Local Server (Python)
*   **Communication**: HTTP POST to `localhost:<port>`.
*   **Endpoints**: `/generate` (LLM), `/speak` (TTS).

---

## 7. Security & Privacy

*   **CSP**: Restricted to `self`, `wasm-unsafe-eval` (ONNX/WebLLM).
*   **Permissions**: `offscreen`, `host_permissions` (`music.youtube.com`, `localhost`, `generativelanguage.googleapis.com`).

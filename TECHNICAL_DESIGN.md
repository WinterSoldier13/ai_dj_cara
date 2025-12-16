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
        CS[Content Script] -- "Polls DOM" --> DOM[YouTube Music DOM]
        CS -- "State & Events" --> BG[Background Service Worker]
        CS -- "Playback Control" --> DOM
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
| **Content Script** (`content.ts`) | Observes song state, detects transitions, controls playback, and injects UI. | DOM API, MutationObserver (Poller), XPath |
| **Background Service Worker** (`background.ts`) | Orchestrates the workflow, manages settings, handles "Pre-warm" and "Play" signals, manages the Offscreen lifecycle. | Chrome Messaging, Chrome Storage, Service Worker API |
| **Offscreen Document** (`offscreen.ts`) | Executes heavy tasks that require a DOM or long-running processes (WebLLM, Audio Playback, Fetching). | Web Audio API, WebGPU, OPFS, Transformers.js |
| **Popup** (`popup.ts`) | User interface for configuration (Providers, API Keys). | HTML/CSS, Chrome Storage |

---

## 3. Component Details

### 3.1. Content Script (The Observer)
*   **Location**: `src/content/content.ts`
*   **Context**: Runs in the context of `https://music.youtube.com/*`.
*   **Polling Mechanism**:
    *   Runs a loop every **1000ms**.
    *   Extracts `CurrentSong` and `UpcomingSong` metadata using **XPath** and CSS selectors.
    *   Tracks playback progress (`currentTime` / `duration`).
*   **State Management**:
    *   `prewarmedSongs` (Set): Tracks song pairs (Current + Upcoming) that have already triggered a generation request.
    *   `alertedSongs` (Set): Tracks song pairs that have triggered the "Song About To End" event.
*   **Playback Control**:
    *   **Pause**: Triggered when the song has < 2 seconds remaining.
    *   **Resume**: Triggered when `TTS_ENDED` message is received from the Background.
    *   **Safeguards**: Checks `isSongPaused()` state to ensure it doesn't resume if the user manually paused it (mostly).

### 3.2. Background Service Worker (The Orchestrator)
*   **Location**: `src/background/background.ts`
*   **Context**: Event-driven Service Worker.
*   **Responsibilities**:
    1.  **Session Caching**: Maintains an in-memory (via `chrome.storage.session`) cache of generated text to avoid regenerating intros if the user replays a song or if pre-warming succeeded.
    2.  **Offscreen Lifecycle**: Automatically creates `offscreen.html` when needed (generation or playback) and destroys it when no YouTube Music tabs are open to conserve resources.
    3.  **Message Routing**: Acts as the bridge between `content.ts` (Tab ID aware) and `offscreen.ts` (Global).

### 3.3. Offscreen Document (The Engine)
*   **Location**: `src/offscreen/offscreen.ts`
*   **Context**: Hidden HTML document (`offscreen.html`).
*   **Why Offscreen?**
    *   **Audio Playback**: Service Workers cannot play audio directly.
    *   **WebGPU Access**: Required for WebLLM (In-browser LLM).
    *   **OPFS Access**: Service Workers have limited file system access compared to Window contexts.
*   **Core Capabilities**:
    *   **LLM Service**: Dynamically imports `webllmService.ts` if WebLLM is enabled, or calls Gemini API / Local Server.
    *   **TTS Service**: Loads `KokoroTTS` (ONNX) or fetches audio blobs from APIs.
    *   **Smart Playback**: Before playing, it verifies with `content.ts` (via a proxy message through `background`) that the song state hasn't changed (The "Shut The F*** Up" protocol), preventing stale intros.

---

## 4. Data & Control Flow

### 4.1. The Pre-warming Pipeline (Look-Ahead Generation)
To ensure zero latency, the system anticipates the need for an intro.

1.  **Trigger**: `content.ts` detects the current song is **> 10%** complete.
2.  **Request**: Sends `PREWARM_RJ` to `background.ts` with metadata (Old Song, New Song).
3.  **Text Generation**:
    *   `background.ts` checks the cache.
    *   If miss, sends `GENERATE_RJ` to `offscreen.ts`.
    *   `offscreen.ts` calls the selected LLM provider (Gemini/WebLLM/Local).
    *   Resulting text is returned and cached in `chrome.storage.session`.
4.  **Audio Pre-fetch**:
    *   Immediately after text generation, `background.ts` sends `PRELOAD_AUDIO` to `offscreen.ts`.
    *   `offscreen.ts` generates/fetches the audio and stores it in **OPFS** (`dj_audio_<hash>.wav`) and an in-memory Map.

### 4.2. The Transition Sequence (The "Drop")
This is the critical path where the DJ intro plays.

1.  **Trigger**: `content.ts` detects the current song has **< 2 seconds** remaining.
2.  **Action**: `content.ts` **pauses** the YouTube Music player.
3.  **Request**: Sends `SONG_ABOUT_TO_END` to `background.ts`.
4.  **Execution**:
    *   `background.ts` retrieves the text (likely from cache).
    *   Sends `PLAY_AUDIO` to `offscreen.ts`.
5.  **Playback**:
    *   `offscreen.ts` checks the **OPFS** cache for the audio file.
    *   **Validation**: `offscreen.ts` asks `content.ts` "Are we still on Song A going to Song B?". If yes, it plays.
    *   Audio plays through an HTML5 `Audio` element.
6.  **Resume**:
    *   When audio ends, `offscreen.ts` resolves the promise.
    *   `background.ts` sends `TTS_ENDED` to `content.ts`.
    *   `content.ts` **resumes** the YouTube Music player.

---

## 5. Storage & Caching Strategy

Performance is critical. The system uses a multi-tiered caching strategy.

### 5.1. Text Cache
*   **Storage**: `chrome.storage.session`.
*   **Key**: `rj_intro_<sanitized_old_title>_<sanitized_new_title>`.
*   **Scope**: Persists as long as the browser session remains open.

### 5.2. Audio Cache (Tier 1: Memory)
*   **Storage**: `Map<string, Promise<string>>` in `offscreen.ts`.
*   **Content**: Blob URLs or Pending Promises.
*   **TTL**: Entries are removed 10 minutes after creation to free memory.

### 5.3. Audio Cache (Tier 2: Persistent OPFS)
*   **Storage**: Origin Private File System.
*   **Key**: SHA-256 hash of `text + provider`.
*   **Format**: `.wav` files.
*   **Cleanup**:
    *   Runs on a probabilistic trigger (10% chance on save).
    *   Deletes files older than **30 minutes**.
*   **Benefit**: Ensures that if a user skips back and forth, the audio doesn't need to be re-synthesized / re-fetched.

---

## 6. External Integrations

### 6.1. Gemini API (Google)
*   **LLM**: Uses `gemini-2.5-flash` for fast, witty text generation.
*   **TTS**: Uses `gemini-2.5-flash-preview-tts` (Voice: "Aoede").
*   **Data Format**: JSON Request -> JSON Response (Text) / Base64 Encoded PCM (Audio).

### 6.2. WebLLM (Local Browser)
*   **Model**: Llama 3.1 8B (4-bit quantized).
*   **Engine**: `MLC-LLM` via WebGPU.
*   **Constraint**: Requires significant VRAM and is an optional build target (`npm run build -- --env webllm`) to keep the extension size manageable.

### 6.3. Kokoro JS (Local Browser)
*   **Model**: Kokoro-82M (ONNX).
*   **Voice**: `af_bella` (American Female).
*   **Performance**: Runs on WASM/ONNX Runtime efficiently in the browser.

### 6.4. Local Server (Python)
*   **Communication**: HTTP POST to `localhost:<port>`.
*   **Endpoints**: `/generate` (LLM), `/speak` (TTS).
*   **Flexibility**: Allows users to run any GGUF model or XTTS model on their own hardware.

---

## 7. Security & Privacy

*   **CSP (Content Security Policy)**:
    *   Restricted to `self`, `wasm-unsafe-eval` (for ONNX/WebLLM).
    *   Connect sources: `localhost`, `generativelanguage.googleapis.com` (Gemini), `huggingface.co` (Model weights).
*   **Permissions**:
    *   `offscreen`: Essential for audio/AI isolation.
    *   `host_permissions`: `https://music.youtube.com/*` (Target), `http://localhost/*` (Local Server).
*   **Data Handling**:
    *   **Local/WebLLM**: No data leaves the machine.
    *   **Gemini API**: Song metadata is sent to Google, but no personal user identifiers are explicitly tracked by the extension.

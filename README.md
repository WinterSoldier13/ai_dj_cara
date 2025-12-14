# AI DJ Cara - Your Personal AI Radio Jockey 🎙️🎵

> This is better than the best fucking thing I've ever coded in my life.

**AI DJ Cara** transforms your YouTube Music experience by adding a personality to your playlist. Just like a real Radio Jockey, Cara introduces the next song with hype, wit, and energy, making your listening session feel like a live radio show curated just for you.

## ✨ Features

- **🗣️ AI Radio Jockey**: Generates context-aware, witty, and **high-energy** intros for upcoming songs. Meet **Cara**, your charismatic host who aggressively hypes up the transitions!
- **🧠 Multiple AI Models**:
  - **Gemini Nano (Chrome Built-in)**: Zero latency, runs entirely in the browser using experimental Chrome AI APIs.
  - **WebLLM**: Runs powerful local LLMs (like Llama 3) directly in your browser using WebGPU.
  - **Local Server**: Connect to your own powerful local Python server for maximum control, custom models, and zero-compromise performance.
- **🔊 Dynamic Speech**:
  - **Chrome TTS**: Lightweight, fast, and reliable.
  - **Local XTTS v2**: High-quality, emotive, and realistic voice cloning that sounds just like a real human dynamic RJ.
- **⚡ Smart Caching & Pre-fetch**:
  - Automatically identifies when a song is closing (at 50% mark).
  - Pre-generates the script and **pre-fetches** the high-quality audio from the local server.
  - Ensures the intro is ready to play instantly when the song ends, even for large audio files.
  - Includes auto-cleanup to prevent memory leaks.
- **🎧 YouTube Music Integration**: Seamlessly monitors playback and announces transitions just before a song ends.

---
## Screenshot

![Screenshot](images/image1.png)

## 🛠️ Installation & Setup

### Part 1: Chrome Extension

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/your-repo/ai_dj_cara.git
    cd ai_dj_cara
    ```

2.  **Install Dependencies & Build**

    ```bash
    npm install
    npm run build
    ```

3.  **Load into Chrome**
    - Open Chrome and go to `chrome://extensions`.
    - Enable **Developer mode** (top right).
    - Click **Load unpacked**.
    - Select the `dist` folder generated in your project directory.

### Part 2: Local Server (Optional - For High Quality Voice & LLM)

To unlock the full potential of **AI DJ Cara** with realistic voices (XTTS) and powerful LLMs (Llama), you can run the local server component.

#### Prerequisites

- Python 3.10+
- NVIDIA GPU with CUDA support (Recommended for acceptable performance)
- ~8GB VRAM for 8B models + XTTS

#### Setup Instructions

1.  **Navigate to Server Directory**

    ```bash
    cd local_server
    ```

2.  **Install Python Requirements**
    Basic CPU installation:

    ```bash
    pip install -r requirements.txt
    ```

    **🚀 For CUDA (GPU) Support (Highly Recommended)**:
    You must install the CUDA-enabled version of PyTorch. Run this command _before_ or _instead_ of the standard torch install:

    ```bash
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
    pip install -r requirements.txt
    ```

    _Note: Adjust `cu121` to match your installed CUDA version (e.g., cu118)._

3.  **Download Models**
    - **LLM**: Download a GGUF model (e.g., `Llama-3.1-8B-Instruct-Q4_K_M.gguf`) from HuggingFace.
    - **TTS**: The server uses Coqui XTTS v2. It will attempt to look for models in the defined path.
    - _Configuration_: Open `local_server/server.py` and update the paths to your models:
      ```python
      LLM_PATH = "D:/path/to/your/llama.gguf"
      SPEECH_MODEL_PATH = "D:/path/to/xtts_model_folder"
      ```

4.  **Run the Server**

    ```bash
    python server.py --start_llm --port 8008
    ```

    - `--start_llm`: Enables the LLM service. Omit if you only want to use the local TTS with WebLLM/Gemini.
    - `--port`: Default is 8008.

---

## ⚙️ Configuration

1.  Click the **AI DJ Cara** icon in your Chrome toolbar.
2.  **Model Provider**:
    - _Gemini (Chrome)_: Uses Chrome's built-in AI (requires `chrome://flags` configuration).
    - _WebLLM_: Downloads and runs models in the browser via WebGPU.
    - _Local Server_: Connects to your running Python server for generation.
3.  **Speech Service**:
    - _Chrome TTS_: Robotic but fast.
    - _Local Server_: Uses the high-quality XTTS voice from your python server.
4.  **Local Server Port**: Ensure this matches your running server (default 8008).
5.  **Test Connection**: Click to verify your extension can talk to the local server.

---

## 🧠 How It Works

1.  **Monitoring**: The content script watches the DOM on `music.youtube.com` for song progress.
2.  **Trigger**: When a song is near its end, the extension captures the current song metadata and the next up song.
3.  **Generation**:
    - A prompt is sent to the selected **Model Provider** (e.g., "The song 'Hello' is ending, introduce 'Levitating'").
    - The model returns a witty, DJ-style script.
4.  **Audio Synthesis**:
    - The script is sent to the **Speech Service** to be converted into audio.
    - If using **Local Server**, the audio is pre-fetched and cached in the background.
5.  **Playback**: The audio is played cleanly over the music (or pausing it briefly depending on configuration) to create a seamless transition.

---

## 🐛 Troubleshooting

- **"Connection Refused"**:
  - Ensure the Python server is running (`python server.py`).
  - Verify `manifest.json` permits `http://localhost`.
  - **Fix**: Reload the extension in `chrome://extensions`.
- **Latency / Delays**:
  - The extension uses "Smart Caching" to pre-load audio. If latency persists, ensure your GPU is powerful enough for XTTS v2.
  - Check the server logs to see generation times.
- **WebLLM Slow**:
  - WebLLM requires a decent GPU. First load will take time to download weights (cached afterwards).

## 📄 License

MIT License. Run wild, DJ!

import { MessageSchema } from '../utils/types';
import { RJ_SYSTEM_PROMPT } from './constants';

const audioCache = new Map<string, Promise<string>>(); // text -> Promise<blobUrl>

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
  if (message.type === 'GENERATE_RJ') {
    handleGeneration(message.payload).then(sendResponse);
    return true; // Keep channel open
  } else if (message.type === 'PLAY_AUDIO') {
    playAudio(message.payload).then(() => sendResponse({success: true})).catch((err) => sendResponse({success: false, error: err}));
    return true;
  } else if (message.type === 'PRELOAD_AUDIO') {
    preloadAudio(message.payload); // Fire and forget for response, but we log internally
    sendResponse({success: true}); 
    return false;
  }
});

async function fetchAudio(localServerPort: number, textToSpeak: string): Promise<string> {
    console.log("Fetching Audio from Local Server...");
    const response = await fetch(`http://localhost:${localServerPort}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSpeak })
    });

    if (!response.ok) throw new Error("Local Server TTS failed");

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    console.log("Audio fetched and blob created.");
    return url;
}

async function preloadAudio(payload: { localServerPort?: number; textToSpeak: string; speechProvider?: 'tts' | 'localserver' | 'gemini-api'; geminiApiKey?: string }) {
   if (audioCache.has(payload.textToSpeak)) {
       console.log("Audio already cached (or fetching) for:", payload.textToSpeak);
       return;
   }
   
   console.log("Starting Preload for:", payload.textToSpeak);

   let audioPromise;
   if (payload.speechProvider === 'localserver') {
       const port = payload.localServerPort || 8008;
       audioPromise = fetchAudio(port, payload.textToSpeak);
   } else {
       // Default to Gemini API
       audioPromise = fetchGeminiTTS(payload.geminiApiKey, payload.textToSpeak);
   }

   audioCache.set(payload.textToSpeak, audioPromise);
   
   try {
       await audioPromise;
       console.log("Audio preload completed successfully.");
       
        // Cleanup after 10 mins
        setTimeout(async () => {
            if (audioCache.has(payload.textToSpeak)) {
                try {
                    const url = await audioCache.get(payload.textToSpeak);
                    if (url) URL.revokeObjectURL(url);
                } catch(e) {}
                audioCache.delete(payload.textToSpeak);
            }
        }, 10 * 60 * 1000);

   } catch (e) {
       console.error("Audio preload failed", e);
       audioCache.delete(payload.textToSpeak); // Remove failed promise
   }
}

async function handleGeneration(payload: { oldSongTitle: string; oldArtist: string; newSongTitle: string; newArtist: string; modelProvider?: 'gemini' | 'gemini-api' | 'webllm' | 'localserver'; geminiApiKey?: string; useWebLLM?: boolean; localServerPort?: number; currentTime?: string; systemPrompt?: string }) {
    // Default to gemini-api if not specified
    const modelProvider = payload.modelProvider || 'gemini-api';

    if (modelProvider === 'localserver') {
        return generateWithLocalServer(payload);
    } else if (modelProvider === 'webllm' || payload.useWebLLM) {
        // Condition checked at build time
        if (process.env.INCLUDE_WEBLLM) {
            // Dynamic import to avoid bundling if not included
            // Note: In webpack, dynamic import usually creates a separate chunk. 
            // Since we want to control bundling via DefinePlugin, we can try require but 
            // standard dynamic import `import()` is better for splitting.
            try {
                // @ts-ignore
                const webLLMService = await import('./webllmService');
                return webLLMService.generateWithWebLLM(payload);
            } catch (e) {
                console.error("Failed to load WebLLM service:", e);
                return "WebLLM service not available in this build.";
            } 
        } else {
             console.warn("WebLLM requested but not included in this build.");
             return "WebLLM support is not enabled in this build of the extension.";
        }
    } else {
        // Default: Gemini API
        return generateWithGeminiAPI(payload);
    }
}

async function generateWithGeminiAPI(data: { oldSongTitle: string, oldArtist: string, newSongTitle: string, newArtist: string, geminiApiKey?: string, currentTime?: string }): Promise<string> {
    const apiKey = data.geminiApiKey;
    if (!apiKey) {
        console.error("Gemini API Key is missing");
        return `Coming up next: ${data.newSongTitle} by ${data.newArtist}.`;
    }

    const timeContext = data.currentTime ? ` Current time: ${data.currentTime}.` : "";
    const prompt = `Previous Song: "${data.oldSongTitle}" by "${data.oldArtist}"\nNext Song: "${data.newSongTitle}" by "${data.newArtist}"\n${timeContext}\n\nGenerate the DJ intro now:`;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: RJ_SYSTEM_PROMPT }]
                },
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Gemini API failed');
        }

        const json = await response.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
             throw new Error("Invalid response format from Gemini API");
        }
        return text;

    } catch (err) {
        console.error("Gemini API request failed:", err);
        return `Coming up next: ${data.newSongTitle} by ${data.newArtist}.`;
    }
}

async function playAudio(payload: { localServerPort?: number; textToSpeak: string; speechProvider?: 'tts' | 'localserver' | 'gemini-api'; geminiApiKey?: string }) {
    try {
        let audioPromise = audioCache.get(payload.textToSpeak);

        if (!audioPromise) {
             console.log("Audio not cached, requesting now (Just-In-Time)...");
             // Default to Gemini API if not local
             if (payload.speechProvider === 'localserver') {
                 const port = payload.localServerPort || 8008;
                 audioPromise = fetchAudio(port, payload.textToSpeak);
             } else {
                 // Default: Gemini API
                 audioPromise = fetchGeminiTTS(payload.geminiApiKey, payload.textToSpeak);
             }
             audioCache.set(payload.textToSpeak, audioPromise);
        } else {
            console.log("Playing cached audio (awaiting promise if pending).");
        }
        
        const urlOrBuffer = await audioPromise;

        // If it's a blob URL (localserver), use Audio element
        if (typeof urlOrBuffer === 'string' && urlOrBuffer.startsWith('blob:')) {
            const audio = new Audio(urlOrBuffer);
            return new Promise<void>((resolve, reject) => {
                audio.onended = () => resolve();
                audio.onerror = (e) => reject(e);
                audio.play().catch(reject);
            });
        }
        // If it's an ArrayBuffer (Gemini API returns PCM, which we convert to WAV ArrayBuffer or play directly)
        else {
             const audio = new Audio(urlOrBuffer);
             return new Promise<void>((resolve, reject) => {
                audio.onended = () => resolve();
                audio.onerror = (e) => reject(e);
                audio.play().catch(reject);
            });
        }
    } catch (e) {
        console.error("Audio playback failed", e);
        audioCache.delete(payload.textToSpeak);
        throw e;
    }
}

async function fetchGeminiTTS(apiKey: string | undefined, text: string): Promise<string> {
    if (!apiKey) throw new Error("Gemini API Key missing for TTS");

    console.log("Fetching Audio from Gemini API...");
    // Use gemini-2.5-flash-preview-tts
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Aoede" // Breezy female voice
                        }
                    }
                }
            }
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Gemini TTS failed");
    }

    const json = await response.json();
    const base64Data = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Data) throw new Error("No audio data returned from Gemini TTS");

    // Convert Base64 to ArrayBuffer (PCM)
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const pcmData = bytes.buffer;

    // Wrap PCM in WAV container
    const wavBuffer = createWavFile(pcmData);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    return url;
}

// Helper to add WAV header to raw PCM data
function createWavFile(pcmData: ArrayBuffer): ArrayBuffer {
    const numChannels = 1;
    const sampleRate = 24000;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcmData.byteLength;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const header = new ArrayBuffer(headerSize);
    const view = new DataView(header);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, byteRate, true); // ByteRate
    view.setUint16(32, blockAlign, true); // BlockAlign
    view.setUint16(34, bitsPerSample, true); // BitsPerSample

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Concatenate header and data
    const wavFile = new Uint8Array(headerSize + dataSize);
    wavFile.set(new Uint8Array(header), 0);
    wavFile.set(new Uint8Array(pcmData), 44);

    return wavFile.buffer;
}

function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

async function generateWithLocalServer(data: { oldSongTitle: string, oldArtist: string, newSongTitle: string, newArtist: string, localServerPort?: number, currentTime?: string, systemPrompt?: string }): Promise<string> {
   try {
       const port = data.localServerPort || 8008;
       const timeContext = data.currentTime ? ` Current time: ${data.currentTime}.` : "";
       const prompt = `Previous: "${data.oldSongTitle}" by ${data.oldArtist}\nNext: "${data.newSongTitle}" by ${data.newArtist}\n${timeContext}`;
       
       const response = await fetch(`http://localhost:${port}/generate`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ 
               text: prompt,
               system_prompt: data.systemPrompt || RJ_SYSTEM_PROMPT // Use passed prompt or proper RJ one
            })
       });

       const json = await response.json();
       if (json.error) throw new Error(json.error);
       
       return json.text || `Coming up next: ${data.newSongTitle}`;

   } catch (err) {
       console.error("Local Server Model failed:", err);
       return `Coming up next: ${data.newSongTitle} by ${data.newArtist}.`;
   }
}

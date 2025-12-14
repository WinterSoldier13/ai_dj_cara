import { MessageSchema } from '../utils/types';
import { CreateMLCEngine, AppConfig } from "@mlc-ai/web-llm";

const RJ_SYSTEM_PROMPT = `
  You are DJ Cara, a high-energy, witty, and charismatic radio host broadcasting live!
  Goal: Create a seamless, hype transition between two songs.
  Style: Energetic, punchy, cool, engaging. Use radio slang but keep it natural.
  Constraints: Max 2 sentences. No emojis. No repetitive phrasing like "That was... now here is...".
  Instruction: Acknowledge the vibe of the previous track briefly, then aggressively hype up the next track. Make the listener excited!
`;

const SELECTED_MODEL = "Llama-3.1-8B-Instruct-q4f16_1-MLC";

const appConfig: AppConfig = {
  model_list: [
    {
      model: `https://huggingface.co/mlc-ai/${SELECTED_MODEL}`,
      model_id: SELECTED_MODEL,
      model_lib: `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Llama-3_1-8B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm`,
    },
  ],
};

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

async function preloadAudio(payload: { localServerPort: number; textToSpeak: string }) {
   if (audioCache.has(payload.textToSpeak)) {
       console.log("Audio already cached (or fetching) for:", payload.textToSpeak);
       return;
   }
   
   console.log("Starting Preload for:", payload.textToSpeak);
   const audioPromise = fetchAudio(payload.localServerPort, payload.textToSpeak);
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

async function handleGeneration(payload: { oldSongTitle: string; oldArtist: string; newSongTitle: string; newArtist: string; modelProvider?: 'gemini' | 'webllm' | 'localserver'; useWebLLM?: boolean; localServerPort?: number; currentTime?: string; systemPrompt?: string }) {
    // Backward compatibility or default logic
    const modelProvider = payload.modelProvider || (payload.useWebLLM ? 'webllm' : 'gemini');

    if (modelProvider === 'localserver') {
        return generateWithLocalServer(payload);
    } else if (modelProvider === 'webllm') {
        return generateWithWebLLM(payload);
    } else {
        return generateInOffscreen(payload); // Gemini (Chrome AI)
    }
}

async function playAudio(payload: { localServerPort: number; textToSpeak: string }) {
    try {
        let audioPromise = audioCache.get(payload.textToSpeak);

        if (!audioPromise) {
             console.log("Audio not cached, requesting now (Just-In-Time)...");
             audioPromise = fetchAudio(payload.localServerPort, payload.textToSpeak);
             audioCache.set(payload.textToSpeak, audioPromise);
        } else {
            console.log("Playing cached audio (awaiting promise if pending).");
        }
        
        const url = await audioPromise;
        const audio = new Audio(url);
        
        return new Promise<void>((resolve, reject) => {
            audio.onended = () => {
                // Don't revoke immediately to allow replay if needed
                resolve();
            };
            audio.onerror = (e) => {
                reject(e);
            };
            audio.play().catch(reject);
        });
    } catch (e) {
        console.error("Audio playback failed", e);
        // If it failed, maybe clear cache so retry can work?
        audioCache.delete(payload.textToSpeak);
        throw e;
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

let engine: any = null;

async function getEngine() {
    if (engine) return engine;
    
    console.log("Initializing WebLLM Engine...");
    engine = await CreateMLCEngine(SELECTED_MODEL, { 
      appConfig,
      initProgressCallback: (report) => console.log("Hiring Cara RJ:", report.text)
    });
    return engine;
}


async function generateWithWebLLM(data: { oldSongTitle: string, oldArtist: string, newSongTitle: string, newArtist: string, currentTime?: string }): Promise<string> {
    try {
        console.log("Using WebLLM Model:", SELECTED_MODEL);
        const engine = await getEngine();

        const timeContext = data.currentTime ? ` Current time: ${data.currentTime}.` : "";
        
        // Use consistent prompt
        const systemPrompt = RJ_SYSTEM_PROMPT + ` You are Cara, a high-energy radio DJ. Your output must be under 3 sentences. Be punchy, cool, and direct. Use the provided time to set the mood if relevant. No emojis. No intros like "Here is the transition".`;

        const currentTask = `Previous: "${data.oldSongTitle}" by ${data.oldArtist}\nNext: "${data.newSongTitle}" by ${data.newArtist}\n${timeContext}`;

        const reply = await engine.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Previous: "Hello" by Adele\nNext: "Levitating" by Dua Lipa` },
                { role: "assistant", content: "Adele keeping it deep with Hello. Now let's pick up the pace, here is Dua Lipa turning up the heat with Levitating!" },
                
                { role: "user", content: `Previous: "Hotel California" by Eagles\nNext: "Humble" by Kendrick Lamar` },
                { role: "assistant", content: "That was the legendary Eagles. We're switching lanes completely now—turn your volume up for Kendrick Lamar." },

                { role: "user", content: currentTask }
            ],

            temperature: 0.8, // Bump slightly for creativity
            top_p: 0.9,      // Helps variety
            repetition_penalty: 1.1, // CRITICAL for 1B models to stop loops
            max_tokens: 128,
        });

        console.log("WebLLM Response:", reply);
        return reply.choices[0].message.content || `Coming up: ${data.newSongTitle}.`;
    } catch (err) {
        console.error("WebLLM failed:", err);
        return `Next up: ${data.newSongTitle} by ${data.newArtist}. Let's go!`;
    }
}

async function generateInOffscreen(data: { oldSongTitle: string, oldArtist: string, newSongTitle: string, newArtist: string }): Promise<string> {
   try {
        // @ts-ignore
        const ai = window.ai || chrome.aiAssistant;
        if (!ai) {
             console.log("AI Model not found on window or chrome");
             return `Next up: ${data.newSongTitle} by ${data.newArtist}. Let's get it.`;
        }
        
        // @ts-ignore
        const capabilities = await ai.capabilities();
        
        if (capabilities.available === 'no') {
             console.log("AI Model not available");
             return `Next up: ${data.newSongTitle} by ${data.newArtist}. Let's get it.`;
        }

        // @ts-ignore
        const session = await ai.create({
            systemPrompt: RJ_SYSTEM_PROMPT
        });

        const prompt = `The current song "${data.oldSongTitle}" by "${data.oldArtist}" just finished. The next track is "${data.newSongTitle}" by "${data.newArtist}". 
                        Output exactly the text that you will say to hype up the user, your ouput should just be the text that you as an RJ will say and nothing else.`;

        // @ts-ignore
        const response = await session.prompt(prompt);
         
        // @ts-ignore
        session.destroy();
        
        return response;

   } catch (err) {
       console.error("RJ Model failed in offscreen:", err);
       return `Stay tuned. We got ${data.newSongTitle} by ${data.newArtist} coming up next.`;
   }
}

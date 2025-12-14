import { MessageSchema } from '../utils/types';

// Currently Gemini for Chrome is not available in all regions :(
const USE_WEB_LLM = true;
const introCache = new Map<string, Promise<string>>();
const alreadyAnnounced = new Set<string>();

function getCacheKey(oldTitle: string, newTitle: string): string {
    return `${oldTitle}:::${newTitle}`;
}

export async function generateRJIntro(oldSongTitle: string, oldArtist: string, newSongTitle: string, newArtist: string, currentTime?: string): Promise<string> {
    const key = getCacheKey(oldSongTitle, newSongTitle);
    
    if (introCache.has(key)) {
        console.log(`[Cache Hit] Using pre-generated intro for ${key}`);
        return introCache.get(key)!;
    }

    console.log(`[Cache Miss] Generating new intro for ${key}`);
    
    const generationPromise = (async () => {
        try {
            // @ts-ignore
            if (!await chrome.offscreen.hasDocument()) {
              await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [chrome.offscreen.Reason.DOM_PARSER],
                justification: 'To use local AI models'
              });
            }

            const settings = await chrome.storage.sync.get(['modelProvider', 'speechProvider', 'localServerPort', 'geminiApiKey']);
            const modelProvider = settings.modelProvider || 'gemini';
            const speechProvider = settings.speechProvider || 'tts';
            const localServerPort = settings.localServerPort || 8008;
            const geminiApiKey = settings.geminiApiKey || '';

            const response = await chrome.runtime.sendMessage({
              type: 'GENERATE_RJ',
              payload: {
                oldSongTitle,
                oldArtist,
                newSongTitle,
                newArtist,
                useWebLLM: modelProvider === 'webllm', // fallback for now
                modelProvider,
                geminiApiKey,
                localServerPort,
                currentTime
              }
            });

            // Trigger Audio Preload if using Local Server TTS
            if (speechProvider === 'localserver' && response) {
                 console.log("Triggering Audio Preload for:", response);
                 chrome.runtime.sendMessage({
                    type: 'PRELOAD_AUDIO',
                    payload: {
                        localServerPort,
                        textToSpeak: response
                    }
                 });
            }

            return response;
        } catch (err) {
            console.error("RJ Model failed:", err);
            return `Stay tuned. We got ${newSongTitle} by ${newArtist} coming up next.`;
        }
    })();

    introCache.set(key, generationPromise);
    
    // Cleanup cache after 10 minutes to prevent memory leaks.
    setTimeout(() => {
        introCache.delete(key);
    }, 10 * 60 * 1000);
    
    return generationPromise;
}

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'SONG_ABOUT_TO_END' && sender.tab?.id) {
        const { currentSongTitle, currentSongArtist, upcomingSongTitle, upcomingSongArtist } = message.payload;
        // Pass currentTime here as well in case cache missed and we need it now
        const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        announceSong(sender.tab.id, currentSongTitle, currentSongArtist, upcomingSongTitle, upcomingSongArtist, currentTime);
    } else if (message.type === 'PREWARM_RJ') {
        const { oldSongTitle, oldArtist, newSongTitle, newArtist, currentTime } = message.payload;
        console.log(`[Pre-Warm] Received request for ${oldSongTitle} -> ${newSongTitle}`);
        generateRJIntro(oldSongTitle, oldArtist, newSongTitle, newArtist, currentTime);
    }
});

function announceSong(tabId: number, currentSongTitle: string, currentSongArtist: string, upcomingSongTitle: string, upcomingSongArtist: string, currentTime: string) {
    if(alreadyAnnounced.has(`${currentSongTitle}:::${upcomingSongTitle}`)) {
        console.log(`[Skip] Already announced ${currentSongTitle} -> ${upcomingSongTitle}`);
        chrome.tabs.sendMessage(tabId, { type: 'TTS_ENDED' });
        return;
    }
    
    generateRJIntro(currentSongTitle, currentSongArtist, upcomingSongTitle, upcomingSongArtist, currentTime).then(async (response: string) => {
      console.log("Generated Intro:", response);
      alreadyAnnounced.add(`${currentSongTitle}:::${upcomingSongTitle}`);
      
      // Cleanup set
      setTimeout(() => {
          alreadyAnnounced.delete(`${currentSongTitle}:::${upcomingSongTitle}`);
      }, 2 * 60 * 1000);

      const settings = await chrome.storage.sync.get(['speechProvider', 'localServerPort', 'geminiApiKey']);
      const speechProvider = settings.speechProvider || 'tts';
      const localServerPort = settings.localServerPort || 8008;
      const geminiApiKey = settings.geminiApiKey || '';

      if (speechProvider === 'localserver' || speechProvider === 'gemini-api') {
          try {
              // Ensure document exists
               // @ts-ignore
                if (!await chrome.offscreen.hasDocument()) {
                    await chrome.offscreen.createDocument({
                        url: 'offscreen.html',
                        reasons: [chrome.offscreen.Reason.DOM_PARSER],
                        justification: 'To use local AI models'
                    });
                }

              await chrome.runtime.sendMessage({
                  type: 'PLAY_AUDIO',
                  payload: {
                      localServerPort,
                      textToSpeak: response,
                      speechProvider,
                      geminiApiKey
                  }
              });
              console.log(`${speechProvider} TTS ended`);
              chrome.tabs.sendMessage(tabId, { type: 'TTS_ENDED' });
          } catch (e) {
              console.error(`Failed to play audio with ${speechProvider}`, e);
              // Fallback to Chrome TTS? Or just fail? Let's fallback.
              console.log("Falling back to Chrome TTS");
              speakNative(response, tabId);
          }
      } else {
          speakNative(response, tabId);
      }
    });
}

function speakNative(text: string, tabId: number) {
    chrome.tts.speak(text, {
        rate: 0.9,
        pitch: 1.1,
        volume: 1,
        voiceName: 'Google UK English Female',
        onEvent: (event) => {
            if (event.type === 'end') {
                console.log("TTS ended");
                chrome.tabs.sendMessage(tabId, { type: 'TTS_ENDED' });
            }
        }
      });
}

// Lifecycle Management: Close offscreen if no YTM tabs are open
async function checkOffscreen() {
    const tabs = await chrome.tabs.query({ url: "*://music.youtube.com/*" });
    if (tabs.length === 0) {
        // @ts-ignore
        if (await chrome.offscreen.hasDocument()) {
            console.log("No YTM tabs open. Closing offscreen document to free memory.");
            // @ts-ignore
            await chrome.offscreen.closeDocument();
        }
    }
}

chrome.tabs.onRemoved.addListener(checkOffscreen);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // If a tab navigates away from YTM, check if we should close
    if (changeInfo.status === 'complete') {
        checkOffscreen();
    }
});

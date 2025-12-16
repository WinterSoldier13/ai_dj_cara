import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const INDICATOR_ID = 'ai-rj-mode-indicator';
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";

/**
 * Configuration constants for DOM selectors and attributes.
 */
const SELECTORS = {
  SELECTED_ITEM: 'ytmusic-player-queue-item[selected]',
  WRAPPER: 'ytmusic-playlist-panel-video-wrapper-renderer',
  ITEM: 'ytmusic-player-queue-item',
  PRIMARY_RENDERER: '#primary-renderer',
  TITLE: '.song-title',
  ARTIST: '.byline'
} as const;

// --- State Variables ---

let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;
let videoElement: HTMLMediaElement | null = null;

// Sets to track processed songs to prevent double-firing
const prewarmedSongs = new Set<string>();
const alertedSongs = new Set<string>();
const MAX_SET_SIZE = 50;

let isDebug = false;
let isEnabled = true;

const interval_logger = new IntervalLogger(5000);

// --- Logging & Debugging ---

function log(message: any, ...args: any[]) {
    if (!isDebug) return;
    if (message instanceof Error) {
        console.error("[AI-DJ]", message, ...args);
    } else {
        console.log("[AI-DJ]", message, ...args);
    }
}

// --- Initialization & Config ---

function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();
        
        // Start the engines
        setupVideoListener();      // Fast loop (Precision Timing)
        startBackgroundPolling();  // Slow loop (Metadata Fetching)
    });
}

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.isDebugEnabled) isDebug = changes.isDebugEnabled.newValue;
        if (changes.isEnabled) {
            isEnabled = changes.isEnabled.newValue;
            updateAIRJModeIndicator();
        }
    }
});

// --- UI Helpers ---

function updateAIRJModeIndicator() {
    const logoAnchor = document.querySelector('a.ytmusic-logo');
    if (!logoAnchor) return;

    let indicator = document.getElementById(INDICATOR_ID);

    if (isEnabled) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = INDICATOR_ID;
            indicator.innerText = 'AI RJ Mode';
            // Styling
            Object.assign(indicator.style, {
                fontSize: '10px',
                fontWeight: 'bold',
                color: '#fff',
                opacity: '0.7',
                position: 'absolute',
                bottom: '-12px',
                left: '0',
                width: '100%',
                textAlign: 'center',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                fontFamily: 'Roboto, Arial, sans-serif'
            });

            const anchorStyle = window.getComputedStyle(logoAnchor);
            if (anchorStyle.position === 'static') {
                 (logoAnchor as HTMLElement).style.position = 'relative';
            }
            logoAnchor.appendChild(indicator);
        }
    } else if (indicator) {
        indicator.remove();
    }
}

// --- Playback Controls ---

export const isSongPaused = (): boolean => {
    const media = document.querySelector('video') as HTMLMediaElement | null;
    if (media) return media.paused;
    
    // Fallback to DOM Icon check
    const pathElement = document.querySelector('#play-pause-button yt-icon path');
    return pathElement?.getAttribute('d') === PLAY_PATH;
};

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) button.click();
    else log(new Error("Could not find #play-pause-button"));
};

export const pauseSong = (): void => {
    const media = document.querySelector('video') as HTMLMediaElement | null;
    if (media && !media.paused) {
        media.pause();
    } else if (!media && !isSongPaused()) {
        click_play_pause();
    }
};

export const resumeSong = (): void => {
    const media = document.querySelector('video') as HTMLMediaElement | null;
    if (media && media.paused) {
        media.play().catch(e => log("Error playing media:", e));
    } else if (!media && isSongPaused()) {
        click_play_pause();
    }
};

// --- Data Fetching ---

function getSongInfo(): CurrentSong {
    try {
        const video = document.querySelector('video') as HTMLMediaElement | null;
        
        let duration = 0;
        let currentTime = 0;
        let isPaused = true;

        if (video) {
            // FIX: Using raw float for precision. No Math.floor()!
            duration = Number.isFinite(video.duration) ? video.duration : 0;
            currentTime = video.currentTime; 
            isPaused = video.paused;
        }

        // Metadata extraction
        const metadata = navigator.mediaSession?.metadata;
        let title = metadata?.title || "";
        let artist = metadata?.artist || "";
        let album = metadata?.album || "";

        // DOM Fallback
        if (!title) {
            title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || "";
            const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
            const parts = byline.split('•').map(s => s.trim());
            artist = parts[0] || "";
            album = parts[1] || "";
        }

        return { title, artist, album, duration, currentTime, isPaused };

    } catch (e) {
        console.error('getSongInfo error', e);
        return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
    }
}

function fetchUpcomingSong(): Promise<UpcomingSong | null> {
  return new Promise((resolve) => {
    const handleResponse = (event: Event) => {
      const customEvent = event as CustomEvent;
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(customEvent.detail);
    };

    document.addEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_DATA'));
    
    // Timeout
    setTimeout(() => {
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(null);
    }, 1000);
  });
}

// --- The Core Engine (Event Driven) ---

function setupVideoListener() {
    const video = document.querySelector('video');
    if (!video) {
        // Retry logic if video tag isn't inserted yet
        setTimeout(setupVideoListener, 500); 
        return;
    }
    
    if (videoElement === video) return; // Already attached
    
    videoElement = video;
    log("✅ Attached AI DJ listener to video element.");

    // The heartbeat of the extension: Fires ~4 times/sec
    video.addEventListener('timeupdate', handleTimeUpdate);
    
    // Handle song changes (reset processed sets if needed, though keying handles this)
    video.addEventListener('loadeddata', () => {
        log("New video loaded data.");
    });
}

function handleTimeUpdate() {
    if (!isEnabled || !videoElement || videoElement.paused) return;

    const duration = videoElement.duration;
    const currentTime = videoElement.currentTime;

    // Safety: Ignore if duration is Infinity (livestream/loading)
    if (!Number.isFinite(duration)) return;

    // 1. Calculate time remaining with precision
    const timeRemaining = duration - currentTime;

    // 2. Get current metadata synchronously
    const currentInfo = getSongInfo();
    if (!currentInfo.title) return;

    // 3. Generate a Unique Key for this transition
    // We use "PENDING" if upcoming isn't fetched yet so we don't crash, 
    // but the actual alert will retry fetching.
    const nextTitle = upcomingSong?.title || "PENDING";
    const songKey = `${currentInfo.title}::${nextTitle}`;

    // Debug logging (throttled)
    if (isDebug) {
        interval_logger.log(`Time Left: ${timeRemaining.toFixed(3)}s | Key: ${songKey}`);
    }

    // 4. Cleanup Memory
    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // --- LOGIC A: PRE-WARM ---
    // Trigger when 20% of song is done
    if (duration > 0 && (currentTime / duration) > 0.2) {
        // Only trigger prewarm if we actually KNOW the upcoming song
        if (upcomingSong && !prewarmedSongs.has(songKey)) {
            log(`Pre-warming RJ model for ${songKey}`);
            prewarmedSongs.add(songKey);
            
            chrome.runtime.sendMessage({
                type: 'PREWARM_RJ',
                payload: {
                    oldSongTitle: currentInfo.title,
                    oldArtist: currentInfo.artist,
                    newSongTitle: upcomingSong.title,
                    newArtist: upcomingSong.artist,
                    currentTime: new Date().toLocaleTimeString()
                }
            });
        }
    }

    // --- LOGIC B: THE TRIGGER (Pause at 2s left) ---
    // We do NOT check for !upcomingSong here. We pause first, ask questions later.
    if (!alertedSongs.has(songKey)) {
        // Window: 2.2s to 0.2s (avoid 0.0s edge cases)
        // Duration check: >10s to ignore short ads/sounds
        if (timeRemaining <= 2.2 && timeRemaining > 0.2 && duration > 10) {
            
            log(`🔥 TIME HIT: ${timeRemaining.toFixed(3)}s remaining. PAUSING.`);
            
            // 1. Pause
            pauseSong();
            alertedSongs.add(songKey);

            // 2. Panic Fetch / Send Message
            (async () => {
                // If we don't have upcoming song data yet, grab it now
                if (!upcomingSong) {
                    log("Upcoming song missing at trigger time. Panic fetching...");
                    upcomingSong = await fetchUpcomingSong();
                }

                const message: MessageSchema = {
                    type: 'SONG_ABOUT_TO_END',
                    payload: {
                        currentSongTitle: currentInfo.title,
                        currentSongArtist: currentInfo.artist,
                        upcomingSongTitle: upcomingSong?.title || 'Unknown Song',
                        upcomingSongArtist: upcomingSong?.artist || 'Unknown Artist'
                    }
                };
                
                log("Sending Alert Message:", message);
                chrome.runtime.sendMessage(message);
            })();
        }
    }
}

// --- Background Tasks ---

// We keep a slow poll just to update 'upcomingSong' metadata in the background
// so 'handleTimeUpdate' usually has it ready when the time comes.
function startBackgroundPolling() {
    log("Starting Background Polling...");
    
    // Initial fetch
    fetchUpcomingSong().then(data => { if(data) upcomingSong = data; });

    setInterval(() => {
        if (!isSongPaused()) {
            fetchUpcomingSong().then(data => {
                if (data) {
                    upcomingSong = data;
                }
            });
        }
    }, 2000); // Check every 2 seconds
}

// --- Message Listeners ---

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    // 1. Resume after TTS
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Attempting to resume song.");
        if (isSongPaused()) {
            resumeSong();
        }
    }
    
    // 2. Respond to Popup requests
    if (message.type === 'GET_CURRENT_SONG_INFO') {
        const current = getSongInfo();
        // Return whatever we have cached
        sendResponse({
            type: 'CURRENT_SONG_INFO',
            payload: {
                currentSongTitle: current.title,
                upcomingSongTitle: upcomingSong?.title || 'Unknown'
            }
        });
    }
});

// --- Boot ---

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
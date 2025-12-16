import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const artistNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/span/span[2]/yt-formatted-string';
const currentSongNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/yt-formatted-string';
const currentSongAlbumNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/span/span[2]/yt-formatted-string/a[3]';
const currentSongTimerXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[1]/span';
const musicBarXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]';

const interval_logger = new IntervalLogger(5000);

// SVG Path constants for comparison
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";

/**
 * Configuration constants for DOM selectors and attributes.
 * Update these if YouTube Music changes their DOM structure.
 */
const SELECTORS = {
  SELECTED_ITEM: 'ytmusic-player-queue-item[selected]',
  WRAPPER: 'ytmusic-playlist-panel-video-wrapper-renderer',
  ITEM: 'ytmusic-player-queue-item',
  PRIMARY_RENDERER: '#primary-renderer',
  TITLE: '.song-title',
  ARTIST: '.byline'
} as const

const INDICATOR_ID = 'ai-rj-mode-indicator';

// --- State Variables ---
let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;

// Sets to track processed songs.
// Using a simple cleanup strategy: clear if size exceeds threshold.
const prewarmedSongs = new Set<string>();
const alertedSongs = new Set<string>();
const MAX_SET_SIZE = 50;

let isDebug = false;
let isEnabled = true;
let isFirstSong = true;

// --- Logging & Debugging ---

function log(message: any, ...args: any[]) {
    if (!isDebug) return;

    if (message instanceof Error) {
        console.error(message, ...args);
    } else {
        console.log(message, ...args);
    }
}

// Initialize state and start polling
function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();

        // Start polling only after we have the initial settings
        startPolling();
    });
}

// Listen for changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.isDebugEnabled) {
            isDebug = changes.isDebugEnabled.newValue;
        }
        if (changes.isEnabled) {
            isEnabled = changes.isEnabled.newValue;
            updateAIRJModeIndicator();
        }
    }
});

// --- Helper Functions ---

function updateAIRJModeIndicator() {
    const logoAnchor = document.querySelector('a.ytmusic-logo');
    if (!logoAnchor) return;

    let indicator = document.getElementById(INDICATOR_ID);

    if (isEnabled) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = INDICATOR_ID;
            indicator.innerText = 'AI RJ Mode';

            indicator.style.fontSize = '10px';
            indicator.style.fontWeight = 'bold';
            indicator.style.color = '#fff';
            indicator.style.opacity = '0.7';
            indicator.style.position = 'absolute';
            indicator.style.bottom = '-12px';
            indicator.style.left = '0';
            indicator.style.width = '100%';
            indicator.style.textAlign = 'center';
            indicator.style.pointerEvents = 'none';
            indicator.style.whiteSpace = 'nowrap';
            indicator.style.fontFamily = 'Roboto, Noto Naskh Arabic UI, Arial, sans-serif';

            const anchorStyle = window.getComputedStyle(logoAnchor);
            if (anchorStyle.position === 'static') {
                 (logoAnchor as HTMLElement).style.position = 'relative';
            }

            logoAnchor.appendChild(indicator);
        }
    } else {
        if (indicator) {
            indicator.remove();
        }
    }
}

// Helper to safely get text content from XPath
function getTextFromXPath(xpath: string, context: Node = document): string {
    try {
        const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue?.textContent?.trim() || '';
    } catch (e) {
        log(new Error(`getTextFromXPath error for ${xpath}:`), e);
        return '';
    }
}

const isFullScreenPlayerOpen = (): boolean => {
    const layout = document.querySelector('ytmusic-app-layout');
    if (!layout) return false;

    const state = layout.getAttribute('player-ui-state');
    // PLAYER_PAGE_OPEN = Fullscreen/Expanded
    // PLAYER_BAR_ONLY = Minimized to bottom bar
    return state === 'PLAYER_PAGE_OPEN';
};

const togglePlayer = (): void => {
    // we need to click on the musicBar
    const result = document.evaluate(
        musicBarXPath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
    );

    const element = result.singleNodeValue as HTMLElement | null;

    if (element) {
        log("Homie, clicking the player bar now...");
        element.click();
    } else {
        log(new Error("Could not find the player bar at the specified XPath."));
    }
};

export const isSongPaused = (): boolean => {
    const media = document.querySelector('video, audio') as HTMLMediaElement | null;
    if (media){
        return media.paused;
    }
    const pathElement = document.querySelector('#play-pause-button yt-icon path');

    if (!pathElement) {
        log(new Error("Play/Pause button path not found in DOM."));
        return false;
    }

    const currentPath = pathElement.getAttribute('d');
    return currentPath === PLAY_PATH;
};

export const resumeSong = (): void => {
    const tryResume = (attempt: number) => {
        if (attempt > 10) {
            log("Giving up on resumeSong after 10 attempts.");
            return;
        }

        const media = document.querySelector('video, audio') as HTMLMediaElement | null;
        if (media && !media.paused) {
            log("Resume successful (media.paused is false).");
            return;
        }

        if (media) {
             media.play().catch(e => log("Error playing media:", e));
        } else {
            click_play_pause();
        }

        // Check again after a short delay
        setTimeout(() => {
            if (isSongPaused()) {
                log(`Still paused, retrying resume... (Attempt ${attempt + 1})`);
                tryResume(attempt + 1);
            } else {
                log("Resume verified.");
            }
        }, 300);
    };

    tryResume(1);
}

export const pauseSong = (): void => {
    const media = document.querySelector('video, audio') as HTMLMediaElement | null;
    if(media?.paused) return;
    media?.pause();

    // Double check with DOM button state just in case
    setTimeout(() => {
         if(!isSongPaused()) {
             click_play_pause();
         }
    }, 100);
}

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;

    if (button) {
        button.click();
    } else {
        log(new Error("Could not find #play-pause-button"));
    }
};

// --- Core Functions ---

// export function getSongInfo(): CurrentSong {
//     try {
//         const title = getTextFromXPath(currentSongNameXPath);
//         const artist = getTextFromXPath(artistNameXPath);
//         const album = getTextFromXPath(currentSongAlbumNameXPath);
//         const timer = getTextFromXPath(currentSongTimerXPath); // it will be a string like "0:00 / 3:59"

//         if (!timer) {
//             // log(new Error('getSongInfo: Timer element not found')); // Too noisy
//             return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
//         }

//         //convert the timer string to seconds
//         const [currentTime, duration] = (() => {
//             const [currentTimeStr, durationStr] = timer.split('/');
//             const [currMinutes, currSeconds] = currentTimeStr.split(':').map(Number);
//             const [durMinutes, durSeconds] = durationStr.split(':').map(Number);
//             return [currMinutes * 60 + currSeconds, durMinutes * 60 + durSeconds];
//         })();

//         const currSong: CurrentSong = {
//             title,
//             artist,
//             album,
//             duration,
//             currentTime,
//             isPaused: isSongPaused()
//         }

//         return currSong;

//     } catch (e) {
//         log(new Error('getSongInfo: Unexpected error'), e);
//         return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
//     }
// }

function getSongInfo(): CurrentSong {
    try {
        const video = document.querySelector('video, audio') as HTMLMediaElement | null;
        
        // Default values if video isn't loaded yet
        let duration = 0;
        let currentTime = 0;
        let isPaused = false;

        if (video) {
            duration = Number.isNaN(video.duration) ? 0 : Math.floor(video.duration);
            currentTime = Math.floor(video.currentTime); 
            isPaused = video.paused;
        }

        const metadata = navigator.mediaSession?.metadata;
        
        let title = "";
        let artist = "";
        let album = "";

        if (metadata) {
            title = metadata.title;
            artist = metadata.artist;
            album = metadata.album;
        } 
        
        if (!title) {
            title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || "";
            const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
            const parts = byline.split('•').map(s => s.trim());
            artist = parts[0] || "";
            album = parts[1] || "";
        }

        return {
            title,
            artist,
            album,
            duration, // Returns seconds (e.g. 239.5)
            currentTime,
            isPaused
        };

    } catch (e) {
        console.error('getSongInfo: Unexpected error', e);
        return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
    }
}

function fetchUpcomingSong(): Promise<UpcomingSong | null> {
  return new Promise((resolve) => {
    // 1. Set up a one-time listener for the response
    const handleResponse = (event: Event) => {
      const customEvent = event as CustomEvent;
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(customEvent.detail);
    };

    document.addEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);

    // 2. Dispatch the request
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_DATA'));
    
    // Optional: Timeout if injector doesn't respond in 1 second.
    setTimeout(() => {
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(null);
    }, 1000);
  });
}

/**
 * Scrapes the YouTube Music queue to find the currently active song
 * and returns the metadata for the *next* song in the list.
 */
export const getNextSongInQueue = (): UpcomingSong | null => {
    try {
    const currentItem = document.querySelector<HTMLElement>(SELECTORS.SELECTED_ITEM);
    if (!currentItem) return null;

    // Determine the current Row (the entire wrapper if it exists, otherwise the item)
    const currentRow = currentItem.closest(SELECTORS.WRAPPER) || currentItem;

    let nextRow: Element | null = currentRow.nextElementSibling;
    let nextSongItem: HTMLElement | null = null;

    // Helper to extract item from a row (wrapper or item)
    const extractItemFromRow = (row: Element): HTMLElement | null => {
        const tagName = row.tagName.toLowerCase();
        if (tagName === SELECTORS.WRAPPER) {
            // Traverse #primary-renderer children to find the item
            // Using querySelector can be brittle with ID descendants in some contexts,
            // so finding the element directly is safer.
            const primary = row.querySelector(SELECTORS.PRIMARY_RENDERER);
            if (primary) {
                for (let i = 0; i < primary.children.length; i++) {
                     const child = primary.children[i] as HTMLElement;
                     if (child.tagName.toLowerCase() === SELECTORS.ITEM) {
                         return child;
                     }
                }
            }
        } else if (tagName === SELECTORS.ITEM) {
            return row as HTMLElement;
        }
        return null;
    }

    // 1. Try to find the next valid song in the current siblings
    // We iterate because there might be separators (like "Autoplay is on" header) or other non-song elements.
    while (nextRow) {
        const item = extractItemFromRow(nextRow);
        if (item) {
            nextSongItem = item;
            break;
        }
        nextRow = nextRow.nextElementSibling;
    }

    // 2. If no song found in current container siblings, check #automix-contents
    if (!nextSongItem) {
        const contentsContainer = currentRow.closest('#contents');
        if (contentsContainer) {
             const queueContainer = contentsContainer.parentElement; // ytmusic-player-queue
             if (queueContainer) {
                 const automixContainer = queueContainer.querySelector('#automix-contents');
                 if (automixContainer) {
                     // Check children of automix container
                     let automixChild = automixContainer.firstElementChild;
                     while (automixChild) {
                         const item = extractItemFromRow(automixChild);
                         if (item) {
                             nextSongItem = item;
                             break;
                         }
                         automixChild = automixChild.nextElementSibling;
                     }
                 }
             }
        }
    }

    if (!nextSongItem) return null;

    const titleEl = nextSongItem.querySelector<HTMLElement>(SELECTORS.TITLE);
    const artistEl = nextSongItem.querySelector<HTMLElement>(SELECTORS.ARTIST);

    return {
      title: titleEl?.getAttribute('title') || titleEl?.innerText.trim() || "Unknown",
      artist: artistEl?.getAttribute('title') || artistEl?.innerText.trim() || "Unknown"
    };

  } catch (e) {
    console.error("[YTM Scraper] Failed to extract next song:", e);
    return null;
  }
};


function get_status() {
    updateAIRJModeIndicator();

    // If Chrome extension is disabled
    if (!isEnabled) return;

    currentSong = getSongInfo();
    // upcomingSong = getNextSongInQueue();
    fetchUpcomingSong().then(data => {
        if (data) {
            upcomingSong = data;
        } else {
            // This is expected if there is no upcoming song or if the injector is not ready yet
            // log("Failed to fetch upcoming song from injector during status check.");
            upcomingSong = null;
        }
    });

    if(isDebug){
    interval_logger.log(`--- Status Check --- ${currentSong.title}::${upcomingSong?.title} ---`);
    }

    if (currentSong.title === '') {
        return;
    }

    // If paused, we don't need to do anything (music isn't progressing)
    if (isSongPaused()) return;

    // Was it the first song?
    if(isFirstSong){
        //for now do nothing
        log("This was the first song", currentSong);
        isFirstSong = false;
    }

    // Key for state tracking: Current Title + Upcoming Title
    if (!upcomingSong) return;
    const songKey = currentSong.title + "::" + upcomingSong.title;

    // Cleanup memory if sets are too big
    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // Pre-warm checking
    // Using a safe range instead of strict > 0.1, to avoid re-triggering if user seeks back.
    // However, the Set handles the 'once per session' check.
    const progress = currentSong.currentTime / currentSong.duration;
    if (progress > 0.2 && !prewarmedSongs.has(songKey)) {
        log(`Song > 20%. Pre-warming RJ model for key: ${songKey}`);
        prewarmedSongs.add(songKey);
        
        const message: MessageSchema = {
            type: 'PREWARM_RJ',
            payload: {
                oldSongTitle: currentSong.title,
                oldArtist: currentSong.artist,
                newSongTitle: upcomingSong.title,
                newArtist: upcomingSong.artist,
                currentTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
        };
        chrome.runtime.sendMessage(message);
    }

    const timeRemaining = currentSong.duration - currentSong.currentTime;
    log(`Time Remaining: ${timeRemaining}s for key: ${songKey} of duration ${currentSong.duration}`);
    log(`Has alerted before: ${alertedSongs.has(songKey)}`);

    // Check if we already alerted for this song pair
    if (alertedSongs.has(songKey)) return;

    // Condition: Time < 2s AND duration is reasonable (>10s to avoid ads/glitches?)
    if (timeRemaining <= 2 && timeRemaining > 0 && currentSong.duration > 10) {
        pauseSong();
        log(`Song ending in 2s. Triggering pause for key: ${songKey}`);
        alertedSongs.add(songKey);

        const message: MessageSchema = {
            type: 'SONG_ABOUT_TO_END',
            payload: {
                currentSongTitle: currentSong.title,
                currentSongArtist: currentSong.artist,
                upcomingSongTitle: upcomingSong?.title || 'Unknown',
                upcomingSongArtist: upcomingSong?.artist || 'Unknown'
            }
        };
        chrome.runtime.sendMessage(message);
    }
}

function startPolling() {
    log("Starting Polling...");

    // Initial check
    currentSong = getSongInfo();
    // upcomingSong = getNextSongInQueue();
    fetchUpcomingSong().then(data => {
        if (data) {
            upcomingSong = data;
            log(`Setting Initial Upcoming Song: ${upcomingSong?.title}`);
        } else {
            log("Failed to fetch initial upcoming song from injector.");
        }
    });
    log(`Setting Initial Song: ${currentSong.title}`);

    // Poll every 1 second
    setInterval(get_status, 1000);
    
    log("Polling started successfully.");
}

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Attempting to resume song.");
        // Only resume if we are currently paused.
        if (isSongPaused()) {
            resumeSong();
        } else {
             log("TTS Ended, but song is already playing. Skipping resume.");
        }
    }
});

// Someone requested current song info
chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if(message.type === 'GET_CURRENT_SONG_INFO'){
        // Refresh info to be sure
        const current = getSongInfo();
        const next = getNextSongInQueue();

        log("Received request to validate current song info.");
        const response: MessageSchema = {
            type: 'CURRENT_SONG_INFO',
            payload: {
                currentSongTitle: current.title,
                upcomingSongTitle: next?.title || 'Unknown'
            }
        };
        sendResponse(response);
    }
});

// Start watching
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';

// --- Constants ---

const artistNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/span/span[2]/yt-formatted-string';
const currentSongNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/yt-formatted-string';
const currentSongAlbumNameXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]/div[2]/span/span[2]/yt-formatted-string/a[3]';
const currentSongTimerXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[1]/span';
const musicBarXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]';

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

// --- State Variables ---

let hasAlertedForCurrentSong = false;
let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;
let hasPrewarmed = false;
let lastSongKey = "";
let isDebug = false;
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

// Initialize debug state
chrome.storage.sync.get(['isDebugEnabled'], (result) => {
    isDebug = result.isDebugEnabled ?? false;
});

// Listen for changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.isDebugEnabled) {
        isDebug = changes.isDebugEnabled.newValue;
    }
});

// --- Helper Functions ---

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
    const pathElement = document.querySelector('#play-pause-button yt-icon path');

    if (!pathElement) {
        log(new Error("Play/Pause button path not found in DOM."));
        return false;
    }

    const currentPath = pathElement.getAttribute('d');
    return currentPath === PLAY_PATH;
};

export const resumeSong = (): void => {
    if(!isSongPaused()) return;
    click_play_pause();
}

export const pauseSong = (): void => {
    if(isSongPaused()) return;
    click_play_pause();
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

export function getSongInfo(): CurrentSong {
    try {
        const title = getTextFromXPath(currentSongNameXPath);
        const artist = getTextFromXPath(artistNameXPath);
        const album = getTextFromXPath(currentSongAlbumNameXPath);
        const timer = getTextFromXPath(currentSongTimerXPath); // it will be a string like "0:00 / 3:59"

        if (!timer) {
            log(new Error('getSongInfo: Timer element not found'));
            return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
        }

        //convert the timer string to seconds
        const [currentTime, duration] = (() => {
            const [currentTimeStr, durationStr] = timer.split('/');
            const [currMinutes, currSeconds] = currentTimeStr.split(':').map(Number);
            const [durMinutes, durSeconds] = durationStr.split(':').map(Number);
            return [currMinutes * 60 + currSeconds, durMinutes * 60 + durSeconds];
        })();

        const currSong: CurrentSong = {
            title,
            artist,
            album,
            duration,
            currentTime,
            isPaused: isSongPaused()
        }

        return currSong;

    } catch (e) {
        log(new Error('getSongInfo: Unexpected error'), e);
        return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
    }
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
    const nextRow = currentRow.nextElementSibling as HTMLElement;

    if (!nextRow) return null;

    // Identify the actual song item in the next row
    let nextSongItem: HTMLElement | null = null;
    const tagName = nextRow.tagName.toLowerCase();

    if (tagName === SELECTORS.WRAPPER) {
      // Must target #primary-renderer to skip the hidden video version (#counterpart-renderer)
      nextSongItem = nextRow.querySelector(`${SELECTORS.PRIMARY_RENDERER} ${SELECTORS.ITEM}`);
    } else if (tagName === SELECTORS.ITEM) {
      nextSongItem = nextRow;
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

function handleTimeUpdate() {
    chrome.storage.sync.get(['isEnabled'], (result) => {
        // If Chrome extension is disabled
        if (!result.isEnabled) return; 
        // If paused, we don't need to do anything (music isn't progressing)
        if (isSongPaused()) return;

        currentSong = getSongInfo();
        upcomingSong = getNextSongInQueue();
        if (currentSong.title === '') {
            return;
        }

        // Was it the first song?
        if(isFirstSong){
            //for now do nothing
            log("This was the first song", currentSong);
            isFirstSong = false;
        }

        // Check if song changed to reset prewarm flag
        const songKey = `${currentSong.title}-${currentSong.artist}`;
        if (songKey !== lastSongKey) {
            hasPrewarmed = false;
            lastSongKey = songKey;
        }

        // Pre-warm checking
        const progress = currentSong.currentTime / currentSong.duration;
        if (progress > 0.5 && !hasPrewarmed && upcomingSong) {
            log("Song > 50%. Pre-warming RJ model...");
            hasPrewarmed = true;
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
        if(timeRemaining>2) return;

        log(`Song ending in 2s. Triggering pause.`);
        pauseSong();
        hasAlertedForCurrentSong = true;
        
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
    });
}

function startObservers() {
    log("Starting DOM Observers...");

    const timeNode = document.evaluate(
        currentSongTimerXPath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
    ).singleNodeValue as Node;

    if (!timeNode) {
        log("Nodes not ready, retrying in 1s...");
        setTimeout(startObservers, 1000);
        return;
    }

    currentSong = getSongInfo();
    upcomingSong = getNextSongInQueue();
    log(`Setting Initial Song: ${currentSong.title}`);

    const observerConfig = { characterData: true, subtree: true, childList: true };

    const timeObserver = new MutationObserver((mutations) => {
        // This fires basically every second or so
        handleTimeUpdate();
    });

    timeObserver.observe(timeNode, observerConfig);
    
    
    log("Observers attached successfully. Watching for Time changes.");
}

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Resuming playback.");
        // Only click if it's paused. It should be paused because we paused it.
        if (isSongPaused() && hasAlertedForCurrentSong) {
             resumeSong();
        }
    }
});

// Start watching
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObservers);
} else {
    startObservers();
}

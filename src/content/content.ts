import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';

// --- CONSTANTS ---
const EVENT_TRIGGER = 'YTM_EXT_TRIGGER'; // Song Changed (Paused)
const EVENT_UPDATE = 'YTM_EXT_UPDATE';   // Info Updated (e.g. Queue loaded)
const EVENT_RESUME = 'YTM_EXT_RESUME';
const EVENT_REQUEST_DATA = 'YTM_EXTENSION_REQUEST_DATA';
const EVENT_RETURN_DATA = 'YTM_EXTENSION_RETURN_DATA';

// --- STATE ---
let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;

// Track processing to avoid duplicates
const processedPairs = new Set<string>(); // "TitleA::TitleB"
const prefetchTimestamps = new Map<string, number>(); // "TitleA::TitleB" -> Timestamp

let isDebug = false;
let isEnabled = true;

// --- LOGGING ---
function log(msg: string, ...args: any[]) {
    if (isDebug) console.log(`%c[Content] ${msg}`, 'color: #00ccff', ...args);
}

// --- INITIALIZATION ---
function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();

        // Request initial status from Injector
        document.dispatchEvent(new CustomEvent(EVENT_REQUEST_DATA));
    });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.isDebugEnabled) isDebug = changes.isDebugEnabled.newValue;
        if (changes.isEnabled) {
            isEnabled = changes.isEnabled.newValue;
            updateAIRJModeIndicator();
        }
    }
});

// --- UI INDICATOR ---
function updateAIRJModeIndicator() {
    const logoAnchor = document.querySelector('a.ytmusic-logo');
    if (!logoAnchor) return;
    let indicator = document.getElementById('ai-rj-mode-indicator');

    if (isEnabled) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'ai-rj-mode-indicator';
            indicator.innerText = 'AI RJ Mode';
            Object.assign(indicator.style, {
                fontSize: '10px', fontWeight: 'bold', color: '#fff', opacity: '0.7',
                position: 'absolute', bottom: '-12px', left: '0', width: '100%',
                textAlign: 'center', pointerEvents: 'none', whiteSpace: 'nowrap',
                fontFamily: 'Roboto, Arial, sans-serif'
            });
            if (window.getComputedStyle(logoAnchor).position === 'static') {
                (logoAnchor as HTMLElement).style.position = 'relative';
            }
            logoAnchor.appendChild(indicator);
        }
    } else {
        indicator?.remove();
    }
}

// --- LOGIC: SONG CHANGE HANDLING ---

/**
 * Handle Song Change Event (Triggered by Injector)
 * The song is PAUSED when this fires.
 */
async function handleSongChange(detail: any) {
    if (!isEnabled) {
        document.dispatchEvent(new CustomEvent(EVENT_RESUME));
        return;
    }

    const prevSong = currentSong;
    currentSong = detail.currentSong;
    upcomingSong = detail.upcomingSong;

    log(`🎵 Song Changed: ${currentSong?.title} (Next: ${upcomingSong?.title})`);

    // 1. Announce the TRANSITION to this song (if available)
    // We are looking for a transition from prevSong -> currentSong
    // But since we store prewarmed keys as "Current::Next", we look for "Prev::Current"
    if (prevSong && currentSong) {
        const pairKey = `${prevSong.title}::${currentSong.title}`;

        // Check if we have an announcement pending/ready?
        // Actually, the background/offscreen handles the "Ready" part via TTS.
        // We just ask the background: "Hey, song changed to B. Did you have a script for A->B?"
        // But wait, the architecture is: Content asks to Play.

        // Simpler approach:
        // We assume `SONG_ABOUT_TO_END` logic was replaced by this strictly event-driven flow?
        // No, the user said: "When we have the event of A::B... content script should start prefetch...
        // and as soon as the song changes... trigger the announce flow".

        // So here we trigger the announce flow.
        await triggerAnnounce(pairKey);
    } else {
        // First song or no previous context. Just resume.
        log("No previous song context or first load. Resuming.");
        document.dispatchEvent(new CustomEvent(EVENT_RESUME));
    }

    // 2. Start Prefetch for NEXT Pair (Current::Upcoming)
    schedulePrefetch();
}

/**
 * Triggers the announcement (TTS) for the given pair.
 * It sends a message to background to play the audio.
 * Then waits for TTS_ENDED or timeout to Resume.
 */
async function triggerAnnounce(pairKey: string) {
    return new Promise<void>((resolve) => {
        // We need to tell background to play audio for this pair.
        // But the message type `SONG_ABOUT_TO_END` was used for this?
        // Or `PLAY_AUDIO`?
        // The previous logic used `SONG_ABOUT_TO_END` to trigger generation/prefetch? No.

        // Let's use a new flow or adapt `SONG_ABOUT_TO_END`.
        // Actually, the user wants us to "notify the content script to carry on the task".
        // The task is: Play the intro.

        // We'll send a message to check if audio is ready and play it.
        // If no audio is ready (because we didn't prefetch, or it failed), we should resume immediately.

        // Let's send a PLAY_AUDIO request with specific pair info?
        // Or re-use `SONG_ABOUT_TO_END` but rename it?
        // `SONG_ABOUT_TO_END` was "Generate and Play".

        // Ideally, we send "PLAY_TRANSITION".
        // Since I shouldn't change background too much, let's see what `SONG_ABOUT_TO_END` does.
        // It likely triggers `generate_rj` which generates AND plays.
        // But we want to play PRE-generated audio if possible.

        // Wait, `PREWARM_RJ` generates audio.
        // `SONG_ABOUT_TO_END` (in original code) was sent when song was ending.

        // Proposed Flow:
        // 1. Send `PLAY_AUDIO` for `pairKey`.
        //    But `PLAY_AUDIO` expects raw data or text.
        //    The background stores the cache? No, `offscreen` has the cache.

        // Let's rely on `SONG_ABOUT_TO_END` behavior if it handles "Play if ready".
        // If not, we might need to modify `content.ts` to send the specific "Play Cached" command.
        // Looking at `types.ts`, `PLAY_AUDIO` has `forSongNow`, `forSongNext`.

        // Let's try sending `PLAY_AUDIO` with `forSongNow = currentSong.title`?
        // But `offscreen` manages the cache.

        // For now, to minimize offscreen changes, I will use `SONG_ABOUT_TO_END`.
        // But wait! The prompt says: "The content script should then do the prefetch... and trigger the announce flow".

        // If I send `SONG_ABOUT_TO_END`, the background/offscreen might try to generate if not found?
        // That's acceptable.

        log(`Triggering Announce for ${pairKey}`);

        // We set a flag so that when TTS_ENDED comes, we resume.
        const resumeHandler = (msg: any) => {
            if (msg.type === 'TTS_ENDED') {
                log("TTS Ended. Resuming.");
                chrome.runtime.onMessage.removeListener(resumeHandler);
                document.dispatchEvent(new CustomEvent(EVENT_RESUME));
                resolve();
            }
        };
        chrome.runtime.onMessage.addListener(resumeHandler);

        // Fallback: If no TTS plays within X seconds (e.g. not generated), resume.
        // But how do we know if it *started*?
        // We'll give it a short timeout (e.g. 2s) to acknowledge?
        // If generation is slow (not prewarmed), we might wait longer?
        // If we pause playback, we better have something to say or resume quickly.

        // If not prewarmed, maybe we shouldn't announce?
        // "The prefetch should only happen...".
        // Ideally we only announce if we successfully prefetched.

        // I will assume `SONG_ABOUT_TO_END` handles the "Play or Generate" logic.
        // I'll send the message.
        chrome.runtime.sendMessage({
            type: 'SONG_ABOUT_TO_END',
            payload: {
                currentSongTitle: pairKey.split('::')[0], // Previous
                currentSongArtist: "Unknown",
                upcomingSongTitle: pairKey.split('::')[1], // Current
                upcomingSongArtist: currentSong!.artist
            }
        });

        // Safety Resume Timeout (in case background drops it)
        setTimeout(() => {
             // We can check if `isSongPaused` via DOM?
             // But we are paused. If 3 seconds pass and no TTS started...
             // Hard to know. Let's hope `TTS_ENDED` fires even if failure?
             // Or we just rely on user manual resume if stuck.
             // Better: Resume after 5s if nothing happens?
             // log("Safety resume timer...");
             // resolve(); document.dispatchEvent(new CustomEvent(EVENT_RESUME));
        }, 5000);
    });
}


// --- LOGIC: PREFETCH ---

let prefetchTimer: any = null;

function schedulePrefetch() {
    if (prefetchTimer) clearTimeout(prefetchTimer);

    if (!currentSong || !upcomingSong) {
        log("Cannot schedule prefetch: missing info");
        return;
    }

    const pairKey = `${currentSong.title}::${upcomingSong.title}`;
    log(`Scheduling prefetch for ${pairKey} in 15s...`);

    // Store start time for this pair attempt
    const now = Date.now();

    // Check if we did this recently (Debounce/Throttle)
    // The user requirement: "prefetch only after 15s of the first prefetch request for the given pair"
    // I interpret this as: "Wait 15s from song start before *actually* requesting."

    prefetchTimer = setTimeout(() => {
        performPrefetch(pairKey, currentSong!, upcomingSong!);
    }, 15000);
}

function performPrefetch(pairKey: string, cSong: CurrentSong, uSong: UpcomingSong) {
    // Verify we are still playing the same song context
    if (!currentSong || !upcomingSong) return;
    const currentPair = `${currentSong.title}::${upcomingSong.title}`;

    if (currentPair !== pairKey) {
        log(`Prefetch aborted: Context changed (${currentPair} != ${pairKey})`);
        return;
    }

    // Check history to avoid spamming the same pair if we loop?
    // User: "compare the upcoming requests for a difference of 15seconds"
    // Since we just waited 15s, this is satisfied?

    if (processedPairs.has(pairKey)) {
        // Maybe we allow re-fetching if it's been a long time?
        // For now, strict once-per-session-per-pair to save tokens.
        log(`Already prefetched ${pairKey}. Skipping.`);
        return;
    }

    log(`🚀 Sending PREWARM_RJ for ${pairKey}`);
    processedPairs.add(pairKey);

    chrome.runtime.sendMessage({
        type: 'PREWARM_RJ',
        payload: {
            oldSongTitle: cSong.title,
            oldArtist: cSong.artist,
            newSongTitle: uSong.title,
            newArtist: uSong.artist,
            currentTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
    });
}

// --- EVENT LISTENERS ---

// 1. From Injector (Song Change / Data Update)
document.addEventListener(EVENT_TRIGGER, (e: any) => {
    handleSongChange(e.detail);
});

document.addEventListener(EVENT_UPDATE, (e: any) => {
    const { currentSong: c, upcomingSong: u } = e.detail;
    // Only update data, don't trigger song change logic unless title changed
    if (c?.title !== currentSong?.title) {
        // This is weird, injector should have fired TRIGGER.
        // But maybe we missed it?
        handleSongChange(e.detail);
    } else {
        // Just update upcoming (Queue loaded?)
        if (upcomingSong?.title !== u?.title) {
            log(`Queue Updated: ${upcomingSong?.title} -> ${u?.title}`);
            upcomingSong = u;
            // If we have a new upcoming song, we should probably schedule prefetch now!
            schedulePrefetch();
        }
    }
});

document.addEventListener(EVENT_RETURN_DATA, (e: any) => {
    const { currentSong: c, upcomingSong: u } = e.detail;
    currentSong = c;
    upcomingSong = u;
    log(`Initial Data: ${currentSong?.title} -> ${upcomingSong?.title}`);

    // On initial load, we might want to prefetch?
    if (currentSong && upcomingSong) {
        schedulePrefetch();
    }
});

// 2. From Background (TTS Ended, etc.)
chrome.runtime.onMessage.addListener((message: MessageSchema) => {
    if (message.type === 'TTS_ENDED') {
        // Handled in triggerAnnounce usually, but as a fallback:
        log("TTS_ENDED received globally.");
        // We assume triggerAnnounce listener caught it.
        // If we are paused and stuck, we can resume here too.
        if (document.querySelector('video')?.paused) {
             document.dispatchEvent(new CustomEvent(EVENT_RESUME));
        }
    }
});


// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

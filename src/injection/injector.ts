import { CurrentSong, UpcomingSong } from "../utils/types";

// --- HELPER: Queue Logic (Keep your existing one) ---
function getNextSongData(): UpcomingSong | null {
  const queueEl = document.querySelector('ytmusic-player-queue') as any;
  const store = queueEl?.queue?.store || queueEl?.store;
  const state = store?.getState ? store.getState() : null;
  const queueState = state?.queue || state?.player?.queue;

  if (!queueState) return null;

  const mainItems = queueState.items || [];
  const automixItems = queueState.automixItems || [];
  const fullQueue = [...mainItems, ...automixItems];

  if (fullQueue.length === 0) return null;

  const unwrap = (item: any) => 
    item.playlistPanelVideoRenderer || 
    item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;

  let currentIndex = -1;
  for (let i = 0; i < fullQueue.length; i++) {
    const data = unwrap(fullQueue[i]);
    if (data && data.selected) {
      currentIndex = i;
      break;
    }
  }

  if (currentIndex !== -1 && currentIndex < fullQueue.length - 1) {
    const nextData = unwrap(fullQueue[currentIndex + 1]);
    if (nextData) {
      return {
        title: nextData.title?.runs?.[0]?.text || "Unknown Title",
        artist: nextData.longBylineText?.runs?.[0]?.text || "Unknown Artist"
      };
    }
  }
  return null;
}

// --- HELPER: Player Status ---
function getPlayerStatus() : CurrentSong | null {
  const player = document.getElementById('movie_player') as any;
  
  if (!player || typeof player.getCurrentTime !== 'function') {
    return null;
  }

  // cannot rely on them, DO NOT USE
  const duration = player.getDuration();
  const currentTime = player.getCurrentTime();
  
  // Player State: 1 = Playing, 2 = Paused, 3 = Buffering
  const state = player.getPlayerState();
  const isPaused = state === 2 || state === 0 || state === -1; // 0 is ended, -1 unstarted

  // Get current song details directly from API (More reliable than DOM)
  const videoData = player.getVideoData ? player.getVideoData() : null;

  function getAlbumFromDOM(): string {
  try {
    const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
    const parts = byline.split('•').map(s => s.trim());
    return (parts.length >= 2) ? parts[1] : "";
  } catch (e) { return ""; }
}

  return {
    title: videoData?.title || "Unknown Title",
    artist: videoData?.author || "Unknown Artist",
    album: getAlbumFromDOM(),
    duration: isNaN(duration) ? 0 : Math.floor(duration),
    currentTime: isNaN(currentTime) ? 0 : Math.floor(currentTime),
    isPaused
  };
}

// --- LISTENER ---
document.addEventListener('YTM_EXTENSION_REQUEST_STATUS', () => {
  const current = getPlayerStatus();
  const upcoming = getNextSongData();

    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_RETURN_STATUS', {
      detail: {
        current,
        upcoming // Attach upcoming song to the same packet
      }
    }));
});

// injector.ts

(() => {
  // --- CONFIG ---
  // Unique namespacing avoids collisions
  const EVENT_TRIGGER = 'YTM_EXT_TRIGGER'; 
  const EVENT_RESUME = 'YTM_EXT_RESUME';

  // --- STATE ---
  let isLocked = false;
  let currentTitle = '';
  const mediaSession = navigator.mediaSession;
  const originalPlay = HTMLMediaElement.prototype.play;

  const log = (msg: string) => console.log(`%c[Injector] ${msg}`, 'color: #bada55');

  // --- 1. THE PLAY LOCK ---
  HTMLMediaElement.prototype.play = function(): Promise<void> {
    if (isLocked) {
      log('🚫 Play blocked pending API check');
      return Promise.resolve();
    }
    return originalPlay.apply(this);
  };

  // --- 2. THE TRAP ---
  let _metadata = mediaSession.metadata;
  Object.defineProperty(mediaSession, 'metadata', {
    get() { return _metadata; },
    set(newValue) {
      _metadata = newValue;

      if (newValue && newValue.title !== currentTitle) {
        currentTitle = newValue.title;
        
        const video = document.querySelector('video');
        if (!video) return;

        // Lock & Pause
        isLocked = true;
        video.pause();
        log(`🔒 Event Dispatched for: "${newValue.title}"`);

        // --- DISPATCH EVENT INSTEAD OF POSTMESSAGE ---
        // Bubbles: true is safer if you attach listeners higher up, 
        // but typically not needed on 'document' directly.
        document.dispatchEvent(new CustomEvent(EVENT_TRIGGER, {
          detail: { timestamp: Date.now() } // Optional payload
        }));
      }
    },
    configurable: true
  });

  // --- 3. RESUME LISTENER ---
  document.addEventListener(EVENT_RESUME, () => {
    log('🔓 Resume Event Received');
    isLocked = false;
    const video = document.querySelector('video');
    if (video) originalPlay.call(video);
  });
})();
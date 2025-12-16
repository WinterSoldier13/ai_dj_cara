import { CurrentSong, UpcomingSong } from "../utils/types";

(() => {
  // --- CONFIG ---
  const EVENT_TRIGGER = 'YTM_EXT_TRIGGER'; // Song Changed
  const EVENT_UPDATE = 'YTM_EXT_UPDATE';   // Info Updated (e.g. Queue loaded)
  const EVENT_RESUME = 'YTM_EXT_RESUME';
  const EVENT_REQUEST_DATA = 'YTM_EXTENSION_REQUEST_DATA';
  const EVENT_RETURN_DATA = 'YTM_EXTENSION_RETURN_DATA';

  // --- STATE ---
  let isLocked = false;
  let currentTitle = '';
  let lastUpcomingTitle = ''; // To detect queue updates

  const mediaSession = navigator.mediaSession;
  const originalPlay = HTMLMediaElement.prototype.play;

  const log = (msg: string, ...args: any[]) => console.log(`%c[Injector] ${msg}`, 'color: #bada55', ...args);

  // --- 1. HELPER: Internal Data Access ---

  function getNextSongData(): UpcomingSong | null {
    try {
      const queueEl = document.querySelector('ytmusic-player-queue') as any;
      // Access Redux store if available
      const store = queueEl?.queue?.store || queueEl?.store;

      // If store isn't available, we might be too early or it's hidden.
      // We can try to look at the DOM structure directly if store fails,
      // but store is most reliable for "Upcoming".

      if (!store) {
          // Fallback: Try to parse the DOM list if rendered
          // This is brittle but useful if Redux isn't exposed yet
          return null;
      }

      const state = store.getState();
      const queueState = state?.queue || state?.player?.queue;

      if (!queueState) return null;

      const mainItems = queueState.items || [];
      const automixItems = queueState.automixItems || [];
      const fullQueue = [...mainItems, ...automixItems];

      if (fullQueue.length === 0) return null;

      const unwrap = (item: any) =>
        item.playlistPanelVideoRenderer ||
        item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;

      // Find current index
      let currentIndex = -1;
      for (let i = 0; i < fullQueue.length; i++) {
        const data = unwrap(fullQueue[i]);
        if (data && data.selected) {
          currentIndex = i;
          break;
        }
      }

      // Get next item
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
    } catch (e) {
      // log("Error in getNextSongData", e);
      return null;
    }
  }

  function getPlayerStatus(): CurrentSong | null {
    try {
      const player = document.getElementById('movie_player') as any;
      const videoData = player?.getVideoData ? player.getVideoData() : null;
      const metadata = navigator.mediaSession?.metadata;

      // Prefer MediaSession for Title/Artist/Album as it matches what user sees
      let title = metadata?.title || videoData?.title || "";
      let artist = metadata?.artist || videoData?.author || "";
      let album = metadata?.album || "";

      // Fallback for album from DOM if missing (MediaSession often has it though)
      if (!album) {
         const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
         const parts = byline.split('•').map(s => s.trim());
         if (parts.length > 1) album = parts[1];
      }

      const isPaused = player?.getPlayerState ? (player.getPlayerState() === 2) : true;

      return {
        title,
        artist,
        album,
        isPaused
      };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // --- 2. BROADCASTER ---

  function broadcast(eventType: string, reason?: string) {
    const currentSong = getPlayerStatus();
    const upcomingSong = getNextSongData();

    if (currentSong) {
        // log(`Broadcasting ${eventType} (${reason})`, { current: currentSong.title, next: upcomingSong?.title });

        document.dispatchEvent(new CustomEvent(eventType, {
            detail: {
                currentSong,
                upcomingSong,
                reason,
                timestamp: Date.now()
            }
        }));

        // Update local state to detect changes later
        currentTitle = currentSong.title;
        lastUpcomingTitle = upcomingSong?.title || '';
    }
  }

  // --- 3. THE PLAY LOCK & TRAP ---

  // Override play to enforce pause during transition
  HTMLMediaElement.prototype.play = function(): Promise<void> {
    if (isLocked) {
      // log('🚫 Play blocked pending API check');
      return Promise.resolve();
    }
    return originalPlay.apply(this);
  };

  let _metadata = mediaSession.metadata;
  Object.defineProperty(mediaSession, 'metadata', {
    get() { return _metadata; },
    set(newValue) {
      _metadata = newValue;

      if (newValue && newValue.title !== currentTitle) {
        log(`🔒 Song Change Detected: "${newValue.title}"`);
        
        // 1. Lock & Pause immediately
        isLocked = true;
        const video = document.querySelector('video');
        if (video) video.pause();

        // 2. Broadcast the event with data
        // We might need a slight delay to ensure internal state (queue) updates?
        // Usually metadata updates first. We will send what we have.
        // If queue is stale, the poller will catch it.
        broadcast(EVENT_TRIGGER, 'SONG_CHANGED');
      }
    },
    configurable: true
  });

  // --- 4. LISTENERS ---

  // Listen for resume command from Content Script
  document.addEventListener(EVENT_RESUME, () => {
    log('🔓 Resume Event Received');
    isLocked = false;
    const video = document.querySelector('video');
    if (video) originalPlay.call(video);
  });

  // Listen for data requests (e.g. on startup)
  document.addEventListener(EVENT_REQUEST_DATA, () => {
      broadcast(EVENT_RETURN_DATA, 'REQUESTED');
  });

  // --- 5. POLLING FOR QUEUE UPDATES ---
  // Sometimes the queue loads *after* the song starts, or updates while playing.
  // We check periodically if the "Upcoming" song has changed.

  setInterval(() => {
      const next = getNextSongData();
      const nextTitle = next?.title || '';

      // If upcoming song changed (and we are not currently locked/changing), notify content
      if (nextTitle !== lastUpcomingTitle) {
          // log(`Queue update detected: ${lastUpcomingTitle} -> ${nextTitle}`);
          broadcast(EVENT_UPDATE, 'QUEUE_UPDATED');
      }
  }, 2000);

})();

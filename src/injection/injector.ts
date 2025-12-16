import { UpcomingSong } from "../utils/types";

// --- INTERFACES ---
interface YtmState {
  queue: {
    items: any[]; // We only need to know it's an array
  };
}

// --- HELPER TO UNWRAP DATA ---
function getNextSongData() : UpcomingSong | null {
  const queueEl = document.querySelector('ytmusic-player-queue') as any;
  const queueItems = queueEl?.queue?.store?.getState()?.queue?.items;

  if (!queueItems) return null;

  // Find Current Index based on 'selected: true'
  let currentIndex = -1;
  // Unwrap helper
  const unwrap = (item: any) => 
    item.playlistPanelVideoRenderer || 
    item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;

  for (let i = 0; i < queueItems.length; i++) {
    const data = unwrap(queueItems[i]);
    if (data && data.selected) {
      currentIndex = i;
      break;
    }
  }

  // Get Next Song
  if (currentIndex !== -1 && currentIndex < queueItems.length - 1) {
    const nextData = unwrap(queueItems[currentIndex + 1]);
    if (nextData) {
      const byLineRuns = nextData.longBylineText?.runs || [];
      return {
        title: nextData.title?.runs?.[0]?.text || "Unknown Title",
        artist: byLineRuns[0]?.text || "Unknown Artist"
      };
    }
  }
  return null;
}

// --- LISTENER ---
// Listen for the specific request from the Content Script
document.addEventListener('YTM_EXTENSION_REQUEST_DATA', () => {
  const data = getNextSongData();
  
  // Dispatch the response back
  document.dispatchEvent(new CustomEvent('YTM_EXTENSION_RETURN_DATA', {
    detail: data
  }));
});
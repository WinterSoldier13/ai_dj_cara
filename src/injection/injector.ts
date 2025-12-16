import { UpcomingSong } from "../utils/types"; 

function getNextSongData(): UpcomingSong | null {
  const queueEl = document.querySelector('ytmusic-player-queue') as any;
  
  const store = queueEl?.queue?.store || queueEl?.store;
  const state = store?.getState ? store.getState() : null;
  const queueState = state?.queue || state?.player?.queue;

  if (!queueState) {
    console.warn("YTM Injector: Queue state not found.");
    return null;
  }

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
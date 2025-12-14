export interface StorageSchema {
    isEnabled: boolean;
    isDebugEnabled: boolean;
    modelProvider: 'gemini' | 'webllm' | 'localserver';
    speechProvider: 'tts' | 'localserver';
    localServerPort: number;
}

export type MessageSchema = {
    type: 'SONG_ABOUT_TO_END';
    payload: {
        currentSongTitle: string;
        currentSongArtist: string;
        upcomingSongTitle: string;
        upcomingSongArtist: string;
    };
} | {
    type: 'GENERATE_RJ';
    payload: {
        oldSongTitle: string;
        oldArtist: string;
        newSongTitle: string;
        newArtist: string;
        useWebLLM?: boolean; // Keep for backward compat or refactor logic to use modelProvider
        modelProvider?: 'gemini' | 'webllm' | 'localserver';
        localServerPort?: number;
        systemPrompt?: string;
        currentTime?: string;
    };
} | {
    type: 'TTS_ENDED';
} | {
    type: 'PREWARM_RJ';
    payload: {
        oldSongTitle: string;
        oldArtist: string;
        newSongTitle: string;
        newArtist: string;
        useWebLLM?: boolean;
        modelProvider?: 'gemini' | 'webllm' | 'localserver'; // Add this here too
        currentTime?: string;
    };
} | {
    type: 'PLAY_AUDIO';
    payload: {
        audioData: number[]; // ArrayBuffer/Blob sent as array of numbers/bytes? Or base64 string.
                             // Passing large data via messaging can be slow. 
                             // Better to pass a URL if it's a blob url created in background? 
                             // Verify if Offscreen can fetch directly from localhost if passed port.
                             // Let's pass the Port and Path and let Offscreen fetch it.
        localServerPort: number;
        textToSpeak: string;
    };
} | {
    type: 'SPEAK_WITH_LOCAL_SERVER'; // Cleaner command
    payload: {
        text: string;
        port: number;
    }
} | {
    type: 'PRELOAD_AUDIO';
    payload: {
        localServerPort: number;
        textToSpeak: string;
    }
};

export interface CurrentSong {
    title: string;
    artist: string;
    album: string;
    duration: number;
    currentTime: number;
    isPaused: boolean;
}

export interface UpcomingSong {
    title: string;
    artist: string;
}
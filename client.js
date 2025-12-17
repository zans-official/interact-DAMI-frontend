const toggleButton = document.getElementById('toggleButton');
const downloadButton = document.getElementById('downloadButton');
const downloadMicButton = document.getElementById('downloadMicButton');
const statusDiv = document.getElementById('status');
const messagesDiv = document.getElementById('controlMessages');
const vadIndicator = document.getElementById('vadIndicator');
const toyIdInput = document.getElementById('toyIdInput');
const debugToggle = document.getElementById('debugToggle');
const debugContent = document.getElementById('debugContent');

// Debug panel toggle
if (debugToggle) {
    debugToggle.addEventListener('click', () => {
        debugToggle.classList.toggle('open');
        debugContent.classList.toggle('open');
    });
}

const SERVER_URL = 'wss://esp-backend-eng-612228147959.asia-south1.run.app';
// const SERVER_URL = 'ws://127.0.0.1:8000/';  // Use ws:// for local development
// const SERVER_URL = 'wss://esp-backend-multilingual-612228147959.asia-south1.run.app';

// Frame size limits for WebSocket
const OUTGOING_MAX_FRAME_SIZE = 1024;
const INCOMING_MAX_FRAME_SIZE = 2048;
const STANDARD_DELAY_MS = 100;
const CONTROL_READY_MESSAGE = 'Ready to listen';
const CONTROL_AUDIO_READY_MESSAGE = 'Audio Ready';
const MAX_SPEECH_DURATION_MS = 8000;
const PRE_EMPHASIS_COEFF = 0.90;
const SILENCE_GRACE_MS = 2500;
// ================= VAD / ENERGY CONFIG =================

// Physics thresholds
const ENERGY_THRESHOLD = 0.02;   // RMS loudness
const PEAK_THRESHOLD   = 0.05;   // Peak amplitude

// Hangover logic
const SPEECH_START_FRAMES = 3;   // ~60 ms
const SPEECH_END_FRAMES   = 10;  // ~200 ms

// VAD runtime state
let speechFrames  = 0;
let silenceFrames = 0;
let inSpeech      = false;
let speechStartTimestamp = 0;
let micLocked = false;
let awaitingAudioReady = false;
let awaitingPlaybackCompletion = false;
let serverReadyPending = false;
let activePlaybackSources = 0;
let lastPreEmphasisSample = 0;
let silenceDurationMs = 0;


let websocket;
let audioContext;
let scriptProcessor;
let mediaStream;
let isListeningEnabled = false;
let readyTimer = null;
let frameDurationMs = 0;

// Playback buffers
let playbackContext;
let nextPlaybackTime = 0;

// Recording buffers
let recordingChunks = [];
let isRecording = true; // always record incoming for now
let micRecordingChunks = [];
let isMicRecording = true;

toggleButton.addEventListener('click', () => {
    if (toggleButton.classList.contains('inactive')) {
        startStreaming();
    } else {
        stopStreaming();
    }
});

downloadButton.addEventListener('click', () => {
    downloadRecording();
});

if (downloadMicButton) {
    downloadMicButton.addEventListener('click', () => {
        downloadMicRecording();
    });
}

// ================= MAIN STREAMING ================= //

function startStreaming() {
    console.log('Starting stream...');
    toggleButton.classList.remove('inactive');
    toggleButton.classList.add('active');
    toggleButton.textContent = 'Stop';
    statusDiv.textContent = 'Connecting to DAMI...';
    statusDiv.className = 'status-text';
    isListeningEnabled = false;
    micLocked = false;
    awaitingAudioReady = false;
    awaitingPlaybackCompletion = false;
    serverReadyPending = false;
    activePlaybackSources = 0;
    micRecordingChunks = [];
    if (downloadMicButton) downloadMicButton.disabled = true;
    resetVadState();
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    if (messagesDiv) {
        messagesDiv.innerHTML = '';
        appendControlMessage('Connecting to server...');
    }

    // Build WebSocket URL with toy_id query parameter
    const toyId = toyIdInput.value.trim();
    let wsUrl = SERVER_URL;
    if (toyId) {
        const separator = wsUrl.includes('?') ? '&' : '?';
        wsUrl = `${wsUrl}${separator}toy_id=${encodeURIComponent(toyId)}`;
        appendControlMessage(`Using toy_id: ${toyId}`);
    }

    websocket = new WebSocket(wsUrl);
    websocket.binaryType = 'arraybuffer';

    websocket.onopen = () => {
        console.log('WebSocket connected.');
        statusDiv.textContent = 'Connected. Initializing...';
        statusDiv.className = 'status-text';
        appendControlMessage('Connected to server. Awaiting ready signal...');
        startMicrophone();
    };

    websocket.onmessage = (event) => {
        if (typeof event.data === "string") {
            handleControlMessage(event.data);
            return;
        }

        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;

        // Play frame immediately without queuing
        if (isRecording) {
            recordingChunks.push(event.data);
            downloadButton.disabled = false;
        }

        // Play frame immediately without queuing
        playAudioFrameStreaming(event.data);
    };

    websocket.onclose = () => {
        console.log('WebSocket closed.');
        statusDiv.textContent = 'Speak to DAMI';
        statusDiv.className = 'status-text';
        appendControlMessage('Connection closed.');
        stopStreamingCleanup();
    };

    websocket.onerror = (err) => {
        console.error('WebSocket Error:', err);
        statusDiv.textContent = 'Connection Error';
        statusDiv.className = 'status-text';
        appendControlMessage('WebSocket error encountered.');
        stopStreamingCleanup();
    };
}

function stopStreaming() {
    console.log('Stopping stream...');
    if (websocket) websocket.close();
    stopStreamingCleanup();
}

function stopStreamingCleanup() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    // Reset state flags
    isListeningEnabled = false;
    nextPlaybackTime = 0;
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    
    if (playbackContext) {
        playbackContext.close();
        playbackContext = null;
    }
    
    toggleButton.classList.remove('active');
    toggleButton.classList.add('inactive');
    toggleButton.textContent = 'Start Conversation';

    statusDiv.textContent = 'Speak to DAMI';
    statusDiv.className = 'status-text';
    
    // Reset VAD visual state
    vadIndicator.classList.remove('listening', 'speaking');
    
    resetVadState();
    micLocked = false;
    awaitingAudioReady = false;
    awaitingPlaybackCompletion = false;
    serverReadyPending = false;
    activePlaybackSources = 0;
}

function resetVadState() {
    speechFrames = 0;
    silenceFrames = 0;
    inSpeech = false;
    lastPreEmphasisSample = 0;
    silenceDurationMs = 0;
}

function lockMicInput() {
    micLocked = true;
    isListeningEnabled = false;
    resetVadState();
    vadIndicator.classList.remove('listening');
}

function maybeEnableMicListening(options = {}) {
    const { force = false } = options;
    if (!force && !serverReadyPending) return;
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        serverReadyPending = false;
        return;
    }
    if (!force && (awaitingAudioReady || awaitingPlaybackCompletion)) return;

    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    
    micLocked = false;
    isListeningEnabled = true;
    serverReadyPending = false;
    awaitingAudioReady = false;
    awaitingPlaybackCompletion = false;
    statusDiv.textContent = 'Listening to you...';
    statusDiv.className = 'status-text active';
    vadIndicator.classList.remove('speaking');
}

function endUserSpeech(reason = 'silence') {
    if (!inSpeech) return;

    inSpeech = false;
    speechFrames = 0;
    silenceFrames = 0;
    silenceDurationMs = 0;
    vadIndicator.classList.remove('listening');
    statusDiv.textContent = 'Processing...';
    statusDiv.className = 'status-text';
    appendControlMessage(reason === 'max_duration' ? 'Speech max duration reached' : 'Speech ended');

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "TURN_END", reason }));
    }
    lockMicInput();
    awaitingAudioReady = true;
    awaitingPlaybackCompletion = false;
    serverReadyPending = false;
}

function applyPreEmphasis(input, coeff = PRE_EMPHASIS_COEFF) {
    const filtered = new Float32Array(input.length);
    let previous = lastPreEmphasisSample;

    for (let i = 0; i < input.length; i++) {
        const current = input[i];
        filtered[i] = current - coeff * previous;
        previous = current;
    }

    lastPreEmphasisSample = previous;
    return filtered;
}

// ================= CONTROL MESSAGE HANDLING ================= //

function appendControlMessage(message) {
    if (!messagesDiv) return;
    const trimmed = message.trim();

    if (messagesDiv.firstElementChild && messagesDiv.firstElementChild.classList.contains('placeholder')) {
        messagesDiv.innerHTML = '';
    }

    const entry = document.createElement('p');
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${trimmed}`;
    messagesDiv.appendChild(entry);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleControlMessage(rawMessage) {
    const message = (rawMessage ?? '').toString().trim();
    if (!message) return;

    console.log('Control message:', message);
    appendControlMessage(message);

    const normalized = message.toLowerCase();

    if (normalized === CONTROL_READY_MESSAGE.toLowerCase()) {
        statusDiv.textContent = 'Ready...';
        statusDiv.className = 'status-text';
        serverReadyPending = true;
        if (readyTimer) {
            clearTimeout(readyTimer);
        }
        readyTimer = setTimeout(() => {
            readyTimer = null;
            maybeEnableMicListening();
        }, STANDARD_DELAY_MS);
        return;
    }

    if (normalized === CONTROL_AUDIO_READY_MESSAGE.toLowerCase()) {
        if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
        }
        lockMicInput();
        awaitingAudioReady = false;
        awaitingPlaybackCompletion = false;
        serverReadyPending = false;
        statusDiv.textContent = 'DAMI is speaking...';
        statusDiv.className = 'status-text speaking';
        vadIndicator.classList.add('speaking');
        vadIndicator.classList.remove('listening');
        
        // Fallback: if no audio arrives within 3s, re-enable mic
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(() => {
            readyTimer = null;
            if (activePlaybackSources === 0 && !inSpeech) {
                appendControlMessage('No audio received, resuming listening');
                maybeEnableMicListening({ force: true });
            }
        }, 3000);
        return;
    }

    statusDiv.textContent = message;
    statusDiv.className = 'status-text';
}

// ================= MICROPHONE CAPTURE ================= //

async function startMicrophone() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();

        const source = audioContext.createMediaStreamSource(mediaStream);
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        frameDurationMs = (scriptProcessor.bufferSize / audioContext.sampleRate) * 1000;

        scriptProcessor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);

            if (micLocked || !isListeningEnabled) {
                resetVadState();
                return;
            }

            const emphasized = applyPreEmphasis(input);

            // ---------- ENERGY CALCULATION ----------
            let sumSquares = 0;
            let peak = 0;

            for (let i = 0; i < emphasized.length; i++) {
                const v = emphasized[i];
                sumSquares += v * v;
                peak = Math.max(peak, Math.abs(v));
            }

            const rms = Math.sqrt(sumSquares / emphasized.length);
            const isSpeech = rms > ENERGY_THRESHOLD || peak > PEAK_THRESHOLD;

            // ---------- VAD STATE MACHINE ----------
            if (isSpeech) {
                speechFrames++;
                silenceFrames = 0;
                silenceDurationMs = 0;
            } else {
                silenceFrames++;
                speechFrames = 0;
                silenceDurationMs += frameDurationMs;
            }

            // ---------- SPEECH START ----------
            if (!inSpeech && speechFrames >= SPEECH_START_FRAMES) {
                inSpeech = true;
                speechFrames = 0;
                speechStartTimestamp = performance.now();
                awaitingAudioReady = false;
                awaitingPlaybackCompletion = false;
                serverReadyPending = false;

                vadIndicator.classList.add('listening');
                vadIndicator.classList.remove('speaking');
                statusDiv.textContent = 'You are speaking...';
                statusDiv.className = 'status-text active';
                appendControlMessage('Speech detected');

                websocket?.send(JSON.stringify({ type: "TURN_START" }));
            }

            // ---------- MAX DURATION SAFEGUARD ----------
            if (inSpeech) {
                const elapsed = performance.now() - speechStartTimestamp;
                if (elapsed >= MAX_SPEECH_DURATION_MS) {
                    endUserSpeech('max_duration');
                    return;
                }
            }

            // ---------- SPEECH END ----------
            if (inSpeech && silenceDurationMs >= SILENCE_GRACE_MS) {
                endUserSpeech('silence');
                return;
            }

            // ---------- SEND AUDIO ONLY IF SPEAKING ----------
            if (inSpeech && websocket.readyState === WebSocket.OPEN) {
                const resampled = resampleTo16k(emphasized, audioContext.sampleRate);
                const pcm16 = toPCM16(resampled);
                
                // Record user mic input for debugging
                if (isMicRecording) {
                    micRecordingChunks.push(pcm16.slice(0));
                    if (downloadMicButton) downloadMicButton.disabled = false;
                }
                
                sendAudioInChunks(pcm16);
            }
        };


        source.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
        statusDiv.textContent = 'Microphone ready...';
        statusDiv.className = 'status-text';
    } catch (err) {
        console.error(err);
        statusDiv.textContent = 'Microphone Error';
        statusDiv.className = 'status-text';
        stopStreaming();
    }
}

// ================= AUDIO PLAYBACK ================= //

function playAudioFrameStreaming(frameData) {
    try {
        if (!frameData || frameData.byteLength === 0) return;

        // Initialize playback context if needed
        if (!playbackContext) {
            playbackContext = new AudioContext({ sampleRate: 16000 });
            nextPlaybackTime = playbackContext.currentTime;
        }

        const sampleCount = frameData.byteLength / 2;
        const floatSamples = new Float32Array(sampleCount);
        const dataView = new DataView(frameData);

        // Convert PCM16 to float
        for (let i = 0; i < sampleCount; i++) {
            floatSamples[i] = dataView.getInt16(i * 2, true) / 0x8000;
        }

        // Create audio buffer for this frame
        const buffer = playbackContext.createBuffer(1, sampleCount, 16000);
        buffer.getChannelData(0).set(floatSamples);

        // Create source and schedule it to play at precise time
        const source = playbackContext.createBufferSource();
        source.buffer = buffer;
        source.connect(playbackContext.destination);
        awaitingPlaybackCompletion = true;
        activePlaybackSources++;
        source.onended = () => {
            activePlaybackSources = Math.max(0, activePlaybackSources - 1);
            if (activePlaybackSources === 0) {
                awaitingPlaybackCompletion = false;
                vadIndicator.classList.remove('speaking');
                if (readyTimer) {
                    clearTimeout(readyTimer);
                    readyTimer = null;
                }
                maybeEnableMicListening({ force: true });
            }
        };
        
        // Schedule playback to maintain continuous audio stream
        const currentTime = playbackContext.currentTime;
        const startTime = Math.max(currentTime, nextPlaybackTime);
        
        source.start(startTime);
        
        // Calculate when this frame will finish playing
        const frameDuration = sampleCount / 16000; // duration in seconds
        nextPlaybackTime = startTime + frameDuration;
        
    } catch (e) {
        console.error("Streaming playback error:", e);
    }
}

// ================= RECORDING (WAV EXPORT) ================= //

function downloadRecording() {
    if (!recordingChunks.length) {
        alert('No audio recorded yet!');
        return;
    }

    const wav = encodeWAV(recordingChunks, 16000);
    const blob = new Blob([wav], { type: 'audio/wav' });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = "assistant-recording.wav";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(link.href);
}

function downloadMicRecording() {
    if (!micRecordingChunks.length) {
        alert('No mic audio recorded yet!');
        return;
    }

    const wav = encodeWAV(micRecordingChunks, 16000);
    const blob = new Blob([wav], { type: 'audio/wav' });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = "my-mic-input.wav";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(link.href);
}

// ================= UTILITIES ================= //

function sendAudioInChunks(audioBuffer) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !isListeningEnabled) {
        return;
    }

    const totalBytes = audioBuffer.byteLength;
    let offset = 0;
    
    while (offset < totalBytes) {
        const chunkSize = Math.min(OUTGOING_MAX_FRAME_SIZE, totalBytes - offset);
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        websocket.send(chunk);
        offset += chunkSize;
    }
}

function resampleTo16k(input, origRate) {
    if (origRate === 16000) return input;
    const ratio = origRate / 16000;
    const newLen = Math.round(input.length / ratio);
    const result = new Float32Array(newLen);

    let o = 0, i = 0;
    while (o < result.length) {
        const next = Math.round((o + 1) * ratio);
        let sum = 0, count = 0;
        while (i < next && i < input.length) {
            sum += input[i++];
            count++;
        }
        result[o++] = sum / count;
    }
    return result;
}

function toPCM16(input) {
    const buf = new ArrayBuffer(input.length * 2);
    const view = new DataView(buf);
    input.forEach((s, i) => {
        view.setInt16(i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
    });
    return buf;
}

function concatBuffers(chunks) {
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;

    for (const c of chunks) {
        if (!c || !c.byteLength) continue;
        result.set(new Uint8Array(c), offset);
        offset += c.byteLength;
    }
    return result.buffer;
}

function encodeWAV(buffers, sampleRate) {
    const pcm = concatBuffers(buffers);
    const dataSize = pcm.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    new Uint8Array(buffer).set(new Uint8Array(pcm), 44);

    return buffer;
}

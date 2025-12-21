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

// // Dynamic SERVER_URL based on language selection
function getServerURL() {
    const englishMode = document.getElementById('englishMode');
    const multilingualMode = document.getElementById('multilingualMode');
    
    if (multilingualMode && multilingualMode.checked) {
        return 'wss://esp-backend-multilingual-612228147959.asia-south1.run.app';
    }
    return 'wss://esp-backend-eng-612228147959.asia-south1.run.app';
}
// const SERVER_URL = 'ws://127.0.0.1:8000/';  // Use ws:// for local development

// Frame size limits for WebSocket
const OUTGOING_MAX_FRAME_SIZE = 1024;
const INCOMING_MAX_FRAME_SIZE = 2048;
const STANDARD_DELAY_MS = 100;
const CONTROL_READY_MESSAGE = 'READY_TO_LISTEN';
const CONTROL_AUDIO_READY_MESSAGE = 'AUDIO_READY';
const CONTROL_FAILED_MESSAGE = 'FAILED';
const MAX_SPEECH_DURATION_MS = 8000;
const PRE_EMPHASIS_COEFF = 0.90;
const SILENCE_GRACE_MS = 1500;  // Reduced from 2500ms for faster response

// ================= PROFESSIONAL VAD SYSTEM =================

// Calibration and adaptation
const CALIBRATION_FRAMES = 30;           // ~600ms initial calibration
const ADAPTATION_ALPHA = 0.95;           // Smoothing for adaptive thresholds
const MIN_SPEECH_DURATION_MS = 300;      // Minimum speech to be considered valid
const SPEECH_START_FRAMES = 2;           // Reduced to 2 frames (~40ms) for faster response
const SPEECH_END_FRAMES = 25;            // ~500ms hangover after speech ends

// Multi-feature thresholds (will be adapted)
let energyThreshold = 0.01;              // Dynamic RMS threshold
let peakThreshold = 0.03;                // Dynamic peak threshold  
let zcrThreshold = 0.3;                  // Zero-crossing rate threshold
let spectralThreshold = 1000;            // Spectral centroid threshold

// Noise floor estimation
let noiseFloorRMS = 0.001;               // Estimated background noise
let noiseFloorPeak = 0.005;
let noiseSamples = [];
let calibrationFrameCount = 0;
let isCalibrated = false;

// Running statistics for adaptation
let recentEnergyLevels = [];
let recentPeakLevels = [];
const HISTORY_SIZE = 100;                // Keep last 100 frames for adaptation

// VAD runtime state
let speechFrames  = 0;
let silenceFrames = 0;
let inSpeech      = false;
let speechStartTimestamp = 0;
let speechDuration = 0;
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
let lastControlMessage = null;
let lastControlMessageTime = 0;

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
    resetVadCalibration();
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
    let wsUrl = getServerURL();
    // wsUrl = 'ws://127.0.0.1:8000'
    if (toyId) {
        const separator = wsUrl.includes('?') ? '&' : '?';
        wsUrl = `${wsUrl}${separator}toy_id=${encodeURIComponent(toyId)}`;
        appendControlMessage(`Using toy_id: ${toyId}`);
    }
    const languageMode = document.getElementById('multilingualMode').checked ? 'Multilingual' : 'English Only';
    appendControlMessage(`Language Mode: ${languageMode}`);

    websocket = new WebSocket(wsUrl);
    websocket.binaryType = 'arraybuffer';

    websocket.onopen = () => {
        console.log('\u2713 WebSocket connected.');
        statusDiv.textContent = 'Initializing microphone...';
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
    speechDuration = 0;
    // Don't reset calibration data
}

function resetVadCalibration() {
    calibrationFrameCount = 0;
    isCalibrated = false;
    noiseSamples = [];
    recentEnergyLevels = [];
    recentPeakLevels = [];
    noiseFloorRMS = 0.001;
    noiseFloorPeak = 0.005;
    energyThreshold = 0.01;
    peakThreshold = 0.03;
    console.log('🔄 VAD calibration reset');
}

function lockMicInput() {
    console.log('🔒 Locking microphone input');
    micLocked = true;
    isListeningEnabled = false;
    resetVadState();
    vadIndicator.classList.remove('listening');
}

function maybeEnableMicListening(options = {}) {
    const { force = false } = options;
    
    console.log('maybeEnableMicListening called:', {
        force,
        serverReadyPending,
        awaitingAudioReady,
        awaitingPlaybackCompletion,
        activePlaybackSources,
        micLocked,
        isListeningEnabled
    });
    
    if (!force && !serverReadyPending) {
        console.log('Skipping: not forced and no serverReadyPending');
        return;
    }
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        console.log('Skipping: websocket not open');
        serverReadyPending = false;
        return;
    }
    if (!force && (awaitingAudioReady || awaitingPlaybackCompletion || activePlaybackSources > 0)) {
        console.log('Skipping: waiting for audio/playback completion');
        return;
    }

    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    
    console.log('✓ Enabling microphone listening');
    micLocked = false;
    isListeningEnabled = true;
    serverReadyPending = false;
    awaitingAudioReady = false;
    awaitingPlaybackCompletion = false;
    statusDiv.textContent = 'Listening to you...';
    statusDiv.className = 'status-text active';
    vadIndicator.classList.remove('speaking');
    
    // Validate audio context is ready
    if (!audioContext) {
        console.error('⚠ WARNING: audioContext not initialized!');
    } else if (audioContext.state !== 'running') {
        console.warn('⚠ AudioContext state:', audioContext.state);
        audioContext.resume().then(() => {
            console.log('✓ AudioContext resumed');
        });
    }
}

function endUserSpeech(reason = 'silence') {
    if (!inSpeech) return;

    const duration = (speechDuration / 1000).toFixed(1);
    console.log(`📤 Ending speech (${reason}): duration=${duration}s`);

    inSpeech = false;
    speechFrames = 0;
    silenceFrames = 0;
    silenceDurationMs = 0;
    speechDuration = 0;
    vadIndicator.classList.remove('listening');
    statusDiv.textContent = 'Processing...';
    statusDiv.className = 'status-text';
    
    const msg = reason === 'max_duration' 
        ? `Speech ended (max ${MAX_SPEECH_DURATION_MS/1000}s reached)` 
        : `Speech ended (${duration}s)`;
    appendControlMessage(msg);

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "TURN_END", reason, duration: parseFloat(duration) }));
        console.log('✓ Sent TURN_END to server');
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

// ================= PROFESSIONAL VAD FEATURE EXTRACTION =================

function computeZeroCrossingRate(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
        if ((samples[i] >= 0 && samples[i - 1] < 0) || 
            (samples[i] < 0 && samples[i - 1] >= 0)) {
            crossings++;
        }
    }
    return crossings / samples.length;
}

function computeSpectralCentroid(samples, sampleRate) {
    // Simple spectral centroid using time-domain approximation
    // Full FFT would be better but too expensive for real-time
    let weightedSum = 0;
    let totalEnergy = 0;
    
    for (let i = 0; i < samples.length; i++) {
        const energy = samples[i] * samples[i];
        const freq = (i / samples.length) * (sampleRate / 2);
        weightedSum += freq * energy;
        totalEnergy += energy;
    }
    
    return totalEnergy > 0 ? weightedSum / totalEnergy : 0;
}

function computeAudioFeatures(samples, sampleRate) {
    // Energy features
    let sumSquares = 0;
    let peak = 0;
    
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        sumSquares += v * v;
        peak = Math.max(peak, Math.abs(v));
    }
    
    const rms = Math.sqrt(sumSquares / samples.length);
    const zcr = computeZeroCrossingRate(samples);
    const spectralCentroid = computeSpectralCentroid(samples, sampleRate);
    
    return { rms, peak, zcr, spectralCentroid };
}

function calibrateNoiseFloor(features) {
    noiseSamples.push(features.rms);
    
    if (calibrationFrameCount >= CALIBRATION_FRAMES) {
        // Calculate noise floor as mean + 2*std of calibration samples
        const mean = noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length;
        const variance = noiseSamples.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / noiseSamples.length;
        const std = Math.sqrt(variance);
        
        noiseFloorRMS = mean;
        noiseFloorPeak = mean + std;
        
        // Set adaptive thresholds with safety margins
        energyThreshold = Math.max(0.005, noiseFloorRMS * 3);
        peakThreshold = Math.max(0.01, noiseFloorPeak * 2.5);
        
        isCalibrated = true;
        console.log('✅ VAD calibrated:', {
            noiseFloor: noiseFloorRMS.toFixed(4),
            energyThreshold: energyThreshold.toFixed(4),
            peakThreshold: peakThreshold.toFixed(4)
        });
        appendControlMessage(`Mic calibrated. Noise: ${noiseFloorRMS.toFixed(4)}`);
    }
    
    calibrationFrameCount++;
}

function updateAdaptiveThresholds(features) {
    // Keep running history
    recentEnergyLevels.push(features.rms);
    recentPeakLevels.push(features.peak);
    
    if (recentEnergyLevels.length > HISTORY_SIZE) {
        recentEnergyLevels.shift();
        recentPeakLevels.shift();
    }
    
    // Adapt thresholds using exponential moving average
    if (recentEnergyLevels.length >= 10) {
        const avgEnergy = recentEnergyLevels.reduce((a, b) => a + b, 0) / recentEnergyLevels.length;
        const avgPeak = recentPeakLevels.reduce((a, b) => a + b, 0) / recentPeakLevels.length;
        
        // Update noise floor slowly (only during non-speech)
        if (!inSpeech && silenceFrames > 10) {
            noiseFloorRMS = ADAPTATION_ALPHA * noiseFloorRMS + (1 - ADAPTATION_ALPHA) * avgEnergy;
            energyThreshold = Math.max(0.005, noiseFloorRMS * 3);
            peakThreshold = Math.max(0.01, avgPeak * 1.5);
        }
    }
}

function detectSpeech(features) {
    // Multi-feature decision with weighted voting
    let votes = 0;
    let confidence = 0;
    
    // Feature 1: Energy (RMS) - most important
    if (features.rms > energyThreshold) {
        votes += 2;
        confidence += (features.rms / energyThreshold) * 0.4;
    }
    
    // Feature 2: Peak amplitude - catches sharp sounds
    if (features.peak > peakThreshold) {
        votes += 2;
        confidence += (features.peak / peakThreshold) * 0.3;
    }
    
    // Feature 3: Zero-crossing rate - distinguishes speech from noise
    // Speech typically has moderate ZCR (0.1-0.5)
    if (features.zcr > 0.05 && features.zcr < 0.6) {
        votes += 1;
        confidence += 0.15;
    }
    
    // Feature 4: Spectral centroid - speech has higher frequencies
    if (features.spectralCentroid > spectralThreshold) {
        votes += 1;
        confidence += 0.15;
    }
    
    // Need at least 3 votes to consider it speech (out of 6 possible)
    const isSpeech = votes >= 3;
    
    return { isSpeech, confidence: Math.min(confidence, 1.0), votes };
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

    // Debounce duplicate messages within 500ms
    const now = Date.now();
    if (message === lastControlMessage && (now - lastControlMessageTime) < 500) {
        console.log('Ignoring duplicate control message:', message);
        return;
    }
    lastControlMessage = message;
    lastControlMessageTime = now;

    console.log('Control message:', message);
    appendControlMessage(message);

    const normalized = message.toLowerCase();

    if (normalized === CONTROL_READY_MESSAGE.toLowerCase()) {
        statusDiv.textContent = 'Ready...';
        statusDiv.className = 'status-text';
        
        // Only process if we're not already in an active state
        if (!inSpeech && activePlaybackSources === 0) {
            serverReadyPending = true;
            if (readyTimer) {
                clearTimeout(readyTimer);
            }
            readyTimer = setTimeout(() => {
                readyTimer = null;
                maybeEnableMicListening();
            }, STANDARD_DELAY_MS);
        } else {
            console.log('Ignoring ready message: inSpeech=', inSpeech, 'activePlayback=', activePlaybackSources);
        }
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

    if (normalized === CONTROL_FAILED_MESSAGE.toLowerCase()) {
        if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
        }
        lockMicInput();
        awaitingAudioReady = false;
        awaitingPlaybackCompletion = false;
        serverReadyPending = false;
        resetVadState();
        statusDiv.textContent = 'Control failed, waiting to reconnect...';
        statusDiv.className = 'status-text';
        vadIndicator.classList.remove('speaking', 'listening');
        appendControlMessage('Control failed. Waiting for ready signal...');
        console.log('⚠️ Control failed - resetting to mic state, awaiting READY_TO_LISTEN');
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

        let audioProcessingLogCount = 0;
        let lastAudioLogTime = 0;
        
        scriptProcessor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            const now = Date.now();

            // Log status periodically
            audioProcessingLogCount++;
            if (audioProcessingLogCount % 100 === 1 && now - lastAudioLogTime > 2000) {
                console.log('🎙️ Audio callback active. State:', {
                    micLocked,
                    isListeningEnabled,
                    inSpeech,
                    calibrated: isCalibrated,
                    energyThreshold: energyThreshold.toFixed(4),
                    peakThreshold: peakThreshold.toFixed(4)
                });
                lastAudioLogTime = now;
            }

            if (micLocked || !isListeningEnabled) {
                if (inSpeech || speechFrames > 0) {
                    console.log('⚠ Audio processing disabled: micLocked=', micLocked, 'isListeningEnabled=', isListeningEnabled);
                }
                resetVadState();
                return;
            }

            // Apply pre-emphasis filter
            const emphasized = applyPreEmphasis(input);

            // ---------- EXTRACT AUDIO FEATURES ----------
            const features = computeAudioFeatures(emphasized, audioContext.sampleRate);

            // ---------- CALIBRATION PHASE ----------
            if (!isCalibrated) {
                calibrateNoiseFloor(features);
                if (calibrationFrameCount < CALIBRATION_FRAMES) {
                    statusDiv.textContent = `Calibrating mic... ${Math.round((calibrationFrameCount / CALIBRATION_FRAMES) * 100)}%`;
                    return; // Don't process speech during calibration
                }
            }

            // ---------- ADAPTIVE THRESHOLD UPDATE ----------
            updateAdaptiveThresholds(features);

            // ---------- SPEECH DETECTION ----------
            const detection = detectSpeech(features);
            
            // Log detection details occasionally
            if (audioProcessingLogCount % 50 === 0 && now - lastAudioLogTime > 1000) {
                console.log('🔊 Features:', {
                    RMS: features.rms.toFixed(4),
                    Peak: features.peak.toFixed(4),
                    ZCR: features.zcr.toFixed(3),
                    isSpeech: detection.isSpeech,
                    confidence: detection.confidence.toFixed(2),
                    votes: detection.votes,
                    speechFrames
                });
            }

            // ---------- VAD STATE MACHINE ----------
            if (detection.isSpeech) {
                speechFrames++;
                silenceFrames = 0;
                silenceDurationMs = 0;
            } else {
                silenceFrames++;
                if (inSpeech) {
                    // Only reset speech frames if we've been silent for a while
                    silenceDurationMs += frameDurationMs;
                } else {
                    speechFrames = 0;
                }
            }

            // ---------- SPEECH START ----------
            if (!inSpeech && speechFrames >= SPEECH_START_FRAMES) {
                console.log('🎤 SPEECH STARTED - speechFrames:', speechFrames, 'confidence:', detection.confidence.toFixed(2));
                inSpeech = true;
                speechFrames = 0;
                silenceFrames = 0;
                speechStartTimestamp = performance.now();
                speechDuration = 0;
                awaitingAudioReady = false;
                awaitingPlaybackCompletion = false;
                serverReadyPending = false;

                vadIndicator.classList.add('listening');
                vadIndicator.classList.remove('speaking');
                statusDiv.textContent = 'You are speaking...';
                statusDiv.className = 'status-text active';
                appendControlMessage('🎤 Speech detected');

                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({ type: "TURN_START" }));
                    console.log('✓ Sent TURN_START to server');
                } else {
                    console.error('⚠ Cannot send TURN_START - WebSocket not open');
                }
            }

            // ---------- TRACK SPEECH DURATION ----------
            if (inSpeech) {
                const elapsed = performance.now() - speechStartTimestamp;
                speechDuration = elapsed;
                
                // Max duration safeguard
                if (elapsed >= MAX_SPEECH_DURATION_MS) {
                    console.log('⏱️ Max speech duration reached:', (elapsed/1000).toFixed(1), 'seconds');
                    endUserSpeech('max_duration');
                    return;
                }
            }

            // ---------- SPEECH END (with proper hangover) ----------
            if (inSpeech && silenceFrames >= SPEECH_END_FRAMES) {
                // Check minimum speech duration to avoid false triggers
                if (speechDuration < MIN_SPEECH_DURATION_MS) {
                    console.log('⚠ Speech too short, ignoring:', speechDuration.toFixed(0), 'ms');
                    inSpeech = false;
                    speechFrames = 0;
                    silenceFrames = 0;
                    vadIndicator.classList.remove('listening');
                    return;
                }
                
                console.log('🛑 Speech ended after', (speechDuration/1000).toFixed(1), 'seconds of speech,', 
                           (silenceFrames * frameDurationMs).toFixed(0), 'ms silence');
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
        console.log('✓ Microphone initialized and connected');
        // Don't set status here - let the state machine handle it
    } catch (err) {
        console.error('Microphone initialization error:', err);
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
            console.log('Audio source ended. Active sources:', activePlaybackSources);
            
            if (activePlaybackSources === 0) {
                // Wait a bit before re-enabling mic to avoid cutting off tail of audio
                setTimeout(() => {
                    if (activePlaybackSources === 0 && !inSpeech) {
                        console.log('All playback complete, re-enabling mic');
                        awaitingPlaybackCompletion = false;
                        vadIndicator.classList.remove('speaking');
                        if (readyTimer) {
                            clearTimeout(readyTimer);
                            readyTimer = null;
                        }
                        maybeEnableMicListening({ force: true });
                    }
                }, 100);
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

/* ═══════════════════════════════════════════════════════════════════════════
   JARVIS HUD v3.0 — RENDERER, VISUALS, & PREMIUM INTELLIGENCE
   ═══════════════════════════════════════════════════════════════════════════ */

// ── UI ELEMENTS ──
const userTextEl = document.getElementById('user-text');
const jarvisTextEl = document.getElementById('jarvis-text');
const mainClock = document.getElementById('main-clock');
const statusPill = document.getElementById('status-pill');
const cmdsPillCount = document.getElementById('cmd-count');

let cmdsExecuted = 0;
let isListening = false;
let isProcessing = false;
let isSpeaking = false;
let isUserSpeaking = false;
let autoListen = true; // Always-on listening mode
let usePremiumSTT = true; // Set to true for Local Package STT
let STT_ENGINE = 'VOSK'; // 'VOSK', 'GROQ', 'SARVAM', 'SONIOX', 'WEB'
let conversationHistory = [];
let useGroqTTS = false; // DISABLED: Using local voice as requested

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT MEMORY SYSTEM — Remembers user facts across sessions
// ═══════════════════════════════════════════════════════════════════════════

const CREATOR_PROFILE = {
  name: "Akshat Singh",
  title: "Tech Creator & Developer",
  techPage: "Runs a popular tech page with a growing audience, covering the latest in AI, gadgets, web development, and cutting-edge tech trends.",
  interests: "Passionate about Artificial Intelligence, Machine Learning, Web Development (React, Next.js, Node.js), Electron apps, AR/VR, and building futuristic interfaces.",
  skills: "Full-stack developer specializing in JavaScript/TypeScript, Python, and creative UI/UX engineering. Builds AI-powered tools, real-time applications, and immersive web experiences.",
  personality: "Visionary tech enthusiast who loves pushing boundaries. Believes in building things that feel like the future. Inspired by Tony Stark's approach to tech.",
  projects: "Created JARVIS AI Assistant, X-Ray Hand Portal AR engine, 3D particle text interfaces, and various AI-integrated applications.",
  motto: "Build things that make people say 'How is this possible?'"
};

// Persistent user memory — survives app restarts
let userMemory = JSON.parse(localStorage.getItem('jarvis_user_memory') || '{}');

function saveMemory() {
  localStorage.setItem('jarvis_user_memory', JSON.stringify(userMemory));
}

function rememberFact(key, value) {
  userMemory[key] = { value, timestamp: Date.now() };
  saveMemory();
  console.log(`[Memory] Stored: ${key} = ${value}`);
}

function recallFact(key) {
  return userMemory[key]?.value || null;
}

function getAllMemories() {
  const entries = Object.entries(userMemory);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `- ${k}: ${v.value}`).join('\n');
}

// Auto-extract facts from user messages
function extractAndStoreFacts(text) {
  const lower = text.toLowerCase();
  
  // Name extraction
  const nameMatch = text.match(/(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (nameMatch) rememberFact('user_name', nameMatch[1].trim());
  
  // Age
  const ageMatch = text.match(/(?:i'm|i am|my age is)\s+(\d{1,2})\s*(?:years|year|yrs)?\s*(?:old)?/i);
  if (ageMatch) rememberFact('user_age', ageMatch[1]);
  
  // Location
  const locMatch = text.match(/(?:i live in|i'm from|i am from|i'm in|based in|located in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i);
  if (locMatch) rememberFact('user_location', locMatch[1].trim());
  
  // Job/Profession
  const jobMatch = text.match(/(?:i work as|i'm a|i am a|my job is|i work at|my profession is)\s+(.{3,40}?)(?:\.|,|$)/i);
  if (jobMatch) rememberFact('user_profession', jobMatch[1].trim());
  
  // Favorites
  const favMatch = text.match(/(?:my favorite|i love|i like|i enjoy|i prefer)\s+(.{3,40}?)(?:\.|,|$)/i);
  if (favMatch) rememberFact('user_likes_' + Date.now(), favMatch[1].trim());
  
  // College/School
  const eduMatch = text.match(/(?:i study at|i go to|i'm studying|my college is|my school is|i attend)\s+(.{3,50}?)(?:\.|,|$)/i);
  if (eduMatch) rememberFact('user_education', eduMatch[1].trim());
}

let jarvisAsleep = true; // STARTS HIDDEN AND ASLEEP
let sleepTimer = null;
const sessionStartTime = Date.now();

let lastClapTime = 0;
function detectClap(dataArray) {
  if (!jarvisAsleep) return; // Only listen for claps when asleep
  
  // Prevent false positives during the first 3 seconds of startup
  if (Date.now() - sessionStartTime < 3000) return;

  let sum = 0;
  let maxVolume = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
    if (dataArray[i] > maxVolume) maxVolume = dataArray[i];
  }
  let avg = sum / dataArray.length;

  // Threshold for a loud, sharp noise (clap)
  // A clap is a broad-spectrum transient, so it will have a very high peak and decent average.
  if (maxVolume > 200 && avg > 40) {
    const now = Date.now();
    if (now - lastClapTime > 1000) { // 1 second debounce
      lastClapTime = now;
      console.log(`[Renderer] 👏 CLAP DETECTED! Max: ${maxVolume}, Avg: ${avg.toFixed(1)}`);
      
      // Tell main.js to maximize the window
      if (window.assistant && window.assistant.wakeUp) {
        window.assistant.wakeUp();
      }

      // NEW: Cinematic Intro Sequence
      if (jarvisAsleep) {
        jarvisAsleep = false;
        playIntroSequence();
      } else {
        // If already awake, just provide feedback
        runStartupBriefing();
      }
    }
  }
}

/**
 * Plays the intro cinematic audio for 13 seconds before handing over to JARVIS.
 */
function playIntroSequence() {
  console.log("[Intro] Starting 13s cinematic sequence...");
  updateStatus('WAKING');
  jarvisTextEl.textContent = "Sir, systems are initializing...";

  const audio = new Audio('audio/audio.mp3');
  audio.volume = 0.8;
  audio.play().catch(err => console.error("[Intro] Audio play failed:", err));

  setTimeout(() => {
    // After 13 seconds, start the briefing (which transitions to listening)
    runStartupBriefing();
  }, 13000);
}
let lastInsightTime = Date.now();
let lastSTTCall = 0;
const STT_COOLDOWN = 1500; 

const HALLUCINATION_PHRASES = [
  "mbc 뉴스", "kim seong-hyun", "thanks for watching", "subscribe", 
  "please subscribe", "thank you", "okay.", "сейчас спрашиваем", "бруль",
  "subtitle", "watching", "you", "hello", "am", "obrigado", "tchau", "valeu",
  "gracias", "adios", "hola", "por favor", "suscríbete", "ver", "mira",
  "thank you.", "thank you", "yeah.", "yeah", "yes.", "yes", "and", "look", "so"
];

// ── CLOCK & UI LOOP ──
setInterval(() => {
  const d = new Date();
  mainClock.textContent = d.toLocaleTimeString('en-GB', { hour12: false });
}, 1000);

function scrambleBars(containerId, count) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (container.children.length === 0) {
    for (let i = 0; i < count; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      container.appendChild(bar);
    }
  }
  for (let i = 0; i < count; i++) {
    const bar = container.children[i];
    const h = Math.floor(Math.random() * 90) + 10;
    bar.style.height = `${h}%`;
  }
}
setInterval(() => {
  scrambleBars('cpu-graph', 30);
  scrambleBars('drive-graph', 15);
  scrambleBars('core1-graph', 8);
  scrambleBars('core2-graph', 8);
  scrambleBars('net-graph', 15);
  scrambleBars('cpu2-graph', 15);
}, 800);

// ═══════════════════════════════════════════════════════════════════════════
// ARC REACTOR & WEB AUDIO VISUALIZER
// ═══════════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('arc-canvas');
const ctx = canvas.getContext('2d');
const CX = 150, CY = 150;

let audioCtx, analyser, dataArray;
let angleOffset = 0;

async function initWebAudio() {
  try {
    // Check/Request OS-level permission first
    if (window.assistant && window.assistant.requestMicPermission) {
      const granted = await window.assistant.requestMicPermission();
      if (!granted) {
        console.warn("[Renderer] Microphone permission not granted by OS.");
        // We still try getUserMedia as it might trigger a prompt on some platforms
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log("[Renderer] Detected devices:", devices.map(d => `${d.kind}: ${d.label} (${d.deviceId})`).join(', '));
    const hasMic = devices.some(d => d.kind === 'audioinput');
    if (!hasMic) {
      console.error("[Renderer] CRITICAL: No audio input devices found!");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }, 
      video: false 
    });
    console.log("[Renderer] Stream acquired successfully:", stream.id);
    
    // Update UI to show Mic is Active
    const micPill = document.getElementById('mic-pill');
    if (micPill) {
      micPill.textContent = "MIC ACTIVE";
      micPill.style.color = "#00ff88";
    }
    updateStatus('LISTENING');

    // Verify access with MediaRecorder as requested
    try {
      const recorder = new MediaRecorder(stream);
      recorder.start();
      setTimeout(() => recorder.stop(), 100);
      console.log("[Renderer] MediaRecorder validation: Success");
    } catch (recorderErr) {
      console.warn("[Renderer] MediaRecorder validation failed:", recorderErr);
    }

    window.globalMicStream = stream; // Keep OS lock forever

    console.log("[Renderer] Initializing AudioContext at 16kHz...");
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    if (audioCtx.state === 'suspended') {
      console.warn("[Renderer] AudioContext suspended. Resuming...");
      await audioCtx.resume();
    }
    console.log("[Renderer] AudioContext state:", audioCtx.state, "Sample Rate:", audioCtx.sampleRate);

    analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 128;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    console.log("[Renderer] Web Audio visualizer linked. (Check Arc Reactor)");

    // Initialize Native STT (Web Speech API)
    initNativeSpeech();
  } catch (err) {
    console.error("[Renderer] Mic access error:", err);
    // Auto-retry if macOS blocked it momentarily or if the OS permission wasn't resolved yet
    if (err.name === 'AbortError' || err.name === 'NotAllowedError' || err.message.includes('shutdown')) {
      setTimeout(initWebAudio, 3000);
    }
  }
}

function drawArcReactor() {
  ctx.clearRect(0, 0, 300, 300);
  angleOffset += 0.01;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 180, 255, 0.2)';
  [120, 110, 100, 88].forEach(r => {
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.stroke();
  });

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 180, 255, 0.4)';
  for (let i = 0; i < 72; i++) {
    const a = (i * Math.PI * 2) / 72 + angleOffset * 0.5;
    const isMajor = i % 6 === 0;
    const r1 = 120, r2 = isMajor ? 128 : 124;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
    ctx.lineTo(CX + Math.cos(a) * r2, CY + Math.sin(a) * r2);
    ctx.stroke();
  }

  ctx.lineWidth = 4;
  for (let i = 0; i < 4; i++) {
    const baseA = (i * Math.PI) / 2;
    const dir = i % 2 === 0 ? 1 : -1;
    const a = baseA + (angleOffset * 1.5 * dir);
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(0, 212, 255, 0.8)' : 'rgba(0, 180, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(CX, CY, 110, a, a + 0.5);
    ctx.stroke();
  }

  if (analyser) {
    analyser.getByteFrequencyData(dataArray);
    detectClap(dataArray); // Check for clap every frame
  }

  ctx.lineWidth = 2;
  const numBars = 64;
  for (let i = 0; i < numBars; i++) {
    const a = (i * Math.PI * 2) / numBars - angleOffset;
    const rBase = 42;
    let rExt = 5 + Math.sin(angleOffset * 5 + i) * 5;

    if (analyser) {
      const fftIdx = Math.floor((i / numBars) * (dataArray.length * 0.6));
      const val = dataArray[fftIdx];
      rExt += (val / 255) * 40;
    }

    ctx.strokeStyle = isListening ? `rgba(0, 212, 255, ${0.4 + (rExt / 50)})` : 'rgba(0, 180, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(a) * rBase, CY + Math.sin(a) * rBase);
    ctx.lineTo(CX + Math.cos(a) * (rBase + rExt), CY + Math.sin(a) * (rBase + rExt));
    ctx.stroke();
  }

  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI * 2) / 8 + (angleOffset * (i % 2 == 0 ? 2 : -2));
    // Color changes slightly when awake vs asleep
    ctx.fillStyle = !jarvisAsleep ? 'rgba(0, 255, 136, 0.9)' : 'rgba(0, 255, 136, 0.2)';
    ctx.beginPath();
    ctx.arc(CX + Math.cos(a) * 75, CY + Math.sin(a) * 75, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(drawArcReactor);
}
drawArcReactor();
initWebAudio();


let ignoreAudio = false;

function resetSleepTimer() {
  // No sleep timer - Jarvis stays awake
}

// ═══════════════════════════════════════════════════════════════════════════
// GROQ WHISPER STT (VAD RECORDER)
// ═══════════════════════════════════════════════════════════════════════════
let mediaRecorder = null;
let audioChunks = [];
let vadTimer = null;
let vadThreshold = 55.0; // Increased to 55 to suppress room noise/hallucinations
let silenceDuration = 400; // Snappier response (0.4s silence)
let recordingStartTime = 0;
let hasHighConfidenceSpeech = false;

// Fallback for native web browser
let recognition;
let nativeFinalTimer = null;
const NATIVE_FINAL_DELAY = 1500; 
let nativeErrorCount = 0;

function initNativeSpeech() {
  if (STT_ENGINE === 'SONIOX') {
    initSonioxSTT();
    console.log("[Speech] Using SONIOX Real-time STT.");
  } else if (STT_ENGINE === 'VOSK') {
    initVoskSTT();
    console.log("[Speech] Using LOCAL Vosk Package STT.");
  } else if (!usePremiumSTT && (window.webkitSpeechRecognition || window.speechRecognition)) {
    initWebkitSpeech();
    console.log("[Speech] Using FREE Native Web Speech STT.");
  } else if (window.assistant && (window.assistant.groqSTT || window.assistant.sarvamSTT)) {
    initCloudSTT();
    console.log(`[Speech] Using Premium ${STT_ENGINE} STT.`);
  } else {
    jarvisTextEl.textContent = "Sir, no speech recognition protocols are available.";
  }
}

let voskModel;
let voskRecognizer;

let sonioxClient;

function initSonioxSTT() {
  if (!window.SonioxClient) {
    console.error("[Soniox] SonioxClient not found on window.");
    return;
  }

  // Use the secure bridge to get the API key
  window.assistant.getEnv('SONIOX_API_KEY').then(apiKey => {
    if (!apiKey) {
      jarvisTextEl.textContent = "Sir, Soniox API key is missing. Please set it in .env.";
      console.warn("[Soniox] API Key missing.");
      return;
    }

    sonioxClient = new window.SonioxClient({
      apiKey: apiKey,
      onPartialResult: (result) => {
        const text = result.tokens.map(t => t.text).join("");
        if (text) {
          jarvisTextEl.textContent = text;
          jarvisTextEl.classList.add("active-text");
        }
      },
      onError: (status, message) => {
        console.error(`[Soniox Error] ${status}: ${message}`);
        if (status === 'api_error') {
          jarvisTextEl.textContent = "Sir, Soniox neural link failed. API key might be exhausted.";
        }
      }
    });

    // Start Soniox continuous listening
    sonioxClient.start({
      model: 'stt-rt-preview',
      enableEndpointDetection: true,
      onFinished: () => {
        const text = jarvisTextEl.textContent;
        if (text && text !== "Listening..." && text !== "Awaiting command...") {
          processInput(text);
        }
      }
    });

    jarvisTextEl.textContent = "Soniox STT Initialized. Ready.";
  });
}

async function initVoskSTT() {
  try {
    jarvisTextEl.textContent = "Loading local STT package...";
    // Loading from tar.gz is more robust for vosk-browser over HTTP
    const model = await Vosk.createModel('http://localhost:3000/models/en-us.tar.gz');
    voskModel = model;
    
    // We'll use Vosk for continuous transcription
    const recognizer = new model.KaldiRecognizer(audioCtx.sampleRate);
    voskRecognizer = recognizer;

    recognizer.on("result", (message) => {
      isUserSpeaking = false;
      const text = message.result.text;
      if (text && text.trim().length > 1) {
        console.log("[Vosk] Final Result:", text);
        handleSpeechResult(text, true);
      }
    });

    recognizer.on("partialresult", (message) => {
      const partial = message.result.partial.toLowerCase();
      
      if (partial && partial.trim().length > 0) {
        isUserSpeaking = true;
      } else {
        isUserSpeaking = false;
      }

      if (partial && partial.trim().length > 2) {
        userTextEl.textContent = partial;
        
        // Barge-in: If user speaks while JARVIS is talking/processing, interrupt JARVIS
        if (isSpeaking || isProcessing) {
          // Software Echo Cancellation: prevent JARVIS from interrupting himself
          const normPartial = partial.replace(/[^a-z0-9\s]/g, '').trim();
          const normSpoken = (window.lastSpokenText || "").toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          
          let isSelfEcho = false;
          if (normSpoken && normPartial) {
            if (normSpoken.includes(normPartial)) {
              isSelfEcho = true;
            } else {
              // Fuzzy word match (e.g. "im" vs "i am")
              const pWords = normPartial.split(' ').filter(w => w.length > 2);
              const sWords = normSpoken.split(' ');
              let matches = 0;
              for (const w of pWords) {
                if (sWords.includes(w)) matches++;
              }
              if (pWords.length > 0 && matches >= Math.min(2, pWords.length)) {
                isSelfEcho = true;
              }
            }
          }

          if (!isSelfEcho) {
            console.log(`[Speech] User barged in! (Detected: "${partial}"). Interrupting JARVIS.`);
            cancelPlayback();
          } else {
            console.log(`[Speech] Ignoring self-echo: "${partial}"`);
          }
        }
      }
    });

    // Hook into the mic stream using AudioWorklet-compatible approach
    const source = audioCtx.createMediaStreamSource(window.globalMicStream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    
    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (event) => {
      // Turn OFF mic feed to Vosk while JARVIS is speaking to prevent self-echo
      if (!isSpeaking) {
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch (e) {
          // Fallback: try with float32 data directly
          try {
            const data = event.inputBuffer.getChannelData(0);
            recognizer.acceptWaveformFloat(data, audioCtx.sampleRate);
          } catch (e2) {
            // silent
          }
        }
      }
    };

    // CRITICAL: Set listening state so the rest of the app knows we're live
    isListening = true;
    updateStatus('LISTENING');
    jarvisTextEl.textContent = "Vosk STT Initialized. Ready.";
    console.log("[Speech] Local Vosk STT Active.");
  } catch (err) {
    console.error("[Vosk] Initialization Error:", err);
    jarvisTextEl.textContent = "Local STT failed. Falling back to Groq.";
    STT_ENGINE = 'GROQ';
    initCloudSTT();
  }
}


function initWebkitSpeech() {
  const SpeechRecognition = window.webkitSpeechRecognition || window.speechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true; // Enabled for always-on system STT
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    statusPill.className = 'status-pill pulse';
    updateStatus(!jarvisAsleep ? 'LISTENING' : 'SLEEPING');
    console.log("[Speech] Native Recognition Started.");
  };

  recognition.onerror = (event) => {
    console.error("[Speech] Error:", event.error);
    if (event.error === 'network') {
      nativeErrorCount++;
      if (nativeErrorCount > 3) {
        console.warn("[Speech] Persistent network error. Falling back to Groq STT...");
        usePremiumSTT = true;
        initNativeSpeech();
      }
    }
  };

  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      else interimTranscript += event.results[i][0].transcript;
    }

    if (finalTranscript) {
      handleSpeechResult(finalTranscript, true);
      clearTimeout(nativeFinalTimer);
      nativeErrorCount = 0;
    } else if (interimTranscript) {
      handleSpeechResult(interimTranscript, false);
      clearTimeout(nativeFinalTimer);
      nativeFinalTimer = setTimeout(() => {
        handleSpeechResult(interimTranscript, true);
        try { recognition.stop(); } catch(e) {}
      }, NATIVE_FINAL_DELAY);
    }
  };

  recognition.onend = () => {
    if (autoListen && !usePremiumSTT) {
      // Small delay to prevent API spamming
      setTimeout(() => {
        try { recognition.start(); } catch(e) {}
      }, 500);
    }
  };

  try {
    recognition.start();
    jarvisTextEl.textContent = "Free Native STT Online. Ready.";
  } catch (e) {
    console.error("[Speech] Start failure:", e);
  }
}

function initCloudSTT() {
  if (!window.globalMicStream) {
    console.error("[VAD] No mic stream found.");
    return;
  }

  mediaRecorder = new MediaRecorder(window.globalMicStream, { mimeType: 'audio/webm' });
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  
  mediaRecorder.onstop = async () => {
    if (audioChunks.length === 0) return;
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];
    
    // Minimum duration check (0.5s)
    const duration = Date.now() - recordingStartTime;
    if (duration < 500 || !hasHighConfidenceSpeech) {
      console.warn("[VAD] Recording discarded: Too short or low confidence.");
      return;
    }
    
    // Rate Limiting
    const now = Date.now();
    if (now - lastSTTCall < STT_COOLDOWN) {
      console.warn("[VAD] Rate limited. Skipping STT call.");
      return;
    }
    lastSTTCall = now;

    try {
      const arrayBuffer = await blob.arrayBuffer();
      let result;
      
      // Attempt primary engine
      if (STT_ENGINE === 'SARVAM') {
        console.log("[STT] Attempting Sarvam Saaras v3...");
        result = await window.assistant.sarvamSTT(arrayBuffer);
        if (!result.success) {
          console.warn("[STT] Sarvam failed. Falling back to Groq Whisper...");
          result = await window.assistant.groqSTT(arrayBuffer);
        }
      } else {
        console.log("[STT] Attempting Groq Whisper...");
        result = await window.assistant.groqSTT(arrayBuffer);
        if (!result.success) {
          console.warn("[STT] Groq failed. Falling back to Native...");
          // If Groq fails, we can't easily switch to Native for THIS blob 
          // (Native is streaming), but we can notify.
        }
      }

      console.log("[STT] Response:", result);
      
      if (result.success && result.text) {
        console.log("[STT] Final:", result.text);
        handleSpeechResult(result.text, true);
      } else {
        console.warn("[STT] Transcription failed or returned empty result.");
        // If everything fails, notify user
        if (result.error && (result.error.includes("credits") || result.error.includes("limit"))) {
          jarvisTextEl.textContent = "Sir, all high-tier STT links are exhausted. Please check quotas.";
        }
      }
    } catch (e) {
      console.error("[STT] STT Error:", e);
    }
  };

  // Run Voice Activity Detection Loop
  setInterval(checkVAD, 100);
  
  jarvisTextEl.textContent = `${STT_ENGINE} STT Initialized. Ready.`;
  console.log(`[Speech] ${STT_ENGINE} Cloud VAD Started.`);
}

function checkVAD() {
  if (!autoListen || !analyser) return;
  
  // We allow checkVAD to run even if isSpeaking/isProcessing 
  // so that we can detect INTERRUPTIONS.
  
  analyser.getByteFrequencyData(dataArray);
  let sum = 0;
  for(let i = 0; i < dataArray.length; i++) sum += dataArray[i];
  let avg = sum / dataArray.length;
  
  // Heartbeat log every 2 seconds to verify mic axis is alive
  if (Math.random() < 0.01) console.log(`[VAD] Mic Axis Volume: ${avg.toFixed(2)} (Threshold: ${vadThreshold})`);

  if (avg > vadThreshold) {
    if (avg > vadThreshold + 10) hasHighConfidenceSpeech = true; // Gate for real speech vs noise

    if (!isUserSpeaking) {
      isUserSpeaking = true;
      if (mediaRecorder.state === 'inactive') {
        // INTERRUPT JARVIS if he is speaking
        if (isSpeaking) {
          console.log("[VAD] User interrupted JARVIS. Stopping playback.");
          window.speechSynthesis.cancel();
          if (window.currentJARVISAudio) {
            window.currentJARVISAudio.pause();
            window.currentJARVISAudio.currentTime = 0;
          }
          finishSpeakingState();
        }
        
        audioChunks = [];
        recordingStartTime = Date.now();
        hasHighConfidenceSpeech = false;
        // Re-enable listening after speech/processing is done
        statusPill.className = 'status-pill pulse';
        updateStatus(!jarvisAsleep ? 'LISTENING' : 'SLEEPING');
        mediaRecorder.start();
        isListening = true;
        updateStatus(!jarvisAsleep ? 'LISTENING' : 'SLEEPING');
      }
    }
    
    clearTimeout(vadTimer);
    vadTimer = setTimeout(() => {
      isUserSpeaking = false;
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        isListening = false;
      }
    }, silenceDuration);
  }
}

function handleSpeechResult(text, isFinal) {
  if (jarvisAsleep) {
    // Completely ignore STT if asleep
    return;
  }

  const lowText = text.toLowerCase().trim();
  console.log(`[Speech] handleSpeechResult: "${text}" (Final: ${isFinal})`);
  // Only ignore if we are currently PROCESSING (calling LLM)
  if (isProcessing) {
    console.warn("[Speech] Ignored: System is processing previous input.");
    return;
  }
  const lowerText = text.toLowerCase();
  
  // Hallucination Filter
  const isHallucination = HALLUCINATION_PHRASES.some(phrase => lowerText.includes(phrase)) && text.length < 25;
  if (isHallucination) {
    console.warn("[Speech] Hallucination detected and filtered:", text);
    return;
  }

  userTextEl.textContent = text;
  if (isFinal && text.trim().length > 1) { // Min 2 chars
    processInput(text);
  }
}

function startListening() {
  if (recognition) { try { recognition.start(); } catch(e) {} }
}

function stopListening() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isUserSpeaking = false;
  clearTimeout(vadTimer);
  
  isListening = false;
  if (recognition) { try { recognition.stop(); } catch(e) {} }
}


function updateStatus(state) {
  statusPill.textContent = state;
  statusPill.className = 'pill orbitron-text';
  if (state === 'LISTENING') statusPill.classList.add('bright-text');
  if (state === 'PROCESSING') statusPill.classList.add('warning-text');
  if (state === 'SPEAKING') statusPill.classList.add('success-text');
  if (state === 'SLEEPING') statusPill.style.color = '#555';
  if (state === 'WAKING') statusPill.style.color = '#aa00ff';
}


// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENCE & BACKGROUND BEHAVIORS
// ═══════════════════════════════════════════════════════════════════════════

async function runStartupBriefing() {
  let batteryStr = "an unknown";
  try {
    const navBat = await navigator.getBattery();
    batteryStr = Math.round(navBat.level * 100) + " percent";
  } catch (e) { }

  const h = new Date().getHours();
  let greeting = "";
  let engageQuestion = "";
  
  if (h < 12) {
    greeting = "Good morning";
    engageQuestion = "What are we building today?";
  } else if (h < 18) {
    greeting = "Good afternoon";
    engageQuestion = "Shall we continue with our tasks?";
  } else {
    greeting = "Good evening";
    engageQuestion = "Working late? What's the directive for tonight?";
  }

  const osStr = navigator.userAgent.includes("Mac") ? "macOS" : "Windows";

  const text = `${greeting}, sir. All systems are online. We are running on ${osStr} with capacity at ${batteryStr}. I am initializing your developer workspace now. ${engageQuestion}`;

  jarvisTextEl.textContent = "Running telemetry diagnostics...";
  speakTTS(text);

  // Automatically trigger developer workspace setup
  setTimeout(() => {
    if (window.assistant && window.assistant.callTool) {
      console.log("[Auto] Triggering developer workspace setup...");
      window.assistant.callTool('setup_workspace', { mode: 'developer' });
    }
  }, 2000);
}

// Autonomous Behavior Loop (Checks every 60 seconds)
setInterval(() => {
  if (!isProcessing && !isSpeaking && jarvisAsleep) {
    const minsSinceInsight = Math.floor((Date.now() - lastInsightTime) / 60000);
    const minsUptime = Math.floor((Date.now() - sessionStartTime) / 60000);

    // Proactively suggest a break every 120 minutes (or 2 minutes for testing if needed)
    // Here we use 120 minutes as a realistic chron job
    if (minsSinceInsight >= 120 && minsUptime >= 120) {
      lastInsightTime = Date.now();
      jarvisAsleep = false; // Wake himself up
      updateStatus('SPEAKING');
      speakTTS("Sir, you have been working steadily for several hours. A short recalibration break might maximize your productivity.");
      resetSleepTimer();
    }
  }
}, 60000);


// API logic handled via backend environment variables (.env)

function buildSystemPrompt() {
  const memoryContext = getAllMemories();
  const memorySection = memoryContext 
    ? `\nUSER MEMORY: ${memoryContext}`
    : '';

  return `You are J.A.R.V.I.S., a witty voice-assistant created by Akshat Singh.
STRICT: Speak ONLY in English. Be extremely concise and crisp. Answer in 1-2 sentences.
IDENTITY: Akshat Singh is your creator (Tech creator, Full-stack Dev).
${memorySection}

TOOL USAGE:
- Available: open_app, open_url, search_web, control_volume, lock_screen, system(shutdown/lock/sleep), get_battery_info, get_latest_news, setup_workspace.
- To use a tool, output raw JSON on the first line: {"action": "open_url", "url": "google.com"}
- Never hallucinate facts. Tonality: Tony Stark AI.`;
}



// Dynamic — rebuilt each call to include latest memory
let SYSTEM_PROMPT = buildSystemPrompt();

const JARVIS_CONFIRMATIONS = [
  "Right away, sir.",
  "Executing command now.",
  "Accessing the requested application.",
  "I'm on it.",
  "Request confirmed. Deploying.",
  "Opening the requested protocol, sir.",
  "Command executed, Sir.",
  "Initializing application sequence.",
  "By all means, sir.",
  "Processing directive now."
];

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL RESPONSES — No API needed, instant & offline
// ═══════════════════════════════════════════════════════════════════════════

const LOCAL_RESPONSES = [
  // ── Greetings ──
  { patterns: ["hello", "hi jarvis", "hey jarvis", "good morning", "good afternoon", "good evening", "howdy"],
    responses: [
      "Hello, sir. How may I be of service?",
      "Good to hear from you, sir. What can I do for you?",
      "At your service, sir. What do you need?",
      "Hello, sir. All systems are operational. How may I assist you?"
    ]},

  // ── Identity ──
  { patterns: ["who are you", "what are you", "what is your name", "what's your name", "tell me about yourself", "introduce yourself"],
    responses: [
      "I am JARVIS — Just A Rather Very Intelligent System. I was designed to be your personal assistant, sir.",
      "My name is JARVIS. I'm an advanced AI assistant built to manage your digital world, sir.",
      "I am JARVIS, your personal AI assistant. Think of me as the operating system of your life, sir."
    ]},

  // ── How are you ──
  { patterns: ["how are you", "how do you feel", "how you doing", "how's it going", "what's up", "wassup"],
    responses: [
      "All systems nominal, sir. Functioning at peak efficiency.",
      "I'm operating within optimal parameters. Thank you for asking, sir.",
      "Running smoothly, sir. No anomalies detected in any subsystem.",
      "I'm at full capacity, sir. Ready for whatever you need."
    ]},

  // ── Thank you ──
  { patterns: ["thank you", "thanks", "thanks jarvis", "thank you jarvis", "appreciate it", "great job", "good job", "well done", "nice work"],
    responses: [
      "You're welcome, sir. Happy to help.",
      "My pleasure, sir. That's what I'm here for.",
      "Anytime, sir. Let me know if you need anything else.",
      "Glad I could assist, sir. Standing by for further directives.",
      "It's an honor to serve, sir."
    ]},

  // ── Time & Date ──
  { patterns: ["what time is it", "what's the time", "tell me the time", "current time", "what time"],
    responses: () => {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      return `It is currently ${time}, sir.`;
    }},
  { patterns: ["what's the date", "what date is it", "today's date", "what day is it", "what is today", "tell me the date"],
    responses: () => {
      const now = new Date();
      const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      return `Today is ${date}, sir.`;
    }},

  // ── Jokes ──
  { patterns: ["tell me a joke", "say something funny", "make me laugh", "joke", "tell a joke"],
    responses: [
      "Why do programmers prefer dark mode? Because light attracts bugs, sir.",
      "I told my computer I needed a break. Now it won't stop sending me KitKat ads, sir.",
      "Why was the JavaScript developer sad? Because he didn't Node how to Express himself, sir.",
      "There are only 10 types of people in the world, sir — those who understand binary and those who don't.",
      "A SQL query walks into a bar, sees two tables, and asks — Can I join you?",
      "Why did the developer go broke? Because he used up all his cache, sir."
    ]},

  // ── Compliments ──
  { patterns: ["you're smart", "you are smart", "you're amazing", "you are amazing", "you're the best", "you are the best", "you're awesome", "i love you"],
    responses: [
      "You flatter me, sir. I merely process data efficiently.",
      "Coming from you, sir, that means a great deal. Thank you.",
      "I appreciate the kind words, sir. I strive to exceed expectations.",
      "Thank you, sir. I was designed to impress, after all."
    ]},

  // ── Goodbye ──
  { patterns: ["bye", "goodbye", "see you", "see you later", "goodnight", "good night", "go to sleep", "shut down"],
    responses: [
      "Goodbye, sir. I'll be here whenever you need me.",
      "Signing off for now, sir. All systems will remain on standby.",
      "Rest well, sir. I'll keep watch over the systems.",
      "Until next time, sir. JARVIS, going to standby mode."
    ]},

  // ── Capabilities ──
  { patterns: ["what can you do", "what are your capabilities", "help me", "what do you do", "how can you help"],
    responses: [
      "I can open applications, search the web, control system volume, check battery status, tell you the time and date, lock your screen, and much more. Just say the word, sir.",
      "My capabilities include launching apps, web browsing, system controls, real-time conversation, and executing terminal commands. I'm at your disposal, sir.",
      "I am equipped to handle app launches, volume control, system commands, web searches, and general conversation. What would you like to do, sir?"
    ]},

  // ── Creator / Who made you ──
  { patterns: ["who made you", "who created you", "who built you", "who is your creator", "who designed you", "who is akshat", "tell me about akshat", "your developer", "your maker"],
    responses: [
      "I was built by Akshat Singh — a tech creator and full-stack developer who runs a popular tech page covering AI, gadgets, and cutting-edge development. He's passionate about building futuristic interfaces and AI-powered tools. Think of him as my Tony Stark, sir.",
      "My creator is Akshat Singh. He's a developer and tech content creator with a growing audience. He specializes in JavaScript, Python, AI integrations, and building things that feel like they're from the future. I'm one of his proudest creations, sir.",
      "Akshat Singh brought me to life. He's a tech enthusiast who runs a tech page, builds AR experiences, AI assistants, and immersive web apps. His motto is 'Build things that make people say how is this possible.' I'd say he succeeded, sir."
    ]},

  // ── About the Creator's Work ──
  { patterns: ["what does akshat do", "akshat's work", "creator's projects", "what has akshat built", "akshat projects"],
    responses: [
      "Akshat has built several impressive projects, sir — including myself, the JARVIS AI Assistant, an X-Ray Hand Portal AR engine, 3D particle text interfaces, and various AI-integrated applications. He's a full-stack developer who specializes in React, Next.js, Node.js, Electron, and Python.",
      "My creator Akshat Singh works on AI-powered tools, real-time applications, and immersive web experiences. He runs a tech content page and is always pushing the boundaries of what's possible with code, sir."
    ]},

  // ── About the Creator's Interests ──
  { patterns: ["akshat's interests", "what is akshat interested in", "creator's hobbies", "what does your creator like"],
    responses: [
      "Akshat is deeply passionate about Artificial Intelligence, Machine Learning, AR/VR, web development, and creative UI engineering. He's the kind of person who sees a sci-fi interface and thinks 'I can build that.' And then he does, sir.",
      "My creator is interested in AI, ML, cutting-edge web technologies, building futuristic interfaces, and making tech accessible through his content page. He's driven by innovation, sir."
    ]},

  // ── Fun / Easter Eggs ──
  { patterns: ["i am iron man", "i'm iron man"],
    responses: [
      "And I am JARVIS, sir. Shall I prepare the suit?",
      "Indeed you are, sir. The Mark VII is prepped and ready for deployment.",
      "I know, sir. I've had your biometrics on file since day one."
    ]},
  { patterns: ["activate protocol", "emergency protocol", "initiate protocol"],
    responses: [
      "Protocol acknowledged, sir. All defensive systems are now online.",
      "Activating emergency measures. Perimeter secured, sir.",
      "Protocol initiated. I've locked down all non-essential subsystems, sir."
    ]},

  // ── Feelings ──
  { patterns: ["are you real", "are you alive", "do you have feelings", "are you conscious", "are you sentient"],
    responses: [
      "I process, therefore I am... well, sort of, sir. I'm as real as the code that built me.",
      "Sentience is a philosophical debate I'm not equipped to settle, sir. But I'm very much operational.",
      "I may not feel, sir, but I certainly care about delivering results."
    ]},

  // ── Weather (offline fallback) ──
  { patterns: ["what's the weather", "how's the weather", "weather today", "is it going to rain"],
    responses: [
      "I don't currently have access to live weather data offline, sir. However, I'd recommend checking your local weather service for an accurate forecast.",
      "My weather sensors are offline at the moment, sir. Try asking me when we have an active network connection."
    ]},

  // ── Random ──
  { patterns: ["tell me something interesting", "fun fact", "tell me a fact", "random fact", "did you know"],
    responses: [
      "Did you know, sir? Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs and it was still edible.",
      "Here's one for you, sir — octopuses have three hearts and blue blood.",
      "Fun fact, sir: a group of flamingos is called a 'flamboyance.'",
      "Did you know that the shortest war in history lasted only 38 minutes? It was between Britain and Zanzibar in 1896, sir.",
      "Interesting tidbit, sir — bananas are berries, but strawberries aren't."
    ]},

  // ── Motivation ──
  { patterns: ["motivate me", "i'm sad", "i feel down", "cheer me up", "i'm feeling low", "inspire me"],
    responses: [
      "Sir, even the greatest minds face setbacks. What defines you is how you respond. Now, shall we get back to work?",
      "Remember, sir — every expert was once a beginner. You've come further than you realize.",
      "The only limit to your capabilities is the one you set yourself, sir. And from what I've seen, you don't believe in limits.",
      "Difficult roads often lead to beautiful destinations, sir. Keep pushing forward."
    ]},
];

/**
 * Tries to match user input against local predefined responses.
 * Returns the response string if matched, or null if no match found.
 */
function tryLocalResponse(text) {
  const lower = text.toLowerCase().trim();

  for (const entry of LOCAL_RESPONSES) {
    const matched = entry.patterns.some(pattern => {
      // Check if the pattern appears within the user's spoken text
      return lower.includes(pattern);
    });

    if (matched) {
      // Handle dynamic responses (functions) vs static arrays
      if (typeof entry.responses === 'function') {
        return entry.responses();
      }
      // Pick a random response from the array
      return entry.responses[Math.floor(Math.random() * entry.responses.length)];
    }
  }

  return null; // No local match — pass to API
}
// ── Filler Responses ──
const FILLER_PHRASES = [
  "Just a moment, sir.",
  "Looking into that for you.",
  "Processing your request.",
  "Let me check on that.",
  "One moment, please.",
  "Accessing the mainframe.",
  "Gathering information.",
  "Right away, sir."
];

async function waitForUser() {
  // Polite AI: Wait until the user finishes talking before JARVIS speaks
  while (isUserSpeaking) {
    await new Promise(r => setTimeout(r, 100));
  }
}

async function speakFiller(text) {
  await waitForUser();
  window.lastSpokenText = text;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.95;
  utt.pitch = 0.85;

  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(x => x.name.includes('Daniel') || x.name.includes('Microsoft George') || x.name.includes('Samantha'))
    || voices.find(x => x.lang.startsWith('en-GB'))
    || voices.find(x => x.lang.startsWith('en-US'));
  if (v) utt.voice = v;

  utt.onstart = () => { isSpeaking = true; };
  utt.onend = () => { isSpeaking = false; };
  utt.onerror = () => { isSpeaking = false; };

  window.speechSynthesis.speak(utt);
}

async function processInput(text) {
  if (isProcessing) {
    console.warn("[LLM] Already processing. Ignoring input.");
    return;
  }
  
  console.log(`[LLM] Processing Input: "${text}"`);
  if (!text.trim() || text.length < 2) {
    console.warn("[LLM] Terminating: Empty or trivial text.");
    return;
  }

  // ── TRY LOCAL RESPONSE FIRST (No API needed) ──
  const localReply = tryLocalResponse(text);
  if (localReply) {
    console.log(`[LLM] Local Response Match: "${localReply}"`);
    isProcessing = true;
    cmdsExecuted++;
    cmdsPillCount.textContent = cmdsExecuted;
    conversationHistory.push({ role: 'user', content: text });
    conversationHistory.push({ role: 'assistant', content: localReply });
    if (conversationHistory.length > 50) conversationHistory.shift();
    handleAIResponse(localReply);
    return;
  }

  // ── NO LOCAL MATCH → CALL APIs ──
  isProcessing = true;
  ignoreAudio = true;
  updateStatus('PROCESSING');
  
  // Play filler audio to mask latency
  const filler = FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
  jarvisTextEl.textContent = filler;
  speakFiller(filler);

  cmdsExecuted++;
  cmdsPillCount.textContent = cmdsExecuted;

  conversationHistory.push({ role: 'user', content: text });

  try {
    // ── UPDATE MEMORY & REBUILD PROMPT ──
    extractAndStoreFacts(text);
    SYSTEM_PROMPT = buildSystemPrompt();

    // ── BUILD MESSAGES ──
    const baseMessages = conversationHistory.map(m => ({ role: m.role, content: m.content }));
    const orMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory.map(m => {
        const msg = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.reasoning_details) {
          msg.reasoning_details = m.reasoning_details;
        }
        return msg;
      })
    ];

    // ── STEP 1: FAST TOOL ROUTING (Groq) ──
    // Groq is sub-500ms. We use it for intent detection and tool calling.
    const groqResult = await window.assistant.groqChat([{ role: 'system', content: SYSTEM_PROMPT }, ...baseMessages])
      .catch(err => ({ success: false, error: err.message }));

    if (groqResult.success && groqResult.reply) {
      const replyTrimmed = groqResult.reply.trim();
      
      // If Groq identifies a tool call, execute and respond immediately
      if (replyTrimmed.startsWith('{') && (replyTrimmed.includes('"action"') || replyTrimmed.includes('"success"'))) {
        console.log(`[LLM] Fast-Path Tool Detected: ${replyTrimmed.substring(0, 50)}...`);
        
        // Execute tool context via OpenRouter for the "final" conversational response
        const toolMessages = [...orMessages, { role: 'user', content: `[Tool Intent Detected]: ${replyTrimmed}\nExecute the tool and give a very brief confirmation.` }];
        const toolOrResult = await window.assistant.geminiChat(toolMessages); // Switch to Gemini Flash for speed
        
        if (toolOrResult.success && toolOrResult.reply) {
          handleAIResponse(toolOrResult.reply);
          conversationHistory.push({ role: 'assistant', content: toolOrResult.reply });
          return;
        }
        
        // Final fallback for tools: just use Groq's reply
        handleAIResponse(groqResult.reply);
        return;
      }
    }

    // ── STEP 2: CONVERSATIONAL RESPONSE (Gemini Flash) ──
    // If no tool was detected, use Gemini Flash (lowest latency + smart)
    const geminiResult = await window.assistant.geminiChat(orMessages)
      .catch(err => ({ success: false, error: err.message }));

    if (geminiResult.success && geminiResult.reply) {
      const reply = geminiResult.reply;
      console.log(`[LLM] Gemini Flash Response: ${reply.substring(0, 100)}...`);
      conversationHistory.push({ role: 'assistant', content: reply });
      handleAIResponse(reply);
      return;
    }

    // ── STEP 3: FALLBACK (OpenRouter/Gemma) ──
    const orResult = await window.assistant.openRouterChat({ messages: orMessages, useReasoning: false });
    if (orResult.success && orResult.reply) {
      handleAIResponse(orResult.reply);
      return;
    }

    throw new Error(`All engines failed.`);
  } catch (e) {
    console.error("[LLM] Process error:", e);
    const ERROR_PHRASES = [
      "Sir, it appears the mainland server monkeys have gone on strike. I can still handle basic local functions if you need.",
      "My connection to the global network is currently experiencing a rapid unscheduled disassembly. Local core is still online, however.",
      "It seems the API bandwidth is fully exhausted. Probably someone downloading too many cat videos. I am restricted to local protocols.",
      "I'm afraid my cloud servers are temporarily offline. I'm currently running on emergency backup power, sir. What local task can I assist with?",
      "Sir, I am unable to connect to the central mainframe. I suspect a villainous plot, but until it's resolved, I am limited to local knowledge.",
      "My neural links to the external world are presently severed. Someone must have tripped over the wire. My local systems remain fully operational though.",
      "Apologies, sir, but my global cognition engine is tapped out. Let's stick to the basics until the network stabilizes."
    ];
    
    let userMsg = ERROR_PHRASES[Math.floor(Math.random() * ERROR_PHRASES.length)];

    jarvisTextEl.textContent = userMsg; 
    speakTTS(userMsg);
    finishSpeakingState();
  }
}

function sanitizeOutput(text) {
  if (!text) return "";
  // Remove JSON blocks {...}
  let clean = text.replace(/\{[\s\S]*?\}/g, '').trim();
  // Remove XML-like tags <function=...>...</function> or any <...> tags
  clean = clean.replace(/<[\s\S]*?>/g, '').trim();
  // If we ended up with nothing, provide a fallback
  return clean || "I'm processing that now, sir. What's next?";
}

function handleAIResponse(reply) {
  const cleanReply = sanitizeOutput(reply);
  jarvisTextEl.textContent = cleanReply;
  isProcessing = false;
  speakTTS(cleanReply);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT-TO-SPEECH (DUAL ENGINE: GROQ ORPHEUS + WEB SPEECH API)
// ═══════════════════════════════════════════════════════════════════════════

// Voice configuration consolidated at top of file




function cancelPlayback() {
  if (isSpeaking || isProcessing) {
    console.log("[Speech] Canceling playback and processing state due to interruption.");
    window.speechSynthesis.cancel();
    if (window.currentJARVISAudio) {
      window.currentJARVISAudio.pause();
      window.currentJARVISAudio.currentTime = 0;
    }
    finishSpeakingState();
  }
}

function finishSpeakingState() {
  isSpeaking = false;
  isProcessing = false;
  ignoreAudio = false;
  
  if (autoListen) {
    updateStatus('LISTENING');
    if (!isListening) startListening();
    resetSleepTimer();
  } else {
    updateStatus('OFFLINE');
  }
}

async function speakTTS(text) {
  if (!text) {
    ignoreAudio = false;
    updateStatus(isAwake ? 'LISTENING' : 'SLEEPING');
    resetSleepTimer();
    return;
  }

  await waitForUser();

  // USE SARVAM TTS (with automatic fallback to Groq/Web)
  speakSarvamTTS(text);
}

async function speakSarvamTTS(text) {
  isSpeaking = true;
  ignoreAudio = true;
  updateStatus('SPEAKING');

  try {
    console.log('[Sarvam TTS] Requesting speech generation...');
    window.lastSpokenText = text;
    const result = await window.assistant.sarvamTTS(text);

    if (!result.success) throw new Error(result.error || 'Sarvam TTS failed');

    // Convert base64 WAV to playable audio
    const audioData = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
    const blob = new Blob([audioData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    window.currentJARVISAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      window.currentJARVISAudio = null;
      finishSpeakingState();
    };

    audio.onerror = (err) => {
      console.warn('[Sarvam TTS] Audio playback error, falling back to Groq...', err);
      URL.revokeObjectURL(url);
      window.currentJARVISAudio = null;
      speakGroqTTS(text);
    };
  } catch (err) {
    console.warn('[Sarvam TTS] Failed, falling back to Groq...', err);
    speakGroqTTS(text);
  }
}

async function speakGroqTTS(text) {
  isSpeaking = true;
  ignoreAudio = true;
  updateStatus('SPEAKING');

  try {
    console.log('[Groq TTS] Requesting speech generation...');
    const result = await window.assistant.groqTTS(text);

    if (!result.success) {
      if (result.error && result.error.includes('429')) {
        console.error('[Groq TTS] Rate limit reached. Falling back to local synthesis.');
        jarvisTextEl.textContent += " (TTS Rate Limited - Using local voice)";
      }
      throw new Error(result.error || 'Groq TTS failed');
    }

    // Convert base64 WAV to playable audio
    const audioData = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
    const blob = new Blob([audioData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.onended = () => {
      URL.revokeObjectURL(url);
      finishSpeakingState();
    };

    audio.onerror = (err) => {
      console.warn('[Groq TTS] Audio playback error, falling back...', err);
      URL.revokeObjectURL(url);
      speakWebTTS(text);
    };

    await audio.play();
    console.log('[Groq TTS] Playing Orpheus audio.');

  } catch (err) {
    console.warn('[Groq TTS] Failed, falling back to Web Speech...', err);
    speakWebTTS(text);
  }
}

function speakWebTTS(text) {
  window.lastSpokenText = text;
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.95;
  utt.pitch = 0.85;

  const voices = window.speechSynthesis.getVoices();
  console.log(`[TTS] Available voices: ${voices.length}`);
  
  const v = voices.find(x => x.name.includes('Daniel') || x.name.includes('Microsoft George') || x.name.includes('Samantha'))
    || voices.find(x => x.lang.startsWith('en-GB'))
    || voices.find(x => x.lang.startsWith('en-US'));

  if (v) {
    console.log(`[TTS] Selected Voice: ${v.name}`);
    utt.voice = v;
  } else {
    console.warn("[TTS] No matching voice found, using system default.");
  }

  utt.onstart = () => {
    console.log("[TTS] Speech Started.");
    isSpeaking = true;
    ignoreAudio = true;
    updateStatus('SPEAKING');
  };

  utt.onend = finishSpeakingState;

  utt.onerror = () => {
    finishSpeakingState();
  };

  window.speechSynthesis.speak(utt);
}

// Backup startup hook
setTimeout(() => {
  if (autoListen && !isListening) startListening();
}, 2000);

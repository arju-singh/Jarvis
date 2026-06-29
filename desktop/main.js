require('dotenv').config();
const { app, BrowserWindow, ipcMain, systemPreferences, session, shell, protocol, net } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const Groq = require('groq-sdk');

console.log("[Main] JARVIS Core Initializing...");
console.log(`[Main] Environment: SARVAM_KEY=${process.env.SARVAM_API_KEY ? 'Present' : 'Missing'}, GROQ_KEY=${process.env.GROQ_API_KEY ? 'Present' : 'Missing'}, OPENROUTER_KEY=${process.env.OPENROUTER_API_KEY ? 'Present' : 'Missing'}`);

// ── Groq API Key Rotation Pool ───────────────────────────────────────────
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean); // Remove undefined/empty keys

let currentKeyIndex = 0;
let groq = new Groq({ apiKey: GROQ_KEYS[currentKeyIndex] });

console.log(`[Groq] Key pool initialized with ${GROQ_KEYS.length} key(s). Active: Key #${currentKeyIndex + 1}`);

/**
 * Rotates to the next Groq API key. Returns true if rotated, false if all keys exhausted.
 */
function rotateGroqKey(reason) {
  currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
  groq = new Groq({ apiKey: GROQ_KEYS[currentKeyIndex] });
  console.log(`[Groq] 🔄 Rotated to Key #${currentKeyIndex + 1} (Reason: ${reason})`);
  return true;
}

/**
 * Checks if an error is a key-exhaustion/quota/permission issue that warrants rotation.
 */
function isKeyExhausted(err) {
  const msg = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode || 0;
  return (
    status === 429 ||
    status === 403 ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('credits') ||
    msg.includes('limit_exhausted') ||
    msg.includes('permission') ||
    msg.includes('blocked')
  );
}

// ── MCP Configuration ───────────────────────────────────────────────────
let mcpClient = null;

async function setupMCP() {
  try {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: os.platform() === 'win32' ? 'python' : 'python3',
      args: [path.join(__dirname, 'mcp_server.py')]
    });

    mcpClient = new Client({
      name: "JarvisClient",
      version: "1.0.0"
    }, {
      capabilities: { tools: {} }
    });

    await mcpClient.connect(transport);
    console.log("[MCP] Connected to Python FastMCP Server!");
  } catch (e) {
    console.error("[MCP] Error setting up MCP:", e);
  }
}


// Suppress Chromium data pipe network errors in console
// app.commandLine.appendSwitch('log-level', '3');
// app.commandLine.appendSwitch('disable-logging');

const express = require('express');
const http = require('http');

let mainWindow;
let server;

const cors = require('cors');

function startLocalServer() {
  const app = express();
  const port = 3000;

  app.use(cors());
  app.use((req, res, next) => {
    console.log(`[Server] Request: ${req.url}`);
    next();
  });

  app.use(express.static(__dirname));

  server = http.createServer(app);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Main] Local JARVIS Server serving ${__dirname} at http://localhost:${port}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true, // Re-enable security now that we use a server
      experimentalFeatures: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    show: false,
  });

  mainWindow.loadURL('http://localhost:3000/index.html');

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    console.log(`[Renderer] [${levels[level] || 'LOG'}] ${message}`);
  });

  mainWindow.once('ready-to-show', () => {
    console.log("[Main] Window ready, starting in SLEEP mode (hidden).");
    // mainWindow.show(); // Removed to start hidden
  });

  ipcMain.on('wake-up', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.maximize();
      mainWindow.focus();
      console.log("[Main] Wake-up received, window maximized.");
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await setupMCP();
  console.log(`[Main] Platform detected: ${process.platform}`);

  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log(`[Main] Current Mic Status: ${status}`);
      if (status !== 'granted') {
        const micAccess = await systemPreferences.askForMediaAccess('microphone');
        console.log(`[Main] macOS Mic Access Request: ${micAccess ? 'Granted' : 'Denied'}`);
        if (!micAccess) {
          console.warn("[Main] Microphone access denied. Opening System Settings...");
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        }
      }
    } catch (err) {
      console.error('[Main] macOS Media access request failed:', err);
    }
  } else if (process.platform === 'win32') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Main] Windows Microphone status: ${status}`);
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`[Main] Permission Request: ${permission}`);
    const allowed = ['media', 'audioCapture', 'microphone', 'videoCapture'];
    if (allowed.includes(permission)) {
      console.log(`[Main] Permission Granted: ${permission}`);
      return callback(true);
    }
    console.warn(`[Main] Permission Denied: ${permission}`);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => {
    return true;
  });

  startLocalServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
// COMMAND HANDLER — apps, system, web search, URLs, timers
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('run-command', async (event, data) => {

  // ── [1] Open Apps ───────────────────────────────────────────────────────
  if (data.action === 'open_app') {
    if (process.platform === 'darwin') {
      const macApps = {
        'notepad': 'open -a TextEdit',
        'chrome': 'open -a "Google Chrome"',
        'firefox': 'open -a Firefox',
        'calculator': 'open -a Calculator',
        'explorer': 'open ~',
        'vscode': 'open -a "Visual Studio Code"',
        'spotify': 'open -a Spotify',
        'discord': 'open -a Discord',
        'figma': 'open -a Figma',
        'vlc': 'open -a VLC',
        'zoom': 'open -a zoom.us',
        'telegram': 'open -a Telegram',
        'whatsapp': 'open -a WhatsApp',
        'brave': 'open -a "Brave Browser"',
        'opera': 'open -a Opera',
        'obs': 'open -a OBS',
        'steam': 'open -a Steam',
        'edge': 'open -a "Microsoft Edge"',
        'outlook': 'open -a "Microsoft Outlook"',
        'word': 'open -a "Microsoft Word"',
        'excel': 'open -a "Microsoft Excel"',
        'powerpoint': 'open -a "Microsoft PowerPoint"',
        'cmd': 'open -a Terminal',
        'terminal': 'open -a Terminal',
        'settings': 'open -a "System Preferences" || open -a "System Settings"',
        'paint': 'open -a Paintbrush || open -a Preview',
      };
      const cmd = macApps[data.app];
      if (cmd) {
        return new Promise(r => exec(cmd, (err) => r({ success: !err, error: err?.message })));
      }
      return { success: false, error: `Unknown app: ${data.app}` };
    }
    return { success: false, error: 'Opening applications is only supported on macOS.' };
  }

  // ── [2] System Commands ─────────────────────────────────────────────────
  if (data.action === 'system') {
    if (process.platform === 'darwin') {
      const macCmds = {
        'shutdown': 'sudo shutdown -h now',
        'restart': 'sudo shutdown -r now',
        'sleep': 'pmset sleepnow',
        'lock': 'pmset displaysleepnow',
        'mute': 'osascript -e "set volume output muted true"',
        'volume_up': `osascript -e "set volume output volume ((output volume of (get volume settings)) + ${data.amount || 10})"`,
        'volume_down': `osascript -e "set volume output volume ((output volume of (get volume settings)) - ${data.amount || 10})"`,
        'screenshot': `screencapture "${path.join(os.homedir(), 'Desktop', `screenshot_${Date.now()}.png`)}"`,
      };
      const cmd = macCmds[data.command];
      if (cmd) {
        return new Promise(r => exec(cmd, (err) => r({ success: !err, error: err?.message })));
      }
    }
    return { success: false, error: `Unknown system command: ${data.command}` };
  }

  // ── [3] Web Search ──────────────────────────────────────────────────────
  if (data.action === 'web_search') {
    const query = encodeURIComponent(data.query);
    const url = `https://www.google.com/search?q=${query}`;
    const cmd = process.platform === 'darwin' ? `open "${url}"` : `start "" "${url}"`;
    return new Promise(r => exec(cmd, (err) => r({ success: !err, error: err?.message })));
  }

  // ── [4] Open URL ────────────────────────────────────────────────────────
  if (data.action === 'open_url') {
    const cmd = process.platform === 'darwin' ? `open "${data.url}"` : `start "" "${data.url}"`;
    return new Promise(r => exec(cmd, (err) => r({ success: !err, error: err?.message })));
  }

  // ── [5] Set Timer ───────────────────────────────────────────────────────
  if (data.action === 'set_timer') {
    const seconds = data.duration_seconds || 60;
    const label = data.label || 'Timer';
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('timer-done', label);
      }
    }, seconds * 1000);
    return { success: true, message: `Timer set for ${seconds} seconds` };
  }

  return { success: false, error: 'Unknown action' };
});

// ── Permissions IPC ───────────────────────────────────────────────────────
ipcMain.handle('request-mic-permission', async () => {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;

    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
    return granted;
  }

  if (process.platform === 'win32') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;

    // Windows 10+ handles this via ms-settings
    shell.openExternal('ms-settings:privacy-microphone');
    return false; // User must manually enable and restart
  }

  return true;
});

// ── Window Controls ───────────────────────────────────────────────────────
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

// ── Groq TTS Handler (with Key Rotation) ─────────────────────────────────
ipcMain.handle('groq-tts', async (event, text) => {
  const maxRetries = GROQ_KEYS.length;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Groq TTS] Generating speech (Key #${currentKeyIndex + 1}): "${text.substring(0, 50)}..."`);

      const response = await groq.audio.speech.create({
        model: 'canopylabs/orpheus-v1-english',
        voice: 'hannah',
        input: text,
        response_format: 'wav'
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      console.log(`[Groq TTS] Audio generated: ${buffer.length} bytes`);
      return { success: true, audio: base64 };
    } catch (err) {
      console.error(`[Groq TTS] Error (Key #${currentKeyIndex + 1}):`, err.message);
      if (isKeyExhausted(err) && rotateGroqKey(`TTS: ${err.message.substring(0, 60)}`)) {
        continue; // Retry with next key
      }
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'ALL_KEYS_EXHAUSTED' };
});

// ── Sarvam TTS Handler (Bulbul v1) ───────────────────────────────────────
ipcMain.handle('sarvam-tts', async (event, text) => {
  try {
    console.log(`[Sarvam TTS] Generating speech for: "${text.substring(0, 50)}..."`);

    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        speaker: "simran",
        target_language_code: "en-IN",
        model: "bulbul:v3",
        audio_format: "wav"
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[Sarvam TTS] Full Error Response:', JSON.stringify(errorData, null, 2));
      throw new Error(errorData.message || errorData.error || `Sarvam API error: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.audios || !data.audios[0]) {
      throw new Error('Sarvam TTS returned no audio data');
    }

    console.log(`[Sarvam TTS] Audio generated successfully.`);
    return { success: true, audio: data.audios[0] };
  } catch (err) {
    console.error('[Sarvam TTS] Error:', err.message);
    return { success: false, error: err.message };
  }
});

// ── Groq Chat Handler (with Key Rotation) ────────────────────────────────
ipcMain.handle('groq-chat', async (event, messages) => {
  const maxKeyRetries = GROQ_KEYS.length;

  for (let keyAttempt = 0; keyAttempt < maxKeyRetries; keyAttempt++) {
    try {
      console.log(`[Groq Chat] Sending ${messages.length} messages... (Key #${currentKeyIndex + 1})`);

      let tools = [];
      if (mcpClient) {
        const response = await mcpClient.listTools();
        tools = response.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }));
      }

      const models = ["llama-3.3-70b-versatile", "llama-3.2-90b-versatile", "qwen-2.5-32b", "mixtral-8x7b-32768", "llama-3.1-8b-instant"];
      let chatCompletion = null;
      let lastError = null;

      for (const model of models) {
        try {
          console.log(`[Groq Chat] Attempting with model: ${model}`);
          chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: model,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? "auto" : "none"
          });
          break; // Success!
        } catch (err) {
          lastError = err;
          const errMsg = (err.message || "").toLowerCase();

          // If it's a model-level limit, decommissioned, or the model itself is blocked/permission denied
          if (errMsg.includes("rate_limit") || errMsg.includes("quota") || err.status === 429 || errMsg.includes("model_permission") || errMsg.includes("model is blocked") || errMsg.includes("blocked at the organization level") || errMsg.includes("decommissioned") || errMsg.includes("not_found") || errMsg.includes("does not exist")) {
            console.warn(`[Groq Chat] Model ${model} unavailable. Trying fallback model...`);
            continue;
          }
          // If it's a true key-level issue (invalid API key, global quota), throw to trigger key rotation
          if (isKeyExhausted(err)) throw err;
          throw err;
        }
      }

      // All models failed with this key → rotate
      if (!chatCompletion) throw lastError;

      let message = chatCompletion.choices[0]?.message;

      // Handle Tool Calls if the LLM decides to use one
      if (message?.tool_calls) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          if (mcpClient) {
            console.log(`[MCP] Executing tool: ${toolCall.function.name}`);
            const args = JSON.parse(toolCall.function.arguments);
            const result = await mcpClient.callTool({
              name: toolCall.function.name,
              arguments: args
            });

            let content = "Success";
            if (result.content && result.content.length > 0) {
              content = result.content[0].text;
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: content
            });
          }
        }

        // Request final response after tool execution
        for (const model of models) {
          try {
            chatCompletion = await groq.chat.completions.create({
              messages: messages,
              model: model
            });
            break;
          } catch (err) {
            const em = (err.message || '').toLowerCase();
            if (em.includes("rate_limit") || err.status === 429 || em.includes("decommissioned") || em.includes("not_found") || em.includes("does not exist")) continue;
            if (isKeyExhausted(err)) throw err;
            throw err;
          }
        }
        message = chatCompletion.choices[0]?.message;
      }

      const reply = message?.content || "";
      return { success: true, reply, messages };

    } catch (err) {
      console.error(`[Groq Chat] Error (Key #${currentKeyIndex + 1}):`, err.message);
      // Try rotating to next key
      if (isKeyExhausted(err) && rotateGroqKey(`Chat: ${err.message.substring(0, 60)}`)) {
        continue; // Retry entire chat with next key
      }
      return {
        success: false,
        error: isKeyExhausted(err) ? "GROQ_LIMIT_EXHAUSTED" : err.message
      };
    }
  }
  return { success: false, error: "GROQ_LIMIT_EXHAUSTED" };
});

ipcMain.handle('mcp-tool', async (event, toolName, args) => {
  if (!mcpClient) return { success: false, error: "MCP Client not initialized" };
  try {
    console.log(`[MCP] Explicit tool call from Renderer: ${toolName}`);
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: args
    });
    let content = "Success";
    if (result.content && result.content.length > 0) {
      content = result.content[0].text;
    }
    return { success: true, content };
  } catch (err) {
    console.error(`[MCP] Tool call error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── Gemini Chat Handler (Final Response) ──────────────────────────────────
ipcMain.handle('gemini-chat', async (event, messages) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not defined");

    const contents = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || "Result processed." }]
      }));

    // Use gemini-3-flash-preview as requested (Experimental)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    });

    if (!response.ok) {
      const error = await response.json();
      const msg = error.error?.message || "Gemini API Error";
      const isQuota = msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('limit');
      throw new Error(isQuota ? "GEMINI_LIMIT_EXHAUSTED" : msg);
    }

    const data = await response.json();
    const reply = data.candidates[0].content.parts[0].text;

    return { success: true, reply };
  } catch (err) {
    console.error('[Gemini Chat] Error:', err.message);
    return { success: false, error: err.message };
  }
});

// ── OpenRouter Chat Handler (Gemma 4 + Reasoning) ───────────────────────
let openRouterAbort = null; // Dedup: cancel in-flight requests if user barges in

ipcMain.handle('openrouter-chat', async (event, { messages, useReasoning = true }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { success: false, error: 'OPENROUTER_API_KEY not set' };

  // Cancel any previous in-flight request (barge-in support)
  if (openRouterAbort) {
    openRouterAbort.abort();
    openRouterAbort = null;
  }
  const controller = new AbortController();
  openRouterAbort = controller;

  // Model cascade: try specific free models first, then the smart free router
  // Only Gemma 4 supports reasoning; others get standard completions
  const REASONING_MODELS = new Set(['google/gemma-4-26b-a4b-it:free']);
  const MODELS = [
    'google/gemma-4-26b-a4b-it:free',        // Primary: Gemma 4 with reasoning
    'google/gemma-3-27b-it:free',             // Fallback: Gemma 3 27B
    'nvidia/nemotron-3-super:free',           // NVIDIA Nemotron 3 Super
    'openrouter/free',                        // Smart router: auto-picks best available free model
  ];

  for (const model of MODELS) {
    try {
      const modelSupportsReasoning = useReasoning && REASONING_MODELS.has(model);
      console.log(`[OpenRouter] Attempting ${model} (reasoning: ${modelSupportsReasoning})...`);

      // Build the API payload — preserve reasoning_details in assistant messages
      const apiMessages = messages.map(m => {
        const msg = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.reasoning_details && modelSupportsReasoning) {
          msg.reasoning_details = m.reasoning_details;
        }
        return msg;
      });

      const body = {
        model,
        messages: apiMessages,
        max_tokens: 1024,
      };
      if (modelSupportsReasoning) {
        body.reasoning = { enabled: true };
      }

      const startMs = Date.now();
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://jarvis-assistant.local',
          'X-Title': 'JARVIS AI Assistant',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errMsg = errBody.error?.message || response.statusText;
        console.warn(`[OpenRouter] ${model} failed (${response.status}): ${errMsg}`);
        // If rate-limited or model unavailable, try next model
        if (response.status === 429 || response.status === 503 || response.status === 402 || response.status === 400) continue;
        throw new Error(errMsg);
      }

      const data = await response.json();
      const latencyMs = Date.now() - startMs;
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No choices returned');

      const assistantMessage = choice.message;
      const reply = assistantMessage.content || '';
      const reasoning = assistantMessage.reasoning_details || assistantMessage.reasoning || null;

      console.log(`[OpenRouter] ✅ ${model} responded in ${latencyMs}ms (${reply.length} chars)`);
      if (reasoning) console.log(`[OpenRouter] 🧠 Reasoning attached (${JSON.stringify(reasoning).length} chars)`);

      openRouterAbort = null;
      return {
        success: true,
        reply,
        reasoning_details: reasoning,
        model,
        latencyMs,
        usage: data.usage || null,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[OpenRouter] Request aborted (user barged in).');
        return { success: false, error: 'ABORTED' };
      }
      console.warn(`[OpenRouter] ${model} error: ${err.message}`);
      continue; // Try next model
    }
  }

  openRouterAbort = null;
  return { success: false, error: 'ALL_OPENROUTER_MODELS_EXHAUSTED' };
});

// ── Groq STT Handler (Whisper, with Key Rotation) ───────────────────────
ipcMain.handle('groq-stt', async (event, buffer) => {
  const tempPath = path.join(os.tmpdir(), `jarvis_audio_${Date.now()}.webm`);
  fs.writeFileSync(tempPath, Buffer.from(buffer));

  const maxRetries = GROQ_KEYS.length;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Groq STT] Transcribing audio (Key #${currentKeyIndex + 1})...`);
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: "whisper-large-v3-turbo",
        language: "en"
      });
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return { success: true, text: transcription.text };
    } catch (err) {
      console.error(`[Groq STT] Error (Key #${currentKeyIndex + 1}):`, err.message);
      if (isKeyExhausted(err) && rotateGroqKey(`STT: ${err.message.substring(0, 60)}`)) {
        continue; // Retry with next key
      }
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return { success: false, error: isKeyExhausted(err) ? "GROQ_STT_LIMIT_EXHAUSTED" : err.message };
    }
  }
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  return { success: false, error: 'ALL_KEYS_EXHAUSTED' };
});

// ── Sarvam STT Handler (Saaras v3) ───────────────────────────────────────
ipcMain.handle('sarvam-stt', async (event, buffer) => {
  try {
    console.log(`[Sarvam STT] Processing audio buffer (${buffer.byteLength} bytes)...`);

    // Saaras v3 works best with WAV/MP3. 
    // The buffer from renderer is likely webm/opus (default MediaRecorder).
    // Sarvam supports OPUS/OGG so we can send it directly.

    const formData = new FormData();
    const audioBlob = new Blob([buffer], { type: 'audio/webm' });

    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'saaras:v3');
    formData.append('language_code', 'en-IN'); // Optimized for Indian English context
    formData.append('with_timestamps', 'false');

    console.log("[Sarvam STT] Sending request to Sarvam AI...");
    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY
      },
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[Sarvam STT] Full Error Response:', JSON.stringify(errorData, null, 2));
      throw new Error(errorData.message || errorData.error || `Sarvam API error: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[Sarvam STT] Transcription: ${data.transcript}`);
    return { success: true, text: data.transcript };
  } catch (err) {
    console.error('[Sarvam STT] Error Details:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-env', (event, key) => {
  return process.env[key];
});
